"""Platform → own DS-Bot gateway decisions (docs/DSBOT_PLUGIN_ARCHITECTURE.md §4)."""
import json
import os
import re
import secrets
import tempfile
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from flybot_workspace import dsbot_gateway as gw
from flybot_workspace import lifecycle
from flybot_workspace.app import App, Config
from flybot_workspace.lifecycle import ManagerAuth, ManagerIdentity
from flybot_workspace.security import digest
from flybot_workspace.store import Store

ORIGIN = 'https://flybot-workspace.example'
COOKIE = '__Host-ot_session'
KEY = 'k' * 40


def seed(store):
    """Two users, each with one healthy runtime; returns their session tokens."""
    now = int(time.time())
    tokens = {}
    with store.transaction() as db:
        db.executescript(lifecycle.SCHEMA)
        gw.ensure_schema(db)
        for n, (user, inst, addr) in enumerate((('a' * 32, '1' * 32, '172.30.0.11:8080'),
                                                ('b' * 32, '2' * 32, '172.30.0.12:8080'))):
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, f'user{n}', 'x', now))
            ws = f'{n}' * 32
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (ws, user, 'w', now, f'k{n}', f'r{n}'))
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,"
                       "operation_id,operation_type,observed,observed_revision,health,process_ref,error_code,blocked,create_key,created) "
                       "VALUES(?,?,?,'p','compose','img',?,'running',1,'op','create','running',1,'healthy',NULL,NULL,0,?,?)",
                       (inst, ws, user, f'vol{n}', f'c{n}', now))
            gw.record_upstream(db, inst, addr, f'dsh-auth-{addr}=' + 'S' * 20 + str(n), now)
            token = secrets.token_urlsafe(32)
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (digest(token), digest('c'), user, now + 3600, now))
            tokens[user] = token
    return tokens


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.store = Store(os.path.join(self.tmp.name, 'd'))
        self.tokens = seed(self.store)
        self.app = gw.GatewayApp(self.store, ORIGIN, COOKIE, KEY)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, token=None, uri='/b/', method='GET', key=KEY, **headers):
        env = {'REQUEST_METHOD': 'GET', 'PATH_INFO': gw.ROUTE_PATH, 'HTTP_X_ORIGINAL_URI': uri,
               'HTTP_X_ORIGINAL_METHOD': method}
        if key is not None:
            env[gw.KEY_HEADER] = key
        if token is not None:
            env['HTTP_COOKIE'] = f'{COOKIE}={token}'
        env.update({'HTTP_' + k.upper(): v for k, v in headers.items()})
        seen = {}

        def start(status, hdrs):
            seen['status'] = int(status.split()[0])
            seen['headers'] = dict(hdrs)
        gw.mount(lambda e, s: s('200 OK', []) or [b'app'], self.app)(env, start)
        return seen['status'], seen['headers']

    def test_provisioned_instance_is_not_replaced_by_a_healthy_legacy_instance(self):
        owner, canonical, legacy = 'a' * 32, '1' * 32, '3' * 32
        with self.store.transaction() as db:
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,"
                       "desired,revision,operation_id,operation_type,observed,observed_revision,health,create_key,created) "
                       "VALUES(?,?,?,'p','compose','img','legacy-volume','running',1,'op','create','running',1,'healthy','legacy',0)",
                       (legacy, '0' * 32, owner))
            gw.record_upstream(db, legacy, '172.30.0.13:8080', 'dsh-auth-legacy=' + 'S' * 20, 1)
        self.assertEqual(self.call(self.tokens[owner])[0], 503)
        with self.store.transaction() as db:
            db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?,?,?)',
                       (owner, '0' * 32, 'a' * 32, canonical, 'manager', 1))
        self.assertEqual(self.call(self.tokens[owner])[1]['X-OT-Instance'], canonical)
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET health='unknown' WHERE id=?", (canonical,))
        self.assertEqual(self.call(self.tokens[owner])[0], 503)

    def test_skill_runs_use_own_runtime_and_the_old_namespace_is_retired_at_the_edge(self):
        task = 'a' * 32
        token = self.tokens['a' * 32]
        status, headers = self.call(token, uri=f'/v1/skills/runs/{task}/artifact')
        self.assertEqual(status, 204)
        self.assertIn('feature=skills', headers['X-OT-Upstream-Path'])
        self.assertEqual(self.call(token, uri=f'/v1/runtime/tasks/{task}/artifact')[0], 404)
        config = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key=KEY)
        self.assertIn('location ^~ /v1/runtime/ {\n    default_type application/json;\n    return 410', config)

    def test_each_user_reaches_only_their_own_dsbot(self):
        a, b = self.tokens['a' * 32], self.tokens['b' * 32]
        status, headers = self.call(a)
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Upstream'], '172.30.0.11:8080')
        self.assertEqual(headers['X-OT-Instance'], '1' * 32)
        self.assertEqual(headers['X-OT-Upstream-Path'], '/')
        self.assertEqual(headers['X-OT-Owner-Username'], 'user0')
        status, headers = self.call(b, uri='/b/api/bot?x=1')
        self.assertEqual((status, headers['X-OT-Upstream']), (204, '172.30.0.12:8080'))
        self.assertEqual(headers['X-OT-Upstream-Path'], '/api/bot?x=1')
        self.assertEqual(headers['X-OT-Owner-Username'], 'user1')

    def test_request_fields_cannot_select_another_instance(self):
        a = self.tokens['a' * 32]
        for extra in ({'x_ot_upstream': '172.30.0.12:8080'}, {'x_ot_instance': '2' * 32}):
            status, headers = self.call(a, uri='/b/?instance=' + '2' * 32, **extra)
            self.assertEqual(headers['X-OT-Upstream'], '172.30.0.11:8080')
        status, headers = self.call(None, HTTP_COOKIE=f'{COOKIE}=forged{"x" * 37}')
        self.assertEqual(status, 401)

    def test_unauthenticated_cross_site_and_unknown_key(self):
        a = self.tokens['a' * 32]
        self.assertEqual(self.call()[0], 401)
        self.assertEqual(self.call(a, key=None)[0], 404)
        self.assertEqual(self.call(a, key='wrong' * 10)[0], 404)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST', origin='https://evil.example')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST', origin=ORIGIN)[0], 204)
        self.assertEqual(self.call(a, uri='/b/api/x', x_original_upgrade='websocket')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/x', x_original_upgrade='websocket', origin=ORIGIN)[0], 204)
        self.assertEqual(self.call(a, uri='/b/api/x', sec_fetch_site='cross-site', sec_fetch_mode='cors')[0], 403)
        self.assertEqual(self.call(a, uri='/b/', sec_fetch_site='cross-site', sec_fetch_mode='navigate')[0], 204)

    def test_platform_paths_and_tricks_are_not_forwarded(self):
        a = self.tokens['a' * 32]
        for uri in ('/v1/auth/session', '/register/', '/privacy/', '/bx', '/b/%2e%2e/x', '/b/a%2fb', '/b/../v1/', '//b/'):
            self.assertEqual(self.call(a, uri=uri)[0], 404, uri)

    def test_unhealthy_or_blocked_runtime_is_not_routed(self):
        a = self.tokens['a' * 32]
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET health='unknown' WHERE id=?", ('1' * 32,))
        self.assertEqual(self.call(a)[0], 503)
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET health='healthy', blocked=1 WHERE id=?", ('1' * 32,))
        self.assertEqual(self.call(a)[0], 503)

    def test_expired_session(self):
        with self.store.transaction() as db:
            db.execute('UPDATE sessions SET expires=0')
        self.assertEqual(self.call(self.tokens['a' * 32])[0], 401)

    def test_moved_pages_map_to_plugin_route(self):
        routes = dict(gw.load_routes(), moved_pages=frozenset({'chat', 'home'}))
        self.assertEqual(gw.target_for('/chat/', routes), '/api/flybot-workspace/page?path=%2Fchat%2F')
        self.assertEqual(gw.target_for('/chat?start=0', routes), '/api/flybot-workspace/page?path=%2Fchat')
        self.assertEqual(gw.target_for('/chat/app.mjs?v=1', routes), '/api/flybot-workspace/page?path=%2Fchat%2Fapp.mjs')
        self.assertEqual(gw.target_for('/', routes), '/api/flybot-workspace/page?path=%2F')
        self.assertIsNone(gw.target_for('/privacy/', routes))

    def test_shipped_routes_move_private_chat(self):
        self.assertTrue({'chat', 'meetings', 'skills', 'memory', 'settings', 'onboarding', 'automations', 'agents', 'artifacts'} <= gw.load_routes()['moved_pages'])
        self.assertTrue({'members', 'team', 'messenger', 'discover'} <= gw.load_routes()['moved_pages'])
        self.assertEqual(gw.target_for('/chat/app.mjs', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fchat%2Fapp.mjs')
        release_base = '/chat/assets/' + 'a' * 32
        for module in ('chat/app.mjs', 'chat/files.mjs', 'chat/translation.mjs', 'shell/thumb.mjs'):
            path = f'{release_base}/{module}'
            expected = '/api/flybot-workspace/page?path=' + path.replace('/', '%2F')
            self.assertEqual(gw.target_for(path, gw.load_routes()), expected)
        self.assertEqual(gw.target_for('/settings', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fsettings')
        self.assertEqual(gw.target_for('/settings/connectors', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fsettings%2Fconnectors')
        self.assertEqual(gw.target_for('/onboarding', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fonboarding')
        self.assertEqual(gw.target_for('/artifacts/', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fartifacts%2F')
        self.assertEqual(gw.target_for('/space?view=meetings', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fartifacts')
        self.assertIsNone(gw.target_for('/space/app.mjs', gw.load_routes()))
        self.assertEqual(gw.target_for('/artifacts/app.mjs', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fartifacts%2Fapp.mjs')
        self.assertIsNone(gw.target_for('/share/' + 'A' * 43, gw.load_routes()))
        self.assertEqual(gw.target_for('/members/', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fmembers%2F')
        self.assertEqual(gw.target_for('/messenger/', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fmessenger%2F')
        self.assertEqual(gw.target_for('/discover/', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fdiscover%2F')
        self.assertEqual(gw.target_for('/team/', gw.load_routes()), '/api/flybot-workspace/page?path=%2Fteam%2F')
        ws, aid = 'a' * 32, 'b' * 32
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/export'), 'artifacts')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/studio-copy'), 'artifacts')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/shared-copy'), 'artifacts')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/shared-copy/extra'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/studio-personal-copy'), 'artifacts')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/studio-personal-copy/extra'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/studio/documents/{aid}/live'), 'studio')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/studio/documents/{aid}/live/anything'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/shared/{aid}/action'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/shared/{aid}/discussion'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/spreadsheet/draft'), 'artifacts')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/slides/draft'), 'artifacts')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/document/draft'), 'artifacts')
        work = '/v1/discover/works/work-demo'
        comment = 'otwc_' + '0' * 26
        for path in (work, work + '/remix', work + '/comments', work + '/comments/' + comment + '/like',
                     work + '/comments/' + comment + '/remove'):
            self.assertEqual(gw.moved_api(path), 'discover')
        self.assertEqual(gw.moved_api('/v1/model-api/image'), 'model-api')
        self.assertEqual(gw.moved_api('/v1/model-api/video'), 'model-api')
        self.assertEqual(gw.moved_api('/v1/model-api/music'), 'model-api')
        self.assertEqual(gw.moved_api('/v1/model-api/model3d'), 'model-api')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/images'), 'images')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/videos'), 'videos')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/music'), 'music')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/models-3d'), 'model3d')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/images/{aid}'), 'images')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/videos/{aid}'), 'videos')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/music/{aid}'), 'music')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/websites'), 'websites')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/websites/{aid}'), 'websites')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/models-3d/{aid}'), 'model3d')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/shares/{aid}/revoke'), 'artifacts')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/shares/{aid}/link'), 'artifacts')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/shares/{aid}/link/extra'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/artifacts/{aid}/discover'), 'discover')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/messages/{aid}/files/0'), 'agents')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/draft'), 'agents')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/agents/draft/extra'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/attachments'), 'agents')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/reply-progress'), 'agents')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/reply-stop'), 'agents')
        cards = f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/action-cards'
        self.assertEqual(gw.moved_api(cards), 'agents')
        self.assertEqual(gw.moved_api(cards + '/541200ea-fed6-40b5-8b27-5c6568024724/answer'), 'agents')
        self.assertIsNone(gw.moved_api(cards + '/invalid/answer'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/messages/{aid}/retry'), 'agents')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/social/conversations/otc_01/attachments'), 'messenger')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/profile/dream'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/actions/draft'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/actions/draft/save'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/{aid}/share-group'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/candidates/{aid}'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/social/conversations/otc_01/memory/capture'), 'messenger')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/agents/{aid}/conversations/{aid}/memory/capture'), 'agents')

        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/draft'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/speech'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/share-recipients'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/{aid}/shares'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/{aid}/artifact'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/{aid}/memory'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/{aid}/action'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/memory/actions/from-meeting'), 'memory')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/shared/{aid}/revoke'), 'meetings')
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/transcribe'), 'meetings')
        self.assertEqual(gw.moved_api('/v1/stickers'), 'stickers')
        self.assertEqual(gw.moved_api(f'/v1/stickers/{aid}/file'), 'stickers')
        self.assertIsNone(gw.moved_api('/v1/stickers/other/file'))
        self.assertEqual(gw.moved_api(f'/v1/workspaces/{ws}/meetings/from-call/otcav_' + 'A' * 26), 'meetings')
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/meetings/from-call/otcav_' + 'O' * 26))
        self.assertIsNone(gw.moved_api(f'/v1/workspaces/{ws}/meetings/{aid}/draft'))

    def test_team_runs_are_forwarded_only_to_the_signed_in_users_runtime(self):
        workspace = 'a' * 32
        run = 'c' * 32
        share = 'otsr_' + '0' * 26
        base = f'/v1/workspaces/{workspace}/team-runs'
        shared = f'/v1/workspaces/{workspace}/shared-runs'
        for path, feature in (
            (base, 'team-runs'),
            (f'{base}/{run}/export', 'team-runs'),
            (f'{base}/{run}/steps/7/retry', 'team-runs'),
            (f'{base}/{run}/steps/1/artifact', 'team-runs'),
            (f'{base}/automation-results/{run}/{workspace}', 'team-runs'),
            (f'{base}/{run}/share', 'shares'),
            (f'{shared}/{share}/revoke', 'shares'),
        ):
            with self.subTest(path=path):
                self.assertEqual(gw.moved_api(path), feature)
                self.assertEqual(self.call(uri=path, method='POST', origin=ORIGIN)[0], 401)
                for owner, instance in (('a' * 32, '1' * 32), ('b' * 32, '2' * 32)):
                    status, headers = self.call(self.tokens[owner], uri=path, method='POST', origin=ORIGIN)
                    self.assertEqual(status, 204)
                    self.assertEqual(headers['X-OT-Instance'], instance)
                    self.assertIn(f'feature={feature}', headers['X-OT-Upstream-Path'])
        self.assertIsNone(gw.moved_api(f'{base}/{run}/steps/8/retry'))
        self.assertEqual(self.call(uri='/team-runs')[0], 401)
        status, headers = self.call(self.tokens['a' * 32], uri='/team-runs')
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Upstream-Path'], '/api/flybot-workspace/page?path=%2Fteam-runs')

    def test_c_api_routing_matches_plugin_features_without_platform_execution(self):
        ws, ident = 'a' * 32, 'b' * 32
        for path, feature in (
            (f'/v1/workspaces/{ws}/members', 'members'),
            (f'/v1/workspaces/{ws}/members/{ident}/remove', 'members'),
            (f'/v1/workspaces/{ws}/invites', 'invites'),
            ('/v1/invites/accept', 'invites'),
            (f'/v1/workspaces/{ws}/join-requests', 'invites'),
            ('/v1/team-directory', 'teams'),
            (f'/v1/workspaces/{ws}/directory', 'teams'),
            (f'/v1/workspaces/{ws}/social/conversations/{ident}/agent-replies', 'messenger'),
            ('/v1/meeting-calls/create', 'messenger'),
            ('/v1/meeting-calls/join', 'messenger'),
            ('/v1/meeting-calls/recording', 'messenger'),
            ('/v1/discover/works', 'discover'),
            (f'/v1/workspaces/{ws}/agents/{ident}/discover', 'discover'),
        ):
            self.assertEqual(gw.moved_api(path), feature, path)
        self.assertEqual(gw.moved_api('/v1/teams'), 'teams')
        self.assertEqual(gw.moved_api('/v1/workspaces'), 'teams')

    def test_space_activity_is_owner_routed_and_the_old_stream_is_gone(self):
        uri = '/v1/workspaces/' + 'a' * 32 + '/artifacts/activity?artifact=' + 'b' * 32
        for owner, iid in [('a' * 32, '1' * 32), ('b' * 32, '2' * 32)]:
            status, headers = self.call(self.tokens[owner], uri=uri)
            self.assertEqual(status, 204)
            self.assertEqual(headers['X-OT-Instance'], iid)
            self.assertIn('feature=artifacts', headers['X-OT-Upstream-Path'])
            self.assertIn('%2Fartifacts%2Factivity', headers['X-OT-Upstream-Path'])
        self.assertEqual(self.call(uri=uri)[0], 401)

        app = App(self.store, Config(ORIGIN))
        received = {}
        body = b''.join(app({'HTTP_HOST': 'flybot-workspace.example', 'REQUEST_METHOD': 'GET',
                            'PATH_INFO': '/v1/workspaces/' + 'a' * 32 + '/events'},
                           lambda status, headers: received.update(status=status, headers=dict(headers))))
        self.assertTrue(received['status'].startswith('410 '))
        self.assertEqual(received['headers']['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(json.loads(body)['error']['code'], 'retired')

    def test_record_upstream_validation(self):
        with self.store.transaction() as db:
            for addr in ('127.0.0.1:8080', '8.8.8.8:8080', '169.254.169.254:80', 'host:8080', '10.0.0.1:80'):
                with self.assertRaises(ValueError, msg=addr):
                    gw.record_upstream(db, '1' * 32, addr, 'dsh-auth-x=' + 'a' * 20, 1)
            with self.assertRaises(ValueError):
                gw.record_upstream(db, '1' * 32, '10.0.0.1:8080', 'session=abc', 1)

    def test_other_paths_reach_the_management_app(self):
        seen = {}

        def app(env, start):
            start('200 OK', [])
            return [b'app']
        body = gw.mount(app, self.app)(
            {'PATH_INFO': '/v1/auth/session', 'REQUEST_METHOD': 'GET'}, lambda st, h: seen.setdefault('s', st))
        self.assertEqual((seen['s'], body), ('200 OK', [b'app']))

    def test_nginx_config_strips_client_credentials(self):
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key_include='/etc/nginx/ot-gateway-key.conf')
        for line in ('location = /v1/platform/route { return 404; }', 'auth_request /_ot_authz;',
                     'proxy_set_header Cookie $ot_cookie;', 'proxy_hide_header Set-Cookie;',
                     'proxy_set_header X-OT-Gateway-Key $ot_gateway_key;', 'include /etc/nginx/ot-gateway-key.conf;', 'location ^~ /b/ { return 418; }',
                     'location ^~ /api/ { return 418; }', 'proxy_set_header Upgrade $http_upgrade;'):
            self.assertIn(line, conf)
        with self.assertRaises(ValueError):
            gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081)
        with self.assertRaises(ValueError):
            gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key_include='../x')
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key='k' * 40)
        self.assertIn('set $ot_gateway_key "' + 'k' * 40 + '";', conf)
        self.assertIn('location = /settings { return 418; }', conf)
        self.assertIn('location ^~ /settings/ { return 418; }', conf)
        self.assertIn('location = /onboarding { return 418; }', conf)
        self.assertIn('location = /artifacts { return 418; }', conf)
        self.assertIn('location ^~ /artifacts/ { return 418; }', conf)
        self.assertIn('location ~ "^/v1/workspaces/[0-9a-f]{32}/artifacts/(?:activity|document-tree|shared-copy|studio-personal-copy|(?:document|spreadsheet|slides)/draft)$" { return 418; }', conf)
        self.assertIn('location ~ "^/v1/workspaces/[0-9a-f]{32}/artifacts(?:/[0-9a-f]{32}(?:/(?:remove|favorite|preview|file|export|restore|studio-copy|versions(?:/[0-9]{1,8}(?:/export)?)?|shares(?:/[0-9a-f]{32}(?:/(?:revoke|link))?)?))?)?$" { return 418; }', conf)
        self.assertIn('location = /members { return 418; }', conf)
        self.assertIn('location = /discover { return 418; }', conf)
        self.assertIn('absolute_redirect off;', conf)
        self.assertIn('location @ot_login {', conf)
        self.assertIn('rewrite ^ /_ot_discover_guest$uri last;', conf)
        self.assertIn('return 302 /login;', conf)
        self.assertNotIn('location = /login { return 418; }', conf)
        self.assertIn('location ~ "^/v1/discover/(?:agents|works|me/works)$" { return 418; }', conf)

    def test_nginx_config_optional_social_path(self):
        routes = gw.load_routes()
        conf = gw.nginx_config(routes, '127.0.0.1:8080', 8081, key='k' * 40)
        self.assertNotIn('location ^~ /social/', conf)
        self.assertNotIn('rewrite ^/v1/discover/(works|agents)$', conf)
        with self.assertRaises(ValueError):
            gw.nginx_config(routes, '127.0.0.1:8080', 8081, key='k' * 40, bot_social='http://bad')
        social = gw.nginx_config(routes, '127.0.0.1:8080', 8081, key='k' * 40, bot_social='bot-social:8787')
        self.assertIn('location = /social { absolute_redirect off; return 308 /social/; }', social)
        self.assertIn('location ^~ /social/', social)
        self.assertIn('rewrite ^/v1/discover/(works|agents)$ /_ot_public_feed/$1 last;', social)
        self.assertIn('proxy_pass http://bot-social:8787/v1/ot/public/discover/;', social)
        self.assertIn('proxy_pass http://bot-social:8787/;', social)
        self.assertIn('X-Forwarded-Prefix /social;', social)
        self.assertIn('proxy_set_header X-OT-Gateway-Key "";', social)
        # The path stays on the existing origin; admin and FlyBot routes stay blocked.
        self.assertIn('location ^~ /v1/admin/ { return 404; }', social)


    def report(self, iid, body, manager_token, *, action='dsbot-upstream'):
        import io
        raw = json.dumps(body).encode()
        env = {'REQUEST_METHOD': 'POST', 'PATH_INFO': f'/v1/internal/instances/{iid}/{action}',
               'REMOTE_ADDR': '127.0.0.1', 'CONTENT_LENGTH': str(len(raw)), 'wsgi.input': io.BytesIO(raw),
               'HTTP_AUTHORIZATION': f'Bearer manager-a.{manager_token}'}
        seen = {}
        out = b''.join(gw.mount(None, self.app)(env, lambda st, h: seen.setdefault('s', int(st.split()[0]))))
        return seen['s'], json.loads(out)

    def test_manager_reports_upstream_for_granted_running_process_only(self):
        token = secrets.token_urlsafe(32)
        self.app.manager_auth = ManagerAuth([ManagerIdentity('manager-a', digest(token), frozenset({'1' * 32}), 'compose')])
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET process_ref=? WHERE id=?", ('f' * 32, '1' * 32))
            db.execute("UPDATE instances SET process_ref=? WHERE id=?", ('e' * 32, '2' * 32))
        good = {'address': '172.30.0.21:8080', 'auth_cookie': 'dsh-auth-172.30.0.21:8080=' + 'Z' * 30, 'process_ref': 'f' * 32}
        self.assertEqual(self.report('1' * 32, good, token), (200, {'recorded': True}))
        self.assertEqual(self.call(self.tokens['a' * 32])[1]['X-OT-Upstream'], '172.30.0.21:8080')
        self.assertEqual(self.report('2' * 32, dict(good, process_ref='e' * 32), token)[0], 403)
        self.assertEqual(self.report('1' * 32, dict(good, process_ref='0' * 32), token)[0], 409)
        self.assertEqual(self.report('1' * 32, dict(good, address='8.8.8.8:8080'), token)[0], 400)
        self.assertEqual(self.report('1' * 32, good, 'x' * 43)[0], 401)
        self.assertEqual(self.report('1' * 32, dict(good, extra=1), token)[0], 400)

    def test_restart_cannot_reactivate_an_old_gateway_route(self):
        iid, owner, other = '1' * 32, 'a' * 32, 'b' * 32
        token = secrets.token_urlsafe(32)
        manager = ManagerIdentity('manager-a', digest(token), frozenset({iid}), 'compose')
        self.app.manager_auth = ManagerAuth([manager])
        runtime = lifecycle.Lifecycle(self.store, lifecycle.RuntimePolicy(backend_mode='compose', image_ref='example/runtime@sha256:' + 'a' * 64))
        previous = {'address': '172.30.0.21:8080', 'auth_cookie': 'dsh-auth-172.30.0.21:8080=' + 'Z' * 30, 'process_ref': 'f' * 32}
        with self.store.transaction() as db:
            db.execute('UPDATE instances SET process_ref=? WHERE id=?', (previous['process_ref'], iid))
        self.assertEqual(self.report(iid, previous, token)[0], 200)
        self.assertEqual(self.call(self.tokens[owner])[1]['X-OT-Upstream'], previous['address'])

        self.assertTrue(runtime.restart(owner, iid, operation_id='restart-race-fixture-0001')[0])
        claim = runtime.claim(manager, iid)
        self.assertEqual(self.report(iid, previous, token)[0], 409, 'old process may not refresh during restart')
        self.assertEqual(self.call(self.tokens[owner])[0], 503)
        runtime.observe(manager, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], 'running', 'd' * 32)
        self.assertEqual(self.call(self.tokens[owner])[0], 503, 'old cookie does not reactivate after a new process is healthy')
        self.assertEqual(self.report(iid, previous, token)[0], 409, 'old process may not report after replacement')
        self.assertEqual(self.call(self.tokens[other])[1]['X-OT-Upstream'], '172.30.0.12:8080')
        current = {'address': '172.30.0.31:8080', 'auth_cookie': 'dsh-auth-172.30.0.31:8080=' + 'R' * 30, 'process_ref': 'd' * 32}
        self.assertEqual(self.report(iid, current, token)[0], 200)
        self.assertEqual(self.call(self.tokens[owner])[1]['X-OT-Upstream'], current['address'])

    def test_retired_instance_cannot_route_or_receive_manager_reports(self):
        owner, canonical, retired = 'a' * 32, '1' * 32, '3' * 32
        token = secrets.token_urlsafe(32)
        self.app.manager_auth = ManagerAuth([
            ManagerIdentity('manager-a', digest(token), frozenset({canonical, retired}), 'compose'),
        ])
        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,"
                "desired,revision,operation_id,operation_type,observed,observed_revision,health,process_ref,"
                "create_key,created,retired_at,retired_to) "
                "VALUES(?,?,?,'p','compose','img','retired-volume','running',1,'op','start','running',1,"
                "'healthy',?,'retired',0,3,?)",
                (retired, '0' * 32, owner, '9' * 32, canonical),
            )
            # Simulate a stale upstream record left in the control plane.
            db.execute('INSERT INTO dsbot_upstreams VALUES(?,?,?,?)',
                       (retired, '172.30.0.13:8080', 'dsh-auth-retired=' + 'S' * 20, 2))
            with self.assertRaisesRegex(ValueError, 'Instance is not active'):
                gw.record_upstream(db, retired, '172.30.0.14:8080', 'dsh-auth-retired=' + 'S' * 20, 4)

        status, headers = self.call(self.tokens[owner], uri='/chat')
        self.assertEqual((status, headers.get('X-OT-Instance')), (204, canonical))
        status, headers = self.call(
            uri=f'/v1/gateway/agents/{owner}/invocations', method='POST',
            Authorization='Bearer ota_' + retired + '_' + 'K' * 43,
        )
        self.assertEqual((status, headers.get('X-OT-Gateway-Error')), (503, 'dsbot_not_ready'))
        self.assertNotIn('X-OT-Upstream', headers)
        status, body = self.report(retired, {
            'address': '172.30.0.14:8080', 'auth_cookie': 'dsh-auth-retired=' + 'S' * 20,
            'process_ref': '9' * 32,
        }, token)
        self.assertEqual((status, body['error']['code']), (403, 'not_granted'))
        status, body = self.report(retired, {'seal_key': 'ab' * 32}, token, action='dsbot-import')
        self.assertEqual((status, body['error']['code']), (403, 'not_granted'))
        status, body = self.report(canonical, {'seal_key': 'ab' * 32}, token, action='dsbot-import')
        self.assertEqual(status, 200)
        self.assertTrue(body['owner_imported'])

    def test_operator_key_file_must_be_private(self):
        path = os.path.join(self.tmp.name, 'gw.json')
        with open(path, 'w') as f:
            json.dump({'version': 1, 'key': 'q' * 40}, f)
        os.chmod(path, 0o644)
        with self.assertRaises(ValueError):
            gw.load_operator_key(path)
        os.chmod(path, 0o600)
        self.assertEqual(gw.load_operator_key(path), 'q' * 40)

    def test_external_agent_api_is_routed_by_key_instance(self):
        token = 'ota_' + '1' * 32 + '_' + 'K' * 43
        status, headers = self.call(
            None, uri='/v1/gateway/agents/' + 'a' * 32 + '/invocations', method='POST',
            Authorization='Bearer ' + token)
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Upstream'], '172.30.0.11:8080')
        self.assertEqual(headers['X-OT-Instance'], '1' * 32)
        self.assertTrue(headers['X-OT-Upstream-Path'].startswith('/api/flybot-workspace/gateway?path='))
        self.assertEqual(headers['X-OT-Upstream-Token'], token)
        self.assertNotIn('X-OT-Owner-Username', headers)
        # A key for B must never reach A.
        other = 'ota_' + '2' * 32 + '_' + 'K' * 43
        status, headers = self.call(
            None, uri='/v1/gateway/invocations/' + 'c' * 32, method='GET',
            Authorization='Bearer ' + other)
        self.assertEqual((status, headers['X-OT-Instance'], headers['X-OT-Upstream']),
                         (204, '2' * 32, '172.30.0.12:8080'))
        # No token, bad shape, or unknown path.
        self.assertEqual(self.call(None, uri='/v1/gateway/agents/' + 'a' * 32 + '/invocations', method='POST')[0], 401)
        self.assertEqual(self.call(None, uri='/v1/gateway/agents/' + 'a' * 32 + '/invocations', method='POST',
                                   Authorization='Bearer not-a-key')[0], 401)
        self.assertEqual(self.call(None, uri='/v1/gateway/secret', method='GET',
                                   Authorization='Bearer ' + token)[0], 404)
        # A session cookie alone cannot open the external API, and a key cannot
        # steer to a browser page.
        self.assertEqual(self.call(self.tokens['a' * 32], uri='/v1/gateway/invocations/' + 'c' * 32)[0], 401)

    def test_external_agent_api_requires_the_canonical_runtime(self):
        owner, canonical, legacy = 'a' * 32, '1' * 32, '3' * 32
        with self.store.transaction() as db:
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,"
                       "desired,revision,operation_id,operation_type,observed,observed_revision,health,create_key,created) "
                       "VALUES(?,?,?,'p','compose','img','legacy-volume','running',1,'op','create','running',1,'healthy','legacy',0)",
                       (legacy, '0' * 32, owner))
            gw.record_upstream(db, legacy, '172.30.0.13:8080', 'dsh-auth-legacy=' + 'S' * 20, 1)

        def call(iid, method, uri):
            return self.call(uri=uri, method=method, Authorization=f'Bearer ota_{iid}_' + 'K' * 43)

        operations = (
            ('POST', f'/v1/gateway/agents/{owner}/invocations'),
            ('GET', '/v1/gateway/invocations/' + 'c' * 32),
        )
        for iid in (canonical, legacy):
            for method, uri in operations:
                status, headers = call(iid, method, uri)
                self.assertEqual((status, headers.get('X-OT-Gateway-Error')), (503, 'dsbot_not_ready'))
                self.assertNotIn('X-OT-Upstream', headers)

        with self.store.transaction() as db:
            db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?,?,?)',
                       (owner, '0' * 32, 'a' * 32, canonical, 'manager', 1))

        for method, uri in operations:
            status, headers = call(canonical, method, uri)
            self.assertEqual((status, headers.get('X-OT-Instance')), (204, canonical))
            status, headers = call(legacy, method, uri)
            self.assertEqual((status, headers.get('X-OT-Gateway-Error')), (503, 'dsbot_not_ready'))
            self.assertNotIn('X-OT-Upstream', headers)
        self.assertEqual(self.call(self.tokens[owner])[1].get('X-OT-Instance'), canonical)

    def test_nginx_config_has_external_agent_location(self):
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key='k' * 40)
        self.assertIn('location ^~ /v1/gateway/ {', conf)
        self.assertIn('proxy_set_header X-OT-Gateway-Token $ot_token;', conf)
        self.assertIn('proxy_set_header Authorization $http_authorization;', conf)
        # The caller's Authorization still never reaches a runtime.
        self.assertIn('proxy_set_header Authorization "";', conf)
        external = conf.split('location ^~ /v1/gateway/ {', 1)[1].split('recursive_error_pages', 1)[0]
        self.assertIn('error_page 401 = @ot_gateway_unauthorized;', external)
        self.assertIn('error_page 500 = @ot_gateway_error;', external)
        self.assertIn('return 503 \'{"error":{"code":"dsbot_not_ready"}}\';', external)

    def test_nginx_sets_runtime_owner_from_the_authorization_response(self):
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key='k' * 40)
        browser, external = conf.split('location @ot_dsbot {', 1)[1].split('location ^~ /v1/gateway/ {', 1)
        self.assertIn('auth_request_set $ot_owner_username $upstream_http_x_ot_owner_username;', browser)
        self.assertIn('proxy_set_header X-OT-Owner-Username $ot_owner_username;', browser)
        self.assertIn('proxy_set_header X-OT-Owner-Username "";', external)

    def test_bot_social_socket_routes_only_shared_runtime_api(self):
        routes = gw.load_routes()
        conf = gw.nginx_config(routes, '127.0.0.1:8080', 8081, key=KEY, bot_social='bot-social:8787',
                               bot_social_socket=True)
        public, private = conf.split('listen unix:' + gw.SOCIAL_SOCKET_PATH + ';')
        self.assertIn('location ^~ /social/', public)
        self.assertIn('location ^~ /v1/ot/ops/ { return 404; }', private)
        self.assertIn('location ^~ /v1/ot/', private)
        self.assertIn('proxy_pass http://bot-social:8787;', private)
        self.assertIn('location / { return 404; }', private)
        self.assertNotIn('auth_request', private)
        with self.assertRaises(ValueError):
            gw.nginx_config(routes, '127.0.0.1:8080', 8081, key=KEY, bot_social_socket=True)



    def test_moved_v1_apis_go_to_the_owners_dsbot(self):
        a = self.tokens['a' * 32]
        status, headers = self.call(a, uri='/v1/settings', method='GET')
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Instance'], '1' * 32)
        self.assertIn('/api/flybot-workspace/legacy?feature=settings&path=%2Fv1%2Fsettings', headers['X-OT-Upstream-Path'])
        status, headers = self.call(a, uri='/v1/onboarding/look', method='POST', Origin='https://flybot-workspace.example')
        self.assertEqual(status, 204)
        self.assertIn('feature=settings', headers['X-OT-Upstream-Path'])
        status, headers = self.call(a, uri='/v1/onboarding/progress', method='POST', Origin='https://flybot-workspace.example')
        self.assertEqual(status, 204)
        self.assertIn('feature=settings&path=%2Fv1%2Fonboarding%2Fprogress', headers['X-OT-Upstream-Path'])
        status, headers = self.call(a, uri='/v1/model-api')
        self.assertIn('feature=model-api', headers['X-OT-Upstream-Path'])
        status, headers = self.call(a, uri='/v1/onboarding/automations', method='POST', Origin='https://flybot-workspace.example')
        self.assertEqual(status, 204)
        self.assertIn('feature=automations', headers['X-OT-Upstream-Path'])
        # The Composio callback and authentication still reach the platform.
        self.assertEqual(self.call(a, uri='/v1/composio/callback')[0], 404)
        self.assertEqual(self.call(a, uri='/v1/auth/session')[0], 404)
        # User B cannot be steered onto A's settings by a forged instance id.
        b = self.tokens['b' * 32]
        status, headers = self.call(b, uri='/v1/settings')
        self.assertEqual(headers['X-OT-Instance'], '2' * 32)
        self.assertEqual(self.call(None, uri='/v1/settings')[0], 401)
        status, headers = self.call(a, uri='/v1/automation-templates')
        self.assertIn('feature=automations', headers['X-OT-Upstream-Path'])
        automation = f"/v1/workspaces/{'3' * 32}/automations/{'4' * 32}"
        status, headers = self.call(a, uri=automation, method='POST', Origin='https://flybot-workspace.example')
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Instance'], '1' * 32)
        self.assertIn('feature=automations', headers['X-OT-Upstream-Path'])

    def test_workspace_export_forwards_queries_to_authenticating_users_runtime(self):
        path = f"/v1/workspaces/{'a' * 32}/export"
        query = 'type=memory&cursor=20'
        for owner, instance in (('a', '1'), ('b', '2')):
            status, headers = self.call(self.tokens[owner * 32], uri=path + '?' + query)
            self.assertEqual(status, 204)
            self.assertEqual(headers['X-OT-Instance'], instance * 32)
            target = urlsplit(headers['X-OT-Upstream-Path'])
            self.assertEqual(target.path, '/api/flybot-workspace/legacy')
            self.assertEqual(parse_qs(target.query), {
                'feature': ['export'], 'path': [path], 'query': [query],
            })
        self.assertEqual(self.call(uri=path)[0], 401)
        self.assertEqual(self.call(self.tokens['a' * 32], uri=path + '/another')[0], 404)

    def test_profile_page_and_social_activity_use_owners_runtime(self):
        routes = gw.load_routes()
        for path, encoded in (('/profile', '%2Fprofile'), ('/profile/edit/', '%2Fprofile%2Fedit'),
                              ('/profile/app.mjs', '%2Fprofile%2Fapp.mjs')):
            self.assertEqual(gw.target_for(path, routes), '/api/flybot-workspace/page?path=' + encoded)
        for path in ('/v1/profile', '/v1/profile/avatar', '/p/alice'):
            self.assertIsNone(gw.target_for(path, routes))
        path = '/v1/profile/social?view=liked'
        self.assertEqual(self.call(uri=path)[0], 401)
        for user, expected in (('a', '1'), ('b', '2')):
            status, headers = self.call(self.tokens[user * 32], uri=path)
            self.assertEqual(status, 204)
            self.assertEqual(headers['X-OT-Instance'], expected * 32)
            self.assertIn('feature=discover', headers['X-OT-Upstream-Path'])
        self.assertEqual(gw.moved_api('/v1/profile/follow-work'), 'discover')

    def test_nginx_fences_every_moved_api_from_the_same_matchers(self):
        routes = gw.load_routes()
        conf = gw.nginx_config(routes, '127.0.0.1:8080', 8081, key=KEY, bot_social='bot-social:8787')
        rules = [line for line in conf.splitlines() if line.lstrip().startswith('location ')
                 and '/v1/' in line and 'return 418;' in line]
        patterns = [pattern.pattern for pattern, _feature in gw.MOVED_APIS]
        self.assertEqual(rules, [f'  location ~ "{pattern}" {{ return 418; }}' for pattern in patterns])
        token = self.tokens['a' * 32]
        ws, ident = 'a' * 32, 'b' * 32
        grant, conversation = 'otag_' + 'A' * 26, 'otc_' + 'B' * 26
        for uri, feature in (
            ('/v1/settings', 'settings'),
            ('/v1/stickers/' + ident + '/file', 'stickers'),
            ('/v1/skills/runs/' + ident + '/artifact', 'skills'),
            ('/v1/discover/works?kind=slides', 'discover'),
            ('/v1/discover/agents/test-agent/remix', 'discover'),
            ('/v1/agent-copy-grants/recipients', 'agents'),
            (f'/v1/agent-copy-grants/{grant}/remix', 'agents'),
            ('/v1/profile/follow-work', 'discover'),
            ('/v1/onboarding/automations', 'automations'),
            (f'/v1/workspaces/{ws}/automations/draft', 'automations'),
            (f'/v1/workspaces/{ws}/automations/schedule-preview', 'automations'),
            (f'/v1/workspaces/{ws}/agents/{ident}/conversations', 'agents'),
            (f'/v1/workspaces/{ws}/agents/{ident}/shares/{grant}/revoke', 'agents'),
            (f'/v1/workspaces/{ws}/agents/{ident}/access/{conversation}/revoke', 'agents'),
            (f'/v1/workspaces/{ws}/memory/actions/from-chat', 'memory'),
            (f'/v1/workspaces/{ws}/memory/{ident}/versions/123/restore', 'memory'),
            (f'/v1/workspaces/{ws}/memory/{ident}/pin', 'memory'),
            (f'/v1/workspaces/{ws}/team-runs/automation-results/{ident}/{ident}', 'team-runs'),
        ):
            with self.subTest(uri=uri):
                path = uri.partition('?')[0]
                self.assertTrue(any(re.fullmatch(pattern, path) for pattern in patterns))
                self.assertEqual(gw.moved_api(path), feature)
                status, headers = self.call(token, uri=uri)
                self.assertEqual(status, 204)
                self.assertIn('feature=' + feature, headers['X-OT-Upstream-Path'])
        self.assertIn('location = /space { return 418; }', conf)
        self.assertIn('location = /profile { return 418; }', conf)
        self.assertIn('rewrite ^/v1/discover/(works|agents)$ /_ot_public_feed/$1 last;', conf)

    def test_nginx_leaves_platform_api_exceptions_outside_runtime_fence(self):
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, key=KEY)
        patterns = re.findall(r'^  location ~ "(\^/v1/.*)" \{ return 418; \}$', conf, flags=re.M)
        self.assertIn('location = /v1/agent-homepages/start { return 410; }', conf)
        self.assertIn('location = /v1/composio/callback { proxy_pass http://127.0.0.1:8080;', conf)
        ws, ident = 'a' * 32, 'b' * 32
        for path in (
            '/v1/agent-homepages/start',
            '/v1/runtime/tasks',
            '/v1/composio/callback',
            '/v1/skills/unknown',
            '/v1/discover/unknown',
            '/v1/agent-copy-grants/unknown',
            '/v1/onboarding/unknown',
            '/v1/mcp/servers-other',
            f'/v1/workspaces/{ws}/agents/{ident}/runtime',
            f'/v1/workspaces/{ws}/agents/{ident}/runtime/unbind',
            f'/v1/workspaces/{ws}/agents/{ident}/homepage',
            f'/v1/workspaces/{ws}/agents/{ident}/homepage/revoke',
        ):
            with self.subTest(path=path):
                self.assertFalse(any(re.fullmatch(pattern, path) for pattern in patterns))
                self.assertIsNone(gw.target_for(path, gw.load_routes()))
                self.assertEqual(self.call(self.tokens['a' * 32], uri=path)[0], 404)

    def test_manager_import_bundles_are_scoped_to_the_granted_owner(self):
        import io
        token = secrets.token_urlsafe(32)
        self.app.manager_auth = ManagerAuth([ManagerIdentity('manager-a', digest(token), frozenset({'1' * 32, '3' * 32}), 'compose')])
        seal = 'ab' * 32
        raw = json.dumps({'seal_key': seal}).encode()

        def post(iid, body=raw, tok=token):
            env = {'REQUEST_METHOD': 'POST', 'PATH_INFO': f'/v1/internal/instances/{iid}/dsbot-import',
                   'REMOTE_ADDR': '127.0.0.1', 'CONTENT_LENGTH': str(len(body)), 'wsgi.input': io.BytesIO(body),
                   'HTTP_AUTHORIZATION': f'Bearer manager-a.{tok}'}
            seen = {}
            out = b''.join(gw.mount(None, self.app)(env, lambda st, h: seen.setdefault('s', int(st.split()[0]))))
            return seen['s'], json.loads(out)

        # No user rows is fine: empty tables, no secrets. B's instance is not granted.
        status, body = post('1' * 32)
        self.assertEqual(status, 200)
        self.assertTrue(body['owner_imported'])
        names = [f['name'] for f in body['features']]
        self.assertIn('settings', names)
        self.assertIn('model-api', names)
        self.assertIn('connectors', names)
        self.assertEqual(post('2' * 32)[0], 403)
        self.assertEqual(post('1' * 32, tok='x' * 43)[0], 401)
        self.assertEqual(post('1' * 32, body=json.dumps({'seal_key': '00'}).encode())[0], 400)
        with self.store.transaction() as db:
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,"
                       "desired,revision,operation_id,operation_type,observed,observed_revision,health,create_key,created) "
                       "VALUES(?,?,?,'p','compose','img','legacy-volume','running',1,'op','create','running',1,'healthy','legacy',0)",
                       ('3' * 32, '0' * 32, 'a' * 32))
            db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?,?,?)',
                       ('a' * 32, '0' * 32, 'a' * 32, '1' * 32, 'manager-a', 1))
        status, rejected = post('3' * 32)
        self.assertEqual((status, rejected['error']['code']), (409, 'import_destination'))
        self.assertEqual(post('1' * 32)[0], 200)

if __name__ == '__main__':
    unittest.main()

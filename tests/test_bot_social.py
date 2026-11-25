"""Bot Social collaboration endpoint tests. In-process WSGI + temporary SQLite only.

Does not contact a live Bot Social server or store connector tokens.
"""
import json
import tempfile
import unittest
from pathlib import Path

from flybot_workspace import bot_social
from flybot_workspace.app import App, Config
from flybot_workspace.operator_config import OperatorAdmin
from flybot_workspace.security import digest
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, seed_legacy_workspace

TOKEN = 'A' * 43


class ParseServerUrlTests(unittest.TestCase):
    def test_accepts_https_and_loopback_http(self):
        self.assertEqual(bot_social.parse_server_url('https://social.example/team'), 'https://social.example/team')
        self.assertEqual(bot_social.parse_server_url('https://flybot-workspace.example/social'),
                         'https://flybot-workspace.example/social')
        self.assertEqual(bot_social.parse_server_url('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
        self.assertEqual(bot_social.parse_server_url('localhost:8787'), 'http://localhost:8787')
        self.assertEqual(bot_social.parse_server_url(''), None)
        self.assertEqual(bot_social.parse_server_url(None), None)

    def test_rejects_plain_http_remote_userinfo_and_query(self):
        with self.assertRaises(bot_social.BotSocialConfigError):
            bot_social.parse_server_url('http://example.com')
        with self.assertRaises(bot_social.BotSocialConfigError):
            bot_social.parse_server_url('https://user:pass@social.example')
        with self.assertRaises(bot_social.BotSocialConfigError):
            bot_social.parse_server_url('https://social.example/?x=1')
        with self.assertRaises(bot_social.BotSocialConfigError):
            bot_social.parse_server_url('ftp://social.example')


class BotSocialAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(
            Store(Path(self.temp.name) / 'state'),
            Config(ORIGIN, allow_registration=True),
            clock=lambda: self.now,
            operator_admin=OperatorAdmin(digest(TOKEN)),
        )
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.wid = seed_legacy_workspace(self.alice)['id']
        self.bob = Client(self.app)
        self.bob.register('bob')

    def admin(self, method, path, body=None, peer='127.0.0.1', origin=None, **headers):
        client = Client(self.app, peer)
        return client.call(method, path, body, {'HTTP_AUTHORIZATION': 'Bearer ' + TOKEN, **headers},
                           origin=origin, csrf=False)

    def save_workspace(self, revision, changes, wid=None):
        return self.alice.call('POST', f'/v1/workspaces/{wid or self.wid}/bot-social', {
            'revision': revision, 'changes': changes,
        })

    def test_platform_default_is_used_until_a_workspace_override_is_set(self):
        empty = self.admin('GET', '/v1/admin/bot-social')
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['effective']['source'], 'none')
        self.assertIsNone(empty['body']['bot_social']['server'])
        created = self.admin('POST', '/v1/admin/bot-social', {
            'revision': 0,
            'changes': {'server': 'https://social.example', 'displayName': 'FlyBot'},
        })
        self.assertEqual(created['status'], 200, created)
        self.assertEqual(created['body']['bot_social']['server'], 'https://social.example')
        self.assertEqual(created['body']['bot_social']['displayName'], 'FlyBot')
        self.assertNotIn('token', json.dumps(created))
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/bot-social')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['effective']['source'], 'platform')
        self.assertEqual(seen['body']['effective']['server'], 'https://social.example')
        self.assertIsNone(seen['body']['bot_social']['server'])
        override = self.save_workspace(0, {'server': 'https://team.social.example/home', 'displayName': 'Team'})
        self.assertEqual(override['status'], 200, override)
        again = self.alice.call('GET', f'/v1/workspaces/{self.wid}/bot-social')
        self.assertEqual(again['body']['effective']['source'], 'workspace')
        self.assertEqual(again['body']['effective']['server'], 'https://team.social.example/home')
        self.assertEqual(again['body']['bot_social']['displayName'], 'Team')

    def test_rejects_a_token_field_and_an_invalid_url(self):
        refused = self.admin('POST', '/v1/admin/bot-social', {
            'revision': 0,
            'changes': {'server': 'https://social.example', 'token': 'ot-fake-should-not-be-stored'},
        })
        self.assertEqual(refused['status'], 400)
        self.assertIn('token', refused['body'].get('error', {}).get('message', '').lower() + json.dumps(refused['body']))
        bad = self.admin('POST', '/v1/admin/bot-social', {
            'revision': 0,
            'changes': {'server': 'http://example.com'},
        })
        self.assertEqual(bad['status'], 400)
        with self.app.store.connect() as db:
            self.assertIsNone(bot_social.load_platform(db))

    def test_workspace_member_cannot_change_override(self):
        # bob is not in alice's workspace
        denied = self.bob.call('GET', f'/v1/workspaces/{self.wid}/bot-social')
        self.assertEqual(denied['status'], 404)
        outsider = self.bob.call('POST', f'/v1/workspaces/{self.wid}/bot-social', {
            'revision': 0, 'changes': {'server': 'https://evil.example'},
        })
        self.assertIn(outsider['status'], (403, 404))

    def test_clearing_the_platform_server_leaves_no_container_payload(self):
        self.admin('POST', '/v1/admin/bot-social', {
            'revision': 0, 'changes': {'server': 'https://social.example'},
        })
        cleared = self.admin('POST', '/v1/admin/bot-social', {
            'revision': 1, 'changes': {'server': None},
        })
        self.assertEqual(cleared['status'], 200, cleared)
        self.assertIsNone(cleared['body']['bot_social']['server'])
        with self.app.store.connect() as db:
            public, source = bot_social.resolve(db)
            self.assertIsNone(bot_social.container_payload(public, source))

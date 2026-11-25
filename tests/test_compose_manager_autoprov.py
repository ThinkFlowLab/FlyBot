"""poll-once discovers server auto-provisioned instances over real loopback HTTP; Docker is a stub."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from dataclasses import replace
import io
import json
from threading import Event, Lock
import unittest
from unittest.mock import patch

import test_compose_manager as base
from flybot_workspace import model_api
from flybot_workspace.lifecycle import GATEWAY_REFRESH_SECONDS, ManagerAuth, ManagerIdentity
from flybot_workspace.dsbot_gateway import ensure_schema, owner_runtime_readiness, record_upstream
from flybot_workspace.manager.__main__ import main, dsbot_import, dsbot_route
from flybot_workspace.manager.engine import ComposeEngine, Registry, Runner
from flybot_workspace.manager.safety import ManagerError, write_new
from flybot_workspace.manager.worker import ManagerWorker
from flybot_workspace.runtime_autoprovision import AutoProvisionPolicy
from flybot_workspace.security import digest
from tests.test_management import Client


class AutoProvisionPollTests(unittest.TestCase):
    setUp = base.ComposeManagerTests.setUp
    start_http = base.ComposeManagerTests.start_http
    create = base.ComposeManagerTests.create
    manager = base.ComposeManagerTests.manager
    put_model_api = base.ComposeManagerTests.put_model_api

    def enable_auto(self, static=False):
        # The Docker stub models one project, so the auto-only manager has no static grant here.
        grants = frozenset([self.iid]) if static else frozenset()
        self.app.manager_auth = ManagerAuth([ManagerIdentity('manager-a', digest(self.token), grants, 'compose', True)])
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='manager-a', max_instances=3)

    def auto_instance(self, name='carol', peer='127.0.0.9', static=False):
        self.enable_auto(static)
        user = Client(self.app, peer=peer)
        registration = user.register(name)
        self.assertEqual(registration['status'], 201)
        owner = registration['body']['user']['id']
        # Before any home request, signup has already queued exactly one owner-scoped start.
        with self.store.connect() as db:
            first = db.execute(
                'SELECT p.instance_id, i.desired, j.operation_type, j.revision FROM runtime_auto_provisions p '
                'JOIN instances i ON i.id=p.instance_id JOIN runtime_jobs j ON j.instance_id=i.id WHERE p.user_id=?',
                (owner,),
            ).fetchall()
        self.assertEqual(len(first), 1)
        self.assertEqual(tuple(first[0])[1:], ('running', 'start', 1))
        agent = user.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertEqual(registration['body']['personal_chat'],
                         {'workspace_id': agent['workspace']['id'], 'agent_id': agent['agent']['id']})
        state = agent['runtime_provisioning']
        self.assertEqual((state['state'], state['instance_id']), ('existing', first[0]['instance_id']))
        return user, state['instance_id']

    def poll(self, *options):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(['--config', str(self.cfgpath), '--execute', 'poll-once', *options])
        return code, json.loads(out.getvalue())

    def test_poll_once_adopts_auto_instance_without_restart(self):
        self.start_http()
        self.put_model_api('platform', 'synthetic-platform-fixture-key')
        with self.store.transaction() as db:
            ensure_schema(db)
        _, auto = self.auto_instance()
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfgpath.write_text(json.dumps(self.cfg))
        code, first = self.poll()
        self.assertEqual(code, 0, first)
        self.assertEqual([r['instance_id'] for r in first['results']], [auto])
        by_id = {r['instance_id']: r for r in first['results']}
        self.assertEqual(by_id[auto]['status'], 'observed', first)
        self.assertEqual(by_id[auto]['observed'], 'running', first)
        self.assertEqual(by_id[auto]['revision'], 1)
        lease_files = self.root / 'secrets'
        config = json.loads((lease_files / ('model-api-' + auto + '.json')).read_text())
        self.assertEqual((config['source'], config['api_key']), ('platform', 'synthetic-platform-fixture-key'))
        with self.store.transaction() as db:
            owner = db.execute('SELECT owner_id FROM instances WHERE id=?', (auto,)).fetchone()[0]
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_jobs WHERE instance_id=?', (auto,)).fetchone()[0], 1)
            self.assertEqual(owner_runtime_readiness(db, owner), 'starting')
            record_upstream(db, auto, '10.0.0.1:8080', 'dsh-auth-fixture=' + 'x' * 24, self.now)
            self.assertEqual(owner_runtime_readiness(db, owner), 'ready')
        # A repeat poll cannot enqueue or run an additional startup.
        code, second = self.poll()
        self.assertEqual(code, 0, second)
        by_id = {r['instance_id']: r for r in second['results']}
        self.assertEqual(by_id[auto]['status'], 'no_claim', second)
        manager_cfg = json.loads(self.cfgpath.read_text())
        self.assertNotIn(auto, manager_cfg['instances'])  # never written back

    def test_browser_resumes_the_existing_granted_container_without_auto_adopting_it(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        fixture = self.root / 'stub-engine.json'
        before = json.loads(fixture.read_text())
        with self.store.connect() as db:
            ensure_schema(db)

        readiness, start = '/v1/auth/runtime-readiness', '/v1/auth/runtime-start'
        self.enable_auto()
        self.assertEqual(self.client.call('GET', readiness)['body']['state'], 'unavailable')
        self.assertEqual(self.client.call('POST', start, {})['status'], 409)
        self.assertEqual(client.assigned(), [])

        self.app.manager_auth = ManagerAuth([
            self.identity,
            ManagerIdentity('auto-manager', 'b' * 64, frozenset(), 'compose', True),
        ])
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-manager', max_instances=3)
        bound = self.client.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual((bound['state'], bound['instance_id'], bound['readiness']), ('bound', self.iid, 'stopped'))
        self.assertEqual(self.client.call('GET', readiness)['body']['state'], 'stopped')
        self.assertEqual(self.client.call('POST', start, {}, csrf=False)['status'], 403)
        self.assertEqual(self.client.call('POST', start, {'instance_id': 'a' * 32})['status'], 400)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.client.call('POST', start, {}), range(2)))
        self.assertEqual(sorted(reply['status'] for reply in responses), [200, 202])
        self.assertTrue(all(reply['body'] == {'state': 'starting'} for reply in responses))

        self.assertEqual(worker.run_once(self.iid)['observed'], 'running')
        after = json.loads(fixture.read_text())
        self.assertEqual((after['id'], after['sentinel']), (before['id'], before['sentinel']))
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM instances').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_auto_provisions').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_jobs').fetchone()[0], 2)
            record_upstream(db, self.iid, '10.0.0.1:8080', 'dsh-auth-fixture=' + 'x' * 24, self.now)
        self.assertEqual(self.client.call('GET', readiness)['body']['state'], 'ready')

    def test_pending_owners_use_two_fenced_worker_slots(self):
        self.start_http()
        assigned = [self.auto_instance(name, '127.0.0.' + str(peer))[1]
                    for name, peer in (('alice2', 11), ('bob2', 12), ('carol2', 13))]
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfgpath.write_text(json.dumps(self.cfg))
        started = []
        entered_two, release = Event(), Event()
        lock = Lock()

        def slow_start(worker, iid):
            with lock:
                started.append(iid)
                if len(started) == 2:
                    entered_two.set()
            if not release.wait(4):
                raise AssertionError('independent owners did not enter both worker slots')
            return {'status': 'observed', 'instance_id': iid, 'observed': 'running'}

        with patch.object(ManagerWorker, 'run_once', new=slow_start), ThreadPoolExecutor(max_workers=1) as poller:
            future = poller.submit(self.poll)
            try:
                self.assertTrue(entered_two.wait(2))
                with lock:
                    self.assertEqual(len(started), 2)
            finally:
                release.set()
            code, result = future.result(timeout=5)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(started), sorted(assigned))
        self.assertEqual([row['instance_id'] for row in result['results']], sorted(assigned))

    def test_new_signup_uses_the_spare_worker_of_an_active_poll(self):
        client = self.start_http()
        _, cold = self.auto_instance()
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfgpath.write_text(json.dumps(self.cfg))
        entered, release, late_started = Event(), Event(), Event()

        def hold_start(_worker, iid):
            claim = client.claim(iid)
            if iid == cold:
                entered.set()
                self.assertTrue(release.wait(6))
            job = claim['job']
            client.leased_call(iid, claim, 'observe', observed='running', process_ref='c' * 32)
            if iid != cold:
                late_started.set()
            return {'status': 'observed', 'instance_id': iid, 'observed': 'running'}

        with patch.object(ManagerWorker, 'run_once', new=hold_start), ThreadPoolExecutor(max_workers=1) as poller:
            future = poller.submit(self.poll)
            try:
                self.assertTrue(entered.wait(2))
                _, late = self.auto_instance('dana', '127.0.0.10')
                self.assertTrue(late_started.wait(3), 'the new signup waited for another owner')
                self.assertFalse(future.done())
            finally:
                release.set()
            code, result = future.result(timeout=5)

        self.assertEqual(code, 0, result)
        self.assertEqual([row['instance_id'] for row in result['results']], [cold, late])
        with self.store.connect() as db:
            self.assertEqual([(row['instance_id'], row['status']) for row in db.execute(
                'SELECT instance_id,status FROM runtime_jobs WHERE instance_id IN (?,?) ORDER BY instance_id',
                (cold, late))], [(iid, 'succeeded') for iid in sorted((cold, late))])

    def test_route_repair_for_a_running_owner_proceeds_during_another_owners_start(self):
        client = self.start_http()
        _, cold = self.auto_instance()
        online, repair = self.auto_instance('dana', '127.0.0.10')
        self.cfg['instances'] = {}
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['dsbot_gateway'] = {'web_container': 'fixture-web'}
        self.cfgpath.write_text(json.dumps(self.cfg))
        claim = client.claim(repair)
        client.leased_call(repair, claim, 'observe', observed='running', process_ref='c' * 32)
        with self.store.transaction() as db:
            ensure_schema(db)
        path = '/v1/auth/runtime-readiness'
        self.assertEqual(online.call('GET', path)['body']['state'], 'starting')
        entered, release, rerouted = Event(), Event(), Event()

        def wait_for_start(_worker, iid):
            self.assertEqual(iid, cold)
            entered.set()
            self.assertTrue(release.wait(4))
            return {'status': 'no_claim', 'instance_id': iid}

        def publish(_engine, _client, iid):
            self.assertEqual(iid, repair)
            with self.store.transaction() as db:
                record_upstream(db, repair, '10.0.0.2:8080', 'dsh-auth-fixture=' + 'x' * 24, self.now)
            rerouted.set()
            return {'status': 'published', 'instance_id': repair}

        with (patch.object(ManagerWorker, 'run_once', new=wait_for_start),
              patch.object(dsbot_route, 'publish', side_effect=publish),
              ThreadPoolExecutor(max_workers=1) as observer):
            future = observer.submit(self.poll)
            try:
                self.assertTrue(entered.wait(2))
                self.assertTrue(rerouted.wait(2))
                self.assertFalse(future.done())
                self.assertEqual(online.call('GET', path)['body']['state'], 'ready')
            finally:
                release.set()
            code, result = future.result(timeout=5)
        self.assertEqual(code, 0, result)
        accepted = [(row['instance_id'], row['status']) for row in result['results']]
        self.assertEqual(accepted, [(cold, 'no_claim'), (cold, 'not_running'),
                                    (repair, 'no_claim'), (repair, 'published')])

    def test_new_accounts_inherit_platform_model_and_restart_picks_up_rotation(self):
        client = self.start_http()
        original = 'synthetic-platform-fixture-key'
        rotated = 'rotated-platform-fixture-key'
        self.put_model_api('platform', original)
        carol, first = self.auto_instance()
        dana, second = self.auto_instance('dana', peer='127.0.0.10')
        self.assertNotEqual(first, second)
        self.assertEqual(carol.call('GET', f'/v1/instances/{second}')['status'], 404)
        self.assertEqual(dana.call('GET', f'/v1/instances/{first}')['status'], 404)
        carol_instance = carol.call('GET', f'/v1/instances/{first}')['body']['instance']
        personal_workspace = carol_instance['workspace_id']
        old_account_key = 'synthetic-legacy-account-key'
        old_workspace_key = 'synthetic-legacy-workspace-key'
        self.put_model_api('account', old_account_key, account_id=carol_instance['owner_id'])
        workspace_settings = f'/v1/workspaces/{personal_workspace}/model-api'
        workspace_saved = carol.call('POST', workspace_settings, {'revision': 0, 'changes': {
            'provider': 'openai', 'base_url': 'https://workspace.example/v1', 'model': 'workspace-model',
            'api_key': old_workspace_key,
        }})
        self.assertEqual(workspace_saved['status'], 200)

        def start(iid):
            # The Docker stub keeps a single project's state per fixture directory.
            root = self.root / iid
            root.mkdir(mode=0o700)
            path = root / 'manager.json'
            write_new(path, {**self.cfg, 'instances': {},
                             'auto_instances': {'image': base.IMAGE, 'healthcheck': None}})
            registry = Registry(str(path))
            snapshot = client.snapshot(iid)
            self.assertEqual(snapshot['volume_ref'], 'ot-' + iid)
            registry.adopt(iid, snapshot)
            engine = ComposeEngine(registry, Runner(registry, enabled=True))
            worker = ManagerWorker(client, registry, engine)
            boot = worker.run_once(iid)
            self.assertEqual(boot['observed'], 'running')
            secret = engine.secret_path(iid)
            self.assertEqual(secret.relative_to(root).as_posix(), f'secrets/model-api-{iid}.json')
            payload = json.loads(secret.read_text())
            self.assertEqual((payload['source'], payload['api_key']), ('platform', original))
            self.assertNotIn(original, json.dumps(boot))
            return worker, secret, boot['process_ref']

        first_worker, first_secret, first_process = start(first)
        _, second_secret, _ = start(second)
        self.assertNotEqual(first_secret, second_secret)
        for api, response in (
            (f'/v1/instances/{first}', 'instance'),
            (f'/v1/workspaces/{personal_workspace}/instances', 'items'),
        ):
            body = carol.call('GET', api)['body']
            snapshot = body[response][0] if response == 'items' else body[response]
            self.assertEqual(snapshot['model_api']['source'], 'platform')
            self.assertNotIn(old_account_key, json.dumps(body))
            self.assertNotIn(old_workspace_key, json.dumps(body))
        self.assertEqual(carol.call('POST', workspace_settings, {'revision': 1, 'changes': {'api_key': None}})['status'], 200)
        with self.store.transaction() as db:
            blob = model_api.wrap(model_api.wrapping_key(self.store), rotated)
            db.execute("UPDATE model_api_configs SET key_blob=?, revision=revision+1 WHERE scope='platform'", (blob,))
        restart = carol.call('POST', f'/v1/instances/{first}/restart', {'operation_id': 'rotate-platform-model-0001'})
        self.assertEqual(restart['status'], 202)
        receipt = first_worker.run_once(first)
        self.assertEqual(receipt['observed'], 'running')
        self.assertNotEqual(receipt['process_ref'], first_process)
        self.assertEqual(json.loads(first_secret.read_text())['api_key'], rotated)
        self.assertEqual(json.loads(second_secret.read_text())['api_key'], original)
        self.assertNotIn(rotated, json.dumps(receipt))

    def test_signup_remains_valid_when_personal_workspace_has_no_capacity(self):
        self.enable_auto()
        self.app.config = replace(self.app.config, max_workspaces=1)
        user = Client(self.app, peer='127.0.0.9')
        self.assertEqual(user.register('carol')['status'], 201)
        self.assertEqual(user.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(user.call('GET', '/v1/personal-agent')['body'], {'personal_agent': None})
        self.assertEqual(user.call('POST', '/v1/personal-agent')['status'], 429)
        self.app.config = replace(self.app.config, max_workspaces=10)
        provisioning = user.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual(provisioning['state'], 'provisioned')
        self.assertEqual(user.call('GET', '/v1/instances/' + provisioning['instance_id'])['body']['instance']['desired'], 'running')

    def test_explicit_workspace_create_honors_auto_capacity_and_queues_the_account_runtime(self):
        manager = self.start_http()
        _, first = self.auto_instance()
        self.app.auto_provision = replace(self.app.auto_provision, max_instances=1)
        dana = Client(self.app, peer='127.0.0.10')
        registration = dana.register('dana')
        self.assertEqual(registration['status'], 201)
        owner = registration['body']['user']['id']
        self.assertNotIn('personal_chat', registration['body'])
        personal = dana.call('GET', '/v1/personal-agent')['body']['personal_agent']
        personal_workspace = personal['workspace']['id']
        # An account may ask for an instance from another workspace it owns.
        # Its canonical runtime still belongs to its own personal space.
        other_workspace = '9' * 32
        with self.store.transaction() as db:
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (other_workspace, owner, 'Another workspace', self.now, digest(other_workspace), digest(other_workspace)))
        api = f'/v1/workspaces/{other_workspace}/instances'
        headers = {'HTTP_IDEMPOTENCY_KEY': 'explicit-account-create'}
        full = dana.call('POST', api, {}, headers)
        self.assertEqual(full['status'], 429, full['body'])
        self.assertEqual(full['body']['error']['code'], 'quota')
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM instances WHERE owner_id=?', (owner,)).fetchone()[0], 0)
        self.assertEqual([item['id'] for item in manager.assigned()], [first])

        self.app.auto_provision = replace(self.app.auto_provision, max_instances=2)
        self.assertEqual(dana.call('POST', api, {})['status'], 400)
        self.assertEqual(dana.call('POST', f'/v1/workspaces/{self.wid}/instances', {}, headers)['status'], 404)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: dana.call('POST', api, {}, headers), range(2)))
        self.assertEqual(sorted(result['status'] for result in responses), [200, 201])
        assigned = responses[0]['body']['instance']
        self.assertEqual(responses[1]['body']['instance']['id'], assigned['id'])
        self.assertEqual(assigned['workspace_id'], personal_workspace)
        self.assertEqual((assigned['desired'], assigned['operation']['type']), ('running', 'start'))
        self.assertEqual({item['id'] for item in manager.assigned()}, {first, assigned['id']})
        self.assertEqual(manager.claim(assigned['id'])['job']['operation_type'], 'start')
        state = dana.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual((state['state'], state['instance_id']), ('existing', assigned['id']))

    def test_without_template_auto_instance_is_skipped(self):
        self.start_http()
        _, auto = self.auto_instance(static=True)
        code, result = self.poll()
        self.assertEqual(code, 0, result)
        by_id = {r['instance_id']: r for r in result['results']}
        self.assertEqual(by_id[auto]['status'], 'skipped')

    def test_poll_prioritizes_cold_signup_in_results_and_skips_stopped_instance(self):
        client = self.start_http()
        _, cold = self.auto_instance(static=True)
        _, stopped = self.auto_instance('dana', peer='127.0.0.10', static=True)
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['dsbot_gateway'] = {'web_container': 'fixture-web'}
        self.cfgpath.write_text(json.dumps(self.cfg))
        pending_restart = {**client.snapshot(self.iid), 'desired': 'running', 'observed': 'running',
                           'converged': False, 'revision': 4, 'observed_revision': 3}
        stopped_instance = {**client.snapshot(stopped), 'desired': 'stopped', 'observed': 'stopped', 'converged': True}
        inventory = [pending_restart, stopped_instance, client.snapshot(cold)]
        events = []

        def work(_worker, iid):
            events.append(('claim', iid))
            return ({'status': 'observed', 'observed': 'running', 'instance_id': iid} if iid == cold
                    else {'status': 'no_claim', 'instance_id': iid})

        def publish(_engine, _client, iid):
            events.append(('route', iid))
            return {'status': 'published', 'instance_id': iid}

        with (patch.object(base.ManagerClient, 'assigned', return_value=inventory),
              patch.object(ManagerWorker, 'run_once', autospec=True, side_effect=work),
              patch.object(dsbot_route, 'publish', side_effect=publish)):
            code, result = self.poll()
        self.assertEqual(code, 0, result)
        # The restart runs in a separate worker. Only operations for the same
        # instance have a guaranteed order of execution.
        self.assertCountEqual(events, [('claim', cold), ('route', cold), ('claim', self.iid)])
        self.assertLess(events.index(('claim', cold)), events.index(('route', cold)))
        self.assertEqual([(row['instance_id'], row['status']) for row in result['results']], [
            (cold, 'observed'), (cold, 'published'),
            (self.iid, 'no_claim'), (self.iid, 'not_running'),
            (stopped, 'no_claim'), (stopped, 'not_running'),
        ])

    def test_recent_route_skips_repeat_claim_and_docker_publish_until_due(self):
        client = self.start_http()
        _, iid = self.auto_instance()
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfg['dsbot_gateway'] = {'web_container': 'fixture-web'}
        self.cfgpath.write_text(json.dumps(self.cfg))
        with self.store.transaction() as db:
            ensure_schema(db)

        calls = []
        def publish(_engine, _client, target):
            calls.append(target)
            with self.store.transaction() as db:
                record_upstream(db, target, '10.0.0.1:8080', 'dsh-auth-fixture=' + 'x' * 24, int(self.runtime.clock()))
            return {'status': 'published', 'instance_id': target}

        with patch.object(dsbot_route, 'publish', side_effect=publish):
            self.assertEqual(self.poll()[0], 0)
            item = client.snapshot(iid)
            self.assertTrue(item['gateway_route_present'])
            self.assertTrue(item['gateway_route_fresh'])
            self.assertNotIn('auth_cookie', item)
            self.assertNotIn('address', item)
            with patch.object(ManagerWorker, 'run_once', side_effect=AssertionError('idle claim')):
                self.assertEqual(self.poll()[0], 0)
                self.assertEqual(calls, [iid])
                with self.store.transaction() as db:
                    db.execute('UPDATE dsbot_upstreams SET updated=updated-? WHERE instance_id=?', (GATEWAY_REFRESH_SECONDS, iid))
                stale = client.snapshot(iid)
                self.assertTrue(stale['gateway_route_present'])
                self.assertFalse(stale['gateway_route_fresh'])
                self.assertEqual(self.poll()[0], 0)
                self.assertEqual(calls, [iid, iid])
                with self.store.transaction() as db:
                    db.execute('DELETE FROM dsbot_upstreams WHERE instance_id=?', (iid,))
                self.assertFalse(client.snapshot(iid)['gateway_route_present'])
                self.assertEqual(self.poll()[0], 0)
                self.assertEqual(calls, [iid, iid, iid])
                with patch.object(dsbot_import, 'deliver', return_value={'status': 'delivered'}) as deliver:
                    self.assertEqual(self.poll('--import-legacy')[0], 0)
                    self.assertEqual(calls, [iid, iid, iid, iid])
                    self.assertEqual(deliver.call_args.args[-1], iid)

    def test_adopt_requires_matching_auto_snapshot(self):
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfgpath.write_text(json.dumps(self.cfg))
        registry = Registry(str(self.cfgpath))
        iid = 'b' * 32
        good = {'id': iid, 'provisioning': 'auto', 'backend_mode': 'compose', 'image_ref': base.IMAGE, 'volume_ref': 'ot-' + iid}
        for bad in ({**good, 'provisioning': 'operator'}, {**good, 'image_ref': 'other/image@sha256:' + 'b' * 64},
                    {**good, 'volume_ref': 'ot-' + 'c' * 32}, {**good, 'id': 'c' * 32}):
            with self.assertRaises(ManagerError):
                registry.adopt(iid, bad)
        with self.assertRaises(ManagerError):
            registry.adopt(self.iid, {**good, 'id': self.iid, 'volume_ref': 'ot-' + self.iid})
        self.assertEqual(registry.adopt(iid, good)['publish_port'], None)
        entry, _ = registry.entry(iid, good)
        self.assertEqual(entry['image'], base.IMAGE)


if __name__ == '__main__':
    unittest.main()

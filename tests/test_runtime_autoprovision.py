"""Operator opt-in per-user runtime auto-provisioning and manager assignment scoping.

In-process WSGI with SQLite and the simulation lifecycle only; synthetic data,
loopback peers, no Docker, no vendor or model calls.
"""
from dataclasses import replace
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.dsbot_gateway import ensure_schema, record_upstream
from flybot_workspace.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimeFault, RuntimePolicy
from flybot_workspace.operator_config import load_auto_provision, load_manager_auth
from flybot_workspace.runtime_autoprovision import AutoProvisionPolicy, capacity_status, set_parked
from flybot_workspace.security import digest, opaque
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, seed_legacy_workspace


class AutoProvisionTests(unittest.TestCase):
    def make_app(self, enabled=True, max_instances=5, auto_manager=True, grants=()):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, RuntimePolicy(), clock=lambda: self.now)
        self.token, self.other_token = opaque(), opaque()
        auth = ManagerAuth([
            ManagerIdentity('auto-mgr', digest(self.token), frozenset(grants), 'simulation', auto_manager),
            ManagerIdentity('other-mgr', digest(self.other_token), frozenset(), 'simulation', True),
        ])
        policy = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=max_instances) if enabled else None
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: self.now,
                       lifecycle=self.runtime, manager_auth=auth, auto_provision=policy)

    def user(self, name, peer):
        client = Client(self.app, peer=peer)
        self.assertEqual(client.register(name)['status'], 201)
        return client

    def manager(self, method, path, body=None, token=None, name='auto-mgr'):
        return Client(self.app).call(method, path, body,
                                     {'HTTP_AUTHORIZATION': f'Bearer {name}.' + (token or self.token)},
                                     origin=None, csrf=False)

    def listed(self, **kw):
        result = self.manager('GET', '/v1/internal/instances?limit=100', **kw)
        self.assertEqual(result['status'], 200, result)
        return result['body']['items']

    def ensure(self, client):
        result = client.call('POST', '/v1/personal-agent')
        self.assertIn(result['status'], (200, 201), result)
        return result['body']['personal_agent']

    def run_job(self, iid, observed, process_ref=None):
        claim = self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': iid})
        self.assertEqual(claim['status'], 200, claim)
        body = claim['body']['claim']
        self.assertIsNotNone(body)
        lease = {'job_id': body['job']['id'], 'observed_revision': body['job']['revision'], 'lease': body['lease']}
        agent_bootstrap = None
        if body['job']['operation_type'] != 'stop':
            bootstrap = self.manager('POST', f'/v1/internal/instances/{iid}/runtime-agent-bootstrap', lease)
            self.assertEqual(bootstrap['status'], 200, bootstrap)
            self.assertEqual(set(bootstrap['body']), {'agent_bootstrap'})
            self.assertEqual(self.manager('POST', f'/v1/internal/instances/{iid}/runtime-agent-key', lease)['status'], 404)
            agent_bootstrap = bootstrap['body']['agent_bootstrap']
        payload = {**lease, 'observed': observed}
        if process_ref:
            payload['process_ref'] = process_ref
        result = self.manager('POST', f'/v1/internal/instances/{iid}/observe', payload)
        self.assertEqual(result['status'], 200, result)
        # Receipt is for the claimed job even when the server queues a follow-up start.
        self.assertEqual(result['body']['job']['id'], body['job']['id'])
        self.assertEqual(result['body']['job']['status'], 'succeeded')
        return agent_bootstrap

    def count(self, sql, *args):
        with self.store.connect() as db:
            return db.execute(sql, args).fetchone()[0]

    def assert_chat_execution_stays_in_dsbot(self, client, personal):
        wid, aid = personal['workspace']['id'], personal['agent']['id']
        base = f'/v1/workspaces/{wid}/agents/{aid}/conversations'
        with self.store.connect() as db:
            cid = db.execute('SELECT id FROM agent_conversations WHERE agent_id=?', (aid,)).fetchone()[0]
        before = self.count('SELECT COUNT(*) FROM agent_messages WHERE conversation_id=?', cid)
        listed = client.call('GET', base)
        sent = client.call('POST', f'{base}/{cid}/messages', {'body': 'hello'},
                           {'HTTP_IDEMPOTENCY_KEY': 'autoprov-retired-msg-0001'})
        for result in (listed, sent):
            self.assertEqual(result['status'], 410, result)
            self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')
        self.assertEqual(self.count('SELECT COUNT(*) FROM agent_messages WHERE conversation_id=?', cid), before)
        self.assertEqual(self.count('SELECT COUNT(*) FROM runtime_tasks'), 0)

    def test_disabled_by_default_keeps_the_dsbot_execution_fence(self):
        self.make_app(enabled=False)
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        self.assertNotIn('runtime_provisioning', personal)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 0)
        self.assertEqual(self.listed(), [])
        self.assertEqual(alice.call('GET', '/v1/auth/runtime-readiness')['body']['state'], 'unmanaged')
        self.assert_chat_execution_stays_in_dsbot(alice, personal)

    def test_provision_bind_idempotent_and_isolated(self):
        self.make_app()
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        first = self.ensure(alice)
        state = first['runtime_provisioning']
        self.assertEqual(state['state'], 'provisioned')
        self.assertEqual(state['error_code'], 'runtime_starting')
        iid = state['instance_id']
        again = self.ensure(alice)['runtime_provisioning']
        self.assertEqual((again['state'], again['instance_id']), ('existing', iid))
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances WHERE owner_id=(SELECT id FROM users WHERE username=?)', 'alice'), 1)
        wid, aid = first['workspace']['id'], first['agent']['id']
        owner = alice.call('GET', '/v1/auth/session')['body']['user']['id']
        with self.store.connect() as db:
            binding = db.execute('SELECT workspace_id,agent_id,instance_id,manager_id FROM runtime_auto_provisions '
                                 'WHERE user_id=?', (owner,)).fetchone()
        self.assertEqual(tuple(binding), (wid, aid, iid, 'auto-mgr'))
        inst = alice.call('GET', f'/v1/instances/{iid}')
        self.assertEqual(inst['status'], 200, inst)
        self.assertEqual(inst['body']['instance']['workspace_id'], wid)
        bob_personal = self.ensure(bob)
        bob_state = bob_personal['runtime_provisioning']
        self.assertNotEqual(bob_state['instance_id'], iid)
        # Old agent-level bindings expose nothing; only the account owns an instance.
        self.assertEqual(bob.call('GET', f'/v1/instances/{iid}')['status'], 404)
        self.assertEqual(alice.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/runtime')['status'], 404)
        self.assertEqual(bob.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/runtime')['status'], 404)
        rebind = bob.call('POST', f"/v1/workspaces/{bob_personal['workspace']['id']}/agents/{bob_personal['agent']['id']}/runtime",
                          {'instance_id': iid, 'revision': 1})
        self.assertEqual(rebind['status'], 404)
        self.assertEqual(self.ensure(bob)['runtime_provisioning']['instance_id'], bob_state['instance_id'])
        self.assertEqual(self.count('SELECT COUNT(*) FROM workspace_agent_bindings'), 0)
        ids = {item['id'] for item in self.listed()}
        self.assertEqual(ids, {iid, bob_state['instance_id']})
        self.assertTrue(all(item['provisioning'] == 'auto' for item in self.listed()))

    def test_first_chat_waits_for_the_owners_confirmed_upstream(self):
        self.make_app()
        with self.store.transaction() as db:
            ensure_schema(db)
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        path = '/v1/auth/runtime-readiness'
        alice_id = alice.call('GET', '/v1/auth/session')['body']['user']['id']
        bob_id = bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.assertEqual(Client(self.app).call('GET', path)['status'], 401)
        self.assertEqual(alice.call('GET', path)['body'], {'state': 'setup', 'user_id': alice_id})
        personal = self.ensure(alice)
        provision = personal['runtime_provisioning']
        iid = provision['instance_id']
        self.assertEqual(provision['readiness'], 'starting')
        self.assertEqual(alice.call('GET', path)['body'], {'state': 'starting', 'user_id': alice_id})
        self.run_job(iid, 'stopped')
        self.run_job(iid, 'running', process_ref='a' * 32)
        self.assertEqual(alice.call('GET', path)['body'], {'state': 'starting', 'user_id': alice_id})
        with self.store.transaction() as db:
            record_upstream(db, iid, '10.0.0.1:8788', 'dsh-auth-test=' + 'x' * 20, self.now)
        self.assertEqual(alice.call('GET', path)['body'], {'state': 'ready', 'user_id': alice_id})
        self.assertEqual(alice.call('GET', path + '?include=personal-chat')['body'],
                         {'state': 'ready', 'user_id': alice_id, 'personal_chat': {
                             'workspace_id': personal['workspace']['id'], 'agent_id': personal['agent']['id']}})
        self.assertEqual(bob.call('GET', path + '?include=personal-chat')['body'],
                         {'state': 'setup', 'user_id': bob_id})
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET desired='stopped' WHERE id=?", (iid,))
        self.assertEqual(alice.call('GET', path)['body'], {'state': 'unavailable', 'user_id': alice_id})

    def test_auto_provision_returns_personal_bootstrap_without_minting_key(self):
        self.make_app()
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        personal = self.ensure(alice)
        other = self.ensure(bob)
        iid = personal['runtime_provisioning']['instance_id']
        created = self.run_job(iid, 'stopped')
        started = self.run_job(iid, 'running', process_ref='a' * 32)
        for bundle in (created, started):
            self.assertEqual((bundle['instance_id'], bundle['feature']), (iid, 'agents'))
            bindings = json.loads(bundle['tables']['personal_agents'])
            self.assertEqual(len(bindings), 1)
            self.assertEqual(bindings[0]['workspace_id'], personal['workspace']['id'])
            self.assertEqual(bindings[0]['agent_id'], personal['agent']['id'])
            self.assertNotIn(other['agent']['id'], bundle['tables']['workspace_agents'])
        self.assertEqual(self.count('SELECT COUNT(*) FROM runtime_keys'), 0)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instance_runtime_keys'), 0)
        self.assertFalse((self.store.path.parent / 'instance-runtime.wrap').exists())

    def test_concurrent_ensure_creates_one_instance(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        results, errors = [], []
        def go():
            try:
                results.append(Client.call(alice, 'POST', '/v1/personal-agent'))
            except Exception as error:  # pragma: no cover - surfaced below
                errors.append(error)
        threads = [threading.Thread(target=go) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertTrue(all(r['status'] in (200, 201) for r in results), results)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        self.assertEqual(self.count('SELECT COUNT(*) FROM runtime_auto_provisions'), 1)
        self.assertEqual(self.count('SELECT COUNT(*) FROM workspace_agent_bindings'), 0)

    def test_retired_agent_binding_cannot_block_an_owners_first_runtime(self):
        self.make_app(enabled=False)
        alice = self.user('alice', '127.0.0.1')
        bob = self.user('bob', '127.0.0.2')
        with self.store.transaction() as db:
            owner = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            row, _ = self.app.ensure_personal_agent(db, owner, 'alice', self.now)
            old_binding = (row['agent_id'], row['workspace_id'], 'a' * 32, 1, owner, self.now, self.now)
            db.execute('INSERT INTO workspace_agent_bindings VALUES(?,?,?,?,?,?,?)', old_binding)
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)

        first = self.ensure(alice)['runtime_provisioning']
        other = self.ensure(bob)['runtime_provisioning']
        self.assertEqual(first['state'], 'provisioned')
        self.assertEqual(other['state'], 'provisioned')
        self.assertNotIn(first['instance_id'], (old_binding[2], other['instance_id']))
        self.assertEqual(self.ensure(alice)['runtime_provisioning']['instance_id'], first['instance_id'])
        self.assertEqual(bob.call('GET', f"/v1/instances/{first['instance_id']}")['status'], 404)
        with self.store.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM workspace_agent_bindings')], [old_binding])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_auto_provisions').fetchone()[0], 2)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_global_cap_refuses_cleanly_with_actionable_chat_state(self):
        self.make_app(max_instances=1)
        with self.store.transaction() as db:
            ensure_schema(db)
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        self.assertEqual(self.ensure(alice)['runtime_provisioning']['state'], 'provisioned')
        path = '/v1/auth/runtime-readiness'
        bob_id = bob.call('GET', '/v1/auth/session')['body']['user']['id']
        # A readiness check cannot create a personal workspace or instance.
        with self.store.transaction():
            self.assertEqual(bob.call('GET', path)['body'], {'state': 'capacity', 'user_id': bob_id})
            self.assertEqual(bob.call('GET', '/v1/auth/session?include=home')['body']['home'],
                             {'runtime_state': 'capacity', 'personal_agent': None})
        self.assertEqual(self.count('SELECT COUNT(*) FROM personal_agents'), 1)
        self.assertEqual(alice.call('GET', path)['body']['state'], 'starting')
        bob_personal = self.ensure(bob)
        self.assertEqual(bob_personal['runtime_provisioning']['state'], 'capacity')
        self.assertEqual(bob_personal['runtime_provisioning']['readiness'], 'capacity')
        self.assertEqual(bob_personal['runtime_provisioning']['error_code'], 'runtime_capacity')
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        self.assertIsNone(bob_personal['runtime_provisioning']['instance_id'])
        self.assert_chat_execution_stays_in_dsbot(bob, bob_personal)
        self.app.auto_provision = replace(self.app.auto_provision, max_instances=2)
        self.assertEqual(bob.call('GET', path)['body'], {'state': 'setup', 'user_id': bob_id})
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        self.assertEqual(self.ensure(bob)['runtime_provisioning']['state'], 'provisioned')
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 2)

    def test_lifecycle_capacity_maps_to_capacity(self):
        self.make_app()
        with self.store.transaction() as db:
            ensure_schema(db)
        self.runtime.policy = RuntimePolicy(max_instances=1)
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        self.ensure(alice)
        self.assertEqual(bob.call('GET', '/v1/auth/runtime-readiness')['body']['state'], 'capacity')
        self.assertEqual(self.ensure(bob)['runtime_provisioning']['state'], 'capacity')

    def test_paused_owner_keeps_runtime_and_releases_one_reservation(self):
        self.make_app(max_instances=1)
        policy = self.app.auto_provision
        with self.store.transaction() as db:
            ensure_schema(db)
        alice = self.user('alice', '127.0.0.1')
        iid = self.ensure(alice)['runtime_provisioning']['instance_id']
        before = alice.call('GET', f'/v1/instances/{iid}')['body']['instance']
        with self.assertRaises(RuntimeFault) as pending, self.store.transaction() as db:
            set_parked(db, policy, iid, before['revision'], True, self.now)
        self.assertEqual(pending.exception.code, 'conflict')
        self.run_job(iid, 'stopped')
        self.run_job(iid, 'running', process_ref='a' * 32)
        owner_id = alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.runtime.stop(owner_id, iid)
        self.run_job(iid, 'stopped')
        stopped = alice.call('GET', f'/v1/instances/{iid}')['body']['instance']
        rev = stopped['revision']

        with self.store.transaction() as db:
            self.assertEqual(capacity_status(db, policy), {'limit': 1, 'reserved': 1, 'parked': 0, 'available': 0})
            with self.assertRaises(RuntimeFault) as stale:
                set_parked(db, policy, iid, rev - 1, True, self.now)
            self.assertEqual(stale.exception.current['revision'], rev)
            self.assertTrue(set_parked(db, policy, iid, rev, True, self.now))
            self.assertFalse(set_parked(db, policy, iid, rev, True, self.now))
            self.assertEqual(capacity_status(db, policy), {'limit': 1, 'reserved': 0, 'parked': 1, 'available': 1})
        self.assertEqual(alice.call('GET', '/v1/auth/runtime-readiness')['body']['state'], 'parked')
        self.assertEqual(alice.call('GET', '/v1/auth/session?include=home')['body']['home'],
                         {'runtime_state': 'parked', 'personal_agent': None})
        for path in ('/v1/auth/runtime-start', f'/v1/instances/{iid}/start', f'/v1/instances/{iid}/restart'):
            result = alice.call('POST', path, {})
            self.assertEqual(result['status'], 409, result)
            self.assertEqual(result['body']['error']['code'], 'runtime_parked')
        self.assertEqual(self.ensure(alice)['runtime_provisioning'],
                         {'state': 'existing', 'instance_id': iid, 'readiness': 'parked', 'error_code': 'runtime_parked'})
        self.assertEqual(alice.call('GET', f'/v1/instances/{iid}')['body']['instance'], stopped)
        self.assertEqual({item['id'] for item in self.listed()}, {iid})

        with self.store.transaction() as db:
            self.assertTrue(set_parked(db, policy, iid, rev, False, self.now))
            self.assertFalse(set_parked(db, policy, iid, rev, False, self.now))
            self.assertTrue(set_parked(db, policy, iid, rev, True, self.now))
        bob = self.user('bob', '127.0.0.2')
        self.assertEqual(bob.call('GET', '/v1/auth/runtime-readiness')['body']['state'], 'setup')
        other = self.ensure(bob)['runtime_provisioning']
        self.assertEqual(other['state'], 'provisioned')
        self.assertNotEqual(other['instance_id'], iid)
        self.assertEqual(bob.call('GET', f'/v1/instances/{iid}')['status'], 404)
        with self.assertRaises(RuntimeFault) as full, self.store.transaction() as db:
            set_parked(db, policy, iid, rev, False, self.now)
        self.assertEqual((full.exception.status, full.exception.code), (429, 'runtime_capacity'))
        self.assertEqual(alice.call('GET', f'/v1/instances/{iid}')['body']['instance'], stopped)

    def test_operator_enrolled_owner_runtime_is_respected_not_duplicated(self):
        self.make_app(enabled=False)
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        wid = personal['workspace']['id']
        inst = alice.call('POST', f'/v1/workspaces/{wid}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': 'manual-instance-0001'})
        self.assertEqual(inst['status'], 201, inst)
        iid = inst['body']['instance']['id']
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        state = self.ensure(alice)['runtime_provisioning']
        self.assertEqual((state['state'], state['instance_id']), ('bound', iid))
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        self.assertEqual(self.count('SELECT COUNT(*) FROM runtime_auto_provisions'), 0)
        self.assertEqual(self.count('SELECT COUNT(*) FROM workspace_agent_bindings'), 0)
        # Operator-enrolled instance is NOT visible to the auto manager.
        self.assertEqual(self.listed(), [])


    def test_workspace_create_reuses_personal_runtime(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        iid = personal['runtime_provisioning']['instance_id']
        wid = seed_legacy_workspace(alice, name='another workspace')['id']
        result = alice.call('POST', f'/v1/workspaces/{wid}/instances', {},
                            {'HTTP_IDEMPOTENCY_KEY': 'another-instance-key'})
        self.assertEqual(result['status'], 200, result)
        self.assertEqual(result['body']['instance']['id'], iid)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)

    def test_failed_create_shows_unavailable(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        iid = personal['runtime_provisioning']['instance_id']
        claim = self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': iid})['body']['claim']
        failed = self.manager('POST', f'/v1/internal/instances/{iid}/observe', {
            'job_id': claim['job']['id'], 'observed_revision': claim['job']['revision'], 'lease': claim['lease'],
            'observed': 'failed', 'error_code': 'runtime_failure'})
        self.assertEqual(failed['status'], 200, failed)
        state = self.ensure(alice)['runtime_provisioning']
        self.assertEqual(state['error_code'], 'runtime_unavailable')
        # No automatic start after a failed create.
        self.assertEqual(self.count("SELECT COUNT(*) FROM runtime_jobs WHERE instance_id=? AND operation_type='start'", iid), 0)

    def test_manager_scoping(self):
        self.make_app()
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        a = self.ensure(alice)['runtime_provisioning']['instance_id']
        # An operator-enrolled instance in Bob's own workspace, not granted to anyone.
        bob_ws = seed_legacy_workspace(bob, name='bobspace')['id']
        manual = bob.call('POST', f'/v1/workspaces/{bob_ws}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': 'bob-manual-inst-0001'})
        self.assertEqual(manual['status'], 201, manual)
        m = manual['body']['instance']['id']
        self.assertEqual({i['id'] for i in self.listed()}, {a})
        for path in (f'/v1/internal/instances/{m}/heartbeat',):
            self.assertEqual(self.manager('POST', path, {'job_id': '0' * 32, 'observed_revision': 1, 'lease': 'x' * 43})['status'], 404)
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': m})['status'], 404)
        # Another auto_provisioned manager sees none of auto-mgr's assignments.
        self.assertEqual(self.listed(token=self.other_token, name='other-mgr'), [])
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': a},
                                      token=self.other_token, name='other-mgr')['status'], 404)

    def test_manager_without_auto_flag_sees_only_explicit_grants(self):
        self.make_app(auto_manager=False, enabled=False)
        self.app.manager_auth.identities['auto-mgr'] = ManagerIdentity('auto-mgr', digest(self.token), frozenset(), 'simulation', False)
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        alice = self.user('alice', '127.0.0.1')
        a = self.ensure(alice)['runtime_provisioning']['instance_id']
        self.assertEqual(self.listed(), [])
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': a})['status'], 404)

    def test_startup_validation_fails_closed(self):
        store = Store(Path(tempfile.mkdtemp()) / 'state')
        runtime = Lifecycle(store)
        token = opaque()
        policy = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=None, auto_provision=policy)
        plain = ManagerAuth([ManagerIdentity('auto-mgr', digest(token), frozenset(), 'simulation', False)])
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=plain, auto_provision=policy)
        compose = ManagerAuth([ManagerIdentity('auto-mgr', digest(token), frozenset(), 'compose', True)])
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=compose, auto_provision=policy)
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=None, manager_auth=compose, auto_provision=policy)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=0)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id=None, max_instances=3)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=3, max_per_user=2)

    def test_operator_files(self):
        directory = Path(tempfile.mkdtemp())
        os.chmod(directory, 0o700)
        token = opaque()
        grants = directory / 'grants.json'
        grants.write_text(json.dumps([{'id': 'auto-mgr', 'credential_hash': digest(token), 'instance_ids': [],
                                       'backend_mode': 'compose', 'auto_provisioned': True}]))
        os.chmod(grants, 0o600)
        auth = load_manager_auth(grants)
        self.assertTrue(auth.identities['auto-mgr'].auto_provisioned)
        grants.write_text(json.dumps([{'id': 'auto-mgr', 'credential_hash': digest(token), 'instance_ids': [],
                                       'backend_mode': 'compose', 'auto_provisioned': 'yes'}]))
        with self.assertRaises(ValueError):
            load_manager_auth(grants)
        legacy = [{'id': 'm', 'credential_hash': digest(token), 'instance_ids': ['a' * 32], 'backend_mode': 'compose'}]
        grants.write_text(json.dumps(legacy))
        self.assertFalse(load_manager_auth(grants).identities['m'].auto_provisioned)
        auto = directory / 'auto.json'
        auto.write_text(json.dumps({'enabled': True, 'manager_id': 'auto-mgr', 'max_instances': 20}))
        os.chmod(auto, 0o600)
        policy = load_auto_provision(auto)
        self.assertEqual((policy.enabled, policy.manager_id, policy.max_instances, policy.max_per_user), (True, 'auto-mgr', 20, 1))
        auto.write_text(json.dumps({'enabled': True, 'manager_id': 'auto-mgr', 'max_instances': 20, 'extra': 1}))
        with self.assertRaises(ValueError):
            load_auto_provision(auto)
        os.chmod(auto, 0o644)
        with self.assertRaises(ValueError):
            load_auto_provision(auto)


if __name__ == '__main__':
    unittest.main()

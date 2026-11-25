"""Browser-facing provisioning maintains one owner-scoped Compose runtime."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from flybot_workspace.app import App, Config
from flybot_workspace.dsbot_gateway import ensure_schema, record_upstream
from flybot_workspace.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimePolicy
from flybot_workspace.runtime_autoprovision import AutoProvisionPolicy
from flybot_workspace.security import digest, opaque
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class RuntimePerUserTests(unittest.TestCase):
    def test_distinct_workspaces_and_keys_reuse_the_owners_compose_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'state')
            policy = RuntimePolicy(backend_mode='compose', image_ref='example/runtime@sha256:' + 'a' * 64)
            runtime = Lifecycle(store, policy)
            app = App(store, Config(ORIGIN, allow_registration=True), lifecycle=runtime)
            alice, bob = Client(app), Client(app, peer='127.0.0.2')
            alice_id, bob_id = ('a' * 32, 'b' * 32)
            home, team, bob_home = ('1' * 32, '2' * 32, '3' * 32)
            with store.transaction() as db:
                for client, uid, name in [(alice, alice_id, 'alice'), (bob, bob_id, 'bob')]:
                    db.execute('INSERT INTO users VALUES (?,?,?,?)', (uid, name, 'unused', 1))
                    token, csrf = opaque(), opaque()
                    db.execute('INSERT INTO sessions VALUES (?,?,?,?,?)',
                               (digest(token), digest(csrf), uid, 2100000000, 1))
                    client.cookies.update(zip(app.config.cookie_names, (token, csrf)))
                for wid, owner in [(home, alice_id), (team, alice_id), (bob_home, bob_id)]:
                    db.execute('INSERT INTO workspaces VALUES (?,?,?,?,?,?)',
                               (wid, owner, 'Workspace ' + wid[0], 1, digest(wid), digest(wid)))
                db.execute('INSERT INTO workspace_members VALUES (?,?,?,?,?)',
                           (home, bob_id, 'admin', 1, alice_id))
                db.execute('INSERT INTO workspace_members VALUES (?,?,?,?,?)',
                           (team, bob_id, 'admin', 1, alice_id))

            with ThreadPoolExecutor(max_workers=2) as pool:
                first, second = list(pool.map(lambda pair: runtime.create(alice_id, *pair), [
                    (home, 'create-runtime-home'), (team, 'create-runtime-team'),
                ]))
            self.assertEqual(sum(created for created, _ in [first, second]), 1)
            iid = first[1]['instance']['id']
            self.assertEqual(second[1]['instance']['id'], iid)
            reused = alice.call('POST', f'/v1/workspaces/{team}/instances', {},
                                {'HTTP_IDEMPOTENCY_KEY': 'third-runtime-request'})
            self.assertEqual(reused['status'], 200)
            self.assertEqual(reused['body']['instance']['id'], iid)
            self.assertEqual(alice.call('GET', f'/v1/instances/{iid}')['status'], 200)
            bobs = bob.call('POST', f'/v1/workspaces/{bob_home}/instances', {},
                            {'HTTP_IDEMPOTENCY_KEY': 'create-runtime-home'})
            self.assertEqual(bobs['status'], 201)
            self.assertNotEqual(bobs['body']['instance']['id'], iid)
            self.assertNotEqual(bobs['body']['instance']['volume_ref'], first[1]['instance']['volume_ref'])
            self.assertEqual(bob.call('GET', f'/v1/instances/{iid}')['status'], 404)
            shared = bob.call('GET', f'/v1/workspaces/{home}/instances')
            self.assertEqual([row['id'] for row in shared['body']['items']],
                             [bobs['body']['instance']['id']])
            for wid in (home, team):
                rows = alice.call('GET', f'/v1/workspaces/{wid}/instances')
                self.assertEqual(rows['status'], 200)
                self.assertEqual([row['id'] for row in rows['body']['items']], [iid])

    def test_resume_is_explicit_idempotent_and_only_targets_the_callers_stopped_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'state')
            policy = RuntimePolicy(backend_mode='compose', image_ref='example/runtime@sha256:' + 'a' * 64)
            runtime = Lifecycle(store, policy)
            manager = ManagerIdentity('owner-manager', digest(opaque()), frozenset(), 'compose', True)
            app = App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=ManagerAuth([manager]),
                      auto_provision=AutoProvisionPolicy(True, manager.id, 5))
            alice, bob = Client(app), Client(app, peer='127.0.0.2')
            own_ids = []
            with store.transaction() as db:
                ensure_schema(db)
                for client, name, owner in [(alice, 'alice', 'a' * 32), (bob, 'bob', 'b' * 32)]:
                    db.execute('INSERT INTO users VALUES (?,?,?,?)', (owner, name, 'unused', 1))
                    token, csrf = opaque(), opaque()
                    db.execute('INSERT INTO sessions VALUES (?,?,?,?,?)',
                               (digest(token), digest(csrf), owner, 2100000000, 1))
                    client.cookies.update(zip(app.config.cookie_names, (token, csrf)))
                    binding = app.queue_new_account_runtime(db, owner, name, 1)
                    iid = db.execute('SELECT instance_id FROM runtime_auto_provisions WHERE user_id=?',
                                     (owner,)).fetchone()[0]
                    own_ids.append((owner, iid, binding['workspace_id']))

            def observe(owner, iid, state):
                claim = runtime.claim(manager, iid)
                job = claim['job']
                runtime.observe(manager, iid, job['id'], job['revision'], claim['lease'], state,
                                process_ref=owner if state == 'running' else None)

            for owner, iid, _ in own_ids:
                observe(owner, iid, 'running')
                runtime.stop(owner, iid)
                observe(owner, iid, 'stopped')

            start, status = '/v1/auth/runtime-start', '/v1/auth/runtime-readiness'
            self.assertEqual(Client(app).call('POST', start, {})['status'], 401)
            self.assertEqual(alice.call('POST', start, {}, csrf=False)['status'], 403)
            self.assertEqual(alice.call('POST', start, {'instance_id': own_ids[1][1]})['status'], 400)
            self.assertEqual(alice.call('GET', status)['body']['state'], 'stopped')
            self.assertEqual(bob.call('GET', status)['body']['state'], 'stopped')
            self.assertNotIn('personal_chat', alice.call('GET', status)['body'])
            with store.connect() as db:
                for client, (owner, _iid, workspace) in zip((alice, bob), own_ids):
                    agent = db.execute('SELECT agent_id FROM personal_agents WHERE user_id=?', (owner,)).fetchone()[0]
                    self.assertEqual(client.call('GET', status + '?include=personal-chat')['body'], {
                        'state': 'stopped', 'user_id': owner,
                        'personal_chat': {'workspace_id': workspace, 'agent_id': agent},
                    })
            self.assertEqual(Client(app).call('GET', status + '?include=personal-chat')['status'], 401)
            first_saw_stopped = Event()
            release_first = Event()
            runtime_readiness = app.runtime_readiness

            def hold_first_start(db, owner):
                state = runtime_readiness(db, owner)
                if state == 'stopped' and not first_saw_stopped.is_set():
                    first_saw_stopped.set()
                    self.assertTrue(release_first.wait(5))
                return state

            with patch.object(app, 'runtime_readiness', side_effect=hold_first_start), ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(alice.call, 'POST', start, {})
                try:
                    self.assertTrue(first_saw_stopped.wait(5))
                    second = alice.call('POST', start, {})
                finally:
                    release_first.set()
                responses = [first.result(timeout=5), second]
            self.assertEqual(sorted(response['status'] for response in responses), [200, 202])
            self.assertTrue(all(response['body'] == {'state': 'starting'} for response in responses))
            self.assertEqual(bob.call('GET', status)['body']['state'], 'stopped')

            owner, iid, wid = own_ids[0]
            observe(owner, iid, 'running')
            with store.transaction() as db:
                record_upstream(db, iid, '172.30.0.11:8080', 'dsh-auth-test=' + 'S' * 24, 1800000000)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM instances WHERE owner_id=?', (owner,)).fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_jobs WHERE instance_id=?', (iid,)).fetchone()[0], 3)
                db.execute('UPDATE instances SET blocked=1 WHERE id=?', (own_ids[1][1],))
            self.assertEqual(alice.call('GET', status)['body']['state'], 'ready')
            self.assertEqual(alice.call('GET', f'/v1/workspaces/{wid}/instances')['body']['items'][0]['id'], iid)
            self.assertEqual(bob.call('GET', status)['body']['state'], 'unavailable')
            self.assertEqual(bob.call('POST', start, {})['status'], 409)

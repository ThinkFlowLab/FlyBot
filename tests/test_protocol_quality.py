"""Extra real SQLite/protocol regressions, synthetic state only; no service/Docker."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import unittest
import os
from pathlib import Path
import subprocess
import sys

from flybot_workspace.lifecycle import Lifecycle, ManagerIdentity, RuntimeFault
from flybot_workspace.security import digest, opaque
import test_runtime as fixtures
from test_management import Client


class ProtocolQualityTests(unittest.TestCase):
    # Reuse setup/helpers, not inherited test methods or another class's tests.
    setUp = fixtures.RuntimeTests.setUp
    create = fixtures.RuntimeTests.create
    manager = fixtures.RuntimeTests.manager
    tick = fixtures.RuntimeTests.tick
    ready = fixtures.RuntimeTests.ready
    action = fixtures.RuntimeTests.action
    manager_call = fixtures.RuntimeTests.manager_call

    def test_workspace_listing_alone_latches_expired_manager_lease(self):
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        claim = self.runtime.claim(identity, iid)
        before = self.client.call('GET', f'/v1/workspaces/{self.wid}/instances')['body']['items'][0]
        self.assertFalse(before['blocked']); self.assertIsNone(before['error'])
        self.now += self.runtime.policy.lease_seconds + 1
        # No inspect/job/logs/manager-list call may accidentally expire it first.
        response = self.client.call('GET', f'/v1/workspaces/{self.wid}/instances')
        self.assertEqual(response['status'], 200)
        listed = response['body']['items'][0]
        self.assertTrue(listed['blocked'])
        self.assertEqual(listed['observed'], 'unknown')
        self.assertEqual(listed['error']['code'], 'interrupted')
        self.assertFalse(listed['converged'])
        with self.store.connect() as db:
            job = db.execute('SELECT status,lease_hash FROM runtime_jobs WHERE id=?', (claim['job']['id'],)).fetchone()
            blocked = db.execute('SELECT blocked FROM instances WHERE id=?', (iid,)).fetchone()[0]
        self.assertEqual(job['status'], 'interrupted'); self.assertIsNone(job['lease_hash'])
        self.assertEqual(blocked, 1)
        again = self.client.call('GET', f'/v1/workspaces/{self.wid}/instances')['body']['items'][0]
        self.assertEqual(again, listed)

    def test_http_control_log_read_still_latches_expiry_without_exposing_lease(self):
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        claim = self.runtime.claim(identity, iid)
        self.now += self.runtime.policy.lease_seconds + 1
        response = self.client.call('GET', f'/v1/instances/{iid}/logs')
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['items'][0]['status'], 'interrupted')
        self.assertNotIn(claim['lease'], json.dumps(response))
        self.assertFalse(response['body']['runtime_logs_supported'])

    def test_parallel_additive_runtime_initialization_preserves_auth_sessions_and_workspaces(self):
        with self.store.connect() as db:
            before = {table: [tuple(r) for r in db.execute('SELECT * FROM ' + table)]
                      for table in ('users', 'sessions', 'workspaces')}
        with ThreadPoolExecutor(max_workers=4) as pool:
            runtimes = list(pool.map(lambda _: Lifecycle(self.store, clock=lambda: self.now), range(8)))
        self.assertEqual(len(runtimes), 8)
        with self.store.connect() as db:
            after = {table: [tuple(r) for r in db.execute('SELECT * FROM ' + table)] for table in before}
            self.assertEqual([r[0] for r in db.execute('SELECT version FROM runtime_schema')], [1])
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertEqual(before, after)
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(self.client.call('GET', f'/v1/workspaces/{self.wid}')['body']['workspace']['id'], self.wid)

    def test_separate_python_processes_share_one_durable_idempotent_instance(self):
        script = """
import json, sys
from flybot_workspace.store import Store
from flybot_workspace.lifecycle import Lifecycle
runtime = Lifecycle(Store(sys.argv[1]), clock=lambda: 1800000000)
created, value = runtime.create(sys.argv[2], sys.argv[3], 'separate-process-create-0001')
print(json.dumps({'created': created, 'id': value['instance']['id'], 'job': value['job']['id']}))
"""
        root = Path(__file__).resolve().parent.parent
        def run_child(_):
            completed = subprocess.run([sys.executable, '-c', script, str(self.store.path.parent), self.owner, self.wid],
                                       cwd=root, env={'PATH': os.defpath, 'PYTHONPATH': str(root)},
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
            return json.loads(completed.stdout)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run_child, range(4)))
        self.assertEqual(sum(r['created'] for r in results), 1)
        self.assertEqual(len({r['id'] for r in results}), 1)
        self.assertEqual(len({r['job'] for r in results}), 1)
        repeated = self.runtime.create(self.owner, self.wid, 'separate-process-create-0001')
        self.assertFalse(repeated[0])
        self.assertEqual(repeated[1]['instance']['id'], results[0]['id'])
        self.assertEqual(repeated[1]['job']['id'], results[0]['job'])

    def test_cross_scope_manager_cannot_claim_renew_or_observe_another_instances_job(self):
        one = self.create()['instance']['id']
        two = self.create('quality-instance-two-0001')['instance']['id']
        manager_a = self.manager(one)
        manager_b = ManagerIdentity('manager-b', digest(opaque()), frozenset((two,)))
        claim = self.runtime.claim(manager_a, one)
        for action in (lambda: self.runtime.claim(manager_b, one),
                       lambda: self.runtime.heartbeat(manager_b, one, claim['job']['id'], 1, claim['lease']),
                       lambda: self.runtime.observe(manager_b, one, claim['job']['id'], 1, claim['lease'], 'stopped')):
            with self.assertRaises(RuntimeFault) as error:
                action()
            self.assertEqual(error.exception.status, 404)
        self.assertEqual([r['id'] for r in self.runtime.manager_list(manager_b)['items']], [two])
        wrong_mode = replace(manager_a, backend_mode='compose-planning')
        with self.assertRaises(RuntimeFault):
            self.runtime.claim(wrong_mode, one)
        self.assertEqual(self.runtime.get_job(self.owner, claim['job']['id'])['status'], 'running')

    def test_old_completed_job_cannot_overwrite_or_renew_a_newer_leased_revision(self):
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        old = self.runtime.claim(identity, iid)
        result = self.fake.execute(old)
        self.runtime.observe(identity, iid, old['job']['id'], 1, old['lease'], **result)
        self.runtime.start(self.owner, iid)
        current = self.runtime.claim(identity, iid)
        with self.assertRaises(RuntimeFault):
            self.runtime.observe(identity, iid, old['job']['id'], 1, old['lease'], 'stopped')
        with self.assertRaises(RuntimeFault):
            self.runtime.heartbeat(identity, iid, old['job']['id'], 1, old['lease'])
        snapshot = self.runtime.inspect(self.owner, iid)
        self.assertEqual(snapshot['revision'], 2)
        self.assertEqual(snapshot['observed_revision'], 1)
        self.assertFalse(snapshot['converged'])
        self.assertEqual(self.runtime.get_job(self.owner, current['job']['id'])['status'], 'running')
        result = self.fake.execute(current)
        accepted = self.runtime.observe(identity, iid, current['job']['id'], 2, current['lease'], **result)
        self.assertTrue(accepted['instance']['converged'])

    def test_competing_start_stop_transactions_keep_one_current_job_and_revision_chain(self):
        iid = self.ready()
        def change(index):
            return self.runtime.start(self.owner, iid) if index % 2 == 0 else self.runtime.stop(self.owner, iid)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(change, range(16)))
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
            jobs = db.execute('SELECT * FROM runtime_jobs WHERE instance_id=? ORDER BY revision', (iid,)).fetchall()
            pending = [j for j in jobs if j['status'] == 'queued']
        self.assertEqual(len(jobs), row['revision'])
        self.assertEqual([j['revision'] for j in jobs], list(range(1, row['revision'] + 1)))
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]['operation_id'], row['operation_id'])
        self.assertEqual(pending[0]['revision'], row['revision'])
        self.assertTrue(all(j['status'] in ('succeeded', 'superseded') for j in jobs[:-1]))
        self.assertEqual(sum(changed for changed, _ in results), row['revision'] - 1)
        self.assertTrue(self.tick(iid)['instance']['converged'])

    def test_private_fake_content_cannot_enter_public_snapshot_jobs_or_control_events(self):
        iid = self.ready()
        marker = 'SYNTHETIC-PRIVATE-CONTENT-NOT-A-REAL-CREDENTIAL'
        self.fake.write_marker(iid, marker)
        start = self.action(iid, 'start')['body']; self.tick(iid)
        self.action(iid, 'restart', {'operation_id': 'quality-restart-0001'}); self.tick(iid)
        paths = (f'/v1/instances/{iid}', f'/v1/jobs/{start["job"]["id"]}',
                 f'/v1/workspaces/{self.wid}/instances', f'/v1/instances/{iid}/logs?tail=1')
        for path in paths:
            response = self.client.call('GET', path)
            self.assertEqual(response['status'], 200)
            serialized = json.dumps(response)
            for secret in (marker, self.token, 'lease_hash', 'credential_hash', 'manager_id'):
                self.assertNotIn(secret, serialized)
        logs = self.client.call('GET', f'/v1/instances/{iid}/logs?tail=1')['body']
        self.assertTrue(logs['truncated'])
        self.assertFalse(logs['runtime_logs_supported'])
        self.assertEqual(set(logs['items'][0]), {'revision', 'operation_type', 'status', 'error_code', 'created'})

    def test_manager_credentials_do_not_grant_a_user_session_or_other_owner_jobs(self):
        created = self.create(); iid = created['instance']['id']; self.manager(iid)
        manager = Client(self.app)
        headers = {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + self.token}
        self.assertEqual(manager.call('GET', f'/v1/instances/{iid}', headers=headers, origin=None)['status'], 401)
        self.assertEqual(manager.call('GET', f'/v1/jobs/{created["job"]["id"]}', headers=headers, origin=None)['status'], 401)
        other = Client(self.app); other.register('quality-other-owner')
        self.assertEqual(other.call('GET', f'/v1/jobs/{created["job"]["id"]}', headers=headers)['status'], 404)
        self.assertEqual(other.call('POST', f'/v1/instances/{iid}/restart', {'operation_id': 'quality-forbidden-0001'}, headers=headers)['status'], 404)
        self.assertEqual(self.runtime.inspect(self.owner, iid)['revision'], 1)

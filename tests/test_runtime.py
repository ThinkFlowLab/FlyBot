"""Synthetic in-process lifecycle/manager acceptance. NO actual runtime/container."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from flybot_workspace.app import App, Config
from flybot_workspace.compose_planning import NodeComposePlanner, PlanningFailure
from flybot_workspace.fake_runtime import FakeManagerWorker, FakeRuntimeBackend, RuntimeFailure
from flybot_workspace.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimeFault, RuntimePolicy
from flybot_workspace.security import digest, opaque
from flybot_workspace.store import Store
from flybot_workspace.operator_config import load_manager_auth
import os
from test_management import Client, ORIGIN, seed_legacy_workspace


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, clock=lambda: self.now)
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: self.now, lifecycle=self.runtime)
        self.client = Client(self.app); self.client.register()
        self.owner = self.client.call('GET', '/v1/auth/session')['body']['user']['id']
        self.wid = seed_legacy_workspace(self.client)['id']
        self.fake = FakeRuntimeBackend(self.store)
        self.token = opaque()

    def create(self, key='instance-create-0001'):
        result = self.client.call('POST', f'/v1/workspaces/{self.wid}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertIn(result['status'], (200, 201), result)
        return result['body']

    def manager(self, *iids, name='manager-a', mode='simulation'):
        identity = ManagerIdentity(name, digest(self.token), frozenset(iids), mode)
        self.app.manager_auth = ManagerAuth([identity])
        return identity

    def tick(self, iid, identity=None):
        return FakeManagerWorker(self.runtime, identity or self.manager(iid), self.fake).run_once(iid)

    def ready(self):
        result = self.create(); iid = result['instance']['id']
        self.tick(iid)
        return iid

    def action(self, iid, action, body=None):
        return self.client.call('POST', f'/v1/instances/{iid}/{action}', body or {})

    def manager_call(self, method, path, body=None, peer='127.0.0.1', **headers):
        client = Client(self.app, peer)
        return client.call(method, path, body, {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + self.token, **headers}, origin=None, csrf=False)

    def observation(self, claim, observed='stopped', **extra):
        return {'job_id': claim['job']['id'], 'observed_revision': claim['job']['revision'],
                'lease': claim['lease'], 'observed': observed, **extra}

    def test_create_is_durable_and_atomic_idempotent_with_separate_instance_ids(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.runtime.create(self.owner, self.wid, 'concurrent-create-001'), range(8)))
        self.assertEqual(sum(created for created, _ in results), 1)
        self.assertEqual(len({r['instance']['id'] for _, r in results}), 1)
        first = results[0][1]; iid = first['instance']['id']
        resumed = Lifecycle(Store(self.store.path.parent), clock=lambda: self.now)
        self.assertEqual(resumed.create(self.owner, self.wid, 'concurrent-create-001')[1], first)
        second = self.create()['instance']
        self.assertNotEqual(second['id'], iid)
        self.assertNotEqual(second['volume_ref'], first['instance']['volume_ref'])
        self.assertEqual(first['instance']['revision'], 1)
        self.assertFalse(first['instance']['converged'])
        self.assertEqual(first['instance']['backend_mode'], 'simulation')

    def test_pending_start_stop_reuses_current_revision_job_and_operation(self):
        iid = self.ready()
        started = self.action(iid, 'start'); self.assertEqual(started['status'], 202)
        for _ in range(4):
            retry = self.action(iid, 'start')
            self.assertEqual(retry['status'], 200)
            self.assertEqual(retry['body'], started['body'])
        stopped = self.action(iid, 'stop'); self.assertEqual(stopped['status'], 202)
        self.assertEqual(stopped['body']['instance']['revision'], 3)
        self.assertEqual(self.action(iid, 'stop')['body'], stopped['body'])
        self.assertEqual(self.runtime.get_job(self.owner, started['body']['job']['id'])['status'], 'superseded')
        self.assertEqual(self.tick(iid)['job']['operation_type'], 'stop')

    def test_restart_keys_reuse_even_historically_and_new_key_recycles_process(self):
        iid = self.ready(); self.action(iid, 'start'); self.tick(iid)
        before = self.fake.inspect(iid)
        first = self.action(iid, 'restart', {'operation_id': 'restart-request-0001'})
        self.assertEqual(first['status'], 202)
        self.assertEqual(self.action(iid, 'restart', {'operation_id': 'restart-request-0001'})['body'], first['body'])
        self.assertEqual(self.action(iid, 'restart', {'operation_id': 'restart-request-0002'})['status'], 409)
        self.tick(iid)
        after = self.fake.inspect(iid)
        self.assertNotEqual(before['process_ref'], after['process_ref'])
        self.assertEqual(after['generation'], before['generation'] + 1)
        second = self.action(iid, 'restart', {'operation_id': 'restart-request-0002'})
        self.tick(iid)
        historical = self.action(iid, 'restart', {'operation_id': 'restart-request-0001'})
        self.assertEqual(historical['status'], 200)
        self.assertEqual(historical['body']['job']['id'], first['body']['job']['id'])
        self.assertEqual(historical['body']['instance']['revision'], second['body']['instance']['revision'])
        self.assertIsNone(self.tick(iid))

    def test_restart_stopped_instance_is_single_restart_job_not_two_intents(self):
        iid = self.ready()
        restarted = self.action(iid, 'restart')
        self.assertEqual(restarted['body']['instance']['revision'], 2)
        self.assertEqual(restarted['body']['job']['operation_type'], 'restart')
        self.tick(iid)
        self.assertEqual(self.fake.inspect(iid)['generation'], 1)

    def test_optimistic_revision_and_running_job_conflicts(self):
        iid = self.ready()
        self.assertEqual(self.action(iid, 'start', {'expected_revision': 2})['status'], 409)
        self.assertEqual(self.action(iid, 'start', {'expected_revision': True})['status'], 400)
        started = self.action(iid, 'start')['body']
        identity = self.manager(iid); claim = self.runtime.claim(identity, iid)
        self.assertEqual(self.action(iid, 'stop')['status'], 409)
        self.assertEqual(self.action(iid, 'restart')['status'], 409)
        self.assertEqual(self.action(iid, 'start')['body']['job']['id'], started['job']['id'])
        result = self.fake.execute(claim)
        self.runtime.observe(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], **result)

    def test_outdated_wrong_lease_wrong_manager_and_repeat_observations_cannot_succeed(self):
        iid = self.ready(); self.action(iid, 'start')
        identity = self.manager(iid); claim = self.runtime.claim(identity, iid)
        args = [identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], 'running', uuid4().hex]
        for index, value in [(2, uuid4().hex), (3, 1), (4, opaque()), (0, replace(identity, id='manager-b'))]:
            bad = args.copy(); bad[index] = value
            with self.assertRaises(RuntimeFault) as error:
                self.runtime.observe(*bad)
            self.assertEqual(error.exception.code, 'stale_observation')
        self.assertFalse(self.runtime.inspect(self.owner, iid)['converged'])
        accepted = self.runtime.observe(*args)
        self.assertTrue(accepted['instance']['converged'])
        with self.assertRaises(RuntimeFault):
            self.runtime.observe(*args)

    def test_restart_observation_requires_distinct_process_identity(self):
        iid = self.ready(); self.action(iid, 'start'); self.tick(iid)
        old = self.fake.inspect(iid)['process_ref']; self.action(iid, 'restart')
        identity = self.manager(iid); claim = self.runtime.claim(identity, iid)
        with self.assertRaises(RuntimeFault) as error:
            self.runtime.observe(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], 'running', old)
        self.assertEqual(error.exception.code, 'invalid_observation')
        result = self.fake.execute(claim)
        self.assertTrue(self.runtime.observe(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], **result)['instance']['converged'])

    def test_expired_lease_is_interrupted_and_blocks_automatic_reexecution_after_restart(self):
        iid = self.ready(); self.action(iid, 'start'); identity = self.manager(iid)
        claim = self.runtime.claim(identity, iid)
        self.now += 31
        resumed = Lifecycle(Store(self.store.path.parent), clock=lambda: self.now)
        state = resumed.inspect(self.owner, iid)
        self.assertTrue(state['blocked']); self.assertEqual(state['observed'], 'unknown')
        self.assertFalse(state['converged'])
        self.assertEqual(resumed.get_job(self.owner, claim['job']['id'])['status'], 'interrupted')
        self.assertIsNone(resumed.claim(identity, iid))
        with self.assertRaises(RuntimeFault):
            resumed.intent(self.owner, iid, 'restart')
        with self.assertRaises(RuntimeFault):
            resumed.observe(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], 'running', uuid4().hex)

    def test_heartbeat_renews_only_own_unexpired_lease(self):
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        claim = self.runtime.claim(identity, iid)
        self.now += 20
        result = self.runtime.heartbeat(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'])
        self.assertEqual(result['lease_until'], self.now + 30)
        self.now += 15
        self.assertIsNone(self.runtime.claim(identity, iid))
        self.assertFalse(self.runtime.inspect(self.owner, iid)['blocked'])

    def test_concurrent_manager_claims_only_one_execution(self):
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        with ThreadPoolExecutor(max_workers=5) as pool:
            claims = list(pool.map(lambda _: self.runtime.claim(identity, iid), range(10)))
        self.assertEqual(sum(c is not None for c in claims), 1)

    def test_fake_sqlite_volume_survives_stop_restart_and_control_plane_reopen(self):
        iid = self.ready(); self.action(iid, 'start'); self.tick(iid)
        self.fake.write_marker(iid, 'Synthetic volume payload')
        volume = self.fake.inspect(iid)['volume_ref']
        self.action(iid, 'stop'); self.tick(iid)
        self.assertIsNone(self.fake.inspect(iid)['process_ref'])
        self.fake = FakeRuntimeBackend(Store(self.store.path.parent))
        self.runtime = Lifecycle(Store(self.store.path.parent), clock=lambda: self.now)
        self.app.lifecycle = self.runtime
        self.action(iid, 'start'); self.tick(iid)
        state = self.fake.inspect(iid)
        self.assertEqual(state['marker'], 'Synthetic volume payload')
        self.assertEqual(state['volume_ref'], volume)

    def test_memory_fake_receipts_and_sqlite_receipts_prevent_duplicate_restarts(self):
        for fake in (FakeRuntimeBackend(), self.fake):
            iid = self.create('separate-create-' + uuid4().hex)['instance']['id']; identity = self.manager(iid)
            claim = self.runtime.claim(identity, iid); fake.execute(claim)
            result = fake.execute(claim)
            self.runtime.observe(identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], **result)
            self.action(iid, 'restart'); claim = self.runtime.claim(identity, iid)
            first = fake.execute(claim)
            if fake.store:
                fake = FakeRuntimeBackend(Store(self.store.path.parent))
            second = fake.execute(claim)
            self.assertEqual(first, second); self.assertEqual(fake.inspect(iid)['generation'], 1)

    def test_failure_reports_fixed_code_not_exception_text_or_false_running(self):
        iid = self.ready(); self.action(iid, 'start')
        self.fake.fail_next = True
        result = self.tick(iid)
        self.assertEqual(result['job']['status'], 'failed')
        self.assertEqual(result['instance']['observed'], 'failed')
        self.assertFalse(result['instance']['converged'])
        self.assertEqual(self.action(iid, 'start')['body']['job']['id'], result['job']['id'])
        self.action(iid, 'restart')
        with patch.object(self.fake, 'execute', side_effect=ValueError('PRIVATE-SECRET-TEST /private/path')):
            result = self.tick(iid)
        self.assertNotIn('PRIVATE-SECRET-TEST', json.dumps(result))
        self.assertNotIn('/private/path', json.dumps(result))

    def test_owner_isolation_including_jobs_logs_and_unsupported_actions(self):
        result = self.create(); iid, jid = result['instance']['id'], result['job']['id']
        other = Client(self.app); other.register('other')
        paths = [('GET', f'/v1/instances/{iid}'), ('GET', f'/v1/jobs/{jid}'), ('GET', f'/v1/instances/{iid}/logs'),
                 ('POST', f'/v1/instances/{iid}/start'), ('POST', f'/v1/instances/{iid}/purge'), ('GET', f'/v1/workspaces/{self.wid}/instances')]
        for method, path in paths:
            self.assertEqual(other.call(method, path)['status'], 404)
        own = seed_legacy_workspace(other)['id']
        self.assertEqual(other.call('GET', f'/v1/workspaces/{own}/instances')['body']['items'], [])
        self.assertEqual(self.action(iid, 'purge')['status'], 501)

    def test_instance_endpoints_reject_selector_overrides_and_require_csrf(self):
        path = f'/v1/workspaces/{self.wid}/instances'
        for key in ('owner_id', 'workspace_id', 'image', 'command', 'mount', 'token', 'profile', 'backend_mode'):
            self.assertEqual(self.client.call('POST', path, {key: 'untrusted'}, {'HTTP_IDEMPOTENCY_KEY': 'instance-create-0001'})['status'], 400)
        self.assertEqual(self.client.call('POST', path, {}, {'HTTP_IDEMPOTENCY_KEY': 'instance-create-0001'}, csrf=False)['status'], 403)
        iid = self.create()['instance']['id']
        self.assertEqual(self.client.call('POST', f'/v1/instances/{iid}/start', {}, csrf=False)['status'], 403)
        self.assertEqual(self.action(iid, 'restart', {'operation_id': 'short'})['status'], 400)

    def test_manager_auth_is_scoped_loopback_separate_from_user_and_origin(self):
        first = self.create(); iid = first['instance']['id']
        other = self.create('instance-create-0002')['instance']['id']; self.manager(iid)
        path = '/v1/internal/instances'
        self.assertEqual(self.client.call('GET', path)['status'], 401)
        self.assertEqual(self.manager_call('GET', path, peer='192.0.2.1')['status'], 401)
        for headers in ({'HTTP_COOKIE': 'anything=x'}, {'HTTP_ORIGIN': ORIGIN}, {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + opaque()}):
            self.assertEqual(self.manager_call('GET', path, **headers)['status'], 401)
        items = self.manager_call('GET', path)['body']['items']
        self.assertEqual([i['id'] for i in items], [iid])
        self.assertEqual(self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': other})['status'], 404)
        self.assertEqual(self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': iid, 'image': 'bad'})['status'], 400)

    def test_http_manager_claim_observe_job_poll_and_sanitized_event_log(self):
        created = self.create(); iid = created['instance']['id']; self.manager(iid)
        claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': iid})['body']['claim']
        result = self.manager_call('POST', f'/v1/internal/instances/{iid}/observe', self.observation(claim))
        self.assertEqual(result['status'], 200, result)
        job = self.client.call('GET', f"/v1/jobs/{created['job']['id']}")['body']['job']
        self.assertEqual(job['status'], 'succeeded')
        response = self.client.call('GET', f'/v1/instances/{iid}/logs?tail=1')
        self.assertFalse(response['body']['runtime_logs_supported'])
        for secret in (claim['lease'], self.token, 'lease_hash', 'manager_id', 'credential_hash'):
            self.assertNotIn(secret, json.dumps(response) + json.dumps(job) + json.dumps(result))
        with self.store.connect() as db:
            dump = '\n'.join(db.iterdump())
        self.assertNotIn(self.token, dump); self.assertNotIn(claim['lease'], dump)
        self.assertEqual(self.manager_call('POST', f'/v1/internal/instances/{iid}/observe', self.observation(claim))['status'], 409)

    def test_bad_manager_observation_is_invalid_not_internal_error(self):
        iid = self.create()['instance']['id']; self.manager(iid)
        claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': iid})['body']['claim']
        path = f'/v1/internal/instances/{iid}/observe'
        for changes in ({'observed': 'secret token'}, {'process_ref': 'not-an-id'}, {'error_code': 'arbitrary-secret'}, {'observed_revision': True}, {'lease': '非ASCII'}, {'job_id': None}):
            body = {**self.observation(claim), **changes}
            self.assertIn(self.manager_call('POST', path, body)['status'], (400, 409))
        self.assertEqual(self.manager_call('POST', path, {})['status'], 400)

    def test_instance_and_job_quotas_preserve_existing_replays(self):
        self.runtime.policy = replace(self.runtime.policy, max_instances_per_workspace=1, max_jobs=1)
        first = self.create(); iid = first['instance']['id']
        self.assertEqual(self.create(), first)
        response = self.client.call('POST', f'/v1/workspaces/{self.wid}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': 'instance-create-0002'})
        self.assertEqual(response['status'], 429)
        self.tick(iid)
        self.assertEqual(self.action(iid, 'start')['status'], 429)
        self.assertEqual(self.runtime.inspect(self.owner, iid)['revision'], 1)

    def test_runtime_schema_is_additive_and_unknown_version_fails_closed(self):
        self.assertEqual(Store(self.store.path.parent).path, self.store.path)
        with self.store.connect() as db:
            db.execute('DELETE FROM runtime_schema')
        with self.assertRaises(ValueError):
            Lifecycle(self.store)

    def test_runtime_list_and_logs_queries_are_bounded(self):
        a = self.create()['instance']['id']; b = self.create('instance-create-0002')['instance']['id']
        path = f'/v1/workspaces/{self.wid}/instances'
        first = self.client.call('GET', path + '?limit=1')['body']
        second = self.client.call('GET', path + '?limit=1&cursor=' + first['cursor'])['body']
        self.assertEqual({i['id'] for i in first['items'] + second['items']}, {a, b})
        for query in ('limit=0', 'limit=101', 'cursor=bad', 'limit=1&limit=2'):
            self.assertEqual(self.client.call('GET', path + '?' + query)['status'], 400)
        for query in ('tail=0', 'tail=101', 'tail=1&tail=2', 'token=x'):
            self.assertEqual(self.client.call('GET', f'/v1/instances/{a}/logs?' + query)['status'], 400)

    def test_simulation_manager_cannot_attest_compose_mode(self):
        self.runtime.policy = replace(self.runtime.policy, backend_mode='compose-planning')
        iid = self.create()['instance']['id']; identity = self.manager(iid)
        with self.assertRaises(RuntimeFault):
            self.runtime.claim(identity, iid)


    def test_concurrent_same_start_or_restart_reuses_one_durable_job(self):
        iid = self.ready()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.runtime.start(self.owner, iid), range(8)))
        self.assertEqual(sum(changed for changed, _ in results), 1)
        self.assertEqual(len({r['job']['id'] for _, r in results}), 1)
        self.tick(iid)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.runtime.restart(self.owner, iid, 'same-restart-key-0001'), range(8)))
        self.assertEqual(sum(changed for changed, _ in results), 1)
        self.assertEqual(len({r['job']['id'] for _, r in results}), 1)

    def test_conflict_exposes_current_intent_without_secret_fields(self):
        iid = self.ready()
        started = self.action(iid, 'start')['body']['instance']
        response = self.action(iid, 'restart')
        self.assertEqual(response['status'], 409)
        self.assertEqual(response['body']['error']['current'], {'revision': started['revision'], 'operation': started['operation']})

    def test_compose_planning_profile_cannot_claim_or_report_real_running(self):
        self.runtime.policy = replace(self.runtime.policy, backend_mode='compose-planning')
        iid = self.create()['instance']['id']; identity = self.manager(iid, mode='compose-planning')
        with self.assertRaises(RuntimeFault) as error:
            self.runtime.claim(identity, iid)
        self.assertEqual(error.exception.status, 501)
        self.assertFalse(self.runtime.inspect(self.owner, iid)['converged'])

    def test_operator_manager_grants_are_digest_only_private_and_cannot_self_grant(self):
        iid = self.ready()
        directory = Path(self.temp.name) / 'operator'; directory.mkdir(mode=0o700)
        path = directory / 'managers.json'
        data = [{'id': 'manager-a', 'credential_hash': digest(self.token), 'instance_ids': [iid], 'backend_mode': 'simulation'}]
        path.write_text(json.dumps(data)); path.chmod(0o600)
        auth = load_manager_auth(path)
        self.assertEqual(auth.identities['manager-a'].instance_ids, frozenset((iid,)))
        self.assertNotIn(self.token, path.read_text())
        self.assertNotIn(digest(self.token), repr(auth.identities['manager-a']))
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            load_manager_auth(path)
        path.chmod(0o600)
        link = directory / 'link.json'; link.symlink_to(path)
        with self.assertRaises(ValueError):
            load_manager_auth(link)
        data[0]['token'] = 'forbidden-plaintext'
        path.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            load_manager_auth(path)
        fifo = directory / 'fifo'; os.mkfifo(fifo, mode=0o600)
        with self.assertRaises(ValueError):
            load_manager_auth(fifo)

    def test_storage_failure_does_not_claim_runtime_success(self):
        iid = self.ready()
        with patch.object(self.store, 'transaction', side_effect=OSError('PRIVATE-FAILURE-PATH')):
            response = self.action(iid, 'start')
        self.assertEqual(response['status'], 503)
        self.assertNotIn('PRIVATE-FAILURE-PATH', json.dumps(response))
        self.assertEqual(self.runtime.inspect(self.owner, iid)['revision'], 1)


    def test_members_can_inspect_but_only_owner_or_admin_operate(self):
        result = self.create(); iid, jid = result['instance']['id'], result['job']['id']
        admin = Client(self.app, peer='127.0.0.2')
        admin_id = admin.register('bob')['body']['user']['id']
        member = Client(self.app, peer='127.0.0.3')
        member_id = member.register('carol')['body']['user']['id']
        outsider = Client(self.app, peer='127.0.0.4'); outsider.register('dave')
        # The lifecycle still checks the membership snapshot on historical rows.
        # Live membership changes are owned by Bot Social.
        with self.store.transaction() as db:
            db.executemany(
                'INSERT INTO workspace_members(workspace_id, user_id, role, created, added_by) VALUES(?,?,?,?,?)',
                [(self.wid, admin_id, 'admin', self.now, self.owner),
                 (self.wid, member_id, 'member', self.now, self.owner)],
            )
        listed = admin.call('GET', f'/v1/workspaces/{self.wid}/instances')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['id'] for row in listed['body']['items']], [iid])
        self.assertEqual(member.call('GET', f'/v1/instances/{iid}')['status'], 200)
        self.assertEqual(member.call('GET', f'/v1/jobs/{jid}')['status'], 200)
        self.assertEqual(member.call('GET', f'/v1/instances/{iid}/logs')['status'], 200)
        denied = member.call('POST', f'/v1/instances/{iid}/start', {})
        self.assertEqual(denied['status'], 403)
        self.assertEqual(member.call('POST', f'/v1/workspaces/{self.wid}/instances',
                                     {}, {'HTTP_IDEMPOTENCY_KEY': 'member-create-0001'})['status'], 403)
        created = admin.call('POST', f'/v1/workspaces/{self.wid}/instances',
                             {}, {'HTTP_IDEMPOTENCY_KEY': 'admin-create-0001'})
        self.assertEqual(created['status'], 201, created)
        other = created['body']['instance']['id']
        self.tick(other)
        self.assertEqual(admin.call('POST', f'/v1/instances/{other}/start', {})['status'], 202)
        # Workspace owner can still see and stop an instance an admin created.
        self.assertEqual(self.client.call('GET', f'/v1/instances/{other}')['status'], 200)
        self.assertEqual(self.action(other, 'stop')['status'] in (200, 202), True)
        self.assertEqual(outsider.call('GET', f'/v1/instances/{iid}')['status'], 404)
        self.assertEqual(outsider.call('POST', f'/v1/instances/{iid}/start', {})['status'], 404)
        self.assertEqual(outsider.call('GET', f'/v1/jobs/{jid}')['status'], 404)


class PlannerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.iid = 'a' * 32
        self.registry = {'instances': {self.iid: {'composeFile': '/synthetic/runtime/compose.yaml', 'serviceName': 'runtime', 'volumeName': 'ot-' + self.iid, 'imageRef': 'example/runtime:approved'}}}
        self.planner = NodeComposePlanner()

    def test_python_adapter_plans_restart_once_and_never_executes_docker(self):
        result = self.planner.plan(self.registry, {'instance_id': self.iid, 'operation': 'restart'})
        self.assertTrue(result['ok']); spawn = result['plan']['spawn']
        self.assertFalse(spawn['shell']); self.assertEqual(spawn['args'][-2:], ['restart', 'runtime'])
        self.assertNotIn('up', spawn['args']); self.assertNotIn('stop', spawn['args'])

    def test_python_adapter_rejects_request_overrides_and_destructive_operations(self):
        for request in ({'operation': 'start', 'image': 'bad'}, {'operation': 'purge'}, {'operation': 'start', 'instance_id': '../other'}):
            request = {'instance_id': self.iid, **request}
            result = self.planner.plan(self.registry, request)
            self.assertFalse(result['ok']); self.assertNotIn('plan', result)

    def test_operator_absolute_node_supports_toolcache_without_path_search(self):
        absolute = self.planner.node
        with patch('flybot_workspace.compose_planning.shutil.which', return_value=None):
            planner = NodeComposePlanner(node_executable=absolute)
            result = planner.plan(self.registry, {'instance_id': self.iid, 'operation': 'inspect'})
        self.assertTrue(result['ok'])
        with patch.dict(os.environ, {'FLYBOT_WORKSPACE_PLANNER_NODE': absolute}):
            self.assertEqual(NodeComposePlanner().node, str(Path(absolute).resolve()))
        with patch.dict(os.environ, {'PATH': '/untrusted/request/path'}):
            os.environ.pop('FLYBOT_WORKSPACE_PLANNER_NODE', None)
            with patch('flybot_workspace.compose_planning.shutil.which', return_value=None) as which:
                planner = NodeComposePlanner()
                which.assert_called_once_with('node', path=os.defpath)
                self.assertIsNone(planner.node)
        for invalid in ('node', './node', '/not-present/node', '/bin/sh'):
            with self.assertRaises(PlanningFailure):
                NodeComposePlanner(node_executable=invalid)
        with tempfile.TemporaryDirectory() as directory:
            node = Path(directory) / 'node'; node.write_text('not executable'); node.chmod(0o777)
            with self.assertRaises(PlanningFailure):
                NodeComposePlanner(node_executable=str(node))

    def test_python_adapter_bounds_input_and_sanitizes_process_failure(self):
        with self.assertRaises(PlanningFailure):
            self.planner.plan({'oversize': 'x' * 131073}, {})
        with patch('flybot_workspace.compose_planning.subprocess.run', side_effect=OSError('PRIVATE-PATH-TEST')):
            with self.assertRaises(PlanningFailure) as error:
                self.planner.plan(self.registry, {'instance_id': self.iid, 'operation': 'start'})
            self.assertNotIn('PRIVATE-PATH-TEST', str(error.exception))



if __name__ == '__main__':
    unittest.main()

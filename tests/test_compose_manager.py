"""Real loopback HTTP + actual bounded subprocess STUB tests; NO DOCKER ENGINE."""
from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from wsgiref.simple_server import make_server

import test_runtime as fixtures
from flybot_workspace.app import App, Config
from flybot_workspace.lifecycle import Lifecycle, RuntimeFault, RuntimePolicy, ManagerIdentity
from flybot_workspace.store import Store
from flybot_workspace.manager.client import ManagerClient
from flybot_workspace.manager.engine import Registry, Runner, ComposeEngine, manifest, compatible_manifest_upgrade, BOT_SOCIAL_TARGET, RUNTIME_KEY_TARGET, SOCIAL_SOCKET_BIND, SOCIAL_SOCKET_SOURCE, SOCIAL_SOCKET_TARGET, compose_bytes
from flybot_workspace.manager.safety import ManagerError, write_new, replace_private, instance_lock, redact
from flybot_workspace.manager.worker import ManagerWorker
from flybot_workspace.manager.__main__ import main
from flybot_workspace.server import QuietHandler
from flybot_workspace.operator_config import load_manager_auth
from flybot_workspace.security import digest, opaque

IMAGE = 'operator/runtime@sha256:' + 'a' * 64


class IsolatedSupervisorTests(unittest.TestCase):
    def test_idle_polling_is_prompt_and_failures_keep_the_backoff_and_logs(self):
        path = Path(__file__).resolve().parents[1] / 'deploy' / 'isolated' / 'manager-poll.py'
        supervisor = runpy.run_path(str(path))
        idle = {'status': 'polled', 'results': [{'status': 'no_claim'}, {'status': 'not_running'}]}
        failure = {'error': 'manager_operation_refused'}
        work = {'status': 'polled', 'results': [{'status': 'observed'}, {'status': 'published'}]}
        replies = [(0, idle), *([(2, failure)] * 5), (0, work), (2, failure)]
        passes = [subprocess.CompletedProcess([], code, json.dumps(body) + '\n') for code, body in replies]
        output = io.StringIO()
        with (
            redirect_stdout(output),
            patch.object(subprocess, 'run', side_effect=passes) as poll,
            patch.object(time, 'sleep') as sleep,
            self.assertRaises(StopIteration),
        ):
            supervisor['run']()
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 10, 20, 40, 60, 60, 1, 10])
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], [body for _, body in replies[1:]])
        self.assertTrue(all(call.args[0][-2:] == ['--execute', 'poll-once'] for call in poll.call_args_list))


class BotSocialSocketManifestTests(unittest.TestCase):
    def test_local_bot_social_socket_manifest_upgrade_is_opt_in_and_read_only(self):
        iid = 'a' * 32
        entry = {'image': IMAGE, 'healthcheck': None, 'publish_port': None}
        original = manifest(iid, entry)
        expected = manifest(iid, entry, bot_social_socket=True)
        self.assertEqual(compatible_manifest_upgrade(original, expected), {'added': [SOCIAL_SOCKET_TARGET]})
        self.assertEqual(expected['services']['flybot']['volumes'][-1], SOCIAL_SOCKET_BIND)
        different_source = deepcopy(expected)
        different_source['services']['flybot']['volumes'][-1]['source'] = 'different'
        self.assertIsNone(compatible_manifest_upgrade(original, different_source))
        config = {
            'version': 1, 'execution_enabled': False, 'base_url': 'http://127.0.0.1:8080',
            'server_host': 'account.test', 'manager_id': 'local', 'token': 'fixture', 'docker': '/bin/false',
            'socket': '/var/run/docker.sock', 'instances': {iid: entry}, 'bot_social_socket': True,
        }
        with tempfile.TemporaryDirectory() as data_dir:
            root = Path(data_dir)
            path = root / 'manager.json'
            write_new(path, config)
            with self.assertRaisesRegex(ManagerError, 'bot_social_socket_directory'):
                Registry(str(path))
            socket_dir = root / SOCIAL_SOCKET_SOURCE
            socket_dir.mkdir(mode=0o755)
            registry = Registry(str(path))
            _, stored = registry.entry(iid)
            self.assertEqual(json.loads(stored.read_text()), expected)


def assert_container_readable_secret(test, path):
    info = path.stat()
    mode = info.st_mode & 0o777
    if info.st_uid == 1000:
        test.assertEqual(mode, 0o600)
    else:
        test.assertEqual(mode, 0o644)
        test.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)



class ComposeManagerTests(unittest.TestCase):
    create = fixtures.RuntimeTests.create
    manager = fixtures.RuntimeTests.manager
    action = fixtures.RuntimeTests.action
    manager_call = fixtures.RuntimeTests.manager_call

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, RuntimePolicy(image_ref=IMAGE, profile='local-compose', backend_mode='compose'),
                                 clock=lambda: self.now)
        self.app = App(self.store, Config(fixtures.ORIGIN, allow_registration=True),
                       clock=lambda: self.now, lifecycle=self.runtime)
        self.client = fixtures.Client(self.app)
        self.assertEqual(self.client.register()['status'], 201)
        self.owner = self.client.call('GET', '/v1/auth/session')['body']['user']['id']
        personal = self.client.call('POST', '/v1/personal-agent')
        self.assertEqual(personal['status'], 201)
        self.wid = personal['body']['personal_agent']['workspace']['id']
        self.agent_id = personal['body']['personal_agent']['agent']['id']
        self.token = opaque()
        self.iid = self.create()['instance']['id']
        self.identity = self.manager(self.iid, mode='compose')
        self.root = Path(self.temp.name) / 'operator'
        self.root.mkdir(mode=0o700)
        self.docker = self.root / 'docker-stub'
        code = (Path(__file__).parent / 'fixtures/docker_stub.py').read_text()
        self.docker.write_text('#!' + sys.executable + '\n' + code.split('\n', 1)[1])
        self.docker.chmod(0o700)
        self.sock = self.root / 'engine.sock'
        s = socket.socket(socket.AF_UNIX); s.bind(str(self.sock)); s.close()
        self.cfgpath = self.root / 'manager.json'
        self.cfg = {'version': 1, 'execution_enabled': True, 'base_url': 'http://127.0.0.1:8080', 'server_host': 'management.test', 'manager_id': 'manager-a',
                    'token': self.token, 'docker': str(self.docker), 'socket': str(self.sock),
                    'instances': {self.iid: {'image': IMAGE, 'healthcheck': None, 'publish_port': None}}}
        write_new(self.cfgpath, self.cfg)
        self.registry = Registry(str(self.cfgpath))
        self.engine = ComposeEngine(self.registry, Runner(self.registry, enabled=True))

    def controls(self, **data):
        (self.root / 'stub-controls.json').write_text(json.dumps(data))

    def start_http(self):
        self.runtime.clock = time.time
        server = make_server('127.0.0.1', 0, self.app, handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        def close():
            server.shutdown(); thread.join(3); server.server_close()
        self.addCleanup(close)
        self.cfg['base_url'] = 'http://127.0.0.1:' + str(server.server_port)
        self.cfgpath.write_text(json.dumps(self.cfg))
        self.registry = Registry(str(self.cfgpath))
        self.engine = ComposeEngine(self.registry, Runner(self.registry, enabled=True))
        return ManagerClient(self.cfg['base_url'], 'manager-a', self.token, enabled=True, host_header='management.test')

    def test_explicit_execution_mode_claim_and_digest_required(self):
        claim = self.runtime.claim(self.identity, self.iid)
        self.assertEqual(claim['job']['status'], 'running')
        self.assertEqual(claim['instance']['backend_mode'], 'compose')
        self.assertIn('previous_process_ref', claim)
        with self.assertRaises(ValueError):
            RuntimePolicy(image_ref='mutable:latest', backend_mode='compose')

    def test_planning_only_mode_still_cannot_execute(self):
        self.runtime.policy = replace(self.runtime.policy, backend_mode='compose-planning')
        iid = self.create('new-planning-instance-key')['instance']['id']
        identity = self.manager(iid, mode='compose-planning')
        with self.assertRaises(RuntimeFault) as error:
            self.runtime.claim(identity, iid)
        self.assertEqual(error.exception.status, 501)

    def test_grant_mode_scope_and_remote_denials_include_recovery(self):
        wrong = ManagerIdentity('other', digest(self.token), frozenset(), 'compose')
        with self.assertRaises(RuntimeFault):
            self.runtime.claim(wrong, self.iid)
        with self.assertRaises(RuntimeFault) as error:
            self.runtime.recover(wrong, self.iid, 1, 'scope-recovery-key-0001', 'quiesced-executors')
        self.assertEqual(error.exception.status, 404)
        body = {'expected_revision': 1, 'operation_id': 'recovery-operation-0001', 'confirmation': 'quiesced-executors'}
        for peer, headers in [('198.51.100.20', {}), ('127.0.0.1', {'HTTP_ORIGIN': 'https://invalid.example'}),
                              ('127.0.0.1', {'HTTP_COOKIE': 'something'})]:
            response = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/recover', body, peer=peer, **headers)
            self.assertIn(response['status'], (401, 403))

    def test_recovery_is_fenced_idempotent_stop_and_old_lease_stays_invalid(self):
        claim = self.runtime.claim(self.identity, self.iid)
        self.now += self.runtime.policy.lease_seconds + 1
        self.runtime.expire()
        with self.assertRaises(RuntimeFault):
            self.runtime.recover(self.identity, self.iid, 99, 'operator-recovery-0001', 'quiesced-executors')
        with self.assertRaises(RuntimeFault):
            self.runtime.recover(self.identity, self.iid, 1, 'operator-recovery-0001', 'yes')
        result = self.runtime.recover(self.identity, self.iid, 1, 'operator-recovery-0001', 'quiesced-executors')
        self.assertEqual(result['instance']['desired'], 'stopped')
        self.assertEqual(result['instance']['revision'], 2)
        self.assertEqual(result['job']['operation_type'], 'recover')
        self.assertFalse(result['instance']['converged'])
        self.assertEqual(self.runtime.recover(self.identity, self.iid, 1, 'operator-recovery-0001', 'quiesced-executors'), result)
        self.assertEqual(self.action(self.iid, 'start')['status'], 409)
        with self.assertRaises(RuntimeFault):
            self.runtime.observe(self.identity, self.iid, claim['job']['id'], 1, claim['lease'], 'stopped')
        new = self.runtime.claim(self.identity, self.iid)
        done = self.runtime.observe(self.identity, self.iid, new['job']['id'], 2, new['lease'], 'stopped')
        self.assertTrue(done['instance']['converged'])
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)

    def test_real_http_subprocess_stub_create_start_restart_stop_and_retention(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        self.assertFalse(json.loads((self.root / 'stub-engine.json').read_text())['running'])
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        before = json.loads((self.root / 'stub-engine.json').read_text())
        self.action(self.iid, 'restart', {'operation_id': 'restart-stub-proof-0001'})
        restarted = worker.run_once(self.iid)
        after = json.loads((self.root / 'stub-engine.json').read_text())
        self.assertEqual(before['id'], after['id'])  # Docker restart keeps the container ID
        self.assertNotEqual(started['process_ref'], restarted['process_ref'])
        self.action(self.iid, 'stop')
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        stopped = json.loads((self.root / 'stub-engine.json').read_text())
        self.assertEqual(stopped['sentinel'], before['sentinel'])
        self.assertTrue(stopped['volume'])
        self.assertEqual(worker.run_once(self.iid)['status'], 'no_claim')
        # Restarting a stopped, existing container is supported too.
        self.action(self.iid, 'restart', {'operation_id': 'restart-stopped-0001'})
        self.assertEqual(worker.run_once(self.iid)['observed'], 'running')

    def test_lease_is_renewed_during_slow_actual_subprocess_not_after_it(self):
        client = self.start_http()
        self.runtime.policy = replace(self.runtime.policy, lease_seconds=2)
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['status'], 'observed')
        self.action(self.iid, 'start')
        self.controls(start_delay=3)
        count = []
        original = self.runtime.heartbeat
        def heartbeat(*args, **kwargs):
            count.append(time.monotonic())
            return original(*args, **kwargs)
        with patch.object(self.runtime, 'heartbeat', side_effect=heartbeat):
            result = worker.run_once(self.iid)
        self.assertEqual(result['status'], 'observed', result)
        self.assertGreaterEqual(len(count), 4)

    def test_lost_lease_aborts_subprocess_and_never_sends_observe(self):
        client = self.start_http()
        self.runtime.policy = replace(self.runtime.policy, lease_seconds=2)
        worker = ManagerWorker(client, self.registry, self.engine)
        worker.run_once(self.iid); self.action(self.iid, 'start')
        self.controls(start_delay=3)
        original = client.leased_call
        calls = []
        def leased(iid, claim, action, **fields):
            calls.append(action)
            if calls.count('heartbeat') >= 2:
                raise ManagerError('stale_observation')
            return original(iid, claim, action, **fields)
        with patch.object(client, 'leased_call', side_effect=leased):
            start = time.monotonic(); result = worker.run_once(self.iid)
        self.assertEqual(result['status'], 'uncertain')
        self.assertLess(time.monotonic() - start, 2)
        self.assertNotIn('observe', calls)

    def test_actual_http_cli_inspect_logs_and_explicit_recovery(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        worker.run_once(self.iid)
        common = ['--config', str(self.cfgpath), '--execute']
        def command(*args):
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(common + list(args) + ['--instance-id', self.iid])
            return code, json.loads(out.getvalue())
        self.assertEqual(command('inspect')[0], 0)
        process = subprocess.run([sys.executable, '-m', 'flybot_workspace.manager', *common, 'inspect', '--instance-id', self.iid],
                                 cwd=Path(__file__).parent.parent, capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stdout)
        self.assertTrue(json.loads(process.stdout)['engine']['stopped'])
        self.assertNotIn(self.token, process.stdout + process.stderr)
        code, logs = command('logs', '--tail', '10')
        self.assertEqual(code, 0)
        self.assertNotIn('synthetic-password', logs['text'])
        self.assertNotIn('synthetic-token', logs['text'])
        self.assertNotIn('synthetic-bearer', logs['text'])
        self.action(self.iid, 'start')
        claim = client.claim(self.iid)  # simulate a crashed manager before command
        with self.store.transaction() as db:
            db.execute('UPDATE runtime_jobs SET lease_until=0 WHERE id=?', (claim['job']['id'],))
        code, preview = command('recover')
        self.assertEqual(code, 0); self.assertFalse(preview['applied'])
        self.assertTrue(client.snapshot(self.iid)['blocked'])
        self.assertEqual(command('recover', '--apply', '--expected-revision', '2', '--operation-id', 'operator-recover-0001')[0], 2)
        code, result = command('recover', '--apply', '--confirm-no-active-executors', '--expected-revision', '2', '--operation-id', 'operator-recover-0001')
        self.assertEqual(code, 0); self.assertTrue(result['applied'])
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')

    def test_registry_rejects_bind_mounts_commands_mutable_image_and_manifest_tamper(self):
        original = self.cfg['instances'][self.iid]
        for extra in ('command', 'mounts', 'env', 'privileged', 'compose_file'):
            with self.assertRaises(ManagerError):
                manifest(self.iid, {**original, extra: 'untrusted'})
        with self.assertRaises(ManagerError):
            manifest(self.iid, {**original, 'image': 'runtime:latest'})
        self.registry.entry(self.iid)
        path = self.root / ('compose-' + self.iid + '.json')
        data = json.loads(path.read_text()); data['services']['flybot']['privileged'] = True
        path.write_text(json.dumps(data))
        with self.assertRaises(ManagerError):
            self.engine.compose(self.iid, 'start')

    def test_registry_symlinks_permissions_and_unregistered_ids_are_rejected(self):
        self.cfgpath.chmod(0o644)
        with self.assertRaises(ManagerError):
            Registry(str(self.cfgpath))
        self.cfgpath.chmod(0o600)
        alias = self.root / 'link.json'; alias.symlink_to(self.cfgpath)
        with self.assertRaises(ManagerError):
            Registry(str(alias))
        with self.assertRaises(ManagerError):
            self.registry.entry('b' * 32)
        self.registry.entry(self.iid)
        path = self.root / ('compose-' + self.iid + '.json')
        path.unlink(); path.symlink_to(self.cfgpath)
        with self.assertRaises(ManagerError):
            self.registry.entry(self.iid)

    def test_operator_ownership_executable_symlink_and_writable_binary_are_rejected(self):
        with patch('flybot_workspace.manager.safety.os.getuid', return_value=os.getuid() + 1):
            with self.assertRaises(ManagerError):
                Registry(str(self.cfgpath))
        alias = self.root / 'docker-link'; alias.symlink_to(self.docker)
        self.cfg['docker'] = str(alias); self.cfgpath.write_text(json.dumps(self.cfg))
        registry = Registry(str(self.cfgpath))
        with self.assertRaises(ManagerError):
            ComposeEngine(registry, Runner(registry, enabled=True)).compose(self.iid, 'create')
        self.cfg['docker'] = str(self.docker); self.cfgpath.write_text(json.dumps(self.cfg))
        self.docker.chmod(0o722)
        registry = Registry(str(self.cfgpath))
        with self.assertRaises(ManagerError):
            ComposeEngine(registry, Runner(registry, enabled=True)).compose(self.iid, 'create')

    def test_default_off_and_exact_command_allowlist(self):
        with self.assertRaises(ManagerError):
            ComposeEngine(self.registry, Runner(self.registry)).compose(self.iid, 'create')
        for verb in ('pull', 'down', 'rm', 'exec', 'run', 'start --privileged'):
            with self.assertRaises(ManagerError):
                self.engine.compose(self.iid, verb)
        for tail in (0, 101, True, '10'):
            with self.assertRaises(ManagerError):
                self.engine.compose(self.iid, 'logs', tail=tail)
        for base in ('http://localhost:8080', 'https://127.0.0.1:8080', 'http://example.com:8080', 'http://127.0.0.1:8080/path', 'http://u:p@127.0.0.1:8080'):
            with self.assertRaises(ManagerError):
                ManagerClient(base, 'manager-a', self.token)

    def test_project_volume_identity_and_output_limits_fail_closed(self):
        self.engine.compose(self.iid, 'create')
        for ctrl in ({'wrong_volume': True}, {'wrong_project': True}, {'privileged': True}, {'volume_driver_options': True}):
            self.controls(**ctrl)
            with self.assertRaises(ManagerError):
                self.engine.inspect(self.iid)
        self.controls(log_bytes=65537)
        with self.assertRaises(ManagerError) as error:
            self.engine.compose(self.iid, 'logs')
        self.assertEqual(error.exception.code, 'output_limit')

    def test_health_inspection_uses_exact_docker_labels_and_refuses_ambiguous_ids(self):
        self.engine.compose(self.iid, 'start')
        with patch.object(self.engine.runner, 'run', wraps=self.engine.runner.run) as run:
            self.assertTrue(self.engine.inspect(self.iid)['healthy'])
            self.assertEqual([call.args[0][0] for call in run.call_args_list], ['volume', 'ps', 'inspect'])
            self.assertEqual(run.call_args_list[1].args[0], [
                'ps', '--all', '--quiet', '--no-trunc',
                '--filter', 'label=com.docker.compose.project=ot-' + self.iid,
                '--filter', 'label=com.docker.compose.service=flybot',
                '--filter', 'label=com.docker.compose.config-hash',
            ])
        for output in ('invalid-id', 'b' * 64 + '\n' + 'c' * 64):
            with self.subTest(output=output):
                self.controls(container_list_raw=output)
                with self.assertRaisesRegex(ManagerError, 'container_scope'):
                    self.engine.inspect(self.iid)

    def test_exact_volume_inspect_rejects_existing_untrusted_volume_under_substring_filter_model(self):
        self.engine.compose(self.iid, 'create')
        name = 'ot-' + self.iid
        # Regression fixture: anchored filter misses the existing name. Not a real-daemon claim.
        raw, _ = self.engine.runner.run(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])
        self.assertEqual(raw, '')
        self.controls(wrong_volume=True)
        with patch.object(self.engine.runner, 'run', wraps=self.engine.runner.run) as run:
            with self.assertRaises(ManagerError) as error:
                self.engine.volume_check(self.iid)
            self.assertEqual(error.exception.code, 'volume_owner')
            self.assertEqual([c.args[0] for c in run.call_args_list], [['volume', 'inspect', name]])

    def test_exact_volume_missing_is_distinguished_from_all_other_nonzero_errors(self):
        name = 'ot-' + self.iid
        self.engine.volume_check(self.iid)  # exact missing response from actual subprocess stub
        self.controls(volume_inspect_error='Error: No such volume: ' + name)
        self.engine.volume_check(self.iid)
        for ctrl in (
                {'volume_inspect_error': 'permission denied'},
                {'volume_inspect_error': 'Cannot connect to the Docker daemon'},
                {'volume_inspect_error': 'Error response from daemon: get ot-wrong: no such volume'},
                {'volume_inspect_error': 'Error: No such volume: ' + name + '\npermission denied'},
                {'volume_error_code': 2}, {'volume_error_stdout': ''},
                {'volume_error_stdout': '[{}]'}, {'volume_error_stdout': 'garbled'}):
            with self.subTest(ctrl=ctrl):
                self.controls(**ctrl)
                with self.assertRaises(ManagerError) as error:
                    self.engine.volume_check(self.iid)
                self.assertEqual(error.exception.code, 'engine_failure')

    def test_volume_inspect_success_is_not_absence_and_invalid_metadata_fails_closed(self):
        self.engine.compose(self.iid, 'create')
        self.engine.volume_check(self.iid)
        for ctrl in ({'volume_inspect_raw': '[]'}, {'volume_inspect_raw': '{}'},
                     {'volume_inspect_raw': 'invalid'}, {'volume_inspect_warning': True},
                     {'volume_inspect_raw': '[{"Name":"wrong"}]'}, {'volume_driver': 'remote'},
                     {'volume_scope': 'global'}, {'volume_driver_options': True}, {'wrong_volume': True}):
            with self.subTest(ctrl=ctrl):
                self.controls(**ctrl)
                with self.assertRaises(ManagerError):
                    self.engine.volume_check(self.iid)

    def test_volume_failure_diagnostics_never_become_public_exception_text(self):
        secret = 'synthetic-secret-never-log-this'
        self.controls(volume_inspect_error='permission denied password=' + secret)
        with self.assertRaises(ManagerError) as error:
            self.engine.volume_check(self.iid)
        self.assertEqual(str(error.exception), 'engine_failure')
        self.assertNotIn(secret, repr(error.exception))

    def test_claim_validation_binds_requested_target_revision_and_operation(self):
        claim = self.runtime.claim(self.identity, self.iid)
        client = ManagerClient('http://127.0.0.1:8080', 'manager-a', self.token, enabled=True)
        modifications = [('instance', 'id', 'b' * 32), ('job', 'revision', True), ('job', 'status', 'queued'),
                         ('job', 'operation_type', 'restart'), ('instance', 'desired', 'running')]
        for section, field, value in modifications:
            bad = deepcopy(claim); bad[section][field] = value
            with patch.object(client, 'call', return_value={'claim': bad}), self.assertRaises(ManagerError):
                client.claim(self.iid)

    def test_start_requires_health_and_restart_requires_new_started_at(self):
        self.engine.compose(self.iid, 'create')
        self.engine.compose(self.iid, 'start')
        self.controls(not_ready=True)
        self.assertFalse(self.engine.inspect(self.iid)['healthy'])
        with self.assertRaises(ManagerError) as error:
            self.engine.wait(self.iid, 'start', timeout=.01)
        self.assertEqual(error.exception.code, 'readiness_timeout')
        self.controls(unchanged_identity=True)
        previous = self.engine.inspect(self.iid)['process_ref']
        self.engine.compose(self.iid, 'restart')
        self.assertEqual(self.engine.inspect(self.iid)['process_ref'], previous)
        with self.assertRaises(ManagerError):
            self.engine.wait(self.iid, 'restart', previous, timeout=.01)

    def test_subprocess_total_timeout_and_clean_environment(self):
        with patch.dict(os.environ, {'DOCKER_HOST': 'tcp://invalid:2375', 'COMPOSE_FILE': '/untrusted', 'HTTP_PROXY': 'http://invalid:1234'}):
            self.engine.compose(self.iid, 'create')
        keys = json.loads((self.root / 'stub-engine.json').read_text())['env_keys']
        for key in ('DOCKER_HOST', 'COMPOSE_FILE', 'HTTP_PROXY', 'PYTHONPATH', 'LD_PRELOAD'):
            self.assertNotIn(key, keys)
        self.controls(log_delay=3)
        _, path = self.registry.entry(self.iid)
        args = ['compose', '--env-file', '/dev/null', '-f', str(path), '--project-directory', str(self.root), '-p', 'ot-' + self.iid, 'logs', '--no-color', '--no-log-prefix', '--tail', '1', 'flybot']
        before = time.monotonic()
        with self.assertRaises(ManagerError) as error:
            self.engine.runner.run(args, timeout=.15)
        self.assertEqual(error.exception.code, 'command_timeout')
        self.assertLess(time.monotonic() - before, 1)

    def test_recovery_of_running_engine_queues_only_fenced_stop_without_resuming_restart(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        worker.run_once(self.iid); self.action(self.iid, 'start'); worker.run_once(self.iid)
        self.action(self.iid, 'restart', {'operation_id': 'crashed-restart-0001'})
        claim = client.claim(self.iid)
        with self.store.transaction() as db:
            db.execute('UPDATE runtime_jobs SET lease_until=0 WHERE id=?', (claim['job']['id'],))
        common = ['--config', str(self.cfgpath), '--execute']
        def command(*args):
            with redirect_stdout(io.StringIO()):
                return main(common + list(args) + ['--instance-id', self.iid])
        self.assertEqual(command('recover', '--apply', '--expected-revision', '3', '--operation-id', 'safe-stop-recover-0001'), 2)
        self.assertTrue(self.engine.inspect(self.iid)['healthy'])
        self.assertEqual(command('recover', '--apply', '--confirm-no-active-executors', '--expected-revision', '3', '--operation-id', 'safe-stop-recover-0001'), 0)
        # Recovery itself performs NO unleased stop and records NO success observation.
        self.assertTrue(self.engine.inspect(self.iid)['healthy'])
        snapshot = client.snapshot(self.iid)
        self.assertEqual(snapshot['desired'], 'stopped'); self.assertFalse(snapshot['converged'])
        self.assertEqual(self.action(self.iid, 'start')['status'], 409)
        with self.assertRaises(ManagerError):
            client.leased_call(self.iid, claim, 'observe', observed='running', process_ref='b' * 32)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        self.assertTrue(self.engine.inspect(self.iid)['stopped'])

    def test_operator_lock_redaction_and_init_disabled_no_overwrite(self):
        with instance_lock(self.root, self.iid), self.assertRaises(ManagerError):
            with instance_lock(self.root, self.iid):
                self.fail('second lock unexpectedly acquired')
        text = '{"password":"small", "api_key":"short"} token=other Bearer abc.def.ghi ' + self.token
        out = redact(text, (self.token,))
        for secret in ('small', 'short', 'other', 'abc.def.ghi', self.token):
            self.assertNotIn(secret, out)
        state = Path(self.temp.name) / 'new-manager'
        args = ['init', '--state-dir', str(state), '--instance-id', self.iid, '--image', IMAGE]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(main(args), 0)
            self.assertEqual(main(args), 2)
        config = json.loads((state / 'manager.json').read_text())
        self.assertEqual(load_manager_auth(state / 'grants.json').identities['local-compose'].backend_mode, 'compose')
        self.assertFalse(config['execution_enabled'])
        self.assertEqual((state / 'manager.json').stat().st_mode & 0o777, 0o600)
        self.assertNotIn(config['token'], (state / 'grants.json').read_text())


    def put_model_api(self, scope, key, provider='openai', base_url='https://example.com/v1', model='gpt-4o-mini', account_id=None, workspace_id=None):
        from uuid import uuid4
        from flybot_workspace import model_api
        blob = model_api.wrap(model_api.wrapping_key(self.store), key)
        with self.store.transaction() as db:
            db.execute(
                'INSERT INTO model_api_configs(id,scope,account_id,workspace_id,provider,base_url,model,key_blob,revision,updated) VALUES(?,?,?,?,?,?,?,?,1,?)',
                (uuid4().hex, scope, account_id, workspace_id, provider, base_url, model, blob, self.now),
            )

    def test_manifest_pins_readonly_model_api_bind_without_the_key(self):
        document = manifest(self.iid, self.cfg['instances'][self.iid])
        volumes = document['services']['flybot']['volumes']
        secret = [item for item in volumes if item.get('target') == '/run/secrets/flybot-workspace-model-api.json']
        self.assertEqual(len(secret), 1)
        self.assertEqual(secret[0]['type'], 'bind')
        self.assertEqual(secret[0]['source'], 'secrets/model-api-' + self.iid + '.json')
        self.assertTrue(secret[0]['read_only'])
        collaboration = [item for item in volumes if item.get('target') == '/run/secrets/flybot-workspace-bot-social.json']
        self.assertEqual(len(collaboration), 1)
        self.assertEqual(collaboration[0]['type'], 'bind')
        self.assertEqual(collaboration[0]['source'], 'secrets/bot-social-' + self.iid + '.json')
        self.assertTrue(collaboration[0]['read_only'])
        runtime_key = [item for item in volumes if item.get('target') == RUNTIME_KEY_TARGET]
        self.assertEqual(len(runtime_key), 1)
        self.assertEqual(runtime_key[0]['type'], 'bind')
        self.assertEqual(runtime_key[0]['source'], 'secrets/runtime-key-' + self.iid + '.json')
        self.assertTrue(runtime_key[0]['read_only'])
        self.assertNotIn('api_key', json.dumps(document))
        self.assertNotIn('token', json.dumps(document))
        dumped = (self.root / ('compose-' + self.iid + '.json'))
        self.registry.entry(self.iid)
        self.assertNotIn('sk-', dumped.read_text())

    def test_worker_injects_resolved_secret_workspace_override_wins_and_key_is_redacted(self):
        platform_key = 'sk-platform-inject-test-key-aaaa'
        workspace_key = 'sk-workspace-inject-test-key-bbbb'
        self.put_model_api('platform', platform_key)
        self.put_model_api('workspace', workspace_key, provider='anthropic', base_url='https://api.anthropic.com', model='claude-sonnet', workspace_id=self.wid)
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        path = self.engine.secret_path(self.iid)
        assert_container_readable_secret(self, path)
        document = json.loads(path.read_text())
        self.assertEqual(document['api_key'], workspace_key)
        self.assertEqual(document['source'], 'user')
        self.assertEqual(document['provider'], 'anthropic')
        self.assertEqual(document['model'], 'claude-sonnet')
        self.assertNotIn(workspace_key, (self.root / ('compose-' + self.iid + '.json')).read_text())
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        self.assertNotIn(workspace_key, json.dumps(started))
        self.assertNotIn(platform_key, json.dumps(started))
        instance = self.client.call('GET', f'/v1/instances/{self.iid}')
        body = json.dumps(instance)
        self.assertNotIn(workspace_key, body)
        self.assertNotIn(platform_key, body)
        stdout, stderr = self.engine.compose(self.iid, 'logs', tail=20)
        redacted = redact(stdout + '\n' + stderr, (workspace_key, platform_key, self.token))
        self.assertNotIn(workspace_key, redacted)
        self.assertNotIn(platform_key, redacted)

    def test_missing_model_api_writes_empty_secret_file(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        path = self.engine.secret_path(self.iid)
        self.assertEqual(path.read_text(), '')
        assert_container_readable_secret(self, path)

    def test_runtime_secret_requires_a_lease_and_rejects_stop_jobs(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        self.action(self.iid, 'start')
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        bad = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-secret', {
            'job_id': 'a' * 32, 'observed_revision': 1, 'lease': 'A' * 43,
        })
        self.assertIn(bad['status'], (400, 401, 403, 409))
        self.assertNotIn('sk-', json.dumps(bad))
        self.action(self.iid, 'stop')
        stop = client.claim(self.iid)
        with self.assertRaises(ManagerError) as error:
            client.runtime_secret(self.iid, stop)
        self.assertEqual(error.exception.code, 'secret_not_applicable')
        observed = client.leased_call(self.iid, stop, 'observe', observed='stopped')
        self.assertEqual(observed['job']['status'], 'succeeded')

    def test_inspect_rejects_an_extra_bind_mount(self):
        self.engine.compose(self.iid, 'create')
        self.engine.compose(self.iid, 'start')
        self.controls(extra_bind=True)
        with self.assertRaises(ManagerError) as error:
            self.engine.inspect(self.iid)
        self.assertIn(error.exception.code, ('unsafe_container', 'unexpected_mount', 'secret_mount', 'bot_social_mount'))

    def test_inspect_accepts_named_volume_in_binds_and_rejects_a_substitute(self):
        # Real Docker lists ot-<id>:/data:rw in HostConfig.Binds as well as Mounts.
        self.engine.compose(self.iid, 'create')
        state = self.engine.inspect(self.iid)
        self.assertTrue(state['stopped'])
        self.assertFalse(state['needs_recreate'])
        self.controls(substitute_volume_bind=True)
        with self.assertRaises(ManagerError) as error:
            self.engine.inspect(self.iid)
        self.assertEqual(error.exception.code, 'unsafe_container')

    def put_bot_social(self, scope, server, display_name=None, workspace_id=None):
        from uuid import uuid4
        with self.store.transaction() as db:
            db.execute(
                'INSERT INTO bot_social_configs(id,scope,workspace_id,server,display_name,revision,updated) VALUES(?,?,?,?,?,1,?)',
                (uuid4().hex, scope, workspace_id, server, display_name, self.now),
            )

    def test_worker_injects_workspace_bot_social_url_without_a_token(self):
        self.put_bot_social('platform', 'https://platform.social.example', 'Platform')
        self.put_bot_social('workspace', 'https://team.social.example', 'Team', workspace_id=self.wid)
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        path = self.engine.bot_social_path(self.iid)
        assert_container_readable_secret(self, path)
        document = json.loads(path.read_text())
        self.assertEqual(document['server'], 'https://team.social.example')
        self.assertEqual(document['displayName'], 'Team')
        self.assertEqual(document['source'], 'workspace')
        self.assertNotIn('token', document)
        self.assertNotIn('api_key', document)
        dumped = (self.root / ('compose-' + self.iid + '.json')).read_text()
        self.assertIn('flybot-workspace-bot-social.json', dumped)
        self.assertNotIn('token', dumped)
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        body = json.dumps(started)
        # The server URL may appear in operator docs, but a token must not.
        self.assertNotIn('token', body)

    def test_missing_bot_social_writes_empty_config_file(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        path = self.engine.bot_social_path(self.iid)
        self.assertEqual(json.loads(path.read_text()), {})
        assert_container_readable_secret(self, path)

    def test_runtime_bot_social_requires_a_lease_and_rejects_stop_jobs(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        self.action(self.iid, 'start')
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        bad = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-bot-social', {
            'job_id': 'a' * 32, 'observed_revision': 1, 'lease': 'A' * 43,
        })
        self.assertIn(bad['status'], (400, 401, 403, 409))
        self.assertNotIn('token', json.dumps(bad))
        self.action(self.iid, 'stop')
        stop = client.claim(self.iid)
        with self.assertRaises(ManagerError) as error:
            client.runtime_bot_social(self.iid, stop)
        self.assertEqual(error.exception.code, 'bot_social_not_applicable')
        observed = client.leased_call(self.iid, stop, 'observe', observed='stopped')
        self.assertEqual(observed['job']['status'], 'succeeded')



    def test_worker_installs_bootstrap_without_credentials_on_create_start_and_restart(self):
        # The separate auto-provision API suite and real Compose fixture cover
        # enrollment. Mark this fixture's existing instance to exercise delivery.
        with self.store.transaction() as db:
            db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?,?,?)',
                       (self.owner, self.wid, self.agent_id, self.iid, 'manager-a', self.now))
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)

        def assert_bootstrap_file():
            path = self.engine.agent_bootstrap_path(self.iid)
            assert_container_readable_secret(self, path)
            document = json.loads(path.read_text())
            self.assertEqual(set(document), {'agent_bootstrap'})
            bundle = document['agent_bootstrap']
            self.assertEqual(bundle['instance_id'], self.iid)
            personal = json.loads(bundle['tables']['personal_agents'])
            self.assertEqual(len(personal), 1)
            self.assertEqual((personal[0]['workspace_id'], personal[0]['agent_id']), (self.wid, self.agent_id))
            self.assertNotIn('origin', bundle)
            self.assertNotIn('token', bundle)
            self.assertNotIn('hostname', bundle)

        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        assert_bootstrap_file()
        # Simulate a left-over credential file that would still be on a stopped host.
        self.engine.agent_bootstrap_path(self.iid).write_text('{"token":"obsolete-fixture-token"}')
        # The create observation queued the automatic start for this instance.
        self.assertEqual(worker.run_once(self.iid)['observed'], 'running')
        assert_bootstrap_file()
        restarted = self.action(self.iid, 'restart', {'operation_id': 'bootstrap-test-restart-0001'})
        self.assertEqual(restarted['status'], 202, restarted)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'running')
        assert_bootstrap_file()
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM instance_runtime_keys').fetchone()[0], 0)

    def test_manual_instance_has_empty_bootstrap_file_and_endpoint_rejects_stop_jobs(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        path = self.engine.agent_bootstrap_path(self.iid)
        assert_container_readable_secret(self, path)
        self.assertEqual(path.read_bytes(), b'')
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'running')
        self.assertEqual(path.read_bytes(), b'')
        invalid_lease = {'job_id': 'a' * 32, 'observed_revision': 1, 'lease': 'A' * 43}
        bad = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-bootstrap', invalid_lease)
        self.assertIn(bad['status'], (400, 401, 403, 409))
        retired = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', invalid_lease)
        self.assertEqual(retired['status'], 404)
        self.assertEqual(self.action(self.iid, 'stop')['status'], 202)
        stop = client.claim(self.iid)
        with self.assertRaises(ManagerError) as error:
            client.runtime_agent_bootstrap(self.iid, stop)
        self.assertEqual(error.exception.code, 'agent_bootstrap_not_applicable')
        observed = client.leased_call(self.iid, stop, 'observe', observed='stopped')
        self.assertEqual(observed['job']['status'], 'succeeded')

    def test_manager_rejects_unexpected_bootstrap_payload_and_wrong_instance(self):
        client = ManagerClient(self.cfg['base_url'], 'manager-a', self.token, enabled=True)
        claim = {'job': {'id': 'a' * 32, 'revision': 1}, 'lease': 'A' * 43}
        bundle = {
            'format': 'flybot-workspace-dsbot-import', 'version': 1, 'feature': 'agents',
            'instance_id': 'b' * 32, 'created': self.now, 'tables': {}, 'manifest': {},
        }
        for response in ({'agent_bootstrap': None, 'token': 'obsolete-token'}, {'agent_bootstrap': bundle}):
            with self.subTest(response=response), patch.object(client, 'call', return_value=response):
                with self.assertRaisesRegex(ManagerError, 'agent_bootstrap_shape'):
                    client.runtime_agent_bootstrap(self.iid, claim)
        with self.assertRaisesRegex(ManagerError, 'agent_bootstrap_shape'):
            self.engine.install_agent_bootstrap(self.iid, bundle)
        self.assertFalse(self.engine.agent_bootstrap_path(self.iid).exists())

    def old_compose_document(self):
        document = manifest(self.iid, self.cfg['instances'][self.iid])
        skip = {BOT_SOCIAL_TARGET, RUNTIME_KEY_TARGET}
        volumes = [item for item in document['services']['flybot']['volumes'] if item.get('target') not in skip]
        document['services']['flybot']['volumes'] = volumes
        return document

    def write_old_compose(self):
        path = self.root / ('compose-' + self.iid + '.json')
        document = self.old_compose_document()
        if path.exists():
            replace_private(path, compose_bytes(document))
        else:
            write_new(path, document)
        return path

    def test_compatible_secret_bind_upgrade_is_detected_and_unrelated_drift_is_not(self):
        expected = manifest(self.iid, self.cfg['instances'][self.iid])
        older = self.old_compose_document()
        self.assertEqual(compatible_manifest_upgrade(older, expected),
                         {'added': [BOT_SOCIAL_TARGET, RUNTIME_KEY_TARGET]})
        drifted = dict(older)
        drifted['services'] = {'flybot': dict(older['services']['flybot'], image='evil@sha256:' + 'b' * 64)}
        self.assertIsNone(compatible_manifest_upgrade(drifted, expected))

    def test_migrate_manifest_rewrites_compose_and_never_deletes_the_volume(self):
        path = self.write_old_compose()
        registry = Registry(str(self.cfgpath))
        preview = registry.preview_manifest(self.iid)
        self.assertEqual(preview['status'], 'upgradeable')
        self.assertEqual(preview['volume'], 'ot-' + self.iid)
        self.assertEqual(path.read_bytes(), compose_bytes(self.old_compose_document()))
        applied = registry.apply_manifest_upgrade(self.iid)
        self.assertEqual(applied['status'], 'upgraded')
        self.assertEqual(applied['volume_deleted'] if 'volume_deleted' in applied else False, False)
        self.assertIn(BOT_SOCIAL_TARGET, applied['added'])
        self.assertIn(RUNTIME_KEY_TARGET, applied['added'])
        current = registry.preview_manifest(self.iid)
        self.assertEqual(current['status'], 'current')
        # CLI dry-run of a already-current file, and a fresh older file via CLI --apply.
        self.write_old_compose()
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(['--config', str(self.cfgpath), 'migrate-manifest', '--instance-id', self.iid])
        self.assertEqual(code, 0)
        dry = json.loads(out.getvalue())
        self.assertEqual(dry['status'], 'upgradeable')
        self.assertFalse(dry['volume_deleted'])
        self.assertFalse(dry['executed'])
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(['--config', str(self.cfgpath), 'migrate-manifest', '--apply', '--instance-id', self.iid])
        self.assertEqual(code, 0)
        done = json.loads(out.getvalue())
        self.assertEqual(done['status'], 'upgraded')
        self.assertFalse(done['volume_deleted'])
        self.assertTrue(self.engine.bot_social_path(self.iid).exists())
        self.assertEqual(json.loads(self.engine.bot_social_path(self.iid).read_text()), {})
        self.assertTrue(self.engine.agent_bootstrap_path(self.iid).exists())
        self.assertEqual(self.engine.agent_bootstrap_path(self.iid).read_text(), '')

    def test_start_after_bind_upgrade_recreates_container_without_deleting_volume_data(self):
        client = self.start_http()
        worker = ManagerWorker(client, self.registry, self.engine)
        self.assertEqual(worker.run_once(self.iid)['observed'], 'stopped')
        # Snapshot the pre-upgrade container (model-api bind only) and keep the volume sentinel.
        self.write_old_compose()
        # Reset the stub's recorded binds to the older file and keep the sentinel.
        state_path = self.root / 'stub-engine.json'
        state = json.loads(state_path.read_text())
        self.assertEqual(state.get('sentinel'), 'persistent-test-content')
        # Re-read binds from the older compose by dropping the snapshot, then create from it.
        state.pop('binds', None)
        state_path.write_text(json.dumps(state))
        self.engine.compose(self.iid, 'create')  # entry() will upgrade the file first...
        # The create above used the upgraded file if entry migrated. Force the stub back to old binds.
        self.engine.compose(self.iid, 'create')
        state = json.loads(state_path.read_text())
        # After entry auto-upgrade, stub snapshots current (new) binds on create without force.
        # Simulate a leftover container by writing old binds back, keeping the sentinel and id.
        document = self.old_compose_document()
        old_binds = []
        for volume in document['services']['flybot']['volumes']:
            if volume.get('type') == 'bind':
                source = str((self.root / volume['source']).resolve())
                old_binds.append({'Type': 'bind', 'Source': source, 'Destination': volume['target'], 'RW': False,
                                  'bind': source + ':' + volume['target'] + ':ro'})
        state['binds'] = old_binds
        state['sentinel'] = 'persistent-test-content'
        state['running'] = False
        state_path.write_text(json.dumps(state))
        inspected = self.engine.inspect(self.iid)
        self.assertTrue(inspected['needs_recreate'])
        self.assertEqual(inspected['volume'], 'ot-' + self.iid)
        self.assertEqual(self.action(self.iid, 'start')['status'], 202)
        started = worker.run_once(self.iid)
        self.assertEqual(started['observed'], 'running')
        state = json.loads(state_path.read_text())
        self.assertEqual(state['sentinel'], 'persistent-test-content')
        argv = ' '.join(state.get('last_argv') or [])
        self.assertIn('--force-recreate', argv)
        self.assertNotIn(' -v', ' ' + argv)
        self.assertNotIn('down', argv.split())
        self.assertNotIn('volume', argv.split()[:2] if False else argv)
        self.assertNotIn('rm', argv.split())
        self.assertFalse(self.engine.inspect(self.iid).get('needs_recreate'))

    def test_incompatible_compose_drift_still_fails_closed_without_touching_the_volume(self):
        path = self.write_old_compose()
        raw = json.loads(path.read_text())
        raw['services']['flybot']['command'] = ['sh']
        replace_private(path, compose_bytes(raw))
        sentinel = self.root / 'volume-sentinel'
        sentinel.write_text('keep-me')
        with self.assertRaises(ManagerError) as error:
            Registry(str(self.cfgpath)).entry(self.iid)
        self.assertEqual(error.exception.code, 'manifest_changed')
        self.assertEqual(sentinel.read_text(), 'keep-me')
        self.assertIn('sh', path.read_text())


class ComposeMemoryUpgradeTests(unittest.TestCase):
    def test_memory_upgrade_preserves_volume_and_waits_for_the_next_start(self):
        temp = tempfile.TemporaryDirectory(prefix='ot-mgr-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        iid = 'a' * 32
        docker = root / 'docker-stub'
        code = (Path(__file__).parent / 'fixtures/docker_stub.py').read_text()
        docker.write_text('#!' + sys.executable + '\n' + code.split('\n', 1)[1])
        docker.chmod(0o700)
        sock = root / 'engine.sock'
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(sock))
        entry = {'image': IMAGE, 'healthcheck': None, 'publish_port': None}
        config = root / 'manager.json'
        write_new(config, {'version': 1, 'execution_enabled': True,
                           'base_url': 'http://127.0.0.1:8080', 'server_host': 'management.test',
                           'manager_id': 'manager-a', 'token': 'unused-fixture-token',
                           'docker': str(docker), 'socket': str(sock), 'instances': {iid: entry}})
        registry = Registry(str(config))
        engine = ComposeEngine(registry, Runner(registry, enabled=True))
        engine.compose(iid, 'start')

        path = root / ('compose-' + iid + '.json')
        expected = manifest(iid, entry)
        legacy = deepcopy(expected)
        legacy['services']['flybot']['mem_limit'] = '1g'
        replace_private(path, compose_bytes(legacy))
        state_path = root / 'stub-engine.json'
        state = json.loads(state_path.read_text())
        state['memory_bytes'] = 1024 ** 3
        state_path.write_text(json.dumps(state))

        preview = registry.preview_manifest(iid)
        self.assertEqual(preview['status'], 'upgradeable')
        self.assertEqual(preview['added'], [])
        self.assertEqual(preview['memory_limit'], {'from': '1g', 'to': '1536m'})
        self.assertEqual(path.read_bytes(), compose_bytes(legacy))
        unsupported = deepcopy(legacy)
        unsupported['services']['flybot']['mem_limit'] = '2g'
        self.assertIsNone(compatible_manifest_upgrade(unsupported, expected))
        altered_volume = deepcopy(legacy)
        altered_volume['services']['flybot']['volumes'][0]['volume'] = {'nocopy': True}
        self.assertIsNone(compatible_manifest_upgrade(altered_volume, expected))

        engine.compose(iid, 'stop')
        self.assertEqual(engine.wait(iid, 'stop', timeout=2), {'observed': 'stopped'})
        self.assertTrue(engine.inspect(iid)['needs_recreate'])
        self.assertEqual(json.loads(state_path.read_text())['memory_bytes'], 1024 ** 3)
        self.assertEqual(json.loads(path.read_text())['volumes'], legacy['volumes'])

        engine.compose(iid, 'start-recreate')
        self.assertEqual(engine.wait(iid, 'start-recreate', timeout=2)['observed'], 'running')
        current = json.loads(state_path.read_text())
        self.assertEqual(current['memory_bytes'], 1536 * 1024 ** 2)
        self.assertEqual(current['sentinel'], state['sentinel'])
        self.assertIn('--force-recreate', current['last_argv'])
        self.assertNotIn('-v', current['last_argv'])
        self.assertFalse(engine.inspect(iid)['needs_recreate'])


class ManagerHttpTransportTests(unittest.TestCase):
    def serve(self, status=200, raw=b'{}', slow=False):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append(dict(self.headers))
                try:
                    if slow:
                        self.connection.sendall(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                        for _ in range(200):
                            time.sleep(.02); self.connection.sendall(b'x')
                    else:
                        self.send_response(status)
                        self.send_header('Content-Length', str(len(raw)))
                        self.send_header('Location', 'http://198.51.100.20:9/must-not-follow')
                        self.end_headers(); self.wfile.write(raw)
                except OSError:
                    pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True); thread.start()
        def close():
            server.shutdown(); thread.join(3); server.server_close()
        self.addCleanup(close)
        client = ManagerClient('http://127.0.0.1:' + str(server.server_port), 'local-test', 'a' * 43,
                               host_header='management.test', enabled=True, timeout=.2 if slow else 2)
        return client, calls

    def test_no_redirect_proxy_cookie_origin_and_nested_safe_error(self):
        client, calls = self.serve(status=302)
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://198.51.100.30:9', 'http_proxy': 'http://198.51.100.30:9'}):
            with self.assertRaises(ManagerError):
                client.call('GET', '/v1/internal/test')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['Host'], 'management.test')
        self.assertNotIn('Origin', calls[0]); self.assertNotIn('Cookie', calls[0])
        client, _ = self.serve(status=409, raw=b'{"error":{"code":"stale_observation","message":"Bearer must-not-appear"}}')
        with self.assertRaises(ManagerError) as error:
            client.call('GET', '/v1/internal/test')
        self.assertEqual(error.exception.code, 'stale_observation')
        self.assertNotIn('must-not-appear', str(error.exception))

    def test_response_limit_and_duplicate_keys(self):
        for raw, expected in [(b'x' * 131073, 'response_limit'), (b'{"claim":null,"claim":{}}', 'duplicate_json_key')]:
            client, _ = self.serve(raw=raw)
            with self.assertRaises(ManagerError) as error:
                client.call('GET', '/v1/internal/test')
            self.assertEqual(error.exception.code, expected)

    def test_total_deadline_includes_dribbling_headers(self):
        client, _ = self.serve(slow=True)
        start = time.monotonic()
        with self.assertRaises(ManagerError):
            client.call('GET', '/v1/internal/test')
        self.assertLess(time.monotonic() - start, 1)

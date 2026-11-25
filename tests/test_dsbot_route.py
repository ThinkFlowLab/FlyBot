"""Manager publishes a running runtime to the platform gateway (fake Docker, fake client)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from flybot_workspace.manager import dsbot_route
from flybot_workspace.manager.safety import ManagerError

IID = '3' * 32
REF = 'a' * 32
STARTED_AT = '2026-11-24T04:30:00.123456789Z'
URL = 'http://172.30.5.9:8080/?token=' + 'T' * 43


class FakeRunner:
    def __init__(self, web_networks=()):
        self.calls = []
        self.web_networks = dict.fromkeys(web_networks, {})

    def run(self, args, heartbeat=lambda: None, timeout=10):
        self.calls.append(list(args))
        if args[:3] == ['inspect', '--type', 'container'] and args[3] == 'flybot-workspace-web-1':
            return json.dumps([{'Name': '/flybot-workspace-web-1', 'NetworkSettings': {'Networks': self.web_networks}}]), ''
        if args[:2] == ['network', 'connect']:
            self.web_networks[args[2]] = {}
            return '', ''
        raise AssertionError(args)


class FakeEngine:
    def __init__(self, root, runner, logs=URL, healthy=True, private_ip='172.30.5.9'):
        self.registry = SimpleNamespace(root=root, config={'dsbot_gateway': {'web_container': 'flybot-workspace-web-1'}})
        self.runner, self.logs, self.healthy = runner, logs, healthy
        self.private_ip = private_ip
        self.log_reads = 0
        self.logs_since = []
        self.inspections = 0

    def inspect(self, iid, heartbeat=lambda: None):
        self.inspections += 1
        return {'present': True, 'healthy': self.healthy, 'process_ref': REF if self.healthy else None,
                'private_ip': self.private_ip, 'started_at': STARTED_AT if self.healthy else None}

    def compose(self, iid, operation, heartbeat=lambda: None, tail=100, since=None):
        assert operation == 'logs'
        self.log_reads += 1
        self.logs_since.append(since)
        return f'dsh web ready\n{self.logs}\n', ''


class FakeClient:
    def __init__(self):
        self.reports = []

    def dsbot_upstream(self, iid, address, cookie, process_ref):
        self.reports.append((iid, address, cookie, process_ref))
        return True


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'secrets').mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def test_attaches_web_once_exchanges_and_reports_without_exposing_secrets(self):
        runner, client = FakeRunner(), FakeClient()
        engine = FakeEngine(self.root, runner)
        seen = []

        def exchange(url, address):
            seen.append((url, address))
            return f'dsh-auth-{address}=' + 'C' * 30
        result = dsbot_route.publish(engine, client, IID, exchange=exchange)
        self.assertEqual(result, {'status': 'published', 'instance_id': IID, 'address': '172.30.5.9:8080'})
        self.assertNotIn('C' * 30, json.dumps(result))
        self.assertEqual(seen, [(URL, '172.30.5.9:8080')])
        self.assertEqual(client.reports[0][:2], (IID, '172.30.5.9:8080'))
        self.assertEqual(client.reports[0][3], REF)
        self.assertEqual(engine.inspections, 1)
        self.assertIn(['network', 'connect', f'ot-{IID}_default', 'flybot-workspace-web-1'], runner.calls)
        cache = self.root / 'secrets' / f'dsbot-launch-{IID}.json'
        self.assertEqual(oct(os.stat(cache).st_mode & 0o777), '0o600')
        # Second pass: already attached, launch URL from the private cache (logs may have rotated).
        engine.logs = 'rotated'
        dsbot_route.publish(engine, client, IID, exchange=exchange)
        self.assertEqual(engine.log_reads, 1)
        self.assertEqual(engine.logs_since, [STARTED_AT])
        self.assertEqual(sum(1 for c in runner.calls if c[:2] == ['network', 'connect']), 1)

    def test_invalid_address_fails_before_connecting_the_web_container(self):
        for ip in (None, '127.0.0.1', '8.8.8.8'):
            with self.subTest(ip=ip):
                runner, client = FakeRunner(), FakeClient()
                with self.assertRaisesRegex(ManagerError, 'runtime_address'):
                    dsbot_route.publish(FakeEngine(self.root, runner, private_ip=ip), client, IID)
                self.assertEqual(runner.calls, [])
                self.assertEqual(client.reports, [])

    def test_new_process_needs_its_own_launch_url(self):
        runner, client = FakeRunner(), FakeClient()
        engine = FakeEngine(self.root, runner, logs='no url here')
        with self.assertRaises(ManagerError) as caught:
            dsbot_route.publish(engine, client, IID, exchange=lambda u, a: 'x')
        self.assertEqual(caught.exception.code, 'launch_url_missing')
        self.assertEqual(client.reports, [])

    def test_disabled_or_not_running(self):
        engine = FakeEngine(self.root, FakeRunner())
        engine.registry.config = {}
        self.assertEqual(dsbot_route.publish(engine, FakeClient(), IID)['status'], 'gateway_disabled')
        engine = FakeEngine(self.root, FakeRunner(), healthy=False)
        self.assertEqual(dsbot_route.publish(engine, FakeClient(), IID)['status'], 'not_running')

    def test_config_validation(self):
        for bad in ({'web_container': 'ot-evil'}, {'web_container': 'a b'}, {'web_container': 'w', 'x': 1}):
            engine = FakeEngine(self.root, FakeRunner())
            engine.registry.config = {'dsbot_gateway': bad}
            with self.assertRaises(ManagerError):
                dsbot_route.publish(engine, FakeClient(), IID)

    def test_exchange_failure_is_a_refusal(self):
        def boom(url, address):
            raise ValueError('no cookie')
        with self.assertRaises(ManagerError) as caught:
            dsbot_route.publish(FakeEngine(self.root, FakeRunner()), FakeClient(), IID, exchange=boom)
        self.assertEqual(caught.exception.code, 'dsh_exchange')
        self.assertIsNone(dsbot_route._cached_launch(SimpleNamespace(root=self.root), IID, REF))

    def test_refused_cached_url_refreshes_from_current_process(self):
        engine, client = FakeEngine(self.root, FakeRunner()), FakeClient()
        wrong = URL.replace('T' * 43, 'O' * 43)
        dsbot_route._store_launch(engine.registry, IID, REF, wrong)
        attempts = []

        def exchange(url, address):
            attempts.append(url)
            if url == wrong:
                raise ValueError('expired')
            return 'dsh-auth-test=' + 'C' * 30

        self.assertEqual(dsbot_route.publish(engine, client, IID, exchange=exchange)['status'], 'published')
        self.assertEqual(attempts, [wrong, URL])
        self.assertEqual(engine.logs_since, [STARTED_AT])
        self.assertEqual(len(client.reports), 1)
        self.assertEqual(dsbot_route._cached_launch(engine.registry, IID, REF), URL)


if __name__ == '__main__':
    unittest.main()

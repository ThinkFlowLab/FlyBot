"""Exercise pool allocation through ComposeEngine without a Docker daemon."""
from concurrent.futures import ThreadPoolExecutor
from ipaddress import ip_network
import json
from pathlib import Path
import tempfile
from threading import Event, Lock
import unittest
from unittest.mock import patch

from flybot_workspace.manager.engine import ComposeEngine, EngineFailure, Registry, compose_bytes
from flybot_workspace.manager.network import runtime_pool
from flybot_workspace.manager.safety import ManagerError, write_new


class NetworkRunner:
    def __init__(self):
        self.networks = {}
        self.compose_calls = []
        self.create_calls = []
        self.lock = Lock()
        self.creating = Event()
        self.peer_lookup = Event()
        self.watched_network = None
        self.release = Event()
        self.release.set()

    def add(self, name, subnet, project=None):
        key = f'{len(self.networks) + 1:064x}'
        self.networks[key] = {'Id': key, 'Name': name, 'Driver': 'bridge', 'Scope': 'local',
                              'Internal': False, 'IPAM': {'Config': [{'Subnet': subnet}]},
                              'Labels': {'com.docker.compose.project': project,
                                         'com.docker.compose.network': 'default'}}
        return key

    def run(self, args, *, heartbeat, timeout=10):
        heartbeat()
        if args[:2] == ['network', 'create']:
            self.creating.set()
            if not self.release.wait(5):
                raise AssertionError('network creation did not resume')
        with self.lock:
            if args[:2] == ['network', 'ls']:
                name = args[-1].removeprefix('name=^').removesuffix('$') if '--filter' in args else None
                if name is not None and name == self.watched_network:
                    self.peer_lookup.set()
                return '\n'.join(key for key, row in self.networks.items() if name is None or row['Name'] == name), ''
            if args[:3] == ['network', 'inspect', '--format']:
                return '\n'.join(json.dumps(self.networks[key]['IPAM']['Config']) for key in args[4:]), ''
            if args[:2] == ['network', 'inspect']:
                return json.dumps([self.networks[args[-1]]]), ''
            if args[:2] == ['network', 'create']:
                subnet = args[args.index('--subnet') + 1]
                if any(ip_network(subnet).overlaps(ip_network(row['IPAM']['Config'][0]['Subnet']))
                       for row in self.networks.values()):
                    raise AssertionError('attempted to reuse an allocated subnet')
                project = args[args.index('--label') + 1].split('=', 1)[1]
                assert args[args.index('--label') + 2:args.index('--label') + 4] == [
                    '--label', 'com.docker.compose.network=default']
                self.create_calls.append((args[-1], subnet))
                return self.add(args[-1], subnet, project), ''
            if args[0] == 'compose':
                self.compose_calls.append(args)
                return '', ''
            raise AssertionError('unexpected runner operation')


class RuntimeNetworkPoolTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.iid, self.peer = '1' * 32, '2' * 32
        self.runner = NetworkRunner()
        self.entry = {'image': 'operator/runtime@sha256:' + 'a' * 64, 'healthcheck': None, 'publish_port': None}

    def registry(self, pool=None):
        config = {'version': 1, 'execution_enabled': True, 'base_url': 'http://127.0.0.1:8000',
                  'server_host': 'flybot-workspace.test', 'manager_id': 'manager-test', 'token': 'local-only',
                  'docker': '/usr/bin/docker', 'socket': '/run/docker.sock',
                  'instances': {iid: self.entry.copy() for iid in (self.iid, self.peer)}}
        if pool is not None:
            config['runtime_ipv4_pool'] = pool
        path = self.root / 'manager.json'
        write_new(path, config)
        return Registry(str(path))

    def test_accepts_only_a_canonical_rfc1918_cidr_with_room_for_a_bridge(self):
        self.assertEqual(str(runtime_pool('10.12.224.0/20')), '10.12.224.0/20')
        for value in ('10.0.0.1/16', '10.0.0.0/8', '10.0.0.0/29', '127.0.0.0/20',
                      '169.254.0.0/20', '8.8.8.0/24', 'fd00::/112', 1, None):
            with self.subTest(value=value), self.assertRaisesRegex(ManagerError, 'runtime_network_pool'):
                runtime_pool(value)

    def test_two_owners_get_distinct_project_bridges_without_changing_manifests(self):
        registry = self.registry('10.12.224.0/27')
        engine = ComposeEngine(registry, self.runner)
        project_a, project_b = 'ot-' + self.iid, 'ot-' + self.peer
        original = {iid: registry.entry(iid)[1].read_bytes() for iid in (self.iid, self.peer)}
        self.runner.release.clear()
        self.runner.watched_network = project_b + '_default'
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(engine.compose, self.iid, 'start')
            try:
                self.assertTrue(self.runner.creating.wait(2))
                second = pool.submit(engine.compose, self.peer, 'start')
                self.assertTrue(self.runner.peer_lookup.wait(2))
                self.assertFalse(second.done())
            finally:
                self.runner.release.set()
            first.result(timeout=5)
            second.result(timeout=5)
        self.assertEqual(self.runner.create_calls, [(project_a + '_default', '10.12.224.0/28'),
                                                   (project_b + '_default', '10.12.224.16/28')])
        self.assertEqual({row['Labels']['com.docker.compose.project'] for row in self.runner.networks.values()},
                         {project_a, project_b})
        self.assertEqual(len(self.runner.compose_calls), 2)
        for iid in (self.iid, self.peer):
            path = registry.entry(iid)[1]
            self.assertEqual(path.read_bytes(), original[iid])
            self.assertNotIn('networks', json.loads(path.read_bytes()))

    def test_an_old_owned_bridge_is_reused_even_outside_the_new_pool(self):
        registry = self.registry('10.12.224.0/28')
        engine = ComposeEngine(registry, self.runner)
        project = 'ot-' + self.iid
        held = self.runner.add(project + '_default', '172.24.0.0/16', project)
        original = json.dumps(self.runner.networks[held])
        document = registry.entry(self.iid)[1]
        previous = document.read_bytes()
        engine.compose(self.iid, 'start')
        self.assertEqual(self.runner.create_calls, [])
        self.assertEqual(json.dumps(self.runner.networks[held]), original)
        self.assertEqual(previous, document.read_bytes())
        self.assertEqual(previous, compose_bytes(json.loads(previous)))
        self.assertEqual(len(self.runner.compose_calls), 1)

    def test_foreign_named_bridge_and_full_pool_fail_before_compose(self):
        registry = self.registry('10.12.224.0/28')
        engine = ComposeEngine(registry, self.runner)
        self.runner.add('ot-' + self.iid + '_default', '172.24.0.0/16', 'ot-' + self.peer)
        self.runner.add('other-project', '10.12.224.0/24', 'other-project')
        existing = json.dumps(self.runner.networks)
        with self.assertRaisesRegex(ManagerError, 'runtime_network_owner'):
            engine.compose(self.iid, 'start')
        with self.assertRaisesRegex(ManagerError, 'runtime_network_capacity'):
            engine.compose(self.peer, 'start')
        self.assertEqual(self.runner.create_calls, [])
        self.assertEqual(self.runner.compose_calls, [])
        self.assertEqual(json.dumps(self.runner.networks), existing)

    def test_docker_overlap_failure_does_not_run_compose_or_remove_any_bridge(self):
        registry = self.registry('10.12.224.0/28')
        engine = ComposeEngine(registry, self.runner)
        run = self.runner.run
        called = []

        def concurrent_external_allocation(args, **options):
            called.append(args[:2])
            if args[:2] == ['network', 'create']:
                raise EngineFailure(1, '', 'Pool overlaps with other one on this address space')
            return run(args, **options)

        with patch.object(self.runner, 'run', side_effect=concurrent_external_allocation):
            with self.assertRaises(EngineFailure):
                engine.compose(self.iid, 'start')
        self.assertEqual(called[-1], ['network', 'create'])
        self.assertEqual(self.runner.compose_calls, [])

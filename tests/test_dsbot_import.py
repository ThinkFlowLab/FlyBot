"""Manager job that writes per-user import bundles and the runtime seal key."""
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flybot_workspace.manager import dsbot_import
from flybot_workspace.manager.safety import ManagerError


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.running = True
        self.files = set()
        self.unreadable = set()
        self.received = {}

    def run(self, args, heartbeat=lambda: None, timeout=10, stdin=None):
        self.calls.append(args)
        if args[:3] == ['inspect', '-f', '{{.State.Running}}']:
            return ('true\n' if self.running else 'false\n'), ''
        if 'check-delivery' in args:
            marker, bundle = args[-2:]
            if marker in self.files and bundle not in self.unreadable:
                return '', ''
            raise ManagerError('exec_failed')
        if args[:4] == ['exec', '-i', '-u', '1000:1000'] and args[-4] == 'receive-bundle':
            filename, checksum, marker = args[-3:]
            raw = stdin.read()
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise ManagerError('exec_failed')
            dest = f'/data/flybot-workspace/import/{filename}'
            self.files.add(dest)
            self.unreadable.discard(dest)
            self.received[filename] = json.loads(raw)
            self.files.add(f'/data/flybot-workspace/import/{marker}')
            return '', ''
        raise ManagerError('unexpected')


class FakeEngine:
    def __init__(self, root):
        self.registry = mock.Mock()
        self.registry.root = Path(root)
        self.registry.entry = mock.Mock()
        self.runner = FakeRunner()
        self._key = b'\x11' * 32
        self.seal = Path(root) / 'secrets' / 'seal-x.key'

    def seal_key_path(self, iid):
        return self.seal

    def install_seal_key(self, iid):
        self.seal.parent.mkdir(parents=True, exist_ok=True)
        self.seal.write_bytes(self._key)
        return self.seal, self._key


class FakeClient:
    def __init__(self):
        self.seen = None

    def dsbot_import(self, iid, seal_key_hex):
        self.seen = (iid, seal_key_hex)
        from flybot_workspace.manager.dsbot_import import FEATURES
        return {'owner_imported': True, 'features': [
            {'name': name, 'bundle': {'format': 'flybot-workspace-dsbot-import', 'feature': name, 'tables': {}, 'manifest': {}}}
            for name in FEATURES
        ]}


class ImportJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_writes_bundles_once_and_reuses_the_seal_key(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'imported')
        self.assertEqual(client.seen[1], '11' * 32)
        self.assertEqual(engine.runner.received['settings-v1.bundle']['feature'], 'settings')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertIn('automations-v1.bundle', first['features'])
        self.assertIn('agents-v1.bundle', first['features'])
        self.assertIn('artifacts-v1.bundle', first['features'])
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))

    def test_redelivers_unreadable_bundles_with_legacy_markers(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        dsbot_import.deliver(engine, client, iid)
        bundle = '/data/flybot-workspace/import/agents-v1.bundle'
        engine.runner.unreadable.add(bundle)
        engine.runner.files.remove('/data/flybot-workspace/import/automations-v1.bundle')
        engine.runner.calls.clear()
        retry = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(retry['features'], ['agents-v1.bundle'])
        self.assertNotIn(bundle, engine.runner.unreadable)
        self.assertEqual(dsbot_import.deliver(engine, client, iid)['status'], 'already-imported')

    def test_skips_a_historical_runtime_without_writing_a_bundle(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        with mock.patch.object(client, 'dsbot_import', side_effect=ManagerError('import_destination')):
            result = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(result['status'], 'import_skipped')
        self.assertEqual(engine.runner.received, {})

    def test_refuses_when_the_runtime_is_down(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.running = False
        with self.assertRaises(ManagerError) as caught:
            dsbot_import.deliver(engine, client, '1' * 32)
        self.assertEqual(caught.exception.code, 'instance_not_running')
        self.assertIsNone(client.seen)

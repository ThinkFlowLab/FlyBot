"""B4 per-user DS-Bot import bundles: settings, model-api and connectors."""
import json
from pathlib import Path
import tempfile
import unittest

from flybot_workspace import composio, custom_mcp, dsbot_bundle, model_api
from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN

SEAL = bytes(range(32))  # test-only runtime seal key


class B4BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        for name, peer in (('alice', '127.0.0.1'), ('bob', '127.0.0.2')):
            Client(self.app, peer=peer).register(name)
        with self.store.connect() as db:
            self.alice = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            self.bob = db.execute("SELECT id FROM users WHERE username='bob'").fetchone()[0]
            for uid, tag in ((self.alice, 'a'), (self.bob, 'b')):
                db.execute('INSERT INTO user_settings (user_id, document, revision, updated) VALUES (?,?,?,?)',
                           (uid, json.dumps({'language': 'zh-CN'}), 2, 5))
                db.execute("INSERT INTO model_api_configs (id, scope, account_id, provider, base_url, model, key_blob, revision, updated) "
                           "VALUES (?, 'account', ?, 'openai', 'https://api.example/v1', 'm', ?, 1, 5)",
                           (tag * 32, uid, model_api.wrap(model_api.wrapping_key(self.store), 'sk-test-' + tag * 8)))
                db.execute('INSERT INTO composio_keys (user_id, key_blob, key_hint, revision, updated) VALUES (?,?,?,1,5)',
                           (uid, model_api.wrap(model_api.wrapping_key(self.store, composio.WRAP_NAME), 'ak_test_' + tag * 8), '••••' + tag * 4))
                db.execute('INSERT INTO custom_mcp_servers (id, user_id, name, origin, config_blob, revision, created, updated) VALUES (?,?,?,?,?,1,5,5)',
                           (tag * 31 + '0', uid, 'Docs', 'https://mcp.example.com',
                            model_api.wrap(model_api.wrapping_key(self.store, custom_mcp.WRAP),
                                           json.dumps({'url': 'https://mcp.example.com/mcp', 'bearer_token': 'tok-' + tag}))))

    def test_tables_never_carry_secret_columns(self):
        with self.store.connect() as db:
            for feature in ('settings', 'model-api', 'connectors'):
                bundle = dsbot_bundle.build(db, self.alice, feature, now=1)
                text = dsbot_bundle.dumps(bundle)
                self.assertNotIn('key_blob', text)
                self.assertNotIn('config_blob', text)
                self.assertNotIn('sk-test', text)
                self.assertNotIn(self.bob, text)
            rows = json.loads(dsbot_bundle.build(db, self.alice, 'model-api', now=1)['tables']['model_api_configs'])
            self.assertEqual(rows[0]['key_set'], 1)
            ref = json.loads(dsbot_bundle.build(db, self.alice, 'connectors', now=1)['tables']['composio_user'])
            self.assertEqual(ref, [{'user_ref': 'flybot-workspace-' + self.alice}])

    def test_secrets_are_rewrapped_for_the_runtime_and_scoped_to_one_user(self):
        with self.store.connect() as db:
            bundle = dsbot_bundle.build_with_secrets(db, self.store, self.alice, 'connectors', SEAL, now=1)
            plain = {k: model_api.unwrap(SEAL, v) for k, v in bundle['secrets'].items()}
            self.assertEqual(plain['composio_key'], 'ak_test_' + 'a' * 8)
            self.assertEqual(json.loads(plain['mcp:' + 'a' * 31 + '0'])['bearer_token'], 'tok-a')
            self.assertEqual(len(plain), 2)
            m = dsbot_bundle.build_with_secrets(db, self.store, self.alice, 'model-api', SEAL, now=1)
            self.assertEqual(model_api.unwrap(SEAL, m['secrets']['model_api_key']), 'sk-test-' + 'a' * 8)
            self.assertNotIn('secrets', dsbot_bundle.build_with_secrets(db, self.store, self.alice, 'settings', SEAL, now=1))
            with self.assertRaises(ValueError):
                dsbot_bundle.sealed_secrets(db, self.store, self.alice, 'connectors', b'short')


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "retire-runtime-credentials.py"
SPEC = importlib.util.spec_from_file_location("retire_runtime_credentials", SCRIPT)
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)

INSTANCE = "a" * 32
SECOND = "b" * 32


class RetireCredentialsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.database = root / "management.sqlite3"
        self.secrets = root / "secrets"
        self.secrets.mkdir()
        self.wrap = root / "instance-runtime.wrap"
        self.wrap.write_bytes(b"x" * 32)
        self.wrap.chmod(0o600)
        self.bundle = {"feature": "agents", "instance_id": INSTANCE, "tables": {"personal_agents": "用户绑定"}}
        self.mounted = self.write_key(INSTANCE, self.bundle)
        self.empty = self.write_key(SECOND)
        with sqlite3.connect(self.database) as db:
            db.executescript("""
                CREATE TABLE runtime_keys (id TEXT PRIMARY KEY, revoked INTEGER);
                CREATE TABLE instance_runtime_keys (key_id TEXT, token_blob TEXT);
                INSERT INTO runtime_keys VALUES ('instance-a', 0), ('instance-b', 1), ('unrelated', 0);
                INSERT INTO instance_runtime_keys VALUES ('instance-a', 'sealed-a'), ('instance-b', 'sealed-b');
            """)

    def write_key(self, instance, bootstrap=None):
        path = self.secrets / f"runtime-key-{instance}.json"
        doc = {"origin": "https://fixture.invalid", "token": "old-test-token", "hostname": "old-worker"}
        if bootstrap is not None:
            doc["agent_bootstrap"] = bootstrap
        path.write_text(json.dumps(doc))
        path.chmod(0o640)
        return path

    def test_revokes_only_issued_credentials_and_preserves_mount_and_bootstrap(self):
        before = migration.retirement(self.database, self.secrets)
        self.assertEqual(before, {"files_with_credentials": 2, "bootstrap_bundles": 1,
                                  "unrevoked_issued_keys": 1, "wrapped_credentials": 2, "wrapping_key_present": True})
        self.assertIn("token", json.loads(self.mounted.read_text()))
        self.assertEqual(migration.retirement(self.database, self.secrets, apply=True), before)
        self.assertEqual(json.loads(self.mounted.read_text()), {"agent_bootstrap": self.bundle})
        self.assertEqual(stat.S_IMODE(self.mounted.stat().st_mode), 0o640)
        self.assertEqual(self.empty.read_bytes(), b"")
        self.assertFalse(self.wrap.exists())
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT * FROM runtime_keys ORDER BY id").fetchall(),
                             [("instance-a", 1), ("instance-b", 1), ("unrelated", 0)])
            self.assertEqual(db.execute("SELECT * FROM instance_runtime_keys ORDER BY key_id").fetchall(),
                             [("instance-a", ""), ("instance-b", "")])
        after = {"files_with_credentials": 0, "bootstrap_bundles": 1,
                 "unrevoked_issued_keys": 0, "wrapped_credentials": 0, "wrapping_key_present": False}
        self.assertEqual(migration.retirement(self.database, self.secrets, apply=True), after)

    def test_checks_all_files_before_revoking_or_rewriting(self):
        self.write_key(SECOND, self.bundle)
        with self.assertRaises(ValueError):
            migration.retirement(self.database, self.secrets, apply=True)
        self.assertIn("token", json.loads(self.mounted.read_text()))
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT revoked FROM runtime_keys WHERE id='instance-a'").fetchone(), (0,))

    def test_does_not_follow_symlinks(self):
        self.empty.unlink()
        self.empty.symlink_to(self.mounted)
        with self.assertRaises(OSError):
            migration.retirement(self.database, self.secrets, apply=True)
        self.assertTrue(self.empty.is_symlink())
        self.assertIn("token", json.loads(self.mounted.read_text()))

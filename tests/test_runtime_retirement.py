"""Archived Compose instances retain their evidence without executable grants."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from flybot_workspace.lifecycle import Lifecycle, ManagerIdentity, RuntimeFault, RuntimePolicy, SCHEMA
from flybot_workspace.lifecycle import ensure_retirement_schema, retire_instance
from flybot_workspace.runtime_autoprovision import owned_instance
from flybot_workspace.security import digest
from flybot_workspace.store import Store


ALICE, BOB = 'a' * 32, 'b' * 32
ALICE_HOME, BOB_HOME = 'c' * 32, 'd' * 32
DUPLICATE, CANONICAL, OTHER = '1' * 32, '2' * 32, '3' * 32
RETIRED_JOB = '4' * 32
IMAGE = 'example/runtime@sha256:' + 'e' * 64


def add_instance(db, iid, workspace, owner):
    db.execute("""INSERT INTO instances
        (id, workspace_id, owner_id, profile, backend_mode, image_ref, volume_ref, desired, revision, operation_id,
         operation_type, observed, observed_revision, create_key, created)
        VALUES (?,?,?,'local-compose','compose',?,?,'stopped',1,?,'create','stopped',1,?,1)""",
        (iid, workspace, owner, IMAGE, 'ot-' + iid, iid, digest(iid)))


class RetiredRuntimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name).resolve() / 'state')
        with self.store.connect() as db:
            # An old schema can contain historical duplicate assignments.
            db.executescript(SCHEMA.replace('retired_at INTEGER, retired_to TEXT REFERENCES instances(id), ', ''))
        with self.store.transaction() as db:
            for uid, wid, name in [(ALICE, ALICE_HOME, 'alice'), (BOB, BOB_HOME, 'bob')]:
                db.execute('INSERT INTO users VALUES(?,?,?,1)', (uid, name, 'unused'))
                db.execute('INSERT INTO workspaces VALUES(?,?,?,1,?,?)', (wid, uid, name, digest(wid), digest(wid)))
            add_instance(db, DUPLICATE, ALICE_HOME, ALICE)
            add_instance(db, CANONICAL, ALICE_HOME, ALICE)
            db.execute("""INSERT INTO runtime_jobs
                (id, instance_id, revision, operation_id, operation_type, status, created, finished)
                VALUES (?,?,1,?,'create','succeeded',1,2)""", (RETIRED_JOB, DUPLICATE, DUPLICATE))
        self.runtime = Lifecycle(self.store, RuntimePolicy(image_ref=IMAGE, backend_mode='compose', max_instances=2))
        self.manager = ManagerIdentity('manager-a', '0' * 64, frozenset({DUPLICATE, CANONICAL}), 'compose')

    def test_archive_preserves_history_and_removes_operational_access(self):
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM instances').fetchone()[0], 2)
            db.execute('INSERT INTO runtime_auto_provisions VALUES (?,?,?,?,?,?)',
                       (ALICE, ALICE_HOME, 'f' * 32, CANONICAL, self.manager.id, 1))
            self.assertTrue(retire_instance(db, DUPLICATE, CANONICAL, 3))
            ensure_retirement_schema(db)
            self.assertFalse(retire_instance(db, DUPLICATE, CANONICAL, 4))
            row = db.execute('SELECT retired_at, retired_to, volume_ref FROM instances WHERE id=?', (DUPLICATE,)).fetchone()
            self.assertEqual(tuple(row), (3, CANONICAL, 'ot-' + DUPLICATE))
            self.assertEqual(db.execute('SELECT status FROM runtime_jobs WHERE id=?', (RETIRED_JOB,)).fetchone()[0], 'succeeded')
            self.assertEqual(owned_instance(db, ALICE), CANONICAL)
            self.assertFalse(self.runtime.grants(db, self.manager, DUPLICATE))
        self.assertEqual([item['id'] for item in self.runtime.listing(ALICE, ALICE_HOME)['items']], [CANONICAL])
        self.assertEqual([item['id'] for item in self.runtime.manager_list(self.manager)['items']], [CANONICAL])
        for operation in (
            lambda: self.runtime.inspect(ALICE, DUPLICATE),
            lambda: self.runtime.start(ALICE, DUPLICATE),
            lambda: self.runtime.logs(ALICE, DUPLICATE),
            lambda: self.runtime.get_job(ALICE, RETIRED_JOB),
            lambda: self.runtime.claim(self.manager, DUPLICATE),
            lambda: self.runtime.heartbeat(self.manager, DUPLICATE, RETIRED_JOB, 1, 'x' * 43),
            lambda: self.runtime.recover(self.manager, DUPLICATE, 1, 'operation-recover', 'quiesced-executors'),
        ):
            with self.subTest(operation=operation), self.assertRaises(RuntimeFault) as error:
                operation()
            self.assertEqual(error.exception.status, 404)
        self.assertTrue(self.runtime.create(BOB, BOB_HOME, 'new-bob-instance')[0])

    def test_new_duplicate_insert_and_revival_are_rejected(self):
        with self.store.transaction() as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'active Compose runtime'):
                add_instance(db, OTHER, ALICE_HOME, ALICE)
            self.assertTrue(retire_instance(db, DUPLICATE, CANONICAL, 3))
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'active Compose runtime'):
                db.execute('UPDATE instances SET retired_at=NULL, retired_to=NULL WHERE id=?', (DUPLICATE,))
            add_instance(db, OTHER, BOB_HOME, BOB)
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'active Compose runtime'):
                db.execute('UPDATE instances SET owner_id=? WHERE id=?', (ALICE, OTHER))

    def test_archives_require_a_same_owner_target_and_finished_manager_work(self):
        with self.store.transaction() as db:
            add_instance(db, OTHER, BOB_HOME, BOB)
            with self.assertRaisesRegex(ValueError, 'same owner'):
                retire_instance(db, DUPLICATE, OTHER, 3)
            db.execute('INSERT INTO runtime_auto_provisions VALUES (?,?,?,?,?,?)',
                       (ALICE, ALICE_HOME, 'f' * 32, CANONICAL, self.manager.id, 1))
            with self.assertRaisesRegex(ValueError, 'provisioned runtime'):
                retire_instance(db, CANONICAL, DUPLICATE, 3)
            db.execute('UPDATE instances SET observed_revision=NULL WHERE id=?', (DUPLICATE,))
            with self.assertRaisesRegex(ValueError, 'stopped and converged'):
                retire_instance(db, DUPLICATE, CANONICAL, 3)
            db.execute('UPDATE instances SET observed_revision=revision WHERE id=?', (DUPLICATE,))
            db.execute("UPDATE runtime_jobs SET status='queued' WHERE id=?", (RETIRED_JOB,))
            with self.assertRaisesRegex(ValueError, 'pending manager job'):
                retire_instance(db, DUPLICATE, CANONICAL, 3)
            self.assertIsNone(db.execute('SELECT retired_at FROM instances WHERE id=?', (DUPLICATE,)).fetchone()[0])

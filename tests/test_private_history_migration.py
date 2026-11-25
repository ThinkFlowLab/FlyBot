from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

script = Path(__file__).resolve().parents[1] / 'scripts' / 'plan-private-history-migration.py'
spec = spec_from_file_location('plan_private_history', script)
migration = module_from_spec(spec)
spec.loader.exec_module(migration)

SOURCE, TARGET = '1' * 32, '2' * 32
OWNER, WORKSPACE, AGENT, HISTORIC = (c * 32 for c in '3456')
PRESENT, MISSING = '7' * 32, '8' * 32
PRESENT_MESSAGE, MISSING_MESSAGE = '9' * 32, 'a' * 32


class PrivateHistoryPlanTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        self.management, self.old, self.target = root / 'management.db', root / 'old', root / 'target'
        with sqlite3.connect(self.management) as db:
            db.executescript('''
                CREATE TABLE instances(id TEXT, owner_id TEXT, volume_ref TEXT);
                CREATE TABLE runtime_auto_provisions(user_id TEXT, instance_id TEXT, workspace_id TEXT, agent_id TEXT);
            ''')
            db.executemany('INSERT INTO instances VALUES(?,?,?)',
                           [(iid, OWNER, 'ot-' + iid) for iid in (SOURCE, TARGET)])
            db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?)', (OWNER, TARGET, WORKSPACE, AGENT))
        for volume, iid in ((self.old, SOURCE), (self.target, TARGET)):
            (volume / 'flybot-workspace' / 'features' / 'agents').mkdir(parents=True)
            (volume / 'flybot-workspace' / 'instance.json').write_text(json.dumps({'instance_id': iid}))
            with sqlite3.connect(volume / 'flybot-workspace' / 'features' / 'agents' / 'agents.sqlite3') as db:
                db.executescript('''
                    CREATE TABLE native_personal_binding(singleton INTEGER,workspace_id TEXT,agent_id TEXT);
                    CREATE TABLE agents(id TEXT,workspace_id TEXT,archived INTEGER);
                    CREATE TABLE agent_conversations(id TEXT,agent_id TEXT);
                    CREATE TABLE agent_messages(id TEXT,conversation_id TEXT,role TEXT,text TEXT,created INTEGER);
                ''')
                db.execute('INSERT INTO agent_conversations VALUES(?,?)', (PRESENT, HISTORIC))
                if volume == self.target:
                    db.execute('INSERT INTO native_personal_binding VALUES(1,?,?)', (WORKSPACE, AGENT))
                    db.execute('INSERT INTO agents VALUES(?,?,0)', (AGENT, WORKSPACE))
                    db.execute('INSERT INTO agent_messages VALUES(?,?,?,?,?)', (PRESENT_MESSAGE, PRESENT, 'user', '保留这一条', 1700000000))
        chat = self.old / 'flybot-workspace' / 'features' / 'chat'
        chat.mkdir()
        with sqlite3.connect(chat / 'chat.sqlite3') as db:
            db.executescript('''
                CREATE TABLE chat_state(key TEXT,value TEXT);
                CREATE TABLE conversations(id TEXT,title TEXT,created INTEGER,updated INTEGER);
                CREATE TABLE messages(id TEXT,conversation_id TEXT,role TEXT,text TEXT,created INTEGER,meta TEXT);
            ''')
            db.executemany('INSERT INTO conversations VALUES(?,?,?,?)',
                           [(cid, '会话', 1700000000111, 1700000000111) for cid in (PRESENT, MISSING)])
            db.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?)', [
                (PRESENT_MESSAGE, PRESENT, 'user', '保留这一条', 1700000000111, '{}'),
                (MISSING_MESSAGE, MISSING, 'assistant', '补齐这一条', 1700000000111, '{"legacy":true}'),
            ])

    def plan(self):
        return migration.plan(self.management, self.old, self.target, SOURCE, TARGET)

    def test_preserves_ownership_and_original_time_and_only_exports_missing(self):
        payload, counts = self.plan()
        self.assertEqual(counts, {'missing_conversations': 1, 'missing_messages': 1,
                                  'existing_conversations': 1, 'existing_messages': 1,
                                  'existing_on_historical_agents': 1})
        self.assertEqual(payload['id'], AGENT)
        self.assertEqual([c['id'] for c in payload['conversations']], [MISSING])
        message = payload['conversations'][0]['messages'][0]
        self.assertEqual((message['id'], message['created'], message['meta']),
                         (MISSING_MESSAGE, 1700000000111, {'legacy': True}))

    def test_refuses_an_overlapping_message_with_a_different_payload(self):
        with sqlite3.connect(self.target / 'flybot-workspace' / 'features' / 'agents' / 'agents.sqlite3') as db:
            db.execute("UPDATE agent_messages SET text='另一个内容'")
        with self.assertRaisesRegex(ValueError, 'differing message'):
            self.plan()

    def test_refuses_runtimes_with_different_owners(self):
        with sqlite3.connect(self.management) as db:
            db.execute('UPDATE instances SET owner_id=? WHERE id=?', ('b' * 32, SOURCE))
        with self.assertRaisesRegex(ValueError, 'same account'):
            self.plan()

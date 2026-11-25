"""Per-user Personal Agent and built-in roster (issue #130). In-process WSGI only."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from flybot_workspace.agents import name_hash
from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, seed_legacy_workspace


class PersonalAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def test_ensure_creates_personal_space_agent_and_roster_once(self):
        before = self.alice.call('GET', '/v1/personal-agent')
        self.assertEqual(before['status'], 200)
        self.assertIsNone(before['body']['personal_agent'])
        created = self.alice.call('POST', '/v1/personal-agent')
        self.assertEqual(created['status'], 201, created)
        personal = created['body']['personal_agent']
        self.assertEqual(personal['workspace']['name'], '个人空间')
        self.assertEqual(personal['workspace']['kind'], 'personal')
        self.assertEqual(personal['agent']['name'], "alice's Personal Agent")
        self.assertEqual(personal['agent']['summary'], 'Your Cross-context Super AI Agent.')
        self.assertEqual(len(created['body']['builtin_agents']), 10)
        names = [item['agent']['name'] for item in created['body']['builtin_agents']]
        self.assertIn('FlyBot Assistant', names)
        self.assertIn('Travel Planner', names)
        self.assertIn('Webpage Developer', names)
        again = self.alice.call('POST', '/v1/personal-agent')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['personal_agent']['workspace']['id'],
                         personal['workspace']['id'])
        self.assertEqual(again['body']['personal_agent']['agent']['id'],
                         personal['agent']['id'])
        self.assertEqual(again['body']['builtin_agents'], created['body']['builtin_agents'])
        workspace_id = personal['workspace']['id']
        agent_id = personal['agent']['id']
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT id, name FROM workspaces').fetchall(),
                             [(workspace_id, '个人空间')])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM workspace_agents').fetchone()[0], 11)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM builtin_agents').fetchone()[0], 10)
            conversations = db.execute(
                'SELECT id, title FROM agent_conversations WHERE workspace_id=? AND agent_id=?',
                (workspace_id, agent_id),
            ).fetchall()
            self.assertEqual(len(conversations), 1)
            conversation_id, title = conversations[0]
            self.assertEqual(title, 'Personal Agent')
            messages = db.execute(
                'SELECT body, role, status FROM agent_messages WHERE conversation_id=? ORDER BY seq',
                (conversation_id,),
            ).fetchall()
            self.assertEqual(messages, [('你们已经是好友了，可以开始聊天啦！', 'assistant', 'succeeded')])

        history = self.alice.call(
            'GET', f'/v1/workspaces/{workspace_id}/agents/{agent_id}/conversations/{conversation_id}')
        self.assertEqual(history['status'], 410)
        self.assertEqual(history['body']['error']['code'], 'moved_to_dsbot')

    def test_existing_builtin_assistant_is_rebranded_without_recreating_it(self):
        created = self.alice.call('POST', '/v1/personal-agent')['body']
        builtin = next(item for item in created['builtin_agents'] if item['key'] == 'flybot-assistant')
        old = builtin['agent']
        with self.app.store.transaction() as db:
            db.execute('UPDATE builtin_agents SET builtin_key=? WHERE agent_id=?',
                       ('teamily-agent', old['id']))
            db.execute('UPDATE workspace_agents SET name=?, name_hash=?, summary=?, instructions=? WHERE id=?',
                       ('Teamily Agent', name_hash('Teamily Agent'), 'Teamily 平台助手',
                        'Personalized instructions', old['id']))
        self.app.store = Store(self.path)
        restored = self.alice.call('GET', '/v1/personal-agent')['body']
        updated = next(item for item in restored['builtin_agents'] if item['key'] == 'flybot-assistant')
        self.assertEqual(updated['agent']['id'], old['id'])
        self.assertEqual(updated['agent']['name'], 'FlyBot Assistant')
        self.assertEqual(updated['agent']['summary'], 'FlyBot 平台助手')
        self.assertEqual(updated['agent']['instructions'], 'Personalized instructions')
        self.assertEqual(len(restored['builtin_agents']), 10)
        self.app.store = Store(self.path)
        self.assertEqual(self.alice.call('GET', '/v1/personal-agent')['body'], restored)

    def test_personal_look_is_exposed_only_to_its_owner(self):
        look = {'color': '天空蓝', 'expression': '微笑', 'headwear': '耳机',
                'glasses': '无', 'hand': '咖啡杯'}
        alice = self.alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertIsNone(alice['look'])
        owner_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        # Preserve a look saved before onboarding moved to the DS-Bot container.
        with self.app.store.transaction() as db:
            db.execute(
                'INSERT INTO user_onboarding_steps(user_id, picks, look, updated) VALUES(?,?,?,?)',
                (owner_id, '[]', json.dumps(look), int(self.app.clock())),
            )
        moved = self.alice.call('POST', '/v1/onboarding/look', {'look': {**look, 'color': '薄荷绿'}})
        self.assertEqual(moved['status'], 410)
        self.assertEqual(moved['body']['error']['code'], 'moved_to_dsbot')
        got = self.alice.call('GET', '/v1/personal-agent')['body']['personal_agent']
        self.assertEqual(got['look'], look)
        self.assertEqual(got['agent']['id'], alice['agent']['id'])
        bob = self.bob.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertIsNone(bob['look'])
        self.assertNotEqual(bob['agent']['id'], alice['agent']['id'])

    def test_personal_space_is_isolated_per_user(self):
        alice = self.alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertIsNone(self.bob.call('GET', '/v1/personal-agent')['body']['personal_agent'])
        bob_payload = self.bob.call('POST', '/v1/personal-agent')['body']
        bob = bob_payload['personal_agent']
        self.assertNotEqual(alice['workspace']['id'], bob['workspace']['id'])
        self.assertNotEqual(alice['agent']['id'], bob['agent']['id'])
        self.assertEqual(bob['agent']['name'], "bob's Personal Agent")
        self.assertTrue(all(entry['agent']['workspace_id'] == bob['workspace']['id']
                            for entry in bob_payload['builtin_agents']))
        payload = self.bob.call('GET', '/v1/personal-agent')['body']
        self.assertEqual(payload['personal_agent'], bob)
        self.assertNotIn(alice['workspace']['id'], json.dumps(payload))
        self.assertNotIn(alice['agent']['id'], json.dumps(payload))

    def test_workspace_quota_and_csrf(self):
        limited = App(Store(Path(self.temp.name) / 'limited'), Config(ORIGIN, allow_registration=True,
                                                                    max_workspaces_per_user=1),
                      clock=lambda: 1800000000)
        alice = Client(limited)
        alice.register('alice')
        seed_legacy_workspace(alice)
        self.assertEqual(alice.call('POST', '/v1/personal-agent')['status'], 429)
        fresh = App(Store(Path(self.temp.name) / 'csrf'), Config(ORIGIN, allow_registration=True),
                    clock=lambda: 1800000000)
        client = Client(fresh)
        client.register('alice')
        self.assertEqual(client.call('POST', '/v1/personal-agent', csrf=False)['status'], 403)


if __name__ == '__main__':
    unittest.main()

"""Keep imported task results without restoring a management-plane executor."""
import json
from pathlib import Path
import tempfile
import unittest

from flybot_workspace import dsbot_bundle
from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class RetiredTaskPlaneTests(unittest.TestCase):
    def test_archived_task_result_remains_importable_but_cannot_be_claimed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory).resolve() / 'state'
            store = Store(state)
            owner, workspace, connection, conversation, task = (
                char * 32 for char in 'abcde'
            )
            with store.transaction() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,1)', (owner, 'alice', 'unused'))
                db.execute('INSERT INTO workspaces VALUES(?,?,?,1,?,?)',
                           (workspace, owner, 'Alice', 'workspace-key', 'request-key'))
                db.execute("INSERT INTO runtime_keys VALUES('old-key',?,'Old runtime','hash','prefix',1,NULL,1)", (owner,))
                db.execute("INSERT INTO runtime_connections VALUES(?,?,'old-key','old-host',1,1)", (connection, owner))
                db.execute("INSERT INTO runtime_tasks VALUES(?,?,?,'infer','historic prompt','succeeded',?,1,2)",
                           (task, owner, connection, json.dumps({'text': 'Archived result'})))
                db.execute("INSERT INTO skill_runs VALUES(?,?,'account','web-summary','skill-key','skill-request',1)",
                           (task, owner))
                db.execute("INSERT INTO skill_task_material VALUES(?,'{}',1)", (task,))
                stranger = 'f' * 32
                db.execute('INSERT INTO users VALUES(?,?,?,1)', (stranger, 'bob', 'unused'))
                db.execute("INSERT INTO runtime_tasks VALUES(?,?,?,'infer','foreign runtime task','succeeded',?,1,2)",
                           ('0' * 32, stranger, connection, json.dumps({'text': 'Never import'})))
                db.execute("INSERT INTO skill_runs VALUES(?,?,'account','web-summary','wrong-owner','foreign',1)",
                           ('0' * 32, owner))
                db.execute("INSERT INTO social_conversations VALUES(?,?,'group','Group',NULL,1,1,'group-key','group-request')",
                           (conversation, workspace))
                db.execute("INSERT INTO message_assists VALUES('assist',?,?,'message',?,1,'translate','',?,1,'assist-key','assist-request')",
                           (workspace, conversation, owner, task))

            reopened = Store(state)
            app = App(reopened, Config(ORIGIN))
            client = Client(app)
            for method, path in (
                ('POST', '/v1/agent/connect'),
                ('POST', f'/v1/agent/tasks/{task}/claim'),
                ('POST', f'/v1/agent/tasks/{task}/tools'),
                ('GET', '/v1/runtime-keys'),
                ('GET', '/v1/runtime/tasks'),
                ('POST', '/v1/runtime/tasks'),
                ('GET', '/v1/runtime/connections'),
                ('POST', f'/v1/runtime/tasks/{task}/artifact'),
                ('GET', '/v1/composio/approvals'),
                ('POST', '/v1/mcp/servers'),
            ):
                with self.subTest(method=method, path=path):
                    self.assertEqual(client.call(method, path)['status'], 410)

            with reopened.connect() as db:
                bundle = dsbot_bundle.build(db, owner, 'message-assists', now=3)
                rows = json.loads(bundle['tables']['message_assists'])
                self.assertEqual([(r['task_status'], r['result_text']) for r in rows],
                                 [('succeeded', 'Archived result')])
                skill_bundle = dsbot_bundle.build(db, owner, 'skill-run-history', now=3)
                history = json.loads(skill_bundle['tables']['skill_run_history'])
                self.assertEqual(history, [{
                    'id': task, 'scope': 'account', 'skill_id': 'web-summary', 'prompt': 'historic prompt',
                    'status': 'succeeded', 'created': 1, 'updated': 2, 'loaded': 1, 'result_text': 'Archived result',
                }])
                other = dsbot_bundle.build(db, stranger, 'skill-run-history', now=3)
                self.assertEqual(json.loads(other['tables']['skill_run_history']), [])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])

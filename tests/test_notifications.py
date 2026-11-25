"""Mention parsing and the platform boundary for conversation notifications."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace import notifications
from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class MentionParsingTests(unittest.TestCase):
    def test_boundaries(self):
        self.assertEqual(notifications.mentioned_names('@bob 看一下 @carol。@bob'), ['bob', 'carol'])
        self.assertEqual(notifications.mentioned_names('mail bob@example.com'), [])
        self.assertEqual(notifications.mentioned_names('ping @bob.'), ['bob'])
        self.assertEqual(notifications.mentioned_names('@@bob'), [])
        self.assertEqual(notifications.mentioned_names('（@bob）'), ['bob'])


class MentionNotificationTests(unittest.TestCase):
    def test_platform_refuses_retired_inbox_and_message_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'state')
            app = App(store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
            alice, bob = Client(app), Client(app, peer='127.0.0.2')
            self.assertEqual(alice.register('alice')['status'], 201)
            registered = bob.register('bob')
            self.assertEqual(registered['status'], 201)
            bob_id = registered['body']['user']['id']
            personal = alice.call('POST', '/v1/personal-agent')
            self.assertEqual(personal['status'], 201)
            workspace = personal['body']['personal_agent']['workspace']['id']
            root = f'/v1/workspaces/{workspace}'
            conversations = f'{root}/social/conversations'
            conversation = f'{conversations}/{"1" * 32}'
            notification = f'{root}/notifications'
            routes = (
                ('GET', notification + '?filter=unread', None),
                ('POST', notification + '/read', {'all': True}),
                ('POST', conversations, {'kind': 'group', 'member_ids': [bob_id], 'title': '项目群'}),
                ('POST', conversation + '/messages', {'body': '@bob 请看方案'}),
                ('POST', conversation + '/read', {'message_id': '2' * 32}),
            )
            for actor, client in (('owner', alice), ('other account', bob), ('signed-out', Client(app))):
                for method, path, body in routes:
                    with self.subTest(actor=actor, method=method, path=path):
                        result = client.call(method, path, body, {'HTTP_IDEMPOTENCY_KEY': 'mention-route-proof'})
                        self.assertEqual(result['status'], 410)
                        self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')

            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM social_conversations').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM social_messages').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM social_notifications').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM social_reads').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

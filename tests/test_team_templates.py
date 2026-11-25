"""The platform retires team-template reads and writes in favor of the user's DS-Bot."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class TeamTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.owner = Client(self.app)
        self.assertEqual(self.owner.register('owner')['status'], 201)

    def test_platform_refuses_the_template_catalog(self):
        for client in (self.owner, Client(self.app)):
            result = client.call('GET', '/v1/team-templates')
            self.assertEqual(result['status'], 410)
            self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')

    def test_platform_refuses_template_apply_without_creating_agents_or_groups(self):
        personal = self.owner.call('POST', '/v1/personal-agent')
        self.assertEqual(personal['status'], 201)
        workspace = personal['body']['personal_agent']['workspace']['id']
        outsider = Client(self.app, peer='127.0.0.2')
        self.assertEqual(outsider.register('outsider')['status'], 201)

        def agent_ids():
            with self.app.store.connect() as db:
                return [row[0] for row in db.execute(
                    'SELECT id FROM workspace_agents WHERE workspace_id=? ORDER BY id', (workspace,))]

        before = agent_ids()
        self.assertTrue(before)
        path = f'/v1/workspaces/{workspace}/team-templates/product-squad'
        headers = {'HTTP_IDEMPOTENCY_KEY': 'team-template-00001'}
        for actor, client in (('owner', self.owner), ('other account', outsider), ('signed-out', Client(self.app))):
            with self.subTest(actor=actor):
                result = client.call('POST', path, {}, headers)
                self.assertEqual(result['status'], 410)
                self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')
        self.assertEqual(agent_ids(), before)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM social_conversations WHERE workspace_id=?',
                                        (workspace,)).fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

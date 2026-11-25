"""Keep the central WSGI app out of the browser fixture's execution paths."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class NativeUiBoundaryTests(unittest.TestCase):
    def test_platform_session_does_not_enable_central_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory).resolve() / 'state')
            platform = App(store, Config(ORIGIN, allow_registration=True))
            client = Client(platform)
            self.assertEqual(client.register('ci_owner')['status'], 201)
            session = client.call('GET', '/v1/auth/session')
            self.assertEqual(session['status'], 200)
            self.assertEqual(session['body']['user']['username'], 'ci_owner')

            workspace = 'a' * 32
            agent = 'b' * 32
            conversation = 'c' * 32
            paths = (
                ('GET', '/v1/workspaces'),
                ('GET', f'/v1/workspaces/{workspace}/overview'),
                ('GET', f'/v1/workspaces/{workspace}/agents/{agent}/conversations/{conversation}'),
                ('POST', f'/v1/workspaces/{workspace}/agents/{agent}/conversations/{conversation}/messages'),
                ('GET', f'/v1/workspaces/{workspace}/artifacts'),
                ('GET', f'/v1/workspaces/{workspace}/memory'),
            )
            for method, path in paths:
                with self.subTest(method=method, path=path):
                    response = client.call(method, path)
                    self.assertEqual(response['status'], 410)
                    self.assertEqual(response['body']['error']['code'], 'moved_to_dsbot')
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM workspace_agents').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

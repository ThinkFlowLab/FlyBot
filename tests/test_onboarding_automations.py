"""The retired platform endpoint never writes onboarding automations."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class OnboardingAutomationTests(unittest.TestCase):
    def test_platform_cannot_create_onboarding_automations(self):
        with tempfile.TemporaryDirectory() as directory:
            app = App(Store(Path(directory) / 'state'), Config(ORIGIN, allow_registration=True),
                      clock=lambda: 1800000000)
            owner = Client(app)
            owner.register('alice')

            response = owner.call('POST', '/v1/onboarding/automations', {
                'workspace_id': 'a' * 32,
                'template_ids': ['daily_brief'],
                'username': 'alice',
            })

            self.assertEqual(response['status'], 410)
            self.assertEqual(response['body']['error']['code'], 'moved_to_dsbot')
            with app.store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM automations').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

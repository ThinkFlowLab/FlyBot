"""Team wizard page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class TeamPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/team')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('创建团队', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="slug"', html)
        self.assertIn('value="new"', html)
        self.assertIn('value="convert"', html)
        self.assertIn('/v1/teams', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(self.raw.call('GET', '/team/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/team/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/team', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/team', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/team')['status'], 405)

    def test_team_creation_has_no_legacy_management_fallback(self):
        result = self.client.call('POST', '/v1/teams',
                                  {'name': 'Desk team', 'slug': 'desk-team', 'mode': 'new'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'team-page-create-0001'})
        self.assertEqual(result['status'], 410)
        self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')

    def test_recorded_first_step_keeps_name_id_and_modes_together(self):
        html = self.raw.call('GET', '/team')['body'].decode()
        self.assertIn('为团队命名', html)
        self.assertIn('为团队设置一个显示名称和一个稳定的 Team ID。', html)
        self.assertIn('例如: My Cool Team', html)
        self.assertIn('最多 60 个字符', html)
        self.assertIn('acme-team', html)
        self.assertIn('3–30 个字符，小写字母、数字、连字符', html)
        self.assertIn('创建独立的团队工作区', html)
        self.assertIn('设一个全新、独立的团队工作区开始。', html)
        self.assertIn('转化我当前的工作区', html)
        self.assertIn('将当前工作区升入该团队。', html)
        self.assertIn('继续', html)
        # Issue #246: step 2 is now the real invite step, so the old
        # "step-later" placeholder is gone and steps 2 and 3 exist.
        self.assertNotIn('id="step-later"', html)
        self.assertIn('id="step-2"', html)
        self.assertIn('邀请成员', html)
        self.assertIn('id="invite-role"', html)
        self.assertIn('id="invite-expiry"', html)
        self.assertIn('id="invite-skip"', html)
        self.assertIn('跳过，只建团队', html)
        self.assertIn('id="step-3"', html)
    def test_new_team_alias_is_served_and_unknown_new_paths_404(self):
        alias = self.raw.call('GET', '/new/team')
        self.assertEqual(alias['status'], 200)
        html = alias['body'].decode()
        self.assertIn('创建团队', html)
        self.assertIn('为团队命名', html)
        self.assertEqual(html, self.raw.call('GET', '/team')['body'].decode())
        self.assertEqual(self.raw.call('GET', '/new')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/new/other')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/new/team', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/new/team', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/new/team')['status'], 405)


if __name__ == '__main__':
    unittest.main()

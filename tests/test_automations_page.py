"""Automations page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class AutomationsPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/automations')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('自动化', html)
        self.assertIn('id="task-view-switcher"', html)
        self.assertIn('aria-controls="checklist-panel"', html)
        self.assertIn('aria-controls="bot-schedule-panel"', html)
        self.assertIn('data-category="mine"', html)
        self.assertIn('data-category="work"', html)
        self.assertIn('data-category="life"', html)
        self.assertIn('name="intent"', html)
        self.assertIn('name="scope"', html)
        self.assertIn('value="now"', html)
        self.assertIn('value="monthly"', html)
        self.assertIn('value="weekdays"', html)
        self.assertIn('运行记录', html)
        self.assertIn('id="run-filter-failed"', html)
        self.assertIn('id="run-filter-succeeded"', html)
        self.assertIn('id="run-filter-all"', html)
        self.assertIn('没有符合这个筛选的运行记录。', html)
        self.assertIn('name="template_id"', html)
        self.assertIn('id="manual-run-status"', html)
        self.assertIn('id="view-watched-run"', html)
        self.assertNotIn('生活类模板还没有从对照里记下来', html)
        self.assertNotIn('teamily.com', html)
        self.assertIn('/v1/workspaces', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/automations/app.mjs')
        style = self.raw.call('GET', '/automations/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        for asset in ('checklist.mjs', 'bot-schedules.mjs'):
            self.assertEqual(self.raw.call('GET', f'/automations/{asset}')['status'], 200)
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        self.assertEqual(self.raw.call('GET', '/automations/missing')['status'], 404)

    def test_run_rows_are_served_with_an_in_place_expander(self):
        script = self.raw.call('GET', '/automations/app.mjs')
        source = script['body'].decode()
        self.assertIn('aria-expanded', source)
        self.assertIn('这次运行没有留下输出', source)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/automations', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/automations', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/automations')['status'], 405)

    def test_page_accepts_only_recorded_run_filters(self):
        for value in ('all', 'succeeded', 'failed'):
            page = self.raw.call('GET', '/automations', query='runs=' + value)
            self.assertEqual(page['status'], 200, (value, page['status']))
        self.assertEqual(self.raw.call('GET', '/automations', query='runs=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='runs=FAILED')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='runs=failed&template=daily_brief')['status'], 400,
                         'the one-shot template prefill and the run filter never share a URL')

    def test_platform_wrapper_defers_automation_reads_and_writes_to_dsbot(self):
        collection = f'/v1/workspaces/{"a" * 32}/automations'
        automation = f'{collection}/{"b" * 32}'
        for method, path in (('GET', collection), ('POST', collection),
                             ('GET', f'{automation}/runs/{"c" * 32}'), ('POST', f'{automation}/run')):
            with self.subTest(method=method, path=path):
                response = self.client.call(method, path, {} if method == 'POST' else None)
                self.assertEqual(response['status'], 410)
                self.assertEqual(response['body']['error']['code'], 'moved_to_dsbot')


if __name__ == '__main__':
    unittest.main()

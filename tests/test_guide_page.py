"""Feature guide page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class GuidePageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_guide_serves_recorded_chrome_and_keeps_an_honest_catalog(self):
        page = self.raw.call('GET', '/guide')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('功能指引', html)
        self.assertIn('id="guide-search"', html)
        self.assertIn('搜索功能，例如：添加成员', html)
        self.assertIn('id="view-list"', html)
        self.assertIn('id="view-graph"', html)
        self.assertIn('图谱视图暂不可用', html)
        self.assertIn('id="guide-dialog"', html)
        self.assertIn('操作路径', html)
        self.assertIn('查看功能入口和使用说明。', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertNotIn('折叠会话列表', html)
        self.assertNotIn('295', html)
        self.assertEqual(self.raw.call('GET', '/guide/app.mjs')['status'], 200)
        logo = self.raw.call('GET', '/shell/flybot-logo.svg')
        self.assertEqual(logo['status'], 200)
        self.assertEqual(logo['headers']['Content-Type'], 'image/svg+xml')
        self.assertEqual(self.raw.call('GET', '/guide/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/guide', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/guide', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/guide')['status'], 405)
        script = self.raw.call('GET', '/guide/app.mjs')['body'].decode()
        self.assertIn('export const CATALOG', script)
        self.assertIn('打开聊天', script)
        self.assertIn('通话窗口', script)
        self.assertIn('export function guideIconPath', script)
        self.assertIn('CATEGORY_ICON_PATHS', script)
        self.assertNotIn(
            'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm-1 3h2v5h-2V8zm0 6h2v2h-2v-2z',
            script,
        )
        self.assertNotIn('折叠会话列表', script)
        self.assertNotIn('innerHTML', script)

    def test_guide_search_box_names_itself_and_states_the_empty_copy(self):
        page = self.raw.call('GET', '/guide')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('type="search"', html)
        self.assertIn('aria-label="搜索功能指引"', html)
        self.assertIn('没有匹配的指引。', html)

    def test_guide_accepts_only_the_q_deep_link_query(self):
        self.assertEqual(self.raw.call('GET', '/guide', query='q=%E5%A4%96%E8%A7%82')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/guide', query='q=DS-Bot')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/guide', query='q=')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/guide', query='q=a&x=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/guide/app.mjs', query='q=a')['status'], 400)

    def test_guide_accepts_a_category_deep_link(self):
        for slug in ('calls', 'settings', 'chat'):
            page = self.raw.call('GET', '/guide', query=f'category={slug}')
            self.assertEqual(page['status'], 200, (slug, page['status'], page['body'][:40]))
        combined = self.raw.call('GET', '/guide', query='category=calls&q=%E5%A4%96%E8%A7%82')
        self.assertEqual(combined['status'], 200, combined['body'][:40])

    def test_guide_unknown_category_falls_back_instead_of_failing(self):
        self.assertEqual(self.raw.call('GET', '/guide', query='category=not-a-category')['status'], 200)
        for query in ('category=', 'category=a&category=b', 'category=a&x=1', 'q=a&x=1', 'x=1'):
            self.assertEqual(self.raw.call('GET', '/guide', query=query)['status'], 400, query)

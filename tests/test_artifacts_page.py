"""Artifacts page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ArtifactsPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/artifacts')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('作品库', html)
        self.assertIn('新建云文档', html)
        self.assertIn('新建网站', html)
        self.assertIn('云文档', html)
        self.assertIn('白板', html)
        self.assertIn('上传', html)
        self.assertIn('全部作品', html)
        self.assertIn('我创建的', html)
        self.assertIn('你的资料空间从这里开始', html)
        self.assertIn('class="empty-cta"', html)
        self.assertNotIn('artifacts-disclaimer', html)
        self.assertNotIn('对照里的作品库入口是 /space', html)
        self.assertIn('id="media-image"', html)
        self.assertRegex(html, r'<img id="media-image"[^>]*src="data:image/')
        self.assertIn('让智能体搭建网站', html)
        self.assertIn('保存聊天中的消息', html)
        self.assertIn('id="empty-agent-website"', html)
        self.assertNotIn('id="empty-agent-website" disabled', html)
        self.assertIn('id="new-agent-website"', html)
        self.assertIn('id="new-save-message"', html)
        self.assertIn('id="empty-save-message"', html)
        self.assertIn('暂无收藏', html)
        self.assertIn('没有匹配的作品', html)
        self.assertIn('还没有会议纪要', html)
        self.assertIn('id="new-meeting-in-space"', html)
        self.assertNotIn('还没有会议作品接口', html)
        self.assertIn('id="meetings-error"', html)
        self.assertIn('这个工作区的会议纪要，最新的在前。', html)
        self.assertIn('id="meetings-title"', html)
        self.assertIn('>我的会议</h1>', html)
        self.assertIn('data-tone="wave"', html)
        self.assertIn('id="empty-meetings"', html)
        self.assertIn('aria-label="作品通知"', html)
        self.assertIn('id="artifact-notify"', html)
        self.assertIn('<dialog id="artifact-notifications"', html)
        self.assertRegex(html, r'<button[^>]+data-kind="website"[^>]*>.*</span>网页</button>')
        self.assertIn('data-scope="memory">记忆</button>', html)
        self.assertIn('id="filter-panel"', html)
        self.assertIn('自定义范围', html)
        self.assertIn('暂无可筛选的创建人', html)
        self.assertIn('没有匹配的会话', html)
        self.assertNotIn('还没有作品通知接口', html)
        self.assertIn('id="new-menu"', html)
        self.assertIn('id="new-slides"', html)
        self.assertIn('id="slides-editor"', html)
        self.assertIn('id="slide-list"', html)
        self.assertIn('id="add-slide"', html)
        self.assertIn('id="new-dashboard"', html)
        self.assertIn('id="dashboard-editor"', html)
        self.assertIn('id="widget-list"', html)
        self.assertIn('id="add-widget"', html)
        self.assertIn('资料空间', html)
        self.assertIn('id="dir-collapse"', html)
        self.assertIn('收起侧边栏', html)
        self.assertIn('展开侧边栏', html)
        self.assertIn('+ 新建', html)
        self.assertIn('网格视图', html)
        self.assertIn('列表视图', html)
        self.assertIn('id="dir-expand"', html)
        self.assertIn('创建只读分享链接', html)
        self.assertIn('公开到发现页', html)
        self.assertIn('id="discover-panel"', html)
        self.assertIn('id="publish-discover"', html)
        self.assertIn('导出当前版本', html)
        self.assertIn('版本与导出', html)
        self.assertIn('/v1/workspaces', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        self.assertIn("frame-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertIn("script-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/artifacts/app.mjs')
        style = self.raw.call('GET', '/artifacts/app.css')
        self.assertEqual(script['status'], 200)
        self.assertRegex(html, r'<button[^>]+id="work-version-restore"[^>]*>恢复为新修订</button>')
        self.assertIn("import('./version-preview.mjs')", script['body'].decode())
        preview = self.raw.call('GET', '/artifacts/version-preview.mjs')
        self.assertEqual(preview['status'], 200)
        self.assertIn('text/javascript', preview['headers']['Content-Type'])
        self.assertEqual(preview['headers']['X-Content-Type-Options'], 'nosniff')
        self.assertIn(b'target.submitRestore', preview['body'])
        self.assertIn('renderSlidesEditor', script['body'].decode())
        self.assertIn('renderDashboardEditor', script['body'].decode())
        self.assertEqual(style['status'], 200)
        css = style['body'].decode()
        self.assertIn('#meetings-title', css)
        self.assertIn('#artifact-notify svg', css)
        js = script['body'].decode()
        self.assertIn('is-meetings', js)
        self.assertIn('websitePrompt', js)
        self.assertIn('openWebsiteBriefDialog', js)
        self.assertIn('openSaveMessageDialog', js)
        self.assertNotIn('Teamily Wiki', js)
        thumb = self.raw.call('GET', '/shell/thumb.mjs')
        self.assertEqual(thumb['status'], 200)
        self.assertIn('describeWebsiteDispatch', thumb['body'].decode())
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        self.assertEqual(self.raw.call('GET', '/artifacts/missing')['status'], 404)

    def test_space_alias_accepts_recorded_views_only(self):
        for path in ('/space', '/artifacts'):
            self.assertEqual(self.raw.call('GET', path)['status'], 200, path)
            for view in ('created', 'starred', 'memory', 'meetings'):
                page = self.raw.call('GET', path, query=f'view={view}')
                self.assertEqual(page['status'], 200, f'{path}?view={view}')
                self.assertIn('作品库', page['body'].decode())
            self.assertEqual(self.raw.call('GET', path, query='q=1')['status'], 400)
            self.assertEqual(self.raw.call('GET', path, query='view=created&x=1')['status'], 400)
            self.assertEqual(self.raw.call('GET', path, query='view=unknown')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/artifacts/app.mjs', query='view=created')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/artifacts/app.css', query='view=created')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/settings', query='view=created')['status'], 400)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/artifacts', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/space', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/artifacts', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/artifacts')['status'], 405)
        self.assertEqual(self.raw.call('POST', '/space')['status'], 405)

    def test_artifact_api_is_moved_to_dsbot(self):
        path = f"/v1/workspaces/{'a' * 32}/artifacts"
        listed = self.client.call('GET', path)
        self.assertEqual(listed['status'], 410)
        self.assertEqual(listed['body']['error']['code'], 'moved_to_dsbot')
        created = self.client.call(
            'POST', path, {'title': 'Brief', 'body': 'Hello'},
            {'HTTP_IDEMPOTENCY_KEY': 'artifact-page-create-0001'},
        )
        self.assertEqual(created['status'], 410)
        self.assertEqual(created['body']['error']['code'], 'moved_to_dsbot')


if __name__ == '__main__':
    unittest.main()

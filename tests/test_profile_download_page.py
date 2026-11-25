"""Profile and download page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ProfileDownloadPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_profile_editor_fields_and_assets(self):
        page = self.raw.call('GET', '/profile')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('profile-username', 'profile-form', 'profile-name', 'profile-handle',
                      'profile-bio', 'profile-tags', 'profile-gender', 'profile-location',
                      'profile-website', 'goal-health', 'goal-career', 'profile-save'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('FlyBot ID', html)
        self.assertIn('人生目标', html)
        self.assertIn('仅你自己可见', html)
        self.assertIn('href="/profile/app.css"', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertEqual(self.raw.call('GET', '/profile/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/profile/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/profile', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/profile')['status'], 405)
        edit = self.raw.call('GET', '/profile/edit')
        self.assertEqual(edit['status'], 200)
        edit_html = edit['body'].decode()
        self.assertIn('编辑资料', edit_html)
        self.assertIn('id="profile-home"', edit_html)
        self.assertIn('id="followers-dialog"', edit_html)
        self.assertRegex(edit_html, r'<button[^>]+id="tab-posts"[^>]*>公开作品</button>')
        self.assertIn('id="profile-feed-list"', edit_html)
        self.assertRegex(edit_html, r'<p[^>]+id="profile-feed-empty"[^>]+role="status"')
        self.assertEqual(self.raw.call('GET', '/profile/edit', query='x=1')['status'], 400)

    def test_download_explains_managed_dsbot_and_disables_missing_clients(self):
        page = self.raw.call('GET', '/download')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('id="download-runtime"', html)
        self.assertIn('<h2>你的 DS-Bot</h2>', html)
        self.assertIn('注册后平台会为你单独开一个 DS-Bot', html)
        self.assertNotIn('href="/install/flybot.pyz"', html)
        self.assertEqual(self.client.call('GET', '/install/flybot.pyz')['status'], 404)
        self.assertIn('id="download-unavailable"', html)
        self.assertIn('未实现：没有 FlyBot iOS 客户端', html)
        self.assertIn('未实现：没有 FlyBot Android 客户端', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertEqual(self.raw.call('GET', '/download/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/download', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/download', query='x=1')['status'], 400)

    def test_about_page_is_original_and_rejects_queries(self):
        page = self.raw.call('GET', '/about')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('关于 · FlyBot', html)
        self.assertIn('可自托管', html)
        self.assertIn('href="/about/app.css"', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertNotIn("World's First", html)
        self.assertNotIn('Human-AI Social Network', html)
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/about/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/about', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/about')['status'], 405)

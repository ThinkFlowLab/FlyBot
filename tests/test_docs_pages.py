"""Help centre, terms and privacy page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import re
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


def has_account_menu_link(html, href, label):
    """Account-menu anchors may carry data-ui-text (or other) attributes.

    Attribute order also varies across pages after the locale catalog landed.
    The link must still be a real role=menuitem anchor to the public docs page.
    """
    for match in re.finditer(r'<a\b([^>]*?)>([^<]*)</a>', html):
        attrs, text = match.group(1), match.group(2)
        if text != label:
            continue
        if not re.search(r'\bhref="%s"' % re.escape(href), attrs):
            continue
        if not re.search(r'\brole="menuitem"', attrs):
            continue
        return True
    return False


class DocsPagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_the_three_docs_pages_are_served_with_their_real_content(self):
        help_page = self.raw.call('GET', '/help')
        self.assertEqual(help_page['status'], 200)
        html = help_page['body'].decode()
        self.assertIn('<h1>帮助中心</h1>', html)
        for anchor in ('chat', 'agents', 'artifacts', 'automations', 'meetings', 'memory', 'team', 'runtimes'):
            self.assertIn('id="%s"' % anchor, html)
        self.assertIn('现在能做什么', html)
        self.assertIn('已知边界', html)
        self.assertNotIn('即将支持', html)

        terms = self.raw.call('GET', '/terms')['body'].decode()
        self.assertIn('<h1>服务条款</h1>', terms)
        self.assertIn('自托管实例', terms)
        self.assertIn('--data-dir', terms)

        privacy = self.raw.call('GET', '/privacy')['body'].decode()
        self.assertIn('<h1>隐私政策</h1>', privacy)
        self.assertIn('management.sqlite3', privacy)
        self.assertIn('artifact-objects/', privacy)
        self.assertIn('artifact_media', privacy)
        self.assertIn('user_avatars', privacy)
        self.assertIn('/artifacts/&lt;id&gt;/export', privacy)

        for path in ('/help', '/terms', '/privacy'):
            body = self.raw.call('GET', path)['body'].decode()
            self.assertIn('href="/help" role="menuitem"', body)
            self.assertIn('href="/terms" role="menuitem"', body)
            self.assertIn('href="/privacy" role="menuitem"', body)
            self.assertNotIn('未实现：还没有 FlyBot 帮助中心', body)

    def test_docs_share_one_stylesheet_and_keep_the_page_guards(self):
        self.assertEqual(self.raw.call('GET', '/docs/app.css')['status'], 200)
        for path in ('/help', '/terms', '/privacy'):
            self.assertIn('/docs/app.css', self.raw.call('GET', path)['body'].decode())
            self.assertEqual(self.raw.call('GET', path, query='x=1')['status'], 400)
            self.assertEqual(self.raw.call('GET', path, origin='https://evil.test')['status'], 403)
            self.assertEqual(self.raw.call('POST', path)['status'], 405)
        self.assertEqual(self.raw.call('GET', '/docs/app.css', query='v=1')['status'], 400)

    def test_the_account_menu_no_longer_offers_disabled_legal_placeholders(self):
        links = (('/help', '帮助中心'), ('/terms', '服务条款'), ('/privacy', '隐私政策'))
        for path in ('/chat', '/profile', '/settings', '/guide'):
            html = self.raw.call('GET', path)
            self.assertEqual(html['status'], 200)
            body = html['body'].decode()
            for href, label in links:
                self.assertTrue(
                    has_account_menu_link(body, href, label),
                    '%s still has no real %s link in the account menu' % (path, label),
                )
            self.assertNotIn('未实现：还没有 FlyBot 帮助中心页', body)
            self.assertNotIn('未实现：还没有 FlyBot 服务条款页', body)
            self.assertNotIn('未实现：还没有 FlyBot 隐私政策页', body)


if __name__ == '__main__':
    unittest.main()

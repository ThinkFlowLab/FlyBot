"""Shared management shell serving tests. In-process WSGI only; not browser E2E."""
import unittest

from tests import test_settings_page as settings_page_tests


PAGES = (
    '/settings', '/agents', '/chat', '/automations', '/artifacts', '/space',
    '/members', '/team', '/memory', '/discover',
    '/profile', '/onboarding', '/meetings', '/download', '/guide',
)

CAPTURE_IDS = {
    '/settings': ('login-panel', 'username', 'password', 'settings-panel',
                  'whoami', 'model-key-state', 'model-api-form', 'settings-index'),
    '/agents': ('main-panel', 'agent-search', 'agent-list', 'edit-form', 'chat-panel',
                'open-in-chat', 'homepage-panel', 'manage-public-homepage',
                'manage-drawer', 'open-create'),
    '/discover': ('main-panel', 'feed-panel', 'feed-note', 'discover-list',
                  'discover-empty', 'manage-list', 'manage-empty', 'workspace'),
    '/chat': ('main-panel', 'session-pane', 'conversation-list',
              'chat-form', 'chat-body', 'message-list', 'chat-title'),
    '/automations': ('automation-list', 'editor-form', 'run-panel',
                     'run-list', 'run-empty'),
    '/artifacts': ('artifact-list', 'editor-form', 'media-image',
                   'board-canvas', 'website-preview', 'new-menu',
                   'new-artifact', 'list-empty', 'filter-panel',
                   'empty-starred', 'empty-memory', 'empty-meetings',
                   'meetings-chrome'),
    '/space': ('artifact-list', 'editor-form', 'media-image',
               'board-canvas', 'website-preview', 'new-menu',
               'new-artifact', 'list-empty', 'filter-panel',
               'empty-starred', 'empty-memory', 'empty-meetings',
               'meetings-chrome'),
    '/members': ('member-list', 'invite-list'),
    '/team': ('wizard-form', 'step-1', 'step-2', 'step-3', 'next', 'back',
               'submit', 'invite-skip'),
    '/memory': ('main-panel', 'memory-list', 'editor-form',
                'search', 'new-page', 'graph-canvas', 'topic-list',
                'overview-panel', 'actions-panel', 'action-list',
                'profile-panel', 'dream-profile', 'dream-actions'),
    '/profile': ('main-panel', 'whoami', 'profile-username', 'profile-form',
                 'profile-name', 'profile-handle', 'profile-bio', 'profile-save'),

    '/onboarding': ('main-panel', 'onboarding-form', 'industry', 'role-choices',
                    'onboarding-save', 'onboarding-skip'),
    '/meetings': ('main-panel', 'meeting-list', 'meeting-form', 'meeting-title',
                  'meeting-started-at', 'action-list', 'save-meeting'),
    '/download': ('main-panel', 'download-web', 'download-runtime',
                  'download-unavailable'),
    '/guide': ('main-panel', 'whoami', 'guide-search', 'guide-categories',
               'guide-list', 'guide-count', 'guide-empty', 'guide-dialog',
               'guide-dialog-title', 'guide-dialog-body', 'guide-dialog-path',
               'view-list', 'view-graph'),
}


class ShellPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)
    def test_shell_assets_are_served_with_strict_headers(self):
        css = self.raw.call('GET', '/shell/app.css')
        script = self.raw.call('GET', '/shell/app.mjs')
        self.assertEqual(css['status'], 200, css)
        self.assertEqual(script['status'], 200, script)
        self.assertIn('text/css', css['headers']['Content-Type'])
        self.assertIn('javascript', script['headers']['Content-Type'])
        for response in (css, script):
            self.assertIn("default-src 'none'", response['headers']['Content-Security-Policy'])
            self.assertEqual(response['headers']['Cache-Control'], 'private, no-cache')
            self.assertEqual(response['headers']['X-Content-Type-Options'], 'nosniff')
            self.assertLessEqual(len(response['body']), 262144)
        self.assertIn(b'--ot-measure', css['body'])
        self.assertIn(b'[hidden]', css['body'])
        self.assertIn(b'display: none !important', css['body'])
        self.assertIn(b'.skip-link', css['body'])
        self.assertIn(b'body.app-workspace > .app-rail > a', css['body'])
        self.assertIn(b'font-size: 0.75rem', css['body'])
        self.assertNotIn(b'font-size: 0.62rem', css['body'])
        self.assertNotIn(b'teamily.com', css['body'].lower())
        self.assertNotIn(b'teamily.com', script['body'].lower())
        self.assertIn(b'export function resolveTheme', script['body'])
        self.assertIn(b'export function startShell', script['body'])
        self.assertIn(b'export function accountNameFromLabel', script['body'])
        self.assertIn(b'export function ensureOnboardingMenuItem', script['body'])
        self.assertIn(b'export function ensureChannelsAndConnectorsMenuItems', script['body'])
        self.assertIn("ONBOARDING_MENU_LABEL = '新手引导'".encode(), script['body'])
        self.assertIn(b'/onboarding', script['body'])
        self.assertIn('Agent 渠道'.encode(), script['body'])
        self.assertIn(b'/settings/channels', script['body'])
        self.assertIn('应用连接器'.encode(), script['body'])
        self.assertIn(b'/settings/connectors', script['body'])
        self.assertIn('已登录为'.encode(), script['body'])
        head = self.raw.call('HEAD', '/shell/app.css')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')
        self.assertEqual(self.raw.call('GET', '/shell/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/../settings_page.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/app.css', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/shell/app.css')['status'], 405)

    def test_public_agent_composer_loads_before_login(self):
        composer = self.raw.call('GET', '/shell/public-agent-composer.mjs')
        self.assertEqual(composer['status'], 200)
        self.assertEqual(composer['headers']['Content-Type'], 'text/javascript; charset=utf-8')
        self.assertEqual(composer['headers']['X-Content-Type-Options'], 'nosniff')
        self.assertIn(b'./public-agent-link.mjs', composer['body'])
        dependency = self.raw.call('GET', '/shell/public-agent-link.mjs')
        self.assertEqual(dependency['status'], 200)
        self.assertIn(b'export function stagePublicAgentOpening', dependency['body'])

    def test_public_agent_share_loads_before_login(self):
        path = '/shell/public-agent-share.mjs'
        script = self.raw.call('GET', path)
        self.assertEqual(script['status'], 200)
        self.assertEqual(script['headers']['Content-Type'], 'text/javascript; charset=utf-8')
        self.assertEqual(script['headers']['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(script['headers']['Cross-Origin-Resource-Policy'], 'same-origin')
        self.assertIn(b'data-copy-profile', script['body'])
        head = self.raw.call('HEAD', path)
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')

    def test_central_runtime_console_and_pairing_keys_are_retired(self):
        self.assertEqual(self.client.call('GET', '/runtimes')['status'], 404)
        pairing_keys = self.client.call('GET', '/v1/runtime-keys')
        self.assertEqual(pairing_keys['status'], 410)
        self.assertEqual(pairing_keys['body']['error']['code'], 'moved_to_dsbot')

    def test_management_pages_share_the_shell_and_keep_functional_ids(self):
        for path in PAGES:
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('href="/shell/app.css"', html, path)
            self.assertIn('src="/shell/app.mjs"', html, path)
            self.assertIn('class="skip-link"', html, path)
            self.assertIn('href="#main"', html, path)
            self.assertIn('id="main"', html, path)
            self.assertIn('FlyBot', html, path)
            self.assertIn('class="brand-mark"', html, path)
            self.assertIn('brand-glyph', html, path)
            self.assertNotIn('>FB</a>', html, path)
            self.assertTrue(
                'aria-label="管理导航"' in html or 'aria-label="应用导航"' in html, path)
            self.assertIn('<nav', html, path)
            self.assertIn('id="status"', html, path)
            self.assertNotIn('teamily.com', html.lower(), path)
            for ident in CAPTURE_IDS[path]:
                self.assertIn(f'id="{ident}"', html, f'{path} missing {ident}')
            self.assertIn('aria-label="应用导航"', html, path)
            self.assertIn('id="account-menu"', html, path)
            self.assertIn('id="account-menu-button"', html, path)
            self.assertIn('id="logout-form"', html, path)
            self.assertIn('所有设置', html, path)
            self.assertIn('href="/settings"', html, path)
            self.assertNotIn('积分中心', html, path)
            self.assertNotIn('套餐与账单', html, path)
            self.assertNotIn('contact@teamily.ai', html.lower(), path)
            self.assertIn('id="help-menu"', html, path)
            self.assertIn('查看我的资料', html, path)
            if path == '/onboarding':
                self.assertIn('href="/onboarding"', html, path)
                self.assertIn('工作背景', html, path)
            self.assertIn('href="/download"', html, path)
            self.assertIn('id="appearance-toggle"', html, path)
            self.assertIn('href="/discover"', html, path)
            self.assertNotIn('未实现：发现动态', html, path)
            self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
            if path == '/agents':
                self.assertIn('name="name"', html)
                self.assertIn('id="open-in-chat" href="/chat"', html)
                self.assertIn('id="manage-public-homepage" href="/discover?', html)
            if path in ('/artifacts', '/space'):
                self.assertIn('textarea', html)
                self.assertIn('href="/space"', html)
            if path == '/team':
                self.assertIn('<h1>', html)


if __name__ == '__main__':
    unittest.main()

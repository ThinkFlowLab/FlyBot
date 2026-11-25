"""Former /messenger page now redirects to the unified /chat inbox."""
import unittest

from tests import test_settings_page as settings_page_tests


class MessengerPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)

    def test_page_redirects_to_chat_and_old_assets_are_gone(self):
        page = self.raw.call('GET', '/messenger')
        self.assertEqual(page['status'], 302, page)
        self.assertEqual(page['headers']['Location'], '/chat')
        self.assertEqual(page['body'], b'')
        head = self.raw.call('HEAD', '/messenger')
        self.assertEqual(head['status'], 302)
        self.assertEqual(head['headers']['Location'], '/chat')
        self.assertEqual(head['body'], b'')
        chat = self.raw.call('GET', '/chat')
        html = chat['body'].decode()
        self.assertEqual(chat['status'], 200)
        self.assertIn('id="compose-menu"', html)
        self.assertIn('id="search-panel"', html)
        self.assertIn('href="/chat"', html)
        self.assertNotIn('href="/messenger"', html)
        self.assertNotIn('id="create-conversation"', html)
        self.assertIn('id="account-menu"', html)
        self.assertEqual(self.raw.call('GET', '/messenger/')['headers']['Location'], '/chat')
        self.assertEqual(self.raw.call('GET', '/messenger/app.mjs')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/messenger/app.css')['status'], 404)
        script = self.raw.call('GET', '/shell/chat-utils.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        self.assertIn(b'conversationLabel', script['body'])

    def test_origin_and_method_checks_still_apply(self):
        self.assertEqual(self.raw.call('GET', '/messenger', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/messenger', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/messenger')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/messenger/missing')['status'], 404)


if __name__ == '__main__':
    unittest.main()

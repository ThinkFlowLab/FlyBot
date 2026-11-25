"""Meetings page serving tests. In-process WSGI only."""
import unittest

from tests import test_settings_page as settings_page_tests


class MeetingsPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)

    def test_page_and_assets(self):
        page = self.raw.call('GET', '/meetings')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('main-panel', 'meeting-list', 'meeting-form', 'meeting-title',
                      'meeting-started-at', 'meeting-attendees', 'meeting-summary',
                      'meeting-transcript', 'action-list', 'add-action', 'save-meeting',
                      'export-meeting', 'generate-meeting-draft', 'apply-meeting-draft'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('href="/meetings/app.css"', html)
        self.assertEqual(self.raw.call('GET', '/meetings/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/meetings/audio.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/shell/call-audio-handoff.mjs')['status'], 200)
        self.assertIn('microphone=(self)', page['headers']['Permissions-Policy'])
        self.assertIn("media-src 'self' blob:", page['headers']['Content-Security-Policy'])
        self.assertIn('microphone=()', self.raw.call('GET', '/settings')['headers']['Permissions-Policy'])
        self.assertEqual(self.raw.call('GET', '/meetings/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/meetings', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/meetings', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/meetings')['status'], 405)


if __name__ == '__main__':
    unittest.main()

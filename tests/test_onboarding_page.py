"""Onboarding page serving tests. In-process WSGI only."""
import unittest

from tests import test_settings_page as settings_page_tests


class OnboardingPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)

    def test_page_and_assets(self):
        page = self.raw.call('GET', '/onboarding')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('main-panel', 'onboarding-form', 'industry', 'role-choices',
                      'onboarding-save', 'onboarding-skip', 'account-menu',
                      'onboarding-automation-templates', 'create-onboarding-automations',
                      'onboarding-automation-status'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('工作背景', html)
        self.assertIn('href="/onboarding/app.css"', html)
        self.assertEqual(self.raw.call('GET', '/onboarding/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/onboarding/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/onboarding', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/onboarding', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/onboarding')['status'], 405)


if __name__ == '__main__':
    unittest.main()

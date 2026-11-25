"""Registration UI serving and unchanged authentication policy, synthetic only."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD
from tests.test_settings_page import RawClient


class RegistrationPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True))
        self.page = SettingsPage(self.api)
        self.raw = RawClient(self.page)
        self.client = Client(self.page)

    def test_form_assets_and_strict_headers(self):
        response = self.raw.call('GET', '/register')
        self.assertEqual(response['status'], 200)
        html = response['body'].decode()
        for marker in ('id="register-form"', 'action="/v1/auth/register"', 'method="post"',
                       'id="register-username"', 'id="register-password"', 'type="password"',
                       'autocomplete="new-password"', 'id="register-submit"'):
            self.assertIn(marker, html)
        self.assertNotIn('<script>', html)
        self.assertEqual(response['headers']['Cache-Control'], 'no-store')
        self.assertIn("form-action 'self'", response['headers']['Content-Security-Policy'])
        self.assertEqual(self.raw.call('HEAD', '/register')['body'], b'')
        for path in ('/register/app.mjs', '/register/app.css', '/home/auth.css'):
            self.assertEqual(self.raw.call('GET', path)['status'], 200)
        self.assertEqual(self.raw.call('GET', '/register/missing')['status'], 404)

    def test_login_is_public_with_registration_closed(self):
        self.api.config = replace(self.api.config, allow_registration=False)
        login = self.raw.call('GET', '/login')
        self.assertEqual(login['status'], 200)
        self.assertIn(b'action="/v1/auth/login"', login['body'])
        self.assertEqual(login['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('HEAD', '/login')['body'], b'')
        self.assertEqual(self.raw.call('POST', '/login')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/login', query='next=https://example.com')['status'], 400)
        register = self.raw.call('GET', '/register/')
        self.assertEqual(register['status'], 200)
        self.assertIn(b'href="/login"', register['body'])

    def test_page_policy_not_weakened(self):
        self.assertEqual(self.raw.call('GET', '/register', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', host='evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', site='cross-site')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', query='next=https://evil.test')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/register')['status'], 405)

    def test_existing_api_registers_session_but_preserves_csrf(self):
        result = self.client.register('registration-test')
        self.assertEqual(result['status'], 201)
        self.assertNotIn(PASSWORD, str(result))
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(self.client.call('POST', '/v1/auth/logout', {}, csrf=False)['status'], 403)

    def test_api_origin_registration_policy_and_validation(self):
        body = {'username': 'test-user', 'password': PASSWORD}
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body, origin=None)['status'], 403)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', {'username': 'a', 'password': PASSWORD})['status'], 400)
        self.api.config = replace(self.api.config, allow_registration=False)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body)['status'], 403)

    def test_public_policy_closed_default_and_no_account_counts_or_bootstrap_grants(self):
        self.api.config=replace(self.api.config,allow_registration=False)
        policy=self.client.call('GET','/v1/auth/policy')
        self.assertEqual(policy['status'],200);self.assertFalse(policy['body']['registration_open'])
        self.assertTrue(policy['body']['session_requires_https'])
        self.assertNotIn('user_count',policy['body']);self.assertNotIn('first_user',policy['body'])
        for path in ('/v1/auth/policy?registration_open=true','/v1/auth/policy?next=/'):
            self.assertEqual(self.client.call('GET',path)['status'],400)
        self.assertEqual(self.client.call('POST','/v1/auth/policy',{})['status'],400)
        self.assertEqual(self.client.register('not-created')['body']['error']['code'],'registration_closed')
        with self.api.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0],0)


    def test_root_and_settings_have_prominent_registration_entry_and_matching_explicit_text_input(self):
        for path in ('/','/settings'):
            response=self.raw.call('GET',path);self.assertEqual(response['status'],200,response)
            html=response['body'].decode()
            self.assertIn('class="login-register-button" href="/register">注册新账户',html)
            self.assertRegex(html,r'<input[^>]*type="text"[^>]*name="username"')
            self.assertRegex(html,r'<input[^>]*name="password"[^>]*type="password"')


if __name__ == '__main__':
    unittest.main()

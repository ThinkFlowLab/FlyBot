"""Signed-in home page and workspace overview. In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class HomePageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.api = api
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_home_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('login-panel', 'main-panel', 'home-workspace', 'home-personal',
                      'home-actions', 'home-stats', 'home-conversations', 'home-artifacts',
                      'home-meetings'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('欢迎回来', html)
        self.assertIn('最近对话', html)
        self.assertIn('href="/home/app.css"', html)
        self.assertIn('rel="modulepreload" href="/home/runtime-readiness.mjs"', html)
        self.assertNotIn('href="/look/app.css"', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/home')['status'], 200)
        script = self.raw.call('GET', '/home/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn('spaceHref', script['body'].decode())
        self.assertEqual(self.raw.call('GET', '/home/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/home/missing')['status'], 404)

    def test_platform_does_not_serve_the_runtime_workspace_overview(self):
        personal = self.client.call('POST', '/v1/personal-agent')
        self.assertEqual(personal['status'], 201)
        workspace = personal['body']['personal_agent']['workspace']['id']
        overview = f'/v1/workspaces/{workspace}/overview?limit=5'
        bob = Client(self.app, peer='127.0.0.2')
        self.assertEqual(bob.register('bob')['status'], 201)
        for actor, client in (('owner', self.client), ('other account', bob), ('signed-out', Client(self.app))):
            with self.subTest(actor=actor):
                result = client.call('GET', overview)
                self.assertEqual(result['status'], 410)
                self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')
                self.assertNotIn('workspace', result['body'])
                self.assertNotIn('recent_conversations', result['body'])


class HomeSessionTests(unittest.TestCase):
    def test_home_session_reads_only_the_signed_in_personal_card(self):
        with tempfile.TemporaryDirectory() as directory:
            api = App(Store(Path(directory) / 'state'), Config(ORIGIN, allow_registration=True))
            app = SettingsPage(api)
            alice = Client(app)
            self.assertEqual(alice.register('alice')['status'], 201)
            path = '/v1/auth/session?include=home'
            checked = alice.call('GET', path)
            self.assertEqual(checked['status'], 200)
            self.assertEqual(checked['body']['home'], {'runtime_state': 'unmanaged', 'personal_agent': None})
            self.assertIsNone(alice.call('GET', '/v1/personal-agent')['body']['personal_agent'])
            self.assertNotIn('home', alice.call('GET', '/v1/auth/session')['body'])
            binding = alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
            card = alice.call('GET', path)['body']['home']['personal_agent']
            self.assertEqual(card['workspace'], binding['workspace'])
            self.assertEqual(card['agent'], {field: binding['agent'][field] for field in ('id', 'name', 'summary')})
            self.assertEqual(card['look'], binding['look'])
            bob = Client(app, peer='127.0.0.2')
            self.assertEqual(bob.call('GET', path)['status'], 401)
            self.assertEqual(bob.register('bob')['status'], 201)
            self.assertIsNone(bob.call('GET', path)['body']['home']['personal_agent'])


if __name__ == '__main__':
    unittest.main()

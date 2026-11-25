"""Skills library pages and the retired platform installation routes."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class SkillsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.app = SettingsPage(self.api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_library_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/skills')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('main-panel', 'skills-search', 'skills-list', 'skills-empty', 'skills-error'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('技能库', html)
        self.assertIn('id="skills-permission"', html)
        self.assertIn('收藏会保存到「我的技能库」', html)
        self.assertIn('我已阅读此版本的指令，并允许模型使用', html)
        self.assertIn('<dialog id="skills-review"', html)
        self.assertIn('自己的 DS-Bot', html)
        self.assertIn('没有匹配的技能', html)
        self.assertIn('aria-label="搜索技能"', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/skills/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/skills/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/skills', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/skills', query='q=会议')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/skills')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/skills/missing')['status'], 404)
        script = self.raw.call('GET', '/skills/app.mjs')['body'].decode()
        self.assertIn('/v1/skills/catalog', script)
        self.assertIn('/v1/skills/bindings', script)
        self.assertIn('export function filterSkills', script)
        self.assertIn('/v1/skills/installed', script)
        self.assertIn('X-CSRF-Token', script)
        self.assertNotIn('export function toggleSkill', script)
        self.assertIn('!permission.checked || reviewInstall.hidden', script)
        self.assertIn('csrfCookie(document.cookie)', script)
        self.assertNotIn('innerHTML', script)

    def test_every_shell_page_links_the_skills_entry(self):
        pages = [path.parent.name for path in Path(__file__).absolute().parent.parent.joinpath(
            'flybot_workspace', 'static').glob('*/index.html')]
        self.assertIn('skills', pages)
        for name in pages:
            html = self.raw.call('GET', '/' + name)['body'].decode()
            if 'href="/agents"' not in html:
                continue
            self.assertIn('href="/skills"', html, name)

    def test_the_install_allowlist_matches_the_authoritative_catalogue(self):
        from flybot_workspace import skill_installs, skill_packages
        ids = sorted(item['id'] for item in skill_packages.catalogue())
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sorted(skill_installs.SKILL_IDS), ids)

    def test_platform_refuses_catalog_and_install_state(self):
        bob = Client(self.app, peer='127.0.0.2')
        self.assertEqual(bob.register('bob')['status'], 201)
        installed = '/v1/skills/installed'
        requests = (
            ('GET', '/v1/skills/catalog', None),
            ('GET', '/v1/skills/bindings', None),
            ('GET', installed, None),
            ('POST', installed, {'skill': 'meeting-notes'}),
            ('DELETE', installed, {'skill': 'meeting-notes'}),
        )
        for actor, client in (('alice', self.client), ('bob', bob), ('signed-out', Client(self.app))):
            for method, path, body in requests:
                with self.subTest(actor=actor, method=method, path=path):
                    result = client.call(method, path, body)
                    self.assertEqual(result['status'], 410)
                    self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')
        with self.api.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM skill_installs').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()

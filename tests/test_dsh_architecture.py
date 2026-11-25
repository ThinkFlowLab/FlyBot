"""Drift guards for the accepted DS-Bot/DSH target architecture.

These checks are static and dependency-free: they read the committed route table,
feature directories and the platform fence. They never import or start the web app.
"""
import unittest
from pathlib import Path

from flybot_workspace import dsbot_gateway


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
ARCHITECTURE = DOCS / 'ARCHITECTURE.md'
PLUGIN_CONTRACT = DOCS / 'DSBOT_PLUGIN_ARCHITECTURE.md'
FEATURES = ROOT / 'runtime' / 'flybot-workspace-web' / 'features'
LIB_C = ROOT / 'runtime' / 'flybot-workspace-web' / 'lib' / 'c'
APP = ROOT / 'flybot_workspace' / 'app.py'

# Pages that are deliberate redirects instead of standalone assets. `/messenger`
# resolves to `/chat` in both flybot_workspace/settings_page.py and
# runtime/flybot-workspace-web/src/pages.js.
PAGE_ALIASES = {'messenger': 'chat'}

# Legacy /v1 compatibility for these Stream C features is implemented in lib/c.
C_FEATURES = frozenset({
    'discover', 'invites', 'members', 'messenger', 'overview', 'shares',
    'social', 'team-templates', 'teams',
})

# MOVED_APIS must not name platform-only work. Add a feature here only with a
# documented exception in docs/DSBOT_PLUGIN_ARCHITECTURE.md.
PLATFORM_EXCEPTIONS = frozenset()


class DSHTargetArchitectureTest(unittest.TestCase):
    def test_architecture_links_the_plugin_contract(self):
        self.assertTrue(PLUGIN_CONTRACT.is_file(), 'missing docs/DSBOT_PLUGIN_ARCHITECTURE.md')
        text = ARCHITECTURE.read_text('utf-8')
        self.assertIn('DSBOT_PLUGIN_ARCHITECTURE.md', text)
        self.assertIn('@flybot-workspace/web', text)
        self.assertIn('Bot Social', text)

    def test_every_moved_page_has_a_real_static_entrypoint(self):
        routes = dsbot_gateway.load_routes()
        missing = []
        for page in sorted(routes['moved_pages']):
            target = PAGE_ALIASES.get(page, page)
            if not (ROOT / 'flybot_workspace' / 'static' / target / 'index.html').is_file():
                missing.append(page if target == page else f'{page}->{target}')
        self.assertEqual(missing, [], 'moved_pages without a real static entrypoint: '
                                      + ', '.join(missing))

    def test_every_moved_api_feature_has_a_runtime_implementation(self):
        self.assertTrue(LIB_C.is_dir(), 'missing runtime/flybot-workspace-web/lib/c')
        missing = []
        for feature in sorted({feature for _, feature in dsbot_gateway.MOVED_APIS}):
            if (FEATURES / feature).is_dir():
                continue
            if feature in C_FEATURES and (LIB_C / 'legacy-v1.js').is_file():
                continue
            if feature in PLATFORM_EXCEPTIONS:
                continue
            missing.append(feature)
        self.assertEqual(missing, [], 'MOVED_APIS features without a plugin implementation: '
                                      + ', '.join(missing))

    def test_platform_keeps_the_moved_route_fence(self):
        source = APP.read_text('utf-8')
        self.assertRegex(source, r'moved_api\(path\)')
        self.assertRegex(source, r"refuse\(410,\s*'moved_to_dsbot'")


if __name__ == '__main__':
    unittest.main()

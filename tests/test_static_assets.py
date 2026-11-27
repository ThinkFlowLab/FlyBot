"""The static allowlist and the static/ tree must not drift apart."""
from pathlib import Path
import unittest

from flybot_workspace.settings_page import SettingsPage

STATIC = Path(__file__).resolve().parent.parent / 'flybot_workspace' / 'static'

# Files under flybot_workspace/static/ that stay in the tree without being served.
# Keep this table short and give every entry a reason. A file a page loads belongs in
# SettingsPage.ASSETS, and a file nothing loads should be deleted instead.
UNSERVED = {
    'team-runs/index.html': 'the /team-runs page route is not registered yet; tracked separately',
}

# The closed set of extensions the allowlist may serve. A suffix outside this table fails
# instead of falling back to the declared type: an untyped asset is a hole, not a pass.
CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
}


class StaticAssetAllowlistTests(unittest.TestCase):
    def test_every_static_file_is_served_or_explicitly_unserved(self):
        served = {(directory, name) for directory, name, _ in SettingsPage.ASSETS.values()}
        unserved = []
        for path in sorted(STATIC.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(STATIC).as_posix()
            directory = path.parent.relative_to(STATIC).as_posix()
            directory = '' if directory == '.' else directory
            if (directory, path.name) in served or relative in UNSERVED:
                continue
            unserved.append(relative)
        self.assertEqual(
            [], unserved,
            'static files that no ASSETS entry serves: ' + ', '.join(unserved)
            + '; add each URL to SettingsPage.ASSETS or to UNSERVED with a reason')

    def test_every_served_asset_exists(self):
        missing = sorted(
            f'{directory}/{name}'
            for directory, name, _ in SettingsPage.ASSETS.values()
            if not (STATIC / directory / name).is_file())
        self.assertEqual([], missing, 'ASSETS entries with no file: ' + ', '.join(missing))

    def test_every_served_asset_has_the_content_type_its_extension_needs(self):
        wrong = []
        for url, (_, name, content_type) in SettingsPage.ASSETS.items():
            expected = CONTENT_TYPES.get(Path(name).suffix)
            if expected is None:
                wrong.append(f'{url} -> {name} has no known content type')
            elif content_type != expected:
                wrong.append(f'{url} -> {content_type}, expected {expected}')
        self.assertEqual([], sorted(wrong),
                         'ASSETS entries with the wrong content type: ' + ', '.join(sorted(wrong)))

    def test_non_html_assets_use_their_canonical_url(self):
        wrong = []
        for url, (directory, name, _) in SettingsPage.ASSETS.items():
            if Path(name).suffix == '.html':
                continue
            canonical = f'/{directory}/{name}' if directory else f'/{name}'
            if url != canonical:
                wrong.append(f'{url} -> {canonical}')
        self.assertEqual([], sorted(wrong),
                         'non-HTML ASSETS entries whose URL is not /<directory>/<name>: '
                         + ', '.join(sorted(wrong)))

    def test_unserved_entries_describe_existing_files(self):
        stale = sorted(relative for relative in UNSERVED if not (STATIC / relative).is_file())
        self.assertEqual([], stale, 'UNSERVED entries with no file: ' + ', '.join(stale))
        self.assertTrue(all(UNSERVED.values()), 'every UNSERVED entry needs a reason')


if __name__ == '__main__':
    unittest.main()

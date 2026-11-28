"""The account Help submenu links to the current support and legal pages."""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PAGES = sorted(
    path for path in (ROOT / 'flybot_workspace' / 'static').glob('*/index.html')
    if path.parent.name not in {'about', 'register'}
)
MENU = (
    ('帮助中心', '/help'),
    ('服务条款', '/terms'),
    ('隐私政策', '/privacy'),
)


class HelpMenu(HTMLParser):
    """Collect the entries of `<div id="help-menu">` as (tag, attrs, text) triples."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False
        self.depth = 0
        self.entries = []
        self._current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.inside:
            if tag == 'div':
                self.depth += 1
            elif tag in ('a', 'button'):
                self._current = (tag, attrs, '')
        elif tag == 'div' and attrs.get('id') == 'help-menu':
            self.inside = True
            self.depth = 1

    def handle_endtag(self, tag):
        if not self.inside:
            return
        if tag == 'div':
            self.depth -= 1
            if self.depth == 0:
                self.inside = False
        elif tag in ('a', 'button') and self._current and self._current[0] == tag:
            self.entries.append((*self._current[:2], self._current[2].strip()))
            self._current = None

    def handle_data(self, data):
        if self.inside and self._current is not None:
            self._current = (*self._current[:2], self._current[2] + data)


def help_entries(page):
    parser = HelpMenu()
    parser.feed(page.read_text(encoding='utf-8'))
    return parser.entries


class ShellHelpEntryTests(unittest.TestCase):
    def test_feature_guide_is_linked_from_help_center(self):
        page = ROOT / 'flybot_workspace/static/help/index.html'
        self.assertIn('<a href="/guide">功能指引</a>', page.read_text(encoding='utf-8'))
        for shell_page in PAGES:
            with self.subTest(page=shell_page):
                self.assertFalse(any(attrs.get('href') == '/guide' for _, attrs, _ in help_entries(shell_page)))

    def test_registration_footer_keeps_the_public_help_and_legal_links(self):
        page = ROOT / 'flybot_workspace/static/register/index.html'
        html = page.read_text(encoding='utf-8')
        _, footer = html.split('<footer class="auth-legal">', 1)
        footer = footer.split('</footer>', 1)[0]
        for name, href in MENU:
            self.assertIn(f'<a href="{href}">{name}</a>', footer)

    def test_the_served_pages_are_real_menu_links_in_the_target_order(self):
        menu_hrefs = {href for _, href in MENU}
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                for name, href in MENU:
                    matching = [e for e in entries
                                if e[0] == 'a' and e[1].get('href') == href and e[2] == name]
                    self.assertEqual(
                        len(matching), 1,
                        f'{page}: the help menu has {len(matching)} 「{name}」 links to {href}: {entries}')
                    tag, attrs, _text = matching[0]
                    self.assertEqual(tag, 'a', f'{page}: 「{name}」 is still a {tag}, not a link: {attrs}')
                    self.assertEqual(attrs.get('role'), 'menuitem',
                                     f'{page}: 「{name}」 is not a menu item: {attrs}')
                    self.assertNotIn('disabled', attrs, f'{page}: 「{name}」 is still disabled: {attrs}')
                for tag, attrs, text in entries:
                    if '未实现' in (attrs.get('title') or ''):
                        self.fail(f'{page}: a placeholder survived next to the real pages: {(tag, attrs, text)}')
                ordered = [(attrs.get('href'), text) for tag, attrs, text in entries
                           if tag == 'a' and attrs.get('href') in menu_hrefs]
                self.assertEqual(
                    ordered, [(href, name) for name, href in MENU],
                    f'{page}: the menu entries are out of order: {entries}')


if __name__ == '__main__':
    unittest.main()

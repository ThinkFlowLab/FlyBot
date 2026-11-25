"""The account menu's Help submenu points at the pages we now serve.

`#137` pointed its first item at `/guide` but kept the name 「帮助中心」, so the entry promised a
billing/support FAQ while the landing page is a feature guide. `#306`/`#307` added the real
`/help`, `/terms` and `/privacy` pages, so the placeholder with `title="未实现…"` became a broken
promise in the other direction: the menu said a page was missing while the page was served.
These tests read the static pages as markup, not through a browser: every shell page must carry
exactly one 帮助中心 link to `/help`, one 功能指引 link to `/guide`, one 服务条款 link to `/terms`
and one 隐私政策 link to `/privacy`, all as `role="menuitem"` anchors in that order, and no
`未实现` placeholder may survive. A later shell page must carry the same entries or the count
check fails. The standalone about and registration pages use their own navigation.
"""
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
    ('功能指引', '/guide'),
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
    def test_every_shell_page_links_the_guide_under_its_own_name(self):
        self.assertEqual(len(PAGES), 21, f'expected the 21 pages with the account menu, found {[str(p) for p in PAGES]}')
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                all_guide = [e for e in entries if e[0] == 'a' and e[1].get('href') == '/guide']
                self.assertEqual(
                    len(all_guide), 1,
                    f'{page}: the help menu has {len(all_guide)} links to /guide: {all_guide}')
                guides = [e for e in entries
                          if e[0] == 'a' and e[1].get('href') == '/guide' and e[2] == '功能指引']
                self.assertEqual(
                    len(guides), 1,
                    f'{page}: the help menu has no 「功能指引」 link to /guide: {entries}')
                tag, attrs, text = guides[0]
                self.assertEqual(text, '功能指引', f'{page}: the guide link is misnamed: {text!r}')
                self.assertEqual(attrs.get('role'), 'menuitem', f'{page}: the guide link is not a menu item: {attrs}')

    def test_registration_footer_keeps_the_public_help_and_legal_links(self):
        page = ROOT / 'flybot_workspace/static/register/index.html'
        html = page.read_text(encoding='utf-8')
        _, footer = html.split('<footer class="auth-legal">', 1)
        footer = footer.split('</footer>', 1)[0]
        for name, href in MENU:
            if href != '/guide':
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

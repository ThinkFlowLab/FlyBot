"""Memory page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class MemoryPageServingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/memory')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('记忆', html)
        self.assertIn('新建', html)
        self.assertIn('id="dir-collapse"', html)
        self.assertIn('收起侧边栏', html)
        self.assertIn('id="dir-expand"', html)
        self.assertIn('展开侧边栏', html)
        self.assertIn('id="dir-title"', html)
        self.assertIn('+ 新建', html)
        self.assertIn('class="view-icon"', html)
        self.assertIn('placeholder="搜索主题……"', html)
        self.assertIn('下一步行动', html)
        self.assertIn('总览', html)
        self.assertIn('我的资料', html)
        self.assertIn('我的作品', html)
        self.assertIn('href="/space"', html)
        self.assertIn('我的会议', html)
        self.assertIn('href="/space?view=meetings"', html)
        self.assertNotIn('data-view="meetings"', html)
        self.assertNotIn('id="meetings-panel"', html)
        self.assertNotIn('<button type="button" data-view="meetings"', html)
        self.assertIn('话题亮点', html)
        self.assertIn('id="memory-capture-toggle"', html)
        self.assertIn('id="memory-profile-form"', html)
        self.assertIn('做梦', html)
        self.assertIn('Professional Profile', html)
        self.assertIn('Work Style', html)
        self.assertIn('Communication &amp; Writing Style', html)
        self.assertIn('暂无行动。', html)
        self.assertIn('id="action-search"', html)
        self.assertIn('id="action-follow-up"', html)
        self.assertIn('id="new-action-open"', html)
        self.assertIn('id="new-action-form"', html)
        self.assertIn('id="new-action-form" hidden', html)
        css = self.raw.call('GET', '/memory/app.css')['body'].decode()
        self.assertIn('.memory-views a[aria-current="page"]', css)
        self.assertIn('flex-direction: column', css)
        self.assertIn('var(--ot-accent-soft)', css)
        self.assertIn('.dir-title', css)
        self.assertIn('#new-page', css)
        self.assertIn('.view-icon', css)
        self.assertIn('href="/memory?page=profile"', html)
        self.assertIn('href="/memory?page=todos"', html)
        self.assertNotIn('Develops and maintains software', html)
        self.assertNotIn('Teamily Wiki', html)
        self.assertNotIn('Welcome to Teamily', html)
        self.assertIn('data-filter="updated"', html)
        self.assertIn('id="graph-canvas"', html)
        self.assertIn('id="graph-empty"', html)
        self.assertIn('id="graph-empty" class="graph-empty" hidden', html)
        self.assertIn('创建两个或更多记忆页后，这里会把它们连成图谱', html)
        self.assertIn('id="graph-empty-new"', html)
        self.assertIn('新建记忆页', html)
        self.assertIn('class="graph-hint"', html)
        self.assertIn('选择节点打开', html)
        self.assertIn('class="graph-hover-hint"', html)
        self.assertIn('id="graph-hover-card"', html)
        self.assertIn('class="graph-hover-title"', html)
        self.assertIn('也可以在编辑器里添加连接。', html)
        self.assertNotIn('尚未实现这些手势', html)
        self.assertIn('id="topic-list"', html)
        self.assertIn('id="memory-list"', html)
        self.assertIn('id="action-list"', html)
        self.assertIn('id="overview-panel"', html)
        self.assertIn('data-view="overview"', html)
        self.assertNotIn('id="new-title"', html)
        self.assertIn('id="editor-form"', html)
        self.assertIn('id="action-editor-form"', html)
        self.assertIn('/v1/workspaces', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        self.assertIn("script-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/memory/app.mjs')
        style = self.raw.call('GET', '/memory/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        js = script['body'].decode()
        css = style['body'].decode()
        self.assertIn('export function directoryGroups', js)
        self.assertIn('export function applyDirectoryCollapsed', js)
        self.assertIn('export function topicTag', js)
        self.assertIn('export function memoryPageMeta', js)
        self.assertIn('export function graphPreviewModel', js)
        self.assertIn('export function graphEmptyStateVisible', js)
        self.assertIn('GRAPH_EMPTY_MESSAGE', js)
        self.assertIn('export function bindGraphNodeGestures', js)
        self.assertIn('GRAPH_HOVER_DELAY_MS', js)
        self.assertIn('dir-collapse', js)
        self.assertIn('memory-page-link', js)
        self.assertIn('memory-page-preview', js)
        self.assertIn('memory-page-icon', js)
        self.assertIn('memory-topic-group', js)
        self.assertNotIn('Teamily Wiki', js)
        self.assertNotIn('Welcome to Teamily', js)
        self.assertNotIn('Welcome to my wiki', js)
        self.assertIn('memory-topic-group', css)
        self.assertIn('memory-page-meta', css)
        self.assertIn('memory-page-preview', css)
        self.assertIn('memory-page-icon', css)
        self.assertIn('.graph-hint', css)
        self.assertIn('.graph-empty', css)
        self.assertIn('.graph-empty[hidden]', css)
        self.assertIn('.graph-hover-card', css)
        self.assertEqual(self.raw.call('GET', '/memory/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/memory', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/memory', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory', query='page=overview')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory', query='page=profile&x=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory/app.mjs', query='page=profile')['status'], 400)
        for query in ('page=profile', 'page=todos'):
            page = self.raw.call('GET', '/memory', query=query)
            self.assertEqual(page['status'], 200, query)
            self.assertIn('我的资料', page['body'].decode())
        self.assertEqual(self.raw.call('POST', '/memory')['status'], 405)

    def test_memory_citation_queries_load_exact_records_and_reject_external_returns(self):
        workspace, agent, conversation, message, memory = (str(n) * 32 for n in range(1, 6))
        origin = f'{workspace}.{agent}.{conversation}'
        base = f'workspace={workspace}'
        target = f'{base}&page={memory}'
        for query in (base, f'page=candidates&{base}', target,
                      f'{target}&revision=2&from={origin}.{message}',
                      f'{base}&page=profile&from={origin}',
                      f'{base}&page=todos&action={memory}&from={origin}'):
            with self.subTest(query=query):
                self.assertEqual(self.raw.call('GET', '/memory', query=query)['status'], 200)
        for query in (f'{target}&from=https%3A%2F%2Fevil.test',
                      f'{target}&from={origin}&from={origin}',
                      f'{target}&revision=0002', f'{target}&revision=123456789',
                      f'{base}&page=candidates&from={origin}', f'{base}&page=profile&action={memory}',
                      f'page={memory}&from={origin}', f'{target}&workspace={workspace}'):
            with self.subTest(query=query):
                self.assertEqual(self.raw.call('GET', '/memory', query=query)['status'], 400)

    def test_the_dream_button_asks_the_server_and_can_be_declined(self):
        page = self.raw.call('GET', '/memory')
        html = page['body'].decode()
        self.assertIn('id="dream-page"', html)
        self.assertIn('id="dream-accept"', html)
        self.assertIn('id="dream-ignore"', html)
        self.assertIn('id="dream-panel"', html)
        js = self.raw.call('GET', '/memory/app.mjs')['body'].decode()
        self.assertIn('/dream', js)
        self.assertIn('已忽略，原文没有改动。', js)

    def test_platform_wrapper_defers_memory_reads_and_writes_to_dsbot(self):
        path = f'/v1/workspaces/{"a" * 32}/memory'
        for method, body in (('GET', None), ('POST', {'title': 'Brief', 'body': 'Hello'})):
            with self.subTest(method=method):
                response = self.client.call(method, path, body)
                self.assertEqual(response['status'], 410)
                self.assertEqual(response['body']['error']['code'], 'moved_to_dsbot')

    def test_directory_search_filters_in_place_and_keeps_open_editor(self):
        page = self.raw.call('GET', '/memory')
        html = page['body'].decode()
        self.assertIn('id="search"', html)
        self.assertIn('placeholder="搜索主题……"', html)
        self.assertIn('这个工作区还没有记忆页。', html)
        script = self.raw.call('GET', '/memory/app.mjs')
        source = script['body'].decode()
        self.assertNotIn("addEventListener('input', () => loadWorkspace())", source)
        self.assertIn("searchInput.addEventListener('input', event =>", source)
        self.assertIn('searchDirectory({delay: 220})', source)
        self.assertIn('没有匹配的记忆页。试试其他关键词。', source)
        self.assertIn("event.key === 'Escape'", source)
        self.assertIn('memoryDirectoryQuery', source)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/memory_search.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_graph_empty_state_explains_how_to_get_a_graph(self):
        page = self.raw.call('GET', '/memory')
        html = page['body'].decode()
        self.assertIn('id="graph-empty" class="graph-empty" hidden', html)
        self.assertIn('创建两个或更多记忆页后，这里会把它们连成图谱', html)
        js = self.raw.call('GET', '/memory/app.mjs')['body'].decode()
        self.assertIn('export function graphEmptyStateVisible', js)
        self.assertIn("getElementById('graph-empty-new')", js)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/memory_graph_empty.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)



if __name__ == '__main__':
    unittest.main()


class MemoryProfileWorkspaceSwitchTests(unittest.TestCase):
    def test_workspace_switch_invalidates_previous_profile_before_loading(self):
        source = (Path(__file__).resolve().parents[1] / 'flybot_workspace/static/memory/app.mjs').read_text()
        handler = source.split("workspaceSelect.addEventListener('change'", 1)[1].split('});', 1)[0]
        self.assertLess(handler.index('invalidateMemoryProfile()'), handler.index('await loadWorkspace()'))
        helper = source.split('function invalidateMemoryProfile()', 1)[1].split('\n  }', 1)[0]
        self.assertIn('profileRevision = null', helper)
        self.assertIn('profileRequest += 1', helper)
        self.assertIn('save.disabled = true', helper)

"""Agents page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest

from flybot_workspace import discover
from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class AgentsPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/agents')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('智能体', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="instructions"', html)
        self.assertIn('id="chat-panel"', html)
        self.assertIn('id="open-in-chat"', html)
        self.assertNotIn('id="new-conversation"', html)
        self.assertIn('id="homepage-panel"', html)
        self.assertIn('id="manage-public-homepage"', html)
        self.assertIn('name="quick_starts"', html)
        self.assertIn('/v1/workspaces', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        script = self.raw.call('GET', '/agents/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn(b'/v1/workspaces/', script['body'])
        self.assertIn(b'/chat#workspace=', script['body'])
        self.assertNotIn(b'/conversations', script['body'])
        self.assertIn(b'/discover?', script['body'])
        self.assertNotIn(b'/homepage', script['body'])
        self.assertIn(b'Idempotency-Key', script['body'])
        self.assertEqual(self.raw.call('GET', '/agents/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/agents/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/agents', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/agents', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/agents')['status'], 405)

    def test_category_and_team_template_deep_links_are_the_only_accepted_queries(self):
        page = self.raw.call('GET', '/agents', query='category=design')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        slugs = re.findall(r'data-category="([a-z-]+)"', html)
        self.assertEqual(slugs, ['all', *[slug for slug, _label in discover.AGENT_CATEGORIES]])
        for query in ('tab=teams', 'tab=teams&new=1'):
            self.assertEqual(self.raw.call('GET', '/agents', query=query)['status'], 200)
        for bad in ('category=not-a-category', 'category=', 'category=design&x=1',
                    'x=1', 'category=Design', 'category=design&category=sales',
                    'tab=agents', 'new=1', 'tab=teams&new=2', 'tab=teams&new=1&x=1'):
            self.assertEqual(self.raw.call('GET', '/agents', query=bad)['status'], 400, bad)

    def test_platform_wrapper_leaves_agent_directory_to_the_runtime(self):
        path = f'/v1/workspaces/{"a" * 32}/agents'
        for method, body in (('GET', None), ('POST', {'name': '目录助手'})):
            result = self.client.call(method, path, body)
            self.assertEqual(result['status'], 410, result)
            self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')

    def test_directory_search_filters_in_place_and_preserves_chat_entry(self):
        page = self.raw.call('GET', '/agents')
        html = page['body'].decode()
        self.assertIn('id="agent-search"', html)
        self.assertIn('id="agents-count"', html)
        self.assertIn('这个工作区还没有智能体。', html)
        script = self.raw.call('GET', '/agents/app.mjs')
        source = script['body'].decode()
        self.assertNotIn("addEventListener('input', () => loadWorkspace())", source)
        self.assertIn("addEventListener('input', () => renderDirectory())", source)
        self.assertIn('没有匹配的智能体。试试其他关键词。', source)
        self.assertIn("event.key !== 'Escape'", source)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/agents_search.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_directory_creator_filter_is_enabled_and_filters_by_creator(self):
        page = self.raw.call('GET', '/agents')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('id="creator-filter"', html)
        self.assertNotIn('id="creator-filter" disabled', html)
        self.assertNotIn('未实现：创建者筛选', html)
        script = self.raw.call('GET', '/agents/app.mjs')
        self.assertEqual(script['status'], 200)
        source = script['body'].decode()
        self.assertIn("getElementById('creator-filter')", source)
        self.assertIn('没有符合筛选的智能体', source)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/agents_creator_filter.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()


# The search box is wired in static/agents/app.mjs, so its behaviour cannot be
# read off the HTML. This harness mounts the real module against a fake document
# and an injected fetch, then drives the recorded acceptance cases: typing sends
# no request, the selected agent's chat link survives typing, the empty note
# distinguishes "no match" from a vacant directory, the count follows the query,
# and Escape clears the box and keeps focus. It runs under node, which the same
# CI job already installs for the node --test steps.
SEARCH_HARNESS = r"""const appUrl = process.env.OT_AGENTS_APP;
const scenario = process.env.FLYBOT_WORKSPACE_SCENARIO;
const assert = (await import('node:assert/strict')).default;

let focused = null;
class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {};
    this.className = ''; this.hidden = false; this.disabled = false; this.value = '';
    this.textContent = ''; this.attributes = {}; this.type = ''; this.href = '';
    this.elements = new Proxy({}, {get: (target, key) => (target[key] ||= {value: ''})});
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      if (node.tagName === 'option' && this.value === '') this.value = node.value;
    }
  }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelector() { return new El('button'); }
  focus() { focused = this; }
  get options() { return this.children; }
  closest() { return null; }
}

const elements = new Map();
const doc = {
  cookie: '',
  readyState: 'complete',
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new El());
    return elements.get(id);
  },
  createElement(tag) { return new El(tag); },
  querySelectorAll() { return []; },
};
const el = id => doc.getElementById(id);

const agents = scenario === 'vacant' ? [] : [
  {id: 'a1', name: 'Beta Helper', summary: '写文案', instructions: 'x', revision: 1, homepage: {visibility: 'restricted'}},
  {id: 'a2', name: 'Alpha Desk', summary: '整理邮件', instructions: 'y', revision: 1, homepage: {visibility: 'restricted'}},
];
const requests = [];
const json = (status, body) => ({status, json: async () => body});
const fetcher = async (path, options) => {
  requests.push([path, options.method]);
  if (path === '/v1/auth/session') return json(200, {user: {id: 'u1', username: 'alice'}});
  if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'w1', name: 'Desk'}]});
  if (path === '/v1/workspaces/w1') return json(200, {workspace: {id: 'w1', owner_id: 'u1'}});
  if (path === '/v1/workspaces/w1/members') return json(200, {items: [{user_id: 'u1', role: 'owner'}]});
  if (path === '/v1/workspaces/w1/agents?limit=100') return json(200, {items: agents});
  for (const agent of agents) {
    if (path === `/v1/workspaces/w1/agents/${agent.id}`) return json(200, {agent});
  }
  return json(404, {});
};

const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
el('workspace').value = 'w1';
const {mount} = await import(appUrl);
await mount(doc, {fetcher});
await settle();

const search = el('agent-search');
const type = async text => { search.value = text; search.handlers.input({target: search}); await settle(); };

if (scenario === 'typing') {
  const before = requests.length;
  await type('be');
  assert.equal(requests.length, before, 'typing in the search box sent ' + (requests.length - before) + ' request(s)');
  assert.equal(el('agent-list').children.length, 1, 'the list was not filtered down to the matching agent');
  await type('zzz');
  assert.equal(requests.length, before, 'typing sent another request');
  assert.equal(el('agent-list').children.length, 0, 'the list still shows non-matching agents');
} else if (scenario === 'chat') {
  el('agent-list').handlers.click({target: {closest: () => ({dataset: {id: 'a1'}})}});
  await settle();
  assert.equal(el('chat-panel').hidden, false);
  const title = el('chat-title').textContent;
  const chatLink = el('open-in-chat').href;
  assert.match(title, /Beta Helper/);
  assert.equal(chatLink, '/chat#workspace=w1&agent=a1');
  assert.equal(requests.some(([path]) => path.includes('/conversations')), false);
  const before = requests.length;
  await type('alpha');
  assert.equal(el('agent-list').children.length, 1);
  assert.equal(el('chat-panel').hidden, false);
  assert.equal(el('chat-title').textContent, title);
  assert.equal(el('open-in-chat').href, chatLink);
  assert.equal(requests.length, before);
} else if (scenario === 'empty') {
  assert.equal(el('agents-empty').hidden, true, 'the empty note shows while agents are listed');
  await type('zzz');
  assert.equal(el('agents-empty').hidden, false, 'no empty note for a query with no hits');
  assert.equal(el('agents-empty').textContent, '没有匹配的智能体。试试其他关键词。');
  await type('');
  assert.equal(el('agents-empty').hidden, true);
  assert.equal(el('agent-list').children.length, 2);
} else if (scenario === 'vacant') {
  assert.equal(el('agents-empty').hidden, false);
  assert.equal(el('agents-empty').textContent, '这个工作区还没有智能体。');
  await type('zzz');
  assert.equal(el('agents-empty').textContent, '这个工作区还没有智能体。', 'an empty directory reused the search copy');
  assert.equal(el('agents-count').textContent, '显示 0 个智能体');
} else if (scenario === 'count') {
  assert.equal(el('agents-count').textContent, '显示 2 个智能体', 'the count did not start from the whole directory');
  await type('be');
  assert.equal(el('agents-count').textContent, '显示 1 个智能体', 'the count does not follow the query');
  await type('zzz');
  assert.equal(el('agents-count').textContent, '显示 0 个智能体');
} else if (scenario === 'escape') {
  await type('be');
  assert.equal(el('agent-list').children.length, 1);
  search.handlers.keydown({key: 'Escape', preventDefault() {}});
  await settle();
  assert.equal(search.value, '', 'Escape left the query in the box');
  assert.equal(el('agent-list').children.length, 2, 'Escape did not restore the full list');
  assert.equal(focused, search, 'focus left the search box after Escape');
} else {
  throw new Error('unknown scenario ' + scenario);
}
console.log('scenario ok: ' + scenario);
"""


@unittest.skipUnless(shutil.which('node'), 'the agents page behaviour harness needs node')
class AgentsSearchBehaviourTests(unittest.TestCase):
    """Drive static/agents/app.mjs with a fake document; no browser, no server."""

    def run_scenario(self, scenario):
        script = Path(__file__).resolve().parents[1] / 'flybot_workspace/static/agents/app.mjs'
        env = dict(os.environ, OT_AGENTS_APP=script.as_uri(), FLYBOT_WORKSPACE_SCENARIO=scenario)
        completed = subprocess.run(['node', '--input-type=module', '-e', SEARCH_HARNESS],
                                   capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn('scenario ok: ' + scenario, completed.stdout)

    def test_typing_filters_without_refetching(self):
        self.run_scenario('typing')

    def test_typing_preserves_the_selected_agents_native_chat_link(self):
        self.run_scenario('chat')

    def test_empty_note_distinguishes_no_matches_from_a_vacant_directory(self):
        self.run_scenario('empty')

    def test_vacant_directory_keeps_its_original_copy(self):
        self.run_scenario('vacant')

    def test_directory_count_follows_the_query(self):
        self.run_scenario('count')

    def test_escape_clears_the_query_and_restores_focus(self):
        self.run_scenario('escape')

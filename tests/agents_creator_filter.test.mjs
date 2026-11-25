import assert from 'node:assert/strict';
import test from 'node:test';
import { mount } from '../flybot_workspace/static/agents/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.href = '';
    this.options = [];
    this.elements = {};
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    if (this.tagName === 'SELECT') {
      this.options = this.children;
      if (!this.value && this.children[0]) this.value = this.children[0].value;
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.options = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector(selector) {
    if (selector === 'button[type="submit"]') {
      if (!this._submit) {
        this._submit = new Element('button');
        this._submit.type = 'submit';
      }
      return this._submit;
    }
    return null;
  }
  focus() { this.focused = true; }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'button[data-id]' && node.tagName === 'BUTTON' && node.dataset.id) return node;
      if (selector === 'button[data-conversation]' && node.tagName === 'BUTTON' && node.dataset.conversation) return node;
      node = node.parent;
    }
    return null;
  }
}

function fakeDocument() {
  const elements = new Map();
  const pills = ['all', 'content-creation', 'design', 'operations'].map((slug) => {
    const pill = new Element('button');
    pill.dataset.category = slug;
    return pill;
  });
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'runtime-instance' || id === 'creator-filter' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'agent-search' ? 'input'
          : 'div';
        const el = new Element(tag);
        if (id === 'create-form' || id === 'edit-form') {
          el.elements = {
            id: new Element('input'),
            revision: new Element('input'),
            name: new Element('input'),
            summary: new Element('textarea'),
            instructions: new Element('textarea'),
            category: new Element('select'),
          };
          el.reset = () => { for (const field of Object.values(el.elements)) field.value = ''; };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) {
      return selector === '.filter-row .pill[data-category]' ? pills : [];
    },
  };
  return {doc, el: (id) => doc.getElementById(id), pill: (slug) => pills.find((p) => p.dataset.category === slug)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await flush();
};

function json(status, body) {
  return {status, json: async () => body};
}

// Two members, one agent each; alice also owns a second agent. The directory
// row carries created_by as the user id, exactly as agents.view() does.
function directoryFetcher(requests, {agents} = {}) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  const items = agents || [
    {id: 'ag-writer', name: '写作助手', summary: '帮助起草文案', revision: 1,
      category: 'content-creation', created_by: 'user-1'},
    {id: 'ag-search', name: '检索助手', summary: '查找资料', revision: 1,
      category: 'design', created_by: 'user-1'},
    {id: 'ag-ops', name: '运维助手', summary: '查看发布状态', revision: 1,
      category: 'operations', created_by: 'user-2'},
  ];
  const members = [
    {user_id: 'user-1', username: 'alice', role: 'owner'},
    {user_id: 'user-2', username: 'bob', role: 'admin'},
  ];
  return async (path, options) => {
    requests.push({path, method: (options && options.method) || 'GET'});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1') return json(200, {workspace: space});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: members});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items});
    const agentMatch = /^\/v1\/workspaces\/ws-1\/agents\/([^/?]+)$/.exec(path);
    if (agentMatch) {
      const agent = items.find((row) => row.id === agentMatch[1]);
      return json(200, {agent});
    }
    if (path.endsWith('/runtime')) return json(200, {runtime: null});
    if (path.includes('/instances?limit=100')) return json(200, {items: []});
    if (path.endsWith('/conversations?limit=100')) return json(200, {items: []});
    throw new Error('unexpected ' + path);
  };
}

const names = (el) => el('agent-list').children.map((li) => li.children[1].children[0].textContent);

function withLocation(search, run) {
  const saved = {location: globalThis.location, history: globalThis.history, add: globalThis.addEventListener};
  globalThis.location = {pathname: '/agents', search, hash: ''};
  globalThis.history = {
    pushState(_s, _t, url) { globalThis.location.search = url.slice('/agents'.length); },
    replaceState(_s, _t, url) { globalThis.location.search = url.slice('/agents'.length); },
  };
  globalThis.addEventListener = () => {};
  return Promise.resolve(run()).finally(() => {
    globalThis.location = saved.location;
    globalThis.history = saved.history;
    globalThis.addEventListener = saved.add;
  });
}

function changeCreator(el, id) {
  const filter = el('creator-filter');
  filter.value = id;
  assert.equal(typeof filter.handlers.change, 'function',
    'the creator filter has no change handler');
  filter.handlers.change();
}

test('the creator filter lists each creator once, in name order, and narrows in place', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {doc, el} = fakeDocument();
    await mount(doc, {fetcher: directoryFetcher(requests)});
    await tick();
    assert.deepEqual(names(el), ['写作助手', '检索助手', '运维助手']);
    const filter = el('creator-filter');
    assert.deepEqual(filter.options.map((option) => option.value), ['', 'user-1', 'user-2'],
      'the creator filter does not list 全部 plus each distinct creator');
    assert.deepEqual(filter.options.map((option) => option.textContent), ['全部', 'alice', 'bob'],
      'the creator options are not labelled with usernames in sorted order');
    const before = requests.length;

    changeCreator(el, 'user-2');
    await tick();
    assert.equal(requests.length, before, 'choosing a creator sent ' + (requests.length - before) + ' request(s)');
    assert.deepEqual(names(el), ['运维助手'], 'the directory is not limited to that creator');
    assert.equal(el('agents-count').textContent, '显示 1 个智能体');

    changeCreator(el, '');
    await tick();
    assert.deepEqual(names(el), ['写作助手', '检索助手', '运维助手'], '全部 did not restore every card');
    assert.equal(el('agents-count').textContent, '显示 3 个智能体');
    assert.equal(requests.length, before, 'clearing the creator filter sent a request');
  });
});

test('the creator filter intersects with the category pills', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {doc, el, pill} = fakeDocument();
    await mount(doc, {fetcher: directoryFetcher(requests)});
    await tick();
    const before = requests.length;

    pill('design').handlers.click();
    await tick();
    assert.deepEqual(names(el), ['检索助手'], 'the category pill alone is not filtered');

    changeCreator(el, 'user-2');
    await tick();
    assert.deepEqual(names(el), [], 'design + bob should have no rows');
    assert.equal(el('agents-empty').hidden, false);
    assert.equal(el('agents-empty').textContent, '没有符合筛选的智能体',
      'an empty intersection does not get its own copy');
    assert.equal(el('agents-count').textContent, '显示 0 个智能体');

    changeCreator(el, 'user-1');
    await tick();
    assert.deepEqual(names(el), ['检索助手'], 'design + alice is not the intersection');

    pill('content-creation').handlers.click();
    await tick();
    assert.deepEqual(names(el), ['写作助手'], 'content-creation + alice is not the intersection');
    assert.equal(requests.length, before, 'combining the filters sent ' + (requests.length - before) + ' request(s)');
  });
});

test('rows without a creator keep the whole directory and an empty option list', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {doc, el} = fakeDocument();
    const agents = [
      {id: 'ag-1', name: '旧助手', summary: '', revision: 1, category: null},
      {id: 'ag-2', name: '新助手', summary: '', revision: 1, category: 'design'},
    ];
    await mount(doc, {fetcher: directoryFetcher(requests, {agents})});
    await tick();
    assert.deepEqual(el('creator-filter').options.map((option) => option.value), [''],
      'a directory without created_by invented creator options');
    assert.deepEqual(names(el), ['旧助手', '新助手']);
    assert.equal(el('agents-count').textContent, '显示 2 个智能体');
    assert.equal(el('agents-empty').hidden, true);
  });
});

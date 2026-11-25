import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, readAgentForm, matchesCategory, categoryLabel } from '../flybot_workspace/static/agents/app.mjs';

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
  const pills = ['all', 'content-creation', 'operations', 'sales'].map((slug) => {
    const pill = new Element('button');
    pill.dataset.category = slug;
    return pill;
  });
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'runtime-instance' ? 'select'
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

function directoryFetcher(requests, {agents, conversations, workspaceId = 'ws-1', userId = 'user-1'} = {}) {
  const space = {id: workspaceId, name: 'Desk', owner_id: userId};
  const user = {id: userId, username: 'alice'};
  const base = '/v1/workspaces/' + workspaceId;
  const items = agents || [
    {id: 'ag-writer', name: '写作助手', summary: '帮助起草文案', revision: 1, category: 'content-creation'},
    {id: 'ag-ops', name: '运维助手', summary: '查看发布状态', revision: 1, category: 'operations'},
    {id: 'ag-search', name: '检索助手', summary: '查找资料', revision: 1, category: null},
  ];
  const threads = conversations || [
    {id: 'cv-1', title: '当前对话'},
  ];
  return async (path, options) => {
    requests.push({path, method: (options && options.method) || 'GET',
      body: options && options.body ? JSON.parse(options.body) : undefined});
    if (path === base + '/agents' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return json(201, {agent: {id: 'a'.repeat(32), workspace_id:workspaceId, revision: 1, ...body, homepage: {visibility: 'restricted'}}});
    }
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === base) return json(200, {workspace: space});
    if (path === base + '/members') return json(200, {items: [{user_id:userId, role: 'owner'}]});
    if (path === base + '/agents?limit=100') return json(200, {items});
    const agentMatch = new RegExp(`^${base}/agents/([^/?]+)$`).exec(path);
    if (agentMatch) {
      const agent = items.find((row) => row.id === agentMatch[1]);
      return json(200, {agent});
    }
    if (path.endsWith('/runtime')) return json(200, {runtime: null});
    if (path.includes('/instances?limit=100')) return json(200, {items: []});
    if (path.endsWith('/conversations?limit=100')) return json(200, {items: threads});
    const convo = /^\/v1\/workspaces\/ws-1\/agents\/[^/]+\/conversations\/([^/?]+)$/.exec(path);
    if (convo) {
      return json(200, {
        conversation: {id: convo[1], title: '当前对话'},
        items: [
          {id: 'm-1', role: 'user', body: '你好'},
          {id: 'm-2', role: 'assistant', status: 'succeeded', body: '已收到。'},
        ],
      });
    }
    throw new Error('unexpected ' + path);
  };
}


const names = (el) => el('agent-list').children.map((li) => li.children[1].children[0].textContent);

function withLocation(search, run) {
  const saved = {location: globalThis.location, history: globalThis.history, add: globalThis.addEventListener};
  const pushed = [];
  globalThis.location = {pathname: '/agents', search, hash: ''};
  globalThis.history = {
    pushState(_s, _t, url) { pushed.push(url); globalThis.location.search = url.slice('/agents'.length); },
    replaceState(_s, _t, url) { globalThis.location.search = url.slice('/agents'.length); },
  };
  globalThis.addEventListener = () => {};
  return Promise.resolve(run(pushed)).finally(() => {
    globalThis.location = saved.location;
    globalThis.history = saved.history;
    globalThis.addEventListener = saved.add;
  });
}

test('category helpers match only the selected slug and label it', () => {
  assert.equal(matchesCategory({category: 'sales'}, 'all'), true);
  assert.equal(matchesCategory({category: null}, 'all'), true);
  assert.equal(matchesCategory({category: 'sales'}, 'sales'), true);
  assert.equal(matchesCategory({category: null}, 'sales'), false);
  assert.equal(matchesCategory({category: 'legal'}, 'sales'), false);
  assert.equal(categoryLabel('it-security'), 'IT & Security');
  assert.equal(categoryLabel('nope'), '');
});

test('choosing a category pill narrows the directory in place and 全部 restores it', async () => {
  await withLocation('', async (pushed) => {
    const requests = [];
    const {doc, el, pill} = fakeDocument();
    await mount(doc, {fetcher: directoryFetcher(requests)});
    await tick();
    assert.deepEqual(names(el), ['写作助手', '运维助手', '检索助手']);
    const tag = el('agent-list').children[0].children[1].children[2];
    assert.equal(tag.className, 'category-tag');
    assert.equal(tag.textContent, 'Content Creation');
    assert.equal(el('agent-list').children[2].children[1].children.length, 2);
    const before = requests.length;

    pill('operations').handlers.click();
    await tick();
    assert.equal(requests.length, before);
    assert.deepEqual(names(el), ['运维助手']);
    assert.equal(el('agents-count').textContent, '显示 1 个智能体');
    assert.equal(pill('operations').attributes['aria-pressed'], 'true');
    assert.equal(pushed.at(-1), '/agents?category=operations');

    pill('sales').handlers.click();
    await tick();
    assert.deepEqual(names(el), []);
    assert.equal(el('agents-empty').hidden, false);
    assert.equal(el('agents-empty').textContent, '「Sales」类目下还没有智能体。选「全部」查看其余智能体。');

    el('agent-search').value = '写作';
    el('agent-search').handlers.input();
    pill('content-creation').handlers.click();
    await tick();
    assert.deepEqual(names(el), ['写作助手']);

    el('agent-search').value = '';
    pill('all').handlers.click();
    await tick();
    assert.deepEqual(names(el), ['写作助手', '运维助手', '检索助手']);
    assert.equal(pushed.at(-1), '/agents');
    assert.equal(requests.length, before);
  });
});

test('a ?category= deep link filters on first load', async () => {
  await withLocation('?category=content-creation', async () => {
    const {doc, el} = fakeDocument();
    await mount(doc, {fetcher: directoryFetcher([])});
    await tick();
    assert.deepEqual(names(el), ['写作助手']);
  });
});

test('an exact agent link opens the authorized workspace and never falls back to personal', async () => {
  await withLocation('?category=operations', async () => {
    const personal = {id: 'a'.repeat(32), name: 'Personal', kind:'personal', role:'owner'};
    const team = {id: 'b'.repeat(32), name: 'Team', owner_id: 'user-1'};
    const agent = {id: 'c'.repeat(32), workspace_id: team.id, revision: 1, name: '团队智能体', category: 'operations'};
    const requests = [];
    const base = '/v1/workspaces/' + team.id;
    const fetcher = async (path) => {
      requests.push(path);
      if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
      if (path === '/v1/workspaces?limit=100') return json(200, {items: [personal, team]});
      if (path === '/v1/personal-agent') return json(200, {});
      if (path === base) return json(404, {});
      if (path === base + '/members') return json(200, {items: [{user_id:'user-1',role:'owner'}]});
      if (path === '/v1/workspaces/' + personal.id + '/members') return json(404, {});
      if (path === '/v1/workspaces/' + personal.id + '/agents?limit=100') return json(200, {items: []});
      if (path === base + '/agents?limit=100') return json(200, {items: [agent]});
      if (path === base + '/agents/' + agent.id) return json(200, {agent});
      if (path.endsWith('/api-keys')) return json(200, {items: []});
      assert.fail('Unexpected workspace read: ' + path);
    };
    globalThis.location.hash = '#workspace=' + team.id + '&agent=' + agent.id;
    const exact = fakeDocument();
    exact.doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    await mount(exact.doc, {fetcher});
    assert.equal(exact.el('workspace').value, team.id);
    assert.equal(exact.el('edit-form').elements.name.value, agent.name);
    assert.equal(exact.el('open-in-chat').href, '/chat#workspace=' + team.id + '&agent=' + agent.id);
    assert.deepEqual(names(exact.el), [agent.name]);
    assert.equal(exact.el('open-create').hidden, false);
    assert.ok(!requests.includes(base));
    assert.equal(requests.filter(path => path === base + '/agents/' + agent.id).length, 1);

    requests.length = 0;
    globalThis.location.hash = '#workspace=' + 'd'.repeat(32) + '&agent=' + agent.id;
    const denied = fakeDocument();
    await mount(denied.doc, {fetcher});
    assert.equal(denied.el('workspace').value, '');
    assert.equal(denied.el('open-create').hidden, true);
    assert.equal(denied.el('manage-drawer').hidden, true);
    assert.ok(!requests.some(path => /^\/v1\/workspaces\/[^/]+/.test(path)));
    globalThis.location.hash = '#workspace=' + personal.id;
    const own = fakeDocument();
    own.doc.querySelector = exact.doc.querySelector;
    await mount(own.doc, {fetcher});
    assert.equal(own.el('open-create').hidden, false);
  });
});

test('the create and edit forms carry the category and offer all 17 options', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const workspaceId = 'b'.repeat(32);
  await mount(doc, {fetcher: directoryFetcher(requests, {workspaceId, userId:'c'.repeat(32)})});
  await tick();
  const select = el('create-form').elements.category;
  assert.equal(select.options.length, 17);
  assert.equal(el('edit-form').elements.category.options.length, 17);

  el('open-create').handlers.click();
  const form = el('create-form');
  form.elements.name.value = '销售助手';
  form.elements.category.value = 'sales';
  const fakeData = globalThis.FormData;
  globalThis.FormData = class { constructor(f) { this.f = f; } get(k) { return this.f.elements[k] ? this.f.elements[k].value : null; } };
  try {
    assert.deepEqual(readAgentForm(form), {name: '销售助手', summary: '', instructions: '', category: 'sales'});
    form.elements.category.value = '';
    assert.equal(readAgentForm(form).category, null);
    form.elements.category.value = 'sales';
    await form.handlers.submit({preventDefault() {}, currentTarget: form});
    await tick();
  } finally {
    globalThis.FormData = fakeData;
  }
  const post = requests.find((row) => row.method === 'POST' && row.path === '/v1/workspaces/' + workspaceId + '/agents');
  assert.equal(post.body.category, 'sales');

  const buttons = el('agent-list').children.map(row => row.children[1].children[0]);
  await el('agent-list').handlers.click({target:buttons.find(button => button.dataset.id === 'ag-ops')});
  await tick();
  assert.equal(el('edit-form').elements.category.value, 'operations');
  assert.equal(el('edit-form').elements.category.disabled, false);
});

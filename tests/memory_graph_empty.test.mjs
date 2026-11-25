import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  GRAPH_EMPTY_MESSAGE,
  graphEmptyStateVisible,
  mount,
} from '../flybot_workspace/static/memory/app.mjs';

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
    this.focused = false;
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
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.options = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) {
    delete this.attributes[key];
    if (key === 'href') this.href = '';
  }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector(selector) {
    if (selector === '.graph-node') {
      return this.children.find((child) => child.className === 'graph-node') || null;
    }
    return this.children.find((child) => child.attributes.class === selector || child.className === selector) || null;
  }
  focus() { this.focused = true; }
  click() { return this.handlers.click && this.handlers.click({target: this}); }
}

function fakeDocument() {
  const elements = new Map();
  const body = new Element('body');
  const doc = {
    cookie: '',
    body,
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'action-filter' || id === 'new-action-page' || id === 'link-target' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'search' || id === 'topic-search' || id === 'username' || id === 'password' ? 'input'
          : id === 'graph-canvas' ? 'svg'
          : 'div';
        const el = new Element(tag);
        if (id === 'editor-form') {
          el.hidden = true;
          el.elements = {
            title: new Element('input'),
            body: new Element('textarea'),
            topics: new Element('input'),
          };
        }
        if (id === 'action-editor-form') {
          el.hidden = true;
          el.elements = {
            title: new Element('input'),
            notes: new Element('textarea'),
            status: new Element('select'),
            due: new Element('input'),
            memory_page_id: new Element('select'),
          };
        }
        if (id === 'graph-empty') {
          el.hidden = true;
          el.className = 'graph-empty';
          const copy = new Element('p');
          copy.textContent = GRAPH_EMPTY_MESSAGE;
          const button = new Element('button');
          button.id = 'graph-empty-new';
          button.textContent = '新建记忆页';
          el.append(copy, button);
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_ns, tag) { return new Element(tag); },
    createTextNode(text) {
      const node = new Element();
      node.nodeType = 3;
      node.textContent = text;
      return node;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await flush();
};

function json(status, body) {
  return {status, json: async () => body};
}

function graphFetcher(graph) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  return async (path) => {
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/settings') return json(404, {error: {message: 'missing'}});
    if (path === '/v1/workspaces') return json(200, {items: [space]});
    if (path.split('?')[0] === '/v1/workspaces/ws-1/memory') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/actions') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') return json(200, graph);
    throw new Error('unexpected ' + path);
  };
}

const emptyGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
const oneNode = {
  nodes: [{id: 'pg-1', title: '单独一页'}],
  edges: [],
  topics: [],
  counts: {nodes: 1, edges: 0, topics: 0},
};
const twoNodes = {
  nodes: [{id: 'pg-1', title: '项目简报'}, {id: 'pg-2', title: '运维手册'}],
  edges: [{source: 'pg-1', target: 'pg-2', kind: 'mention'}],
  topics: [],
  counts: {nodes: 2, edges: 1, topics: 0},
};

test('graphEmptyStateVisible hides the hint when a query is present or two pages exist', () => {
  assert.equal(GRAPH_EMPTY_MESSAGE, '创建两个或更多记忆页后，这里会把它们连成图谱');
  assert.equal(graphEmptyStateVisible({nodeCount: 0, query: ''}), true);
  assert.equal(graphEmptyStateVisible({nodeCount: 1, query: '  '}), true);
  assert.equal(graphEmptyStateVisible({nodeCount: 2, query: ''}), false);
  assert.equal(graphEmptyStateVisible({nodeCount: 0, query: 'zzz'}), false);
  assert.equal(graphEmptyStateVisible({nodeCount: 1, query: '简报'}), false);
});

test('renderGraph shows the empty hint for zero or one page and hides it for two', async () => {
  const {doc, el} = fakeDocument();
  const api = await mount(doc, {fetcher: graphFetcher(emptyGraph)});
  await tick();
  assert.equal(el('graph-empty').hidden, false);
  assert.ok(el('graph-empty').children[0].textContent.includes('两个或更多'));

  api.renderGraph(oneNode);
  assert.equal(el('graph-empty').hidden, false);

  api.renderGraph(twoNodes);
  assert.equal(el('graph-empty').hidden, true);
});

test('a topic search miss keeps muted nodes and does not show the empty hint', async () => {
  const {doc, el} = fakeDocument();
  const api = await mount(doc, {fetcher: graphFetcher(twoNodes)});
  await tick();
  assert.equal(el('graph-empty').hidden, true);
  el('topic-search').value = 'zzz-no-match';
  el('topic-search').handlers.input();
  await tick();
  assert.equal(el('graph-empty').hidden, true);
  const classOf = (item) => String(item.attributes.class || item.className || '');
  const items = el('graph-canvas').children[0].children.filter((child) => classOf(child).includes('graph-item'));
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => classOf(item).includes('is-muted')));
  api.renderGraph(twoNodes);
  assert.equal(el('graph-empty').hidden, true);
});


test('the graph create entry posts through the existing flow and opens the created page', async () => {
  const {doc, el} = fakeDocument();
  doc.cookie = 'ot_dev_csrf=fixture-csrf';
  const calls = [];
  const baseFetcher = graphFetcher(emptyGraph);
  const fetcher = async (path, options = {}) => {
    calls.push({path, options});
    if (path === '/v1/workspaces/ws-1/memory' && options.method === 'POST') {
      return json(201, {page: {id: 'pg-created', title: '未命名页面', body: '', topics: [], revision: 1,
        created_by: 'user-1', updated_by: 'user-1'}});
    }
    return baseFetcher(path, options);
  };
  mount(doc, {fetcher});
  await tick();
  assert.equal(el('graph-empty').hidden, false);
  el('graph-empty-new').click();
  await tick();
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/v1/workspaces/ws-1/memory');
  assert.deepEqual(JSON.parse(writes[0].options.body), {title: '未命名页面', body: ''});
  assert.equal(writes[0].options.headers['X-CSRF-Token'], 'fixture-csrf');
  assert.ok(writes[0].options.headers['Idempotency-Key']);
  assert.equal(calls.some(call => call.path.endsWith('/pg-created')), false);
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '未命名页面');
});


test('the graph finishing in the background leaves a newly created page open', async () => {
  const {doc, el} = fakeDocument();
  const fallback = graphFetcher(emptyGraph);
  let finishGraph;
  const fetcher = async (path, options = {}) => {
    if (path.endsWith('/memory/graph')) return new Promise(resolve => { finishGraph = resolve; });
    if (path === '/v1/workspaces/ws-1/memory' && options.method === 'POST') {
      return json(201, {page: {id: 'new', title: '未命名页面', body: '', topics: [], revision: 1}});
    }
    return fallback(path, options);
  };
  const loaded = mount(doc, {fetcher});
  await tick();
  assert.equal(typeof finishGraph, 'function');
  el('new-page').click();
  await tick();
  assert.equal(el('editor-form').hidden, false);
  finishGraph(json(200, {graph: emptyGraph}));
  await loaded;
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('list-panel').dataset.view, 'page');
});

test('late graph and action responses cannot replace the new workspace panels', async () => {
  const {doc, el} = fakeDocument();
  const oldGraph = Promise.withResolvers();
  const oldActions = Promise.withResolvers();
  const requested = new Set();
  const ws = [{id:'ws-1',name:'旧工作区'},{id:'ws-2',name:'新工作区'}];
  const action = (id,title) => ({id,title,status:'open'});
  mount(doc,{fetcher:async path => {
    const plain = path.split('?')[0];
    requested.add(plain);
    if (plain === '/v1/auth/session') return json(200,{user:{id:'user-1',username:'alice'}});
    if (path === '/v1/workspaces?scope=personal') return json(200,{items:[]});
    if (path === '/v1/workspaces') return json(200,{items:ws});
    if (plain.endsWith('/memory/actions')) {
      return plain.includes('/ws-1/') ? oldActions.promise : json(200,{items:[action('new-action','新工作区的行动')]});
    }
    if (plain.endsWith('/memory/graph')) return plain.includes('/ws-1/') ? oldGraph.promise : json(200,twoNodes);
    if (plain.endsWith('/memory')) return json(200,{items:[],cursor:null,total:0});
    return json(404,{});
  }});
  await tick();
  assert.ok(requested.has('/v1/workspaces/ws-1/memory/actions'));
  assert.ok(requested.has('/v1/workspaces/ws-1/memory/graph'), 'graph starts while actions is still pending');
  el('workspace').value = 'ws-2';
  await el('workspace').handlers.change();
  const checkNew = () => {
    assert.equal(el('action-list').children[0]?.children[1]?.dataset.id,'new-action');
    assert.equal(el('graph-counts').children[0]?.children[0]?.textContent,'2');
  };
  checkNew();
  oldActions.resolve(json(200,{items:[action('old-action','不应出现的旧行动')]}));
  oldGraph.resolve(json(200,oneNode));
  await tick();
  checkNew();
});

test('a page save with a lost receipt reconciles without changing a newly opened editor or its draft', async () => {
  const {doc, el} = fakeDocument();
  const save = Promise.withResolvers();
  const first = {id:'pg-1', workspace_id:'ws-1', title:'项目简报', body:'第一份约定', topics:[], revision:1, updated:20};
  const second = {id:'pg-2', workspace_id:'ws-1', title:'运维手册', body:'第二份约定', topics:[], revision:1, updated:10};
  const fallback = graphFetcher(twoNodes);
  const requests = [];
  let firstServerPage = first;
  let firstReads = 0;
  mount(doc,{fetcher:async (path, options={}) => {
    const plain = path.split('?')[0];
    if (plain.endsWith('/memory')) return json(200,{items:[first,second],cursor:null,total:2});
    if (plain.endsWith('/memory/pg-1') && options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      return save.promise;
    }
    if (plain.endsWith('/memory/pg-1')) {
      firstReads += 1;
      return json(200,{page:firstServerPage});
    }
    if (plain.endsWith('/memory/pg-2')) return json(200,{page:second});
    return fallback(path,options);
  }});
  await tick();
  const openRecent = index => el('recent-list').children[index].children[0].click();
  await openRecent(0);
  const form = el('editor-form');
  form.elements.body.value = '已提交的改动';
  const saving = form.handlers.submit({preventDefault() {}});
  assert.equal(requests[0].changes.body,'已提交的改动');
  await openRecent(1);
  form.elements.body.value = '另一页的新草稿';
  firstServerPage = {...first,body:'已提交的改动',revision:2};
  save.resolve(json(503,{}));
  await saving;
  assert.equal(firstReads,2);
  assert.equal(form.elements.title.value,second.title);
  assert.equal(form.elements.body.value,'另一页的新草稿');
  assert.match(el('editor-meta').textContent,/修订 1/);
});

test('an action keeps its linked page before the full graph loads', async () => {
  const {doc, el} = fakeDocument();
  const graph = Promise.withResolvers();
  const action = {id:'action-1', title:'检查旧记录', notes:'', status:'open', revision:1,
    memory_page_id:'older-page', memory_page_title:'归档笔记'};
  const fallback = graphFetcher(emptyGraph);
  mount(doc,{fetcher:async (path, options) => {
    const plain = path.split('?')[0];
    if (plain.endsWith('/memory/graph')) return graph.promise;
    if (plain.endsWith('/memory/actions')) return json(200,{items:[action]});
    if (plain.endsWith('/memory/actions/action-1')) return json(200,{action});
    return fallback(path,options);
  }});
  await tick();
  await el('action-list').children[0].children[1].click();
  const select = el('action-editor-form').elements.memory_page_id;
  assert.equal(select.value,'older-page');
  assert.equal(select.options.find(option => option.value === 'older-page')?.textContent,'归档笔记');
  graph.resolve(json(200,{...emptyGraph,nodes:[
    {id:'older-page', title:'归档笔记'},
    {id:'another-old-page', title:'另一条旧记忆'},
  ]}));
  await tick();
  assert.equal(select.value,'older-page');
  assert.ok(select.options.some(option => option.value === 'another-old-page'));
});

test('actions search paginates through retry and opens a follow-up for the exact saved personal revision', async () => {
  const {doc, el} = fakeDocument();
  const workspace = 'a'.repeat(32), team = 'b'.repeat(32);
  const first = {id:'c'.repeat(32), workspace_id:workspace, title:'Review summary', status:'open', revision:1};
  const cursor = '1:-1800000000:' + first.id;
  const match = {id:'d'.repeat(32), workspace_id:workspace, title:'Review context', notes:'Saved notes', status:'open', revision:4,
    source_chat:{kind:'social', workspace_id:team, conversation_id:'otc_team', message_id:'otm_source'}};
  const spaces = [{id:workspace, name:'Personal', kind:'personal'},{id:team, name:'Team', kind:'team'}];
  const requests = [];
  let pages = 0;
  const base = `/v1/workspaces/${workspace}/memory/actions`;
  el('action-filter').value = 'open';
  mount(doc, {fetcher:async (path, options) => {
    const url = new URL(path, 'https://fixture.invalid');
    const {pathname, searchParams} = url;
    requests.push(`${options.method} ${path}`);
    if (pathname === '/v1/auth/session') return json(200, {user:{id:'1'.repeat(32),username:'alice'}});
    if (pathname === '/v1/workspaces') return json(200, {items:spaces});
    if (pathname === base && searchParams.get('status') === 'open' && searchParams.get('q') === 'Review') {
      assert.equal(searchParams.get('order'), 'due');
      if (!searchParams.has('after')) return json(200, {items:[first], cursor});
      assert.equal(searchParams.get('after'), cursor);
      return ++pages === 1 ? json(503, {}) : json(200, {items:[first, match], cursor:null});
    }
    if (pathname === `${base}/${match.id}` && options.method === 'POST') {
      const {revision, changes} = JSON.parse(options.body);
      assert.equal(revision, 4);
      return json(200, {action:{...match, ...changes, revision:5}});
    }
    if (pathname === `${base}/${match.id}`) return json(200, {action:match});
    if (pathname.endsWith('/memory/actions')) return json(200, {items:[]});
    if (pathname.endsWith('/memory/graph')) return json(200, emptyGraph);
    if (pathname.endsWith('/memory')) return json(200, {items:[],cursor:null,total:0});
    return json(404, {});
  }});
  await tick();
  assert.match(el('action-empty').textContent, /未完成/);
  el('action-filter').value = 'done';
  await el('action-filter').handlers.change();
  assert.match(el('action-empty').textContent, /已完成/);
  assert.equal(el('action-list-filters').hidden, false);
  el('action-filter').value = 'open';
  el('action-search').value = 'Review';
  const event = {preventDefault() {}};
  await el('action-list-filters').handlers.submit(event);
  assert.equal(el('action-list-count').textContent, '已显示 1 项行动');
  await el('action-list-more').click();
  assert.equal(el('action-list-retry').hidden, false);
  assert.equal(el('action-list').children.length, 1);
  await el('action-list-retry').click();
  assert.equal(el('action-list-count').textContent, '已显示 2 项行动');
  assert.equal(el('action-list-more').hidden, true);
  await el('action-list').children[1].children[1].click();
  const follow = el('action-follow-up');
  assert.equal(follow.href, `/automations?workspace=${workspace}&memory_action=${match.id}&revision=4`);
  assert.equal(el('action-source-chat').href, `/chat#workspace=${team}&social=otc_team&message=otm_source`);
  assert.equal(requests.filter(path => path.startsWith('POST')).length, 0);
  const editor = el('action-editor-form');
  editor.elements.notes.value = 'An edited draft';
  editor.handlers.input();
  assert.equal(follow.href, '');
  assert.match(el('action-follow-up-status').textContent, /保存修改/);
  await editor.handlers.submit(event);
  assert.equal(follow.href, `/automations?workspace=${workspace}&memory_action=${match.id}&revision=5`);
  el('workspace').value = team;
  await el('workspace').handlers.change();
  assert.equal(el('action-search').value, '');
});

test('narrow stacking overrides the shell panel grid only while the list is visible', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/memory/app.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*#list-panel\.memory-workspace:not\(\[hidden\]\)\s*\{\s*display: flex;/);
  assert.doesNotMatch(css, /#list-panel\.memory-workspace\s*\{\s*display: flex;/);
});

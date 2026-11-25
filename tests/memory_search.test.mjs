import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_EMPTY_NO_MATCH, MEMORY_EMPTY_WORKSPACE, mount } from '../flybot_workspace/static/memory/app.mjs';

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
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector() { return null; }
  focus() { this.focused = true; }
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
        if (id === 'list-empty') el.textContent = MEMORY_EMPTY_WORKSPACE;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_ns, tag) { return new Element(tag); },
    // The WYSIWYG memory editor renders the opened page body with text nodes.
    createTextNode(text) { const node = new Element('#text'); node.textContent = String(text); node.nodeType = 3; return node; },
    querySelectorAll(selector) {
      if (selector !== '.memory-filters [data-filter]') return [];
      return ['all', 'updated', 'topics'].map(filter => {
        const button = this.getElementById('filter-' + filter);
        button.setAttribute('data-filter', filter);
        return button;
      });
    },
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

const pages = [
  {id: 'pg-brief', title: '项目简报', body: '本周进度', topics: [], updated: 1800000000, revision: 1, created_by: 'alice', updated_by: 'alice'},
  {id: 'pg-ops', title: '运维手册', body: '发布步骤', topics: [], updated: 1800000100, revision: 1, created_by: 'alice', updated_by: 'alice'},
  {id: 'pg-notes', title: '会议记录', body: '讨论纪要', topics: [], updated: 1800000200, revision: 1, created_by: 'alice', updated_by: 'alice'},
];

function directoryFetcher(requests, search) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  return async (path, options) => {
    requests.push({path, method: options?.method || 'GET', signal: options?.signal});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/settings') return json(404, {error: {message: 'missing'}});
    if (path === '/v1/workspaces') return json(200, {items: [space]});
    if (path.startsWith('/v1/workspaces/ws-1/memory?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      assert.equal(query.get('order'), 'recent');
      assert.equal(query.get('limit'), '20');
      if (query.has('q') || query.has('topic') || query.has('updated_after')) return search(query);
      return query.get('cursor') === 'older'
        ? json(200, {items: [pages[2]], cursor: null, total: pages.length})
        : json(200, {items: pages.slice(0, 2), cursor: 'older', total: pages.length});
    }
    if (path === '/v1/workspaces/ws-1/memory/actions') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') {
      return json(200, {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
    }
    const pageMatch = /^\/v1\/workspaces\/ws-1\/memory\/([^/?]+)$/.exec(path);
    if (pageMatch) {
      const page = pages.find((row) => row.id === pageMatch[1]);
      if (page) return json(200, {page});
    }
    throw new Error('unexpected ' + path);
  };
}

function openFirstPage(el) {
  return el('memory-list').children[0].children[0].handlers.click();
}

function pageTitles(el) {
  return el('memory-list').children.map((li) => li.children[0].children[1].children[0].textContent);
}

function enterSearch(el, term) {
  const input = el('search');
  input.value = term;
  input.handlers.input();
  input.handlers.keydown({key: 'Enter', preventDefault() {}});
}

test('full-body search finds an unloaded page, shows the match and preserves the open draft', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  await mount(doc, {fetcher: directoryFetcher(requests, query => {
    if (query.get('q') === '讨论') {
      const hit = {...pages[2], match: {kind:'body', text:'昨日的讨论纪要', start:3, end:5}};
      return json(200, {items:[hit], cursor: null, total:1});
    }
    return json(200, {items:[], cursor: null, total:0});
  })});
  await tick();
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册']);
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);
  assert.ok(!requests.some((row) => row.path.includes('q=')));

  await openFirstPage(el);
  await tick();
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '项目简报');
  el('editor-form').elements.title.value = '仍未保存';

  enterSearch(el, 'zzz-no-match');
  await tick();
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '仍未保存');
  assert.equal(el('memory-list').children.length, 0);
  assert.equal(el('list-empty').hidden, false);
  assert.equal(el('list-empty').textContent, MEMORY_EMPTY_NO_MATCH);
  assert.equal(el('filter-all-count').textContent, '3');

  enterSearch(el, ' 讨论 ');
  await tick();
  assert.equal(el('editor-form').hidden, false);
  assert.deepEqual(pageTitles(el), ['会议记录']);
  assert.equal(el('memory-directory-status').textContent, '找到 1 条记忆');
  const match = el('memory-list').children[0].children[0].children[1].children[1];
  assert.equal(match.children[0].children[1].tagName, 'MARK');
  assert.equal(match.children[0].children[1].textContent, '讨论');
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);

  el('search').focused = false;
  el('search').handlers.keydown({key: 'Escape', preventDefault() {}});
  await tick();
  assert.deepEqual(requests.filter(row => row.path.includes('q=')).map(row => new URLSearchParams(row.path.split('?')[1]).get('q')),
    ['zzz-no-match', '讨论']);
  assert.equal(el('search').value, '');
  assert.equal(el('search').focused, true);
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册']);
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '仍未保存');
});

test('browsing and filtered paging reuse their own cursors and retry keeps existing matches', async () => {
  const requests = [];
  let failOnce = true;
  const {doc, el} = fakeDocument();
  await mount(doc, {fetcher: directoryFetcher(requests, query => {
    assert.equal(query.get('q'), '记录');
    if (!query.get('cursor')) return json(200, {items:[pages[2]], cursor:'search:older', total:2});
    assert.equal(query.get('cursor'), 'search:older');
    if (failOnce) {
      failOnce = false;
      return json(503, {});
    }
    return json(200, {items:[pages[2], pages[1]], cursor:null, total:2});
  })});
  await tick();
  assert.equal(el('memory-load-more').hidden, false);
  await el('memory-load-more').handlers.click();
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册', '会议记录']);
  assert.equal(el('memory-load-more').hidden, true);

  enterSearch(el, '记录');
  await tick();
  assert.deepEqual(pageTitles(el), ['会议记录']);
  await el('memory-load-more').handlers.click();
  assert.equal(el('memory-directory-retry').hidden, false);
  assert.match(el('memory-directory-status').textContent, /无法加载更多/);
  assert.deepEqual(pageTitles(el), ['会议记录']);
  await el('memory-directory-retry').handlers.click();
  assert.equal(el('memory-directory-retry').hidden, true);
  assert.deepEqual(pageTitles(el), ['会议记录', '运维手册']);
  el('memory-search-clear').handlers.click();
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册', '会议记录']);
});

test('a late old search stays ignored even when it returns after abort', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  await mount(doc, {fetcher: directoryFetcher(requests, query => query.get('q') === '旧请求'
    ? slow : json(200, {items:[pages[1]], cursor:null, total:1}))});
  await tick();
  enterSearch(el, '旧请求');
  await tick();
  enterSearch(el, '新请求');
  await tick();
  assert.deepEqual(pageTitles(el), ['运维手册']);
  const old = requests.find(row => row.path.includes('q=' + encodeURIComponent('旧请求')));
  assert.equal(old.signal.aborted, true);
  releaseSlow(json(200, {items:[pages[0]], cursor:null, total:1}));
  await tick();
  assert.deepEqual(pageTitles(el), ['运维手册']);
});

test('recent filter delegates the whole seven-day range and clears back to the saved browse window', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  await mount(doc, {fetcher: directoryFetcher(requests, query => {
    assert.match(query.get('updated_after'), /^\d+$/);
    assert.ok(Math.abs(Number(query.get('updated_after')) - (Date.now()/1000 - 7*86400)) < 3);
    return json(200, {items:[pages[2]], total:1});
  })});
  await tick();
  el('filter-updated').handlers.click();
  await tick();
  assert.deepEqual(pageTitles(el), ['会议记录']);
  assert.equal(el('filter-updated').getAttribute('aria-pressed'), 'true');
  el('filter-all').handlers.click();
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册']);
});

test('connected memories push a same-workspace page entry and searchable choices omit existing links', async () => {
  const {doc, el} = fakeDocument();
  const workspace = 'a'.repeat(32);
  const [source, linked, other] = ['b','c','d'].map((char, index) => ({...pages[index], id:char.repeat(32), workspace_id:workspace}));
  const base = `/v1/workspaces/${workspace}/memory`;
  const address = id => '/memory?' + new URLSearchParams({workspace,page:id});
  const visits = [];
  const view = {location:new URL(address(source.id),'https://memory.test')};
  view.history = {
    state:{},
    replaceState(state, _title, path) { this.state = state; view.location = new URL(path,view.location); },
    pushState(state, title, path) { visits.push({from:this.state, path}); this.replaceState(state,title,path); },
  };
  doc.defaultView = view;
  await mount(doc, {fetcher:async path => {
    if (path === '/v1/auth/session') return json(200,{user:{id:'owner',username:'alice'}});
    if (path === '/v1/workspaces') return json(200,{items:[{id:workspace,name:'Desk'}]});
    if (path === base + '/graph') return json(200,{nodes:[source,linked,other],topics:[],
      edges:[{source:source.id,target:linked.id,kind:'mention'}]});
    if (path.startsWith(base + '?')) return json(200,{items:[source,linked,other],total:3});
    if (path === base + '/' + source.id || path === base + '/' + linked.id) {
      return json(200,{page:path.endsWith(source.id) ? source : linked});
    }
    return json(200,{items:[]});
  }});
  await tick();
  const link = el('page-links').children[0].children[0];
  assert.equal(link.href,address(linked.id));
  assert.deepEqual(el('link-target').options.map(option => option.value),['',other.id]);
  el('link-search').value = '无匹配';
  el('link-search').handlers.input({});
  assert.equal(el('link-target').disabled,true);
  assert.equal(el('link-target').options[0].textContent,'没有匹配的记忆页');
  await link.handlers.click({button:0,preventDefault(){}});
  assert.equal(el('editor-form').elements.title.value,linked.title);
  assert.equal(visits[0].from.memoryDirectory.reopenPage,true);
  assert.equal(visits[0].path,address(linked.id));
  assert.equal(view.history.state.memoryDirectory.returnPage,source.id);
});

test('memory directory restores a private search only for the matching account and workspace', async () => {
  const history = {state: {other: 'untouched'}, replaceState(state, _title, url) {
    this.state = state;
    assert.equal(url, '/memory');
  }};
  const start = async (state = history.state) => {
    history.state = state;
    const requests = [];
    const fixture = fakeDocument();
    fixture.doc.defaultView = {history, location: {pathname: '/memory', search: ''}};
    await mount(fixture.doc, {fetcher: directoryFetcher(requests, () => json(200, {items:[], total:0}))});
    await tick();
    return {...fixture, requests};
  };
  const first = await start();
  first.el('filter-updated').handlers.click();
  enterSearch(first.el, '内部会议');
  await tick();
  const saved = history.state;
  assert.equal(saved.other, 'untouched');
  assert.deepEqual(saved.memoryDirectory, {
    owner: 'user-1', workspace: 'ws-1', query: '内部会议', filter: 'updated', topic: '', result: false,
  });

  const same = await start();
  assert.equal(same.el('search').value, '内部会议');
  assert.equal(same.el('filter-updated').getAttribute('aria-pressed'), 'true');
  assert.equal(same.el('memory-directory-reset').hidden, false);
  assert.ok(same.requests.some(({path}) => path.includes('q=' + encodeURIComponent('内部会议')) && path.includes('updated_after=')));
  same.el('memory-directory-reset').handlers.click();
  assert.equal(same.el('search').value, '');
  assert.equal(same.el('filter-all').getAttribute('aria-pressed'), 'true');
  assert.equal(same.el('memory-directory-reset').hidden, true);
  assert.deepEqual(pageTitles(same.el), ['项目简报', '运维手册']);

  for (const scope of [{owner: 'other-user'}, {workspace: 'other-workspace'}]) {
    const different = await start({...saved, memoryDirectory: {...saved.memoryDirectory, ...scope}});
    assert.equal(different.el('search').value, '');
    assert.equal(different.el('filter-all').getAttribute('aria-pressed'), 'true');
    assert.ok(!different.requests.some(({path}) => path.includes('q=') || path.includes('updated_after=')));
  }
});

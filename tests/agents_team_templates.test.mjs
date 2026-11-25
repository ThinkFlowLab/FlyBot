import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, teamDirectoryLink } from '../flybot_workspace/static/agents/app.mjs';

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
  showModal() { this.open = true; }
  close() { this.open = false; }
  closest() { return null; }
}

const TEMPLATES = [
  {slug: 'product-squad', name: '产品研发小队', category: 'product', summary: '从需求到验收的三人小队。',
   agents: [{name: '产品经理助理', summary: '整理需求', category: 'product'},
            {name: '研发工程师助理', summary: '给出方案', category: 'engineering'},
            {name: '测试工程师助理', summary: '设计用例', category: 'engineering'}]},
  {slug: 'content-studio', name: '内容工作室', category: 'content-creation', summary: '选题、写作到审校。',
   agents: [{name: '选题策划助理', summary: '选题', category: 'content-creation'},
            {name: '文案写作助理', summary: '初稿', category: 'content-creation'},
            {name: '审校编辑助理', summary: '审校', category: 'content-creation'}]},
  {slug: 'research-desk', name: '研究小组', category: 'research', summary: '检索、分析与报告。',
   agents: [{name: '资料整理助理', summary: '整理', category: 'data-analysis'},
            {name: '分析助理', summary: '分析', category: 'data-analysis'},
            {name: '报告撰写助理', summary: '报告', category: 'content-creation'}]},
];

function fakeDocument(storage = new Map()) {
  const elements = new Map();
  const doc = {
    cookie: '',
    defaultView: {sessionStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    }},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' ? 'select' : id.endsWith('-form') ? 'form' : id === 'agent-search' ? 'input' : 'div';
        const el = new Element(tag);
        if (id === 'create-form' || id === 'edit-form') {
          el.elements = {
            id: new Element('input'), revision: new Element('input'), name: new Element('input'),
            summary: new Element('textarea'), instructions: new Element('textarea'),
            category: new Element('select'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await flush();
};

const textOf = (node) => (node.textContent || '') + node.children.map(textOf).join('');

function json(status, body) { return {status, json: async () => body}; }

function fetcher(requests, {applyStatus = 200, loseReceipt = false} = {}) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  return async (path, options = {}) => {
    const method = options.method || 'GET';
    requests.push({path, method, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: null});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === '/v1/team-templates') return json(200, {items: TEMPLATES});
    if (path === '/v1/workspaces/ws-1') return json(200, {workspace: space});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: [{user_id: 'user-1', role: 'owner'}]});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (/\/team-templates\/[a-z-]+$/.test(path) && method === 'POST') {
      if (loseReceipt) throw new Error('lost receipt');
      if (applyStatus !== 200 && applyStatus !== 201) {
        return json(applyStatus, {error: {code: 'forbidden', message: 'Only workspace owners and admins can create agent teams'}});
      }
      return json(201, {conversation: {id: 'cv-9', workspace_id: space.id}, created_agents: []});
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
}

async function mountAgents(options) {
  const requests = [];
  const {doc, el} = fakeDocument(options?.storage);
  globalThis.location = {search: options?.search || '', pathname: '/agents', hash: '', href: '', assign(href) { this.href = href; }};
  globalThis.history = {replaceState() {}, pushState() {}};
  await mount(doc, {fetcher: fetcher(requests, options)});
  await tick();
  return {doc, el, requests};
}

test('the Discover team-template link opens and focuses templates without creating a group', async () => {
  assert.equal(teamDirectoryLink('?tab=teams'), true);
  assert.equal(teamDirectoryLink('?tab=teams&new=1'), true);
  assert.equal(teamDirectoryLink('?tab=teams&new=2'), false);
  assert.equal(teamDirectoryLink('?category=design&tab=teams'), false);
  const {el, requests} = await mountAgents({search:'?tab=teams&new=1'});
  assert.equal(el('tab-teams').attributes['aria-selected'], 'true');
  assert.equal(el('teams-panel').hidden, false);
  assert.equal(el('teams-panel').focused, true);
  assert.equal(el('list-panel').hidden, true);
  assert.equal(el('team-template-list').children.length, 3);
  assert.equal(requests.filter(call => call.path === '/v1/team-templates').length, 1);
  assert.equal(requests.some(call => call.path.startsWith('/v1/workspaces/ws-1/agents?')), false);
  await el('tab-agents').handlers.click();
  assert.equal(requests.filter(call => call.path.startsWith('/v1/workspaces/ws-1/agents?')).length, 1);
  assert.equal(requests.some(call => call.method === 'POST'), false);
});

test('the teams tab lists all three templates with their agents', async () => {
  const {el} = await mountAgents();
  await el('tab-teams').handlers.click();
  await tick();
  const list = el('team-template-list');
  assert.equal(list.children.length, 3, '三个模板都要列出来');
  const third = list.children[2];
  assert.match(textOf(third), /研究小组/);
  assert.match(textOf(third), /资料整理助理/);
});

test('applying a template posts its slug and opens the created conversation', async () => {
  const {el, requests} = await mountAgents();
  await el('tab-teams').handlers.click();
  await tick();
  const card = el('team-template-list').children[0];
  const apply = card.children[card.children.length - 1];
  assert.equal(apply.tagName, 'BUTTON');
  assert.match(apply.textContent, /使用模板/);
  await apply.handlers.click();
  assert.equal(requests.some(item => item.method === 'POST'), false);
  assert.equal(el('team-template-name').value, '产品研发小队');
  assert.equal(el('team-template-roles').children.length, 3);
  el('team-template-name').value = '下一版本验收';
  await el('team-template-form').handlers.submit({preventDefault() {}});
  const post = requests.find((item) => item.method === 'POST');
  assert.equal(post.path, '/v1/workspaces/ws-1/team-templates/product-squad');
  assert.match(post.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(post.body, {title:'下一版本验收'});
  assert.equal(globalThis.location.href, '/chat#workspace=ws-1&social=cv-9');
});

test('a forbidden apply explains it in the page language and keeps the list', async () => {
  const {el} = await mountAgents({applyStatus: 403});
  await el('tab-teams').handlers.click();
  await tick();
  const card = el('team-template-list').children[0];
  await card.children[card.children.length - 1].handlers.click();
  await el('team-template-form').handlers.submit({preventDefault() {}});
  assert.match(el('team-template-feedback').textContent, /只有工作区所有者或管理员/, '403 要给中文原因');
  assert.equal(el('team-template-name').readOnly, false);
  assert.equal(el('team-template-list').children.length, 3, '失败不能清空模板列表');
});

test('filtering combines a category with the role name', async () => {
  const {el} = await mountAgents({search:'?tab=teams'});
  el('team-template-search').value = '编辑';
  el('team-template-search').handlers.input();
  assert.deepEqual(el('team-template-list').children.map(node => node.dataset.slug), ['content-studio']);
  el('team-template-category').value = 'research';
  el('team-template-category').handlers.change();
  assert.equal(el('team-template-list').children.length, 0);
});

test('an uncertain write can be resumed after reloading with the same name and key', async () => {
  const storage = new Map();
  const submit = el => el('team-template-form').handlers.submit({preventDefault() {}});
  const open = el => el('team-template-list').children[0].children.at(-1).handlers.click();
  const first = await mountAgents({search:'?tab=teams', storage, loseReceipt:true});
  open(first.el);
  first.el('team-template-name').value = '发布群';
  await submit(first.el);
  assert.match(first.el('team-template-feedback').textContent, /未收到创建结果/);
  const second = await mountAgents({search:'?tab=teams', storage});
  open(second.el);
  assert.equal(second.el('team-template-name').value, '发布群');
  assert.equal(second.el('team-template-name').readOnly, true);
  await submit(second.el);
  const write = requests => requests.find(item => item.method === 'POST');
  assert.deepEqual(write(second.requests), write(first.requests));
  assert.equal(storage.size, 0);
});

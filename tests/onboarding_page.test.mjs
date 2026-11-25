import assert from 'node:assert/strict';
import test from 'node:test';
import {mountAutomationCreation, mountOnboarding, personalChatPath} from '../flybot_workspace/static/onboarding/app.mjs';

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
    this.className = '';
    this.type = '';
    this.elements = {};
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent || '').join('');
  }
  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelector() { return null; }
  focus() {}
  select() {}
  reset() {}
}

function fakeDocument({native = false} = {}) {
  const elements = new Map();
  const next = new FakeElement('button');
  next.dataset.go = '3';
  const stepParts = [2, 3, 4].map(step => {
    const node = new FakeElement('form');
    node.dataset.step = String(step);
    return node;
  });
  const doc = {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.endsWith('-form') ? 'form' : id === 'industry' ? 'select' : 'div';
        elements.set(id, new FakeElement(tag, id));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelector(selector) {
      return native && selector.startsWith('meta[') ? new FakeElement('meta') : null;
    },
    querySelectorAll(selector) {
      if (selector === '#onboarding-steps [data-go]') return [next];
      if (selector === '#onboarding-steps .onboarding-step') return stepParts;
      if (selector === '#onboarding-look select') {
        return doc.getElementById('onboarding-look').children.map(label => label.children[1]);
      }
      return [];
    },
    next,
    stepParts,
  };
  doc.getElementById('main-panel').hidden = true;
  return doc;
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const workspace = 'a'.repeat(32);
const agent = 'b'.repeat(32);
const binding = {workspace: {id: workspace}, agent: {id: agent}};
const auth = {status: 200, body: {user: {username: 'alice'}}};
const look = {color: '天空蓝', expression: '微笑', headwear: '无', glasses: '无', hand: '无'};
const steps = {
  apps: [{key: 'github', name: 'GitHub'}],
  look_options: Object.fromEntries(Object.entries(look).map(([name, value]) => [name, [value]])),
  look,
};
const response = (step, extra = {}) => ({
  status: 200,
  body: {viewer_username: 'alice', progress: {step, completed: false}, steps, ...extra},
});

test('native profile prefetch renders only once it matches the authenticated account', async () => {
  const document = fakeDocument({native: true});
  const calls = [];
  let authenticate;
  const wizard = mountOnboarding(document, {send: async (method, path) => {
    calls.push([method, path]);
    if (path === '/v1/auth/session') return new Promise(resolve => { authenticate = resolve; });
    if (path === '/v1/onboarding') return response(1);
    throw new Error('Unexpected read ' + path);
  }});
  await flush();
  assert.equal(document.getElementById('main-panel').hidden, true);
  assert.deepEqual(calls, [['GET', '/v1/auth/session'], ['GET', '/v1/onboarding']]);
  authenticate(auth);
  await wizard.ready;
  assert.equal(document.getElementById('main-panel').hidden, false);
  assert.equal(document.getElementById('onboarding-step-label').textContent, '第 1 步，共 4 步');
  assert.equal(document.getElementById('onboarding-save').disabled, true);
  assert.equal(calls.length, 2);
});

test('a prefetched wizard for another account is discarded', async () => {
  const document = fakeDocument({native: true});
  let reads = 0;
  const wizard = mountOnboarding(document, {send: async (_method, path) => {
    if (path === '/v1/auth/session') return auth;
    if (path === '/v1/onboarding') {
      reads += 1;
      return reads === 1 ? response(4, {viewer_username: 'bob'}) : response(1);
    }
    throw new Error('Unexpected read ' + path);
  }});
  await wizard.ready;
  assert.equal(reads, 2);
  assert.equal(document.getElementById('onboarding-step-label').textContent, '第 1 步，共 4 步');
});

test('connector status is optional and cannot block durable advancement', async () => {
  const document = fakeDocument();
  const calls = [];
  let resolveConnector;
  const wizard = mountOnboarding(document, {send: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === '/v1/auth/session') return auth;
    if (path === '/v1/onboarding') return response(2);
    if (path === '/v1/composio/connections') return new Promise(resolve => { resolveConnector = resolve; });
    if (path === '/v1/onboarding/progress') return {status: 200, body: {progress: {step: 3, completed: false}}};
    throw new Error('Unexpected request ' + path);
  }});
  await wizard.ready;
  assert.equal(document.stepParts[0].hidden, false);
  assert.match(document.getElementById('onboarding-apps').textContent, /读取中/);
  document.next.handlers.click[0]();
  await flush();
  assert.equal(document.stepParts[1].hidden, false);
  assert.deepEqual(calls.at(-1), ['POST', '/v1/onboarding/progress', {step: 3}]);
  resolveConnector({status: 200, body: {items: [{toolkit: 'github', state: 'connected'}]}});
  await flush();
  assert.equal(document.stepParts[1].hidden, false);
});

test('saved appearance step completes with the selected look, then opens the exact personal chat', async () => {
  const document = fakeDocument();
  const calls = [];
  const destination = [];
  const wizard = mountOnboarding(document, {navigate: path => destination.push(path),
    send: async (method, path, body) => {
      calls.push([method, path, body]);
      if (path === '/v1/auth/session') return auth;
      if (path === '/v1/onboarding') return response(4);
      if (path === '/v1/onboarding/look') return response(4, {progress: {step: 4, completed: true}});
      if (path === '/v1/personal-agent') return {status: 200, body: {personal_agent: binding}};
      throw new Error('Unexpected request ' + path);
    }});
  await wizard.ready;
  assert.equal(document.stepParts[2].hidden, false);
  assert.equal(document.getElementById('onboarding-enter').textContent, '完成并开始聊天');
  document.getElementById('onboarding-enter').handlers.click[0]();
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['POST', '/v1/onboarding/look', {look, finish: true}],
    ['GET', '/v1/personal-agent', undefined],
  ]);
  assert.deepEqual(destination, ['/chat#workspace=' + workspace + '&agent=' + agent]);
  assert.equal(personalChatPath({workspace: {id: '../../../chat'}, agent: {id: agent}}), '');
});

test('a selected one-off task only stages a private draft and preserves an existing draft', async () => {
  const owner = 'c'.repeat(32);
  const other = 'd'.repeat(32);
  const storageKey = 'flybot-workspace.chat-drafts:' + owner;
  const scope = JSON.stringify([owner, workspace, 'agent', agent, null]);
  const taskSteps = {...steps, picks: ['once', 'routine'], recommendations: [
    {key: 'once', kind: 'task', title: '整理会议纪要', summary: '整理结论和行动项。'},
    {key: 'routine', kind: 'routine', title: '每日早报', summary: '定时发早报。'},
    {key: 'unselected', kind: 'task', title: '起草回复', summary: '根据上下文起草。'},
  ]};
  for (const mode of ['new', 'existing', 'foreign', 'unavailable']) {
    const document = fakeDocument();
    const storage = new Map();
    if (mode === 'existing') storage.set(storageKey, JSON.stringify({[scope]: '用户原草稿'}));
    document.defaultView = {addEventListener() {}, sessionStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => {
        if (mode === 'unavailable') throw new Error('storage denied');
        storage.set(key, value);
      },
    }};
    const writes = [];
    const destinations = [];
    const wizard = mountOnboarding(document, {navigate: path => destinations.push(path), send: async (method, path) => {
      if (method === 'POST') writes.push(path);
      switch (path) {
        case '/v1/auth/session':
          return {status: 200, body: {user: {id: owner, username: 'alice'}}};
        case '/v1/onboarding':
          return response(4, {steps: taskSteps});
        case '/v1/onboarding/look':
          return response(4, {steps: taskSteps, progress: {step: 4, completed: true}});
        case '/v1/personal-agent':
          return {status: 200, body: {personal_agent: {
            ...binding, workspace: {id: workspace, owner_id: mode === 'foreign' ? other : owner},
          }}};
        default:
          throw new Error('Unexpected request ' + path);
      }
    }});
    await wizard.ready;
    const choice = document.getElementById('onboarding-first-task');
    assert.deepEqual(choice.children.map(option => option.value), ['', 'once']);
    choice.value = 'once';
    choice.handlers.change[0]();
    const text = document.getElementById('onboarding-first-task-preview').value;
    assert.match(text, /整理会议纪要/);
    assert.deepEqual(writes, [], 'selection does not start a conversation or inference');
    document.getElementById('onboarding-enter').handlers.click[0]();
    await flush();
    assert.deepEqual(writes, ['/v1/onboarding/look']);
    if (mode === 'new') {
      assert.deepEqual(destinations, ['/chat#workspace=' + workspace + '&agent=' + agent]);
      assert.deepEqual(JSON.parse(storage.get(storageKey)), {[scope]: text});
      assert.equal(storage.get('flybot-workspace.cold-chat-draft'), scope);
    } else {
      assert.deepEqual(destinations, []);
      assert.deepEqual(storage.get(storageKey), mode === 'existing' ? JSON.stringify({[scope]: '用户原草稿'}) : undefined);
      assert.equal(storage.has('flybot-workspace.cold-chat-draft'), false);
      assert.match(document.getElementById('onboarding-first-task-status').textContent, /已有未发送草稿|无法确认|无法暂存/);
    }
  }
});

test('an unconfirmed completion stays on step 4 without provisioning or opening chat', async () => {
  const document = fakeDocument();
  const personalRequests = [];
  const wizard = mountOnboarding(document, {navigate: () => assert.fail('navigated after failed save'),
    send: async (method, path) => {
      if (path === '/v1/auth/session') return auth;
      if (path === '/v1/onboarding') return response(4);
      if (path === '/v1/onboarding/look') return {status: 503, body: {}};
      personalRequests.push(method);
      return {status: 200, body: {personal_agent: binding}};
    }});
  await wizard.ready;
  document.getElementById('onboarding-enter').handlers.click[0]();
  await flush();
  assert.equal(document.stepParts[2].hidden, false);
  assert.deepEqual(personalRequests, ['GET']);
  assert.match(document.getElementById('status').textContent, /暂时无法确认/);
});

test('finishing overlaps the binding read and verifies a lost save receipt without another write', async () => {
  for (const mode of ['look', 'skip', 'foreign', 'changed']) {
    const document = fakeDocument();
    const destination = [];
    const pending = Promise.withResolvers();
    const calls = [];
    const skip = mode === 'skip';
    const wizard = mountOnboarding(document, {navigate: path => destination.push(path), send: async (method, path) => {
      calls.push([method, path]);
      if (path === '/v1/auth/session') return auth;
      if (path === '/v1/onboarding') return calls.filter(([, name]) => name === path).length === 1
        ? response(skip ? 1 : 4)
        : response(4, {
          viewer_username: mode === 'foreign' ? 'different' : 'alice',
          progress: {step: 4, completed: true},
          steps: mode === 'changed' ? {...steps, look: {...look, color: '不同颜色'}} : steps,
        });
      if (path === '/v1/onboarding/look' || path === '/v1/onboarding/progress') return pending.promise;
      if (path === '/v1/personal-agent') return {status: 200, body: {personal_agent: binding}};
      throw new Error('Unexpected request ' + path);
    }});
    await wizard.ready;
    document.getElementById(skip ? 'onboarding-skip' : 'onboarding-enter').handlers.click[0]();
    const write = skip ? '/v1/onboarding/progress' : '/v1/onboarding/look';
    assert.deepEqual(calls.slice(-2), [['POST', write], ['GET', '/v1/personal-agent']]);
    assert.deepEqual(destination, []);
    pending.resolve({status: 503, body: {}});
    await flush();
    assert.deepEqual(calls.filter(([method]) => method === 'POST'), [['POST', write]]);
    assert.deepEqual(calls.at(-1), ['GET', '/v1/onboarding']);
    assert.deepEqual(destination, mode === 'foreign' || mode === 'changed'
      ? [] : ['/chat#workspace=' + workspace + '&agent=' + agent]);
  }
});

test('automation creation is opt-in, click-only and guarded against duplicate clicks', async () => {
  const doc = fakeDocument();
  const calls = [];
  let finish;
  const creation = mountAutomationCreation(doc, async (...args) => {
    calls.push(args);
    if (args[1] === '/v1/personal-agent') {
      return {status: 201, body: {personal_agent: {workspace: {id: 'a'.repeat(32)}}}};
    }
    return new Promise(resolve => {finish = resolve;});
  });
  creation.render([{template_id: 'daily_brief', title: '每日工作简报', prompt: '真实模板'}]);
  const button = doc.getElementById('create-onboarding-automations');
  const box = doc.getElementById('onboarding-automation-templates').children[0].children[0];
  assert.equal(box.checked, false);
  assert.deepEqual(calls, [], 'rendering onboarding must not create anything');
  const click = button.handlers.click[0];
  await click();
  assert.deepEqual(calls, [], 'an empty selection never creates anything');
  box.checked = true;
  assert.deepEqual(calls, [], 'selection alone must not create anything');
  const pending = click();
  await click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(button.disabled, true);
  assert.deepEqual(calls[0], ['POST', '/v1/personal-agent', {}]);
  assert.deepEqual(calls[1], ['POST', '/v1/onboarding/automations', {workspace_id: 'a'.repeat(32), template_ids: ['daily_brief']}]);
  finish({status: 201, body: {created: [{id: 'b'.repeat(32), title: '每日工作简报'}], skipped: []}});
  await pending;
  assert.equal(button.disabled, false);
  assert.match(doc.getElementById('onboarding-automation-status').textContent, /暂停的自动化/);
  const links = doc.getElementById('onboarding-automation-links');
  assert.equal(links.children[0].children[0].href, `/automations?workspace=${'a'.repeat(32)}&automation=${'b'.repeat(32)}`);
});

test('automation replay links to the existing result from an already verified personal workspace', async () => {
  const doc = fakeDocument();
  const workspace = 'a'.repeat(32);
  const id = 'c'.repeat(32);
  const calls = [];
  const creation = mountAutomationCreation(doc, async (...args) => {
    calls.push(args);
    return {status: 200, body: {created: [], skipped: [{id, title: '已改名的简报'}, {title: '重名项目'}]}};
  });
  creation.render([{template_id: 'daily_brief', title: '每日工作简报', prompt: '真实模板'}]);
  creation.setPersonalWorkspace(workspace);
  doc.getElementById('onboarding-automation-templates').children[0].children[0].checked = true;
  await doc.getElementById('create-onboarding-automations').handlers.click[0]();
  assert.deepEqual(calls, [['POST', '/v1/onboarding/automations', {workspace_id: workspace, template_ids: ['daily_brief']}]]);
  const links = doc.getElementById('onboarding-automation-links');
  assert.equal(links.children.length, 1);
  assert.equal(links.children[0].children[0].href, `/automations?workspace=${workspace}&automation=${id}`);
});

test('automation creation reports errors without advancing onboarding', async () => {
  const doc = fakeDocument();
  const creation = mountAutomationCreation(doc, async () => {throw new Error('offline');});
  creation.render([{template_id: 'daily_brief', title: '每日工作简报', prompt: '真实模板'}]);
  doc.getElementById('onboarding-automation-templates').children[0].children[0].checked = true;
  const button = doc.getElementById('create-onboarding-automations');
  await button.handlers.click[0]();
  assert.equal(button.disabled, false);
  assert.match(doc.getElementById('onboarding-automation-status').textContent, /结果尚不确定/);
});

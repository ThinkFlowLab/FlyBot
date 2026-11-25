import assert from 'node:assert/strict';
import test from 'node:test';
import {renderRunMarkdown} from '../flybot_workspace/static/automations/result-markdown.mjs';
import {upcomingAutomations} from '../flybot_workspace/static/automations/app.mjs';
import { automationEditionDraft, automationTargetFromSearch, cancellationPrompt, catalogItems, csrfCookie, deletePrompt, draftFromTemplate, listQuery, matchesRunFilter, meetingTargetFromSearch, memoryActionTargetFromSearch, mount, namesFromList, readEditor, RUN_DETAIL_EMPTY, runDetailFields, runErrorReason, runFilterFromSearch, runFilterSearchText, runResultText, runStatusLabel, scheduleFromForm, scheduleSummary, tabCategory } from '../flybot_workspace/static/automations/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('a copied automation starts paused and separates task settings from saved history and source grants', () => {
  const original = {id:'a'.repeat(32),revision:4,workspace_id:'b'.repeat(32),title:'a'.repeat(74)+'📘abcd',
    prompt:'Prepare a weekly briefing',template_id:'custom',intent:'monitor',scope:'ongoing',enabled:true,
    schedule:{kind:'weekly',weekday:3,time:'15:30',time_zone:'Asia/Shanghai'},notification_policy:'off',
    participants:['alice'],agents:['research'],source_meeting:{meeting_id:'c'.repeat(32)},
    source_memory_action:{action_id:'d'.repeat(32)},active_run:{id:'e'.repeat(32)}};
  const draft = automationEditionDraft(original);
  assert.deepEqual(draft,{edition:true,title:'a'.repeat(74)+' · 副本',prompt:original.prompt,template_id:'custom',
    intent:'monitor',scope:'ongoing',enabled:false,schedule:original.schedule,notification_policy:'off',
    participants:['alice'],agents:['research']});
  assert.notEqual(draft.schedule,original.schedule);
  assert.notEqual(draft.participants,original.participants);
  assert.notEqual(draft.agents,original.agents);
});

test('listQuery encodes tab and search', () => {
  assert.equal(listQuery('mine', ''), '?category=mine');
  assert.equal(listQuery('work', '  brief '), '?category=work&q=brief');
  assert.equal(tabCategory('life'), 'life');
  assert.equal(tabCategory('other'), 'mine');
});

test('upcoming automation catalogue uses native slots and excludes inactive and foreign rows', () => {
  const first = {title:'First', workspace_id:'workspace', enabled:true, schedule_status:{state:'scheduled', at:10}};
  const later = {...first, title:'Later', schedule_status:{state:'scheduled', at:20}};
  const due = {...first, title:'Due now', schedule_status:{state:'due'}};
  const items = [later, first, due, {...first, enabled:false}, {...first, workspace_id:'other'},
    {...first, schedule_status:{state:'once_triggered'}}, {...first, schedule_status:{state:'once_cancelled'}},
    {...first, schedule_status:{state:'scheduled', at:0}}, {...first, schedule_status:{state:'paused', at:1}},
    {...first, schedule_status:null}];
  assert.deepEqual(upcomingAutomations(items, 'workspace'), [due, first, later]);
  assert.equal(items[0], later);
});

test('an onboarding link must name exactly one saved automation and its workspace', () => {
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const run = 'c'.repeat(32);
  assert.deepEqual(automationTargetFromSearch(`?workspace=${workspace}&automation=${automation}&runs=failed`),
    {workspace, automation});
  assert.equal(automationTargetFromSearch('?template=daily_brief'), null);
  assert.deepEqual(automationTargetFromSearch(`?workspace=${workspace}&automation=${automation}&automation=${automation}`), {invalid: true});
  assert.deepEqual(automationTargetFromSearch(`?workspace=${workspace}&automation=missing`), {invalid: true});
  assert.deepEqual(automationTargetFromSearch(`?workspace=${workspace}&automation=${automation}&run=${run}`), {workspace, automation, run});
  assert.deepEqual(automationTargetFromSearch(`?run=${run}`), {invalid: true});
  assert.deepEqual(automationTargetFromSearch(`?workspace=${workspace}&automation=${automation}&run=${run}&run=${run}`), {invalid: true});
});

test('meeting follow-up links carry a bounded action index, exact revision and no content', () => {
  const workspace = 'a'.repeat(32);
  const meeting = 'b'.repeat(32);
  const path = `?workspace=${workspace}&meeting=${meeting}&action=0&revision=3`;
  assert.deepEqual(meetingTargetFromSearch(path), {workspace, meeting, action: 0, revision: 3});
  assert.equal(meetingTargetFromSearch('?template=daily_brief'), null);
  for (const invalid of [
    path + '&action=2', path + '&prompt=private', path + '&automation=' + meeting,
    path.replace('action=0', 'action=50'), path.replace('action=0', 'action=-1'), path.replace('action=0', 'action=00'),
    path.replace('revision=3', 'revision=0'), path.replace('revision=3', 'revision=9007199254740992'),
    path.replace('meeting=' + meeting, 'meeting=missing'),
  ]) assert.deepEqual(meetingTargetFromSearch(invalid), {invalid: true});
});

test('memory action follow-up links accept exactly an opaque action and its reviewed revision', () => {
  const workspace = 'a'.repeat(32), memoryAction = 'b'.repeat(32);
  const search = `?workspace=${workspace}&memory_action=${memoryAction}&revision=4`;
  assert.deepEqual(memoryActionTargetFromSearch(search), {workspace, memoryAction, revision: 4});
  assert.equal(memoryActionTargetFromSearch('?revision=4'), null);
  for (const invalid of [search + '&title=private', search + '&revision=5', search.replace('4', '0'),
    search.replace(memoryAction, 'wrong-id'), search.replace('4', '9007199254740992')]) {
    assert.deepEqual(memoryActionTargetFromSearch(invalid), {invalid: true});
  }
});

test('scheduleFromForm and namesFromList map editor fields', () => {
  const fake = {
    get(name) {
      return {
        kind: 'monthly', time: '10:15', time_zone: 'UTC', day: '16',
        weekday: '1', date: '2026-11-20',
      }[name];
    },
  };
  assert.deepEqual(scheduleFromForm(fake), {kind: 'monthly', time: '10:15', time_zone: 'UTC', day: 16});
  assert.deepEqual(namesFromList('alice, Bob, alice'), ['alice', 'Bob']);
});

test('readEditor collects tag fields', () => {
  const values = {
    title: ' Brief ', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
    participants: 'alice, bob', agents: 'brief-bot', kind: 'weekdays',
    time: '09:00', time_zone: 'Asia/Shanghai', prompt: 'hello',
  };
  const fake = {
    get(name) { return values[name]; },
    has(name) { return name === 'enabled'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readEditor({}), {
      title: 'Brief', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
      participants: ['alice', 'bob'], agents: ['brief-bot'],
      schedule: {kind: 'weekdays', time: '09:00', time_zone: 'Asia/Shanghai'},
      prompt: 'hello', enabled: true, notification_policy:'scheduled',
    });
  } finally {
    globalThis.FormData = original;
  }
});

test('runStatusLabel and runResultText describe durable run rows', () => {
  assert.equal(runStatusLabel({status: 'succeeded'}), '已完成');
  assert.equal(runStatusLabel({status: 'queued', error_code: 'no_agent'}), '等待已连接的代理');
  assert.equal(runStatusLabel({status: 'queued'}), '已排队');
  assert.equal(runStatusLabel({status: 'running'}), '运行中');
  assert.equal(runStatusLabel({status: 'running', stop_requested:true}), '正在停止');
  assert.equal(runStatusLabel({status: 'timeout'}), '已超时');
  assert.equal(runStatusLabel({status: 'failed', error_code: 'interrupted'}), '运行中断');
  assert.equal(runResultText({result: {text: 'brief from fake provider'}}), 'brief from fake provider');
  assert.equal(runResultText({result: {}}), '');
});

test('catalogItems filters recorded work and life templates', () => {
  const templates = [
    {id: 'custom', title: '自定义', category: 'custom', prompt: ''},
    {id: 'daily_brief', title: '每日工作简报', category: 'work', prompt: '汇总当天要处理的事项。'},
    {id: 'birthday_reminder', title: '生日和纪念日提醒', category: 'life', prompt: '在日期到来前提醒我。'},
    {id: 'habit_reminder', title: '健康和习惯提醒', category: 'life', prompt: '在约定的时间提醒我。'},
  ];
  assert.deepEqual(catalogItems(templates, 'work', '').map(item => item.id), ['daily_brief']);
  assert.deepEqual(catalogItems(templates, 'life', '习惯').map(item => item.id), ['habit_reminder']);
  assert.deepEqual(catalogItems(templates, 'mine', ''), []);
});

test('draftFromTemplate uses recorded daily brief defaults only', () => {
  assert.deepEqual(draftFromTemplate({
    id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
  }, 'alice'), {
    template_id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
    intent: 'monitor', scope: 'once',
    schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
    participants: ['alice'], agents: [], enabled: false,
  });
  const life = draftFromTemplate({
    id: 'birthday_reminder', title: '生日和纪念日提醒', prompt: '提前提醒。',
  }, 'alice');
  assert.equal(life.intent, '');
  assert.equal(life.scope, 'once');
  assert.equal(life.schedule.kind, 'now');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.classList = {add() {}, remove() {}, contains() { return false; }};
    this._text = '';
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get elements() {
    if (this._elements) return this._elements;
    this._elements = {};
    // The editor form reads every named control through form.elements; the
    // template select also needs appendChild/options so fillTemplates works.
    for (const name of ['intent', 'scope', 'participants', 'agents', 'date', 'time', 'weekday',
      'day', 'time_zone', 'prompt', 'enabled', 'title']) {
      this._elements[name] = new FakeNode('input');
    }
    this._elements.template_id = new FakeNode('select');
    this._elements.kind = new FakeNode('select');
    this._elements.notification_policy = new FakeNode('select');
    return this._elements;
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll() { return []; }
  querySelector() { return new FakeNode(); }
}

function fakeDocument() {
  const elements = new Map();
  const tags = {'editor-form': 'form', workspace: 'select', search: 'input'};
  const doc = {
    cookie: '',
    handlers: {},
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode(tags[id] || 'div'));
      return elements.get(id);
    },
    createElement(tag) { return new FakeNode(tag); },
    createTextNode(text) { return Object.assign(new FakeNode('#text'), {textContent:text}); },
    querySelectorAll() { return []; },
    querySelector() { return new FakeNode(); },
  };
  return {doc, elements};
}

async function mountList(items) {
  const {doc, elements} = fakeDocument();
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push(`${options.method || 'GET'} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') return {status: 200, json: async () => ({items})};
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    await mount(doc, {fetcher});
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  return {list: elements.get('automation-list'), calls};
}

test('personal automations are available while team workspaces load', async () => {
  const {doc, elements} = fakeDocument();
  const {promise: teams, resolve: resolveTeams} = Promise.withResolvers();
  const respond = body => ({status: 200, json: async () => body});
  const calls = [];
  const fetcher = async path => {
    calls.push(path);
    if (path === '/v1/auth/session') return respond({user: {username: 'alice'}});
    if (path === '/v1/workspaces?scope=personal') return respond({items: [{id: 'ws1', name: '个人工作区'}]});
    if (path === '/v1/workspaces?limit=100') return teams;
    if (path === '/v1/workspaces/ws1/automations?category=mine') {
      return respond({items: [{id: 'a1', title: '每日简报', schedule: {kind: 'now'}}]});
    }
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  const mounted = mount(doc, {fetcher});
  try {
    await flush();
    assert.equal(elements.get('new-automation').disabled, false);
    assert.match(elements.get('automation-list').textContent, /每日简报/);
    assert.equal(calls.includes('/v1/automation-templates'), false);
    resolveTeams(respond({items: [{id: 'team', name: '团队'}]}));
    await flush();
    const picker = elements.get('workspace');
    assert.equal(picker.value, 'ws1');
    assert.deepEqual(picker.options.map(option => option.value), ['ws1', 'team']);
  } finally {
    resolveTeams(respond({items: []}));
    await mounted;
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
});

const projectedWorkspace = 'a'.repeat(32);
const projectedOwner = 'b'.repeat(32);
const projectedAutomation = 'c'.repeat(32);
const projectedPath = '/v1/workspaces?scope=personal&include=automations';
const projectedPersonal = {id: projectedWorkspace, owner_id: projectedOwner, name: '个人工作区', kind: 'personal'};

test('a catalogue history entry restores its search only for the signed-in account and selected workspace', async () => {
  const privateQuery = '本人工作区搜索';
  const other = 'e'.repeat(32);
  for (const [viewer, workspace, expected] of [
    [projectedOwner, projectedWorkspace, privateQuery],
    ['d'.repeat(32), projectedWorkspace, ''],
    [projectedOwner, other, ''],
  ]) {
    const {doc, elements} = fakeDocument();
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    doc.defaultView = {
      location: {pathname:'/automations', search:'', hash:'#workspace=' + workspace},
      history: {state:{automationCatalogue:{owner:projectedOwner, workspace:projectedWorkspace,
        category:'mine', query:privateQuery, automation:projectedAutomation}}},
    };
    const queries = [];
    await mount(doc, {fetcher:async path => {
      if (path === '/v1/auth/session') return respond({user:{id:viewer, username:'alice'}});
      if (path.startsWith('/v1/workspaces?')) return respond({items:[{id:workspace, name:'工作区'}]});
      queries.push(path);
      return respond({items:[]});
    }});
    assert.equal(elements.get('search').value, expected);
    assert.deepEqual(queries, [`/v1/workspaces/${workspace}/automations${listQuery('mine', expected)}`]);
  }
});

test('a new automation restores the same account and workspace draft without a write', async () => {
  const storage = new Map();
  const location = {pathname:'/automations', search:'', hash:'#workspace=' + projectedWorkspace};
  const history = {
    state:null,
    replaceState(state, _, address) {
      this.state = state;
      const parsed = new URL(address, 'https://example.test');
      Object.assign(location, {search:parsed.search, hash:parsed.hash});
    },
  };
  const sessionStorage = {
    getItem:key => storage.get(key),
    setItem:(key,value) => storage.set(key,value),
    removeItem:key => storage.delete(key),
  };
  const requests = [];
  async function open(owner, workspace = projectedWorkspace) {
    const {doc, elements} = fakeDocument();
    doc.querySelector = selector => selector === 'meta[name="flybot-workspace-served-by"][content="ds-bot"]'
      ? {content:'ds-bot', getAttribute:() => 'ds-bot'} : null;
    doc.defaultView = {location, history, sessionStorage};
    await mount(doc, {fetcher:async (path, {method} = {}) => {
      requests.push(method);
      let body;
      if (path === '/v1/auth/session') body = {user:{id:owner,username:'alice'}};
      else if (path.startsWith('/v1/workspaces?')) body = {items:[{id:workspace,name:'工作区'}]};
      else body = {items:[]};
      return {status:200,json:async () => body};
    }});
    return elements;
  }
  const first = await open(projectedOwner);
  first.get('new-automation').handlers.click[0]();
  const form = first.get('editor-form');
  form.elements.prompt.value = '保存在本页的指令';
  form.elements.kind.value = 'weekly';
  form.elements.weekday.value = '4';
  form.handlers.input[0]();
  assert.equal(storage.size,1);
  const reloaded = await open(projectedOwner);
  assert.equal(reloaded.get('editor-form').hidden,false);
  assert.equal(reloaded.get('editor-form').elements.prompt.value,'保存在本页的指令');
  assert.equal(reloaded.get('editor-form').elements.weekday.value,'4');
  const foreign = await open('d'.repeat(32));
  assert.equal(foreign.get('editor-form').hidden,true);
  const otherWorkspace = 'e'.repeat(32);
  location.hash = '#workspace=' + otherWorkspace;
  const changedWorkspace = await open(projectedOwner, otherWorkspace);
  assert.equal(changedWorkspace.get('editor-form').hidden,true);
  assert.ok(!requests.includes('POST'));
});

test('native startup overlaps authentication and the owned list, then requests templates on demand', async t => {
  const {doc, elements} = fakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = previousDocument; });
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const work = new FakeNode('button'); work.dataset.category = 'work';
  const life = new FakeNode('button'); life.dataset.category = 'life';
  doc.querySelectorAll = selector => selector === '.tabs [data-category]' ? [work, life] : [];
  const {promise: session, resolve: authenticate} = Promise.withResolvers();
  const {promise: teams, resolve: finishTeams} = Promise.withResolvers();
  const {promise: catalog, resolve: finishTemplates} = Promise.withResolvers();
  const calls = [];
  const fetcher = async path => {
    calls.push(path);
    if (path === '/v1/auth/session') return session;
    if (path === projectedPath) return respond({items: [projectedPersonal], viewer_username: 'alice',
      automations: {items: [{id: projectedAutomation, workspace_id: projectedWorkspace, title: '合并加载的日报'}]}});
    if (path === '/v1/workspaces?limit=100') return teams;
    if (path === '/v1/automation-templates') return catalog;
    throw new Error('unexpected ' + path);
  };
  const mounted = mount(doc, {fetcher});
  try {
    await flush();
    assert.deepEqual(calls, ['/v1/auth/session', projectedPath]);
    assert.equal(elements.get('automation-list')?.textContent || '', '');
    authenticate(respond({user: {id: projectedOwner, username: 'alice'}}));
    await mounted;
    assert.match(elements.get('automation-list').textContent, /合并加载的日报/);
    assert.deepEqual(calls, ['/v1/auth/session', projectedPath, '/v1/workspaces?limit=100']);
    const workOpen = work.handlers.click[0]();
    const lifeOpen = life.handlers.click[0]();
    assert.match(elements.get('list-empty').textContent, /加载模板/);
    assert.equal(calls.filter(path => path === '/v1/automation-templates').length, 1);
    finishTemplates(respond({items: [
      {id: 'daily_brief', title: '工作简报', category: 'work'},
      {id: 'habit_reminder', title: '生活提醒', category: 'life'},
    ]}));
    await Promise.all([workOpen, lifeOpen]);
    assert.match(elements.get('automation-list').textContent, /生活提醒/);
    assert.doesNotMatch(elements.get('automation-list').textContent, /工作简报/);
    await work.handlers.click[0]();
    assert.match(elements.get('automation-list').textContent, /工作简报/);
    assert.equal(calls.filter(path => path === '/v1/automation-templates').length, 1);
    finishTeams(respond({items: [{id: 'team', name: '团队工作区'}]}));
    await flush();
    assert.equal(elements.get('workspace').value, projectedWorkspace);
  } finally {
    authenticate(respond({user: {id: projectedOwner, username: 'alice'}}));
    finishTemplates(respond({items: []}));
    finishTeams(respond({items: []}));
    await mounted;
  }
});

test('a native recurring automation switches only after its revision-checked save succeeds', async t => {
  const {doc, elements} = fakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = previousDocument; });
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const {promise: saving, resolve: finishSave} = Promise.withResolvers();
  const base = '/v1/workspaces/' + projectedWorkspace + '/automations';
  let recurring = {id: projectedAutomation, workspace_id: projectedWorkspace, title: '工作日报',
    enabled: false, revision: 3, schedule: {kind: 'daily', time: '09:00'}, schedule_status: {state: 'paused'}};
  const linked = {...recurring, id: 'e'.repeat(32), title: '关联会议', source_meeting: {meeting_id: 'f'.repeat(32)}};
  const requests = [];
  const fetcher = (path, options = {}) => {
    if (path === '/v1/auth/session') return respond({user: {id: projectedOwner, username: 'alice'}});
    if (path === projectedPath) return respond({items: [projectedPersonal], viewer_username: 'alice',
      automations: {items: [recurring, linked]}});
    if (path === '/v1/workspaces?limit=100') return respond({items: [projectedPersonal]});
    if (path === base + '?category=mine') return respond({items: [recurring, linked]});
    if (path === base + '/' + projectedAutomation && options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      return saving;
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher});
  const list = elements.get('automation-list');
  const switchFor = row => row.children.find(child => child.getAttribute('role') === 'switch');
  const control = switchFor(list.children[0]);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(switchFor(list.children[1]), undefined);
  const toggled = control.handlers.click[0]();
  assert.equal(control.disabled, true);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.deepEqual(requests, [{revision: 3, changes: {enabled: true}}]);
  recurring = {...recurring, enabled: true, revision: 4, schedule_status: {state: 'scheduled'}};
  finishSave(respond({automation: recurring}));
  await toggled;
  assert.equal(switchFor(list.children[0]).getAttribute('aria-checked'), 'true');
});

test('native startup falls back on a different viewer or an out-of-workspace automation row', async t => {
  for (const viewer of ['someone-else', 'alice']) await t.test(viewer, async scenario => {
    const {doc, elements} = fakeDocument();
    const previousDocument = globalThis.document;
    globalThis.document = doc;
    scenario.after(() => { globalThis.document = previousDocument; });
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    const calls = [];
    const listPath = `/v1/workspaces/${projectedWorkspace}/automations?category=mine`;
    await mount(doc, {fetcher: async path => {
      calls.push(path);
      if (path === '/v1/auth/session') return respond({user: {id: projectedOwner, username: 'alice'}});
      if (path === projectedPath) return respond({items: [projectedPersonal], viewer_username: viewer,
        automations: {items: [{id: projectedAutomation,
          workspace_id: viewer === 'alice' ? 'f'.repeat(32) : projectedWorkspace, title: '不能显示的日报'}]}});
      if (path === '/v1/workspaces?scope=personal' || path === '/v1/workspaces?limit=100') {
        return respond({items: [projectedPersonal]});
      }
      if (path === listPath) return respond({items: [{id: projectedAutomation, title: '正常读取的日报'}]});
      throw new Error('unexpected ' + path);
    }});
    assert.equal(calls.includes('/v1/workspaces?scope=personal'), viewer !== 'alice');
    assert.equal(calls.filter(path => path === listPath).length, 1);
    assert.match(elements.get('automation-list').textContent, /正常读取的日报/);
    assert.doesNotMatch(elements.get('automation-list').textContent, /不能显示的日报/);
  });
});

test('an explicit template link opens its draft while the shared directory is still loading', async t => {
  const {doc, elements} = fakeDocument();
  doc.defaultView = {location: {search: '?template=daily_brief'}};
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = previousDocument; });
  const {promise: teams, resolve: finishTeams} = Promise.withResolvers();
  const calls = [];
  try {
    await mount(doc, {fetcher: async path => {
      calls.push(path);
      if (path === '/v1/auth/session') return respond({user: {id: projectedOwner, username: 'alice'}});
      if (path === '/v1/workspaces?scope=personal') return respond({items: [projectedPersonal]});
      if (path === '/v1/workspaces?limit=100') return teams;
      if (path === '/v1/automation-templates') return respond({items: [{id: 'daily_brief', title: '日报模板', category: 'work'}]});
      throw new Error('unexpected ' + path);
    }});
    assert.equal(elements.get('editor-form').hidden, false);
    assert.equal(elements.get('editor-form').elements.title.value, '日报模板');
    assert.equal(elements.get('editor-form').elements.template_id.value, 'daily_brief');
    assert.equal(calls.filter(path => path === '/v1/automation-templates').length, 1);
    assert.equal(calls.includes(projectedPath), false);
    assert.equal(calls.some(path => path.endsWith('/automations?category=mine')), false);
  } finally {
    finishTeams(respond({items: []}));
    await flush();
  }
});

test('a native result link reads the item early and opens only once its workspace is available', async t => {
  const {doc, elements} = fakeDocument();
  const previous = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = previous; });
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  doc.getElementById('run-panel').scrollIntoView = () => {};
  doc.getElementById('editor-form').hidden = true;
  const workspace = projectedWorkspace, automation = projectedAutomation, run = 'd'.repeat(32);
  doc.defaultView = {location:{search:`?workspace=${workspace}&automation=${automation}&run=${run}`}};
  const session = Promise.withResolvers();
  const personal = Promise.withResolvers();
  const teams = Promise.withResolvers();
  const exact = Promise.withResolvers();
  const detailPath = `/v1/workspaces/${workspace}/automations/${automation}`;
  const exactPath = `${detailPath}/runs/${run}`;
  const item = {id:automation, workspace_id:workspace, title:'通知里的自动化', enabled:false, schedule:{kind:'now'}};
  const result = {id:run, workspace_id:workspace, automation_id:automation, status:'succeeded', result:{text:'已打开确切结果'}};
  const calls = [];
  const mounted = mount(doc, {fetcher: async (path, {method}) => {
    calls.push([method, path]);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/workspaces?scope=personal') return personal.promise;
    if (path === '/v1/workspaces?limit=100') return teams.promise;
    if (path === detailPath) return respond({automation:item});
    if (path === exactPath) return exact.promise;
    if (path === `${detailPath}/runs?limit=20`) return respond({items:[result]});
    throw new Error('unexpected ' + path);
  }});
  try {
    await flush();
    assert.deepEqual(calls, [
      ['GET','/v1/auth/session'],
      ['GET','/v1/workspaces?limit=100'],
      ['GET','/v1/workspaces?scope=personal'],
    ]);
    session.resolve(respond({user:{id:projectedOwner, username:'alice'}}));
    await flush();
    assert.ok(calls.some(([,path]) => path === exactPath));
    assert.equal(elements.get('editor-form').hidden, true);
    assert.doesNotMatch(elements.get('run-list')?.textContent || '', /已打开确切结果/);
    personal.resolve(respond({items:[projectedPersonal]}));
    await flush();
    assert.equal(elements.get('editor-form').hidden, false);
    assert.equal(elements.get('run-link-note').textContent, '正在读取这次运行…');
    assert.equal(elements.get('run-list').children[0].children[1].hidden, true);
    elements.get('editor-form').elements.title.value = '已编辑的标题';
    exact.resolve(respond({run:result}));
    await mounted;
    await flush();
    assert.equal(elements.get('editor-heading').textContent, item.title);
    assert.equal(elements.get('editor-form').elements.title.value, '已编辑的标题');
    assert.equal(elements.get('run-link-status').hidden, true);
    assert.equal(elements.get('run-list').children[0].children[1].hidden, false);
    assert.match(elements.get('run-list').textContent, /已打开确切结果/);
    assert.equal(calls.filter(([,path]) => path === detailPath).length, 1);
    assert.equal(calls.filter(([,path]) => path === exactPath).length, 1);
    assert.ok(calls.every(([method]) => method === 'GET'));
  } finally {
    session.resolve(respond({user:{id:projectedOwner, username:'alice'}}));
    personal.resolve(respond({items:[projectedPersonal]}));
    teams.resolve(respond({items:[projectedPersonal]}));
    exact.resolve(respond({run:result}));
    await mounted;
  }
});

test('an exact onboarding link opens before unrelated loads and an explicit paused run shows its result', async () => {
  const {doc, elements} = fakeDocument();
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const run = 'c'.repeat(32);
  const entry = `?workspace=${workspace}&automation=${automation}`;
  const path = `/v1/workspaces/${workspace}/automations/${automation}`;
  const view = {location: {search: entry, pathname: '/automations'}, history: {
    replaceState(state, title, url) { view.location.search = new URL(url, 'https://test.local').search; },
    pushState(state, title, url) { view.location.search = new URL(url, 'https://test.local').search; },
  }};
  doc.defaultView = view;
  doc.getElementById('run-panel').scrollIntoView = () => {};
  const {promise: templates, resolve: resolveTemplates} = Promise.withResolvers();
  const {promise: teams, resolve: resolveTeams} = Promise.withResolvers();
  const calls = [];
  let started = false;
  const item = {id: automation, workspace_id: workspace, title: '引导创建的日报', enabled: false,
    template_id: 'daily_brief', schedule: {kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}};
  const respond = (body, status = 200) => ({status, json: async () => body});
  const fetcher = async (target, {method} = {}) => {
    calls.push([method, target]);
    if (target === '/v1/auth/session') return respond({user: {username: 'alice'}});
    if (target === '/v1/workspaces?scope=personal') return respond({items: [{id: workspace, name: '个人工作区'}]});
    if (target === '/v1/workspaces?limit=100') return teams;
    if (target === '/v1/automation-templates') return templates;
    if (target.endsWith('/automations?category=mine')) return respond({items: []});
    if (target === path) return respond({automation: item});
    if (target.startsWith(path + '/runs?')) return respond({items: started ? [{id: run, status: 'succeeded', result: {text: '今日简报已整理'}}] : []});
    if (target === path + '/run' && method === 'POST') {
      started = true;
      return respond({run: {id: run, status: 'queued'}}, 202);
    }
    throw new Error('unexpected ' + target);
  };
  const restorePolling = holdRunPolling();
  const saved = globalThis.document;
  globalThis.document = doc;
  const mounted = mount(doc, {fetcher});
  try {
    await flush();
    assert.equal(elements.get('editor-heading').textContent, item.title);
    assert.equal(elements.get('editor-form').hidden, false);
    assert.equal(elements.get('editor-form').elements.enabled.checked, false);
    assert.match(elements.get('manual-run-note').textContent, /仍保持暂停/);
    assert.equal(calls.filter(([method]) => method === 'POST').length, 0);
    assert.equal(calls.some(([, target]) => target.endsWith('/automations?category=mine')), false);
    assert.equal(calls.some(([, target]) => target === '/v1/automation-templates'), false);
    await elements.get('run-filter-succeeded').handlers.click[0]();
    assert.equal(view.location.search, entry + '&runs=succeeded');
    await elements.get('tick-automation').handlers.click[0]();
    assert.equal(view.location.search, entry);
    assert.equal(elements.get('manual-run-status').textContent, '已完成');
    assert.match(elements.get('run-list').textContent, /今日简报已整理/);
    assert.equal(elements.get('run-list').children[0].children[1].hidden, false, 'the requested output opens in place');
    assert.equal(elements.get('editor-form').elements.enabled.checked, false);
    assert.deepEqual(calls.filter(([method]) => method === 'POST'), [['POST', path + '/run']]);
    await elements.get('cancel-editor').handlers.click[0]();
    assert.equal(view.location.search, '');
    assert.equal(calls.filter(([, target]) => target.endsWith('/automations?category=mine')).length, 1);
  } finally {
    resolveTeams(respond({items: []}));
    resolveTemplates(respond({items: []}));
    await mounted;
    restorePolling();
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
});

test('save and sample submits one stable creation request and opens the exact exportable result', async t => {
  const {doc, elements} = fakeDocument();
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const run = 'c'.repeat(32);
  const done = {id: run, workspace_id: workspace, automation_id: automation, status: 'succeeded', result: {text: '今日运行结果'}};
  const clipboard = [];
  const view = {location: {search: '?template=daily_brief', pathname: '/automations', origin: 'https://test.local'},
    navigator: {clipboard: {writeText: async text => clipboard.push(text)}},
    history: {replaceState(_state, _title, url) { view.location.search = new URL(url, 'https://test.local').search; }}};
  doc.defaultView = view;
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const saved = globalThis.document;
  const priorFormData = globalThis.FormData;
  globalThis.document = doc;
  globalThis.FormData = class {
    constructor(form) { this.elements = form.elements; }
    get(name) { return this.elements[name]?.value || ''; }
    has(name) { return Boolean(this.elements[name]?.checked); }
  };
  t.after(() => { globalThis.document = saved; globalThis.FormData = priorFormData; });
  const posts = [];
  const updates = [];
  const path = `/v1/workspaces/${workspace}/automations`;
  let savedAutomation;
  const attempt = async (target, options = {}) => {
    if (target === '/v1/auth/session') return respond({user: {id: 'owner', username: 'alice'}});
    if (target.startsWith('/v1/workspaces?')) return respond({items: [{id: workspace, name: '个人工作区', kind: 'personal'}]});
    if (target === '/v1/automation-templates') return respond({items: [{id: 'daily_brief', title: '工作日报', category: 'work'}]});
    if (target === path && options.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push({body, key: options.headers['Idempotency-Key']});
      if (posts.length === 1) throw Error('Lost response fixture');
      savedAutomation = {...body, id:automation, workspace_id:workspace, revision:1};
      return respond({automation:savedAutomation, sample_run:{...done, status:'queued', result:undefined}}, 201);
    }
    if (target === path + '/' + automation && options.method === 'POST') {
      const update = JSON.parse(options.body);
      updates.push(update);
      savedAutomation = {...savedAutomation, ...update.changes, revision:2};
      return respond({automation:savedAutomation});
    }
    if (target.startsWith(path + '/' + automation + '/runs?')) return respond({items: [done], has_pending: false});
    assert.fail(`Unexpected request ${options.method || 'GET'} ${target}`);
  };
  await mount(doc, {fetcher: attempt});
  const form = elements.get('editor-form');
  const sample = elements.get('save-and-sample');
  assert.equal(elements.get('automation-notification-settings').hidden, false);
  assert.equal(form.elements.notification_policy.value, 'scheduled');
  form.elements.notification_policy.value = 'all';
  assert.equal(sample.hidden, true);
  form.elements.kind.value = 'daily';
  elements.get('automation-schedule-settings').handlers.change[0]();
  assert.equal(sample.hidden, false);
  await form.handlers.submit[0]({preventDefault() {}, submitter: sample});
  await form.handlers.submit[0]({preventDefault() {}, submitter: sample});
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(posts[0].body.run_sample, true);
  assert.equal(posts[0].body.enabled, false);
  assert.equal(posts[0].body.schedule.kind, 'daily');
  assert.equal(posts[0].body.notification_policy, 'all');
  assert.equal(form.elements.notification_policy.value, 'all');
  assert.equal(sample.hidden, true);
  assert.equal(view.location.search, `?workspace=${workspace}&automation=${automation}&run=${run}`);
  const detail = elements.get('run-list').children[0].children[1];
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /今日运行结果/);
  const controls = detail.children.find(child => child.className === 'run-result-actions');
  await controls.children.find(child => child.dataset.runControl === 'copy-result').handlers.click[0]();
  await controls.children.find(child => child.dataset.runControl === 'copy-run-link').handlers.click[0]();
  assert.deepEqual(clipboard, ['今日运行结果', 'https://test.local/automations' + view.location.search]);
  form.elements.notification_policy.value = 'off';
  await form.handlers.submit[0]({preventDefault() {}});
  assert.equal(updates[0].revision, 1);
  assert.equal(updates[0].changes.notification_policy, 'off');
  assert.equal(form.elements.notification_policy.value, 'off');
});

test('an exact linked run stays visible when older than the first page of history', async t => {
  const {doc, elements} = fakeDocument();
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const run = 'c'.repeat(32);
  const work = 'e'.repeat(32);
  const path = `/v1/workspaces/${workspace}/automations/${automation}`;
  doc.defaultView = {location: {search: `?workspace=${workspace}&automation=${automation}&run=${run}`}};
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const saved = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = saved; });
  const calls = [];
  const savedRun = {id: run, workspace_id: workspace, automation_id: automation, status: 'succeeded',
    result: {text: '历史样例'}, saved_work: {id:work, title:'重命名的作品'}};
  await mount(doc, {fetcher: async target => {
    calls.push(target);
    if (target === '/v1/auth/session') return respond({user: {id: 'owner', username: 'alice'}});
    if (target.startsWith('/v1/workspaces?')) return respond({items: [{id: workspace, name: '个人工作区', kind: 'personal'}]});
    if (target === path) return respond({automation: {id: automation, workspace_id: workspace, title: '日报', enabled: false}});
    if (target === path + '/runs/' + run) return respond({run: savedRun});
    if (target.startsWith(path + '/runs?')) return respond({items: [{...savedRun, id: 'd'.repeat(32),
      result: {text:'最新运行'}, saved_work:null}]});
    assert.fail('Unexpected request ' + target);
  }});
  await flush();
  assert.equal(elements.get('editor-form').elements.notification_policy.value, 'scheduled');
  const [exact, newest] = elements.get('run-list').children;
  assert.equal(exact.dataset.runId, run);
  assert.equal(exact.children[1].hidden, false);
  assert.equal(newest.children[1].hidden, true);
  assert.match(exact.textContent, /历史样例/);
  const link = exact.children[1].children.find(child => child.dataset.runControl === 'artifact');
  assert.equal(link.textContent,'打开作品');
  assert.equal(link.href,`/space?workspace=${workspace}&artifact=${work}`);
  assert.equal(link.title,'重命名的作品');
  assert.equal(newest.children[1].children.find(child => child.dataset.runControl === 'artifact').textContent,'保存到作品库');
  assert.equal(calls.filter(target => target === path + '/runs/' + run).length, 1);
});

for (const [outcome, committed, receiptWorkspace, expectedStatus] of [
  ['recovers the committed work', true, 'a', '已保存到作品库。'],
  ['keeps retry available when no receipt exists', false, 'a', '作品库暂未显示这次结果，可以重试保存。'],
  ['ignores a receipt from another workspace', true, 'f', '暂时无法确认是否已保存，可以重试。'],
]) {
  test(`a lost result-save response ${outcome}`, async t => {
    const {doc, elements} = fakeDocument();
    const workspace = 'a'.repeat(32), automation = 'b'.repeat(32), run = 'c'.repeat(32);
    const artifact = {id:'e'.repeat(32), title:'运行结果'};
    const exact = `/v1/workspaces/${workspace}/automations/${automation}`;
    const runPath = exact+'/runs/'+run;
    const output = {id:run, workspace_id:workspace, automation_id:automation, status:'succeeded',
      result:{text:'待保存的结果'}, saved_work:null};
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    doc.defaultView = {location:{search:`?workspace=${workspace}&automation=${automation}&run=${run}`}};
    let attempted = false;
    const calls = [];
    await mount(doc, {fetcher:async (path, options = {}) => {
      calls.push([options.method,path]);
      if (path === '/v1/auth/session') return respond({user:{id:'owner',username:'alice'}});
      if (path.startsWith('/v1/workspaces?')) return respond({items:[{id:workspace,name:'个人空间',kind:'personal'}]});
      if (path === exact) return respond({automation:{id:automation,workspace_id:workspace,title:'日报',enabled:false}});
      if (path.startsWith(exact+'/runs?')) return respond({items:[{...output,
        saved_work:attempted && committed && receiptWorkspace === 'a' ? artifact : null}]});
      if (path === runPath) return respond({run:attempted
        ? {...output,workspace_id:receiptWorkspace.repeat(32),saved_work:committed? artifact : null} : output});
      if (path === runPath+'/artifact' && options.method === 'POST') {
        attempted = true;
        throw new TypeError('response lost');
      }
      assert.fail('Unexpected request '+path);
    }});
    await flush();
    const control = () => elements.get('run-list').children[0].children[1].children
      .find(child=>child.dataset.runControl==='artifact');
    await control().handlers.click[0]();
    assert.equal(elements.get('status').textContent,expectedStatus);
    assert.equal(calls.filter(([method,path])=>method==='POST' && path===runPath+'/artifact').length,1);
    assert.equal(calls.filter(([method,path])=>method==='GET' && path===runPath).length,2);
    if (committed && receiptWorkspace === 'a') {
      assert.equal(control().href,`/space?workspace=${workspace}&artifact=${artifact.id}`);
    } else {
      assert.equal(control().textContent,'保存到作品库');
      assert.equal(control().disabled,false);
    }
  });
}

for (const outcome of ['confirmed', 'different schedule', 'wrong workspace']) {
  test(`a lost settings acknowledgment handles ${outcome} and keeps newer typing`, async t => {
    const {doc, elements} = fakeDocument();
    const workspace = 'a'.repeat(32), automation = 'b'.repeat(32), owner = 'c'.repeat(32);
    const path = `/v1/workspaces/${workspace}/automations/${automation}`;
    const scheduled = {kind:'weekly', weekday:2, time:'09:00', time_zone:'Asia/Shanghai'};
    const initial = {id:automation, workspace_id:workspace, title:'发布检查', revision:4,
      template_id:'custom', prompt:'保存前', schedule:scheduled, participants:[{username:'alice'}], agents:[],
      intent:'', scope:'once', enabled:false, notification_policy:'scheduled'};
    const response = Promise.withResolvers();
    const stored = new Map();
    const requests = [];
    let latest = initial;
    doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
    doc.defaultView = {location:{search:`?workspace=${workspace}&automation=${automation}`,pathname:'/automations'},
      sessionStorage:{getItem:key => stored.get(key), setItem:(key,value) => stored.set(key,value),
        removeItem:key => stored.delete(key)}};
    const originalFormData = globalThis.FormData;
    globalThis.FormData = class {
      constructor(form) { this.elements = form.elements; }
      get(name) { return this.elements[name]?.value || ''; }
      has(name) { return Boolean(this.elements[name]?.checked); }
    };
    t.after(() => { globalThis.FormData = originalFormData; });
    await mount(doc, {fetcher:async (target, options = {}) => {
      if (target === '/v1/auth/session') return respond({user:{id:owner,username:'alice'}});
      if (target.startsWith('/v1/workspaces?')) return respond({items:[{id:workspace,name:'空间'}]});
      if (target.startsWith(path + '/runs?')) return respond({items:[]});
      if (target === path && options.method === 'GET') {
        requests.push('GET');
        return respond({automation:latest});
      }
      if (target === path && options.method === 'POST') {
        const body = JSON.parse(options.body);
        requests.push(body.revision);
        const {participants, ...settings} = body.changes;
        latest = {...initial, ...settings, revision:body.revision+1, participants:participants.map(username => ({username}))};
        if (requests.length === 2) {
          if (outcome === 'wrong workspace') latest.workspace_id = 'd'.repeat(32);
          if (outcome === 'different schedule') latest.schedule = {...scheduled, weekday:3};
          await response.promise;
          throw new TypeError('response lost after commit');
        }
        return respond({automation:latest});
      }
      assert.fail('Unexpected request '+target);
    }});
    const form = elements.get('editor-form');
    const submit = () => form.handlers.submit[0]({preventDefault() {}});
    form.elements.prompt.value = '提交的指令';
    form.handlers.input[0]();
    const saving = submit();
    form.elements.prompt.value = '等待期间输入的指令';
    form.handlers.input[0]();
    response.resolve();
    await saving;
    assert.deepEqual(requests, ['GET', 4, 'GET']);
    assert.equal(form.elements.prompt.value, '等待期间输入的指令');
    if (outcome === 'confirmed') {
      assert.equal(elements.get('status').textContent, '已保存提交的设置。仍有未保存的修改。');
      const draft = JSON.parse([...stored.values()][0]);
      assert.equal(draft.revision, 5);
      assert.deepEqual(draft.values,{prompt:'等待期间输入的指令'});
      await submit();
      assert.deepEqual(requests, ['GET', 4, 'GET', 5]);
      assert.equal(latest.prompt, '等待期间输入的指令');
      assert.equal(stored.size,0);
    } else {
      assert.equal(elements.get('status').textContent, '暂时无法确认保存结果。草稿已保留，请重试。');
      assert.equal(JSON.parse([...stored.values()][0]).revision,4);
    }
  });
}

test('exact failure and retry links are scoped and render without waiting for filtered history', async () => {
  const {doc, elements} = fakeDocument();
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const original = 'c'.repeat(32);
  const retry = 'd'.repeat(32);
  const path = `/v1/workspaces/${workspace}/automations/${automation}`;
  const history = Promise.withResolvers();
  const older = {id:original, workspace_id:workspace, automation_id:automation, status:'failed',
    error_code:'provider_error', latest_retry:{id:retry,status:'succeeded'}};
  doc.defaultView = {location:{search:`?workspace=${workspace}&automation=${automation}&run=${original}&runs=failed`}};
  await mount(doc, {fetcher:async target => {
    if (target === '/v1/auth/session') return respond({user:{id:'owner',username:'alice'}});
    if (target.startsWith('/v1/workspaces?')) return respond({items:[{id:workspace,name:'个人工作区',kind:'personal'}]});
    if (target === path) return respond({automation:{id:automation,workspace_id:workspace,title:'日报',enabled:false}});
    if (target === path+'/runs/'+original) return respond({run:older});
    if (target === path+'/runs?limit=20&status=failed') return history.promise;
    assert.fail('Unexpected request ' + target);
  }});
  const exact = elements.get('run-list').children[0];
  assert.equal(exact.dataset.runId,original);
  assert.equal(elements.get('run-filter-failed').attributes['aria-current'],'true');
  assert.match(exact.textContent,/模型提供方/);
  const link = exact.children[1].children.flatMap(child=>child.children).find(child=>child.dataset.runControl==='latest-retry');
  assert.equal(link.textContent,'查看重试 · 已完成');
  assert.equal(link.href,`/automations?workspace=${workspace}&automation=${automation}&run=${retry}`);
  history.resolve(respond({items:[]}));
  await flush();
  assert.equal(elements.get('run-list').children[0].dataset.runId,original);
});

const SOURCE_WORKSPACE = 'a'.repeat(32);
const SOURCE_MEETING = 'b'.repeat(32);
const FOLLOW_UP = 'c'.repeat(32);
const SOURCE_LINK = `?workspace=${SOURCE_WORKSPACE}&meeting=${SOURCE_MEETING}&action=1&revision=4`;
const SOURCE_PATH = `/v1/workspaces/${SOURCE_WORKSPACE}/meetings/${SOURCE_MEETING}/action?index=1&revision=4`;
const SOURCE_LOOKUP = `/v1/workspaces/${SOURCE_WORKSPACE}/automations?meeting=${SOURCE_MEETING}&revision=4&action=1`;
const SOURCE = {
  meeting: {id: SOURCE_MEETING, workspace_id: SOURCE_WORKSPACE, title: '交付例会', revision: 4, transcript: '会议私有全文'},
  action: {index: 1, text: '列出待核对的交付项', owner: 'Bob', done: false},
  viewer_username: 'alice',
};
const respond = (body, status = 200) => ({status, json: async () => body});
const SAVED_SOURCE = {meeting_id: SOURCE_MEETING, revision: 4, action_index: 1, title: SOURCE.meeting.title, text: SOURCE.action.text, owner: SOURCE.action.owner};

function mountMemoryFollowup(t, {changed = false, otherViewer = false} = {}) {
  const {doc, elements} = fakeDocument();
  doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const actionId = 'd'.repeat(32);
  const action = {id: actionId, workspace_id: SOURCE_WORKSPACE, revision: 2, status: 'open',
    title: '核对客户需求', notes: '只整理已经确认的事实。', due_at: null};
  const entry = `?workspace=${SOURCE_WORKSPACE}&memory_action=${actionId}&revision=2`;
  const view = {location: {search: entry, pathname: '/automations'}, history: {
    replaceState(_state, _title, url) { view.location.search = new URL(url, 'https://test.local').search; },
  }};
  doc.defaultView = view;
  const savedDocument = globalThis.document;
  const savedFormData = globalThis.FormData;
  globalThis.document = doc;
  globalThis.FormData = class {
    constructor(form) { this.elements = form.elements; }
    get(name) { return this.elements[name]?.value || ''; }
    has(name) { return Boolean(this.elements[name]?.checked); }
  };
  t.after(() => { globalThis.document = savedDocument; globalThis.FormData = savedFormData; });
  const calls = [];
  const path = `/v1/workspaces/${SOURCE_WORKSPACE}/automations`;
  const mounted = mount(doc, {fetcher: async (target, {method, body, headers} = {}) => {
    calls.push({target, method, body: body && JSON.parse(body), headers});
    if (target === '/v1/auth/session') return respond({user: {username:'alice'}});
    if (target.startsWith('/v1/workspaces?')) return respond({items:[{id:SOURCE_WORKSPACE, name:'个人工作区', kind:'personal'}]});
    if (target === path + `?memory_action=${actionId}&revision=2`) {
      return respond({automation:null, action:{...action, revision: changed ? 3 : 2}, viewer_username: otherViewer ? 'carol' : 'alice'});
    }
    if (target === path && method === 'POST') {
      return respond({automation:{...JSON.parse(body), id:FOLLOW_UP, workspace_id:SOURCE_WORKSPACE, enabled:false,
        source_memory_action:{action_id:actionId, revision:2, title:action.title, notes:action.notes, due_at:null}}}, 201);
    }
    if (target.endsWith('/automations?category=mine') || target.endsWith('/runs?limit=20')) return respond({items:[]});
    assert.fail('Unexpected request ' + method + ' ' + target);
  }});
  return {mounted, elements, calls, action, view};
}

test('the memory action drafts a paused, editable follow-up and saves the exact reviewed reference', async t => {
  const {mounted, elements, calls, action, view} = mountMemoryFollowup(t);
  await mounted;
  const form = elements.get('editor-form');
  assert.equal(form.hidden, false);
  assert.equal(elements.get('memory-action-source').hidden, false);
  assert.match(elements.get('memory-action-source-revision').textContent, /2/);
  assert.match(form.elements.prompt.value, /只整理已经确认的事实/);
  assert.equal(elements.get('memory-action-source-link').href,
    `/memory?workspace=${SOURCE_WORKSPACE}&page=todos&action=${action.id}`);
  assert.equal(elements.get('tick-automation').hidden, true);
  assert.equal(elements.get('save-and-sample').hidden, true);
  assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
  form.elements.prompt.value = '用户明确编辑的跟进指令';
  form.elements.enabled.checked = true;
  await form.handlers.submit[0]({preventDefault() {}});
  const posts = calls.filter(({method}) => method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.source_memory_action, {action_id: action.id, revision: 2});
  assert.equal(posts[0].body.prompt, '用户明确编辑的跟进指令');
  assert.equal(posts[0].body.enabled, false);
  assert.equal(elements.get('memory-action-source-notes').textContent, action.notes);
  assert.equal(elements.get('tick-automation').hidden, false);
  assert.equal(view.location.search, `?workspace=${SOURCE_WORKSPACE}&automation=${FOLLOW_UP}`);
});

test('a different viewer or changed memory action never populates the editor', async t => {
  for (const options of [{otherViewer:true}, {changed:true}]) {
    await t.test(Object.keys(options)[0], async sub => {
      const {mounted, elements, calls} = mountMemoryFollowup(sub, options);
      await mounted;
      assert.equal(elements.get('editor-form').hidden, true);
      assert.match(elements.get('status').textContent, /记忆行动项已更新/);
      assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
    });
  }
});

function mountFollowUp(t, {readFollowup = () => respond(SOURCE), saveStatus = 201,
  workspaces = [{id: SOURCE_WORKSPACE, name: '个人空间'}]} = {}) {
  const {doc, elements} = fakeDocument();
  const view = {location: {search: SOURCE_LINK, pathname: '/automations'}, history: {
    replaceState(state, title, url) { view.location.search = new URL(url, 'https://test.local').search; },
  }};
  doc.defaultView = view;
  const calls = [];
  const saved = globalThis.document;
  const savedFormData = globalThis.FormData;
  globalThis.document = doc;
  globalThis.FormData = class {
    constructor(form) { this.elements = form.elements; }
    get(name) { return this.elements[name]?.value || ''; }
    has(name) { return Boolean(this.elements[name]?.checked); }
  };
  t.after(() => { globalThis.document = saved; globalThis.FormData = savedFormData; });
  const mounted = mount(doc, {fetcher: async (target, options) => {
    const {method, body, headers, signal} = options;
    calls.push({target, method, body: body && JSON.parse(body), headers, signal});
    if (target === '/v1/auth/session') return respond({user: {username: 'alice'}});
    if (target === '/v1/workspaces?scope=personal') return respond({items: workspaces});
    if (target === '/v1/workspaces?limit=100') return respond({items: workspaces});
    if (target === '/v1/automation-templates') return respond({items: []});
    if (target === SOURCE_LOOKUP) return readFollowup();
    if (target.endsWith('/automations?category=mine') || target.endsWith('/runs?limit=20')) return respond({items: []});
    if (target === `/v1/workspaces/${SOURCE_WORKSPACE}/automations` && method === 'POST') {
      if (saveStatus !== 201) return respond({error: {code: 'meeting_source_unavailable'}}, saveStatus);
      return respond({automation: {...JSON.parse(body), id: FOLLOW_UP, workspace_id: SOURCE_WORKSPACE, revision: 1, source_meeting: SAVED_SOURCE}}, 201);
    }
    throw new Error('unexpected ' + method + ' ' + target);
  }});
  return {mounted, view, elements, calls};
}

test('a reviewed meeting follow-up explicitly saves paused and replaces the draft URL', async t => {
  const {mounted, elements, calls, view} = mountFollowUp(t);
  await mounted;
  const form = elements.get('editor-form');
  assert.equal(form.hidden, false);
  assert.equal(elements.get('meeting-action-source').hidden, false);
  assert.equal(elements.get('meeting-action-source-title').textContent, '交付例会');
  assert.equal(elements.get('meeting-action-source-text').textContent, '列出待核对的交付项');
  assert.equal(elements.get('meeting-action-source-owner').textContent, '原负责人：Bob');
  assert.equal(elements.get('meeting-action-source-link').href, '/meetings#' + SOURCE_LINK.slice(1));
  assert.equal(form.elements.title.value, '会议跟进：交付例会 · 行动项 2');
  assert.match(form.elements.prompt.value, /列出待核对的交付项/);
  assert.doesNotMatch(form.elements.prompt.value, /会议私有全文/);
  assert.equal(form.elements.enabled.checked, false);
  assert.equal(form.elements.enabled.disabled, true);
  assert.equal(elements.get('tick-automation').hidden, true);
  assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
  form.elements.prompt.value += '\n增加完整性检查。';
  form.elements.enabled.checked = true;
  await form.handlers.submit[0]({preventDefault() {}});
  const writes = calls.filter(({method}) => method === 'POST');
  assert.equal(calls.filter(({target}) => target === SOURCE_PATH).length, 0);
  const reads = calls.filter(({target}) => target === SOURCE_LOOKUP);
  assert.equal(reads.length, 1);
  assert.ok(reads[0].signal instanceof AbortSignal);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].target, `/v1/workspaces/${SOURCE_WORKSPACE}/automations`);
  assert.equal(writes[0].body.enabled, false);
  assert.deepEqual(writes[0].body.participants, ['alice']);
  assert.equal(writes[0].body.template_id, 'custom');
  assert.deepEqual(writes[0].body.source_meeting, {meeting_id: SOURCE_MEETING, revision: 4, action_index: 1});
  assert.match(writes[0].body.prompt, /增加完整性检查/);
  assert.match(writes[0].headers['Idempotency-Key'], /^[a-z0-9_-]{16,64}$/i);
  assert.equal(elements.get('meeting-action-source').hidden, false);
  assert.equal(form.elements.enabled.disabled, false);
  assert.equal(elements.get('tick-automation').hidden, false);
  assert.equal(view.location.search, `?workspace=${SOURCE_WORKSPACE}&automation=${FOLLOW_UP}`);
});

test('meeting follow-up blocks a completed action or changed revision before saving', async t => {
  const {mounted, elements, calls} = mountFollowUp(t, {saveStatus: 409});
  await mounted;
  await elements.get('editor-form').handlers.submit[0]({preventDefault() {}});
  assert.equal(calls.filter(({method}) => method === 'POST').length, 1);
  assert.match(elements.get('status').textContent, /行动项已更新/);
  assert.equal(elements.get('tick-automation').hidden, true);
});

test('an older exact meeting-action link resumes the saved follow-up even after the meeting changes', async t => {
  const lookup = {id: FOLLOW_UP, workspace_id: SOURCE_WORKSPACE, revision: 3, enabled: true, title: '跟进原行动项', source_meeting: SAVED_SOURCE};
  const {mounted, elements, calls, view} = mountFollowUp(t, {
    readFollowup: () => respond({automation:lookup, viewer_username:'alice'}),
  });
  await mounted;
  assert.equal(elements.get('editor-form').elements.title.value, '跟进原行动项');
  assert.equal(elements.get('editor-form').elements.enabled.checked, true);
  assert.equal(elements.get('editor-form').elements.enabled.disabled, false);
  assert.equal(elements.get('meeting-action-source-text').textContent, SAVED_SOURCE.text);
  assert.equal(elements.get('tick-automation').hidden, false);
  assert.equal(view.location.search, `?workspace=${SOURCE_WORKSPACE}&automation=${FOLLOW_UP}`);
  assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
  await elements.get('cancel-editor').handlers.click[0]();
});

test('meeting follow-up never asks for a meeting from an unverified workspace', async t => {
  const {mounted, elements, calls} = mountFollowUp(t, {workspaces: [{id: 'd'.repeat(32), name: '另一工作区'}]});
  await mounted;
  assert.equal(elements.get('editor-form').hidden, true);
  assert.match(elements.get('status').textContent, /会议行动项链接已不可用/);
  assert.equal(calls.some(({target}) => [SOURCE_PATH, SOURCE_LOOKUP].includes(target)), false);
});

test('a response for a different viewer or action cannot populate the meeting follow-up editor', async t => {
  for (const [field, reply] of [
    ['viewer', {...SOURCE, viewer_username:'other'}],
    ['action', {...SOURCE, action:{...SOURCE.action, index:0}}],
  ]) {
    await t.test(field, async sub => {
      const {mounted, elements, calls} = mountFollowUp(sub, {readFollowup: () => respond(reply)});
      await mounted;
      assert.equal(elements.get('editor-form').hidden, true);
      assert.equal(elements.get('editor-form').elements.prompt.value, '');
      assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
    });
  }
});

test('switching workspaces drops a meeting follow-up still loading', async t => {
  const source = Promise.withResolvers();
  const different = 'd'.repeat(32);
  const {mounted, view, elements, calls} = mountFollowUp(t, {readFollowup: () => source.promise,
    workspaces: [{id: SOURCE_WORKSPACE, name: '个人空间'}, {id: different, name: '另一工作区'}]});
  await flush();
  assert.ok(calls.some(call => call.target === SOURCE_LOOKUP));
  const workspace = elements.get('workspace');
  workspace.value = different;
  workspace.handlers.change[0]();
  source.resolve(respond(SOURCE));
  await mounted;
  assert.equal(elements.get('editor-form').hidden, true);
  assert.equal(view.location.search, '');
  assert.equal(calls.filter(({method}) => method === 'POST').length, 0);
});

test('leaving an opened meeting draft clears its source context', async t => {
  const {mounted, view, elements} = mountFollowUp(t);
  await mounted;
  await elements.get('cancel-editor').handlers.click[0]();
  assert.equal(elements.get('editor-form').hidden, true);
  assert.equal(elements.get('editor-form').elements.prompt.value, '');
  assert.equal(elements.get('editor-form').elements.enabled.disabled, false);
  assert.equal(elements.get('meeting-action-source-text').textContent, '');
  assert.equal(view.location.search, '');
});

test('scheduleSummary writes the editor wording for every recorded schedule kind', () => {
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'Asia/Shanghai'}, true), '立即运行 · 已启用');
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'UTC'}, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '每天 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '18:00', time_zone: 'UTC'}, true), '每天 18:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}, true), '每周四 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekdays', time: '08:30', time_zone: 'Asia/Shanghai'}, true), '工作日 08:30（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'monthly', time: '09:00', day: 16, time_zone: 'Asia/Shanghai'}, true), '每月 16 日 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '单次 2026-11-20 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'later', date: '2026-11-20', time: '08:00', time_zone: 'UTC'}, true), '单次 2026-11-20 08:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, false), '每天 09:00（Asia/Shanghai）· 未启用');
  assert.equal(scheduleSummary(null, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'mystery', time_zone: 'UTC'}, true).includes('mystery'), false, 'an unknown kind is never echoed to the reader');
});

test('list rows describe the schedule instead of printing the internal kind', async () => {
  const {list} = await mountList([
    {id: 'a1', title: '每日简报', enabled: true, schedule: {kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a2', title: '周报', enabled: true, schedule: {kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}},
    {id: 'a3', title: '一次性提醒', enabled: true, schedule: {kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a4', title: '立即运行的任务', enabled: true, schedule: {kind: 'now', time_zone: 'Asia/Shanghai'}},
    {id: 'a5', title: '每月复盘', enabled: false, schedule: {kind: 'monthly', time: '18:00', day: 16, time_zone: 'UTC'}},
  ]);
  const rows = list.children.map(row => row.textContent);
  assert.match(rows[0], /每日简报/);
  assert.match(rows[0], /每天 09:00（Asia\/Shanghai）已启用/);
  assert.match(rows[1], /周报/);
  assert.match(rows[1], /每周四 09:00（Asia\/Shanghai）已启用/);
  assert.match(rows[2], /一次性提醒/);
  assert.match(rows[2], /单次 2026-11-20 09:00（Asia\/Shanghai）已启用/);
  assert.match(rows[3], /立即运行的任务/);
  assert.match(rows[3], /立即运行已启用/);
  assert.match(rows[4], /每月复盘/);
  assert.match(rows[4], /每月 16 日 18:00（UTC）未启用/);
  const joined = list.textContent;
  assert.doesNotMatch(joined, /(?:^|\s)(?:now|later|once|daily|weekly|monthly|weekdays)(?=\s|$)/u,
    `the list must not print an internal schedule kind: ${joined}`);
});
const flush = () => new Promise(resolve => setImmediate(resolve));

const AUTOMATION = {
  id: 'a1', title: '每日简报', enabled: true,
  schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
};

function postCount(calls, fragment) {
  return calls.filter(entry => entry.startsWith('POST ') && entry.includes(fragment)).length;
}

// Stub poll timers while the editor is mounted in Node.
function holdRunPolling(schedule = () => 0) {
  const saved = {setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = () => {};
  return () => {
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
  };
}

async function mountEditor({items = [AUTOMATION], runs = [], workspaces = [{id: 'ws1', name: '团队'}],
  search = '', pushes = [], windowHandlers = {}, schedulePoll, getRuns} = {}) {
  // The click handlers resolve `document` and the run poll from globals, so both
  // stay installed until the test calls restore().
  const restorePolling = holdRunPolling(schedulePoll);
  const {doc, elements} = fakeDocument();
  const view = {
    location: {search},
    history: {pushState(state, title, url) { pushes.push(url); view.location.search = url; }},
    addEventListener(type, handler) { (windowHandlers[type] ||= []).push(handler); },
  };
  doc.defaultView = view;
  const calls = [];
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: workspaces})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    const listed = path.match(/^\/v1\/workspaces\/([^/]+)\/automations\?category=mine$/);
    if (method === 'GET' && listed) return {status: 200, json: async () => ({items})};
    const listedRuns = path.match(/^\/v1\/workspaces\/([^/]+)\/automations\/([^/]+)\/runs\?limit=20(?:&status=([a-z]+))?$/);
    if (method === 'GET' && listedRuns) {
      const wanted = listedRuns[3] || '';
      const allRows = getRuns ? await getRuns() : runs;
      const rows = allRows.filter(item => !wanted || item.status === wanted);
      return {status: 200, json: async () => ({items: listedRuns[2] === items[0]?.id ? rows : []})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/automations\/[^/]+\/remove$/.test(path)) {
      return {status: 200, json: async () => ({})};
    }
    const cancellation = path.match(/^\/v1\/workspaces\/([^/]+)\/automations\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancellation) {
      const [,workspace_id,automation_id,id] = cancellation;
      return {status: 200, json: async () => ({run:{workspace_id,automation_id,id,status:'cancelled'}})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/automations\/[^/]+$/.test(path)) {
      return {status: 200, json: async () => ({automation: {...AUTOMATION, title: '新的标题', revision: 2}})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  await mount(doc, {fetcher});
  return {
    doc, elements, calls, view,
    restore() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
      restorePolling();
    },
  };
}

// A list row is `li > [avatar, copy > [open, schedule], state]`; the open
// button is the only control in a row that carries a click handler.
function openButtonIn(row) {
  const button = row.children.flatMap(node => [node, ...(node.children || [])])
    .find(node => node.handlers && node.handlers.click);
  assert.ok(button, 'the list row must offer a button that opens the automation');
  return button;
}

async function openFirst(elements) {
  const list = elements.get('automation-list');
  assert.ok(list.children.length, 'the list must render the automation before it can be opened');
  openButtonIn(list.children[0]).handlers.click[0]();
  await flush();
}

test('run polling waits for the current request and keeps watching an enabled schedule', async () => {
  const timers = [];
  const {promise: nextRuns, resolve: resolveNext} = Promise.withResolvers();
  let requests = 0;
  const queued = {id: 'r1', status: 'queued', started: 1795085700};
  const succeeded = {...queued, status: 'succeeded'};
  const {elements, restore} = await mountEditor({
    schedulePoll(callback, delay) {
      timers.push({callback, delay});
      return timers.length;
    },
    getRuns: () => ++requests === 1 ? [queued] : nextRuns,
  });
  try {
    await openFirst(elements);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3000);
    timers.shift().callback();
    await flush();
    assert.equal(requests, 2);
    assert.equal(timers.length, 0, 'a slow request must have time to finish');
    resolveNext([succeeded]);
    await flush();
    assert.match(elements.get('run-list').textContent, /已完成/);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 12000, 'an enabled task still watches for scheduled runs');
  } finally {
    resolveNext([succeeded]);
    restore();
  }
});

function alertdialogIn(parent) {
  return parent.children.find(node => node.getAttribute('role') === 'alertdialog');
}

function labelledQuestion(box) {
  return box.children.find(node => node.id === box.getAttribute('aria-labelledby'));
}

test('删除先在原位问一次，确认前 0 请求、确认后恰好 1 次 remove', async () => {
  const {elements, calls, restore} = await mountEditor();
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 0,
      'clicking 删除 must not send the remove request before the user confirms');
    const box = alertdialogIn(form);
    assert.ok(box, 'clicking 删除 must put an alertdialog where the 删除 button was');
    const question = labelledQuestion(box);
    assert.ok(question, 'the alertdialog must label itself through aria-labelledby');
    assert.equal(question.textContent, '删除这条自动化？');
    const labels = box.children.map(node => node.textContent);
    assert.ok(labels.includes('取消'), 'the delete question must offer 取消');
    assert.ok(labels.includes('确认'), 'the delete question must offer 确认');
    assert.equal(remove.hidden, true, 'the 删除 button is replaced by the question while it is open');
    const cancel = box.children.find(node => node.textContent === '取消');
    assert.equal(cancel.focused, true, 'focus must start on 取消, the safe choice');
    box.children.find(node => node.textContent === '确认').handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 1, 'confirming must send exactly one remove request');
    assert.equal(elements.get('status').textContent, '已删除。');
    assert.equal(elements.get('editor-form').hidden, true, 'a confirmed delete returns to the list');
    assert.equal(alertdialogIn(form), undefined);
  } finally { restore(); }
});

test('取消运行先在原位问一次，确认前 0 请求、确认后恰好 1 次 cancel', async () => {
  const {elements, calls, restore} = await mountEditor({
    items: [{...AUTOMATION,id:'a'.repeat(32)}], workspaces: [{id:'b'.repeat(32), name:'团队'}],
    runs: [{id:'c'.repeat(32), status:'queued'}],
  });
  try {
    await openFirst(elements);
    const runList = elements.get('run-list');
    const runRow = runList.children[0];
    const head = runRow.children[0];
    const trigger = head.children.find(node => node.textContent === '取消这次运行');
    assert.ok(trigger, 'a queued run must offer 取消这次运行');
    trigger.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/cancel'), 0,
      'clicking 取消这次运行 must not send the cancel request before the user confirms');
    const box = alertdialogIn(head);
    assert.ok(box, 'clicking 取消这次运行 must put an alertdialog in the run row');
    const question = labelledQuestion(box);
    assert.equal(question.textContent, '取消这次运行？');
    const confirm = box.children.find(node => node.textContent === '确认取消');
    assert.ok(confirm, 'the run question must offer 确认取消');
    assert.equal(box.children.find(node => node.textContent === '取消').focused, true);
    confirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/cancel'), 1, 'confirming must send exactly one cancel request');
    assert.equal(elements.get('status').textContent, '已取消。');
  } finally { restore(); }
});

test('Esc 与取消都只关闭问句、0 请求，并把焦点还给触发按钮', async () => {
  const {doc, elements, calls, restore} = await mountEditor();
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.ok(doc.handlers.keydown && doc.handlers.keydown.length,
      'the page has no Escape handler, so Esc cannot close the delete question');
    doc.handlers.keydown[0]({key: 'Escape', preventDefault() {}});
    await flush();
    assert.equal(postCount(calls, '/remove'), 0, 'Esc must close the delete question without sending a request');
    assert.equal(remove.hidden, false, 'Esc must bring the 删除 button back');
    assert.equal(remove.focused, true, 'Esc must return focus to the 删除 button it replaced');
    assert.equal(alertdialogIn(form), undefined);

    remove.focused = false;
    remove.handlers.click[0]();
    await flush();
    const box = alertdialogIn(form);
    box.children.find(node => node.textContent === '取消').handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 0, 'the 取消 button must close the delete question without sending a request');
    assert.equal(remove.focused, true, 'the 取消 button must return focus to the 删除 button');
    assert.equal(alertdialogIn(form), undefined);
  } finally { restore(); }
});

test('deletePrompt and cancellationPrompt carry the confirmation wording', () => {
  assert.deepEqual(deletePrompt({id: 'a1', title: '每日简报'}), {
    question: '删除这条自动化？', confirmLabel: '确认',
  });
  assert.deepEqual(cancellationPrompt({id: 'r1', status: 'queued'}), {
    question: '取消这次运行？', confirmLabel: '确认取消',
  });
});

test('切工作区后问句关闭，残留确认也只能打到快照里的工作区', async () => {
  const {elements, calls, restore} = await mountEditor({
    workspaces: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个团队'}],
  });
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.equal(labelledQuestion(alertdialogIn(form)).textContent, '删除这条自动化？');
    const staleConfirm = alertdialogIn(form).children.find(node => node.textContent === '确认');

    const select = elements.get('workspace');
    select.value = 'ws2';
    select.handlers.change[0]();
    await flush();

    assert.equal(alertdialogIn(form), undefined,
      'changing workspace must close the question that belongs to ws1, not leave it open on ws2');
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'changing workspace itself must never send a request for ws2');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'a confirm that is still reachable must use the workspace snapshotted when it opened, never ws2');
    assert.equal(postCount(calls, '/workspaces/ws1/automations/a1/remove'), 1,
      'the confirm must delete the automation it asked about, in the workspace it asked about');
  } finally { restore(); }
});

test('返回列表再打开第二条时旧问句不跟随，确认也不删第二条', async () => {
  const {elements, calls, restore} = await mountEditor({
    items: [AUTOMATION, {id: 'a2', title: '周报', enabled: true, schedule: {kind: 'now', time_zone: 'Asia/Shanghai'}}],
  });
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    const staleConfirm = alertdialogIn(form).children.find(node => node.textContent === '确认');

    elements.get('cancel-editor').handlers.click[0]();
    await flush();
    assert.equal(alertdialogIn(form), undefined,
      'returning to the list must close the question instead of hiding it inside the form');
    assert.notEqual(remove.focused, true,
      'leaving the editor must not move focus onto the 删除 button, which is about to be hidden');

    const list = elements.get('automation-list');
    assert.equal(list.children.length, 2, 'the list must still offer both automations');
    openButtonIn(list.children[1]).handlers.click[0]();
    await flush();
    assert.equal(alertdialogIn(form), undefined,
      'opening the second automation must not bring the first automation question back');
    assert.equal(postCount(calls, '/remove'), 0, 'opening the second automation must send no remove request');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/automations/a2/remove'), 0,
      'a confirm must never delete the second automation the user was never asked about');
    assert.equal(postCount(calls, '/automations/a1/remove'), 1,
      'a leftover confirm may only act on the automation it asked about');
  } finally { restore(); }
});

test('取消运行的问句同样绑定快照，切工作区后确认也不改道', async () => {
  const {elements, calls, restore} = await mountEditor({
    workspaces: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个团队'}],
    runs: [{id: 'r1', status: 'queued'}],
  });
  try {
    await openFirst(elements);
    const head = elements.get('run-list').children[0].children[0];
    const trigger = head.children.find(node => node.textContent === '取消这次运行');
    trigger.handlers.click[0]();
    await flush();
    const staleConfirm = alertdialogIn(head).children.find(node => node.textContent === '确认取消');

    const select = elements.get('workspace');
    select.value = 'ws2';
    select.handlers.change[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'changing workspace itself must never send a request for ws2');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'a run cancel confirm must use the workspace snapshotted when it opened, never ws2');
    assert.equal(postCount(calls, '/v1/workspaces/ws1/automations/a1/runs/r1/cancel'), 1,
      'the run question must cancel exactly the run it named, in the workspace it named');
  } finally { restore(); }
});

test('保存成功后旧问句关闭，不会在已保存的编辑器里重问', async () => {
  const {elements, calls, restore} = await mountEditor();
  const savedFormData = globalThis.FormData;
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    elements.get('remove-automation').handlers.click[0]();
    await flush();
    assert.ok(alertdialogIn(form), 'the delete question must be open before the save happens');

    const values = {
      title: '新的标题', template_id: 'custom', intent: '', scope: 'once',
      participants: 'alice', agents: '', kind: 'now', time_zone: 'Asia/Shanghai', prompt: '',
    };
    globalThis.FormData = class {
      constructor() { return {get(name) { return values[name] || ''; }, has() { return false; }}; }
    };
    form.handlers.submit[0]({preventDefault() {}});
    await flush();

    assert.equal(postCount(calls, '/automations/a1/remove'), 0,
      'saving must not carry out a delete question that was left open');
    assert.equal(alertdialogIn(form), undefined,
      'a successful save must close the delete question instead of re-showing it in the saved editor');
  } finally {
    if (savedFormData === undefined) delete globalThis.FormData; else globalThis.FormData = savedFormData;
    restore();
  }
});

import { templateFromSearch } from '../flybot_workspace/static/automations/app.mjs';

test('?template= accepts only a plain template id', () => {
  assert.equal(templateFromSearch('?template=daily_brief'), 'daily_brief');
  assert.equal(templateFromSearch('?template=../x'), '');
  assert.equal(templateFromSearch(''), '');
});

test('runFilterFromSearch and runFilterSearchText round-trip the runs query', () => {
  assert.equal(runFilterFromSearch(''), 'all');
  assert.equal(runFilterFromSearch('?runs=failed'), 'failed');
  assert.equal(runFilterFromSearch('?runs=succeeded'), 'succeeded');
  assert.equal(runFilterFromSearch('?runs=active'), 'active');
  assert.equal(runFilterFromSearch('?runs=cancelled'), 'cancelled');
  assert.equal(runFilterFromSearch('?runs=all'), 'all');
  assert.equal(runFilterFromSearch('?runs=1'), 'all');
  assert.equal(runFilterFromSearch('?runs=FAILED'), 'all');
  assert.equal(runFilterFromSearch('?template=daily_brief&runs=failed'), 'failed');
  assert.equal(runFilterSearchText('all'), '');
  assert.equal(runFilterSearchText('failed'), '?runs=failed');
  assert.equal(runFilterSearchText('succeeded'), '?runs=succeeded');
  assert.equal(runFilterSearchText('active'), '?runs=active');
  assert.equal(runFilterSearchText('cancelled'), '?runs=cancelled');
});

test('matchesRunFilter keeps only the requested stored statuses', () => {
  assert.equal(matchesRunFilter({status: 'failed'}, 'all'), true);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'all'), true);
  assert.equal(matchesRunFilter({status: 'failed'}, 'failed'), true);
  assert.equal(matchesRunFilter({status: 'queued'}, 'failed'), false);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'failed'), false);
  assert.equal(matchesRunFilter({status: 'cancelled'}, 'failed'), false);
  assert.equal(matchesRunFilter({status: 'cancelled'}, 'cancelled'), true);
  assert.equal(matchesRunFilter({status: 'timeout'}, 'failed'), true);
  assert.equal(matchesRunFilter({status: 'timeout'}, 'cancelled'), false);
  assert.equal(matchesRunFilter({status: 'queued'}, 'active'), true);
  assert.equal(matchesRunFilter({status: 'running'}, 'active'), true);
  assert.equal(matchesRunFilter({status: 'cancelled'}, 'active'), false);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'succeeded'), true);
  assert.equal(matchesRunFilter({status: 'failed'}, 'succeeded'), false);
  assert.equal(matchesRunFilter({}, 'succeeded'), false);
});

const RUNS = [
  {id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085700, started: 1795085700, finished: 1795085760},
  {id: 'r2', status: 'failed', error_code: 'runtime_failure', due_at: 1795085800, started: 1795085800, finished: 1795085860},
  {id: 'r3', status: 'failed', error_code: 'timeout', due_at: 1795085900, started: 1795085900, finished: 1795085960},
];

test('点「失败」只请求失败运行，并把 ?runs=failed 写进地址栏', async () => {
  const pushes = [];
  const {elements, calls, restore} = await mountEditor({runs: RUNS, pushes});
  try {
    await openFirst(elements);
    calls.length = 0;
    await elements.get('run-filter-failed').handlers.click[0]();
    await flush();
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20&status=failed'),
      `the failed filter must ask the server for failed runs: ${calls.join(' | ')}`);
    assert.deepEqual(pushes, ['/automations?runs=failed'], 'choosing a run filter must leave a shareable URL');
    assert.equal(elements.get('run-filter-failed').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-filter-succeeded').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-list').children.length, 2, 'only the two failed runs stay listed');
    assert.equal(elements.get('run-filter-empty').hidden, true);
  } finally {
    restore();
  }
});

test('带 ?runs=failed 直接打开时首屏就请求失败列表，按钮也已经选中', async () => {
  const handlers = {};
  const {elements, calls, restore} = await mountEditor({runs: RUNS, search: '?runs=failed', windowHandlers: handlers});
  try {
    await openFirst(elements);
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20&status=failed'),
      `a shared URL must be honoured on the first run request: ${calls.join(' | ')}`);
    assert.equal(elements.get('run-filter-failed').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-list').children.length, 2);
  } finally {
    restore();
  }
});

test('筛选没有匹配项时给一句空态，而不是空白列表', async () => {
  const only = [{id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085700}];
  const {elements, restore} = await mountEditor({runs: only, search: '?runs=failed'});
  try {
    await openFirst(elements);
    assert.equal(elements.get('run-list').children.length, 0);
    assert.equal(elements.get('run-filter-empty').hidden, false,
      'a filter with no match must say so instead of leaving the list blank');
    assert.equal(elements.get('run-empty').hidden, true,
      'the old empty note belongs to the unfiltered list only');
  } finally {
    restore();
  }
});

test('浏览器后退回到「全部」时按地址栏重载，不再写一次历史', async () => {
  const pushes = [];
  const handlers = {};
  const {elements, calls, view, restore} = await mountEditor({runs: RUNS, pushes, windowHandlers: handlers});
  try {
    await openFirst(elements);
    await elements.get('run-filter-succeeded').handlers.click[0]();
    await flush();
    assert.deepEqual(pushes, ['/automations?runs=succeeded']);
    assert.ok(handlers.popstate && handlers.popstate.length, 'the page must listen for back/forward');
    calls.length = 0;
    view.location.search = '';
    handlers.popstate[0]({});
    await flush();
    assert.deepEqual(pushes, ['/automations?runs=succeeded'], 'back/forward must not push another history entry');
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20'),
      `going back to 全部 must reload the unfiltered list: ${calls.join(' | ')}`);
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-list').children.length, 3);
  } finally {
    restore();
  }
});

// A failed or timed-out run used to be a dead end: the only control was 取消这次运行
// on a queued run, so the next attempt was whatever the schedule produced. These
// tests drive the real mount() and read the request the retry button sends.

const RETRY_RUNS = [
  {id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085600, started: 1795085600, finished: 1795085660},
  {id: 'r2', status: 'failed', error_code: 'runtime_failure', due_at: 1795085700, started: 1795085700, finished: 1795085760},
  {id: 'r3', status: 'timeout', error_code: 'timeout', due_at: 1795085800, started: 1795085800, finished: 1795085860},
  {id: 'r4', status: 'queued', error_code: null, due_at: 1795085900, started: 1795085900, finished: null},
];

function runRowButtons(elements, label) {
  const list = elements.get('run-list');
  const found = [];
  for (const row of list.children) {
    const nodes = row.children.flatMap(node => [node, ...(node.children || [])]);
    for (const node of nodes) {
      if (node.tagName === 'BUTTON' && String(node.textContent).trim() === label) found.push(node);
    }
  }
  return found;
}

async function mountRuns({runs = RETRY_RUNS.filter(item => item.status !== 'queued'), retry = 'ok', dispatch, schedulePoll} = {}) {
  const restorePolling = holdRunPolling(schedulePoll);
  const {doc, elements} = fakeDocument();
  doc.defaultView = {location: {search: ''}, history: {pushState(state, title, url) {
    doc.defaultView.location.search = new URL(url, 'https://test.local').search;
  }}};
  const calls = [];
  const posts = [];
  let listed = runs.slice();
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') {
      return {status: 200, json: async () => ({items: [AUTOMATION]})};
    }
    if (method === 'GET' && /^\/v1\/workspaces\/ws1\/automations\/a1\/runs\?/.test(path)) {
      const filter = new URL(path, 'https://test.local').searchParams.get('status') || 'all';
      return respond({items: listed.filter(item => matchesRunFilter(item, filter)),
        has_pending: listed.some(item => ['queued', 'running'].includes(item.status))});
    }
    const exact = method === 'GET' && path.match(/^\/v1\/workspaces\/ws1\/automations\/a1\/runs\/([^/]+)$/);
    if (exact) return respond({run: listed.find(item => item.id === exact[1])});
    if (method === 'POST' && /^\/v1\/workspaces\/ws1\/automations\/a1\/(run|runs\/[^/]+\/retry)$/.test(path)) {
      posts.push({path, headers: options.headers || {}, body: options.body});
      if (dispatch) return dispatch({posts, list: rows => { listed = [...rows, ...runs]; }});
      if (retry === 'ok') {
        const fresh = {id: 'r9', status: 'queued', error_code: 'no_agent', due_at: 1795086000, started: 1795086000, finished: null};
        listed = [fresh, ...listed];
        return {status: 201, json: async () => ({run: fresh})};
      }
      return {status: retry, json: async () => ({error: {code: 'conflict', message: 'Only a failed run can be retried'}})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  await mount(doc, {fetcher});
  await openFirst(elements);
  return {
    elements, calls, posts,
    list(rows) { listed = [...rows, ...runs]; },
    restore() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
      restorePolling();
    },
  };
}

test('only failed, timed-out and cancelled runs offer 重新运行', async () => {
  const {elements, restore} = await mountRuns({
    runs: [...RETRY_RUNS, {id: 'r5', status: 'cancelled', error_code: 'cancelled', due_at: 1, started: 1, finished: 2}],
  });
  try {
    const retry = runRowButtons(elements, '重新运行');
    assert.equal(retry.length, 3, 'the failed, timed-out and cancelled rows each offer one retry');
    const succeeded = elements.get('run-list').children[0];
    assert.ok(!succeeded.children.flatMap(node => [node, ...(node.children || [])])
      .some(node => String(node.textContent).trim() === '重新运行'), 'a finished success has nothing to re-run');
    const queued = elements.get('run-list').children[3];
    assert.ok(!queued.children.flatMap(node => [node, ...(node.children || [])])
      .some(node => String(node.textContent).trim() === '重新运行'), 'a queued run is not retryable, it is cancellable');
  } finally {
    restore();
  }
});

test('点「重新运行」带幂等键请求 /retry，成功后列表出现一条排队中的新运行', async () => {
  const {elements, posts, restore} = await mountRuns();
  try {
    const [button] = runRowButtons(elements, '重新运行');
    await button.handlers.click[0]();
    await flush();
    assert.equal(posts.length, 1, 'one click is one request');
    assert.equal(posts[0].path, '/v1/workspaces/ws1/automations/a1/runs/r2/retry');
    assert.match(posts[0].headers['Idempotency-Key'] || '', /^[A-Za-z0-9_-]{16,64}$/,
      'the request needs an idempotency key or a double click queues the automation twice');
    const rows = elements.get('run-list').children;
    assert.equal(rows.length, 4, 'the reloaded list now carries the new queued run');
    assert.match(rows[0].textContent, /等待已连接的代理|运行中/, 'the new run is queued, not a finished failure');
    assert.equal(elements.get('manual-run-status').textContent, '等待已连接的代理');
    assert.equal(elements.get('status').textContent, '');
  } finally {
    restore();
  }
});

test('a double click on retry sends one request', async () => {
  const {elements, posts, restore} = await mountRuns();
  try {
    const [button] = runRowButtons(elements, '重新运行');
    const handler = button.handlers.click[0];
    await Promise.all([handler(), handler()]);
    await flush();
    assert.equal(posts.length, 1);
  } finally {
    restore();
  }
});

for (const command of ['manual', 'retry']) {
  test(`an interrupted ${command} response can be checked with the same key while its run is active`, async () => {
    const running = {id: 'r9', status: 'running'};
    const {elements, calls, posts, restore} = await mountRuns({
      dispatch({posts, list}) {
        list([running]);
        if (posts.length === 1) throw new TypeError('response lost');
        return respond({run: running});
      },
    });
    try {
      const button = command === 'retry' ? runRowButtons(elements, '重新运行')[0] : elements.get('tick-automation');
      await button.handlers.click[0]();
      const runControl = elements.get('tick-automation');
      assert.equal(runControl.textContent, '确认并重试');
      assert.equal(runControl.disabled, false);
      assert.equal(elements.get('manual-run-status').dataset.state, 'uncertain');
      assert.equal(runRowButtons(elements, '取消这次运行').length, 0, 'running work can no longer be cancelled');
      await runControl.handlers.click[0]();
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[0], posts[1], 'the same route, body and idempotency key are replayed');
      assert.equal(runControl.disabled, true);
      assert.equal(elements.get('manual-run-status').textContent, '运行中');
      assert.equal(calls.filter(call => call.endsWith('/runs/r9')).length, 0, 'a visible run needs no extra request');
    } finally {
      restore();
    }
  });
}

test('a filtered watcher tracks the exact run and retains identical rows across a poll', async () => {
  const timers = new Map();
  let timer = 0;
  const queued = {id: 'r9', status: 'queued'};
  const {elements, calls, list, restore} = await mountRuns({
    dispatch({list}) { list([queued]); return respond({run: queued}, 202); },
    schedulePoll(callback) { timers.set(++timer, callback); return timer; },
  });
  try {
    await elements.get('tick-automation').handlers.click[0]();
    assert.equal(elements.get('manual-run-status').textContent, '已排队');
    list([{...queued, status: 'running'}]);
    await elements.get('run-filter-succeeded').handlers.click[0]();
    const row = elements.get('run-list').children[0];
    assert.equal(elements.get('manual-run-status').textContent, '运行中');
    assert.equal(calls.filter(call => call.endsWith('/runs/r9')).length, 1);
    list([{...queued, status: 'failed', error_code: 'interrupted'}]);
    timers.get(timer)();
    await flush();
    assert.equal(elements.get('manual-run-status').textContent, '运行中断');
    assert.equal(elements.get('manual-run-status').dataset.state, 'failed');
    assert.equal(elements.get('run-filter-succeeded').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-list').children[0], row, 'unchanged history rows survive polling');
    assert.equal(elements.get('view-watched-run').hidden, false);
    assert.equal(elements.get('tick-automation').disabled, false);
    assert.equal(calls.filter(call => call.endsWith('/runs/r9')).length, 2);
  } finally {
    restore();
  }
});

test('服务端说不能重跑时贴出原因，不假装成功', async () => {
  const {elements, restore} = await mountRuns({retry: 409});
  try {
    const [button] = runRowButtons(elements, '重新运行');
    await button.handlers.click[0]();
    await flush();
    const status = elements.get('status');
    assert.equal(status.dataset.kind, 'error');
    assert.match(status.textContent, /Only a failed run can be retried/);
  } finally {
    restore();
  }
});

// A run row expands in place: the summary, the status code and the failure
// reason come from fields the server already returns (automations.py run_view).
test('a failed run names a readable reason and keeps the raw code visible', () => {
  const failed = {id: 'r1', status: 'failed', error_code: 'provider_error', result: {}};
  assert.equal(runErrorReason(failed), '模型提供方这次没有返回结果。');
  assert.deepEqual(runDetailFields(failed).map(field => field.label), ['状态码', '失败原因']);
  assert.equal(runDetailFields(failed)[0].value, 'provider_error');
});

test('an explicit result.error wins over the mapped code', () => {
  const failed = {status: 'failed', error_code: 'provider_error', result: {error: '上游 502：bad gateway'}};
  assert.equal(runErrorReason(failed), '上游 502：bad gateway');
});

test('an unknown code falls back to the raw code, never to an empty box', () => {
  const failed = {status: 'failed', error_code: 'mystery', result: {}};
  assert.equal(runErrorReason(failed), '服务端只留下错误代码：mystery');
});

test('a run that left nothing says so instead of showing an empty box', () => {
  assert.equal(RUN_DETAIL_EMPTY, '这次运行没有留下输出');
  assert.deepEqual(runDetailFields({status: 'succeeded', result: {}}), []);
});

test('a succeeded run expands to its summary and the model that wrote it', () => {
  const succeeded = {status: 'succeeded', error_code: null, result: {text: '今天的简报', model: 'deepseek-v4'}};
  assert.deepEqual(runDetailFields(succeeded), [
    {label: '摘要', value: '今天的简报'},
    {label: '模型', value: 'deepseek-v4'},
  ]);
  assert.deepEqual(runDetailFields(succeeded, {includeResult:false}), [{label:'模型', value:'deepseek-v4'}]);
});

test('an automation result renders its saved Markdown into headings, tables and fenced code', () => {
  const {doc} = fakeDocument();
  const target = doc.createElement('div');
  const fence = String.fromCharCode(96).repeat(3);
  const source = ['# 本次结果', '', '| 事项 | 状态 |', '| --- | --- |', '| 核对 | 完成 |', '',
    fence+'text', '保持内容', fence].join('\n');
  renderRunMarkdown(doc, target, source);
  const [heading, table, code] = target.children;
  assert.equal(heading.tagName, 'H4');
  assert.equal(heading.children[0].textContent, '本次结果');
  assert.equal(table.children[0].tagName, 'TABLE');
  assert.equal(code.children[0].textContent, '保持内容');
  assert.equal(target.dataset.rendered, 'true');
});

test('recorded trigger and execution location distinguish manual, scheduled and retried runs', () => {
  assert.deepEqual(runDetailFields({trigger: 'manual', automation_revision: 2, dispatch: {backend: 'ds-bot'}}), [
    {label: '触发方式', value: '手动运行'}, {label: '设置版本', value: '第 2 版'},
    {label: '执行位置', value: '个人 DS-Bot'},
  ]);
  assert.deepEqual(runDetailFields({trigger: 'scheduled', dispatch: {backend: 'legacy'}}), [
    {label: '触发方式', value: '定时触发'}, {label: '执行位置', value: '旧版平台'},
  ]);
  assert.deepEqual(runDetailFields({trigger: 'retry'}), [{label: '触发方式', value: '重新运行'}]);
});

test('unsaved edits require confirmation before a saved-version run or leaving the editor', async () => {
  const {elements, posts, restore} = await mountRuns({
    runs: [],
    dispatch: async () => ({status:202, json:async () => ({run:{id:'r1',status:'queued'}})}),
  });
  try {
    const form = elements.get('editor-form');
    const confirmArea = elements.get('editor-head-confirm') || form;
    const run = elements.get('tick-automation');
    const back = elements.get('cancel-editor');
    form.elements.prompt.value = '仅存在于未保存草稿中的任务';

    await run.handlers.click[0]();
    let dialog = alertdialogIn(confirmArea);
    assert.match(labelledQuestion(dialog).textContent, /使用已保存的设置/);
    assert.equal(posts.length, 0);
    dialog.children.find(node => node.textContent === '取消').handlers.click[0]();
    assert.equal(posts.length, 0);
    assert.equal(alertdialogIn(confirmArea), undefined);

    await back.handlers.click[0]();
    dialog = alertdialogIn(confirmArea);
    assert.match(labelledQuestion(dialog).textContent, /放弃修改/);
    dialog.children.find(node => node.textContent === '取消').handlers.click[0]();
    assert.equal(form.hidden, false);
    assert.equal(form.elements.prompt.value, '仅存在于未保存草稿中的任务');

    await run.handlers.click[0]();
    alertdialogIn(confirmArea).children.find(node => node.textContent === '运行已保存版本').handlers.click[0]();
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body, '{}');
    assert.equal(form.elements.prompt.value, '仅存在于未保存草稿中的任务');
  } finally {
    restore();
  }
});

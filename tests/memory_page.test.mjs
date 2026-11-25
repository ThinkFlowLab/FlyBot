import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {memoryCitationFromSearch, mount} from '../flybot_workspace/static/memory/app.mjs';
import {actionSaveAttempt, encodeActionReview, decodeActionReview, decodeNewActionAttempt, decodeActionEdit,
  advanceActionEdit, reconcileActionEdit} from '../flybot_workspace/static/memory/action-review.mjs';
import test from 'node:test';
import {actionQuery, applyDirectoryCollapsed, bindGraphNodeGestures, csrfCookie, directoryGroups, dueAtFromDate, dueDateValue, exportDownloadName, fillGraphHoverCard, formatTopics, applyMarkdown, graphHoverAllowed, graphLayout, graphPreviewModel, hideGraphHoverCard, memoryDirectoryQuery, MEMORY_EMPTY_NO_MATCH, MEMORY_EMPTY_WORKSPACE, memoryPageFromSearch, memoryPageMeta, memoryPagePreview, memoryUpdatedLabel, parseTopics, queryForMemoryPage, showGraphHoverCard, topicTag} from '../flybot_workspace/static/memory/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('empty memory directory and no search match use different messages', () => {
  assert.equal(MEMORY_EMPTY_WORKSPACE, '这个工作区还没有记忆页。');
  assert.equal(MEMORY_EMPTY_NO_MATCH, '没有匹配的记忆页。试试其他关键词。');
});

test('directory and action queries encode filters and omit empty values', () => {
  assert.equal(memoryDirectoryQuery(), '?order=recent&limit=20');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(memoryDirectoryQuery({
    needle:'正文', topic:'研发 & 策划', updatedAfter:1795200000, cursor:'cursor?=opaque',
  }))), {
    order:'recent', limit:'20', q:'正文', topic:'研发 & 策划', updated_after:'1795200000', cursor:'cursor?=opaque',
  });
  assert.equal(actionQuery('', 'open'), '?status=open');
  assert.equal(actionQuery('跟进', 'done'), '?q=%E8%B7%9F%E8%BF%9B&status=done');
  assert.equal(actionQuery('', ''), '');
  const dueCursor = '0:1800000000:' + 'a'.repeat(32);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(actionQuery('', 'open', dueCursor, 20, 'due'))),
    {status:'open', after:dueCursor, limit:'20', order:'due'});
});

test('action edit drafts preserve concurrent changes and isolate overlapping fields for review', () => {
  const base = {title:'旧标题', notes:'原备注', status:'open', due:'', memory_page_id:''};
  const fields = {...base, title:'我的标题', notes:'我的备注'};
  const saved = {...base, notes:'另一设备的备注', status:'done'};
  assert.deepEqual(decodeActionEdit(JSON.stringify({base,fields})), {base,fields});
  assert.equal(decodeActionEdit(JSON.stringify({base,fields:{...fields, memory_page_id:'malformed'}})), null);
  assert.deepEqual(reconcileActionEdit(base,fields,saved), {
    fields:{...saved,title:'我的标题'}, conflicts:['notes'],
  });
  assert.deepEqual(reconcileActionEdit(base,fields,fields), {fields,conflicts:[]});
});

test('an in-flight action edit keeps a return to the old value as a new draft after its save commits', () => {
  const base = {title:'标题', notes:'原备注', status:'open', due:'', memory_page_id:''};
  const submitted = {...base, notes:'提交的备注'};
  const pending = {revision:1, submitted};
  const draft = {base, fields:base, pending};
  assert.deepEqual(decodeActionEdit(JSON.stringify(draft)), draft);
  assert.deepEqual(advanceActionEdit(draft, base, 1), draft);
  const saved = {...submitted, status:'done'};
  const confirmed = advanceActionEdit(draft, saved, 2);
  assert.deepEqual(confirmed, {base:submitted, fields:base});
  assert.deepEqual(reconcileActionEdit(confirmed.base, confirmed.fields, saved), {fields:{...base,status:'done'}, conflicts:[]});
  const concurrent = {...saved, notes:'另一设备修改'};
  const newer = advanceActionEdit(draft, concurrent, 3);
  assert.deepEqual(reconcileActionEdit(newer.base, newer.fields, concurrent).conflicts, ['notes']);
});

test('recovered action review retains the original request and only resends the previously selected actions', () => {
  const source = {id:'a'.repeat(32), title:'Older note', revision:3};
  const otherSource = {id:'b'.repeat(32), title:'Current note', revision:9};
  const selected = new Map([[source.id,source], [otherSource.id,otherSource]]);
  const items = [
    {title:' Rewritten next step ', memory_page_id:otherSource.id, selected:true},
    {title:'Skipped next step', memory_page_id:source.id, selected:false},
  ];
  const state = {selected, sources:[source,otherSource], items, open:true};
  const generation = {key:'c'.repeat(32), sources:[{id:source.id, revision:2},{id:otherSource.id, revision:9}]};
  assert.deepEqual(decodeActionReview(encodeActionReview({...state, generateAttempt:generation})).generateAttempt, generation);
  const saved = actionSaveAttempt(state, 'd'.repeat(32));
  const restored = decodeActionReview(encodeActionReview({...state, saveAttempt:saved}));
  assert.deepEqual(restored.selected, selected);
  assert.equal(restored.open, true);
  assert.equal(restored.saveAttempt.key, saved.key);
  assert.deepEqual(restored.saveAttempt.items, [{title:'Rewritten next step', memory_page_id:otherSource.id, source_revision:9}]);
  assert.equal(restored.saveAttempt.chosen[0], restored.items[0]);
  assert.equal(decodeActionReview(encodeActionReview({...state, sources:[source]})), null);
});

test('due date helpers convert UTC calendar days', () => {
  assert.equal(dueAtFromDate(''), null);
  assert.equal(dueAtFromDate('2027-01-15'), Date.UTC(2027, 0, 15) / 1000);
  assert.equal(dueDateValue(Date.UTC(2027, 0, 15) / 1000), '2027-01-15');
  assert.equal(dueDateValue(null), '');
  assert.equal(dueDateValue('bad'), '');
});

test('recovering an action create retains the exact request key and body', () => {
  const draft = {key:'a'.repeat(32), payload:{title:'Prepare launch', notes:'Reviewed notes', due_at:1799990000, memory_page_id:'b'.repeat(32)}};
  assert.deepEqual(decodeNewActionAttempt(JSON.stringify(draft)),draft);
  assert.equal(decodeNewActionAttempt(JSON.stringify({...draft,key:'uncorrelated'})),null);
  assert.equal(decodeNewActionAttempt(JSON.stringify({...draft,payload:{...draft.payload,memory_page_id:'a different scope'}})),null);
  assert.equal(decodeNewActionAttempt(JSON.stringify({...draft,payload:{...draft.payload,due_at:2 ** 31 + 1}})),null);
});

test('parseTopics splits unique names and formatTopics joins them', () => {
  assert.deepEqual(parseTopics('Getting Started, wiki，Getting started'), ['Getting Started', 'wiki']);
  assert.equal(formatTopics(['Getting Started', 'wiki']), 'Getting Started，wiki');
  assert.equal(formatTopics([]), '');
});

test('graphLayout places a single node at the center and sorts a circle by id', () => {
  assert.deepEqual(graphLayout([]), []);
  assert.deepEqual(graphLayout([{id: 'b'}], 200, 100), [{id: 'b', x: 100, y: 50}]);
  const placed = graphLayout([{id: 'm2'}, {id: 'm1'}], 200, 200, 50);
  assert.equal(placed[0].id, 'm1');
  assert.equal(placed[1].id, 'm2');
  assert.equal(placed[0].x, 100);
  assert.equal(placed[0].y, 50);
  assert.equal(placed[1].x, 100);
  assert.equal(placed[1].y, 150);
});

test('memoryPageFromSearch and queryForMemoryPage stay on the recorded allowlist', () => {
  assert.equal(memoryPageFromSearch(''), 'overview');
  assert.equal(memoryPageFromSearch('?page=profile'), 'profile');
  assert.equal(memoryPageFromSearch('?page=todos'), 'actions');
  assert.equal(memoryPageFromSearch('?page=unknown'), 'overview');
  assert.equal(queryForMemoryPage('overview'), '');
  assert.equal(queryForMemoryPage('profile'), '?page=profile');
  assert.equal(queryForMemoryPage('actions'), '?page=todos');
  assert.equal(memoryPageFromSearch('?page=meetings'), 'overview');
  assert.equal(queryForMemoryPage('meetings'), '');
});

test('memoryUpdatedLabel uses a UTC calendar date and ignores bad values', () => {
  assert.equal(memoryUpdatedLabel(''), '');
  assert.equal(memoryUpdatedLabel(null), '');
  assert.equal(memoryUpdatedLabel('bad'), '');
  assert.equal(memoryUpdatedLabel(Date.UTC(2026, 10, 17) / 1000), '2026-11-17');
});

test('topicTag and memoryPageMeta render date plus hash tags without inventing a 新 badge', () => {
  assert.equal(topicTag(''), '');
  assert.equal(topicTag('  wiki  '), '#wiki');
  assert.equal(topicTag('#already'), '#already');
  assert.equal(memoryPageMeta({}), '');
  assert.equal(
    memoryPageMeta({updated: Date.UTC(2026, 10, 17) / 1000, topics: ['CI fixture', '#keep']}),
    '2026-11-17 · #CI fixture · #keep',
  );
  assert.equal(memoryPagePreview({}), '');
  assert.equal(memoryPagePreview({preview: '  First line of the page.  '}), 'First line of the page.');
});

test('directoryGroups clusters real topics and leaves untagged pages loose', () => {
  const pages = [
    {id: 'a', title: 'Alpha notes', topics: ['Work notes']},
    {id: 'b', title: 'Beta plan', topics: ['Work notes', 'Planning']},
    {id: 'c', title: 'Loose page', topics: []},
    {id: 'd', title: 'Planner', topics: ['Planning']},
  ];
  const grouped = directoryGroups(pages, [
    {name: 'Work notes', pages: [{id: 'a'}, {id: 'b'}], page_count: 2},
    {name: 'Planning', pages: [{id: 'b'}, {id: 'd'}], page_count: 2},
    {name: 'Empty leftover', pages: [{id: 'missing'}], page_count: 1},
  ]);
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['c']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Work notes', 2, ['a', 'b']],
    ['Planning', 2, ['b', 'd']],
  ]);
  assert.equal(grouped.groups.some((group) => group.name === 'Getting Started' || group.name === 'Empty leftover'), false);
});

test('directoryGroups still groups from page topics when the catalog is empty', () => {
  const grouped = directoryGroups(
    [{id: 'n1', title: 'Solo', topics: ['Planning']}, {id: 'n2', title: 'Other'}],
    [],
  );
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['n2']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Planning', 1, ['n1']],
  ]);
});

test('applyDirectoryCollapsed hides the directory in session only', () => {
  const nodes = {};
  const el = (id, extra = {}) => {
    const node = {
      id,
      hidden: false,
      className: '',
      attributes: {},
      classList: {
        toggle(name, on) {
          const parts = new Set((node.className || '').split(/\s+/).filter(Boolean));
          if (on) parts.add(name);
          else parts.delete(name);
          node.className = [...parts].join(' ');
        },
      },
      setAttribute(key, value) {
        node.attributes[key] = value;
      },
      getAttribute(key) {
        return node.attributes[key];
      },
    };
    Object.assign(node, extra);
    nodes[id] = node;
    return node;
  };
  el('list-panel');
  el('memory-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['memory-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['memory-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

test('graphPreviewModel uses title, existing preview and topic tags', () => {
  assert.deepEqual(graphPreviewModel({}), {title: '', summary: '', tags: []});
  assert.deepEqual(
    graphPreviewModel({title: ' Welcome ', preview: '  First line.  ', topics: ['CI fixture', '#keep']}),
    {title: 'Welcome', summary: 'First line.', tags: ['#CI fixture', '#keep']},
  );
});

test('graphHoverAllowed hides the card on coarse pointers and 390-wide viewports', () => {
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 1440}), true);
  assert.equal(graphHoverAllowed({pointerCoarse: true, viewportWidth: 1440}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 390}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 389}), false);
});

function hoverCard() {
  const child = (className) => {
    const node = {className, textContent: '', hidden: false};
    return node;
  };
  const title = child('graph-hover-title');
  const summary = child('graph-hover-summary');
  const tags = child('graph-hover-tags');
  const map = {
    '.graph-hover-title': title,
    '.graph-hover-summary': summary,
    '.graph-hover-tags': tags,
  };
  return {
    hidden: true,
    style: {},
    attributes: {},
    title,
    summary,
    tags,
    querySelector(sel) { return map[sel] || null; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    removeAttribute(key) { delete this.attributes[key]; },
  };
}

function gestureTarget() {
  const listeners = {};
  return {
    attributes: {},
    listeners,
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      const payload = {key: event.key, preventDefault() {}, ...event};
      for (const fn of listeners[type] || []) fn(payload);
    },
  };
}

test('fillGraphHoverCard writes title, summary and tags and can hide empty rows', () => {
  const card = hoverCard();
  fillGraphHoverCard(card, {title: 'Alpha', summary: 'Hello', tags: ['#wiki']});
  assert.equal(card.title.textContent, 'Alpha');
  assert.equal(card.summary.textContent, 'Hello');
  assert.equal(card.summary.hidden, false);
  assert.equal(card.tags.textContent, '#wiki');
  fillGraphHoverCard(card, {title: 'Alpha', summary: '', tags: []});
  assert.equal(card.summary.hidden, true);
  assert.equal(card.tags.hidden, true);
});

test('bindGraphNodeGestures keeps click-to-open and adds dblclick and Enter', () => {
  const opened = [];
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p1', title: 'Alpha'}, {openPage: (id) => opened.push(id), hoverAllowed: false});
  assert.equal(target.getAttribute('tabindex'), '0');
  assert.equal(target.getAttribute('role'), 'button');
  assert.equal(target.getAttribute('aria-label'), 'Alpha');
  target.dispatch('click');
  target.dispatch('dblclick');
  target.dispatch('keydown', {key: 'Enter'});
  assert.deepEqual(opened, ['p1', 'p1', 'p1']);
});

test('bindGraphNodeGestures shows a hover card after the delay and hides it on leave or Escape', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p2', title: 'Beta', preview: 'Summary text', topics: ['wiki']}, {
    openPage() {},
    card,
    hoverAllowed: true,
    delayMs: 0,
    position: {left: 12, top: 24},
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  assert.equal(card.getAttribute('data-id'), 'p2');
  assert.equal(card.title.textContent, 'Beta');
  assert.equal(card.summary.textContent, 'Summary text');
  assert.equal(card.tags.textContent, '#wiki');
  assert.equal(card.style.left, '12px');
  assert.equal(card.style.top, '24px');
  target.dispatch('pointerleave');
  assert.equal(card.hidden, true);
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  target.dispatch('keydown', {key: 'Escape'});
  assert.equal(card.hidden, true);
});

test('bindGraphNodeGestures does not open a hover card when hover is not allowed', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p3', title: 'Gamma', preview: 'Nope'}, {
    openPage() {},
    card,
    hoverAllowed: false,
    delayMs: 0,
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, true);
  assert.equal(card.getAttribute('data-id'), undefined);
});

// The 「偏好」 block sits in the 我的资料 view and keeps its rows in local
// page state: adding and deleting must change the list without any request.

class PrefElement {
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
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelector(selector) {
    return this.children.find((child) => child.attributes.class === selector || child.className === selector) || null;
  }
  getBoundingClientRect() { return {left: 0, top: 0, width: 0, height: 0}; }
  focus() { this.focused = true; }
  click() { if (this.handlers.click) this.handlers.click({target: this, preventDefault() {}}); }
}

function prefDocument() {
  const elements = new Map();
  const body = new PrefElement('body');
  const doc = {
    cookie: '',
    body,
    defaultView: {location: {pathname: '/memory', search: '?page=profile'}, history: {replaceState() {}}},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'action-filter' || id === 'new-action-page' || id === 'link-target' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'search' || id === 'topic-search' ? 'input'
          : id === 'graph-canvas' || id === 'graph-hover-card' ? 'svg'
          : 'div';
        const el = new PrefElement(tag);
        if (id === 'editor-form') {
          el.hidden = true;
          el.elements = {title: new PrefElement('input'), body: new PrefElement('textarea'), topics: new PrefElement('input')};
        }
        if (id === 'action-editor-form') {
          el.hidden = true;
          el.elements = {
            title: new PrefElement('input'), notes: new PrefElement('textarea'),
            status: new PrefElement('select'), due: new PrefElement('input'),
            memory_page_id: new PrefElement('select'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new PrefElement(tag); },
    createElementNS(_ns, tag) { return new PrefElement(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const prefFlush = () => new Promise((resolve) => setImmediate(resolve));
const prefSettle = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await prefFlush();
};
const prefJson = (status, body) => ({status, json: async () => body});

function prefFetcher(calls, store = {items: []}) {
  return async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({path, method});
    if (path === '/v1/auth/session') return prefJson(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/settings') return prefJson(404, {});
    if (path === '/v1/workspaces') return prefJson(200, {items: [{id: 'ws-1', name: 'Desk', owner_id: 'user-1'}]});
    if (path === '/v1/workspaces/ws-1/memory?order=recent&limit=20') return prefJson(200, {items: [], total: 0});
    if (path === '/v1/workspaces/ws-1/memory/actions') return prefJson(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/preferences') {
      if (method === 'GET') return prefJson(200, {items: store.items});
      const text = JSON.parse(options.body).text;
      const known = store.items.find((item) => item.text === text);
      if (known) return prefJson(200, {preference: known});
      const preference = {id: 'pref-' + (store.items.length + 1), text, created: 1800000000};
      store.items.push(preference);
      return prefJson(201, {preference});
    }
    const removal = path.match(/^\/v1\/workspaces\/ws-1\/memory\/preferences\/([^/]+)\/remove$/);
    if (removal) {
      const index = store.items.findIndex((item) => item.id === removal[1]);
      if (index < 0) return prefJson(404, {error: {code: 'not_found'}});
      const [removed] = store.items.splice(index, 1);
      return prefJson(200, {removed});
    }
    if (path === '/v1/workspaces/ws-1/memory/graph') {
      return prefJson(200, {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
    }
    if (path === '/v1/workspaces/ws-1/memory/profile') {
      return prefJson(200, {profile: {revision: 0, professional: '', work_style: '', communication: ''}});
    }
    throw new Error('unexpected ' + path);
  };
}

async function mountPreferences() {
  const {doc, el} = prefDocument();
  const calls = [];
  const store = {items: []};
  await mount(doc, {fetcher: prefFetcher(calls, store)});
  await prefSettle();
  return {doc, el, calls, store};
}

test('the 偏好 block starts empty and says how to fill it', async () => {
  const {el, calls} = await mountPreferences();
  assert.equal(el('profile-panel').hidden, false);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preferences-empty').textContent, '还没有偏好，加一条试试');
  assert.equal(el('preference-list').children.length, 0);
  // The list is read from the workspace store, not from page state.
  assert.ok(calls.some((call) => call.method === 'GET' && call.path === '/v1/workspaces/ws-1/memory/preferences'));
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('adding a preference appends one row, clears the field and hides the empty state', async () => {
  const {el, calls} = await mountPreferences();
  el('preference-input').value = '回复用中文';
  el('add-preference').click();
  await prefSettle();
  assert.equal(el('preference-list').children.length, 1);
  const row = el('preference-list').children[0];
  assert.equal(row.children[0].textContent, '回复用中文');
  assert.equal(row.children[1].textContent, '删除');
  assert.equal(el('preferences-empty').hidden, true);
  assert.equal(el('preference-input').value, '');
  assert.equal(el('preference-status').textContent, '已添加偏好。');
  assert.ok(calls.some((call) => call.method === 'POST' &&
    call.path === '/v1/workspaces/ws-1/memory/preferences'));
});

test('an empty preference is not added and the status line says why', async () => {
  const {el} = await mountPreferences();
  el('preference-input').value = '   ';
  el('add-preference').click();
  await prefSettle();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '请先写一条偏好。');
});

test('deleting removes only that preference and brings the empty state back', async () => {
  const {el, calls} = await mountPreferences();
  for (const text of ['回复用中文', '会议纪要控制在 200 字']) {
    el('preference-input').value = text;
    el('add-preference').click();
    await prefSettle();
  }
  assert.equal(el('preference-list').children.length, 2);
  el('preference-list').children[0].children[1].click();
  await prefSettle();
  assert.equal(el('preference-list').children.length, 1);
  assert.equal(el('preference-list').children[0].children[0].textContent, '会议纪要控制在 200 字');
  assert.equal(el('preferences-empty').hidden, true);
  el('preference-list').children[0].children[1].click();
  await prefSettle();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '已删除偏好。');
  assert.equal(calls.filter((call) => call.method === 'POST' &&
    call.path.endsWith('/remove')).length, 2);
});

test('applyMarkdown wraps or prefixes the selected textarea text', () => {
  const area = {value: 'hello world', selectionStart: 0, selectionEnd: 5, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(area, 'bold'), '**hello** world');
  const empty = {value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(empty, 'h1'), '# 标题');
  const link = {value: 'docs', selectionStart: 0, selectionEnd: 4, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(link, 'link'), '[docs](https://)');
});

test('applyMarkdown builds checklist rows and appends a table after selected text', () => {
  const area = {value:'前言\n核对草稿\n发布\n结语', selectionStart:3, selectionEnd:10, dispatchEvent() {}};
  assert.equal(applyMarkdown(area, 'tasks'), '前言\n\n- [ ] 核对草稿\n- [ ] 发布\n\n结语');
  const table = {value:'保留本段\n下文', selectionStart:0, selectionEnd:4, dispatchEvent() {}};
  assert.equal(applyMarkdown(table, 'table'), '保留本段\n\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n\n下文');
});

import { safeHref, markdownToBlocks, renderMarkdown, domToMarkdown } from '../flybot_workspace/static/memory/rich.mjs';

function richDocument() {
  class Node {
    constructor(type, name, value) { this.nodeType = type; this.tagName = name ? name.toUpperCase() : undefined; this.nodeName = this.tagName || '#text'; this.nodeValue = value ?? null; this.childNodes = []; this.attrs = {}; this.parentNode = null; }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
    append(...kids) { for (const kid of kids) this.appendChild(typeof kid === 'string' ? new Node(3, null, kid) : kid); }
    removeChild(child) { this.childNodes = this.childNodes.filter(item => item !== child); return child; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.hasAttribute(key) ? this.attrs[key] : null; }
    hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
    set textContent(value) { this.childNodes = []; if (value) this.appendChild(new Node(3, null, String(value))); }
  }
  return {createElement: (name) => new Node(1, name), createTextNode: (text) => new Node(3, null, text)};
}

test('rich memory editor round-trips stored markdown through the DOM', () => {
  const doc = richDocument();
  const source = '# 标题\n\n一段 **加粗** 与 _斜体_ 和 `代码`，见 [[项目简报]]。\n\n- 第一点\n- 第二点\n\n1. 步骤一\n2. 步骤二\n\n> 引用\n\n```\ncode\n```\n\n---\n\n[链接](https://example.com)';
  const root = doc.createElement('div');
  renderMarkdown(doc, root, source);
  const once = domToMarkdown(root);
  const again = doc.createElement('div');
  renderMarkdown(doc, again, once);
  assert.equal(domToMarkdown(again), once);
  for (const part of ['# 标题', '**加粗**', '`代码`', '[[项目简报]]', '- 第一点', '1. 步骤一', '> 引用', '```', '---', '[链接](https://example.com)']) {
    assert.ok(once.includes(part), part);
  }
});

test('Memory task checkboxes persist their checked state while read-only checkboxes are disabled', () => {
  const doc = richDocument();
  const root = doc.createElement('div');
  const body = '- [ ] 草稿\n- 备注';
  renderMarkdown(doc, root, body);
  assert.equal(root.firstChild.firstChild.firstChild.disabled, true);
  renderMarkdown(doc, root, body, {interactiveTasks:true});
  const checkbox = root.firstChild.firstChild.firstChild;
  assert.equal(checkbox.disabled, false);
  checkbox.checked = true;
  assert.equal(domToMarkdown(root), '- [x] 草稿\n- 备注');
});

test('malformed Markdown fence remains literal and does not block subsequent headings', () => {
  assert.deepEqual(markdownToBlocks('开头\n```invalid language !\n正文\n\n### 下一步'), [
    {type:'p', text:'开头'},
    {type:'p', text:'```invalid language !\n正文'},
    {type:'h3', text:'下一步'},
  ]);
});

test('rich memory editor drops unsafe links and keeps a list nested in a paragraph', () => {
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('/memory'), '/memory');
  assert.ok(markdownToBlocks('# a\n\nb').length >= 2);
  const doc = richDocument();
  const root = doc.createElement('div');
  const p = root.appendChild(doc.createElement('p'));
  const ul = p.appendChild(doc.createElement('ul'));
  ul.appendChild(doc.createElement('li')).appendChild(doc.createTextNode('First point'));
  ul.appendChild(doc.createElement('li')).appendChild(doc.createTextNode('Second point'));
  assert.equal(domToMarkdown(root).trim(), '- First point\n- Second point');
});

// --- Issue #241: deleting a memory page or a next action must ask first. ---
// These tests import only symbols that exist on main today, and they build the
// fake document from the served HTML, so a control missing from the page cannot
// be invented by the harness. On main the two delete buttons post immediately,
// so the assertions fail as user-visible behaviour instead of as a missing
// export.

const memoryHtml = readFileSync(new URL('../flybot_workspace/static/memory/index.html', import.meta.url), 'utf8');
const memoryTick = () => new Promise((resolve) => setImmediate(resolve));

class MemoryNode {
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
    this.checked = false;
    this.name = '';
    this.type = '';
    this.id = '';
    this.className = '';
    this.focused = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this._named = {};
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) { if (!names().includes(name)) element.className = [...names(), name].join(' '); },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
      toggle(name, force) {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get elements() { return this._named; }
  get parentElement() { return this.parent; }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
      if (this.tagName === 'SELECT' && !this.value && node.value) this.value = node.value;
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  focus() { this.focused = true; }
  click() { return this.dispatch('click'); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  dispatch(type, event = {}) {
    const handlers = this.handlers[type] || [];
    return Promise.all(handlers.map((handler) => handler({
      type, target: this, preventDefault() {}, stopPropagation() {}, ...event,
    })));
  }
}

function fakeMemoryDocument(html) {
  const byId = new Map();
  const forms = [];
  for (const match of html.matchAll(/<(\/?)([a-z0-9-]+)\b([^>]*)>/gi)) {
    const [, closing, rawTag, attrs] = match;
    const tag = rawTag.toUpperCase();
    if (closing) {
      if (tag === 'FORM' && forms.length) forms.pop();
      continue;
    }
    const id = /\bid="([^"]+)"/.exec(attrs);
    const name = /\bname="([^"]+)"/.exec(attrs);
    let node = null;
    if (id || name) {
      node = new MemoryNode(tag);
      if (id) { node.id = id[1]; byId.set(id[1], node); }
      if (name) {
        node.name = name[1];
        const type = /\btype="([^"]+)"/.exec(attrs);
        if (type) node.type = type[1];
        if (forms.length) forms[forms.length - 1]._named[name[1]] = node;
      }
      for (const attr of attrs.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        node.attributes[attr[1]] = attr[2];
      }
      node.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      node.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
    }
    if (tag === 'FORM') {
      const form = node || new MemoryNode('FORM');
      if (!form._named) form._named = {};
      if (id) { form.id = id[1]; byId.set(id[1], form); }
      forms.push(form);
    }
  }
  const body = new MemoryNode('BODY');
  const doc = {
    cookie: '',
    body,
    defaultView: undefined,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new MemoryNode(tag); },
    createElementNS(_namespace, tag) { return new MemoryNode(tag); },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function jsonResponse(status, body) { return {status, json: async () => body}; }

function memoryPage(id, title) {
  return {
    id, title, body: '', topics: [], revision: 1,
    created_by: 'alice', updated_by: 'alice', updated: 1763000000,
  };
}

const citedWorkspace = 'a'.repeat(32);
const citedPage = 'b'.repeat(32);
const originWorkspace = 'c'.repeat(32);
const originAgent = 'd'.repeat(32);
const originConversation = 'e'.repeat(32);
const originMessage = 'f'.repeat(32);
const citationFrom = [originWorkspace, originAgent, originConversation, originMessage].join('.');
const citationQuery = `?workspace=${citedWorkspace}&page=${citedPage}&revision=1&from=${citationFrom}`;
const citationReturn = `/chat#workspace=${originWorkspace}&agent=${originAgent}&conversation=${originConversation}&message=${originMessage}`;

test('a citation builds only a typed private Chat return in the originating workspace', () => {
  assert.equal(memoryCitationFromSearch(citationQuery).href, citationReturn);
  assert.equal(memoryCitationFromSearch(citationQuery.replace('.' + originMessage, '')).href,
    citationReturn.replace('&message=' + originMessage, ''));
  for (const query of [
    citationQuery + '&from=' + citationFrom, citationQuery.replace(citedWorkspace, 'invalid'),
    citationQuery.replace(citationFrom, '//other.example'), citationQuery + '.extra',
    citationQuery.replace('page=' + citedPage, 'page=candidates'),
  ]) assert.equal(memoryCitationFromSearch(query), null);
});

function citationFixture({versionStatus = 200, pageStatus = 200} = {}) {
  const {doc, el} = fakeMemoryDocument(memoryHtml);
  const calls = [];
  const path = `/v1/workspaces/${citedWorkspace}/memory/${citedPage}`;
  const page = {...memoryPage(citedPage, '当前标题'), workspace_id: citedWorkspace, revision: 2};
  const version = {title: '原始标题', revision: 1, body: '<img src=evil> 原始内容'};
  const location = {pathname: '/memory', search: citationQuery};
  doc.defaultView = {location, history: {replaceState(_state, _title, url) {location.search = new URL(url, 'https://fixture.invalid').search;}}};
  doc.createTextNode = text => {
    const node = new MemoryNode('#text');
    node.textContent = text;
    return node;
  };
  const fetcher = async (url, options = {}) => {
    calls.push([options.method, url, options.body]);
    if (url === '/v1/auth/session') return jsonResponse(200, {user: {id: originWorkspace, username: 'alice'}});
    if (url === '/v1/settings') return jsonResponse(200, {settings: {values: {}}});
    if (url.startsWith('/v1/workspaces') && !url.startsWith('/v1/workspaces/')) return jsonResponse(200, {items: [{id: citedWorkspace, name: '来源空间'}]});
    if (url === path + '/versions/1') return jsonResponse(versionStatus, versionStatus === 200 ? {version, current: 2} : {});
    if (url === path && options.method === 'POST') {
      return jsonResponse(200, {page: {...page, ...JSON.parse(options.body).changes, revision: 3}});
    }
    if (url === path) return jsonResponse(pageStatus, pageStatus === 200 ? {page} : {});
    if (url.endsWith('/graph')) return jsonResponse(200, {nodes: [], edges: [], topics: [], counts: {}});
    return jsonResponse(200, {items: [], total: 0});
  };
  return {doc, el, calls, fetcher, location, path};
}

test('the cited revision is read-only and editing fetches the latest page while preserving the exact chat return', async () => {
  const {doc, el, calls, fetcher, location, path} = citationFixture();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    mount(doc, {fetcher});
    for (let round = 0; round < 6; round += 1) await memoryTick();
    assert.equal(el('memory-citation-preview').hidden, false);
    assert.equal(el('editor-form').hidden, true);
    assert.equal(el('memory-citation-title').textContent, '原始标题');
    assert.equal(el('memory-citation-version').textContent, '引用版本 · 修订 1 · 当前修订 2');
    assert.equal(el('memory-citation-body').textContent, '<img src=evil> 原始内容');
    assert.equal(el('memory-citation-body').children[0].tagName, 'P');
    assert.equal(el('memory-citation-return').href, citationReturn);
    assert.equal(calls.some(([, url]) => url === path || url === path + '/versions'), false);

    await el('memory-citation-edit').click();
    assert.equal(el('memory-citation-preview').hidden, true);
    assert.equal(el('editor-form').hidden, false);
    assert.equal(el('editor-form').elements.title.value, '当前标题');
    assert.equal(el('editor-form').elements.title.focused, true);
    assert.equal(new URLSearchParams(location.search).has('revision'), false);
    el('editor-form').elements.title.value = '修改后的当前标题';
    await el('editor-form').dispatch('submit');
    const save = calls.find(([method, url]) => method === 'POST' && url === path);
    assert.equal(JSON.parse(save[2]).revision, 2);
    assert.equal(new URLSearchParams(location.search).get('from'), citationFrom);
    assert.equal(el('memory-citation-return').href, citationReturn);
    assert.match(el('memory-citation-status').textContent, /已保存为修订 3/);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('an unavailable cited version can lead to the current page, but a deleted page just preserves return', async () => {
  for (const pageStatus of [200, 404]) {
    const {doc, el, fetcher} = citationFixture({versionStatus: 404, pageStatus});
    const previous = globalThis.document;
    globalThis.document = doc;
    try {
      mount(doc, {fetcher});
      for (let round = 0; round < 6; round += 1) await memoryTick();
      assert.equal(el('memory-citation-return').href, citationReturn);
      assert.equal(el('memory-citation-body').textContent, '');
      assert.equal(el('editor-form').hidden, true);
      assert.equal(el('memory-citation-edit').hidden, pageStatus === 404);
      assert.match(el('memory-citation-status').textContent, pageStatus === 404 ? /已删除或无法访问/ : /引用版本已无法读取/);
    } finally {
      if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
    }
  }
});

const exportBody = '---\ntitle: "项目简报"\nrevision: 1\n---\n\n正文';

function memoryFetcher() {
  const requests = [];
  const pages = {m1: memoryPage('m1', '项目简报'), m2: memoryPage('m2', '运维手册')};
  const action = {
    id: 'a1', title: '跟进客户', notes: '', status: 'open', due_at: null,
    memory_page_id: null, revision: 1, created_by: 'alice', updated_by: 'alice',
  };
  const graph = {
    nodes: Object.values(pages).map((page) => ({id: page.id, title: page.title})),
    edges: [], topics: [], counts: {nodes: 2, edges: 0, topics: 0},
  };
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    requests.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return jsonResponse(200, {user: {username: 'alice'}});
    if (path === '/v1/settings') return jsonResponse(200, {settings: {values: {}}});
    if (path === '/v1/workspaces') {
      return jsonResponse(200, {items: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个'}]});
    }
    const listed = /^\/v1\/workspaces\/(ws[12])\/memory\?order=recent&limit=20$/.exec(path);
    if (listed) return jsonResponse(200, {items: Object.values(pages), total: Object.keys(pages).length});
    const actions = /^\/v1\/workspaces\/(ws[12])\/memory\/actions$/.exec(path.split('?')[0]);
    if (actions) return jsonResponse(200, {items: [action]});
    const graphPath = /^\/v1\/workspaces\/(ws[12])\/memory\/graph$/.exec(path);
    if (graphPath) return jsonResponse(200, graph);
    const oneAction = /^\/v1\/workspaces\/(ws[12])\/memory\/actions\/([^/]+)$/.exec(path);
    if (oneAction) return jsonResponse(200, {action});
    const exportPage = /^\/v1\/workspaces\/(ws[12])\/memory\/([^/]+)\/export$/.exec(path);
    if (exportPage) return {status: 200, json: async () => ({}), text: async () => exportBody};
    const removePage = /^\/v1\/workspaces\/(ws[12])\/memory\/([^/]+)\/remove$/.exec(path);
    if (removePage && method === 'POST') return jsonResponse(200, {});
    const removeAction = /^\/v1\/workspaces\/(ws[12])\/memory\/actions\/([^/]+)\/remove$/.exec(path);
    if (removeAction && method === 'POST') return jsonResponse(200, {});
    const onePage = /^\/v1\/workspaces\/(ws[12])\/memory\/([^/]+)$/.exec(path);
    if (onePage && pages[onePage[2]]) return jsonResponse(200, {page: pages[onePage[2]]});
    return jsonResponse(404, {error: {message: 'unexpected ' + path}});
  };
  return {fetcher, requests};
}

async function mountMemory() {
  const {doc, el} = fakeMemoryDocument(memoryHtml);
  const {fetcher, requests} = memoryFetcher();
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    mount(doc, {fetcher});
    for (let round = 0; round < 12; round += 1) await memoryTick();
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  const posted = () => requests.filter((line) => line.startsWith('POST'));
  const openPageRow = async (index) => {
    await el('memory-list').children[index].children[0].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
  };
  const openActionRow = async (index) => {
    await el('action-list').children[index].children[1].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
  };
  return {doc, el, requests, posted, openPageRow, openActionRow};
}

test('the memory markup ships two labelled alert dialogs for its two deletes', () => {
  for (const [dialogId, questionId] of [
    ['page-delete-confirm', 'page-delete-question'],
    ['action-delete-confirm', 'action-delete-question'],
  ]) {
    const present = (pattern, message) => assert.ok(pattern.test(memoryHtml), message);
    present(new RegExp(`id="${dialogId}"[^>]*role="alertdialog"`), `${dialogId} is an alert dialog`);
    present(new RegExp(`aria-labelledby="${questionId}"`), `${dialogId} is labelled by its question`);
    present(new RegExp(`id="${questionId}"`), `${questionId} exists`);
  }
  assert.match(memoryHtml, /<button type="button" id="delete-page">删除<\/button>/);
  assert.match(memoryHtml, /<button type="button" id="delete-action">删除<\/button>/);
});

test('deleting a memory page asks first, names the target and posts nothing yet', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  for (let round = 0; round < 4; round += 1) await memoryTick();
  assert.deepEqual(posted(), [], 'the delete button must ask before it sends the remove request');
  const dialog = el('page-delete-confirm');
  assert.ok(dialog, 'the page editor renders a confirmation dialog');
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(el('delete-page').hidden, true, 'the trigger is hidden while the question is open');
  assert.match(el('page-delete-question').textContent, /项目简报/);
  assert.equal(el('page-delete-confirm-cancel').focused, true, 'focus moves into the question');
});

test('cancelling or pressing Escape closes the question with zero requests and restores focus', async () => {
  const {doc, el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'opening the question must not post');
  await el('page-delete-confirm-cancel').dispatch('click');
  assert.equal(el('page-delete-confirm').hidden, true);
  assert.equal(el('delete-page').hidden, false);
  assert.equal(el('delete-page').focused, true, 'cancel returns focus to the trigger');

  await el('delete-page').dispatch('click');
  for (const handler of doc.handlers.keydown || []) {
    handler({key: 'Escape', preventDefault() {}, stopPropagation() {}});
  }
  assert.equal(el('page-delete-confirm').hidden, true);
  assert.equal(el('delete-page').focused, true, 'Escape returns focus to the trigger');
  assert.deepEqual(posted(), []);
});

test('confirming posts exactly once to the page captured when the question opened', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'no request before the user confirms');
  await el('page-delete-confirm-submit').dispatch('click');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.deepEqual(posted(), ['POST /v1/workspaces/ws1/memory/m1/remove']);
  assert.equal(el('status').textContent, '已删除。');
  assert.equal(el('page-delete-confirm').hidden, true);
});

test('a pending question is dropped when the workspace or the open entry changes', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'a pending question must not post before it is confirmed');
  assert.equal(el('page-delete-confirm').hidden, false);
  el('workspace').value = 'ws2';
  await el('workspace').dispatch('change');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.equal(el('page-delete-confirm').hidden, true, 'a workspace switch closes the stale question');
  assert.equal(el('delete-page').hidden, false);
  assert.deepEqual(posted(), []);

  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.equal(el('page-delete-confirm').hidden, false);
  await openPageRow(1);
  assert.equal(el('page-delete-confirm').hidden, true, 'opening another page closes the stale question');
  assert.equal(el('delete-page').hidden, false);
  assert.deepEqual(posted(), []);
});

test('deleting a next action asks first and only confirms the captured action', async () => {
  const {el, posted, openActionRow} = await mountMemory();
  await openActionRow(0);
  await el('delete-action').dispatch('click');
  for (let round = 0; round < 4; round += 1) await memoryTick();
  assert.deepEqual(posted(), [], 'the action delete button must ask before it sends the remove request');
  assert.equal(el('action-delete-confirm').hidden, false);
  assert.equal(el('delete-action').hidden, true);
  assert.match(el('action-delete-question').textContent, /跟进客户/);
  await el('action-delete-confirm-submit').dispatch('click');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.deepEqual(posted(), ['POST /v1/workspaces/ws1/memory/actions/a1/remove']);
  assert.equal(el('status').textContent, '已删除。');
  assert.equal(el('action-delete-confirm').hidden, true);
});

// --- The memory page exports the saved page as a Markdown file instead of
// only showing the text on screen. ---

test('exportDownloadName keeps a readable file name and never returns a path', () => {
  assert.equal(exportDownloadName('项目简报'), '项目简报.md');
  assert.equal(exportDownloadName('  a/b:c*?"<>|  '), 'a-b-c.md');
  assert.equal(exportDownloadName(''), '记忆页.md');
  assert.equal(exportDownloadName('x'.repeat(80)), `${'x'.repeat(60)}.md`);
});

test('the memory editor ships a disabled Markdown export control until a page is open', () => {
  assert.match(memoryHtml, /<button type="button" id="page-export" disabled title="打开一页记忆后才能导出为 Markdown。">导出<\/button>/);
  assert.match(memoryHtml, /<p id="page-export-status" class="note editor-export-status" hidden><\/p>/);
});

test('exporting downloads the saved page from its export route and names the file after the title', async () => {
  const savedUrl = globalThis.URL;
  const savedBlob = globalThis.Blob;
  const savedDocument = globalThis.document;
  const blobs = [];
  const revoked = [];
  const downloads = [];
  globalThis.URL = {
    createObjectURL(blob) { blobs.push(blob); return 'blob:export'; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  globalThis.Blob = class {
    constructor(parts, options) { this.parts = parts; this.type = options && options.type; }
  };
  const {doc, el} = fakeMemoryDocument(memoryHtml);
  const {fetcher, requests} = memoryFetcher();
  const append = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (node) => {
    if (node.tagName === 'A') downloads.push(node);
    return append(node);
  };
  globalThis.document = doc;
  try {
    mount(doc, {fetcher});
    for (let round = 0; round < 12; round += 1) await memoryTick();
    assert.equal(el('page-export').disabled, true, 'nothing to export before a page is open');
    await el('memory-list').children[0].children[0].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
    assert.equal(el('page-export').disabled, false, 'opening a page enables the export');

    await el('page-export').dispatch('click');
    for (let round = 0; round < 8; round += 1) await memoryTick();

    assert.deepEqual(
      requests.filter((line) => line.endsWith('/export')),
      ['GET /v1/workspaces/ws1/memory/m1/export'],
      'the export reads the saved page from its own route',
    );
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].type, 'text/markdown;charset=utf-8');
    assert.deepEqual(blobs[0].parts, ['---\ntitle: "项目简报"\nrevision: 1\n---\n\n正文']);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].href, 'blob:export');
    assert.equal(downloads[0].download, '项目简报.md');
    assert.deepEqual(revoked, ['blob:export']);
    assert.match(el('page-export-status').textContent, /已导出 项目简报\.md · 修订 1/);
    assert.equal(el('page-export').disabled, false, 'the control returns after the download');
  } finally {
    globalThis.URL = savedUrl;
    globalThis.Blob = savedBlob;
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  }
});

test('a failed export reports the server message and downloads nothing', async () => {
  const savedUrl = globalThis.URL;
  const savedDocument = globalThis.document;
  const downloads = [];
  globalThis.URL = {createObjectURL() { throw new Error('no download expected'); }, revokeObjectURL() {}};
  const {doc, el} = fakeMemoryDocument(memoryHtml);
  const {fetcher} = memoryFetcher();
  const failing = async (path, options) => (path.endsWith('/export')
    ? {status: 404, json: async () => ({error: {message: 'Memory page not found'}})}
    : fetcher(path, options));
  const append = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (node) => { downloads.push(node); return append(node); };
  globalThis.document = doc;
  try {
    mount(doc, {fetcher: failing});
    for (let round = 0; round < 12; round += 1) await memoryTick();
    await el('memory-list').children[0].children[0].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
    await el('page-export').dispatch('click');
    for (let round = 0; round < 8; round += 1) await memoryTick();
    assert.equal(el('status').textContent, 'Memory page not found');
    assert.equal(el('status').dataset.kind, 'error');
    assert.deepEqual(downloads, [], 'a refused export must not produce a file');
    assert.equal(el('page-export').disabled, false, 'the control is usable again after a failure');
  } finally {
    globalThis.URL = savedUrl;
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  }
});

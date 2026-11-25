// Ticking an action item on /meetings writes that meeting back at once,
// through the existing edit route, without pressing 保存.
import assert from 'node:assert/strict';
import test from 'node:test';
import {actionToggleBody} from '../flybot_workspace/static/meetings/app.mjs';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.type = '';
    this.className = '';
    this._text = '';
  }
  get textContent() { return this._text; }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get innerText() { return this._text; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  // A real <select> selects its first option once one exists.
  pickFirstOption() {
    if (this.tagName !== 'select' || this.value) return;
    const first = this.children.find((child) => child.tagName === 'option');
    if (first) this.value = first.value;
  }
  appendChild(child) { this.children.push(child); this.pickFirstOption(); return child; }
  append(...nodes) { for (const node of nodes) this.children.push(node); this.pickFirstOption(); }
  replaceChildren(...nodes) { this.children = nodes; this.pickFirstOption(); }
  focus() {}
  click() { for (const handler of this.handlers.click || []) handler(); }
  showModal() { this.open = true; }
  close() {
    this.open = false;
    for (const handler of this.handlers.close || []) handler();
  }
  reset() {}
  get options() { return this.children.filter((child) => child.tagName === 'option'); }
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: 'ot_dev_csrf=test',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' ? 'select' : id === 'meeting-form' ? 'form' : 'div';
        elements.set(id, new FakeElement(tag));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, elements};
}

const WORKSPACE = 'a'.repeat(32);
const MEETING_ID = 'b'.repeat(32);
const OTHER_MEETING_ID = 'c'.repeat(32);
const OWNER = 'd'.repeat(32);

function meeting(id = MEETING_ID, revision = 3, actions = [
  {text: 'A', done: false, owner: ''},
  {text: 'B', done: false, owner: ''},
]) {
  return {
    id, workspace_id: WORKSPACE, title: 'Weekly', started_at: 1800000000,
    attendees: ['alice'], revision, created_by: 'alice', updated_by: 'alice',
    summary: '', transcript: '', action_items: actions.map((item) => ({...item})),
    action_count: actions.length,
    done_count: actions.filter((item) => item.done).length,
  };
}

async function mountPage(tag, { revokeWith = 200, beforeWrite = () => {}, afterWrite = () => {}, native = false, mobile = false, readList, saveArtifact, intercept, historyEntry } = {}) {
  const {doc, elements} = fakeDocument();
  if (native) doc.querySelector = selector => selector.includes('flybot-workspace-served-by') ? {} : null;
  const state = {calls: [], body: meeting(), posted: [], revokeWith};
  const json = (status, payload) => ({status, json: async () => payload});
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    state.calls.push(`${method} ${path}`);
    const custom = intercept?.({method, path, options, state, json});
    if (custom) return custom;
    if (path === '/v1/auth/session') return json(200, {user: {username: 'alice', id:OWNER}});
    if (path === '/v1/workspaces?limit=100' || path === '/v1/workspaces?scope=personal') {
      return json(200, {items: [{id: WORKSPACE, name: 'Team'}]});
    }
    if (path.startsWith(`/v1/workspaces/${WORKSPACE}/meetings?`)) {
      if (readList) return readList(new URLSearchParams(path.split('?')[1]), options, json);
      return json(200, {items: [{
        id: MEETING_ID, title: state.body.title, started_at: state.body.started_at,
        attendees: state.body.attendees, done_count: state.body.done_count,
        action_count: state.body.action_count,
      }], cursor: null});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}/artifact` && method === 'POST' && saveArtifact) {
      return saveArtifact(JSON.parse(options.body), json);
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'GET') {
      return json(200, {meeting: state.body, viewer_username: 'alice'});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${OTHER_MEETING_ID}` && method === 'GET') {
      return json(200, {meeting: {...meeting(OTHER_MEETING_ID, 8), title: 'Other'}});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      state.posted.push(payload);
      await beforeWrite();
      if (revokeWith !== 200) return json(revokeWith, {error: {message: 'Meeting changed elsewhere; reload and retry'}});
      state.body = {
        ...state.body,
        revision: state.body.revision + 1,
        action_items: payload.changes.action_items.map((item) => ({...item})),
        done_count: payload.changes.action_items.filter((item) => item.done).length,
        action_count: payload.changes.action_items.length,
      };
      await afterWrite();
      return json(200, {meeting: state.body});
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = {document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData, matchMedia: globalThis.matchMedia};
  const oldHistory = globalThis.history, oldLocation = globalThis.location;
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  globalThis.matchMedia = () => ({matches: mobile});
  if (historyEntry) {
    const location = globalThis.location = new URL('https://local.test/meetings#workspace=' + WORKSPACE);
    globalThis.history = {state:historyEntry, replaceState(value, _title, url) {
      this.state = value;
      location.href = new URL(url, location).href;
    }};
  }
  const restore = () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    if (saved.matchMedia === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = saved.matchMedia;
    globalThis.FormData = saved.FormData;
    if (historyEntry) {
      if (oldHistory === undefined) delete globalThis.history; else globalThis.history = oldHistory;
      if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    }
  };
  await import('../flybot_workspace/static/meetings/app.mjs?toggle=' + tag);
  await settle();
  return {doc, elements, state, restore};
}

async function settle() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('meeting catalogue restores filtered pagination only for the matching account and workspace', async () => {
  for (const [owner, workspace, matches] of [[OWNER, WORKSPACE, true], [MEETING_ID, WORKSPACE, false], [OWNER, OTHER_MEETING_ID, false]]) {
    const {doc, state, restore} = await mountPage(`catalogue-${owner}-${workspace}`, {native:true, mobile:true,
      historyEntry:{meetingCatalogue:{owner, workspace, query:'shipping review', open:true, size:41}},
    });
    try {
      const fields = new URLSearchParams(state.calls.find(call => call.includes('/meetings?')).split('?')[1]);
      assert.equal(fields.get('q'), matches ? 'shipping review' : null);
      assert.equal(fields.get('open'), matches ? '1' : null);
      assert.equal(fields.get('limit'), matches ? '41' : '20');
      assert.equal(doc.getElementById('meeting-search').value, matches ? 'shipping review' : '');
      assert.equal(doc.getElementById('meeting-open-only').checked, matches);
      assert.equal(globalThis.location.href.includes('shipping'), false);
    } finally { restore(); }
  }
});

test('a transient meeting read can be retried in place but an access denial cannot', async () => {
  const detail = `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}`;
  for (const status of [503, 404]) {
    let attempts = 0;
    const {doc, state, restore} = await mountPage(`meeting-detail-retry-${status}`, {
      native: true,
      intercept: ({method, path, json}) => {
        if (method === 'GET' && path === detail && ++attempts === 1) return json(status, {});
      },
    });
    try {
      const feedback = doc.getElementById('status');
      const retry = feedback.children.find(child => child.id === 'meeting-open-retry');
      assert.equal(attempts, 1);
      assert.equal(Boolean(retry), status === 503);
      if (retry) {
        retry.click();
        await settle();
        assert.equal(attempts, 2);
        assert.equal(doc.getElementById('meeting-title').value, state.body.title);
        assert.equal(feedback.textContent, '');
        assert.deepEqual(feedback.children, []);
      }
      assert.deepEqual(state.posted, []);
    } finally { restore(); }
  }
});

function checkbox(doc, index) {
  const row = doc.getElementById('action-list').children[index];
  const label = row?.children.find(child => child.className === 'action-done');
  return label && label.children[0];
}

test('an inline completion carries every saved deadline and omits empty deadlines', () => {
  const payload = actionToggleBody([
    {text: 'A', done: false, owner: '', due_date: '2032-02-29'},
    {text: 'B', done: false, owner: '', due_date: ''},
  ], 0, true, 3);
  assert.deepEqual(payload.changes.action_items, [
    {text: 'A', done: true, owner: '', due_date: '2032-02-29'},
    {text: 'B', done: false, owner: ''},
  ]);
});

test('ticking an action item writes the meeting back without pressing 保存', async () => {
  const {doc, state, restore} = await mountPage('tick-' + Math.random());
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'one edit request goes out for one tick');
    const payload = state.posted[0];
    assert.equal(payload.revision, 3, 'the request carries the revision the page holds');
    assert.deepEqual(Object.keys(payload.changes), ['action_items'], 'only action_items is sent, so other fields are not clobbered');
    assert.deepEqual(payload.changes.action_items, [
      {text: 'A', done: true, owner: ''},
      {text: 'B', done: false, owner: ''},
    ], 'only the ticked item flips');
    assert.equal(doc.getElementById('meeting-action-status').textContent, '已标记完成。');
    assert.equal(doc.getElementById('meeting-action-progress').textContent, '1/2 已完成');
    const progress = doc.getElementById('meeting-list').children[0].children[0].children.find(
      child => child.className === 'meeting-action-progress');
    assert.match(progress.textContent, /1\/2 行动项/,
      'the list count follows the tick');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 4/);
  } finally {
    restore();
  }
});

test('a stale revision reverts the tick and says the meeting moved on', async () => {
  const {doc, state, restore} = await mountPage('conflict-' + Math.random(), {revokeWith: 409});
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'the page tried once');
    assert.equal(box.checked, false, 'the tick goes back to the server state');
    assert.equal(checkbox(doc, 0), box, 'the original checkbox remains mounted after rollback');
    assert.equal(doc.getElementById('meeting-action-status').textContent, '会议已在别处更新，请重新打开后再勾选。');
    assert.equal(doc.getElementById('meeting-action-status').dataset.kind, 'error');
  } finally {
    restore();
  }
});

test('a rejected tick reverts its current checkbox after adding another action', async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const {doc, state, restore} = await mountPage('action-remount', {revokeWith:409, beforeWrite:() => held});
  try {
    const box = checkbox(doc, 0);
    box.checked = true;
    const sent = box.handlers.change[0]();
    doc.getElementById('add-action').handlers.click[0]();
    const rendered = checkbox(doc, 0);
    assert.notEqual(rendered, box);
    assert.equal(rendered.getAttribute('aria-disabled'), 'true');
    finish();
    await sent;
    assert.equal(state.posted.length, 1);
    assert.equal(rendered.checked, false);
    assert.equal(rendered.getAttribute('aria-disabled'), undefined);
    assert.ok(checkbox(doc, 2), 'the new draft action remains');
  } finally {
    finish();
    restore();
  }
});

test('only an unchanged saved action is toggled remotely while edited actions stay in the draft', async () => {
  const {doc, state, restore} = await mountPage('draft-isolation');
  try {
    const row = doc.getElementById('action-list').children[1];
    const title = row.children[0];
    title.value = 'draft text';
    title.handlers.input[0]();
    const savedBox = checkbox(doc, 0);
    savedBox.checked = true;
    await savedBox.handlers.change[0]();
    assert.deepEqual(state.posted[0].changes.action_items, [
      {text: 'A', done: true, owner: ''}, {text: 'B', done: false, owner: ''},
    ]);
    const draftBox = checkbox(doc, 1);
    draftBox.checked = true;
    await draftBox.handlers.change[0]();
    assert.equal(state.posted.length, 1);
    assert.equal(state.body.action_items[1].done, false);
    assert.equal(title.value, 'draft text');
    assert.equal(draftBox.checked, true);
  } finally {
    restore();
  }
});

test('a committed action toggle is confirmed by reading the saved revision after response loss', async () => {
  const {doc, state, restore} = await mountPage('action-ack-lost', {
    native: true,
    afterWrite() { throw new TypeError('Connection closed'); },
  });
  try {
    const summary = doc.getElementById('meeting-summary');
    summary.value = 'Unsaved summary';
    const box = checkbox(doc, 0);
    box.checked = true;
    await box.handlers.change[0]();
    await settle();
    assert.equal(state.posted.length, 1);
    assert.equal(state.calls.filter(call => call === `GET /v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}`).length, 2);
    assert.equal(state.body.revision, 4);
    assert.equal(box.checked, true);
    assert.equal(summary.value, 'Unsaved summary');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 4/);
    assert.equal(doc.getElementById('meeting-action-status').textContent, '已标记完成。');
  } finally {
    restore();
  }
});

test('an earlier write cannot update the newly selected meeting', async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const {doc, state, restore} = await mountPage('scope-fence', {beforeWrite: () => held});
  try {
    const box = checkbox(doc, 0);
    box.checked = true;
    const sent = box.handlers.change[0]();
    assert.equal(doc.getElementById('save-meeting').disabled, true);
    assert.equal(box.disabled, false, 'the originating checkbox can retain keyboard focus');
    assert.equal(box.getAttribute('aria-disabled'), 'true');
    assert.equal(checkbox(doc, 1).disabled, true);
    let repeatsBlocked = false;
    box.handlers.click[0]({preventDefault() { repeatsBlocked = true; }});
    assert.equal(repeatsBlocked, true);
    await doc.getElementById('meeting-list').handlers.click[0]({
      target: {closest: () => ({dataset: {meeting: OTHER_MEETING_ID}})},
    });
    await doc.getElementById('discard-meeting-edits').handlers.click[0]();
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 8/);
    finish();
    await sent;
    assert.equal(state.body.revision, 4);
    assert.equal(doc.getElementById('meeting-title').value, 'Other');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 8/);
    assert.equal(doc.getElementById('save-meeting').disabled, false);
    assert.equal(doc.getElementById('meeting-action-status').textContent, '');
  } finally {
    finish();
    restore();
  }
});

test('a new meeting that was never saved only changes locally', async () => {
  const {doc, elements, state, restore} = await mountPage('new-' + Math.random());
  try {
    // No saved meeting selected: the form is empty and no id is held.
    elements.get('new-meeting').handlers.click[0]();
    await settle();
    elements.get('add-action').handlers.click[0]();
    await settle();
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the checkbox still works before the first save');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();
    assert.equal(state.posted.length, 0, 'nothing is written for a meeting that does not exist yet');
  } finally {
    restore();
  }
});

test('native search and paged retries replace only the current listing, preserving edits', async () => {
  let releaseOld;
  let oldSignal;
  let appendAttempts = 0;
  const old = new Promise(resolve => { releaseOld = resolve; });
  const {doc, restore} = await mountPage('meeting-list-pages', {
    native: true,
    async readList(query, options, json) {
      assert.equal(query.get('limit'), '20');
      assert.equal(query.get('order'), 'recent');
      if (query.get('q') === 'old') {
        oldSignal = options.signal;
        await old;
        return json(200, {items: [{...meeting(), title: 'Outdated'}], cursor: null});
      }
      if (query.get('q') === 'new') {
        assert.equal(query.get('open'), '1');
        if (query.get('cursor')) {
          assert.equal(query.get('cursor'), MEETING_ID);
          if (++appendAttempts === 1) return json(503, {});
          return json(200, {items: [{...meeting(), title: 'Duplicate'}, {...meeting(OTHER_MEETING_ID), title: 'Next'}], cursor: null});
        }
        return json(200, {items: [{...meeting(), title: 'Filtered'}], cursor: MEETING_ID});
      }
      return json(200, {items: [meeting()], cursor: null});
    },
  });
  const ele = id => doc.getElementById(id);
  const titles = () => ele('meeting-list').children.map(li => li.children[0].children[0].textContent);
  try {
    assert.deepEqual(titles(), ['Weekly']);
    ele('meeting-title').value = 'An unsaved editor title';
    ele('meeting-search').value = 'old';
    ele('meeting-list-filters').handlers.submit[0]({preventDefault() {}});
    ele('meeting-search').value = '  new ';
    ele('meeting-open-only').checked = true;
    ele('meeting-open-only').handlers.change[0]();
    assert.equal(oldSignal.aborted, true);
    releaseOld();
    await settle();
    assert.deepEqual(titles(), ['Filtered']);
    assert.equal(ele('meeting-title').value, 'An unsaved editor title');
    await ele('meeting-list-more').handlers.click[0]();
    assert.deepEqual(titles(), ['Filtered']);
    assert.equal(ele('meeting-list-retry').hidden, false);
    await ele('meeting-list-retry').handlers.click[0]();
    assert.deepEqual(titles(), ['Filtered', 'Next']);
    assert.equal(ele('meeting-list-retry').hidden, true);
    assert.equal(ele('meeting-list-more').hidden, true);
  } finally {
    releaseOld();
    restore();
  }
});

test('native follow-up opens only saved open items and artifact save uses the stored revision', async () => {
  const sent = [];
  const artifactId = 'd'.repeat(32);
  const {doc, state, restore} = await mountPage('meeting-saved-actions', {
    native: true,
    saveArtifact(body, json) {
      sent.push(body);
      return json(201, {artifact: {id: artifactId, workspace_id: WORKSPACE}});
    },
  });
  const ele = id => doc.getElementById(id);
  const link = index => ele('action-list').children[index].children.find(child => child.className === 'action-destinations')
    .children.find(child => child.className === 'action-followup');
  try {
    assert.equal(link(0).href, `/automations?workspace=${WORKSPACE}&meeting=${MEETING_ID}&action=0&revision=3`);
    assert.equal(link(0).target, '_blank');
    assert.equal(link(0).hidden, false);
    ele('meeting-transcript').value = 'Unsaved private transcript';
    const input = ele('action-list').children[0].children[0];
    input.value = 'Unsaved action';
    input.handlers.input[0]();
    assert.equal(link(0).getAttribute('aria-disabled'), 'true');
    assert.equal(link(1).getAttribute('aria-disabled'), undefined);
    await ele('save-meeting-artifact').handlers.click[0]();
    assert.deepEqual(sent, [{revision: 3}]);
    assert.equal(ele('meeting-artifact-link').href, `/space?workspace=${WORKSPACE}&artifact=${artifactId}`);
    assert.equal(ele('meeting-artifact-link').hidden, false);
    assert.equal(ele('meeting-transcript').value, 'Unsaved private transcript');
    const box = checkbox(doc, 1);
    box.checked = true;
    await box.handlers.change[0]();
    assert.equal(state.body.revision, 4);
    assert.equal(link(1).hidden, true);
    assert.equal(ele('meeting-artifact-link').hidden, true);
  } finally {
    restore();
  }
});

test('native pagination restarts from the first page when the workspace changes between pages', async () => {
  let firstReads = 0;
  const {doc, restore} = await mountPage('meeting-list-keyset', {
    native: true,
    readList(query, options, json) {
      if (query.get('cursor')) {
        return json(200, {items: [{...meeting(OTHER_MEETING_ID), title: 'Stale page'}], cursor: null, activity_version: 'changed'});
      }
      firstReads += 1;
      return firstReads === 1
        ? json(200, {items: [meeting()], cursor: MEETING_ID, activity_version: 'before'})
        : json(200, {items: [{...meeting(OTHER_MEETING_ID), title: 'Fresh page'}], cursor: null, activity_version: 'changed'});
    },
  });
  const ele = id => doc.getElementById(id);
  try {
    ele('meeting-title').value = 'Draft title';
    await ele('meeting-list-more').handlers.click[0]();
    assert.equal(firstReads, 2);
    assert.deepEqual(ele('meeting-list').children.map(li => li.children[0].children[0].textContent), ['Fresh page']);
    assert.equal(ele('meeting-list-status').textContent, '会议列表已更新。');
    assert.equal(ele('meeting-title').value, 'Draft title');
  } finally {
    restore();
  }
});

test('the mobile list return parks rather than replacing a meeting draft', async () => {
  const {doc, state, restore} = await mountPage('meeting-mobile-park', {mobile: true});
  const ele = id => doc.getElementById(id);
  try {
    ele('new-meeting').handlers.click[0]();
    ele('meeting-title').value = 'Unsent meeting';
    ele('meeting-back-to-list').handlers.click[0]();
    assert.equal(ele('meeting-layout').dataset.view, 'catalogue');
    assert.equal(ele('meeting-resume').hidden, false);
    ele('meeting-resume').click();
    assert.equal(ele('meeting-layout').dataset.view, 'editor');
    assert.equal(ele('meeting-title').value, 'Unsent meeting');
    assert.equal(state.posted.length, 0);
  } finally {
    restore();
  }
});

const meetingPath = `/v1/workspaces/${WORKSPACE}/meetings`;

test('a lost create acknowledgment replays the same data while keeping newer draft edits', async () => {
  const writes = [];
  const {doc, restore} = await mountPage('create-ack-lost', {
    intercept({method, path, options, state, json}) {
      if (method !== 'POST') return;
      const body = JSON.parse(options.body);
      writes.push({path, body, key: options.headers['Idempotency-Key']});
      if (path !== meetingPath) {
        assert.equal(body.revision, 1);
        state.body = {...state.body, ...body.changes, revision: 2};
        return json(200, {meeting: state.body});
      }
      if (writes.length === 1) {
        state.body = {...meeting(MEETING_ID, 1, []), ...body};
        return Promise.reject(new TypeError('connection lost'));
      }
      return json(200, {meeting: state.body});
    },
  });
  const ele = id => doc.getElementById(id);
  const submit = () => ele('meeting-form').handlers.submit[0]({preventDefault() {}});
  try {
    ele('new-meeting').click();
    ele('meeting-title').value = '会后记录';
    ele('meeting-transcript').value = '首份正文';
    await submit();
    assert.equal(ele('save-meeting').textContent, '确认并重试保存');
    assert.equal(ele('save-meeting-mobile').formNoValidate, true);
    ele('meeting-transcript').value = '更多正文';
    await submit();
    assert.match(writes[0].key, /^meeting-/);
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(ele('meeting-transcript').value, '更多正文');
    assert.match(ele('meeting-meta').textContent, /修订 1/);
    assert.match(ele('meeting-save-status').textContent, /未保存的修改/);
    await submit();
    assert.equal(writes[2].path, `${meetingPath}/${MEETING_ID}`);
    assert.equal(writes[2].body.changes.transcript, '更多正文');
    assert.match(ele('meeting-meta').textContent, /修订 2/);
    assert.equal(ele('save-meeting').textContent, '保存');
    assert.equal(ele('meeting-save-status').textContent, '会议已保存。');
  } finally {
    await settle();
    restore();
  }
});

test('a definitive title collision clears the attempt and leaves the create draft editable', async () => {
  const keys = [];
  const {doc, restore} = await mountPage('create-duplicate', {
    intercept({method, path, options, json}) {
      if (path !== meetingPath || method !== 'POST') return;
      keys.push(options.headers['Idempotency-Key']);
      if (keys.length === 1) return json(503, {});
      if (keys.length === 2) return json(409, {error: {message: 'A meeting with this title already exists'}});
      return json(201, {meeting: {...meeting(MEETING_ID, 1, []), ...JSON.parse(options.body)}});
    },
  });
  const ele = id => doc.getElementById(id);
  const submit = () => ele('meeting-form').handlers.submit[0]({preventDefault() {}});
  try {
    ele('new-meeting').click();
    ele('meeting-title').value = '已有标题';
    ele('meeting-transcript').value = '正文保留';
    await submit();
    await submit();
    assert.equal(keys[0], keys[1]);
    assert.match(ele('meeting-save-status').textContent, /同名会议/);
    assert.equal(ele('meeting-transcript').value, '正文保留');
    assert.equal(ele('save-meeting').formNoValidate, false);
    ele('meeting-title').value = '更换标题';
    await submit();
    assert.notEqual(keys[2], keys[1]);
    assert.equal(ele('meeting-save-status').textContent, '会议已保存。');
  } finally {
    await settle();
    restore();
  }
});

test('a lost edit acknowledgment is verified by scoped read-back without replacing newer typing', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const path = `${meetingPath}/${MEETING_ID}`;
  const {doc, state, restore} = await mountPage('edit-ack-lost', {
    native: true,
    intercept({method, path: requested, options, state: fixture, json}) {
      if (requested !== path || method !== 'POST') return;
      const {revision, changes} = JSON.parse(options.body);
      assert.equal(revision, 3);
      fixture.body = {...fixture.body, ...changes, revision: 4,
        action_items: changes.action_items.map(item => ({...item, text: item.text.trim()}))};
      return held.then(() => json(503, {}));
    },
  });
  const ele = id => doc.getElementById(id);
  try {
    ele('meeting-transcript').value = '已提交正文';
    const row = ele('action-list').children[0];
    row.children[0].value = '  经后端规范的行动项  ';
    row.children[0].handlers.input[0]();
    const writing = ele('meeting-form').handlers.submit[0]({preventDefault() {}});
    ele('meeting-transcript').value = '仍在输入正文';
    release();
    await writing;
    assert.equal(state.calls.filter(call => call === `POST ${path}`).length, 1);
    assert.equal(state.calls.filter(call => call === `GET ${path}`).length, 2);
    assert.equal(ele('meeting-transcript').value, '仍在输入正文');
    assert.match(ele('meeting-meta').textContent, /修订 4/);
    assert.match(ele('meeting-save-status').textContent, /未保存的修改/);
  } finally {
    await settle();
    restore();
  }
});

test('an older confirmed create cannot enter a newly selected draft', async () => {
  let acknowledge;
  const pending = new Promise(resolve => { acknowledge = resolve; });
  const {doc, restore} = await mountPage('create-scope-fence', {
    intercept({method, path, options, json}) {
      if (path !== meetingPath || method !== 'POST') return;
      return pending.then(() => json(201, {meeting: {...meeting(MEETING_ID, 1, []), ...JSON.parse(options.body)}}));
    },
  });
  const ele = id => doc.getElementById(id);
  try {
    ele('new-meeting').click();
    ele('meeting-title').value = '先创建的会议';
    const writing = ele('meeting-form').handlers.submit[0]({preventDefault() {}});
    ele('new-meeting').click();
    ele('discard-meeting-edits').click();
    ele('meeting-title').value = '新选中的草稿';
    acknowledge();
    await writing;
    assert.equal(ele('meeting-title').value, '新选中的草稿');
    assert.equal(ele('meeting-meta').textContent, '新会议');
    assert.equal(ele('meeting-save-status').textContent, '');
    assert.equal(ele('save-meeting').disabled, false);
  } finally {
    restore();
  }
});

test('a failed navigation retains the unresolved create attempt in the visible draft', async () => {
  const writes = [];
  const {doc, restore} = await mountPage('failed-navigation-retains-attempt', {
    intercept({method, path, options, json}) {
      if (method === 'GET' && path === `${meetingPath}/${OTHER_MEETING_ID}`) return json(503, {});
      if (method !== 'POST' || path !== meetingPath) return;
      const body = JSON.parse(options.body);
      writes.push({body, key: options.headers['Idempotency-Key']});
      return writes.length === 1 ? json(503, {}) : json(200, {meeting: {...meeting(MEETING_ID, 1, []), ...body}});
    },
  });
  const ele = id => doc.getElementById(id);
  const submit = () => ele('meeting-form').handlers.submit[0]({preventDefault() {}});
  try {
    ele('new-meeting').click();
    ele('meeting-title').value = '原会议草稿';
    await submit();
    await ele('meeting-list').handlers.click[0]({
      target: {closest: () => ({dataset: {meeting: OTHER_MEETING_ID}})},
    });
    await ele('discard-meeting-edits').handlers.click[0]();
    assert.equal(ele('save-meeting').textContent, '确认并重试保存');
    ele('meeting-title').value = '仍在编辑的标题';
    await submit();
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(ele('meeting-title').value, '仍在编辑的标题');
    assert.match(ele('meeting-meta').textContent, /修订 1/);
  } finally {
    await settle();
    restore();
  }
});

test('a meeting switch reads nothing and keeps pending edits until discard is confirmed', async () => {
  const {doc, state, restore} = await mountPage('guard-editor-switch');
  const element = id => doc.getElementById(id);
  const openOther = () => element('meeting-list').handlers.click[0]({
    target: {closest: () => ({dataset: {meeting: OTHER_MEETING_ID}})},
  });
  try {
    element('meeting-transcript').value = 'Unsaved minutes';
    const reads = state.calls.length;
    await openOther();
    assert.equal(element('meeting-unsaved-dialog').open, true);
    assert.equal(state.calls.length, reads);
    element('keep-meeting-edits').click();
    assert.equal(element('meeting-unsaved-dialog').open, false);
    assert.equal(element('meeting-transcript').value, 'Unsaved minutes');
    assert.equal(state.calls.length, reads);
    await openOther();
    await element('discard-meeting-edits').handlers.click[0]();
    assert.equal(element('meeting-transcript').value, '');
    assert.equal(element('meeting-title').value, 'Other');
    assert.deepEqual(state.calls.slice(reads), [`GET ${meetingPath}/${OTHER_MEETING_ID}`]);
  } finally {
    restore();
  }
});

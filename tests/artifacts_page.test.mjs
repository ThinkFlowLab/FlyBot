import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {artifactNoticeTarget, mountArtifactNotifications} from '../flybot_workspace/static/artifacts/notifications.mjs';
import {mountSharedStudio} from '../flybot_workspace/static/artifacts/shared-studio.mjs';
import {studioDiscussionContext} from '../flybot_workspace/static/artifacts/studio-discussion.mjs';
import {sharedWorkCopyToken} from '../flybot_workspace/static/artifacts/shared-work-copy.mjs';
import {
  websiteTitle, websiteStub, websitePrompt, saveableSocialMessage, saveableAgentMessage,
  socialSavePath, agentSavePath, defaultSaveTitle, conversationChatHref,
  describeWebsiteDispatch, spaceHref, escapeHtml,
} from '../flybot_workspace/static/shell/thumb.mjs';
import {
  csrfCookie, listQuery, visibleArtifacts, artifactMatchesType,
  artifactMatchesModified, artifactModifiedBounds, viewFromSearch, queryForView, artifactOrigin, FILE_TYPE_LABELS,
  sessionFilterChoices, applyDirectoryCollapsed, artifactDeletePrompt, mount,
  createArtifactActivity,
  meetingRows, meetingActionLabel, meetingTimeLabel, meetingsForScope,
} from '../flybot_workspace/static/artifacts/app.mjs';

test('a shared copy deep link accepts only one exact private share token', () => {
  const token = 'Ab_Cd-'.repeat(7) + 'e';
  assert.equal(sharedWorkCopyToken('#shared-work=' + token),token);
  assert.equal(sharedWorkCopyToken('#shared-work=' + token + '&shared-work=' + token),'');
  assert.equal(sharedWorkCopyToken('#shared-work=' + token + '&workspace=' + 'a'.repeat(32)),'');
  assert.equal(sharedWorkCopyToken('#shared-work=%2F'),'');
  assert.equal(sharedWorkCopyToken('#shared-work=x'),'');
});

test('Studio discussion identifies the saved revision and bounds the excerpt on Unicode characters', () => {
  const source = {title:'行动方案', revision:7, body:'核对负责人'};
  assert.deepEqual(studioDiscussionContext(source), {
    text:'团队文档《行动方案》 · 版本 7\n\n核对负责人', clipped:false,
  });
  assert.deepEqual(studioDiscussionContext({...source, body:' \n  '}), {text:'',clipped:false});
  const excerpt = studioDiscussionContext({...source, body:'📋'.repeat(3000)});
  assert.equal(excerpt.clipped,true);
  assert.ok(excerpt.text.length <= 2900);
  assert.match(excerpt.text,/…$/u);
  assert.equal(excerpt.text,Buffer.from(excerpt.text).toString());
});

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
  assert.equal(listQuery('  plan & brief ', {kind: 'document', scope: 'favorites'}), '?q=plan%20%26%20brief&kind=document&scope=favorites');
  const query = new URLSearchParams(listQuery(' 蓝图 ', {
    kind: 'website', scope: 'favorites', types: ['网页', 'Markdown', '看板', '网页'],
    creators: ['A & B', '设计员'], sessions: ['otc.alpha', 'space_2'],
    updated: {since: 0, before: 86400},
  }));
  assert.deepEqual([...query], [
    ['q', '蓝图'], ['kind', 'website'], ['scope', 'favorites'], ['type', 'dashboard'], ['type', 'website'],
    ['creator', 'A & B'], ['creator', '设计员'], ['session', 'otc.alpha'], ['session', 'space_2'],
    ['updated_since', '0'], ['updated_before', '86400'],
  ]);
});

test('native Space shows safe excerpts and opens a body match in the document Find panel', async () => {
  const title = '蓝图🌱提纲';
  const text = '会议正文 <img src=x onerror=alert(1)> 蓝图🌱 交付计划';
  const filename = '附件蓝图🌱.png';
  const needle = '蓝图🌱';
  const hit = (kind, source) => {
    const start = source.indexOf(needle);
    return {kind, text: source, start, end: start + needle.length};
  };
  const item = (id, title, match) => ({id, title, match, kind: 'document'});
  const page = await openArtifactsPage({native: true, extraRequest(path) {
    if (path === '/v1/workspaces/w1/artifacts/body') {
      return reply({body:{artifact:{...item('body','周会备忘'),body:text,revision:1}}});
    }
    if (path === '/v1/workspaces/w1/artifacts?q=' + encodeURIComponent(needle) + '&order=recent') {
      return reply({body: {items: [
        item('title', title, hit('title', title)),
        item('body', '周会备忘', hit('body', text)),
        item('file', '附件', hit('filename', filename)),
        item('invalid', '偏移无效', {kind:'body',text:'含🌱',start:1,end:2}),
      ]}});
    }
  }});
  try {
    const search = page.elements.get('search');
    search.value = needle;
    await search.dispatch('keydown', {key: 'Enter'});
    const rows = artifactRows(page.elements.get('artifact-list'));
    assert.deepEqual(rows.map(row => row.dataset.artifactId), ['title','body','file','invalid']);
    const titleButton = rows[0].children[0];
    assert.equal(titleButton.textContent, title);
    assert.equal(titleButton.children.find(node => node.tagName === 'MARK').textContent, needle);
    const contexts = rows.slice(1).map(row => row.children.find(node => node.className === 'artifact-search-context'));
    assert.match(contexts[0].textContent, /^正文 · …/);
    assert.match(contexts[1].textContent, /^文件名 · 附件/);
    assert.deepEqual(contexts.slice(0, 2).map(context => context.children.find(node => node.tagName === 'MARK').textContent),
      [needle, needle]);
    assert.equal(contexts[2], undefined, 'an offset splitting a surrogate is discarded');
    assert.equal(page.created.some(node => node.tagName === 'IMG'), false, 'stored text never becomes HTML');
    await rows[1].children[0].dispatch('click');
    assert.equal(page.elements.get('document-find').hidden, false);
    assert.equal(page.elements.get('document-find-query').value, needle);
    assert.equal(page.form.elements.body.value, text);
  } finally { page.close(); }
});

test('Space debounces composition and ignores obsolete search responses', {timeout: 3000}, async () => {
  const earlier = deferred();
  const started = deferred();
  const latest = deferred();
  const page = await openArtifactsPage({native: true,
    items:[{id:'base',title:'起始作品',kind:'document'}],
    extraRequest(path) {
      if (path === '/v1/workspaces/w1/artifacts?q=old&order=recent') return earlier.promise;
      if (path === '/v1/workspaces/w1/artifacts?q=' + encodeURIComponent('最终正文') + '&order=recent') {
        started.finish();
        return latest.promise;
      }
    },
  });
  try {
    const search = page.elements.get('search');
    const listing = page.elements.get('artifact-list');
    search.value = 'old';
    const pending = search.dispatch('keydown', {key:'Enter'});
    search.value = '暂存字';
    await search.dispatch('input', {isComposing: true});
    assert.equal(page.calls.some(call => call.path.includes(encodeURIComponent('暂存字'))), false);
    search.value = '临时';
    await search.dispatch('compositionend');
    search.value = '最终正文';
    await search.dispatch('input');
    assert.equal(page.elements.get('artifact-list-note').textContent, '正在搜索作品…');
    assert.equal(page.elements.get('list-empty').hidden, true);
    earlier.finish(reply({body:{items:[{id:'old',title:'旧搜索',kind:'document'}]}}));
    await pending;
    assert.deepEqual(artifactRows(listing), []);
    await started.promise;
    latest.finish(reply({body:{items:[{id:'new',title:'只命中正文',kind:'document'}]}}));
    await new Promise(setImmediate);
    assert.deepEqual(artifactRows(listing).map(row => row.dataset.artifactId), ['new']);
    assert.equal(page.calls.filter(call => call.path.includes('?q=')).length, 2);
  } finally { page.close(); }
});

test('Space separates a failed search from an empty result and clears the query with Escape', async () => {
  const failed = deferred();
  let takes = 0;
  const page = await openArtifactsPage({native:true, items:[{id:'base',title:'原目录',kind:'document'}], extraRequest(path) {
    if (path === '/v1/workspaces/w1/artifacts?q=missing&order=recent') {
      takes += 1;
      return takes === 1 ? failed.promise : reply({body:{items:[]}});
    }
  }});
  try {
    const search = page.elements.get('search');
    const retry = page.elements.get('retry-artifact-list');
    const empty = page.elements.get('list-empty');
    search.value = 'missing';
    const pending = search.dispatch('keydown',{key:'Enter'});
    assert.equal(retry.hidden, true);
    assert.equal(empty.hidden, true);
    failed.finish(reply({status:503}));
    await pending;
    assert.equal(retry.hidden, false);
    assert.equal(empty.hidden, true);
    assert.equal(page.elements.get('artifact-list').getAttribute('aria-busy'), 'false');
    assert.match(page.elements.get('artifact-list-note').textContent, /搜索作品失败/);
    await retry.dispatch('click');
    assert.equal(retry.hidden, true);
    assert.equal(empty.hidden, false);
    assert.equal(page.elements.get('empty-no-match').hidden, false);
    await search.dispatch('keydown',{key:'Escape'});
    assert.equal(search.value, '');
    assert.equal(page.doc.activeElement, search);
    assert.equal(page.elements.get('clear-artifact-search').hidden, true);
    assert.deepEqual(artifactRows(page.elements.get('artifact-list')).map(row => row.dataset.artifactId), ['base']);
  } finally { page.close(); }
});

test('custom dates include both local dates and stop at the next local midnight', () => {
  const start = '2026-03-08';
  const end = start;
  const bounds = artifactModifiedBounds('custom', 0, {start, end});
  assert.deepEqual(bounds, {since: +new Date(2026, 2, 8) / 1000, before: +new Date(2026, 2, 9) / 1000});
  const matches = updated => artifactMatchesModified({updated}, 'custom', 0, {start, end});
  assert.deepEqual([bounds.since - 1, bounds.since, bounds.before - 1, bounds.before].map(matches),
    [false, true, true, false]);
  for (const range of [{start}, {start: '2026-02-30', end}, {start, end: '2026-03-07'}]) {
    assert.equal(artifactModifiedBounds('custom', 0, range), null);
  }
  assert.equal(artifactModifiedBounds('custom', 0, {start: '0099-01-01', end: '0099-01-01'})?.since < 0, true);
});

function activityFixture(options = {}) {
  const delays = new Map();
  const reports = [];
  const commits = [];
  let visible = true;
  const activity = createArtifactActivity({
    visible: () => visible,
    report: state => reports.push(state),
    read: async () => ({version: 'a'.repeat(64)}),
    apply: async (snapshot, context) => { commits.push({snapshot, ...context}); },
    ...options,
    setTimer(callback, delay) {
      const key = Symbol('activity timer');
      delays.set(key, {callback, delay});
      return key;
    },
    clearTimer: key => delays.delete(key),
  });
  return {activity, delays, reports, commits, setVisible: value => { visible = value; }};
}

test('Space activity seeds the list version and suppresses hidden-tab requests', async () => {
  const {activity, delays, commits, reports, setVisible} = activityFixture();
  activity.setScope('workspace-one');
  activity.seed('workspace-one', 'a'.repeat(64));
  assert.deepEqual([...delays.values()].map(timer => timer.delay), [8000]);
  await activity.check();
  assert.equal(commits[0].changed, false);
  setVisible(false);
  activity.resume();
  await activity.check();
  assert.equal(commits.length, 1);
  assert.equal(delays.size, 0);
  setVisible(true);
  await activity.check();
  assert.equal(commits.length, 2);
  assert.equal(reports.at(-1), 'ready');
  activity.setScope('');
  assert.equal(delays.size, 0);
});

test('Space activity fences late replies and retries deferred or temporarily invalid snapshots', async () => {
  const stale = Promise.withResolvers();
  const calls = [];
  const commits = [];
  const currentVersion = 'b'.repeat(64);
  let mode = 'defer';
  const {activity, delays, reports} = activityFixture({
    read(workspace, signal) {
      calls.push({workspace, signal});
      if (workspace === 'old') return stale.promise;
      return Promise.resolve({version: mode === 'broken' ? null : currentVersion});
    },
    async apply(snapshot, context) {
      commits.push({version: snapshot.version, workspace: context.workspace, changed: context.changed});
      return mode === 'defer' ? 'defer' : undefined;
    },
  });
  activity.setScope('old');
  const oldResult = activity.check();
  await activity.check();
  assert.equal(calls.length, 1, 'coalesce overlapping reads');
  activity.setScope('new');
  assert.equal(calls[0].signal.aborted, true);
  activity.seed('new', 'a'.repeat(64));
  await activity.check();
  stale.resolve({version: 'c'.repeat(64)});
  await oldResult;
  assert.deepEqual(commits.map(item => item.workspace), ['new']);
  mode = 'broken';
  await activity.check();
  assert.equal(reports.at(-1), 'error');
  assert.deepEqual([...delays.values()].map(timer => timer.delay), [16000]);
  mode = 'apply';
  await activity.check();
  await activity.check();
  assert.deepEqual(commits.map(item => item.changed), [true, true, false]);
  assert.equal(reports.at(-1), 'ready');
  activity.setScope('');
});

test('visibleArtifacts filters by kind, saved messages and creator', () => {
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice'},
    {title: 'Site', kind: 'website', created_by: 'bob'},
    {title: 'Clip', kind: 'document', created_by: 'alice', source: {kind: 'agent_message', id: 'm1'}},
  ];
  assert.deepEqual(visibleArtifacts(items, {kind: 'website'}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'messages'}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'meetings'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'mine', username: 'alice'}).map((item) => item.title), ['Doc', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'favorites'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), []);
});

test('visibleArtifacts maps recorded filters onto existing fields', () => {
  const now = Date.parse('2026-11-17T02:30:00Z');
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice', updated: now / 1000 - 60},
    {title: 'Site', kind: 'website', created_by: 'bob', updated: now / 1000 - 60},
    {title: 'Photo', kind: 'media', created_by: 'alice', updated: now / 1000 - 60, media: {mime: 'image/png'}},
    {title: 'Old', kind: 'document', created_by: 'alice', updated: now / 1000 - 40 * 24 * 60 * 60},
    {title: 'Task', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_task', conversation_id: 'c1'}},
    {title: 'Clip', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_message', conversation_id: 'c2'}},
  ];
  const html = readFileSync(new URL('../flybot_workspace/static/artifacts/index.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/name="file-type" value="([^"]+)"/g)].map(([, name]) => name), FILE_TYPE_LABELS);
  assert.equal(artifactMatchesType(items[0], '云文档'), true);
  assert.equal(artifactMatchesType(items[5], '云文档'), false);
  assert.equal(artifactMatchesType(items[2], '图片'), true);
  assert.equal(artifactMatchesType(items[2], '3D 模型'), false);
  assert.equal(artifactMatchesType({kind: 'media', media: {mime: 'model/gltf-binary'}}, '3D 模型'), true);
  assert.equal(artifactMatchesType(items[0], 'Markdown'), false);
  assert.equal(artifactMatchesType({kind: 'slides'}, '幻灯片'), true);
  assert.equal(artifactMatchesType({kind: 'dashboard'}, '看板'), true);
  assert.equal(artifactMatchesType({kind: 'document'}, '幻灯片'), false);
  assert.deepEqual(visibleArtifacts(items, {types: ['网页']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {types: ['消息']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {types: ['Markdown']}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {modified: 'today', now}).map((item) => item.title),
                   ['Doc', 'Site', 'Photo', 'Task', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {modified: 'custom', now}).map((item) => item.title),
                   items.map((item) => item.title));
  assert.deepEqual(visibleArtifacts(items, {creators: ['bob']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {sessions: ['c2']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), ['Task']);
  assert.equal(artifactMatchesModified(items[3], 'd30', now), false);
  assert.equal(artifactMatchesModified(items[3], 'd90', now), true);
});

test('sessionFilterChoices uses conversation titles instead of raw ids', () => {
  const choices = sessionFilterChoices([
    {title: 'Clip', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Again', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Other', source: {kind: 'agent_message', conversation_id: 'c1'}},
    {title: 'Plain', kind: 'document'},
  ]);
  assert.deepEqual(choices, [
    {id: 'c1', label: '对话'},
    {id: 'c2', label: '晨会'},
  ]);
  assert.equal(choices.some((row) => row.label === 'c1' || row.label === 'c2'), false);
});

test('viewFromSearch and queryForView stay on the recorded allowlist', () => {
  assert.deepEqual(viewFromSearch(''), {kind: 'all', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=created'), {kind: 'all', scope: 'mine'});
  assert.deepEqual(viewFromSearch('?view=starred'), {kind: 'all', scope: 'favorites'});
  assert.deepEqual(viewFromSearch('?view=memory'), {kind: 'all', scope: 'memory'});
  assert.deepEqual(viewFromSearch('?view=automation'), {kind: 'all', scope: 'automation'});
  assert.deepEqual(viewFromSearch('?view=meetings'), {kind: 'meetings', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=unknown'), {kind: 'all', scope: 'all'});
  assert.equal(queryForView('all', 'all'), '');
  assert.equal(queryForView('all', 'mine'), '?view=created');
  assert.equal(queryForView('all', 'favorites'), '?view=starred');
  assert.equal(queryForView('all', 'memory'), '?view=memory');
  assert.equal(queryForView('all', 'automation'), '?view=automation');
  assert.equal(queryForView('meetings', 'all'), '?view=meetings');
});

test('Space opens only the saved source coordinates from the selected workspace', () => {
  const workspace = 'a'.repeat(32);
  const automation = 'b'.repeat(32);
  const run = 'c'.repeat(32);
  const result = {workspace_id: workspace, source: {
    kind: 'automation_run', id: run, automation_id: automation, automation_title: '整理日报',
  }};
  assert.deepEqual(visibleArtifacts([result, {source:{kind:'agent_task'}}, {}], {scope:'automation'}), [result]);
  assert.deepEqual(artifactOrigin(result, workspace), {
    kind:'自动化运行', title:'整理日报', label:'查看原运行',
    href:`/automations?workspace=${workspace}&automation=${automation}&run=${run}`,
  });
  assert.equal(artifactOrigin(result, 'd'.repeat(32)).href, '');
  assert.equal(artifactOrigin({...result, source:{...result.source, id:'../../other'}}, workspace).href, '');
  const step = {workspace_id:workspace,source:{kind:'team_run_step',id:run,position:1,run_title:'整理日报'}};
  assert.deepEqual(artifactOrigin(step,workspace),{kind:'团队任务',title:'整理日报',label:'查看来源步骤',
    href:`/team-runs#workspace=${workspace}&run=${run}&step=1`});
  assert.equal(artifactOrigin(step,'d'.repeat(32)).href,'');
  assert.equal(artifactOrigin({...step,source:{...step.source,position:8}},workspace).href,'');
  assert.equal(artifactOrigin({...step,source:{...step.source,position:'1'}},workspace).href,'');
  const chat = {workspace_id:workspace, source:{
    kind:'agent_message', id:'message_01', conversation_id:'otc_example', conversation_title:'工作群',
  }};
  assert.equal(artifactOrigin(chat, workspace).href, `/chat#workspace=${workspace}&social=otc_example&message=message_01`);
  chat.source = {...chat.source, id:run, agent_id:automation, conversation_id:'d'.repeat(32)};
  assert.equal(artifactOrigin(chat, workspace).href,
    `/chat#workspace=${workspace}&agent=${automation}&conversation=${chat.source.conversation_id}&message=${run}`);
  assert.deepEqual(artifactOrigin({source:{kind:'agent_task', id:run}}, workspace), {kind:'智能体任务'});
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
  el('artifact-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['artifact-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['artifact-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.parentNode = null;
    this._text = '';
    this.classList = {
      add() {}, remove() {},
      toggle(name, on) { this._last = [name, on]; },
      contains() { return false; },
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this.children = []; this._text = String(value); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter(item => item !== handler);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? {textContent: node, parentNode: null} : node);
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(child) { return child === this || this.children.includes(child); }
  focus() { if (this.ownerDocument) this.ownerDocument._activeElement = this; }
  getContext() { return {fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {}}; }
  async dispatch(type, event = {}) {
    if (!event.preventDefault) event.preventDefault = () => {};
    for (const handler of this.handlers[type] || []) await handler(event);
  }
}

function fakeDocument() {
  const elements = new Map();
  const created = [];
  const doc = {
    cookie: '',
    _activeElement: null,
    get activeElement() { return this._activeElement; },
    getElementById(id) {
      if (!elements.has(id)) {
        const tags = {workspace: 'select', search: 'input', 'editor-form': 'form', 'artifact-list': 'ul'};
        const node = new FakeNode(tags[id] || 'div');
        node.ownerDocument = doc;
        elements.set(id, node);
      }
      return elements.get(id);
    },
    createElement(tag) {
      const node = new FakeNode(tag);
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    createTextNode(text) {
      const node = new FakeNode('#text');
      node.textContent = text;
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    querySelectorAll(selector) {
      if (doc.kindButtons && String(selector).includes('data-kind')) return doc.kindButtons;
      if (doc.scopeButtons && String(selector).includes('[data-scope]')) return doc.scopeButtons;
      return [];
    },
    querySelector() { return null; },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      doc.handlers[type] = (doc.handlers[type] || []).filter(item => item !== handler);
    },
    async dispatch(type, event = {}) {
      if (!event.preventDefault) event.preventDefault = () => {};
      for (const handler of doc.handlers[type] || []) await handler(event);
    },
    handlers: {},
  };
  const form = doc.getElementById('editor-form');
  form.elements = {title: new FakeNode('input'), body: new FakeNode('textarea')};
  return {doc, elements, created, form};
}

function reply({status = 200, body = {}} = {}) {
  return {status, json: async () => body};
}

test('Studio retries the exact document after a temporary read failure', async () => {
  const {doc} = fakeDocument();
  const get = id => doc.getElementById('studio-' + id);
  const dialog = get('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  doc.visibilityState = 'hidden';
  doc.defaultView = {location:{origin:'https://test.example'}, addEventListener() {}, clearTimeout() {},
    sessionStorage:{getItem:() => null, removeItem() {}}};
  const workspace = 'a'.repeat(32), id = 'b'.repeat(32);
  const paths = [];
  const opened = [];
  const studio = mountSharedStudio(doc, {
    onDocument: (_workspace, documentId) => { opened.push(documentId); },
    async request(method, path) {
      assert.equal(method, 'GET');
      paths.push(path);
      return paths.length === 1 ? {status:503, body:{}}
        : {status:200, body:{document:{id,title:'协作方案',body:'已保存的正文',revision:1}}};
    },
  });
  studio.setWorkspace({id:workspace, name:'团队', kind:'team', role:'member'}, 'account');
  await studio.open(id);
  assert.equal(get('catalog').hidden, true);
  assert.equal(get('status').textContent, '暂时无法打开团队文档。');
  assert.equal(doc.activeElement, get('open-retry'));
  await get('open-retry').dispatch('click');
  await new Promise(setImmediate);
  assert.deepEqual(paths, Array(2).fill(`/v1/workspaces/${workspace}/studio/documents/${id}`));
  assert.deepEqual(opened, [id]);
  assert.equal(get('open-actions').hidden, true);
  assert.equal(get('body').value, '已保存的正文');
});

const noticeWorkspace = 'a'.repeat(32);
const noticeConversation = 'otc_' + 'B'.repeat(26);
const noticeMessage = 'otm_' + 'C'.repeat(26);
const sharedNotice = {
  id: 'notice-one', kind: 'artifact.shared', title: '路线图', actor_username: 'Lin',
  workspace_id: noticeWorkspace, conversation_id: noticeConversation, message_id: noticeMessage, read: false,
};
const publishedNotice = {id: 'notice-two', kind: 'discover.published', listing_kind: 'work', slug: 'design-brief', read: true};
const noticeChat = '/chat#' + new URLSearchParams({workspace: noticeWorkspace, social: noticeConversation, message: noticeMessage});

function notificationFixture(request) {
  const {doc} = fakeDocument();
  const element = id => doc.getElementById(id);
  const dialog = element('artifact-notifications');
  dialog.showModal = () => { dialog.open = true; element('artifact-notifications-close').focus(); };
  dialog.close = () => { dialog.open = false; void dialog.dispatch('close'); };
  const routes = [];
  let scheduled = 0;
  doc.defaultView = {
    setTimeout: () => ++scheduled,
    clearTimeout() {}, addEventListener() {},
    location: {assign: target => routes.push(target)},
  };
  return {doc, element, dialog, routes, ...mountArtifactNotifications(doc, {request})};
}

test('Space notification links reject foreign paths and open verified work or chat deep links', () => {
  assert.equal(artifactNoticeTarget(sharedNotice, noticeWorkspace), noticeChat);
  assert.equal(artifactNoticeTarget({...sharedNotice, path: '//example.test'}, noticeWorkspace), null);
  assert.equal(artifactNoticeTarget(sharedNotice, 'b'.repeat(32)), null);
  assert.equal(artifactNoticeTarget(publishedNotice, noticeWorkspace), '/discover?work=design-brief');
  assert.equal(artifactNoticeTarget({...publishedNotice, slug: '../account'}, noticeWorkspace), null);
  assert.equal(artifactNoticeTarget({...publishedNotice, listing_kind: 'agent'}, noticeWorkspace), null);
});

test('Space bell fetches a scoped badge, retries loading, and marks only work notices read', async () => {
  const calls = [];
  let openReads = 0;
  const scoped = '/v1/workspaces/' + noticeWorkspace + '/notifications';
  const page = notificationFixture(async (method, url, body, options) => {
    calls.push({method, url, body, options});
    if (method === 'POST') return {status: 200, body: {unread_count: 0}};
    if (url.endsWith('limit=1')) return {status: 200, body: {unread_count: 1}};
    if (!openReads++) return {status: 503};
    return {status: 200, body: {items: [sharedNotice, publishedNotice, {kind: 'messenger.mention'}], unread_count: 1}};
  });
  const bell = page.element('artifact-notify');
  const badge = page.element('artifact-notify-count');
  const retry = page.element('artifact-notifications-retry');
  const list = page.element('artifact-notifications-list');
  page.setWorkspace(noticeWorkspace);
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(call => call.url), [scoped + '?kind=work&limit=1']);
  assert.equal(badge.textContent, '1');
  await bell.dispatch('click');
  await new Promise(setImmediate);
  assert.equal(retry.hidden, false);
  await retry.dispatch('click');
  await new Promise(setImmediate);
  assert.equal(retry.hidden, true);
  assert.deepEqual(list.children.map(row => row.children[0].href), [noticeChat, '/discover?work=design-brief']);
  await page.element('artifact-notifications-read-all').dispatch('click');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).body, {all: true, kind: 'work'});
  assert.equal(calls.at(-1).url, scoped + '/read');
  assert.equal(badge.hidden, true);
  assert.equal(list.children[0].dataset.unread, 'false');
  page.dialog.close();
  assert.equal(page.doc.activeElement, bell);
});

test('Space ignores a delayed notice read after switching workspace and acknowledges unread links before opening', async () => {
  const calls = [];
  const slow = deferred();
  const acknowledgment = deferred();
  const laterWorkspace = 'b'.repeat(32);
  const page = notificationFixture(async (method, url, body, options) => {
    calls.push({method, url, body, options});
    if (url.includes(noticeWorkspace)) return slow.promise;
    if (method === 'POST') return acknowledgment.promise;
    return {status: 200, body: {items: [{...publishedNotice, read: false}], unread_count: 1}};
  });
  page.setWorkspace(noticeWorkspace);
  const old = calls[0];
  page.setWorkspace(laterWorkspace);
  slow.finish({status: 200, body: {items: [sharedNotice], unread_count: 40}});
  await new Promise(setImmediate);
  assert.equal(old.options.signal.aborted, true);
  assert.equal(page.element('artifact-notify-count').textContent, '1');
  await page.element('artifact-notify').dispatch('click');
  await new Promise(setImmediate);
  const link = page.element('artifact-notifications-list').children[0].children[0];
  const opened = link.dispatch('click', {button: 0});
  await link.dispatch('click', {button: 0});
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(page.routes, []);
  assert.deepEqual(calls.at(-1).body, {notification_id: publishedNotice.id, kind: 'work'});
  assert.equal(calls.at(-1).options.keepalive, true);
  assert.ok(calls.at(-1).options.signal instanceof AbortSignal);
  acknowledgment.finish({status: 200, body: {unread_count: 0}});
  await opened;
  assert.deepEqual(page.routes, ['/discover?work=design-brief']);
});

async function openArtifactsPage({items = [], artifact, meetings = [], meetingsStatus = 200, meetingsError = null,
                                  withKinds = false, workspaces = [{id: 'w1', name: 'Desk'}], tasks = [], saveReply = null,
                                  withScopes = false, native = false, extraRequest} = {}) {
  const {doc, elements, created, form} = fakeDocument();
  if (native) doc.querySelector = selector => selector === 'meta[name="flybot-workspace-served-by"][content="ds-bot"]' ? {} : null;
  if (withKinds) {
    doc.kindButtons = ['all', 'website', 'document', 'media', 'messages', 'meetings'].map((kind) => {
      const node = new FakeNode('button');
      node.setAttribute('data-kind', kind);
      node.ownerDocument = doc;
      return node;
    });
  }
  if (withScopes) {
    doc.scopeButtons = ['all', 'mine', 'favorites', 'memory'].map(scope => {
      const node = new FakeNode('button');
      node.setAttribute('data-scope', scope);
      node.ownerDocument = doc;
      return node;
    });
  }
  const calls = [];
  const saveCalls = [];
  let listed = items.slice();
  const target = artifact || {id: 'a1', title: 'Doc', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'};
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({method, path, headers: options.headers || {}, body: options.body});
    const extra = extraRequest?.(path, options);
    if (extra) return extra;
    if (path === '/v1/auth/session') return reply({body: {user: {id: 'u1', username: 'alice'}}});
    if (path === '/v1/auth/providers') return reply({body: {items: []}});
    if (path === '/v1/workspaces?limit=100') return reply({body: {items: workspaces}});
    const order = native ? '?order=recent' : '';
    if (path === '/v1/workspaces/w2/artifacts' + order) return reply({body: {items: []}});
    if (path === '/v1/workspaces/w1/artifacts' + order) return reply({body: {items: listed}});
    if (path === '/v1/workspaces/w1/meetings' + (native ? '?limit=24&order=recent' : '?limit=100')) {
      if (meetingsStatus !== 200) return reply({status: meetingsStatus, body: meetingsError || {}});
      return reply({body: {items: meetings, cursor: null}});
    }
    if (path === '/v1/skills/runs' && method === 'GET') return reply({body: {items: tasks.map(task => ({task, verified: task.status === 'succeeded' && !!task.result?.text?.trim()}))}});
    const taskSave = /^\/v1\/skills\/runs\/([0-9a-f]+)\/artifact$/.exec(path);
    if (taskSave && method === 'POST') {
      saveCalls.push({id: taskSave[1], body: options.body ? JSON.parse(options.body) : null});
      if (saveReply) return reply(saveReply);
      const task = tasks.find((row) => row.id === taskSave[1]);
      const saved = {id: 'a9', title: `${task.prompt} · 任务结果`, kind: 'document', created_by: 'alice'};
      listed = [saved, ...listed];
      return reply({status: 201, body: {artifact: saved}});
    }
    const detail = /^\/v1\/workspaces\/w1\/artifacts\/([^/]+)(\/(shares|versions|discover))?$/.exec(path);
    if (detail && method === 'GET') {
      if (detail[3] === 'shares') return reply({body: {items: []}});
      if (detail[3] === 'versions') return reply({body: {items: []}});
      if (detail[3] === 'discover') return reply({body: {discover: {}}});
      if (detail[1] === target.id) return reply({body: {artifact: target}});
      const row = listed.find(item => item.id === detail[1]);
      if (row) return reply({body: {artifact: {...row, revision: 1, body: 'hello'}}});
    }
    if (path === '/v1/workspaces/w1/artifacts/a1/remove') {
      listed = [];
      return reply({status: 200});
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  let mounted = false;
  try {
    await mount(doc, {fetcher});
    mounted = true;
  } finally {
    if (!mounted) {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  }
  return {
    doc, elements, created, form, calls, saveCalls,
    async openKind(kind) {
      const button = (doc.kindButtons || []).find((node) => node.getAttribute('data-kind') === kind);
      assert.ok(button, `kind button ${kind} must exist`);
      await button.dispatch('click');
    },
    async openScope(scope) {
      const button = (doc.scopeButtons || []).find(node => node.getAttribute('data-scope') === scope);
      assert.ok(button, `scope button ${scope} must exist`);
      await button.dispatch('click');
    },
    meetingCalls() { return calls.filter(call => call.path.startsWith('/v1/workspaces/w1/meetings?')); },
    removeCalls() { return calls.filter(call => call.path === '/v1/workspaces/w1/artifacts/a1/remove'); },
    alertdialog() { return created.filter(node => node.getAttribute('role') === 'alertdialog' && node.parentNode); },
    close() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    },
  };
}

function cardOf(dialog) {
  return dialog.children.find(child => String(child.className || '').includes('send-dialog-card')) || dialog;
}

function artifactRows(list) {
  return list.children.filter(child => String(child.className || '').split(/\s+/).includes('artifact-item'));
}

async function openEditorOn(page, index = 0) {
  const list = page.elements.get('artifact-list');
  const row = artifactRows(list)[index];
  assert.ok(row, `the list must render artifact row ${index} first`);
  await row.children[0].dispatch('click');
}

test('Space sends the saved version to the selected private or group conversation', async () => {
  const item = {id: 'a1', title: '交付原件', kind: 'document', revision: 4, created_by: 'alice'};
  const socialPath = '/v1/workspaces/w1/social/conversations/shared-id/messages';
  const privatePath = '/v1/workspaces/w1/agents/assistant/conversations/shared-id/messages';
  const sends = [];
  let staged;
  const page = await openArtifactsPage({items: [item], native: true, extraRequest(path, options) {
    if (path === '/v1/workspaces/w1/social/conversations?limit=100') return reply({body: {items: [
      {id: 'shared-id', kind: 'group', title: '交付群', updated: 1},
      {id: 'public', title: '公开会话', public_agent: true},
      {id: 'closed', title: '已关闭单聊', direct: {open: false}},
    ]}});
    if (path === '/v1/workspaces/w1/agents?limit=100&include=conversations') return reply({body: {
      items: [{id: 'assistant', name: '资料助手'}, {id: 'archived', name: '旧助手', archived: true}],
      conversations: [{id: 'shared-id', agent_id: 'assistant', title: '项目讨论', updated: 2},
        {id: 'old', agent_id: 'archived', title: '归档对话'}],
    }});
    if (path === privatePath || path === socialPath) {
      sends.push({path, body: JSON.parse(options.body), key: options.headers['Idempotency-Key']});
      if (sends.length === 1) return reply({status: 503});
      if (path === privatePath) return new Promise(resolve => { staged = resolve; });
      return reply({status: 201});
    }
  }});
  try {
    const menuItem = page.created.find(node => node.className === 'artifact-menu-send');
    const dialog = page.elements.get('send-to-chat-dialog');
    const list = page.elements.get('send-to-chat-list');
    const confirm = page.elements.get('send-to-chat-confirm');
    list.querySelectorAll = () => list.children.map(row => row.children[0]);
    const open = async () => {
      await menuItem.dispatch('click');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dialog.hidden, false);
      return list.querySelectorAll('button');
    };
    const [privateChoice, groupChoice] = await open();
    assert.deepEqual(list.querySelectorAll('button').map(button => button.textContent),
      ['智能体 · 资料助手 · 项目讨论', '交付群']);
    item.revision = 5;
    await privateChoice.dispatch('click');
    assert.match(page.elements.get('send-to-chat-lead').textContent, /智能体会读取这份附件/);
    await confirm.dispatch('click');
    assert.equal(dialog.hidden, false);
    assert.match(page.elements.get('send-to-chat-error').textContent, /发送失败/);
    const pending = confirm.dispatch('click');
    assert.equal(confirm.disabled, true);
    staged(reply({status: 202, body: {message: {id: 'staged'}}}));
    await pending;
    assert.equal(dialog.hidden, true, 'a durably staged private send closes without waiting for a model reply');
    assert.deepEqual(sends[1], sends[0], 'retry retains the private destination and write identity');
    assert.deepEqual(sends[0].body, {artifact_id: item.id, artifact_revision: 4});

    const choices = await open();
    await choices.find(button => button.textContent === groupChoice.textContent).dispatch('click');
    page.elements.get('send-to-chat-note').value = '请先核对清单。';
    await confirm.dispatch('click');
    assert.equal(dialog.hidden, true);
    assert.equal(sends[2].path, socialPath);
    assert.equal(sends[2].body.artifact_revision, 5);
    assert.equal(sends[2].body.body, '请先核对清单。');
    assert.notEqual(sends[2].key, sends[1].key);
  } finally { page.close(); }
});

test('Space starts an agent thread only on confirmation and links to the exact versioned send', async () => {
  const agent = 'b'.repeat(32);
  const thread = 'c'.repeat(32);
  const message = 'd'.repeat(32);
  const item = {id:'a1', title:'交付原件', kind:'document', revision:4, created_by:'alice'};
  const collection = '/v1/workspaces/w1/agents/' + agent + '/conversations';
  const sent = [];
  const page = await openArtifactsPage({items:[item],native:true,extraRequest(path,options) {
    if (path === '/v1/workspaces/w1/social/conversations?limit=100') return reply({body:{items:[]}});
    if (path === '/v1/workspaces/w1/agents?limit=100&include=conversations') {
      return reply({body:{items:[{id:agent,name:'资料助手'},{id:'e'.repeat(32),name:'已删除',native_deleted:true}],conversations:[]}});
    }
    if (path === collection || path === collection + '/' + thread + '/messages') {
      sent.push({path,body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});
      if (path === collection) {
        return sent.length === 1 ? reply({status:503})
          : reply({status:200,body:{conversation:{id:thread,workspace_id:'w1',agent_id:agent}}});
      }
      return sent.length === 3 ? reply({status:503}) : reply({status:202,body:{message:{id:message}}});
    }
  }});
  try {
    const dialog = page.elements.get('send-to-chat-dialog');
    const select = page.elements.get('send-to-chat-agent');
    const confirm = page.elements.get('send-to-chat-confirm');
    page.elements.get('send-to-chat-list').querySelectorAll = () => [];
    await page.created.find(node=>node.className === 'artifact-menu-send').dispatch('click');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(page.elements.get('send-to-chat-new').hidden,false);
    assert.deepEqual(select.children.map(option=>option.value),['',agent]);
    select.value = agent;
    await select.dispatch('change');
    page.elements.get('send-to-chat-note').value = '这个版本缺哪些交付项？';
    assert.deepEqual(sent,[]);
    await confirm.dispatch('click');
    assert.equal(dialog.hidden,false);
    assert.equal(page.elements.get('send-to-chat-note').value,'这个版本缺哪些交付项？');
    await confirm.dispatch('click');
    assert.equal(dialog.hidden,false);
    await confirm.dispatch('click');
    assert.equal(dialog.hidden,true);
    assert.deepEqual(sent[1],sent[0]);
    assert.deepEqual(sent[3],sent[2]);
    assert.deepEqual(sent[3].body,{artifact_id:item.id,artifact_revision:4,body:'这个版本缺哪些交付项？'});
    assert.equal(page.elements.get('status').children.at(-1).href,
      '/chat#workspace=w1&agent=' + agent + '&conversation=' + thread + '&message=' + message);
  } finally { page.close(); }
});

test('Space enables creation when the workspace resolves even if its catalogue is still loading', {timeout:3000}, async () => {
  const {doc,form} = fakeDocument();
  const el = id => doc.getElementById(id);
  form.hidden = true;
  const workspaceStarted = deferred();
  const workspace = deferred();
  const catalogueStarted = deferred();
  const catalogue = deferred();
  const saved = globalThis.document;
  globalThis.document = doc;
  const loading = mount(doc,{fetcher:async path => {
    if (path === '/v1/auth/session') return reply({body:{user:{id:'u1',username:'alice'}}});
    if (path === '/v1/workspaces?limit=100') {
      workspaceStarted.finish();
      return workspace.promise;
    }
    if (path === '/v1/workspaces/w1/artifacts') {
      catalogueStarted.finish();
      return catalogue.promise;
    }
    return reply();
  }});
  try {
    await workspaceStarted.promise;
    assert.equal(el('main-panel').hidden,false);
    assert.equal(el('workspace-pending').hidden,false);
    assert.equal(el('new-menu-button').disabled,true);
    assert.equal(el('new-artifact').disabled,true);
    await el('new-artifact').dispatch('click');
    assert.equal(form.hidden,true);
    workspace.finish(reply({body:{items:[{id:'w1',name:'Desk'}]}}));
    await catalogueStarted.promise;
    assert.equal(el('workspace-pending').hidden,true);
    assert.equal(el('new-menu-button').disabled,false);
    await el('new-artifact').dispatch('click');
    await new Promise(setImmediate);
    assert.equal(form.hidden,false);
  } finally {
    workspace.finish(reply());
    catalogue.finish(reply({body:{items:[]}}));
    await loading;
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
});

test('artifactDeletePrompt names the artifact and never echoes an empty title', () => {
  assert.deepEqual(artifactDeletePrompt({title: 'Doc'}), {
    question: '删除「Doc」？', detail: '删除后不能恢复。', cancelLabel: '取消', confirmLabel: '确认',
  });
  assert.equal(artifactDeletePrompt({title: '  '}).question, '删除这个作品？');
  assert.equal(artifactDeletePrompt(null).question, '删除这个作品？');
});

test('clicking remove asks first and sends no request until the answer is yes', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    assert.equal(trigger.hidden, false);
    void trigger.dispatch('click');
    assert.equal(page.removeCalls().length, 0, 'opening the question must not send the delete request');
    const dialogs = page.alertdialog();
    assert.equal(dialogs.length, 1, 'one inline alertdialog must exist');
    const box = dialogs[0];
    assert.equal(box.getAttribute('aria-labelledby'), 'remove-artifact-question');
    const question = box.children.find(child => child.id === 'remove-artifact-question');
    assert.equal(question.textContent, '删除「Doc」？');
    assert.deepEqual(box.children.filter(child => child.tagName === 'BUTTON').map(child => child.textContent), ['取消', '确认']);
    assert.equal(trigger.hidden, true);
    const buttons = box.children.filter(child => child.tagName === 'BUTTON');
    assert.equal(page.doc.activeElement, buttons[0], 'focus starts on the cancel button');
  } finally {
    page.close();
  }
});

test('cancel and Escape keep the artifact and send nothing', async () => {
  for (const how of ['cancel', 'escape']) {
    const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
    try {
      await openEditorOn(page);
      const trigger = page.elements.get('remove-artifact');
      const list = page.elements.get('artifact-list');
      const statusText = page.elements.get('status').textContent;
      const rowsBefore = list.children.length;
      const pending = trigger.dispatch('click');
      const box = page.alertdialog()[0];
      const choice = box.children.filter(child => child.tagName === 'BUTTON');
      if (how === 'cancel') await choice[0].dispatch('click');
      else await page.doc.dispatch('keydown', {key: 'Escape'});
      await pending;
      assert.equal(page.removeCalls().length, 0, `no delete request after ${how}`);
      assert.equal(page.alertdialog().length, 0, `the question closes after ${how}`);
      assert.equal(trigger.hidden, false, `the remove button returns after ${how}`);
      assert.equal(page.doc.activeElement, trigger, `focus returns to remove after ${how}`);
      assert.equal(list.children.length, rowsBefore, `the list is unchanged after ${how}`);
      assert.equal(page.elements.get('status').textContent, statusText, `the status line is unchanged after ${how}`);
    } finally {
      page.close();
    }
  }
});

test('confirming deletes the artifact exactly once and clears it from the list', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    const pending = trigger.dispatch('click');
    const box = page.alertdialog()[0];
    await box.children.filter(child => child.tagName === 'BUTTON')[1].dispatch('click');
    await pending;
    assert.equal(page.removeCalls().length, 1);
    assert.equal(page.elements.get('status').textContent, '已删除。');
    assert.equal(page.elements.get('status').dataset.kind, 'ok');
    assert.equal(page.elements.get('artifact-list').children.length, 0);
    assert.equal(page.elements.get('editor-form').hidden, true);
    assert.equal(page.elements.get('list-panel').hidden, false);
  } finally {
    page.close();
  }
});

test('library layout applies actual grid/list presentation state without changing data', async () => {
  const {applyArtifactLayout} = await import('../flybot_workspace/static/artifacts/app.mjs');
  const row = {id: 'persisted-work'};
  const list = {dataset: {}, children: [row]};
  assert.equal(applyArtifactLayout(list, 'grid'), 'grid');
  assert.equal(list.dataset.layout, 'grid');
  assert.equal(applyArtifactLayout(list, 'list'), 'list');
  assert.equal(list.dataset.layout, 'list');
  assert.equal(applyArtifactLayout(list, 'unknown'), 'grid');
  assert.equal(list.children[0], row);
});

test('switching workspace retires a delete question aimed at the workspace it left', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: 'W1 作品', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: 'W1 作品', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
    workspaces: [{id: 'w1', name: 'Desk'}, {id: 'w2', name: 'Studio'}],
  });
  try {
    await openEditorOn(page);
    page.elements.get('remove-artifact').dispatch('click');
    const box = page.alertdialog()[0];
    assert.ok(box, 'clicking remove asks the user first');
    const question = box.children.find((node) => node.id === 'remove-artifact-question');
    assert.equal(question.textContent, '删除「W1 作品」？');

    page.elements.get('workspace').value = 'w2';
    await page.elements.get('workspace').dispatch('change');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'the question must not keep asking about a workspace the page has left',
    );
    assert.deepEqual(
      page.calls.filter((call) => call.method === 'POST').map((call) => call.path),
      [],
      'switching workspace while the question is open must delete nothing',
    );
  } finally {
    page.close();
  }
});

test('returning to the list retires the delete question', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    await openEditorOn(page);
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await page.elements.get('cancel-editor').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'going back to the list must not leave the delete question hanging over it',
    );
    assert.deepEqual(
      page.calls.filter((call) => call.method === 'POST').map((call) => call.path),
      [],
      'nothing is deleted by leaving the editor',
    );
  } finally {
    page.close();
  }
});

test('opening another artifact never inherits the previous delete question', async () => {
  const page = await openArtifactsPage({
    items: [
      {id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'},
      {id: 'a2', title: '周报', kind: 'document', created_by: 'alice'},
    ],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    const list = page.elements.get('artifact-list');
    await artifactRows(list)[0].children[0].dispatch('click');
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await page.elements.get('cancel-editor').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    await artifactRows(list)[1].children[0].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'the question about the first artifact must not follow the editor into the second one',
    );
    const posts = page.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/remove'));
    assert.equal(posts.length, 0, 'opening a second artifact deletes nothing');
    const form = page.elements.get('editor-form');
    assert.equal(form.hidden, false, 'the second artifact is open in the editor');
  } finally {
    page.close();
  }
});

test('the confirmation keeps the target it captured even if the picker moves without an event', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
    workspaces: [{id: 'w1', name: 'Desk'}, {id: 'w2', name: 'Studio'}],
  });
  try {
    await openEditorOn(page);
    void page.elements.get('remove-artifact').dispatch('click');
    const box = page.alertdialog()[0];
    assert.ok(box, 'clicking remove asks the user first');

    page.elements.get('workspace').value = 'w2';
    box.children.filter(child => child.tagName === 'BUTTON')[1].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    const posts = page.calls.filter((call) => call.method === 'POST');
    assert.deepEqual(
      posts.map((call) => call.path),
      ['/v1/workspaces/w1/artifacts/a1/remove'],
      'the answer must delete the artifact the question named, in the workspace it named',
    );
  } finally {
    page.close();
  }
});

test('opening an artifact straight from a stale list clears the question', async () => {
  const page = await openArtifactsPage({
    items: [
      {id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'},
      {id: 'a2', title: '周报', kind: 'document', created_by: 'alice'},
    ],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    const list = page.elements.get('artifact-list');
    await artifactRows(list)[0].children[0].dispatch('click');
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await artifactRows(list)[1].children[0].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'opening another artifact must clear a question the editor still holds',
    );
    assert.equal(
      page.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/remove')).length,
      0,
      'opening another artifact deletes nothing',
    );
  } finally {
    page.close();
  }
});

test('library item badges and times are derived from real artifact fields', async () => {
  const { kindBadge, artifactTime } = await import('../flybot_workspace/static/artifacts/app.mjs');
  assert.equal(kindBadge('document'), 'DOC');
  assert.equal(kindBadge('website'), 'WEB');
  assert.equal(kindBadge('unknown'), 'FILE');
  assert.equal(artifactTime(0), '');
  const now = new Date(2026, 10, 19, 15, 0).getTime();
  assert.equal(artifactTime(new Date(2026, 10, 19, 9, 5).getTime() / 1000, now), '今天 09:05');
  assert.equal(artifactTime(new Date(2026, 10, 2, 18, 30).getTime() / 1000, now), '11月2日 18:30');
});


test('canSendArtifactToChat enables every persisted work type, not missing IDs', async () => {
  const {canSendArtifactToChat, conversationLabel} = await import('../flybot_workspace/static/artifacts/app.mjs');
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'media'}), true);
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'document'}), true);
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'website'}), true);
  assert.equal(canSendArtifactToChat({kind: 'media'}), false);
  assert.equal(conversationLabel({title: 'Project room'}), 'Project room');
  assert.equal(conversationLabel({kind: 'dm', members: [{username: 'alice'}, {username: 'bob'}]}), 'alice、bob');
  assert.equal(conversationLabel({kind: 'group'}), '群聊');
  assert.equal(conversationLabel({kind: 'dm'}), '单聊');
});

import { newKindFromSearch, newKindButtonId } from '../flybot_workspace/static/artifacts/app.mjs';

test('?new= only opens known 新建 editors', () => {
  assert.equal(newKindFromSearch('?new=document'), 'document');
  assert.equal(newKindButtonId('document'), 'new-artifact');
  assert.equal(newKindButtonId(newKindFromSearch('?new=whiteboard')), 'new-board');
  assert.equal(newKindFromSearch('?new=constructor'), '');
  assert.equal(newKindFromSearch(''), '');
  assert.equal(newKindButtonId('image'), '');
});

test('meetingRows sorts newest first and labels action items honestly', () => {
  const rows = meetingRows([
    {id: 'm1', title: '周会', started_at: 1700000000, action_count: 2, done_count: 1},
    {id: 'm2', title: '评审', started_at: 1700003600, action_count: 0, done_count: 0},
    {id: 'm3', title: '复盘', started_at: 1699996400, action_count: 3, done_count: 3},
  ]);
  assert.deepEqual(rows.map((row) => row.title), ['评审', '周会', '复盘']);
  assert.equal(rows[0].actionLabel, '尚无行动项');
  assert.equal(rows[1].actionLabel, '2 项行动项，1 项已完成');
  assert.equal(rows[2].actionLabel, '3 项行动项，全部完成');
  assert.equal(meetingActionLabel(1, 0), '1 项行动项');
  assert.equal(meetingActionLabel(undefined, undefined), '尚无行动项');
  assert.match(meetingTimeLabel(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(meetingTimeLabel(0), '');
  assert.equal(meetingTimeLabel('nope'), '');
});

test('meetingsForScope keeps the workspace list unless the joined scope is selected', () => {
  const items = [
    {id: 'm1', title: '周会', attendees: ['alice'], created_by: 'u2'},
    {id: 'm2', title: '评审', attendees: ['bob'], created_by: 'u2'},
    {id: 'm3', title: '复盘', attendees: [], created_by: 'u1'},
  ];
  assert.deepEqual(meetingsForScope(items).map((row) => row.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(meetingsForScope(items, {scope: 'all'}).map((row) => row.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(
    meetingsForScope(items, {scope: 'joined', username: 'alice', userId: 'u1'}).map((row) => row.id),
    ['m1', 'm3'],
  );
  assert.deepEqual(meetingsForScope(items, {scope: 'joined', username: 'ALICE'}).map((row) => row.id), ['m1']);
  assert.deepEqual(meetingsForScope(items, {scope: 'joined'}).map((row) => row.id), []);
  const local = [{id: 'm4', title: '独立容器的会议', attendees: [], created_by: 'owner'}];
  assert.deepEqual(meetingsForScope(local, {scope: 'joined', userId: 'u1'}).map(row => row.id), ['m4']);
  assert.deepEqual(meetingsForScope(local, {scope: 'joined'}), []);
  const receipt = {id: 'received', title: '收到的纪要', organizer: '组织者', shared: true};
  assert.deepEqual(meetingsForScope([local[0], receipt], {scope: 'joined'}), [receipt]);
});

test('the Space meetings list keeps local notes and pages received read-only copies separately', async () => {
  const [local, first, second] = ['a', 'b', 'c'].map(value => value.repeat(32));
  const sent = (id, title) => ({id, title, shared: true, organizer: '会议主持人',
    started_at: 1710000000, action_count: 1, done_count: 1});
  const page = await openArtifactsPage({withKinds: true, native: true,
    meetings: [{id: local, title: '本人纪要', started_at: 1700000000, created_by: 'owner'}],
    extraRequest(path) {
      if (path.endsWith('/meetings/shared?limit=24')) return reply({body: {items: [sent(first, '第一份纪要')], cursor: first}});
      if (path.endsWith('/meetings/shared?limit=24&cursor=' + first)) return reply({body: {items: [sent(second, '第二份纪要')], cursor: null}});
    },
  });
  try {
    await page.openKind('meetings');
    const list = page.elements.get('artifact-list');
    const more = page.elements.get('more-shared-meetings');
    assert.deepEqual(list.children.map(row => row.children[0].href), [
      '/meetings#workspace=w1&shared=' + first + '&library=joined',
      '/meetings#workspace=w1&meeting=' + local + '&library=joined',
    ]);
    assert.equal(list.children[0].dataset.meetingShared, 'true');
    assert.match(list.children[0].textContent, /第一份纪要共享纪要.*会议主持人/);
    assert.equal(more.hidden, false);
    await more.dispatch('click');
    assert.equal(list.children.length, 3);
    assert.equal(more.hidden, true);
    assert.equal(page.meetingCalls().length, 1, 'receipt pagination does not reload the owner notes');
  } finally { page.close(); }
});

test('Space retries both meeting cursors when a shared page fails before either advances', async () => {
  const [owned, shared, nextOwned, nextShared] = ['a', 'b', 'c', 'd'].map(value => value.repeat(32));
  const note = id => ({id, title: id, started_at: 1710000000, created_by: 'owner'});
  const pageBody = (id, cursor = null) => reply({body: {items: [note(id)], cursor}});
  let sharedAttempts = 0;
  const page = await openArtifactsPage({withKinds: true, native: true, extraRequest(path) {
    if (path.endsWith('/meetings?limit=24&order=recent')) return pageBody(owned, owned);
    if (path.endsWith('/meetings/shared?limit=24')) return pageBody(shared, shared);
    if (path.endsWith('/meetings?limit=24&order=recent&cursor=' + owned)) return pageBody(nextOwned);
    if (path.endsWith('/meetings/shared?limit=24&cursor=' + shared)) {
      return ++sharedAttempts === 1 ? reply({status: 503, body: {}}) : pageBody(nextShared);
    }
  }});
  try {
    await page.openKind('meetings');
    const list = page.elements.get('artifact-list');
    const more = page.elements.get('more-shared-meetings');
    const retry = page.elements.get('retry-meetings');
    await more.dispatch('click');
    assert.equal(list.children.length, 2);
    assert.equal(more.disabled, true);
    assert.equal(retry.hidden, false);
    await retry.dispatch('click');
    assert.equal(list.children.length, 4);
    assert.equal(page.meetingCalls().filter(call => call.path.endsWith('&cursor=' + owned)).length, 2);
    assert.equal(more.hidden, true);
    assert.equal(retry.hidden, true);
  } finally { page.close(); }
});

test('Space searches older meetings on demand without increasing the first read', async () => {
  const [recent, older] = ['a', 'b'].map(value => value.repeat(32));
  const note = (id, title) => ({id, title, started_at: 1710000000, created_by: 'owner'});
  const page = await openArtifactsPage({withKinds: true, native: true, extraRequest(path) {
    if (path.endsWith('/meetings?limit=24&order=recent')) {
      return reply({body:{items:[note(recent, '本周会议')], cursor:recent}});
    }
    if (path.endsWith('/meetings/shared?limit=24')) return reply({body:{items:[]}});
    if (path.endsWith('/meetings?limit=76&order=recent&cursor=' + recent)) {
      return reply({body:{items:[note(older, '旧发布复盘')]}});
    }
  }});
  try {
    const search = page.elements.get('search');
    const list = page.elements.get('artifact-list');
    await page.openKind('meetings');
    assert.equal(page.meetingCalls().length, 1);
    assert.doesNotMatch(list.textContent, /旧发布复盘/);
    search.value = '旧发布';
    await search.dispatch('input');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.meetingCalls().length, 2);
    assert.match(list.textContent, /旧发布复盘/);
    assert.doesNotMatch(list.textContent, /本周会议/);
    search.value = '发布';
    await search.dispatch('input');
    assert.equal(page.meetingCalls().length, 2, 'typing a second query reuses the expanded list');
  } finally { page.close(); }
});

test('the meetings kind renders the workspace meetings from the existing endpoint', async () => {
  const page = await openArtifactsPage({withKinds: true, meetings: [
    {id: 'm1', title: '设计周会', started_at: 1700000000, action_count: 2, done_count: 0, created_by: 'u1'},
    {id: 'm2', title: '发布复盘', started_at: 1700007200, action_count: 1, done_count: 1, attendees: ['alice']},
  ]});
  try {
    await page.openKind('meetings');
    assert.equal(page.meetingCalls().length, 1, 'the meetings tab reads the endpoint once');
    assert.equal(page.meetingCalls()[0].method, 'GET');
    const list = page.elements.get('artifact-list');
    const rows = list.children.filter((child) => child.className === 'meeting-item');
    assert.equal(rows.length, 2, 'two meetings must be listed');
    assert.equal(rows[0].children[0].href, '/meetings#workspace=w1&meeting=m2');
    assert.match(rows[0].textContent, /发布复盘/);
    assert.match(rows[1].textContent, /设计周会/);
    assert.match(rows[0].textContent, /1 项行动项，全部完成/);
    assert.match(rows[1].textContent, /2 项行动项/);
    assert.equal(page.elements.get('empty-meetings').hidden, true);
    assert.equal(page.elements.get('meetings-error').hidden, true);
  } finally {
    page.close();
  }
});

test('an empty meetings workspace shows the honest empty state, not an error', async () => {
  const page = await openArtifactsPage({withKinds: true, meetings: []});
  try {
    await page.openKind('meetings');
    assert.equal(page.elements.get('empty-meetings').hidden, false);
    assert.equal(page.elements.get('meetings-error').hidden, true);
    assert.equal(page.elements.get('meetings-error').textContent, '');
  } finally {
    page.close();
  }
});

test('a failing meetings request shows the server reason instead of an empty list', async () => {
  const page = await openArtifactsPage({
    withKinds: true, meetingsStatus: 500,
    meetingsError: {error: {code: 'internal', message: 'listing failed in the store'}},
  });
  try {
    await page.openKind('meetings');
    const errorBox = page.elements.get('meetings-error');
    assert.equal(errorBox.hidden, false);
    assert.match(errorBox.textContent, /listing failed in the store/);
    assert.equal(page.elements.get('empty-meetings').hidden, true, 'a failure must not read as "no meetings"');
    const list = page.elements.get('artifact-list');
    assert.equal(list.children.filter((child) => String(child.className || '').includes('artifact-item')).length, 0);
  } finally {
    page.close();
  }
});

// The artworks empty state is the place a user learns how content gets into the
// library. Its image entry claimed there was no way to save a chat picture even
// though the chat composer uploads every attachment into this same library
// before it sends the message, so the disabled promise was simply false.

test('the artworks empty state points at the real chat picture flow', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/artifacts/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="empty-save-image"');
  assert.ok(start > -1, 'the starred empty state still offers a picture entry');
  const open = html.lastIndexOf('<', start);
  const tag = html.slice(open, html.indexOf('>', start) + 1);
  assert.match(tag, /^<a\b/, 'the picture entry must be a real link, not a disabled button');
  assert.match(tag, /href="\/chat"/, 'it has to reach the page that can actually attach a picture');
  assert.doesNotMatch(tag, /\bdisabled\b/, 'a working entry cannot be disabled');
  const copy = html.slice(open, html.indexOf('</a>', start)).replace(/\s+/g, ' ');
  assert.doesNotMatch(copy, /未实现/, 'the copy must not claim the feature is missing');
  assert.match(copy, /作品库/, 'the copy names where the picture lands');
});

test('saving a completed task artifact posts the task id and lists the document', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [
      {id: 'a'.repeat(32), status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '周报正文'}},
      {id: 'd'.repeat(32), status: 'running', prompt: '还在跑', workspace_id: 'w1', result: {}},
      {id: 'b'.repeat(32), status: 'succeeded', prompt: '空结果', workspace_id: 'w1', result: {text: '   '}},
    ],
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    assert.equal(page.calls.some(call => call.path === '/v1/skills/runs' && call.method === 'GET'), true,
                 'the agent save panel must read the real task list');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    assert.ok(dialog, 'the panel is rendered');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    const rows = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children;
    assert.equal(rows.length, 1, 'only succeeded tasks with text results are offered');
    assert.match(rows[0].textContent, /整理周报/);
    const save = rows[0].children.filter(child => child.tagName === 'BUTTON')[0];
    assert.equal(save.textContent, '保存');
    await save.dispatch('click');
    assert.equal(page.saveCalls.length, 1);
    assert.equal(page.saveCalls[0].id, 'a'.repeat(32));
    assert.deepEqual(page.saveCalls[0].body, {workspace_id: 'w1'});
    assert.equal(page.elements.get('status').textContent, '已保存。');
    const list = page.elements.get('artifact-list');
    const titles = artifactRows(list).map(row => row.textContent);
    assert.equal(titles.some(text => text.includes('整理周报 · 任务结果')), true, 'the saved document joins the list');
  } finally {
    page.close();
  }
});

test('a refused save shows the server reason and keeps the task on screen', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [{id: 'a'.repeat(32), status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '正文'}}],
    saveReply: {status: 409, body: {error: {code: 'conflict', message: 'Only a succeeded task with a text result can be saved'}}},
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    const row = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children[0];
    const save = row.children.filter(child => child.tagName === 'BUTTON')[0];
    await save.dispatch('click');
    const note = cardOf(dialog).children.find(child => child.id === 'agent-task-note');
    assert.equal(note.hidden, false, 'the failure is shown');
    assert.equal(note.textContent, 'Only a succeeded task with a text result can be saved');
    assert.equal(dialog.hidden, false, 'the panel stays open after a failure');
    assert.equal(save.disabled, false, 'the button is not flipped to a success state');
    assert.equal(artifactRows(page.elements.get('artifact-list')).length, 0, 'nothing was added to the list');
  } finally {
    page.close();
  }
});

test('an unauthorised save asks the user to sign in instead of failing silently', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [{id: 'a'.repeat(32), status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '正文'}}],
    saveReply: {status: 401, body: {error: {code: 'unauthorized', message: 'Sign in first'}}},
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    const row = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children[0];
    await row.children.filter(child => child.tagName === 'BUTTON')[0].dispatch('click');
    const note = cardOf(dialog).children.find(child => child.id === 'agent-task-note');
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /登录/);
    assert.equal(artifactRows(page.elements.get('artifact-list')).length, 0);
  } finally {
    page.close();
  }
});

test('favorites scope uses the persisted flag instead of inventing an empty collection', () => {
  const items = [{id:'a', kind:'document', favorited:true}, {id:'b', kind:'document', favorited:false}];
  assert.deepEqual(visibleArtifacts(items, {scope:'favorites'}).map(item=>item.id), ['a']);
});

test('a complete advanced filter resets paging and fences the prior date query', async () => {
  const start = '2026-03-08';
  const updated = artifactModifiedBounds('custom', 0, {start, end: start});
  const base = '/v1/workspaces/w1/artifacts';
  const first = {id: 'a'.repeat(32), kind: 'document', title: '先加载的作品'};
  const old = {id: 'b'.repeat(32), kind: 'document', title: '只匹配旧筛选'};
  const match = {id: 'c'.repeat(32), kind: 'website', title: '完整目录内的较早作品'};
  const held = deferred();
  const rangePath = base + listQuery('', {updated}) + '&order=recent';
  const combinedPath = base + listQuery('', {types: ['网页'], creators: ['A & B'], sessions: ['old.session'], updated}) + '&order=recent';
  const page = await openArtifactsPage({native: true, extraRequest(path) {
    if (path === base + '?order=recent') return reply({body: {items: [first], cursor: first.id}});
    if (path === rangePath) return held.promise;
    if (path === combinedPath) return reply({body: {items: [match], cursor: null}});
  }});
  const {doc, elements, calls} = page;
  const find = doc.querySelector.bind(doc);
  const all = doc.querySelectorAll.bind(doc);
  const control = (name, value, checked = false) => ({name, value, checked});
  const untimed = control('modified', 'any');
  const custom = control('modified', 'custom', true);
  const website = control('file-type', '网页');
  const author = control('creator', 'A & B');
  const source = control('session', 'old.session');
  const selectors = [untimed, custom, website, author, source];
  doc.querySelector = selector => selector === '#filter-panel input[name="modified"]:checked'
    ? selectors.find(input => input.name === 'modified' && input.checked) : find(selector);
  doc.querySelectorAll = selector => {
    if (selector === '#filter-panel input[type="checkbox"]') return [website, author, source];
    const field = /^#filter-panel input\[name="([^"]+)"\](:checked)?$/.exec(selector);
    return field ? selectors.filter(input => input.name === field[1] && (!field[2] || input.checked)) : all(selector);
  };
  const panel = elements.get('filter-panel');
  const since = elements.get('filter-date-start');
  const until = elements.get('filter-date-end');
  since.name = 'modified-start';
  until.name = 'modified-end';
  const rows = () => artifactRows(elements.get('artifact-list')).map(row => row.dataset.artifactId);
  try {
    const listCalls = () => calls.filter(call => call.path.startsWith(base + '?'));
    assert.deepEqual(rows(), [first.id]);
    await panel.dispatch('change', {target: custom});
    since.value = start;
    await panel.dispatch('change', {target: since});
    until.value = '2026-03-07';
    await panel.dispatch('change', {target: until});
    assert.equal(listCalls().length, 1);
    assert.equal(until.getAttribute('aria-invalid'), 'true');
    assert.match(elements.get('filter-date-message').textContent, /结束日期不能早于/);

    until.value = start;
    const oldQuery = panel.dispatch('change', {target: until});
    assert.equal(listCalls().at(-1).path, rangePath);
    assert.equal(until.getAttribute('aria-invalid'), undefined);

    website.checked = author.checked = source.checked = true;
    await panel.dispatch('change', {target: source});
    assert.equal(listCalls().at(-1).path, combinedPath);
    assert.deepEqual(rows(), [match.id]);
    assert.equal(elements.get('artifact-pagination').hidden, true);
    held.finish(reply({body: {items: [old], cursor: null}}));
    await oldQuery;
    assert.deepEqual(rows(), [match.id]);

    await elements.get('filter-reset').dispatch('click');
    assert.deepEqual(rows(), [first.id]);
    assert.equal(untimed.checked, true);
    assert.equal(website.checked, false);
    assert.equal(since.value, '');
  } finally { page.close(); }
});

test('loading more is single-flight and never inserts results into a newly selected catalog scope', async () => {
  const first = {id: 'a'.repeat(32), kind: 'document', title: '最近作品'};
  const older = {id: 'b'.repeat(32), kind: 'document', title: '下一页作品'};
  const saved = {id: 'c'.repeat(32), kind: 'document', title: '较早的收藏', favorited: true};
  const held = deferred();
  const base = '/v1/workspaces/w1/artifacts';
  const olderPath = base + '?order=recent&cursor=' + first.id;
  const page = await openArtifactsPage({native: true, withScopes: true, extraRequest(path) {
    if (path === base + '?order=recent') return reply({body: {items: [first], cursor: first.id}});
    if (path === olderPath) return held.promise;
    if (path === base + '?scope=favorites&order=recent') return reply({body: {items: [saved], cursor: null}});
  }});
  const list = page.elements.get('artifact-list');
  const footer = page.elements.get('artifact-pagination');
  const more = page.elements.get('more-artifacts');
  try {
    assert.equal(footer.hidden, false);
    const loadingMore = more.dispatch('click');
    assert.equal(more.getAttribute('aria-disabled'), 'true');
    await more.dispatch('click');
    assert.equal(page.calls.filter(call => call.path === olderPath).length, 1);
    await page.openScope('favorites');
    assert.equal(footer.hidden, true);
    held.finish(reply({body: {items: [older], cursor: null}}));
    await loadingMore;
    assert.deepEqual(artifactRows(list).map(row => row.dataset.artifactId), [saved.id]);
  } finally { page.close(); }
});

test('pagination retry keeps current rows and rebuilds the expanded range if its activity version moved', async () => {
  const first = {id: 'a'.repeat(32), kind: 'document', title: '先加载的作品'};
  const older = {id: 'b'.repeat(32), kind: 'document', title: '追加的作品'};
  const inserted = {id: 'c'.repeat(32), kind: 'document', title: '后来更新的作品'};
  const base = '/v1/workspaces/w1/artifacts?order=recent';
  const olderPath = base + '&cursor=' + first.id;
  const expanded = base + '&limit=40';
  const before = 'a'.repeat(64);
  const after = 'b'.repeat(64);
  let attempts = 0;
  const page = await openArtifactsPage({native: true, extraRequest(path) {
    if (path === base) return reply({body: {items: [first], cursor: first.id, activity_version: before}});
    if (path === olderPath) {
      if (++attempts === 1) return reply({status: 503});
      return reply({body: {items: [older], cursor: null, activity_version: after}});
    }
    if (path === expanded) return reply({body: {items: [inserted, first, older], cursor: null, activity_version: after}});
  }});
  try {
    const ids = () => artifactRows(page.elements.get('artifact-list')).map(row => row.dataset.artifactId);
    const more = page.elements.get('more-artifacts');
    await more.dispatch('click');
    assert.deepEqual(ids(), [first.id]);
    assert.equal(more.textContent, '重试加载更多');
    await more.dispatch('click');
    assert.deepEqual(ids(), [inserted.id, first.id, older.id]);
    assert.equal(page.calls.filter(call => call.path === expanded).length, 1);
    assert.equal(page.elements.get('artifact-pagination').hidden, true);
  } finally { page.close(); }
});

test('an older workspace list cannot overwrite the current selected workspace', async () => {
  const {doc, elements} = fakeDocument();
  const saved = globalThis.document;
  globalThis.document = doc;
  let finishOld, announce;
  const firstStarted = new Promise(resolve => {announce=resolve;});
  const old = new Promise(resolve => {finishOld=resolve;});
  const fetcher = async path => {
    if (path === '/v1/auth/session') return reply({body:{user:{id:'u1',username:'alice'}}});
    if (path === '/v1/workspaces?limit=100') return reply({body:{items:[{id:'w1',name:'Old'}, {id:'w2',name:'New'}]}});
    if (path === '/v1/workspaces/w1/artifacts') { announce(); return old; }
    if (path === '/v1/workspaces/w2/artifacts') return reply({body:{items:[{id:'new',kind:'document',title:'New workspace document'}]}});
    throw new Error(path);
  };
  try {
    const mounted = mount(doc, {fetcher});
    await firstStarted;
    const picker = elements.get('workspace'); picker.value = 'w2';
    await picker.dispatch('change');
    await new Promise(resolve=>setImmediate(resolve));
    finishOld(reply({body:{items:[]}}));
    await mounted;
    assert.equal(elements.get('artifact-list').hidden, false);
    assert.equal(artifactRows(elements.get('artifact-list')).length, 1);
    assert.equal(artifactRows(elements.get('artifact-list'))[0].children[0].textContent, 'New workspace document');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document=saved; }
});


test('saved result deep links require an exact authorized workspace and artifact id pair', async () => {
  const {artifactTargetFromSearch}=await import('../flybot_workspace/static/artifacts/app.mjs');
  const wid='a'.repeat(32),aid='b'.repeat(32);
  assert.deepEqual(artifactTargetFromSearch('?workspace='+wid+'&artifact='+aid),{workspace:wid,artifact:aid});
  assert.deepEqual(artifactTargetFromSearch('?workspace='+wid+'&artifact='+aid+'&revision=12'),{workspace:wid,artifact:aid,revision:12});
  assert.deepEqual(artifactTargetFromSearch('?workspace='+wid),{workspace:wid});
  assert.equal(artifactTargetFromSearch('?new=document'),null);
  for(const query of ['?artifact='+aid,'?workspace='+wid+'&artifact=','?workspace='+wid+'&workspace='+wid,'?workspace=../private&artifact='+aid,'?workspace='+wid+'&artifact='+aid+'&artifact='+aid,'?workspace='+wid+'&artifact='+aid+'&new=document','?workspace='+wid+'&artifact='+aid+'&x=1'])assert.deepEqual(artifactTargetFromSearch(query),{invalid:true});
  for(const revision of ['0','-1','01','+1','1.2','100000000','1&revision=2']) {
    assert.deepEqual(artifactTargetFromSearch('?workspace='+wid+'&artifact='+aid+'&revision='+revision),{invalid:true});
  }
  assert.deepEqual(artifactTargetFromSearch('?workspace='+wid+'&revision=1'),{invalid:true});
});

const linkedWorkspace = 'a'.repeat(32);
const linkedArtifact = 'b'.repeat(32);
const linkedCatalog = `/v1/workspaces/${linkedWorkspace}/artifacts`;
const linkedDetail = linkedCatalog + '/' + linkedArtifact;
const linkedSearch = `?workspace=${linkedWorkspace}&artifact=${linkedArtifact}`;
const linkedRecord = {id: linkedArtifact, workspace_id: linkedWorkspace, title: '资料直链', body: '原始内容',
  kind: 'document', revision: 1, created_by: 'alice'};
const nextTask = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let finish;
  return {promise: new Promise(resolve => { finish = resolve; }), finish: value => finish(value)};
}

function linkFixture(respond, search = linkedSearch, {native = false} = {}) {
  const page = fakeDocument();
  if (native) {
    page.doc.querySelector = selector => selector === 'meta[name="flybot-workspace-served-by"][content="ds-bot"]' ? {} : null;
    const dialog = page.doc.getElementById('duplicate-artifact-dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    page.doc.getElementById('duplicate-artifact-title').select = () => {};
  }
  page.form.hidden = true;
  const view = new FakeNode();
  const initial = new URL('/space'+search, 'https://example.test');
  view.location = {search:initial.search, hash:initial.hash, pathname:initial.pathname};
  view.history = {
    replaceState(_state, _title, relative) {
      const url = new URL(relative, 'https://example.test');
      view.location = {search: url.search, hash: url.hash, pathname: url.pathname};
    },
  };
  page.doc.defaultView = view;
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push({path, method: options.method, signal: options.signal, body: options.body, headers: options.headers});
    const result = respond(path, options);
    if (result) return result;
    if (path === '/v1/auth/session') return reply({body: {user: {id: 'u1', username: 'alice'}}});
    if (path === '/v1/workspaces?limit=100') {
      return reply({body: {items: [{id: linkedWorkspace, name: '本工作区'}, {id: 'w2', name: '其他工作区'}]}});
    }
    if (path === '/v1/workspaces?scope=personal') return reply({body: {items: []}});
    if (path === linkedDetail) return reply({body: {artifact: linkedRecord}});
    throw new Error(path);
  };
  return {...page, view, calls, mounted: mount(page.doc, {fetcher})};
}

test('Space opens a verified team document before the unrelated personal directory arrives', async () => {
  const session = deferred();
  const teams = deferred();
  const local = deferred();
  const personal = 'c'.repeat(32);
  const page = linkFixture(path => {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/workspaces?limit=100') return teams.promise;
    if (path === '/v1/workspaces?scope=personal') return local.promise;
    if (path === linkedCatalog + '?order=recent') return reply({body: {items: [linkedRecord]}});
  }, linkedSearch, {native:true});
  await nextTask();
  assert.ok(page.calls.some(call => call.path === '/v1/workspaces?limit=100'));
  assert.ok(page.calls.some(call => call.path === '/v1/workspaces?scope=personal'));
  assert.equal(page.calls.some(call => call.path === linkedDetail), false);
  teams.finish(reply({body: {items: [{id: linkedWorkspace, name: '团队空间'}]}}));
  await nextTask();
  assert.equal(page.calls.some(call => call.path === linkedDetail), false);
  session.finish(reply({body: {user: {id:'u1', username:'alice'}}}));
  await page.mounted;
  assert.equal(page.form.hidden, false);
  assert.equal(page.calls.filter(call => call.path === linkedDetail).length, 1);
  local.finish(reply({body: {items: [{id:personal, name: '个人空间'}]}}));
  await nextTask();
  const picker = page.elements.get('workspace');
  assert.deepEqual(picker.children.map(option => option.value), [personal, linkedWorkspace]);
  assert.equal(picker.value, linkedWorkspace);
  assert.equal(page.calls.filter(call => call.path === linkedDetail).length, 1);
});

test('Space still waits for the linked workspace when the first signed directory only returns other workspaces', async () => {
  const local = deferred();
  const page = linkFixture(path => {
    if (path === '/v1/workspaces?limit=100') return reply({body: {items: [{id:'w2', name:'其他工作区'}]}});
    if (path === '/v1/workspaces?scope=personal') return local.promise;
  }, linkedSearch, {native:true});
  await nextTask();
  assert.equal(page.form.hidden, true);
  assert.equal(page.calls.some(call => call.path === linkedDetail), false);
  local.finish(reply({body: {items: [{id:linkedWorkspace, name:'个人空间'}]}}));
  await page.mounted;
  assert.equal(page.form.hidden, false);
  assert.equal(page.calls.filter(call => call.path === linkedDetail).length, 1);
});

test('Space keeps the selected workspace in its catalog address and reloads the intended catalog', async () => {
  const personal = 'c'.repeat(32);
  const respond = path => {
    if (path === '/v1/workspaces?scope=personal') return reply({body: {items:[{id:personal,name:'个人空间'}]}});
    if (path === '/v1/workspaces?limit=100') return reply({body: {items:[
      {id:personal,name:'个人空间'}, {id:linkedWorkspace,name:'团队空间'},
    ]}});
    if (path === '/v1/workspaces/'+personal+'/artifacts' || path === linkedCatalog) return reply({body: {items:[]}});
  };
  const page = linkFixture(respond,'');
  await page.mounted;
  await nextTask();
  const picker = page.elements.get('workspace');
  picker.value = linkedWorkspace;
  await picker.dispatch('change');
  assert.equal(page.view.location.hash, '#workspace='+linkedWorkspace);
  assert.equal(page.view.location.search, '');
  const restored = linkFixture(respond,page.view.location.hash);
  await restored.mounted;
  assert.equal(restored.elements.get('workspace').value,linkedWorkspace);
  assert.ok(restored.calls.some(call => call.path === linkedCatalog));
  assert.equal(restored.calls.some(call => call.path === '/v1/workspaces/'+personal+'/artifacts'),false);
});

test('Space leaves an inaccessible pinned workspace unselected before starting any catalog read', async () => {
  const page = linkFixture(() => undefined,'#workspace='+'d'.repeat(32));
  await page.mounted;
  assert.equal(page.elements.get('workspace').value,'');
  assert.match(page.elements.get('status').textContent,/无法访问此工作区/);
  assert.equal(page.elements.get('new-menu-button').disabled,true);
  assert.equal(page.calls.some(call => /\/artifacts(?:\?|$)/.test(call.path)),false);
});

test('Space uses the saved release to confirm a lost publish or withdrawal receipt', async () => {
  const saved = {...linkedRecord,revision:2};
  const path = linkedDetail+'/discover';
  const slug = 'public-work';
  let listing = {listed:true,slug,published_revision:1};
  const page = linkFixture((requested,options) => {
    if (requested === linkedDetail) return reply({body:{artifact:saved}});
    if (requested === linkedCatalog+'?order=recent') return reply({body:{items:[saved]}});
    if (requested === path && options.method === 'GET') return reply({body:{discover:listing}});
    if (requested === path && options.method === 'POST') return reply({status:503});
    if (requested === path+'/revoke' && options.method === 'POST') {
      listing = {listed:false};
      return reply({status:503});
    }
  },linkedSearch,{native:true});
  await page.mounted;
  const el = id => page.elements.get(id);
  const discover = el('discover-panel');
  discover.open = true;
  await discover.dispatch('toggle');
  await nextTask();
  assert.equal(el('discover-slug').value,slug);

  await el('publish-discover').dispatch('click');
  assert.match(el('discover-status').textContent,/当前公开状态与本次发布请求不一致/);
  assert.match(el('discover-revision').textContent,/公开修订 1 · 当前保存的修订 2/);
  assert.equal(el('discover-public-link').href,'/w/'+slug);

  listing = {...listing,published_revision:2};
  await el('publish-discover').dispatch('click');
  assert.equal(el('discover-status').textContent,'已公开到发现页。');
  assert.equal(el('discover-revision').textContent,'发现页公开修订 2。');
  await el('revoke-discover').dispatch('click');
  assert.equal(el('discover-status').textContent,'已从发现页撤回。');
  assert.equal(el('discover-public-link').hidden,true);
  assert.deepEqual(page.calls.filter(call => call.path.startsWith(path)).map(call => [call.method,call.path]),[
    ['GET',path], ['POST',path], ['GET',path], ['POST',path], ['GET',path], ['POST',path+'/revoke'], ['GET',path],
  ]);
});

test('copying a historic version recovers a lost receipt without discarding an unsaved Space draft', async () => {
  const copy = {...linkedRecord,id:'c'.repeat(32),title:'历史副本',body:'第一版内容'};
  const saved = {...linkedRecord,revision:2,body:'第二版内容'};
  let writes = 0;
  const page = linkFixture((path,options) => {
    if (path === linkedDetail) return reply({body:{artifact:saved}});
    if (path === linkedCatalog+'?order=recent') return reply({body:{items:[saved]}});
    if (path === linkedDetail+'/versions') return reply({body:{items:[{revision:2,title:saved.title},{revision:1,title:'第一版'}]}});
    if (path === linkedCatalog && options.method === 'POST') {
      if (++writes === 1) return Promise.reject(new Error('simulated lost response'));
      return reply({body:{artifact:copy}});
    }
  },linkedSearch,{native:true});
  await page.mounted;
  page.form.elements.body.value = '继续编辑的未保存草稿';
  const versions = page.elements.get('version-panel');
  versions.open = true;
  await versions.dispatch('toggle');
  await nextTask();
  const historical = page.elements.get('version-list').children[1];
  await historical.children.find(node => node.textContent === '复制为新作品').dispatch('click');
  const dialog = page.elements.get('duplicate-artifact-dialog');
  const form = page.elements.get('duplicate-artifact-form');
  assert.equal(dialog.open,true);
  page.elements.get('duplicate-artifact-title').value = copy.title;
  await form.dispatch('submit');
  assert.equal(page.elements.get('duplicate-artifact-submit').textContent,'重试');
  await form.dispatch('submit');
  const posts = page.calls.filter(call => call.path === linkedCatalog && call.method === 'POST');
  assert.equal(posts.length,2);
  assert.ok(posts[0].headers['Idempotency-Key']);
  assert.equal(posts[0].headers['Idempotency-Key'],posts[1].headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(posts[1].body),{title:copy.title,duplicate_from:{artifact_id:linkedArtifact,revision:1}});
  assert.equal(dialog.open,true);
  assert.equal(page.form.elements.body.value,'继续编辑的未保存草稿');
  page.view.confirm = () => false;
  await form.dispatch('submit');
  assert.equal(dialog.open,true);
  assert.equal(page.form.elements.body.value,'继续编辑的未保存草稿');
  page.view.confirm = () => true;
  await form.dispatch('submit');
  assert.equal(dialog.open,false);
  assert.equal(page.form.elements.body.value,copy.body);
  assert.equal(page.form.elements.title.value,copy.title);
  assert.equal(page.calls.some(call => call.method === 'GET' && call.path === linkedCatalog+'/'+copy.id),false);
});

test('an authorized direct link opens editable content with the catalog and optional panels held', async () => {
  const session = deferred();
  const choices = deferred();
  const directory = deferred();
  const versions = deferred();
  const page = linkFixture(path => ({
    '/v1/auth/session': session.promise,
    '/v1/workspaces?limit=100': choices.promise,
    [linkedCatalog]: directory.promise,
    [linkedDetail + '/versions']: versions.promise,
  })[path]);
  assert.deepEqual(page.calls.map(call => call.path), ['/v1/auth/session']);
  session.finish(reply({body: {user: {id: 'u1', username: 'alice'}}}));
  await nextTask();
  assert.equal(page.calls.some(call => call.path.startsWith(linkedCatalog)), false);
  choices.finish(reply({body: {items: [{id: linkedWorkspace, name: '本工作区'}]}}));
  await page.mounted;
  assert.deepEqual(page.calls.filter(call => call.path.startsWith(linkedCatalog)).map(call => call.path),
    [linkedDetail, linkedCatalog]);
  assert.equal(page.elements.get('list-panel').hidden, true);
  assert.equal(page.form.hidden, false);
  assert.equal(page.form.elements.body.value, linkedRecord.body);
  const version = page.elements.get('version-panel');
  assert.equal(version.open, false);
  version.open = true;
  await version.dispatch('toggle');
  assert.equal(page.calls.at(-1).path, linkedDetail + '/versions');
  page.form.elements.body.value = '持续写入的草稿';
  versions.finish(reply({body: {items: [{revision: 1, title: '资料直链'}]}}));
  await nextTask();
  assert.equal(page.form.elements.body.value, '持续写入的草稿');
  assert.equal(page.elements.get('version-list').children[0].children[1].href,
    linkedDetail + '/versions/1/export');
  page.view.confirm = () => false;
  await page.elements.get('cancel-editor').dispatch('click');
  assert.equal(page.view.location.search, linkedSearch);
  assert.equal(page.form.elements.body.value, '持续写入的草稿');
  page.view.confirm = () => true;
  await page.elements.get('cancel-editor').dispatch('click');
  assert.equal(page.view.location.search, '');
  assert.equal(page.elements.get('list-panel').hidden, false);
  assert.equal(page.calls.filter(call => call.path === linkedCatalog).length, 1);
  directory.finish(reply({body: {items: [linkedRecord]}}));
  await nextTask();
  assert.equal(artifactRows(page.elements.get('artifact-list')).length, 1);
});

test('Space opens a saved Markdown table in the document editor without changing its source', async () => {
  const markdown = '原始内容\n\n| 事项 |  进展 |\n| :--- | ---: |\n| **初稿** | 待核对 |';
  const page = linkFixture(path => {
    if (path === linkedDetail) return reply({body:{artifact:{...linkedRecord,body:markdown}}});
    if (path === linkedCatalog) return reply({body:{items:[]}});
  });
  await page.mounted;
  const rich = page.elements.get('document-rich');
  const table = rich.children.find(child => child.className === 'chat-markdown-table-scroll').children[0];
  const [head, body] = table.children;
  assert.equal(table.tagName,'TABLE');
  assert.equal(head.children[0].children[1].getAttribute('data-align'),'right');
  assert.equal(body.children[0].children[0].children[0].tagName,'STRONG');
  assert.equal(page.form.elements.body.value,markdown);
  await page.elements.get('document-source-toggle').dispatch('click');
  assert.equal(page.elements.get('document-source').value,markdown);
});

test('Space follows a saved revision while idle and keeps an edit typed during the next read', async () => {
  const activityPath = linkedCatalog + '/activity?artifact=' + linkedArtifact;
  const stale = {...linkedRecord, revision: 2, body: '另一会话已保存'};
  const newer = {...linkedRecord, revision: 3, body: '更新的服务器内容'};
  const pending = deferred();
  const requested = deferred();
  let remote = linkedRecord;
  const page = linkFixture((path, options) => {
    if (path === linkedCatalog) return reply({body: {items: []}});
    if (path === activityPath) return reply({body: {version: String(remote.revision).repeat(64), revision: remote.revision}});
    if (path === linkedDetail && options.method === 'POST') {
      return reply({status: 409, body: {error: {code: 'conflict', current: remote}}});
    }
    if (path === linkedDetail && remote === newer) {
      requested.finish();
      return pending.promise;
    }
    if (path === linkedDetail) return reply({body: {artifact: remote}});
  });
  await page.mounted;
  const retry = page.elements.get('workspace-events-retry');
  remote = stale;
  await retry.dispatch('click');
  assert.equal(page.form.elements.body.value, stale.body);
  assert.equal(page.elements.get('artifact-live-update').hidden, true);

  remote = newer;
  const checking = retry.dispatch('click');
  await requested.promise;
  page.form.elements.body.value = '本地未保存内容';
  pending.finish(reply({body: {artifact: remote}}));
  await checking;
  assert.equal(page.form.elements.body.value, '本地未保存内容');
  assert.equal(page.elements.get('artifact-live-update').hidden, false);
  assert.equal(page.elements.get('artifact-live-compare').href, '/space' + linkedSearch);

  const reads = page.calls.filter(call => call.path === linkedDetail && call.method === 'GET').length;
  await retry.dispatch('click');
  assert.equal(page.calls.filter(call => call.path === linkedDetail && call.method === 'GET').length, reads);
  await page.form.dispatch('submit');
  const saved = page.calls.find(call => call.path === linkedDetail && call.method === 'POST');
  assert.equal(JSON.parse(saved.body).revision, stale.revision);
  assert.match(page.elements.get('status').textContent, /保存遇到新版本/);
  assert.equal(page.form.elements.body.value, '本地未保存内容');
});

test('an unauthorized direct link reports its error while the authorized catalog is pending', async () => {
  const directory = deferred();
  const page = linkFixture(path => {
    if (path === '/v1/workspaces?limit=100') return reply({body: {items: [{id: 'w2', name: '其他工作区'}]}});
    if (path === '/v1/workspaces/w2/artifacts') return directory.promise;
  });
  await page.mounted;
  assert.equal(page.calls.filter(call => call.path.includes(linkedArtifact)).length, 0);
  assert.equal(page.form.hidden, true);
  assert.equal(page.elements.get('status').textContent, '文档链接无效，或你没有访问该工作区的权限。');
  directory.finish(reply({status: 503}));
  await nextTask();
  assert.equal(page.elements.get('retry-artifact-list').hidden, false);
  assert.equal(page.elements.get('status').textContent, '文档链接无效，或你没有访问该工作区的权限。');
});

test('late direct detail and catalog replies cannot restore the previous workspace after a switch', async () => {
  const earlierDetail = deferred();
  const earlierCatalog = deferred();
  const page = linkFixture(path => {
    if (path === linkedDetail) return earlierDetail.promise;
    if (path === linkedCatalog) return earlierCatalog.promise;
    if (path === '/v1/workspaces/w2/artifacts') {
      return reply({body: {items: [{id: 'new', title: '第二个工作区', kind: 'document'}]}});
    }
  });
  await nextTask();
  const firstDetail = page.calls.find(call => call.path === linkedDetail);
  const picker = page.elements.get('workspace');
  picker.value = 'w2';
  await picker.dispatch('change');
  await nextTask();
  assert.equal(firstDetail.signal.aborted, true);
  earlierDetail.finish(reply({status: 404}));
  earlierCatalog.finish(reply({status: 503}));
  await page.mounted;
  assert.equal(page.calls.some(call => call.path === '/v1/workspaces/w2/artifacts/' + linkedArtifact), false);
  assert.equal(page.elements.get('status').textContent, '');
  assert.equal(page.elements.get('artifact-list-status').hidden, true);
  assert.equal(page.form.hidden, true);
  assert.equal(artifactRows(page.elements.get('artifact-list'))[0].children[0].textContent, '第二个工作区');
});

test('an older save cannot replace a new draft after returning from the direct editor', async () => {
  const save = deferred();
  const page = linkFixture((path, {method}) => {
    if (path === linkedDetail && method === 'POST') return save.promise;
    if (path === linkedCatalog) return reply({body: {items: [linkedRecord]}});
  });
  await page.mounted;
  page.form.elements.body.value = '首次修改';
  const saving = page.form.dispatch('submit');
  assert.equal(page.elements.get('mobile-editor-save').disabled, true);
  assert.equal(page.elements.get('mobile-editor-save').textContent, '保存中…');
  assert.deepEqual(JSON.parse(page.calls.at(-1).body), {revision: 1, changes: {title: '资料直链', body: '首次修改'}});
  await page.elements.get('cancel-editor').dispatch('click');
  await page.elements.get('new-artifact').dispatch('click');
  page.form.elements.title.value = '另一份新文档';
  page.form.elements.body.value = '另一份草稿';
  save.finish(reply({body: {artifact: {...linkedRecord, revision: 2, body: '首次修改'}}}));
  await saving;
  assert.equal(page.form.elements.title.value, '另一份新文档');
  assert.equal(page.form.elements.body.value, '另一份草稿');
  assert.equal(page.elements.get('save-artifact').disabled, false);
  assert.equal(page.elements.get('mobile-editor-save').disabled, false);
  assert.equal(page.elements.get('mobile-editor-save').textContent, '保存');
});

test('the compact editor opens existing panels and keeps an unsaved draft when dismissing actions', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document'}]});
  try {
    await artifactRows(page.elements.get('artifact-list'))[0].children[0].dispatch('click');
    const el = id => page.elements.get(id);
    const menu = el('mobile-editor-menu');
    assert.equal(menu.hidden, false);
    assert.equal(el('mobile-editor-delete').hidden, false);
    assert.equal(el('mobile-editor-markdown').hidden, false);
    assert.equal(el('version-panel').open, false);
    assert.equal(page.calls.some(call => call.path.endsWith('/versions')), false);
    menu.open = true;
    await el('mobile-editor-version').dispatch('click');
    assert.equal(menu.open, false);
    assert.equal(el('version-panel').open, true);
    await el('version-panel').dispatch('toggle');
    assert.equal(page.calls.at(-1).path, '/v1/workspaces/w1/artifacts/a1/versions');

    page.form.elements.body.value = '未保存的正文';
    menu.open = true;
    const deleting = el('mobile-editor-delete').dispatch('click');
    const [confirmation] = page.alertdialog();
    assert.ok(confirmation);
    await page.doc.dispatch('keydown', {key: 'Escape'});
    await deleting;
    assert.equal(page.removeCalls().length, 0);
    assert.equal(page.form.elements.body.value, '未保存的正文');
    assert.equal(page.doc.activeElement, el('mobile-editor-delete'));

    await menu.dispatch('keydown', {key: 'Escape'});
    assert.equal(menu.open, false);
    assert.equal(page.doc.activeElement, el('mobile-editor-more'));
    page.doc.defaultView = {confirm: () => true};
    await el('cancel-editor-load').dispatch('click');
    assert.equal(el('list-panel').hidden, false);
    assert.equal(page.doc.activeElement, el('new-menu-button'));
    await el('new-artifact').dispatch('click');
    assert.equal(el('mobile-editor-delete').hidden, true);
    assert.equal(el('mobile-editor-version').hidden, true);
  } finally {
    page.close();
  }
});

test('wrapping editor titles stay on one stored line and respect IME Enter', async () => {
  const page = await openArtifactsPage();
  try {
    await page.elements.get('new-artifact').dispatch('click');
    const title = page.form.elements.title;
    title.value = '开头\n\n下半段';
    await title.dispatch('input');
    assert.equal(title.value, '开头 下半段');
    let prevented = false;
    let submissions = 0;
    page.form.requestSubmit = () => { submissions++; };
    const preventDefault = () => { prevented = true; };
    await title.dispatch('keydown', {key: 'Enter', isComposing: true, preventDefault});
    assert.equal(prevented, false);
    assert.equal(submissions, 0);
    await title.dispatch('keydown', {key: 'Enter', isComposing: false, preventDefault});
    assert.equal(prevented, true);
    assert.equal(submissions, 1);
  } finally {
    page.close();
  }
});

test('website helpers keep titles and escaped stubs bounded and honest', () => {
  assert.equal(websiteTitle('  给产品做介绍站  '), '网站：给产品做介绍站');
  assert.equal(websiteTitle('x'.repeat(80)).startsWith('网站：'), true);
  assert.ok(websiteTitle('x'.repeat(80)).length <= 50);
  assert.equal(websiteTitle('   '), '新网站');
  assert.match(websiteStub('<script>'), /&lt;script&gt;/);
  assert.doesNotMatch(websiteStub('<script>alert(1)</script>'), /<script>/);
  assert.equal(escapeHtml('a&b<"'), 'a&amp;b&lt;&quot;');
  assert.match(websitePrompt('站点', '需要首页和关于'), /作品标题：站点/);
  assert.match(websitePrompt('站点', '需要首页和关于'), /需要首页和关于/);
});

test('saveable messages require real text and reject retracted or unfinished rows', () => {
  assert.equal(saveableSocialMessage({body: '你好', revision: 1}), true);
  assert.equal(saveableSocialMessage({body: '  ', revision: 1}), false);
  assert.equal(saveableSocialMessage({body: '你好', retracted: 1}), false);
  assert.equal(saveableSocialMessage({body: '语音消息', revision: 1, voice: {mime: 'audio/webm'}}), false);
  assert.equal(saveableAgentMessage({body: '完成稿', status: 'succeeded'}), true);
  assert.equal(saveableAgentMessage({body: '完成稿', status: 'queued'}), false);
  assert.equal(defaultSaveTitle('  第一段内容  '), '第一段内容');
  const wid = 'a'.repeat(32), cid = 'b'.repeat(32), mid = 'c'.repeat(32), aid = 'd'.repeat(32);
  assert.equal(
    socialSavePath(wid, cid, mid),
    `/v1/workspaces/${wid}/social/conversations/${cid}/messages/${mid}/save`,
  );
  assert.equal(
    agentSavePath(wid, aid, cid, mid),
    `/v1/workspaces/${wid}/agents/${aid}/conversations/${cid}/messages/${mid}/artifact`,
  );
});

test('deep links point at existing space and chat routes, not invented pages', () => {
  const wid = 'a'.repeat(32), id = 'b'.repeat(32), aid = 'c'.repeat(32);
  assert.equal(spaceHref(), '/space');
  assert.equal(spaceHref(wid), '/space?workspace=' + wid);
  assert.equal(spaceHref(wid, id), '/space?workspace=' + wid + '&artifact=' + id);
  assert.equal(conversationChatHref(wid, {source: 'social', id}), '/chat#workspace=' + wid + '&social=' + id);
  assert.equal(
    conversationChatHref(wid, {source: 'agent', id, agent_id: aid}),
    '/chat#workspace=' + wid + '&agent=' + aid + '&conversation=' + id,
  );
});

test('website dispatch copy distinguishes queued work from a missing runtime', () => {
  assert.match(describeWebsiteDispatch({status: 'queued', task_id: 't1'}), /发出搭建请求/);
  assert.match(describeWebsiteDispatch({status: 'queued', error_code: 'no_agent'}), /没有在线运行时/);
  assert.match(describeWebsiteDispatch({error_code: 'quota'}), /quota/);
  assert.match(describeWebsiteDispatch(null), /未能发出搭建请求/);
});

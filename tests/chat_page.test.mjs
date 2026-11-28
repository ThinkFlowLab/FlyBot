import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeSessions, SEARCH_TABS, initial, chatIdentity, applyChatIdentity, composeSelectedLabel, filterMemberChoices, composeCreateEnabled, composeGroupPayload, GROUP_CREATE_INTRO, GROUP_CREATE_MODES, mount, messageSearchQuery, wrapBold, inlineBold, dueReminders, reminderDueLabel } from '../flybot_workspace/static/chat/app.mjs';

import {consumePublicAgentOpening, publicAgentIntentFromHash, publicAgentContinuation, publicAgentOpening, stagePublicAgentOpening} from '../flybot_workspace/static/shell/public-agent-link.mjs';
import {mountPublicAgentComposer} from '../flybot_workspace/static/shell/public-agent-composer.mjs';
import {mountPublicDraft} from '../flybot_workspace/static/chat/public-draft.mjs';
import {mountChatFiles} from '../flybot_workspace/static/chat/files.mjs';
import {mountChatApprovalNotice} from '../flybot_workspace/static/chat/activity.mjs';
import {mountWorkspaceInvite} from '../flybot_workspace/static/chat/workspace-invite.mjs';
import {mountMessageUtilities} from '../flybot_workspace/static/chat/utilities.mjs';
import {readMarkdownTable, renderMarkdownTable} from '../flybot_workspace/static/shell/markdown-table.mjs';
import {countMentionedGroupMembers} from '../flybot_workspace/static/chat/mentions.mjs';
import {pendingSignupSession, readChatDraftMentions, readChatDrafts, readPendingChatText, rememberSignupSession,
  savePendingChatText, writeChatDraftMentions, writeChatDrafts} from '../flybot_workspace/static/home/runtime-readiness.mjs';
import {agentDirectoryHref, directAgentAccessHref, directAgentAccessFromHash} from '../flybot_workspace/static/shell/chat-utils.mjs';

test('the account approval notice only reads for a current private reply and ignores an old view', async () => {
  const notice = {hidden: true};
  const calls = [];
  const approvalNotice = mountChatApprovalNotice({getElementById: () => notice}, {
    request(method, path, body, extra, signal) {
      return new Promise(resolve => calls.push({method, path, signal, resolve}));
    },
  });
  assert.equal(calls.length, 0);
  let active = true;
  const first = approvalNotice.start(() => active);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/composio/approvals?view=pending');
  active = false;
  const next = approvalNotice.start(() => true);
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve({status: 200, body: {pending: true}});
  await first;
  assert.equal(notice.hidden, true);
  calls[1].resolve({status: 200, body: {pending: true}});
  await next;
  assert.equal(notice.hidden, false);
  approvalNotice.stop();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(notice.hidden, true);
});

test('Agent directory links preserve the native workspace and optional exact agent', () => {
  const workspace = 'a'.repeat(32);
  const agent = 'b'.repeat(32);
  assert.equal(agentDirectoryHref(workspace, agent), `/agents#workspace=${workspace}&agent=${agent}`);
  assert.equal(agentDirectoryHref(workspace, 'invalid'), `/agents#workspace=${workspace}`);
  assert.equal(agentDirectoryHref('invalid', agent), '/agents');
});

test('group mention feedback counts only eligible human members addressed outside literal text', () => {
  const members = [
    {user_id:'self', handle:'sender.home'},
    {user_id:'one', handle:'reviewer.home'},
    {user_id:'two', handle:'teammate.home'},
    {user_id:'three', handle:'suspended.home', suspended:true},
  ];
  const draft = '＠Reviewer.home @reviewer.home @sender.home @suspended.home @reviewer.home.other\n' +
    '```text\n@teammate.home\n``` 和 [提示 @teammate.home](/guide)';
  assert.equal(countMentionedGroupMembers(draft, {members, viewerId:'self'}), 1);
  assert.equal(countMentionedGroupMembers(draft, {members, viewerId:'self', direct:true}), 0);
});

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('initial uses the first letter or digit and skips leading punctuation', () => {
  assert.equal(initial('Helper'), 'H');
  assert.equal(initial('产品群'), '产');
  assert.equal(initial('[CI FIXTURE] Directory assistant'), 'C');
  assert.equal(initial('...'), '?');
  assert.equal(initial(''), '?');
});

test('chatIdentity shows a letter avatar only for a real conversation title', () => {
  assert.deepEqual(chatIdentity('Directory assistant'), {
    title: 'Directory assistant', initial: 'D', showAvatar: true,
  });
  assert.deepEqual(chatIdentity('  '), {title: '聊天', initial: '', showAvatar: false});
  assert.deepEqual(chatIdentity('聊天'), {title: '聊天', initial: '', showAvatar: false});
  const document = {
    nodes: {
      'chat-title': {textContent: ''},
      'chat-avatar': {textContent: '', hidden: true},
    },
    getElementById(id) { return this.nodes[id]; },
  };
  applyChatIdentity(document, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-title'].textContent, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-avatar'].textContent, 'C');
  assert.equal(document.nodes['chat-avatar'].hidden, false);
  applyChatIdentity(document, '聊天');
  assert.equal(document.nodes['chat-avatar'].hidden, true);
  assert.equal(document.nodes['chat-avatar'].textContent, '');
});

test('SEARCH_TABS lists the recorded search scopes', () => {
  assert.deepEqual(SEARCH_TABS.map((entry) => entry[1]), [
    '全部', '作品', '记忆', '联系人', '群组', '智能体', '消息', '文件', '云文档', '媒体', '链接',
  ]);
});

test('mergeSessions combines agent and social rows without inventing pins', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.source, row.id, row.title]), [
    ['social', 's1', 'bob'],
    ['social', 's2', '产品群'],
    ['agent', 'c1', 'Helper'],
  ]);
  assert.equal(sessions.every((row) => !row.pinned), true);
  assert.deepEqual(sessions.map((row) => row.preview), [
    '单聊 · 2 人',
    '群聊 · 2 人',
    'Old thread',
  ]);
});

test('mergeSessions prefers a last-message preview from the listing', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', preview: 'Latest assistant reply', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', preview: '你好 Alice', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', preview: '', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.id, row.preview]), [
    ['s1', '你好 Alice'],
    ['s2', '群聊 · 2 人'],
    ['c1', 'Latest assistant reply'],
  ]);
});

test('mergeSessions keeps archived private threads out of the inbox and named threads distinct from their previews', () => {
  const agent = {id: 'ag', name: 'Helper'};
  const sessions = mergeSessions([
    {id: 'archived', agent, title: 'Archived', title_edited: true, archived: true},
    {id: 'renamed', agent, title: 'Quarterly review', title_edited: true, preview: 'Latest assistant reply', updated: 30},
    {id: 'duplicated', agent, title: 'Project notes', title_edited: true, preview: 'Project notes', updated: 20},
    {id: 'legacy', agent, title: 'Old thread', title_edited: false, updated: 10},
  ], [], alice);
  assert.deepEqual(sessions.map(row => [row.id, row.title, row.preview]), [
    ['renamed', 'Quarterly review', 'Latest assistant reply'],
    ['duplicated', 'Project notes', 'Helper'],
    ['legacy', 'Helper', 'Old thread'],
  ]);
});


test('messageSearchQuery adds only an explicit conversation scope and encodes keywords', async () => {
  const {messageSearchQuery} = await import('../flybot_workspace/static/chat/app.mjs');
  const global = new URLSearchParams(messageSearchQuery('budget & 预算'));
  assert.equal(global.get('q'), 'budget & 预算');
  assert.equal(global.has('conversation_id'), false);
  const scoped = new URLSearchParams(messageSearchQuery('budget & 预算', 'a'.repeat(32)));
  assert.equal(scoped.get('conversation_id'), 'a'.repeat(32));
  assert.deepEqual([...scoped.keys()].sort(), ['conversation_id', 'limit', 'q']);
});


function keyEvent(overrides) {
  return {
    key: 'Enter',
    isComposing: false,
    keyCode: 13,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

test('shouldSendOnShortcut honors enter and Ctrl/Cmd+Enter bindings and ignores IME', async () => {
  const {shouldSendOnShortcut} = await import('../flybot_workspace/static/chat/app.mjs');
  assert.equal(shouldSendOnShortcut(keyEvent(), 'enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({shiftKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({altKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({key: 'a'}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({isComposing: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({keyCode: 229}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true, shiftKey: true}), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'unknown'), true);
  assert.equal(shouldSendOnShortcut(null, 'enter'), false);
});

test('composeSelectedLabel reports the recorded selected count', () => {
  assert.equal(composeSelectedLabel(0), '已选 0');
  assert.equal(composeSelectedLabel(2), '已选 2');
});

test('filterMemberChoices matches usernames without inventing members', () => {
  const members = [
    {user_id: alice, username: 'alice'},
    {user_id: bob, username: 'bob'},
  ];
  assert.deepEqual(filterMemberChoices(members, alice, '').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'BO').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'zzz'), []);
});

test('composeCreateEnabled stays off until a custom-group selection exists', () => {
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 3}), false);
  assert.equal(composeCreateEnabled({composeMode: 'contact', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'contact', selectedCount: 0}), false);
});

test('composeGroupPayload omits a blank title so the existing API can default it', () => {
  assert.deepEqual(composeGroupPayload([bob], '  产品群  '), {
    kind: 'group', member_ids: [bob], title: '产品群',
  });
  assert.deepEqual(composeGroupPayload([bob], '   '), {kind: 'group', member_ids: [bob]});
});

test('group create chrome keeps the recorded labels and no billing copy', () => {
  assert.equal(GROUP_CREATE_INTRO, '选择联系人或智能体加入群组。');
  assert.deepEqual(GROUP_CREATE_MODES, [
    ['custom', '自定义群组'],
    ['team', 'AI 智能体团队'],
  ]);
});

import {groupPickerChoices, groupAgentSummary} from '../flybot_workspace/static/chat/app.mjs';

test('group picker distinguishes stored agents and people; contact picker omits agents', () => {
  const humans = [{user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}];
  const agents = [{id: 'helper', name: 'Helper'}, {id: 'old', name: 'Archived', archived: 1}];
  const choices = groupPickerChoices(humans, alice, agents);
  assert.deepEqual(choices.map(row => [row.id, row.kind]), [[bob, 'human'], ['helper', 'agent']]);
  assert.ok(choices[1].label.includes('AI 智能体'));
  assert.deepEqual(groupPickerChoices(humans, alice).map(row => row.id), [bob]);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 1, selectedHumanCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', personal:true, selectedCount: 1, selectedHumanCount: 0, selectedAgentCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 2, selectedHumanCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 2, selectedHumanCount: 1}), false);
  assert.deepEqual(composeGroupPayload([bob], '', ['helper']), {
    kind: 'group', member_ids: [bob], agent_ids: ['helper'],
  });
  assert.equal(groupAgentSummary({agent_members: []}), '');
  assert.match(groupAgentSummary({agent_members: [{name: 'Helper'}]}), /Helper。用 @ 指定智能体/);
});

import {groupReplyStatus} from '../flybot_workspace/static/chat/app.mjs';
test('explicit group reply statuses distinguish pending, success and fixed errors', () => {
  assert.equal(groupReplyStatus({status: 'queued'}), '等待执行');
  assert.equal(groupReplyStatus({status: 'running'}), '执行中');
  assert.equal(groupReplyStatus({status: 'succeeded'}), '已完成');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'no_agent'}), '失败：没有可用运行时连接');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'timeout'}), '失败：执行超时');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'private diagnostic'}), '失败：请求失败');
});

test('the chat empty state opens Agents and Discover', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="chat-empty"');
  assert.ok(start > -1, 'the chat page has an empty state');
  const block = html.slice(start, html.indexOf('id="message-list"', start));
  assert.match(block, /<a href="\/agents"[^>]*>浏览智能体<\/a>/);
  assert.match(block, /<a href="\/discover"[^>]*>发现<\/a>/);
  assert.doesNotMatch(block, /<button[^>]*>帮助中心/, 'the next steps are links, not disabled buttons');
});

// These tests drive the real mount() with a stubbed two-page fetch, importing
// only symbols that exist on main today. On main the first page renders its 20
// hits and offers no way to reach the cursor page the server returned, and the
// query builder drops a cursor it is handed, so the assertions below fail as
// user-visible behaviour rather than as a missing export.

class FakeElement {
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
    this.name = '';
    this.href = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get textContent() {
    return this.text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this.replaceChildren();
    this.text = String(value);
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!names().includes(name)) element.className = [...names(), name].join(' ');
      },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
      toggle(name, force = !this.contains(name)) {
        if (force) this.add(name);
        else this.remove(name);
        return force;
      },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, before) {
    node.parent = this;
    this.children.splice(this.children.indexOf(before), 0, node);
    return node;
  }
  after(...nodes) {
    const parent = this.parent;
    if (!parent) return;
    const next = parent.children[parent.children.indexOf(this) + 1];
    if (next) for (const node of nodes) parent.insertBefore(node, next);
    else parent.append(...nodes);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  dispatchEvent(event) {
    for (const listener of this.handlers[event.type] || []) listener(event);
    return true;
  }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter((item) => item !== handler);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  getBoundingClientRect() { return {top: 0, bottom: 0}; }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    if (selector === 'input:not(:disabled)') {
      return descendants(this).find((node) => node.tagName === 'INPUT' && !node.disabled) || null;
    }
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) { return descendants(this).filter(node => matchesSelector(node, selector)); }
}

function descendants(node) {
  const rows = [];
  for (const child of node.children) rows.push(child, ...descendants(child));
  return rows;
}

function matchesSelector(node, selector) {
  if (!node || !selector) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = /^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    const value = attr[3];
    const actual = attr[2].startsWith('data-')
      ? node.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      : node.attributes[attr[2]];
    if (value === undefined) return actual !== undefined && actual !== null && actual !== '';
    return actual === value;
  }
  return node.tagName === selector.toUpperCase();
}

// Ids, initial hidden state, labels and search tabs come from the served page,
// so the harness cannot invent a control the user would not have.
function fakeChatDocument(html) {
  const byId = new Map();
  const tabs = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (id) {
      const element = new FakeElement(tag);
      element.id = id[1];
      element.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      element.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
      byId.set(id[1], element);
    }
    const tab = /\bdata-search-tab="([^"]+)"/.exec(attrs);
    if (tab) {
      const element = new FakeElement('button');
      element.dataset.searchTab = tab[1];
      tabs.push(element);
    }
  }
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)<\/\1>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[2]);
    const label = match[3].trim();
    if (id && label && byId.has(id[1])) byId.get(id[1]).textContent = label;
  }
  const body = new FakeElement('body');
  const doc = {
    cookie: '',
    body,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '#search-panel [data-search-tab]') return tabs;
      return [];
    },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function json(status, body) { return {status, json: async () => body}; }

function searchHit(index) {
  const padded = String(index).padStart(2, '0');
  return {
    kind: 'agent',
    conversation_id: 'cv-' + padded,
    message_id: 'm-' + padded,
    title: '对话 ' + index,
    snippet: '片段 ' + index,
  };
}

function messagePage(start, count, cursor) {
  const items = [];
  for (let index = start; index < start + count; index += 1) items.push(searchHit(index));
  return {items, cursor};
}

function chatFetcher({failNext = false} = {}) {
  const requests = [];
  // Page two repeats the last hit of page one, so appending must not show it twice.
  const pages = [messagePage(1, 20, 'cursor-1'), messagePage(20, 20, '')];
  const fetcher = async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path.startsWith('/v1/workspaces/ws-1/search/messages?')) {
      if (failNext && /[?&]cursor=/.test(path)) throw new Error('无法加载更多。');
      const page = pages.shift();
      if (!page) throw new Error('unexpected search page: ' + path);
      return json(200, page);
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 16) {
  for (let index = 0; index < times; index += 1) await tick();
}

async function fire(node, type, event = {}) {
  for (const handler of (node.handlers && node.handlers[type]) || []) await handler(event);
}

function installChatGlobals({narrow = false} = {}) {
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.location = {hash: '', pathname: '/chat'};
  globalThis.history = {pushState() {}, replaceState() {}};
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = (query) => ({matches: narrow && query === '(max-width: 900px)'});
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  };
}

function messageRowTitles(doc) {
  const results = doc.getElementById('search-results');
  const titles = [];
  for (const section of results.children) {
    const list = section.children.find((child) => child.tagName === 'UL');
    for (const row of (list ? list.children : [])) {
      const button = row.children[0];
      const title = button && button.children[0];
      if (title) titles.push(title.textContent);
    }
  }
  return titles;
}

// The user-facing entry to page two: a visible control labelled 加载更多, whether
// it lives beside the results or inside them.
function visibleLoadMoreLabels(doc) {
  const labels = [];
  const add = (node) => {
    if (node && !node.hidden) labels.push(String(node.textContent || '').trim());
  };
  add(doc.getElementById('search-more'));
  const visit = (node) => {
    if (!node) return;
    if (node.tagName === 'BUTTON' && String(node.textContent || '').trim() === '加载更多') add(node);
    for (const child of node.children || []) visit(child);
  };
  visit(doc.getElementById('search-results'));
  return labels;
}

async function openMessageSearch(doc, el, fetcher) {
  await mount(doc, {fetcher});
  await settle();
  assert.equal(el('workspace').value, 'ws-1', 'the fixture workspace is selected');
  const input = el('session-search');
  await fire(input, 'focus');
  input.value = '上周';
  await fire(input, 'input');
  await settle();
}

function chatHtml() {
  return readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
}

test('a confirmed attachment replaces its preview before the upload response arrives', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const uploads = [];
  class Upload {
    constructor() {
      this.upload = {};
      uploads.push(this);
    }
    open() {}
    setRequestHeader() {}
    send() {}
  }
  const revoked = [];
  doc.defaultView = {
    XMLHttpRequest: Upload, FormData,
    URL: {createObjectURL: () => 'blob:video-preview', revokeObjectURL: url => revoked.push(url)},
  };
  const destination = {owner:alice, scope:'group-one', wid:'workspace-one', conversationId:'chat-one', path:'/messages'};
  const receipts = [];
  const queue = mountChatFiles(doc, {
    context: () => destination, ownerId: () => alice, csrfToken: () => '',
    createKey: () => 'attachment-key', sent: (to, message) => receipts.push({to, message}),
  });
  queue.addFiles([new File(['bytes'], 'clip.mp4', {type:'video/mp4'})]);
  const preview = el('message-list').children[0];
  const progress = descendants(preview).find(node => node.tagName === 'PROGRESS');
  const status = descendants(preview).find(node => node.getAttribute('role') === 'status');
  uploads[0].upload.onprogress({lengthComputable:true, loaded:1, total:4});
  assert.equal(progress.hidden, false);
  assert.equal(progress.value, 25);
  uploads[0].upload.onload();
  assert.equal(progress.hidden, true);
  assert.equal(status.textContent, '附件已上传，正在确认发送…');

  const message = {id:'saved-video', client_key:'attachment-key', user_id:alice,
    workspace_id:destination.wid, conversation_id:destination.conversationId, attachment:{title:'clip.mp4'}};
  queue.confirmFromHistory('another-group', [message]);
  queue.confirmFromHistory(destination.scope, [{...message, user_id:bob}]);
  queue.confirmFromHistory(destination.scope, [{...message, workspace_id:'workspace-two'}]);
  queue.confirmFromHistory(destination.scope, [{...message, conversation_id:'chat-two'}]);
  assert.deepEqual(el('message-list').children, [preview]);
  queue.confirmFromHistory(destination.scope, [message]);
  assert.equal(el('message-list').children.length, 0);
  assert.deepEqual(revoked, ['blob:video-preview']);
  Object.assign(uploads[0], {status:201, response:{message}});
  uploads[0].onload();
  await Promise.resolve();
  assert.deepEqual(receipts, [{to:destination, message:undefined}]);
});

test('choosing a group attachment only creates a preview and removing it sends nothing', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = {
    XMLHttpRequest: class { constructor() { assert.fail('file selection made an upload request'); } },
    URL:{createObjectURL: () => 'blob:draft', revokeObjectURL() {}},
  };
  let destination = {scope:'first-group'};
  const files = mountChatFiles(doc, {context:() => destination});
  const input = el('chat-attachment');
  const picked = new File(['preview'], 'preview.png', {type:'image/png'});
  input.files = [picked];
  await fire(input,'change');
  assert.deepEqual(files.draftFiles('first-group'), [picked]);
  assert.equal(el('agent-file-draft').hidden, false);
  assert.equal(el('chat-body').required, false);
  destination = {scope:'second-group'};
  files.render();
  assert.equal(el('agent-file-draft').hidden, true);
  assert.equal(el('chat-body').required, true);
  destination = {scope:'first-group'};
  files.render();
  const remove = descendants(el('agent-file-draft')).find(node => node.getAttribute('aria-label') === '移除 preview.png');
  await fire(remove,'click');
  assert.deepEqual(files.draftFiles('first-group'), []);
  assert.equal(el('agent-file-draft').hidden, true);
});

test('pasting files stages a scoped attachment and leaves normal caption paste to the textarea', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = {
    XMLHttpRequest: class { constructor() { assert.fail('clipboard paste made an upload request'); } },
    URL:{createObjectURL: () => 'blob:screenshot', revokeObjectURL() {}},
  };
  let destination = {scope:'group', private:false};
  const files = mountChatFiles(doc, {context:() => destination});
  const field = el('chat-body');
  field.value = '已有草稿';
  const photo = new File(['fixture'], 'screenshot.png', {type:'image/png'});
  let prevented = false;
  const paste = (picked, text = '') => fire(field, 'paste', {
    clipboardData:{files:picked, getData:() => text}, preventDefault() { prevented = true; },
  });

  await paste([], '正常文本');
  assert.equal(prevented, false);
  await paste([photo], '图片说明');
  assert.equal(prevented, false);
  assert.equal(field.value, '已有草稿');
  assert.deepEqual(files.draftFiles('group'), [photo]);

  destination = {scope:'private', private:true};
  files.render();
  assert.equal(el('agent-file-draft').hidden, true);
  await paste([photo]);
  assert.equal(prevented, true);
  assert.deepEqual(files.draftFiles('private'), [photo]);
  destination = {scope:'blocked', blocked:true};
  await paste([photo]);
  assert.deepEqual(files.draftFiles('blocked'), []);
});

test('file drop checks its original conversation and reports partial attachment limits', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = {XMLHttpRequest: class { constructor() { assert.fail('file drop made an upload request'); } }};
  const original = {scope:'origin', private:true};
  let destination = original;
  const files = mountChatFiles(doc, {context:() => destination});
  const target = el('chat-form');
  const hint = el('composer-file-drop');
  let prevented = false;
  const drag = {dataTransfer:{types:['Files'], files:[new File(['valid'], 'notes.txt')]},
    preventDefault() { prevented = true; }};
  await fire(target,'dragenter',{dataTransfer:{types:['text/plain']}, preventDefault:() => assert.fail('blocked text drag')});
  assert.equal(hint.hidden,true);
  await fire(target,'dragenter',drag);
  await fire(target,'dragenter',drag);
  await fire(target,'dragleave');
  assert.equal(hint.hidden,false, 'moving between child controls must keep the drop affordance');
  destination = {scope:'different'};
  files.render();
  await fire(target,'dragover',drag);
  assert.equal(drag.dataTransfer.dropEffect,'none');
  await fire(target,'drop',drag);
  assert.equal(prevented,true);
  assert.equal(hint.hidden,true);
  assert.deepEqual(files.draftFiles('different'),[]);

  destination = original;
  drag.dataTransfer.files = [
    new File([], 'empty.txt'), new File(['not allowed'], 'archive.zip'),
    ...Array.from({length:5}, (_, index) => new File(['valid'], `${index}.txt`)),
  ];
  await fire(target,'dragenter',drag);
  await fire(target,'dragover',drag);
  assert.equal(drag.dataTransfer.dropEffect,'copy');
  await fire(target,'drop',drag);
  assert.equal(hint.hidden,true);
  assert.deepEqual(files.draftFiles('origin').map(file => file.name), ['0.txt','1.txt','2.txt','3.txt']);
  const feedback = el('chat-upload-error').textContent;
  assert.match(feedback, /空文件/);
  assert.match(feedback, /私聊支持图片/);
  assert.match(feedback, /最多 4 个附件/);
  destination = {scope:'other'};
  files.render();
  assert.equal(el('chat-upload-error').textContent,'');
  assert.equal(el('agent-file-draft').hidden,true);
});

test('clipboard files that fit can still be staged after skipping one over the private aggregate limit', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = {};
  const files = mountChatFiles(doc, {context:() => ({scope:'private', private:true})});
  const first = new File([new Uint8Array(6 * 1024 * 1024)], 'first.txt');
  const tooLarge = new File([new Uint8Array(3 * 1024 * 1024)], 'skip.txt');
  const last = new File(['small'], 'last.txt');
  await fire(el('chat-body'),'paste',{
    clipboardData:{files:[first,tooLarge,last],getData:() => ''}, preventDefault() {},
  });
  assert.deepEqual(files.draftFiles('private'),[first,last]);
  assert.match(el('chat-upload-error').textContent,/合计 8 MB/);
});

test('message search pages by cursor through a 加载更多 control instead of stopping at 20', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher();
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    const searchRequests = () => requests.filter((path) => path.includes('/search/messages?'));
    assert.equal(searchRequests().length, 1, 'the first query asks the server once');
    assert.match(searchRequests()[0], /[?&]limit=20(&|$)/, 'the first page asks for limit=20');
    assert.doesNotMatch(searchRequests()[0], /cursor=/, 'the first page has no cursor yet');

    const first = messageRowTitles(doc);
    assert.equal(first.length, 20, 'page one shows exactly the 20 hits the server returned');
    assert.equal(first[0], '对话 1');
    assert.equal(first[19], '对话 20');
    assert.deepEqual(
      visibleLoadMoreLabels(doc),
      ['加载更多'],
      'the server returned a cursor, so the 20 rendered rows must offer a way to reach page two',
    );

    await fire(el('search-more'), 'click');
    await settle();
    assert.equal(searchRequests().length, 2, 'clicking the control asks for the next page');
    assert.match(searchRequests()[1], /[?&]cursor=cursor-1(&|$)/, 'the second request carries the cursor');
    assert.match(searchRequests()[1], /[?&]limit=20(&|$)/, 'the page size stays 20');
    const appended = messageRowTitles(doc);
    assert.equal(appended.length, 39, 'the next page is appended once, without repeating the last row');
    assert.equal(appended[38], '对话 39');
    assert.deepEqual(visibleLoadMoreLabels(doc), [], 'an empty cursor hides the control again');
  } finally {
    restore();
  }
});

test('a failed next page keeps the rows already shown and leaves the control for a retry', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher({failNext: true});
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'page one still offers the next page');
    await fire(el('search-more'), 'click');
    await settle();
    assert.match(requests[requests.length - 1], /[?&]cursor=cursor-1(&|$)/);
    assert.equal(messageRowTitles(doc).length, 20, 'the rows already shown stay');
    assert.equal(doc.getElementById('search-empty').textContent, '无法加载更多。');
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'the cursor survives so the user can retry');
    assert.equal(el('search-more').disabled, false);
  } finally {
    restore();
  }
});

test('messageSearchQuery hands the next-page cursor to the server', () => {
  const first = new URLSearchParams(messageSearchQuery('上周'));
  assert.equal(first.get('limit'), '20', 'the page size stays 20');
  assert.equal(first.get('cursor'), null, 'the first page sends no cursor');

  const next = new URLSearchParams(messageSearchQuery('上周', alice, 'cursor-1'));
  assert.equal(next.get('limit'), '20', 'the page size stays 20');
  assert.equal(next.get('conversation_id'), alice);
  assert.equal(next.get('cursor'), 'cursor-1', 'a supplied cursor must reach the server, or page two is unreachable');
});

// Narrow screens show one pane at a time: the conversation list or the open
// conversation. The stylesheet keys that switch on `sessions-open`; these tests
// drive mount() and pin the class to the user's actual path through the page.

function sessionFetcher() {
  const aliceRow = {user_id: alice, username: 'alice'};
  const first = {
    id: 'conv-1', kind: 'dm', title: 'bob', updated: 30,
    members: [aliceRow, {user_id: bob, username: 'bob'}],
  };
  const second = {
    id: 'conv-2', kind: 'dm', title: 'carol', updated: 20,
    members: [aliceRow, {user_id: 'c'.repeat(32), username: 'carol'}],
  };
  const requests = [];
  const fetcher = async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') {
      return json(200, {items: [first, second]});
    }
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-1') {
      return json(200, {
        conversation: first,
        items: [{id: 'm-1', user_id: bob, body: '你好', created: '2026-01-01T00:00:00Z'}],
      });
    }
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-2') {
      return json(200, {conversation: second, items: []});
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

function sessionRows(el) {
  return el('conversation-list').children.map((li) => li.children[0]);
}

for (const preset of [true,false]) {
  test(`group creation shows an inline retry for ${preset ? 'team presets' : 'custom groups'}`, async () => {
    const {doc, el} = fakeChatDocument(chatHtml());
    doc.documentElement = {lang:preset ? 'zh-CN' : 'en'};
    const restore = installChatGlobals({narrow:preset});
    const {fetcher:original} = sessionFetcher();
    const mode = el('compose-mode-team');
    mode.dataset.groupMode = 'team';
    const memberChoices = el('member-choices');
    const templateChoices = el('team-template-choices');
    const members = () => memberChoices.children.map(label=>label.children[0]);
    const templates = () => templateChoices.children.map(label=>label.children[0]);
    const originalAll = doc.querySelectorAll;
    doc.querySelectorAll = selector => {
      if (selector === '#compose-mode-switch [data-group-mode]') return [mode];
      if (selector === '#team-template-choices input:checked') return templates().filter(box=>box.checked);
      if (selector === '#member-choices label') return memberChoices.children;
      if (selector === '#member-choices input:checked') return members().filter(box=>box.checked);
      if (selector === '#member-choices input[name="member"]:checked') return members().filter(box=>box.checked&&box.name==='member');
      if (selector === '#member-choices input[name="agent-member"]:checked') return [];
      return originalAll(selector);
    };
    doc.querySelector = selector => selector === '#team-template-choices input:checked' ? templates().find(box=>box.checked) : null;
    const attempts = [];
    const path = '/v1/workspaces/ws-1/' + (preset ? 'team-templates/product-squad' : 'social/conversations');
    const created = {id:'new-group',kind:'group',workspace_id:'ws-1',title:'调研协作群',
      members:[{user_id:alice,username:'alice'}], agent_members:[], last_seq:0};
    const createFailure = Promise.withResolvers();
    const openFailure = Promise.withResolvers();
    let opens = 0;
    try {
      await mount(doc,{fetcher:async (url,options={})=>{
        if (url === '/v1/team-templates') return json(200,{items:[{slug:'product-squad',name:'产品研发小队',agents:[{name:'产品经理'}]}]});
        if (url.endsWith('/members')) return json(200,{items:[{user_id:bob,username:'bob'}]});
        if (url === path && options.method === 'POST') {
          attempts.push({body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});
          if (attempts.length === 1) return createFailure.promise;
          if (preset && attempts.length === 2) return json(409,{error:{code:'team_template_role_conflict',
            message:'「产品经理助理」已归档。请在智能体中恢复后重试。'}});
          if (preset && attempts.length === 3) return json(429,{error:{code:'team_template_agent_quota'}});
          const {agent_members:_, ...raw} = created;
          return json(201,{conversation:preset ? raw : created});
        }
        if (url.endsWith('/new-group')) {
          opens += 1;
          if (opens === 1) return openFailure.promise;
          return json(200,{conversation:created,items:[]});
        }
        return original(url,options);
      }});
      await fire(el('compose-new-group'),'click',{detail:1});
      if (preset) {
        await fire(el('compose-mode-switch'),'click',{target:mode});
        await settle();
      } else el('compose-title').value = '调研协作群';
      const choice = preset ? templates()[0] : members()[0];
      choice.checked = true;
      await fire(preset ? templateChoices : memberChoices,'change');
      const submit = ()=>fire(el('compose-social-form'),'submit',{preventDefault() {}});
      const createdAttempt = submit();
      await settle();
      assert.match(el('compose-dialog-progress').textContent,preset ? /正在创建产品研发小队/ : /Creating the conversation/);
      assert.equal(el('compose-dialog-submit').disabled,true);
      assert.equal(el('compose-mode-switch').inert,true);
      await fire(el('session-search'),'focus');
      assert.equal(el('compose-dialog').hidden,false);
      assert.equal(el('search-panel').hidden,true);
      await submit();
      assert.equal(attempts.length,1);
      createFailure.resolve(json(500,{error:{code:'internal_error',message:'Internal service error'}}));
      await createdAttempt;
      const error = el('compose-dialog-error');
      assert.equal(error.hidden,false);
      assert.equal(error.focused,true);
      assert.match(error.textContent,preset ? /所选模板已保留.*重试/ : /Your selections are saved\. Try again/);
      assert.doesNotMatch(el('status').textContent,/Internal service error/);
      assert.equal(el('compose-dialog').hidden,false);
      assert.equal(el('compose-dialog-submit').disabled,false);
      assert.equal(choice.checked,true);
      if (!preset) assert.equal(el('compose-title').value,'调研协作群');
      assert.deepEqual(attempts[0].body,preset ? {} : {kind:'group',member_ids:[bob],title:'调研协作群'});
      if (preset) {
        await submit();
        assert.match(error.textContent,/产品经理助理.*在智能体中恢复/);
        await submit();
        assert.match(error.textContent,/智能体数量已达上限.*切换到有可用名额的工作区/);
        assert.equal(choice.checked,true);
        assert.equal(el('compose-dialog-submit').disabled,false);
      }
      const lastAttempt = submit();
      if (preset) {
        await settle();
        assert.equal(opens,1);
        assert.equal(el('compose-dialog').hidden,false);
        assert.match(el('compose-dialog-progress').textContent,/已创建，正在打开会话/);
        await submit();
        assert.equal(attempts.length,4);
        openFailure.resolve(json(500,{error:{code:'internal_error',message:'Internal service error'}}));
        await lastAttempt;
        assert.match(error.textContent,/会话已创建。暂时无法打开/);
        assert.equal(el('compose-dialog-submit').disabled,false);
        assert.equal(el('compose-dialog-submit').textContent,'重新打开');
        assert.equal(el('compose-dialog-cancel').textContent,'关闭');
        assert.equal(el('compose-dialog').hidden,false);
        assert.equal(choice.checked,true);
        assert.doesNotMatch(el('status').textContent,/Internal service error/);
        await submit();
        assert.equal(attempts.length,4);
        assert.equal(opens,2);
      } else {
        await lastAttempt;
        assert.equal(opens,0);
      }
      for (const retry of attempts.slice(1)) assert.deepEqual(retry,attempts[0]);
      assert.equal(error.hidden,true);
      assert.equal(el('compose-dialog').hidden,true);
      assert.match(el('status').textContent,preset ? /智能体团队已创建/ : /会话已创建/);
    } finally {restore();}
  });
}

test('a slow send moves the draft into the conversation and submits only once', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  let resolveSend;
  let sends = 0;
  try {
    await mount(doc, {fetcher: (path, options) => {
      if (path.endsWith('/conv-1/messages') && options.method === 'POST') {
        sends += 1;
        return new Promise(resolve => { resolveSend = resolve; });
      }
      return fetcher(path);
    }});
    const row = sessionRows(el).find(item => item.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target: row});
    const body = el('chat-body');
    body.value = '发出这条消息';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    const pending = el('message-list').children.at(-1);
    assert.equal(pending.dataset.sendPending, 'pending');
    assert.ok(descendants(pending).some(node => node.textContent === '正在发送…'));
    assert.equal(body.value, '');
    assert.equal(body.focused, true);
    assert.equal(el('chat-send').disabled, false);
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(sends, 1);
    body.value = '下一条草稿';
    resolveSend(json(201, {message: {id: 'sent', user_id: alice, body: '发出这条消息', created: 20}}));
    await settle();
    assert.equal(el('message-list').children.at(-1).dataset.messageId, 'sent');
    assert.equal(el('chat-send').disabled, false);
    assert.equal(body.value, '下一条草稿');
    assert.equal(requests.filter(path => path.endsWith('/conv-1')).length, 1);
  } finally { restore(); }
});

function nativeReplyChat(transport) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  const restore = installChatGlobals();
  globalThis.location.hash = '#workspace=ws-1&agent=agent-1&conversation=private-1';
  const {fetcher: fallback} = sessionFetcher();
  const agent = {id: 'agent-1', name: '助手'};
  const conversation = {id: 'private-1', agent_id: agent.id, title: '私聊', updated: 40};
  const path = '/v1/workspaces/ws-1/agents/agent-1/conversations/private-1';
  const fetcher = (url, opts) => url.endsWith('/agents?limit=100&include=conversations')
    ? json(200, {items: [agent], conversations: [conversation]})
    : url.startsWith(path) ? transport(url.slice(path.length), opts, {agent, conversation}) : fallback(url);
  return {doc, el, restore, fetcher};
}

test('private agent starters stage safe text, preserve drafts, and follow the latest native scope', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  const {fetcher: fallback} = sessionFetcher();
  const agentA = {id:'agent-a', workspace_id:'ws-1', served_by:'ds-bot', name:'甲',
    quick_starts:['核对 <原文>', '测试开场', 'x'.repeat(81), null]};
  const agentB = {...agentA, id:'agent-b', name:'乙', quick_starts:['旧目录开场']};
  const thread = {id:'thread-b', agent_id:agentB.id, title:'既有对话', updated:50};
  let latest = {...agentB, quick_starts:['既有会话的新开场']};
  let deferredAgent;
  const calls = [];
  const fetcher = (url, options = {}) => {
    calls.push({url, method:options.method || 'GET'});
    if (url.endsWith('/agents?limit=100&include=conversations')) {
      return json(200, {items:[agentA, agentB], conversations:[thread]});
    }
    if (url.endsWith('/agents/agent-b/conversations/thread-b?limit=50')) {
      return json(200, {agent:latest, conversation:thread, items:[{role:'user', body:'已有历史'}]});
    }
    if (url.endsWith('/agents/agent-b')) return deferredAgent || json(200, {agent:latest});
    return fallback(url, options);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = '#workspace=ws-1&agent=agent-a';
  try {
    await mount(doc, {fetcher});
    const input = el('chat-body');
    const list = el('agent-quick-starts-list');
    const panel = el('agent-quick-starts');
    const notice = el('agent-quick-starts-status');
    const buttons = [...list.children];
    assert.equal(panel.hidden, false);
    assert.deepEqual(buttons.map(button => [button.type,button.textContent]), [['button','核对 <原文>'],['button','测试开场']]);
    let changes = 0;
    input.addEventListener('input', () => { changes += 1; });
    await fire(buttons[0], 'click');
    assert.equal(input.value, '核对 <原文>');
    await fire(buttons[1], 'click');
    assert.equal(input.value, '核对 <原文>\n\n测试开场');
    assert.equal(input.focused, true);
    assert.equal(changes, 2);
    const oversized = '草'.repeat(3999);
    input.value = oversized;
    await fire(buttons[0], 'click');
    assert.equal(input.value, oversized);
    assert.equal(changes, 2);
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /草稿已保留/);
    input.value = '改过的甲草稿';
    await fire(input, 'input');
    assert.equal(notice.hidden, true);
    assert.equal(calls.filter(call => call.method === 'POST' && /conversations|messages/.test(call.url)).length, 0);

    const row = sessionRows(el).find(button => button.dataset.conversation === thread.id);
    await fire(el('conversation-list'), 'click', {target:row});
    assert.equal(input.value, '');
    assert.deepEqual(list.children.map(button => button.textContent), ['既有会话的新开场']);
    await fire(buttons[0], 'click');
    assert.equal(input.value, '', 'detached controls from another native agent cannot edit this draft');
    await fire(list.children[0], 'click');
    assert.equal(input.value, '既有会话的新开场');
    assert.equal(el('message-list').children.length, 1, 'staging does not change the existing transcript');

    latest = {...agentB, quick_starts:['编辑后的开场']};
    doc.visibilityState = 'visible';
    await fire(doc, 'visibilitychange');
    await settle();
    assert.deepEqual(list.children.map(button => button.textContent), ['编辑后的开场']);
    assert.equal(input.value, '既有会话的新开场');
    assert.equal(calls.filter(call => call.url.endsWith('/agents/agent-b/conversations/thread-b?limit=50')).length, 1);
    latest = {...latest, archived:1};
    const stale = list.children[0];
    await fire(doc, 'visibilitychange');
    await settle();
    assert.equal(panel.hidden, true);
    await fire(stale, 'click');
    assert.equal(input.value, '既有会话的新开场');

    let finishAgent;
    deferredAgent = new Promise(resolve => { finishAgent = resolve; });
    await fire(doc, 'visibilitychange');
    const direct = sessionRows(el).find(button => button.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target:direct});
    finishAgent(json(200, {agent:agentB}));
    await settle();
    assert.equal(panel.hidden, true);
    assert.equal(input.value, '');
  } finally { restore(); }
});

test('private quick starts are suppressed for an agent returned outside the current workspace', async () => {
  const {doc, el, restore, fetcher} = nativeReplyChat((path, options, scope) => {
    assert.equal(path, '?limit=50');
    return json(200, {...scope, agent:{...scope.agent, workspace_id:'another-workspace', served_by:'ds-bot', quick_starts:['私密开场']}, items:[]});
  });
  try {
    await mount(doc, {fetcher});
    assert.equal(el('agent-quick-starts').hidden, true);
    assert.equal(el('agent-quick-starts-list').children.length, 0);
  } finally { restore(); }
});

test('a growing composer stays with the live reply unless the reader had scrolled up', async () => {
  const {doc, el, restore, fetcher} = nativeReplyChat((path, _options, scope) => {
    assert.equal(path, '?limit=50');
    return json(200, {...scope, items:[{id:'earlier', role:'user', body:'一条已有消息'}]});
  });
  const scroller = el('message-scroller');
  scroller.clientHeight = 600;
  scroller.scrollHeight = 1800;
  let resized;
  doc.defaultView = {
    ResizeObserver: class {
      constructor(callback) { resized = callback; }
      observe(target) { assert.equal(target, scroller); }
    },
  };
  try {
    await mount(doc, {fetcher});
    scroller.scrollTop = 1200;
    scroller.clientHeight = 490;
    resized();
    assert.equal(scroller.scrollTop, scroller.scrollHeight);
    assert.equal(el('chat-back-to-latest').hidden, true);

    scroller.scrollTop = 750;
    scroller.clientHeight = 600;
    resized();
    assert.equal(scroller.scrollTop, 750);
    assert.equal(el('chat-back-to-latest').hidden, false);
  } finally { restore(); }
});

test('a native reply streams as plain text without rebuilding history or changing an unsent draft', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const previous = {id: 'earlier', role: 'user', body: '更早的消息'};
  const snapshots = [null, '正在回答 <img src=x>', '正在回答 <img src=x>\n后续内容'];
  const progressKeys = [];
  let historyReads = 0;
  let finishPost;
  let requestKey;
  const {doc, el, restore, fetcher} = nativeReplyChat((path, opts, scope) => {
    if (path === '?limit=50') {
      historyReads += 1;
      return json(200, {...scope, items: [previous]});
    }
    if (path === '/messages' && opts.method === 'POST') {
      requestKey = opts.headers['Idempotency-Key'];
      return new Promise(resolve => { finishPost = resolve; });
    }
    const key = new URL(path, 'https://flybot-workspace.test').searchParams.get('key');
    progressKeys.push(key);
    const next = snapshots.shift();
    return next == null ? json(404, {}) : json(200, {state: 'running', text: next});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const original = list.children[0];
    const field = el('chat-body');
    field.value = '回复这个问题';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    const pending = list.children.at(-1);
    const preview = pending.children.find(node => node.className.includes('reply-preview'));
    assert.equal(pending.dataset.replyProgress, requestKey);
    assert.equal(preview.hidden, true);
    assert.equal(field.value, '');
    field.value = '下一条草稿';

    t.mock.timers.tick(400); await settle();
    assert.equal(preview.hidden, true, '404 during reservation leaves the pending reply intact');
    t.mock.timers.tick(400); await settle();
    assert.equal(preview.textContent, '正在回答 <img src=x>');
    assert.equal(preview.children.length, 0);
    assert.equal(preview.getAttribute('aria-live'), 'off');
    assert.equal(list.children[0], original);
    assert.equal(list.children.at(-1), pending);

    const scroller = el('message-scroller');
    scroller.clientHeight = 200;
    scroller.scrollHeight = 1000;
    scroller.scrollTop = 130;
    doc.visibilityState = 'hidden';
    await fire(doc, 'visibilitychange');
    t.mock.timers.tick(1200); await settle();
    assert.equal(progressKeys.length, 2);
    doc.visibilityState = 'visible';
    await fire(doc, 'visibilitychange');
    t.mock.timers.tick(400); await settle();
    assert.match(preview.textContent, /后续内容/);
    assert.equal(scroller.scrollTop, 130);
    assert.deepEqual(progressKeys, [requestKey, requestKey, requestKey]);

    finishPost(json(201, {
      message: {id: 'new-user', role: 'user', body: '回复这个问题', client_key: requestKey},
      reply: {id: 'new-reply', role: 'assistant', status: 'succeeded', body: '**最终回复**', client_key: requestKey},
    }));
    await settle();
    t.mock.timers.tick(2000); await settle();
    assert.equal(historyReads, 1, 'live progress and final POST do not re-fetch previous messages');
    assert.equal(progressKeys.length, 3);
    assert.deepEqual(list.children.map(node => node.dataset.messageId), ['earlier', 'new-user', 'new-reply']);
    assert.equal(list.children[0], original, 'settling the reply leaves the previous transcript mounted');
    assert.ok(descendants(list.children.at(-1)).some(node => node.tagName === 'STRONG' && node.textContent === '最终回复'));
    assert.equal(field.value, '下一条草稿');
    assert.equal(scroller.scrollTop, 130);
  } finally { restore(); }
});

test('a running native reply preserves its partial text during reconnect and loads the final history once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const key = 'msg-reloaded-reply';
  const user = {id: 'saved-user', role: 'user', body: '等待中的问题', client_key: key};
  const reply = {id: 'saved-reply', role: 'assistant', status: 'running', client_key: key, reply_phase:'queued'};
  let historyReads = 0;
  let polls = 0;
  const snapshots = [
    {state:'running', revision:1, phase:'thinking', text:''},
    {state:'running', revision:2, phase:'writing', text:'正在继续回复'},
    null,
    null,
    {state:'running', revision:3, phase:'writing', text:'正在继续回复，连接已恢复'},
    {state:'succeeded'},
  ];
  const {doc, el, restore, fetcher} = nativeReplyChat((path, _opts, scope) => {
    if (path === '?limit=50') {
      historyReads += 1;
      const current = polls < snapshots.length ? reply : {...reply, status: 'succeeded', body: '已保存的答复'};
      return json(200, {...scope, items: [user, current]});
    }
    assert.equal(path, '/reply-progress?key=' + key + '&after=' + [0,1,2,2,2,3][polls]);
    const snapshot = snapshots[polls++];
    return snapshot ? json(200, snapshot) : json(502, {});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const original = list.children[0];
    const pending = list.children.at(-1);
    const heading = pending.children.find(node => node.className === 'reply-state');
    assert.equal(pending.dataset.messageId, reply.id);
    assert.equal(heading.textContent, '已排队，等待上一条回复完成…');
    t.mock.timers.tick(400); await settle();
    assert.equal(list.children.at(-1), pending);
    assert.equal(heading.textContent, '助手 正在思考…');
    t.mock.timers.tick(50); await settle();
    assert.equal(pending.children.at(-1).textContent, '正在继续回复');
    t.mock.timers.tick(50); await settle();
    assert.equal(heading.textContent, '正在生成回复');
    t.mock.timers.tick(400); await settle();
    assert.equal(heading.textContent, '正在重新连接回复…');
    assert.equal(pending.children.at(-1).textContent, '正在继续回复');
    assert.equal(list.children.at(-1), pending);
    assert.equal(historyReads, 1);
    t.mock.timers.tick(400); await settle();
    assert.equal(heading.textContent, '正在生成回复');
    assert.equal(pending.children.at(-1).textContent, '正在继续回复，连接已恢复');
    t.mock.timers.tick(50); await settle();
    assert.deepEqual(list.children.map(node => node.dataset.messageId), [user.id, reply.id]);
    assert.equal(list.children[0], original, 'a fresh history snapshot keeps an unchanged row mounted');
    assert.equal(list.children.at(-1).dataset.replyProgress, undefined);
    assert.ok(descendants(list.children.at(-1)).some(node => node.textContent === '已保存的答复'));
    t.mock.timers.tick(3000); await settle();
    assert.equal(historyReads, 2);
    assert.equal(polls, snapshots.length);
  } finally { restore(); }
});

for (const deliveredBeforeAck of [false, true]) {
  test(deliveredBeforeAck ? 'a terminal private receipt can settle the transcript before the message acknowledgment'
    : 'a lost private message acknowledgment reconciles without another send or transcript reload', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const issued = Promise.withResolvers();
    const deliveries = [];
    let posts = 0, normalHistory = 0, sendKey;
    const {doc, el, restore, fetcher} = nativeReplyChat((path, opts, scope) => {
      if (path === '?limit=50') {
        normalHistory += 1;
        return json(200, {...scope, items: []});
      }
      if (path === '/messages' && opts.method === 'POST') {
        posts += 1;
        sendKey = opts.headers['Idempotency-Key'];
        if (deliveredBeforeAck) return issued.promise;
        return Promise.reject(new TypeError('acknowledgment lost'));
      }
      const query = new URL(path, 'https://flybot-workspace.test').searchParams;
      assert.equal(query.get('key'), sendKey);
      if (!query.has('receipt')) return json(200, {state: 'succeeded'});
      assert.equal(query.get('receipt'), '1');
      deliveries.push(sendKey);
      return json(200, {state: 'succeeded',
        message: {id: 'sent-once', role: 'user', body: '用户问题', client_key: sendKey},
        reply: {id: 'saved-reply', role: 'assistant', status: 'succeeded', body: '已完成回复', client_key: sendKey}});
    });
    try {
      await mount(doc, {fetcher});
      const field = el('chat-body');
      field.value = '用户问题';
      await fire(el('chat-form'), 'submit', {preventDefault() {}});
      field.value = '另一条未发送草稿';
      if (deliveredBeforeAck) t.mock.timers.tick(400);
      await settle();
      assert.deepEqual(el('message-list').children.map(row => row.dataset.messageId), ['sent-once', 'saved-reply']);
      assert.equal(field.value, '另一条未发送草稿');
      assert.equal(posts, 1);
      assert.equal(normalHistory, 1);
      assert.deepEqual(deliveries, [sendKey]);
      if (deliveredBeforeAck) {
        issued.reject(new TypeError('late acknowledgment lost'));
        await settle();
        assert.equal(posts, 1);
        assert.deepEqual(deliveries, [sendKey]);
      }
    } finally { restore(); }
  });
}

test('a long native reply keeps its partial text and Stop when the stream disconnects', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const post = Promise.withResolvers();
  let sendKey, ack, historyReads = 0, receiptReads = 0, fallbackReads = 0;
  const stopped = [];
  const {doc, el, restore, fetcher} = nativeReplyChat((path, opts, scope) => {
    if (path === '?limit=50') {
      historyReads++;
      return json(200, {...scope, items: []});
    }
    if (path === '/messages' && opts.method === 'POST') {
      sendKey = opts.headers['Idempotency-Key'];
      const fields = {workspace_id:'ws-1', agent_id:'agent-1', conversation_id:'private-1', client_key:sendKey};
      ack = {
        message:{...fields, id:'1'.repeat(32), role:'user', status:'succeeded', body:'需要停止的回复'},
        reply:{...fields, id:'2'.repeat(32), role:'assistant', status:'running', can_stop:true, attempt:1},
      };
      return post.promise;
    }
    if (path === '/reply-progress?key=' + sendKey + '&receipt=1') {
      receiptReads++;
      return json(200, {...ack, state:'running'});
    }
    if (path === '/reply-progress?key=' + sendKey + '&after=1') {
      fallbackReads++;
      if (fallbackReads === 1) return json(200, {state:'running', text:''});
      return json(200, {state:'running', revision:2, phase:'writing', text:'已收到部分内容，继续工作中'});
    }
    if (path === '/reply-stop' && opts.method === 'POST') {
      stopped.push(JSON.parse(opts.body));
      return json(200, {...ack, reply:{...ack.reply, status:'cancelled', can_stop:false}});
    }
    assert.fail('Unexpected request: ' + path);
  });
  const streams = [];
  doc.defaultView = {EventSource: class {
    handlers = new Map();
    constructor() { streams.push(this); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
    running(text) { this.handlers.get('message')({data:JSON.stringify({state:'running', revision:1, phase:'writing', text})}); }
  }};
  try {
    await mount(doc, {fetcher});
    const field = el('chat-body'), stop = el('chat-reply-stop'), list = el('message-list');
    field.value = '需要停止的回复';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(field.value, '');
    field.value = '下一条草稿';
    streams[0].running('已收到部分内容');
    assert.equal(stop.hidden, true);
    t.mock.timers.tick(249);
    await settle();
    assert.equal(receiptReads, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(receiptReads, 1);
    assert.equal(stop.hidden, false);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].closed, undefined);
    assert.deepEqual(list.children.map(row => row.dataset.messageId), [ack.message.id, ack.reply.id]);
    assert.equal(list.children.at(-1).children.at(-1).textContent, '已收到部分内容');
    for (let elapsed = 0; elapsed < 190_000; elapsed += 10_000) {
      t.mock.timers.tick(10_000);
      streams[0].handlers.get('heartbeat')();
      await settle();
    }
    assert.equal(streams[0].closed, undefined);
    assert.equal(fallbackReads, 0);
    streams[0].handlers.get('error')();
    t.mock.timers.tick(0);
    await settle();
    assert.equal(fallbackReads, 1);
    assert.equal(list.children.at(-1).children.at(-1).textContent, '已收到部分内容');
    assert.equal(stop.hidden, false);
    t.mock.timers.tick(749);
    await settle();
    assert.equal(fallbackReads, 1, 'unchanged fallback progress is paced');
    t.mock.timers.tick(120_000);
    await settle();
    assert.equal(fallbackReads, 2);
    assert.equal(list.children.at(-1).children.at(-1).textContent, '已收到部分内容，继续工作中');
    assert.equal(stop.hidden, false);
    await fire(stop, 'click');
    assert.deepEqual(stopped, [{key:sendKey, attempt:1}]);
    assert.equal(stop.hidden, true);
    assert.equal(list.children.at(-1).dataset.state, 'cancelled');
    post.resolve(json(202, ack));
    await settle();
    assert.equal(list.children.at(-1).dataset.state, 'cancelled');
    assert.equal(field.value, '下一条草稿');
    assert.equal(historyReads, 1);
  } finally { restore(); }
});

test('a durable failed reply can be retried in place after reload and a lost retry acknowledgment', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const key = 'msg-retryable-text';
  const id = 'd'.repeat(32);
  const user = {id: 'original-question', role: 'user', client_key: key, body: '为什么需要复核？'};
  const failed = {id, role: 'assistant', client_key: key, status: 'failed', attempt: 1, can_retry: true};
  const running = {...failed, status: 'running', attempt: 2, can_retry: false};
  const succeeded = {...running, status: 'succeeded', body: '复核可以发现遗漏。'};
  let started = false, finished = false;
  const mutations = [];
  const {doc, el, restore, fetcher} = nativeReplyChat((path, opts, scope) => {
    if (path === '?limit=50') return json(200, {...scope, items: [user, finished ? succeeded : failed]});
    if (path === `/messages/${id}/retry` && opts.method === 'POST') {
      mutations.push({body: JSON.parse(opts.body), key: opts.headers['Idempotency-Key']});
      started = true;
      return Promise.reject(new TypeError('retry acknowledgment lost'));
    }
    assert.ok(started);
    const params = new URL(path, 'https://flybot-workspace.test').searchParams;
    assert.equal(params.get('key'), key);
    if (params.get('receipt') === '1') return json(200, {state: 'running', message: user, reply: running});
    finished = true;
    return json(200, {state: 'succeeded'});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const retry = descendants(list.children.at(-1)).find(node => node.dataset.privateReplyRetry);
    assert.equal(retry.textContent, '重试回复');
    el('chat-body').value = '保留输入框';
    await Promise.all([fire(retry, 'click'), fire(retry, 'click')]);
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].body, {attempt: 1});
    assert.match(mutations[0].key, /^reply-/);
    assert.equal(list.children.at(-1).dataset.replyProgress, key);
    t.mock.timers.tick(400);
    await settle();
    assert.deepEqual(list.children.map(row => row.dataset.messageId), [user.id, id]);
    assert.ok(descendants(list.children.at(-1)).some(node => node.textContent === succeeded.body));
    assert.equal(el('chat-body').value, '保留输入框');
  } finally { restore(); }
});

function groupReplyChat(transport) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  const restore = installChatGlobals();
  globalThis.location.hash = '#workspace=ws-1&social=conv-1';
  const {fetcher: fallback} = sessionFetcher();
  const base = '/v1/workspaces/ws-1/social/conversations';
  const conversation = {id: 'conv-1', kind: 'group', title: '测试群', updated: 40,
    members: [{user_id: alice, username: 'alice'}],
    agent_members: [{id: 'agent-1', name: '助手一'}, {id: 'agent-2', name: '助手二'}]};
  const fetcher = (url, opts) => url.startsWith(base + '/conv-1')
    ? transport(url.slice((base + '/conv-1').length).replace(/^\?start=unread$/, ''), opts, conversation)
    : fallback(url);
  return {doc, el, restore, fetcher};
}

test('native group activity follows local and remote Bot handoffs without reply jobs', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let reads = 0;
  const work = [[{id:'native-a',name:'主答 Bot'}],
    [{id:'guest/native-b',name:'接力 Bot'},{id:'guest/invalid/bot',name:'无效状态'}],[]];
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) return json(200,{conversation:{...conversation,native_room_id:'native-room'},items:[]});
    assert.equal(path,'/reply-progress');
    const working_bots = work[reads++];
    return json(200,{items:[],working_bots});
  });
  try {
    await mount(doc,{fetcher});
    const activity = el('group-bot-activity');
    for (const label of ['主答 Bot 正在工作…','接力 Bot 正在工作…','']) {
      t.mock.timers.tick(500);
      await settle();
      assert.equal(activity.textContent,label);
    }
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(reads,3,'an idle native room should poll more slowly');
  } finally { restore(); }
});

test('native group activity follows Bot handoffs before local room projection', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) return json(200,{conversation:{...conversation,native_room_id:null,
      group_agent_routing:{mode:'shared',policy:{mode:'default'},native_group_host:alice}},items:[]});
    assert.equal(path,'/reply-progress');
    return json(200,{items:[],working_bots:[{id:'guest/native-b',name:'接力 Bot'}]});
  });
  try {
    await mount(doc,{fetcher});
    t.mock.timers.tick(500);
    await settle();
    assert.equal(el('group-bot-activity').textContent,'接力 Bot 正在工作…');
  } finally { restore(); }
});

test('native group action cards submit indexed choices and explicit approval decisions', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const posts = [];
  let acceptChoice;
  const cards = [{id:'card-choice',type:'choice',bot_name:'产品助手',question:'选择发布渠道',
    multiple:true,options:[{label:'邮件',description:'仅项目成员'},{label:'群公告'},{label:'<img src=x>'}]},
  {id:'card-approval',type:'approval',bot_name:'发布助手',tool:'发布',reason:'请确认渠道',
    detail:'发布到项目成员可见的公告栏',code:'<script>sample</script>'}];
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) return json(200,{conversation:{...conversation,native_room_id:'native-room'},items:[]});
    if (path === '/reply-progress') return json(200,{items:[],cards});
    const payload = JSON.parse(opts.body);
    posts.push([path, payload]);
    assert.equal(opts.method, 'POST');
    if (path === '/group-cards/card-choice/answer') return new Promise(resolve => { acceptChoice = resolve; });
    return payload.choice === 'reject' ? json(503,{}) : json(200,{ok:true});
  });
  try {
    await mount(doc,{fetcher});
    const dock = el('group-action-cards');
    assert.equal(dock.hidden,true);
    t.mock.timers.tick(500); await settle();
    const [choice, approval] = dock.children;
    assert.equal(dock.hidden,false);
    assert.equal(choice.dataset.cardType,'choice');
    assert.match(choice.textContent,/仅项目成员/);
    assert.match(choice.textContent,/<img src=x>/);
    assert.equal(choice.querySelector('img'),null);
    assert.match(approval.textContent,/请确认渠道.*项目成员可见/);
    assert.equal(approval.querySelector('pre').textContent,'<script>sample</script>');
    const submit = choice.querySelector('[data-card-action="submit"]');
    const [first,, third] = choice.querySelectorAll('input');
    assert.equal(submit.disabled,true);
    assert.equal(first.type,'checkbox');
    first.checked = third.checked = true;
    await fire(first,'change');
    t.mock.timers.tick(1500); await settle();
    assert.equal(dock.children[0],choice,'repeated snapshots keep selected inputs mounted');
    assert.equal(submit.disabled,false);
    const submitEvent = {preventDefault() {}};
    await fire(choice,'submit',submitEvent);
    await fire(choice,'submit',submitEvent);
    assert.equal(submit.disabled,true);
    assert.deepEqual(posts,[['/group-cards/card-choice/answer',{selected:[0,2]}]]);
    acceptChoice(json(200,{ok:true}));
    await settle();
    assert.deepEqual(dock.children,[approval]);
    const reject = approval.querySelector('[data-card-action="reject"]');
    await fire(reject,'click'); await settle();
    assert.equal(reject.disabled,false);
    assert.match(approval.textContent,/未能确认提交/);
    await fire(approval.querySelector('[data-card-action="allow"]'),'click'); await settle();
    assert.deepEqual(posts.slice(1),[
      ['/group-cards/card-approval/answer',{choice:'reject'}], ['/group-cards/card-approval/answer',{choice:'allow'}],
    ]);
    assert.equal(dock.hidden,true);
    t.mock.timers.tick(1500); await settle();
    assert.equal(dock.hidden,true,'a stale snapshot cannot revive answered cards');
  } finally { restore(); }
});

test('native group action cards are detached immediately when the workspace changes', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let posts = 0;
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) return json(200,{conversation:{...conversation,native_room_id:'native-room'},items:[]});
    if (opts.method === 'POST') { posts++; return json(200,{ok:true}); }
    assert.equal(path,'/reply-progress');
    return json(200,{items:[],cards:[{id:'card-approval',type:'approval',bot_name:'助手',tool:'发布'}]});
  });
  try {
    await mount(doc,{fetcher});
    t.mock.timers.tick(500); await settle();
    const dock = el('group-action-cards');
    const allow = dock.querySelector('[data-card-action="allow"]');
    assert.ok(allow);
    const workspace = el('workspace');
    workspace.value = 'other-workspace';
    await fire(workspace,'change');
    assert.equal(dock.hidden,true);
    assert.deepEqual(dock.children,[]);
    await fire(allow,'click');
    assert.equal(posts,0);
  } finally { restore(); }
});

test('group progress updates only the original job and attempt and clears stale text', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const source = {id: 'source', user_id: alice, body: '请两位协助', created: 1, seq: 1, reply_jobs: [
    {id: 'job-a', attempt: 2, status: 'queued', agent_name: '助手一'},
    {id: 'job-b', attempt: 1, status: 'queued', agent_name: '助手二'},
  ]};
  const flowing = [{id: 'job-a', message_id: 'source', attempt: 2, status: 'running', text: '原样显示 <em>片段</em>'},
    {id: 'job-b', message_id: 'other-source', attempt: 1, status: 'running', text: '别的消息'},
    {id: 'job-b', message_id: 'source', attempt: 1, status: 'running', text: ''}];
  const batches = [...Array(18).fill(flowing),
    [{id: 'job-a', message_id: 'source', attempt: 1, status: 'running', text: '过期的尝试'},
      {id: 'job-b', message_id: 'source', attempt: 1, status: 'running', text: '另一个智能体的新进度'}],
  ];
  let historyReads = 0;
  let progressReads = 0;
  let pending;
  let signal;
  let denied = false;
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) {
      historyReads += 1;
      return json(200, {conversation, items: [source]});
    }
    assert.equal(path, '/reply-progress');
    progressReads += 1;
    if (denied) return json(403, {});
    if (batches.length) return json(200, {items: batches.shift()});
    signal = opts.signal;
    return new Promise(resolve => { pending = resolve; });
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const activity = el('group-bot-activity');
    const original = list.children[0];
    const jobs = list.children.slice(1);
    assert.ok(jobs.every(row => row.tagName === 'LI' && row.classList.contains('other')));
    assert.deepEqual(jobs.map(row => row.children[0].textContent), ['助手一 · AI 智能体', '助手二 · AI 智能体']);
    assert.deepEqual(jobs.map(row => row.hidden), [true, true]);
    assert.equal(activity.textContent, '');
    assert.ok(!descendants(original).some(node => node.dataset.replyJobId));
    const [first, second] = jobs.map(row => row.children.find(node => node.classList.contains('group-reply-preview')));
    t.mock.timers.tick(500); await settle();
    assert.equal(list.children[0], original);
    assert.equal(first.textContent, '原样显示 <em>片段</em>');
    assert.equal(first.children.length, 0);
    assert.equal(first.getAttribute('aria-live'), 'off');
    assert.equal(second.hidden, true);
    assert.equal(jobs[0].dataset.state, 'running');
    assert.equal(jobs[1].dataset.state, 'running', 'a claimed job is running before text arrives');
    assert.equal(jobs[0].hidden, false, 'partial text uses the regular bubble');
    assert.equal(jobs[1].hidden, true, 'a running job without text has no placeholder bubble');
    assert.equal(activity.textContent, '助手一、助手二 正在工作…');
    for (let index = 0; index < 17; index += 1) {
      t.mock.timers.tick(500);
      await settle();
    }
    assert.equal(historyReads, 1, 'no legacy transcript poll after 8 seconds of healthy snapshots');

    const scroller = el('message-scroller');
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 200;
    scroller.scrollTop = 120;
    t.mock.timers.tick(500); await settle();
    assert.equal(first.hidden, true);
    assert.equal(second.textContent, '另一个智能体的新进度');
    assert.equal(activity.textContent, '助手二 正在工作…');
    assert.equal(scroller.scrollTop, 120);
    assert.equal(historyReads, 1);

    t.mock.timers.tick(500); await settle();
    doc.visibilityState = 'hidden';
    await fire(doc, 'visibilitychange');
    assert.equal(signal.aborted, true);
    assert.equal(second.hidden, false);
    assert.equal(second.textContent, '另一个智能体的新进度');
    assert.equal(activity.textContent, '');
    pending(json(200, {items: [{id: 'job-b', message_id: 'source', attempt: 1, text: '迟到的隐藏更新'}]}));
    t.mock.timers.tick(2000); await settle();
    assert.equal(progressReads, 20);
    assert.equal(second.textContent, '另一个智能体的新进度');

    denied = true;
    doc.visibilityState = 'visible';
    await fire(doc, 'visibilitychange');
    t.mock.timers.tick(500); await settle();
    assert.equal(progressReads, 21);
    assert.equal(second.hidden, true);
    assert.equal(second.textContent, '');
    assert.equal(activity.textContent, '');
  } finally { restore(); }
});

test('a group reply already absent from the first progress poll refreshes its failed source and offers retry', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const job = {id: 'fast-job', attempt: 1, status: 'queued', agent_name: '核对助手'};
  const source = {id: 'source', user_id: alice, body: '请协助核对', created: 1, seq: 1};
  let historyReads = 0;
  let progressReads = 0;
  const {doc, el, restore, fetcher} = groupReplyChat((path, _opts, conversation) => {
    if (!path) {
      historyReads += 1;
      const state = progressReads ? {...job, status: 'failed', can_retry: true} : job;
      return json(200, {conversation, items: [{...source, reply_jobs: [state]}]});
    }
    assert.equal(path, '/reply-progress');
    progressReads += 1;
    return json(200, {items: []});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const row = () => list.children.find(node => node.dataset.replyJobId === job.id);
    const pendingRow = row();
    assert.equal(row().dataset.state, 'queued');
    t.mock.timers.tick(500); await settle();
    t.mock.timers.tick(350); await settle();
    assert.equal(historyReads, 2);
    assert.equal(list.children[0].dataset.messageId, source.id);
    assert.equal(row(), pendingRow, 'terminal failure uses the original assistant row');
    assert.equal(row().dataset.state, 'failed');
    assert.ok(row().children.some(node => node.getAttribute('aria-label') === '重试 核对助手'));
    t.mock.timers.tick(9000); await settle();
    assert.equal(progressReads, 1, 'no polling a terminal Job');
  } finally { restore(); }
});

test('group retry submits the displayed attempt and refreshes an outdated failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const job = {id: 'retry-job', attempt: 1, status: 'failed', agent_name: '核对助手', can_retry: true};
  const original = {id: 'source', user_id: alice, body: '请协助核对', created: 1, seq: 1};
  const attempts = [];
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) {
      const latest = attempts.length ? {...job, attempt: 2} : job;
      return json(200, {conversation, items: [{...original, reply_jobs: [latest]}]});
    }
    if (path === '/messages?around=source&limit=1&scope=workspace') return json(404,{});
    assert.equal(path, '/messages/source/agent-retry');
    attempts.push(JSON.parse(opts.body));
    return json(409, {error: {code: 'reply_job_unavailable', message: '这次回复的状态已更新。'}});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const retry = descendants(list).find(node => node.getAttribute('aria-label') === '重试 核对助手');
    await fire(retry, 'click');
    await settle();
    assert.deepEqual(attempts, [{job_id: job.id, attempt: 1}]);
    const row = list.children.find(node => node.dataset.replyJobId === job.id);
    assert.equal(row.dataset.replyAttempt, '2');
  } finally { restore(); }
});

test('a lost group retry acknowledgement resumes progress for only the matching owner and attempt', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const original = {id:'source',user_id:alice,workspace_id:'ws-1',conversation_id:'conv-1',body:'请求核对',seq:1};
  const job = {id:'retry-job',agent_id:'agent-1',agent_owner_id:alice,agent_name:'核对助手',status:'failed',attempt:1,can_retry:true};
  const accepted = {...job,status:'running',attempt:2,can_retry:false};
  const writes = [];
  let transcriptReads = 0;
  let receipts = 0;
  const {doc,el,restore,fetcher} = groupReplyChat((path,opts,conversation)=>{
    if (!path) {
      transcriptReads++;
      return json(200,{conversation,items:[{...original,reply_jobs:[job]}]});
    }
    if (path === '/messages/source/agent-retry') {
      writes.push(JSON.parse(opts.body));
      return json(503,{});
    }
    if (path === '/messages?around=source&limit=1&scope=workspace') {
      receipts++;
      return json(200,{items:[{...original,user_id:bob,reply_jobs:[{...accepted,attempt:4}]},
        {...original,reply_jobs:[accepted]}]});
    }
    assert.equal(path,'/reply-progress');
    return json(200,{items:[{id:job.id,message_id:original.id,status:'running',attempt:2,text:'正在核对内容'}]});
  });
  try {
    await mount(doc,{fetcher});
    const list = el('message-list');
    const row = list.children.find(node=>node.dataset.replyJobId===job.id);
    const retry = descendants(row).find(node=>node.classList.contains('group-reply-retry'));
    el('chat-body').value = '下一条群聊草稿';
    await fire(retry,'click');
    assert.equal(row.dataset.replyAttempt,'2');
    assert.equal(row.dataset.state,'running');
    assert.equal(list.children.find(node=>node.dataset.replyJobId===job.id),row);
    t.mock.timers.tick(500);
    await settle();
    assert.equal(descendants(row).find(node=>node.classList.contains('group-reply-preview')).textContent,'正在核对内容');
    assert.equal(el('chat-body').value,'下一条群聊草稿');
    assert.equal(transcriptReads,1);
    assert.equal(receipts,1);
    assert.deepEqual(writes,[{job_id:job.id,attempt:1}]);
  } finally { restore(); }
});

test('an account group uses the bottom composer without a second send form', async () => {
  const sends = [];
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) return json(200, {conversation:{...conversation,account_group:true}, items:[]});
    if (path === '/reply-progress') return json(200, {items:[]});
    sends.push({path, body:JSON.parse(opts.body)});
    return json(201, {message:{id:'sent', user_id:alice, seq:1, created:1, body:sends.at(-1).body.body}});
  });
  try {
    await mount(doc, {fetcher});
    assert.equal(el('group-agent-action').hidden, false);
    assert.equal(el('group-agent-chips').children.length, 2);
    el('conversation-agents-sheet').open = true;
    await fire(el('conversation-agents-sheet'), 'toggle');
    assert.equal(el('group-agent-form').hidden, true);
    assert.equal(el('group-agent-choices').children.length, 0);
    await fire(el('group-agent-form'), 'submit', {preventDefault() {}});
    assert.deepEqual(sends, []);
    el('chat-body').value = '用底部输入框发送';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    await settle();
    assert.deepEqual(sends, [{path:'/messages', body:{body:'用底部输入框发送'}}]);
  } finally {restore();}
});

test('only the matching same-name assistant row becomes the durable reply in transcript order', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const jobs = ['job-a', 'job-b'].map(id => ({id, attempt: 1, status: 'running', agent_name: '同名助手'}));
  const source = {id: 'source', user_id: alice, body: '请两位协助', created: 1, seq: 1, reply_jobs: jobs};
  const later = {id: 'later', user_id: alice, body: '另一条先保存的消息', created: 2, seq: 2};
  const reply = {id: 'reply', reply_job_id: jobs[1].id, role: 'agent', agent_name: '同名助手',
    body: '第二位助手的最终回复', created: 3, seq: 3};
  const snapshot = job => ({id: job.id, message_id: source.id, attempt: job.attempt, text: job.id + ' 的片段'});
  let progressReads = 0;
  const {doc, el, restore, fetcher} = groupReplyChat((path, _opts, conversation) => {
    if (!path) return json(200, {conversation, items: progressReads < 2 ? [source] : [source, later, reply]});
    assert.equal(path, '/reply-progress');
    progressReads += 1;
    return json(200, {items: (progressReads < 2 ? jobs : [jobs[0]]).map(snapshot)});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const [, first, second] = list.children;
    t.mock.timers.tick(500); await settle();
    t.mock.timers.tick(500); await settle();
    const visiblePartial = descendants(second).find(node => node.classList.contains('group-reply-preview'));
    assert.equal(visiblePartial.textContent, 'job-b 的片段', 'awaiting the committed message retains the last fragment');
    t.mock.timers.tick(350); await settle();
    assert.deepEqual(list.children.map(node => node.dataset.messageId), ['source', undefined, 'later', 'reply']);
    assert.equal(list.children[1], first);
    assert.equal(list.children[3], second);
    assert.equal(second.dataset.state, 'replied');
    assert.equal(second.hidden, false);
    assert.equal(second.children[0].textContent, '同名助手 · AI 智能体');
    assert.equal(second.children[1].textContent, reply.body);
  } finally { restore(); }
});

test('the first chat opens using the batched directory while people are pending without preloading artifacts', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: fallback, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: false});
  let releasePeople;
  let workRequests = 0;
  async function fetcher(path) {
    if (path.endsWith('/agents?limit=100&include=conversations')) {
      return json(200, {items: [{id: 'brief', name: 'Brief'}],
        conversations: [{id: 'brief-chat', agent_id: 'brief', title: 'Prior briefing', updated: 1}]});
    }
    if (path.endsWith('/members')) return new Promise(resolve => {releasePeople = resolve;});
    if (path.includes('/artifacts')) {
      workRequests += 1;
      return json(200, {items: []});
    }
    return fallback(path);
  }
  try {
    mount(doc, {fetcher});
    await settle();
    assert.ok(releasePeople);
    assert.equal(workRequests, 0);
    assert.ok(sessionRows(el).some(row => row.dataset.conversation === 'brief-chat'));
    assert.equal(el('message-list').children[0].dataset.messageId, 'm-1');
    assert.ok(!requests.some(path => path.includes('/agents/brief/conversations')));
    await fire(el('compose-add-contact'), 'click');
    assert.match(el('compose-members-empty').textContent, /正在加载/);
    releasePeople(json(200, {items: [{user_id: bob, username: 'bob'}]}));
    await settle();
    assert.equal(descendants(el('member-choices')).filter(node => node.tagName === 'INPUT')[0].value, bob);
  } finally { restore(); }
});

test('a narrow-screen chat starts on the conversation list and returns to it from the back control', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(sessionRows(el).length, 2, 'the fixture lists two conversations');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'no conversation is open yet, so the session list must be the pane the narrow stylesheet shows',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'opening a conversation must uncover it instead of leaving the list over it',
    );
    assert.equal(el('message-list').children.length, 1, 'the opened conversation renders its messages');

    assert.ok(el('chat-back'), 'the chat header offers a way back to the session list');
    await fire(el('chat-back'), 'click');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'the back control returns to the list so another conversation can be opened',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[1]});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), false, 'the second conversation opens the same way');
  } finally {
    restore();
  }
});

test('the 900px stylesheet restores the session pane for the sessions-open state', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const end = css.indexOf('}', css.indexOf('{', start)) > -1 ? css.indexOf('\n}', start) : -1;
  const block = css.slice(start, end);
  assert.match(
    block,
    /\.sessions-open\s*>\s*\.session-pane\s*\{\s*display:\s*flex/,
    'the rule that hides the pane at 900px needs a matching restore for the list state',
  );
});

test('the 900px stylesheet puts the chat panel back in the second column', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const block = css.slice(start, css.indexOf('\n}', start));
  for (const selector of ['#main', '#status']) {
    const rule = block.match(
      new RegExp(`body\\.app-workspace\\.chat-open\\s*>\\s*${selector}[^{]*\\{([^}]*)\\}`),
    );
    assert.ok(rule, `the two-column override at 900px must also move ${selector} out of column 3`);
    assert.match(
      rule[1],
      /grid-column:\s*2\b/,
      `${selector} is pinned to grid-column 3 by the shell stylesheet; without this the implicit third column collapses the session pane to its minimum`,
    );
  }
  // With the list shown, #main must leave the flow: otherwise it is auto-placed
  // in an implicit row below the pane and the 1fr row shrinks (pane 624px tall
  // instead of the full viewport).
  assert.match(
    block,
    /\.sessions-open\s*>\s*#main\s*\{\s*display:\s*none/,
    'the list state must hide the chat panel so the pane fills the viewport',
  );
});

test('a wide chat still opens the first conversation instead of stopping on the list', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'above 900px the list is shown beside the conversation, so no list state is applied',
    );
    assert.equal(el('message-list').children.length, 1, 'the first conversation still opens by default');
  } finally {
    restore();
  }
});

// The search panel is a child of the session pane, and the 900px stylesheet
// paints that pane only in the `sessions-open` state. With a conversation open
// the pane is display:none, so opening search without that state leaves the
// panel in the DOM and visible to script but zero by zero on screen.

function searchRequests(requests) {
  return requests.filter((path) => path.includes('/search/'));
}

function viewedConversationRequests(requests, id) {
  return requests.filter((path) => path === `/v1/workspaces/ws-1/social/conversations/${id}`);
}

test('a narrow chat shows the search panel over an open conversation by revealing the session pane', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), false, 'the conversation is the visible pane');

    await fire(el('message-search'), 'click');
    await settle();

    assert.equal(el('search-panel').hidden, false, 'the search panel is assigned the open state');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'the search panel lives inside the session pane, which the narrow stylesheet hides while a conversation is open; without the list state the panel is 0x0 on screen',
    );
    assert.equal(viewedConversationRequests(requests, 'conv-1').length, 1, 'opening search must not refetch the conversation');
    assert.equal(el('chat-title').textContent, 'bob', 'the open conversation is still the one named in the header');
  } finally {
    restore();
  }
});

test('closing search on a narrow screen returns to the conversation that was open', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    await fire(el('message-search'), 'click');
    await settle();

    await fire(el('search-close'), 'click');
    await settle();

    assert.equal(el('search-panel').hidden, true, 'closing search hides the panel again');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'the conversation, not the list, must be the visible pane after search closes',
    );
    assert.equal(el('message-list').children.length, 1, 'the opened conversation and its messages are still there');
    assert.equal(viewedConversationRequests(requests, 'conv-1').length, 1, 'the user does not have to open the conversation again');
  } finally {
    restore();
  }
});

test('closing search from the narrow session list keeps the list visible', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), true, 'the list is the visible pane before search');

    await fire(el('session-search'), 'focus');
    await settle();
    assert.equal(el('search-panel').hidden, false, 'typing in the list search opens the panel');

    await fire(doc, 'keydown', {key: 'Escape'});
    await settle();

    assert.equal(el('search-panel').hidden, true, 'Escape closes the panel');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'no conversation is open, so dropping the list state would leave the narrow screen blank',
    );
    assert.equal(sessionRows(el).length, 2, 'the conversation list is still rendered underneath');
  } finally {
    restore();
  }
});

test('closing search started from the session list keeps a previously opened conversation in the background', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('chat-back'), 'click');
    assert.equal(doc.body.classList.contains('sessions-open'), true);

    await fire(el('session-search'), 'focus');
    await fire(el('search-close'), 'click');

    assert.equal(doc.body.classList.contains('sessions-open'), true);
    assert.equal(el('conversation-heading').focused, true);
    assert.equal(viewedConversationRequests(requests, 'conv-1').length, 1);
  } finally {
    restore();
  }
});

test('a wide chat leaves the grid classes alone when search opens and closes', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(el('message-list').children.length, 1, 'the wide page opens the first conversation');

    await fire(el('message-search'), 'click');
    await settle();
    assert.equal(el('search-panel').hidden, false, 'search opens');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'above 900px the pane is never hidden, so no list state may be added',
    );

    await fire(el('search-close'), 'click');
    await settle();
    assert.equal(el('search-panel').hidden, true, 'search closes');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'closing search must not add a class the wide layout never uses',
    );
  } finally {
    restore();
  }
});

const openingVersion = 'a'.repeat(64);
const publicListingId = 'otl_' + 'A'.repeat(26);
const openingToken = 'c'.repeat(32);

test('public agent continuation only allows a slug, with an optional exclusive starter or opaque token', () => {
  const intent = {slug:'writing-demo', quickStart:0, version:openingVersion};
  const hash = '#public-agent=writing-demo&quick-start=0&quick-start-version=' + openingVersion;
  assert.equal(publicAgentContinuation(intent), hash);
  assert.deepEqual(publicAgentIntentFromHash(hash), intent);
  assert.deepEqual(publicAgentIntentFromHash('#public-agent=writing-demo'), {slug:'writing-demo'});
  const staged = '#public-agent=writing-demo&draft=' + openingToken;
  assert.equal(publicAgentContinuation({slug:'writing-demo', draft:openingToken}), staged);
  assert.deepEqual(publicAgentIntentFromHash(staged), {slug:'writing-demo', draft:openingToken});
  assert.equal(publicAgentContinuation({...intent, draft:openingToken}), '');
  for (const bad of [
    '#public-agent=writing-demo&quick-start=0', '#public-agent=writing-demo&quick-start-version=' + openingVersion,
    '#public-agent=%2F%2Fevil.test', '?start=1', hash + '&next=https://evil.test',
    hash + '&quick-start=2', hash.replace('=0', '=5'), hash.replace(openingVersion,'x'),
    hash + '&draft=' + openingToken, staged + '&draft=' + openingToken,
    staged.replace(openingToken, 'private%20draft'),
  ]) assert.equal(publicAgentIntentFromHash(bad), null, bad);
});

function publicOpeningView() {
  const saved = new Map();
  return {saved, view: {crypto:webcrypto, sessionStorage: {
    get length() { return saved.size; },
    key: index => [...saved.keys()][index],
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  }}};
}

test('public homepage drafts expire, stay in the original tab and are consumed once', () => {
  const {saved, view} = publicOpeningView();
  const params = {slug:'writing-demo', listingId:publicListingId, text:'首页草稿 & <draft>？'};
  const hash = stagePublicAgentOpening(view, params);
  const intent = publicAgentIntentFromHash(hash);
  assert.match(hash, /^#public-agent=writing-demo&draft=[a-f0-9]{32}$/);
  assert.equal(publicAgentOpening(publicOpeningView().view, intent), null);
  assert.equal(publicAgentOpening(view, {...intent, slug:'other-agent'}), null);
  assert.equal(publicAgentOpening(view, intent).text, params.text);
  assert.equal(publicAgentOpening(view, intent).listingId, publicListingId);
  consumePublicAgentOpening(view, intent);
  assert.equal(publicAgentOpening(view, intent), null);
  const expired = publicAgentIntentFromHash(stagePublicAgentOpening(view, params));
  const key = [...saved.keys()][0];
  saved.set(key, JSON.stringify({...JSON.parse(saved.get(key)), expiresAt:Date.now() - 1}));
  assert.equal(publicAgentOpening(view, expired), null);
  assert.equal(saved.size, 0);
  assert.equal(stagePublicAgentOpening(view, {...params, text:'a'.repeat(4001)}), '');
});

test('homepage composer only navigates with an opaque fragment and reports storage failure inline', async () => {
  const {view} = publicOpeningView();
  const {doc, el} = fakeChatDocument('<form id="public-agent-composer"></form><p id="public-agent-composer-status" hidden></p>');
  const form = el('public-agent-composer');
  const textarea = new FakeElement('textarea');
  const button = new FakeElement('button');
  const pageEvents = [];
  const destinations = [];
  form.dataset = {slug:'writing-demo', listingId:publicListingId};
  form.querySelector = selector => selector === 'textarea[name="message"]' ? textarea : button;
  view.addEventListener = (_name, handler) => pageEvents.push(handler);
  view.location = {assign: path => destinations.push(path)};
  doc.defaultView = view;
  mountPublicAgentComposer(doc);
  assert.equal(button.disabled, true);
  textarea.value = '你好，整理一下这份资料';
  await fire(textarea, 'input');
  assert.equal(button.disabled, false);
  let prevented = false;
  const event = {preventDefault: () => { prevented = true; }};
  const storage = view.sessionStorage;
  view.sessionStorage = null;
  await fire(form, 'submit', event);
  assert.equal(prevented, true);
  assert.equal(el('public-agent-composer-status').hidden, false);
  assert.equal(destinations.length, 0);
  view.sessionStorage = storage;
  await fire(form, 'submit', event);
  assert.match(destinations[0], /^\/login#public-agent=writing-demo&draft=[a-f0-9]{32}$/);
  assert.equal(button.disabled, true);
  pageEvents[0]({persisted:true});
  assert.equal(button.disabled, false);
  assert.equal(el('public-agent-composer-status').hidden, true);
});

test('a versioned public quick start opens a conversation and stages the composer without sending', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  const calls = [];
  const conversation = {id:'otc_test_1', kind:'group', title:'文档助手', public_agent:{open:true}, members:[]};
  const base = '/v1/workspaces/ws-1/social/conversations';
  const hash = publicAgentContinuation({slug:'writing-demo', quickStart:0, version:openingVersion});
  const starter = '列出这个助手能做什么';
  const {fetcher: fallback} = chatFetcher();
  const fetcher = async (path, options = {}) => {
    calls.push({path, method:options.method || 'GET'});
    if (path === '/v1/discover/agents/writing-demo/start') {
      assert.equal(options.method,'POST');
      assert.deepEqual(JSON.parse(options.body), {quick_start:0, quick_start_version:openingVersion});
      return json(200, {workspace_id:'ws-1', conversation_id:conversation.id, draft_text:starter});
    }
    if (path === `${base}/${conversation.id}`) return json(200, {conversation, items:[]});
    return fallback(path);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = hash;
  const writes = [];
  globalThis.history.replaceState = (_state, _title, href) => {
    writes.push(href);
    globalThis.location.hash = href.includes('#') ? '#' + href.split('#').pop() : '';
  };
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(calls.filter(({path}) => path.endsWith('/start')).length, 1);
    assert.equal(calls.filter(({method,path}) => method === 'POST' && path.endsWith('/messages')).length, 0);
    assert.equal(el('chat-body').value, starter);
    assert.equal(el('chat-body').focused, true);
    assert.equal(el('message-list').children.length, 0);
    assert.equal(writes.at(-1), '/chat#workspace=ws-1&social=' + conversation.id);
  } finally { restore(); }
});

test('homepage draft survives start and conversation retry, then attaches once to the verified thread', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {view} = publicOpeningView();
  doc.defaultView = view;
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  const typed = '我的首页草稿\n两行都要保留。';
  const hash = stagePublicAgentOpening(view, {slug:'writing-demo', listingId:publicListingId, text:typed});
  const intent = publicAgentIntentFromHash(hash);
  const conversation = {id:'otc_home_open', kind:'group', title:'文档助手', public_agent:{open:true}, members:[]};
  const calls = [];
  let starts = 0;
  let details = 0;
  const {fetcher: fallback} = chatFetcher();
  const fetcher = async (path, options = {}) => {
    calls.push({path, method:options.method || 'GET', body:options.body});
    if (path === '/v1/discover/agents/writing-demo/start') {
      assert.deepEqual(JSON.parse(options.body), {listing_id:publicListingId});
      return ++starts === 1 ? json(503, {}) : json(200, {workspace_id:'ws-1', conversation_id:conversation.id});
    }
    if (path === '/v1/workspaces/ws-1/social/conversations/' + conversation.id) {
      return ++details === 1 ? json(503, {}) : json(200, {conversation, items:[]});
    }
    return fallback(path);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = hash;
  globalThis.history.replaceState = (_state, _title, href) => {
    globalThis.location.hash = href.includes('#') ? '#' + href.split('#').pop() : '';
  };
  try {
    view.sessionStorage.setItem(
      'flybot-workspace.public-agent-draft:' + JSON.stringify(['user-1','ws-1','social',undefined,conversation.id]),
      '已有对话草稿',
    );
    await mount(doc, {fetcher});
    assert.equal(starts, 1);
    assert.equal(details, 0);
    assert.equal(publicAgentOpening(view, intent).text, typed);
    let retry = el('status').children.findLast(node => node.id === 'public-agent-retry');
    await fire(retry, 'click');
    assert.equal(details, 1);
    assert.equal(publicAgentOpening(view, intent).text, typed);
    retry = el('status').children.findLast(node => node.id === 'public-agent-retry');
    await fire(retry, 'click');
    await settle();
    assert.equal(starts, 3);
    assert.equal(details, 2);
    assert.equal(el('chat-body').value, '已有对话草稿\n\n' + typed);
    assert.equal(el('chat-body').focused, true);
    assert.equal(publicAgentOpening(view, intent), null);
    assert.equal(globalThis.location.hash, '#workspace=ws-1&social=' + conversation.id);
    assert.ok(calls.every(({method,path,body}) => !(method === 'POST' && path.endsWith('/messages')) && !String(body).includes('首页草稿')));
  } finally { restore(); }
});

test('public draft preserves the edited text for its owner and thread, clearing when sent', async () => {
  const saved = new Map();
  const defaultView = {sessionStorage:{getItem:key => saved.get(key) || null,
    setItem:(key, value) => saved.set(key,value), removeItem:key => saved.delete(key)}};
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = defaultView;
  const draft = mountPublicDraft(doc);
  draft.enter('alice/thread', true);
  assert.equal(draft.fill('公开开场'), true);
  el('chat-body').value = '改过的开场';
  await fire(el('chat-body'), 'input');
  draft.enter('bob/thread', true);
  assert.equal(el('chat-body').value,'');
  const {doc:reopened,el:field} = fakeChatDocument(chatHtml());
  reopened.defaultView = defaultView;
  const restored = mountPublicDraft(reopened);
  restored.enter('alice/thread', true);
  restored.fill('第二个快捷开场');
  assert.equal(field('chat-body').value, '改过的开场');
  field('chat-body').value = '';
  restored.persist();
  assert.equal(saved.size,0);
});

test('authenticated composer drafts flush on page exit and remain scoped to account, workspace and conversation', async () => {
  const saved = new Map();
  const view = new EventTarget();
  view.sessionStorage = {getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)};
  function drafts(onChange) {
    const {doc, el} = fakeChatDocument(chatHtml());
    doc.defaultView = view;
    return {composer: mountPublicDraft(doc, {onChange}), field: el('chat-body')};
  }
  const group = JSON.stringify(['alice', 'workspace', 'social', null, 'group']);
  const otherGroup = JSON.stringify(['alice', 'workspace', 'social', null, 'other-group']);
  const otherWorkspace = JSON.stringify(['alice', 'another-workspace', 'social', null, 'group']);
  const otherAccount = JSON.stringify(['bob', 'workspace', 'social', null, 'group']);
  const changes = [];
  const {composer, field} = drafts((...values) => changes.push(values));
  composer.enter(group);
  field.value = '不发送。<草稿>';
  await fire(field, 'input');
  assert.deepEqual(changes, [[group, field.value, '']]);
  assert.equal(saved.size, 0, 'typing avoids a synchronous storage write');
  view.dispatchEvent(new Event('pagehide'));
  const reopened = drafts();
  assert.equal(reopened.composer.lookup(otherWorkspace), '');
  assert.equal(reopened.composer.lookup(otherAccount), '');
  reopened.composer.enter(otherGroup);
  assert.equal(reopened.field.value, '');
  reopened.composer.enter(group);
  assert.equal(reopened.field.value, field.value);
  reopened.field.value = '';
  reopened.composer.persist();
  assert.equal(drafts().composer.lookup(group), '');
});

test('new scoped private drafts move to the committed conversation in storage and can be forgotten', async () => {
  const saved = new Map();
  const defaultView = {sessionStorage: {getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)}};
  function drafts() {
    const {doc, el} = fakeChatDocument(chatHtml());
    doc.defaultView = defaultView;
    return {composer: mountPublicDraft(doc), field: el('chat-body')};
  }
  const newScope = JSON.stringify(['alice', 'workspace', 'agent', 'agent', null]);
  const savedScope = JSON.stringify(['alice', 'workspace', 'agent', 'agent', 'exact']);
  const {composer, field} = drafts();
  composer.enter(newScope);
  field.value = '第一条正在发送时写的第二条';
  await fire(field, 'input');
  composer.move(newScope, savedScope);
  const reopened = drafts();
  assert.equal(reopened.composer.lookup(newScope), '');
  reopened.composer.enter(savedScope);
  assert.equal(reopened.field.value, field.value);
  reopened.composer.forget(savedScope);
  assert.equal(reopened.field.value, '');
  assert.equal(drafts().composer.lookup(savedScope), '');
});

test('draft typing during native conversation creation follows the committed thread', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const draft = mountPublicDraft(doc);
  const input = el('chat-body');
  draft.enter('alice/agent/new');
  input.value = '第一条正在发送时的下一份草稿';
  await fire(input, 'input');
  draft.move('alice/agent/new', 'alice/agent/thread');
  draft.enter('alice/agent/new');
  assert.equal(input.value, '');
  draft.enter('alice/agent/thread');
  assert.equal(input.value, '第一条正在发送时的下一份草稿');
});

test('an offscreen private draft follows its new thread without changing the active composer', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const draft = mountPublicDraft(doc);
  const input = el('chat-body');
  draft.enter('alice/agent/new');
  input.value = '同一智能体的下一条问题';
  await fire(input, 'input');
  draft.enter('alice/other');
  input.value = '当前打开的其他会话';
  draft.move('alice/agent/new', 'alice/agent/created');
  assert.equal(input.value, '当前打开的其他会话');
  draft.enter('alice/agent/created');
  assert.equal(input.value, '同一智能体的下一条问题');
  draft.enter('alice/agent/new');
  assert.equal(input.value, '');
});

test('an over-limit homepage draft stays recoverable without changing the owner and thread composer', async () => {
  const {view} = publicOpeningView();
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = view;
  const draft = mountPublicDraft(doc);
  draft.enter('alice/thread', true);
  const existing = '旧'.repeat(4000);
  const typed = '新草稿';
  assert.equal(draft.fill(existing), true);
  assert.equal(draft.fillOpening(typed), 'saved');
  assert.equal(el('chat-body').value, existing);
  assert.equal(el('public-draft-recovery').hidden, false);
  assert.equal(el('public-draft-recovery-text').value, typed);
  draft.enter('bob/thread', true);
  assert.equal(el('public-draft-recovery').hidden, true);
  assert.equal(el('public-draft-recovery-text').value, '');
  const {doc: reloaded, el: field} = fakeChatDocument(chatHtml());
  reloaded.defaultView = view;
  const restored = mountPublicDraft(reloaded);
  restored.enter('alice/thread', true);
  assert.equal(field('chat-body').value, existing);
  assert.equal(field('public-draft-recovery-text').value, typed);
  await fire(field('public-draft-recovery-clear'), 'click');
  assert.equal(field('public-draft-recovery').hidden, true);
  assert.equal(field('chat-body').value, existing);
});

test('message search tab switches await the in-flight query and newer queries win', async () => {
  const {createMessageSearch} = await import('../flybot_workspace/static/chat/app.mjs');
  const resolvers = [];
  const search = createMessageSearch(() => new Promise(resolve => resolvers.push(resolve)));
  const first = search.load('old');
  const same = search.load('old');
  assert.equal(resolvers.length, 1, 'a tab switch reuses the pending search');
  resolvers[0]({items: [{kind: 'social', message_id: 'old', snippet: 'old'}]});
  await Promise.all([first, same]);
  assert.equal(search.state.hits.length, 1);
  const stale = search.load('stale');
  const latest = search.load('latest');
  resolvers[2]({items: [{kind: 'social', message_id: 'latest', snippet: 'latest'}]});
  await latest;
  resolvers[1]({items: [{kind: 'social', message_id: 'stale', snippet: 'stale'}]});
  await stale;
  assert.equal(search.state.hits[0].messageId, 'latest');
});

test('social sessions retain server unread counts without inventing agent unread state', () => {
  const rows = mergeSessions([], [{id: 'social-unread', kind: 'group', title: 'Group', unread_count: 3}], 'alice');
  assert.equal(rows[0].unread_count, 3);
});


for (const mode of ['visible', 'hidden', 'failed']) {
  test('social unread acknowledgement is snapshot bounded: ' + mode, async () => {
    const {doc, el} = fakeChatDocument(chatHtml());
    const {fetcher: original} = sessionFetcher();
    const posts = [];
    doc.visibilityState = mode === 'hidden' ? 'hidden' : 'visible';
    const fetcher = async (path, options = {}) => {
      if (path.endsWith('/conv-1/read')) {
        posts.push(JSON.parse(options.body));
        return json(mode === 'failed' ? 500 : 200, {unread_count: 1});
      }
      const result = await original(path, options);
      const body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      if (path.endsWith('/social/conversations/conv-1')) {
        body.conversation.unread_count = 2;
        body.items.push({id: 'm-2', user_id: bob, body: 'second', created: '2026-01-01T00:00:01Z'});
      }
      return json(result.status, body);
    };
    const restore = installChatGlobals({narrow: true});
    try {
      await mount(doc, {fetcher});
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, '2');
      await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
      if (mode === 'hidden') assert.equal(posts.length, 0);
      else assert.deepEqual(posts, [{message_id: 'm-2'}]);
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, mode === 'visible' ? '1' : '2');
    } finally { restore(); }
  });
}


test('social pinned state sorts before recency and unread filter uses server state', () => {
  const rows = mergeSessions([], [
    {id: 'new', kind: 'dm', updated: 20, unread_count: 1},
    {id: 'old', kind: 'group', updated: 1, pinned: true},
  ], alice);
  assert.equal(rows[0].id, 'old');
  assert.equal(rows[1].unread_count, 1);
});

function pinConversationFixture() {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: base} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const calls = [];
  const saved = Promise.withResolvers();
  const fetcher = async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET', body: options.body});
    if (path.endsWith('/conv-2/preferences')) return saved.promise;
    const result = await base(path);
    const body = await result.json();
    if (body.conversation?.id === 'conv-2') body.conversation = {...body.conversation, kind: 'group', title: 'Project Room'};
    if (path.endsWith('/social/conversations?limit=100')) {
      body.items = body.items.map(item => item.id === 'conv-2' ? {...item, kind: 'group', title: 'Project Room'} : item);
    }
    return json(result.status, body);
  };
  const open = id => fire(el('conversation-list'), 'click', {
    target: sessionRows(el).find(row => row.dataset.conversation === id),
  });
  return {doc, el, restore, calls, saved, fetcher, open};
}

test('conversation pin shares controls, reorders immediately, and never reopens an old chat after saving', async () => {
  const {doc, el, restore, calls, saved, fetcher, open} = pinConversationFixture();
  try {
    await mount(doc, {fetcher});
    await open('conv-2');
    const before = calls.length;
    const saving = fire(el('group-info-pin'), 'click');
    await settle();
    assert.equal(el('group-info-pin').getAttribute('aria-checked'), 'true');
    assert.equal(el('pin-conversation').textContent, '取消置顶');
    assert.equal(el('group-info-pin').disabled, true);
    assert.equal(el('pin-conversation').disabled, true);
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-2');
    await fire(el('pin-conversation'), 'click');
    assert.deepEqual(calls.slice(before).map(call => [call.method, call.path.split('/').at(-1), JSON.parse(call.body)]),
      [['POST', 'preferences', {pinned: true}]]);

    await open('conv-1');
    const afterNavigation = calls.length;
    assert.equal(el('pin-conversation').disabled, false);
    saved.resolve(json(200, {pinned: true}));
    await saving;
    assert.equal(calls.length, afterNavigation, 'saving only updates the already-loaded directory and controls');
    assert.equal(sessionRows(el).find(row => row.getAttribute('aria-current') === 'true').dataset.conversation, 'conv-1');
    assert.equal(el('pin-conversation').textContent, '置顶会话');
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-2');
  } finally {
    saved.resolve(json(503, {}));
    restore();
  }
});

test('a failed pin rolls back both surfaces and the sidebar without fetching the conversation again', async () => {
  const {doc, el, restore, calls, saved, fetcher, open} = pinConversationFixture();
  try {
    await mount(doc, {fetcher});
    await open('conv-2');
    const before = calls.length;
    const saving = fire(el('pin-conversation'), 'click');
    await settle();
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-2');
    assert.equal(el('group-info-pin').getAttribute('aria-checked'), 'true');
    saved.resolve(json(503, {}));
    await saving;
    assert.equal(calls.length, before + 1);
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-1');
    assert.equal(el('group-info-pin').getAttribute('aria-checked'), 'false');
    assert.equal(el('pin-conversation').textContent, '置顶会话');
    assert.equal(el('pin-conversation').disabled, false);
    assert.match(el('status').textContent, /置顶未保存/);
  } finally {
    saved.resolve(json(503, {}));
    restore();
  }
});

test('session filter selects only real unread social rows', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      return json(result.status, body);
    }});
    el('session-filter-value').value = 'unread';
    await fire(el('session-filter-value'), 'change');
    assert.equal(sessionRows(el).length, 1);
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-1');
    assert.equal(el('session-filter-clear').hidden, false);
    assert.match(sessionRows(el)[0].getAttribute('aria-label'), /2 条未读消息/);
    await fire(el('session-filter-clear'), 'click');
    assert.equal(el('session-filter-value').value, 'all');
    assert.equal(el('session-filter-clear').hidden, true);
    assert.equal(el('session-filter').focused, true);
    assert.equal(sessionRows(el).length, 2);
  } finally { restore(); }
});

test('the inbox filters personal agents and persists bulk-read and mute', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const unread = new Set(['conv-1', 'conv-2']);
  const writes = [];
  const noticeFetches = [];
  const follow = {id:'follow-notice', kind:'follow.new', created:10, read:false, by:{display_name:'Follower'}};
  const mention = {id:'mention-notice', kind:'messenger.mention', created:11, read:false, conversation_id:'conv-1',
    by:{display_name:'Mention sender'}};
  let muted = false;
  let pendingNotifications;
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}, agent: {id: 'personal'}}});
      if (path.endsWith('/agents?limit=100&include=conversations')) return json(200, {items: [{id: 'personal', name: 'Personal'}]});
      if (path.endsWith('/agents/personal/conversations?limit=100')) return json(200, {items: [{id: 'personal-chat'}]});
      if (path.endsWith('/read')) {
        const id = path.split('/').at(-2);
        writes.push([id, JSON.parse(init.body)]);
        unread.delete(id);
        return json(200, {unread_count: 0});
      }
      if (path.endsWith('/conv-1/preferences')) {
        muted = JSON.parse(init.body).muted;
        return json(200, {muted});
      }
      if (path.endsWith('/notifications')) {
        noticeFetches.push(muted);
        const items = muted ? [follow] : [mention, follow];
        if (pendingNotifications) await pendingNotifications.promise;
        return json(200, {items, unread_count:items.length});
      }
      const response = await original(path);
      const data = await response.json();
      if (path.endsWith('/social/conversations?limit=100')) return json(200, {
        items: data.items.map(row => ({...row, unread_count: Number(unread.has(row.id)), muted: row.id === 'conv-1' && muted})),
      });
      if (path.endsWith('/conv-1')) return json(200, {...data, conversation: {...data.conversation, muted}});
      return json(response.status, data);
    }});
    const filter = el('session-filter-value');
    filter.value = 'personal';
    await fire(filter, 'change');
    assert.deepEqual(sessionRows(el).map(row => row.dataset.conversation), ['personal-chat']);
    assert.equal(el('conversation-heading').textContent, '对话 · 1');
    filter.value = 'all';
    await fire(filter, 'change');
    assert.equal(el('conversations-read-all').hidden, false);
    await fire(el('conversations-read-all'), 'click');
    assert.deepEqual(writes, [['conv-1', {}], ['conv-2', {}]]);
    assert.equal(el('conversations-read-all').hidden, true);
    const row = sessionRows(el).find(item => item.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target: row});
    await fire(el('notifications-toggle'), 'click');
    assert.equal(el('notifications-panel').hidden, false);
    assert.equal(el('notification-count').textContent, '2');
    const previousNotificationReads = noticeFetches.length;
    pendingNotifications = Promise.withResolvers();
    await fire(el('mute-conversation'), 'click');
    assert.equal(el('notification-list').children.length, 0, 'do not reactivate cached rows under the new visibility scope');
    pendingNotifications.resolve();
    pendingNotifications = null;
    await settle(2);
    assert.equal(muted, true);
    assert.deepEqual(noticeFetches.slice(previousNotificationReads), [true]);
    assert.equal(el('notifications-panel').hidden, false);
    assert.equal(el('notification-count').textContent, '1');
    assert.deepEqual(el('notification-list').children.map(entry => entry.children[0].dataset.notification), [follow.id]);
    assert.equal(el('mute-conversation').getAttribute('aria-pressed'), 'true');
    assert.match(sessionRows(el).find(item => item.dataset.conversation === 'conv-1').getAttribute('aria-label'), /免打扰/);
    await fire(el('mute-conversation'), 'click');
    await settle(2);
    assert.equal(muted, false);
    assert.equal(el('notification-count').textContent, '2');
    assert.deepEqual(el('notification-list').children.map(entry => entry.children[0].dataset.notification), [mention.id, follow.id]);
  } finally { restore(); }
});

test('muted sessions have no sidebar unread badge and bulk-read leaves their cursor alone', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const writes = [];
  try {
    await mount(doc, {fetcher: async (path) => {
      if (path.endsWith('/read')) {
        writes.push(path);
        return json(200, {unread_count: 0});
      }
      const response = await original(path);
      const data = await response.json();
      if (path.endsWith('/social/conversations?limit=100')) return json(200, {
        items: data.items.map(item => ({...item, muted:item.id === 'conv-1', unread_count:3})),
      });
      return json(response.status, data);
    }});
    const muted = sessionRows(el).find(item => item.dataset.conversation === 'conv-1');
    assert.ok(muted.classList.contains('is-muted'));
    assert.equal(muted.classList.contains('is-unread'), false);
    assert.doesNotMatch(muted.getAttribute('aria-label'), /未读消息/);
    assert.equal(muted.querySelector('.unread-badge'), null);
    const filter = el('session-filter-value');
    filter.value = 'unread';
    await fire(filter, 'change');
    assert.deepEqual(sessionRows(el).map(item => item.dataset.conversation), ['conv-2']);
    await fire(el('conversations-read-all'), 'click');
    assert.deepEqual(writes, ['/v1/workspaces/ws-1/social/conversations/conv-2/read']);
  } finally { restore(); }
});

test('independent conversation search uses current id and pages without opening sidebar search', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const calls = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/social/conversations/conv-1/messages?q=')) {
        calls.push(path);
        const url = new URL(path, 'https://management.test');
        assert.equal(url.pathname, '/v1/workspaces/ws-1/social/conversations/conv-1/messages');
        return json(200, {items: [{kind: 'social', conversation_id: 'conv-1', id: url.searchParams.get('before') ? 'second' : 'first', body: 'Scoped result'}], cursor: url.searchParams.get('before') ? null : 42});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    assert.equal(el('conversation-search-panel').hidden, false);
    el('conversation-search-query').value = 'needle';
    await fire(el('conversation-search-form'), 'submit', {preventDefault() {}});
    const firstHit = el('conversation-search-results').children[0].children[0];
    assert.equal(firstHit.className, 'search-hit');
    assert.equal(firstHit.tagName, 'BUTTON');
    assert.ok(descendants(firstHit).some(node => node.textContent === 'Scoped result'), 'snippet is rendered in the hit row');
    assert.equal(el('conversation-search-more').hidden, false);
    await fire(el('conversation-search-more'), 'click');
    assert.equal(calls.length, 2);
    assert.equal(el('conversation-search-results').children.length, 2);
    assert.match(calls[1], /before=42/);
  } finally { restore(); }
});

test('own message editing and confirmed retraction call versioned endpoints', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  let text = 'Original', revision = 1, retracted = false;
  const message = () => ({id:'mine-1', seq:1, user_id:'social-owner', mine:true, workspace_id:'ws-1', conversation_id:'conv-1',
    body:text, revision, retracted, edited:revision > 1 ? 15 : null});
  const waiting = Promise.withResolvers();
  let holdDirectory = false;
  let transcriptReads = 0;
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.includes('/messages/mine-1/')) {
        const payload = JSON.parse(options.body); posts.push([path, payload]);
        assert.equal(payload.revision, revision);
        revision += 1;
        if (path.endsWith('/edit')) text = payload.body;
        else { text = ''; retracted = true; }
        return json(200, {message:message()});
      }
      if (holdDirectory && path.endsWith('/agents?limit=100&include=conversations')) await waiting.promise;
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) {
        transcriptReads += 1;
        body.items = [message()];
      }
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    holdDirectory = true;
    const transcriptBefore = transcriptReads;
    el('chat-body').value = 'Independent draft';
    let li = el('message-list').children[0];
    await fire(li.children[3], 'click'); // edit opens inline controls
    li.children[5].children[0].value = 'Edited';
    await fire(li.children[5].children[1], 'click'); // only opens the confirm step
    assert.equal(posts.length, 0);
    await fire(li.children[5].children[1], 'click'); // 确认修改
    assert.equal(text, 'Edited');
    li = el('message-list').children[0];
    await fire(li.children[4], 'click'); // only opens confirmation
    assert.equal(posts.length, 1);
    await fire(li.children[5].children[0], 'click');
    assert.equal(posts.length, 2);
    assert.equal(el('message-list').children[0].children[1].textContent, '此消息已撤回');
    assert.equal(transcriptReads, transcriptBefore);
    assert.equal(el('chat-body').value, 'Independent draft');
  } finally { waiting.resolve(); await settle(); restore(); }
});

test('editing a sent message adds a confirm step before the text is replaced', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  let text = 'Original', revision = 1;
  const message = () => ({id:'mine-1', seq:1, user_id:alice, workspace_id:'ws-1', conversation_id:'conv-1',
    body:text, revision, retracted:false, edited:revision > 1 ? 15 : null});
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.includes('/messages/mine-1/')) {
        const payload = JSON.parse(options.body); posts.push([path, payload]);
        revision += 1; text = payload.body;
        return json(200, {message:message()});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) {
        body.items = [message()];
      }
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const controls = () => el('message-list').children[0].children[5];
    const buttons = () => descendants(controls()).filter(node => node.tagName === 'BUTTON');
    await fire(el('message-list').children[0].children[3], 'click'); // 编辑
    controls().children[0].value = 'Edited';
    await fire(controls().children[1], 'click'); // 保存修改
    assert.equal(posts.length, 0, '保存修改 must not send the edit on its own');
    assert.equal(el('message-list').children[0].children[1].textContent, 'Original',
      'the sent text is unchanged until the confirm step');
    const confirm = buttons().find(node => node.textContent === '确认修改');
    assert.ok(confirm, 'a 确认修改 button is shown before the edit is sent');
    assert.equal(buttons().some(node => node.textContent === '保存修改'), false,
      '保存修改 is replaced by the confirm step');
    assert.ok(descendants(controls()).some(node => node.tagName !== 'BUTTON' && /替换/.test(node.textContent || '')),
      'the confirm step says the sent message is replaced, not appended');
    const cancel = buttons().find(node => node.textContent === '取消');
    assert.ok(cancel, '取消 is offered in the confirm step');
    await fire(cancel, 'click');
    assert.equal(posts.length, 0, '取消 sends nothing');
    assert.equal(controls().children.length, 0, '取消 closes the confirm step');
    await fire(el('message-list').children[0].children[3], 'click');
    controls().children[0].value = 'Edited again';
    await fire(controls().children[1], 'click');
    await fire(buttons().find(node => node.textContent === '确认修改'), 'click');
    assert.equal(posts.length, 1);
    assert.match(posts[0][0], /messages\/mine-1\/edit$/);
    assert.equal(text, 'Edited again');
    assert.equal(el('message-list').children[0].children[1].textContent, 'Edited again');
  } finally { restore(); }
});


test('visual session groups use real pins and preserve order within each group', async () => {
  const {groupSessionsForDisplay, sessionDisplayGroup} = await import('../flybot_workspace/static/chat/app.mjs');
  const items = [{id: 'g', kind: 'group'}, {id: 'a', source: 'agent'}, {id: 'p', pinned: true, kind: 'group'}, {id: 'd', kind: 'dm'}];
  assert.deepEqual(groupSessionsForDisplay(items).map(row => row.id), ['p', 'a', 'd', 'g']);
  assert.deepEqual(items.map(row => row.id), ['g', 'a', 'p', 'd']);
  assert.equal(sessionDisplayGroup(items[0]), '群聊');
  assert.equal(sessionDisplayGroup(items[2]), '置顶');
});

test('session timestamps use Hong Kong calendar boundaries and never invent unread state', async () => {
  const {formatSessionTime} = await import('../flybot_workspace/static/chat/app.mjs');
  const seconds = value => Date.parse(value) / 1000;
  const now = Date.parse('2026-11-19T00:01:00+08:00');
  assert.equal(formatSessionTime(seconds('2026-11-18T23:59:00+08:00'), now), '昨天');
  assert.equal(formatSessionTime(seconds('2026-11-19T00:00:00+08:00'), now), '00:00');
  assert.match(formatSessionTime(seconds('2026-11-10T12:00:00+08:00'), now), /2026/);
  assert.equal(formatSessionTime('invalid', now), '');
});

test('icon chat controls have accessible names and a direct file picker', () => {
  const html = chatHtml();
  assert.match(html, /id="conversation-search-open"[^>]*aria-label="搜索当前会话"[\s\S]*?<svg/);
  assert.match(html, /id="chat-call" hidden aria-label="通话" aria-haspopup="dialog"/);
  assert.match(html, /id="chat-attachment-open"[^>]*aria-label="发送文件"/);
  assert.match(html, /id="chat-attachment"[^>]*multiple hidden/);
  assert.match(html, /id="voice-record"[^>]*aria-label="录制语音"/);
  assert.match(html, /id="voice-preview" controls/);
});

import {notificationBadgeText, notificationSummary, notificationTarget} from '../flybot_workspace/static/chat/app.mjs';

test('notification badge and summary text', () => {
  assert.equal(notificationBadgeText(0), '');
  assert.equal(notificationBadgeText(3), '3');
  assert.equal(notificationBadgeText(120), '99+');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'group', conversation_title: '项目群'}),
    'bob 在「项目群」提及了你');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'dm', conversation_title: 'bob'}),
    'bob 在「单聊」提及了你');
  assert.equal(notificationSummary({kind: 'messenger.added', by: {display_name: '小林'}, title: '项目群'}),
    '小林 将你加入「项目群」');
  assert.equal(notificationSummary({kind: 'messenger.call', by: {display_name: '小林'}, title: '项目群', call_kind: 'video'}),
    '小林 在「项目群」发起了视频通话');
  assert.equal(notificationSummary({kind: 'meeting.shared', organizer: '小林', title: '设计评审'}),
    '小林 分享了纪要「设计评审」');
  assert.equal(notificationSummary({kind: 'discover.published', listing_kind: 'agent', actor_username: '小林', title: '日程助手'}),
    '小林 发布了新智能体「日程助手」');
  assert.equal(notificationSummary({kind: 'artifact.shared', actor_username: '小林', title: '排期表'}),
    '小林 分享了作品「排期表」');
  for (const [status, phrase] of [['succeeded','已完成'], ['failed','失败'], ['timeout','已超时'], ['interrupted','已中断']]) {
    assert.equal(notificationSummary({kind:'automation.run_finished', title:'每日摘要', status}), '「每日摘要」运行' + phrase);
  }
});

test('notification targets only resolve exact receipt scope and safe public listing slugs', () => {
  const workspace = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const share = 'c'.repeat(32);
  const path = `/meetings#workspace=${workspace}&shared=${share}`;
  const meeting = {kind: 'meeting.shared', workspace_id: workspace, share_id: share};
  assert.equal(notificationTarget(meeting, workspace), path);
  assert.equal(notificationTarget({kind: 'meeting.shared', path}, workspace), path);
  assert.equal(notificationTarget({...meeting, path}, other), null);
  assert.equal(notificationTarget({...meeting, path: path + '&new=1'}, workspace), null);
  assert.equal(notificationTarget({...meeting, path: path.replace(share, other)}, workspace), null);
  assert.equal(notificationTarget({...meeting, path: '//outside.example'}, workspace), null);
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'work', slug: 'published-work'}), '/w/published-work');
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'agent', slug: 'assistant-app'}), '/a/assistant-app');
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'agent', slug: 'assistant-app', path: '/w/assistant-app'}), null);
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'work', slug: '../settings'}), null);
  assert.equal(notificationTarget({kind: 'follow_work', path: '/w/legacy-slug'}), '/w/legacy-slug');
  assert.equal(notificationTarget({kind: 'follow_work', path: 'https://outside.example/w/legacy-slug'}), null);
  assert.equal(notificationTarget({kind: 'automation_reminder', path: '/wrong'}), '/automations');
  const run = {kind:'automation.run_finished', workspace_id:workspace, automation_id:other, run_id:share};
  const runPath = `/automations?workspace=${workspace}&automation=${other}&run=${share}`;
  assert.equal(notificationTarget(run, workspace), runPath);
  assert.equal(notificationTarget({...run, path:runPath}, workspace), runPath);
  assert.equal(notificationTarget(run, other), null);
  assert.equal(notificationTarget({...run, run_id:'../settings'}, workspace), null);
  assert.equal(notificationTarget({...run, path:'https://outside.example' + runPath}, workspace), null);
  const conversation = 'otc_' + 'A'.repeat(26);
  const message = 'otm_' + 'B'.repeat(26);
  const work = {kind: 'artifact.shared', workspace_id: workspace, conversation_id: conversation, message_id: message};
  const expected = `/chat#workspace=${workspace}&social=${conversation}&message=${message}`;
  assert.equal(notificationTarget({...work, path: expected}, workspace), expected);
  assert.equal(notificationTarget(work, other), null);
  assert.equal(notificationTarget({...work, message_id: '../settings'}, workspace), null);
  assert.equal(notificationTarget({...work, path: '//outside.example'}, workspace), null);
  const taskShare = 'otsr_' + '0'.repeat(26);
  const task = {kind: 'team.run_shared', workspace_id: workspace, share_id: taskShare,
    title: '评审纪要', actor_username: '小林'};
  const taskPath = '/team-runs#workspace=' + workspace + '&shared=' + taskShare;
  assert.equal(notificationSummary(task), '小林 分享了协作结果「评审纪要」');
  assert.equal(notificationTarget({...task, path: taskPath}, workspace), taskPath);
  assert.equal(notificationTarget(task, other), null);
  const ownership = {kind: 'team.owner_transferred', workspace_id: workspace, team_name: '设计组'};
  assert.equal(notificationSummary(ownership), '你已成为「设计组」的所有者');
  assert.equal(notificationTarget(ownership, workspace), '/members#workspace=' + workspace);
  assert.equal(notificationTarget(ownership, other), null);
  assert.equal(notificationTarget({...task, path: taskPath + '&run=' + share}, workspace), null);
});

test('mention notifications show a badge, open the conversation and mark read', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const posts = [];
  let unread = 1;
  const inbox = () => ({unread_count: unread, limit: 100, items: [{
    id: 'n'.repeat(32), kind: 'mention', conversation_id: 'conv-1', conversation_kind: 'group',
    conversation_title: '项目群', message_id: 'm-1', actor_username: 'bob', excerpt: '@alice 看一下',
    created: 30, read: unread === 0}, {
    id: 'o'.repeat(32), kind: 'automation_reminder', title: '提醒', created: 20, read: true,
  }]});
  try {
    await mount(doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/notifications' || path === '/v1/workspaces/ws-1/notifications?filter=unread') return json(200, inbox());
      if (path === '/v1/workspaces/ws-1/notifications/read') {
        posts.push(JSON.parse(init.body)); unread = 0; return json(200, {unread_count: 0});
      }
      if (path.endsWith('/conv-1/read')) return json(200, {unread_count: 0});
      return original(path);
    }});
    await settle();
    assert.equal(el('notification-count').hidden, false);
    assert.equal(el('notification-count').textContent, '1');
    await fire(el('notifications-toggle'), 'click');
    await settle();
    assert.equal(el('notifications-panel').hidden, false);
    assert.equal(el('notification-list').children.length, 2);
    el('notifications-kind').value = 'mention';
    await fire(el('notifications-kind'), 'change');
    el('notifications-unread').checked = true;
    await fire(el('notifications-unread'), 'change');
    assert.equal(el('notification-list').children.length, 1);
    const item = el('notification-list').children[0] && el('notification-list').children[0].children[0];
    assert.ok(item, 'the mention is listed');
    assert.equal(item.children[0].textContent, 'bob 在「项目群」提及了你');
    assert.equal(el('notifications-read-all').disabled, false);
    await fire(item, 'click');
    await settle();
    assert.deepEqual(posts, [{notification_id: 'n'.repeat(32)}]);
    assert.equal(el('notifications-panel').hidden, true);
    assert.equal(el('notification-count').hidden, true);
    assert.equal(el('notifications-empty').textContent, '暂无未读提及。');
  } finally { restore(); }
});

test('native mentions open their exact messages while acknowledgements arrive out of order', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const {doc,el,routes,calls,restore} = fixture;
  const notices = `${linkBase(linkWork)}/notifications`;
  const otherRoom = 'otc_' + 'B'.repeat(26);
  const otherMessage = 'otm_' + 'C'.repeat(26);
  const first = {id:'first', kind:'messenger.mention', conversation_id:linkSocial, message_id:linkSocialOlder};
  const second = {id:'second', kind:'messenger.mention', conversation_id:otherRoom, message_id:otherMessage};
  const pending = {first:Promise.withResolvers(),second:Promise.withResolvers()};
  const otherPath = `${linkBase(linkWork)}/social/conversations/${otherRoom}?around=${otherMessage}`;
  routes.set(notices,()=>json(200,{unread_count:2,items:[first,second]}));
  routes.set(notices + '/read',({body})=>pending[body.notification_id].promise);
  routes.set(otherPath,()=>json(200,{conversation:{id:otherRoom,workspace_id:linkWork,kind:'group',title:'Other group'},
    items:[{id:otherMessage,conversation_id:otherRoom,user_id:bob,body:'Second target',seq:3}],has_newer:true}));
  const clickNotice = async index => {
    await fire(el('notifications-toggle'),'click');
    await fire(el('notification-list').children[index].children[0],'click');
  };
  try {
    await mount(doc,{fetcher:fixture.fetcher});
    await clickNotice(0);
    assert.equal(el('notifications-panel').hidden,true);
    assert.equal(el('notification-count').textContent,'2');
    assert.equal(el('message-list').children[0].dataset.searchJump,'true');
    assert.deepEqual(fixture.messages(),[linkSocialOlder]);
    await clickNotice(1);
    assert.deepEqual(fixture.messages(),[otherMessage]);
    assert.equal(el('message-list').children[0].dataset.searchJump,'true');
    pending.second.resolve(json(200,{unread_count:0}));
    await settle();
    assert.equal(el('notification-count').textContent,'1');
    pending.first.resolve(json(200,{unread_count:1}));
    await settle();
    assert.equal(el('notification-count').hidden,true);
    assert.deepEqual(fixture.messages(),[otherMessage]);
    assert.equal(calls.filter(call=>call.path===otherPath).length,1);
    assert.deepEqual(calls.filter(call=>call.path===notices+'/read').map(call=>call.body),
      [{notification_id:first.id},{notification_id:second.id}]);
  } finally {
    pending.first.resolve(json(503,{}));
    pending.second.resolve(json(503,{}));
    restore();
  }
});

test('automation notification opens only the exact run, keeps raw output out of the inbox and marks all workspace notices read', async () => {
  const fixture = linkedChatFixture('');
  const {doc, el, routes, restore} = fixture;
  const automation = 'a'.repeat(32), run = 'b'.repeat(32), id = 'c'.repeat(32);
  const base = `${linkBase(linkWork)}/notifications`;
  const route = `/automations?workspace=${linkWork}&automation=${automation}&run=${run}`;
  const navigation = [], reads = [];
  globalThis.location.assign = href => navigation.push(href);
  const task = {id, kind:'automation.run_finished', workspace_id:linkWork, automation_id:automation, run_id:run,
    status:'timeout', title:'每周总结', created:10, read:false, excerpt:'不应出现在通知的运行结果'};
  const others = {id:'other', kind:'mention', actor_username:'小林', read:false, created:5};
  let unread = 2;
  routes.set(base, () => json(200, {unread_count:unread, items:[{...task, read:unread < 2}, {...others, read:unread === 0}]}));
  routes.set(base + '/read', ({body}) => {
    reads.push(body);
    unread = body.all ? 0 : 1;
    return json(200, {unread_count:unread});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    await fire(el('notifications-toggle'),'click');
    el('notifications-kind').value = 'automation';
    await fire(el('notifications-kind'),'change');
    const list = el('notification-list');
    assert.equal(list.children.length, 1);
    const notice = list.children[0].children[0];
    assert.equal(notice.dataset.notificationKind, task.kind);
    assert.equal(notice.href, route);
    assert.deepEqual(notice.children.map(node => node.tagName), ['STRONG','TIME']);
    assert.equal(notice.children[0].textContent, '「每周总结」运行已超时');
    await fire(notice,'click',{preventDefault() {}});
    assert.deepEqual(navigation, [route]);
    assert.deepEqual(reads, [{notification_id:id}]);
    await fire(el('notifications-toggle'),'click');
    await fire(el('notifications-read-all'),'click');
    assert.deepEqual(reads, [{notification_id:id},{all:true}]);
    assert.equal(el('notification-count').hidden, true);
  } finally {restore();}
});

test('native notification links bound the read wait, fetch newest unread, and ignore stale workspace actions', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const workspace = 'd'.repeat(32);
  const other = 'e'.repeat(32);
  const inboxPath = `/v1/workspaces/${workspace}/notifications`;
  const receipt = {id: 'receipt', kind: 'meeting.shared', title: '版本复盘', organizer: '小方', created: 30,
    workspace_id: workspace, share_id: 'f'.repeat(32)};
  receipt.path = `/meetings#workspace=${workspace}&shared=${receipt.share_id}`;
  const newest = {id: 'newest', kind: 'discover.published', listing_kind: 'agent', title: '计划助手',
    actor_username: '小方', slug: 'schedule-assistant', path: '/a/schedule-assistant', created: 50};
  const late = {...receipt, id: 'late', share_id: '1'.repeat(32)};
  late.path = `/meetings#workspace=${workspace}&shared=${late.share_id}`;
  const navigation = [];
  const marks = [];
  const filters = [];
  let completeRead;
  let receiptRead = false;
  globalThis.location.assign = path => navigation.push(path);
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path === '/v1/workspaces?limit=100') return json(200, {items: [
        {id: workspace, name: '本工作区'}, {id: other, name: '另一工作区'},
      ]});
      if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: workspace}}});
      if (path === inboxPath || path === inboxPath + '?filter=unread') {
        const filtered = path.includes('?');
        filters.push(filtered);
        return json(200, filtered ? {unread_count: 2, items: [newest, late]}
          : {unread_count: receiptRead ? 0 : 1, items: [{...receipt, read: receiptRead}]});
      }
      if (path === inboxPath + '/read') {
        const id = JSON.parse(options.body).notification_id;
        marks.push({path, id, keepalive: options.keepalive});
        if (id === newest.id) return json(503, {});
        return new Promise(resolve => { completeRead = resolve; });
      }
      if (path.startsWith(`/v1/workspaces/${other}/notifications`)) return json(200, {unread_count: 0, items: []});
      return original(path.replace(workspace, 'ws-1').replace(other, 'ws-1'));
    }});
    const rows = () => el('notification-list').children.map(row => row.children[0]);
    await fire(el('notifications-toggle'), 'click');
    const first = rows()[0];
    assert.equal(first.tagName, 'A');
    assert.equal(first.href, receipt.path);
    assert.equal(first.children[0].textContent, '小方 分享了纪要「版本复盘」');
    const clicked = () => ({preventDefault() {}});
    const pending = fire(first, 'click', clicked());
    assert.deepEqual(navigation, []);
    assert.equal(first.getAttribute('aria-busy'), 'true');
    receiptRead = true;
    completeRead(json(200, {unread_count: 0}));
    await pending;
    assert.deepEqual(navigation, [receipt.path]);
    assert.equal(el('notification-count').hidden, true);

    await fire(el('notifications-toggle'), 'click');
    el('notifications-unread').checked = true;
    await fire(el('notifications-unread'), 'change');
    assert.equal(filters.at(-1), true);
    assert.deepEqual(rows().map(row => row.dataset.notification), [newest.id, late.id]);
    assert.equal(el('notification-count').textContent, '2');
    await fire(rows()[0], 'click', clicked());
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    assert.equal(el('notification-count').textContent, '2', 'temporary read failure leaves the badge unread');

    await fire(el('notifications-toggle'), 'click');
    const denied = fire(rows()[1], 'click', clicked());
    completeRead(json(404, {}));
    await denied;
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    assert.equal(el('notifications-panel').hidden, false);

    const slow = fire(rows()[1], 'click', clicked());
    t.mock.timers.tick(499);
    await settle();
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    t.mock.timers.tick(1);
    await slow;
    assert.deepEqual(navigation, [receipt.path, newest.path, late.path]);
    assert.equal(el('notification-count').textContent, '2', 'opening at the deadline does not acknowledge the notification');
    completeRead(json(200, {unread_count: 1}));
    await settle();
    assert.equal(el('notification-count').textContent, '1', 'a real late acknowledgement still updates the inbox');

    await fire(el('notifications-toggle'), 'click');
    const old = rows()[1];
    const lost = fire(old, 'click', clicked());
    el('workspace').value = other;
    await fire(el('workspace'), 'change');
    completeRead(json(200, {unread_count: 1}));
    await lost;
    await fire(old, 'click', clicked());
    assert.deepEqual(navigation, [receipt.path, newest.path, late.path]);
    assert.deepEqual(marks, [receipt.id, newest.id, late.id, late.id, late.id]
      .map(id => ({path: inboxPath + '/read', id, keepalive: true})));
    assert.equal(el('notification-count').hidden, true);
  } finally { restore(); }
});

import {MESSAGE_REACTIONS, reactionToggle} from '../flybot_workspace/static/chat/app.mjs';

test('reaction toggle turns my reaction off and others on', () => {
  assert.equal(MESSAGE_REACTIONS.length, 6);
  assert.deepEqual(reactionToggle([{emoji: '👍', count: 2, mine: true}], '👍'), {emoji: '👍', active: false});
  assert.deepEqual(reactionToggle([{emoji: '👍', count: 1, mine: false}], '👍'), {emoji: '👍', active: true});
  assert.deepEqual(reactionToggle([], '🎉'), {emoji: '🎉', active: true});
});

test('reaction chips post the toggle and re-render server counts', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.endsWith('/messages/m-1/reactions')) {
        const payload = JSON.parse(options.body); posts.push(payload);
        return json(200, {message_id: 'm-1', reactions: payload.active ? [{emoji: payload.emoji, count: 2, mine: true}] : []});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) body.items[0].reactions = [{emoji: '👍', count: 1, mine: false}];
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const li = el('message-list').children[0];
    const bar = li.children.find(node => node.className === 'message-reactions');
    assert.equal(bar.className, 'message-reactions');
    assert.equal(bar.children[0].textContent, '👍 1');
    await fire(bar.children[0], 'click');
    await settle();
    assert.deepEqual(posts, [{emoji: '👍', active: true}]);
    const next = li.children.find(node => node.className === 'message-reactions');
    assert.equal(next.children[0].textContent, '👍 2');
    assert.equal(next.children[0].getAttribute('aria-pressed'), 'true');
  } finally { restore(); }
});

test('rapid reaction toggles update immediately and preserve the last intent across server receipts', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const replies = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.endsWith('/messages/m-1/reactions')) {
        posts.push(JSON.parse(options.body));
        return new Promise(resolve => replies.push(resolve));
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) body.items[0].reactions = [{emoji: '👍', count: 1, mine: false}];
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const bar = el('message-list').children[0].querySelector('.message-reactions');
    const chip = () => bar.querySelector('.reaction-chip');

    const first = fire(chip(), 'click');
    assert.equal(chip().textContent, '👍 2');
    assert.equal(chip().getAttribute('aria-pressed'), 'true');
    await fire(chip(), 'click');
    assert.equal(chip().textContent, '👍 1');
    assert.equal(chip().getAttribute('aria-pressed'), 'false');
    assert.deepEqual(posts, [{emoji: '👍', active: true}]);

    replies[0](json(200, {reactions: [{emoji: '👍', count: 2, mine: true}]}));
    await settle();
    assert.deepEqual(posts, [{emoji: '👍', active: true}, {emoji: '👍', active: false}]);
    assert.equal(chip().getAttribute('aria-pressed'), 'false');

    replies[1](json(200, {reactions: [{emoji: '👍', count: 3, mine: false}]}));
    await first;
    assert.equal(chip().textContent, '👍 3');
    assert.equal(chip().getAttribute('aria-pressed'), 'false');
  } finally { restore(); }
});

test('team mode needs a selected template', () => {
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 3}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', templateSelected: true}), true);
});

import {forwardTargets, forwardCountLabel} from '../flybot_workspace/static/chat/app.mjs';

test('forward target list excludes the current conversation', () => {
  assert.deepEqual(forwardTargets([{id: 'a', kind: 'dm', title: 'bob'}, {id: 'b', kind: 'group', title: '群'}], 'a'),
    [{id: 'b', label: '群聊 · 群'}]);
  assert.equal(forwardCountLabel(3), '已选 3 条');
});

test('pin a message and multi-select forward call the real endpoints', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.endsWith('/messages/m-1/pin')) {
        posts.push([path, JSON.parse(options.body)]);
        return json(200, {pinned_messages: [{message_id: 'm-1', excerpt: '你好', pinned_by_username: 'alice'}]});
      }
      if (path.endsWith('/conv-1/forward')) {
        posts.push([path, JSON.parse(options.body)]);
        return json(201, {items: [{id: 'f-1'}]});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    assert.equal(el('chat-invite').hidden, true, 'a legacy chat without verified workspace authority cannot issue links');
    assert.equal(el('multi-select-toggle').hidden, false);
    let li = el('message-list').children[0];
    const tools = li.children.find(node => node.className === 'message-tools');
    assert.equal(tools.className, 'message-tools');
    await fire(tools.children[0], 'click');
    await settle();
    assert.deepEqual(posts[0][1], {pinned: true});
    assert.equal(el('pinned-messages').hidden, false);
    li = el('message-list').children[0];
    assert.equal(li.children.find(node => node.className === 'message-tools').children[0].textContent, '取消置顶');
    await fire(el('multi-select-toggle'), 'click');
    assert.equal(el('forward-bar').hidden, false);
    li = el('message-list').children[0];
    const box = li.children.find(node => node.className === 'message-tools').children[0].children[0];
    box.checked = true;
    await fire(box, 'change');
    assert.equal(el('forward-count').textContent, '已选 1 条');
    assert.equal(el('forward-target').value, '');
    assert.equal(el('forward-submit').disabled, true);
    el('forward-target').value = 'conv-2';
    await fire(el('forward-target'), 'change');
    assert.equal(el('forward-submit').disabled, false);
    await fire(el('forward-submit'), 'click');
    await settle();
    assert.deepEqual(posts[1][1], {message_ids: ['m-1'], target_conversation_id: 'conv-2'});
    assert.equal(el('forward-bar').hidden, true);
  } finally { restore(); }
});

test('a forward shows progress and retries an uncertain receipt with the same native key', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const calls = [];
  let rejectForward;
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (!path.endsWith('/conv-1/forward')) return original(path);
      calls.push({path, key:options.headers['Idempotency-Key'], body:JSON.parse(options.body)});
      if (calls.length === 1) return new Promise((_, reject) => { rejectForward = reject; });
      return json(201, {forwarded:1, target_conversation_id:'conv-2'});
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('multi-select-toggle'), 'click');
    const box = el('message-list').children[0].querySelector('input');
    box.checked = true;
    await fire(box, 'change');
    const target = el('forward-target'), submit = el('forward-submit'), status = el('forward-status');
    target.value = 'conv-2';
    await fire(target, 'change');

    const sending = fire(submit, 'click');
    assert.equal(status.textContent, '正在转发 1 条消息…');
    assert.equal(target.disabled, true);
    assert.equal(submit.disabled, true);
    await fire(submit, 'click');
    assert.equal(calls.length, 1);

    rejectForward(new Error('receipt lost'));
    await sending;
    assert.equal(status.textContent, '未能确认转发结果，可以重试。');
    assert.equal(target.value, 'conv-2');
    assert.equal(submit.disabled, false);
    await fire(submit, 'click');
    assert.deepEqual(calls, [calls[0], calls[0]]);
    assert.ok(calls[0].key);
    assert.equal(el('forward-bar').hidden, true);
  } finally { restore(); }
});

test('agent task completion notifications have their own summary', () => {
  assert.equal(notificationSummary({kind: 'agent_reply', status: 'succeeded', actor_username: '助理',
    conversation_kind: 'group', conversation_title: '项目群'}), '助理 在「项目群」已完成你的请求');
  assert.equal(notificationSummary({kind: 'agent_reply', status: 'failed', actor_username: '助理',
    conversation_kind: 'group', conversation_title: '项目群'}), '助理 在「项目群」未能完成你的请求');
});

test('group info panel counts members and agents honestly and picks a readable glyph', async () => {
  const { groupInfoCounts, leadGlyph } = await import('../flybot_workspace/static/chat/app.mjs');
  assert.equal(groupInfoCounts({ members: [{}, {}], agent_members: [{}] }).text, '3 位成员 · 2 位真人 · 1 位智能体');
  assert.equal(groupInfoCounts({}).text, '0 位成员 · 0 位真人 · 0 位智能体');
  assert.equal(leadGlyph('[CI FIXTURE] Group chat'), 'G');
  assert.equal(leadGlyph('产品群'), '产');
  assert.equal(leadGlyph('---', '群'), '群');
  const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
  for (const label of ['视频通话', '语音通话', '自动回复', '自动翻译', '消息免打扰']) assert.ok(html.includes(label));
  assert.match(html, /id="group-translate"[^>]*aria-label="自动翻译"/);
  assert.match(html, /id="group-translate-language"/);
});

test('legacy default group members can change automatic replies for their own agent only', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const members = [
    {id: 'own', name: '助手', mine: true, auto_reply: false},
    {id: 'other', name: '同事的助手', mine: false, auto_reply: true},
  ];
  const updates = [];
  let failNext = false;
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path.endsWith('/agents/own/auto-reply')) {
        const data = JSON.parse(init.body);
        updates.push(data);
        return json(failNext ? 503 : 200, data);
      }
      const result = await original(path);
      const body = await result.json();
      if (path.endsWith('/conv-1')) return json(200, {
        ...body, conversation: {...body.conversation, kind: 'group', agent_members: members},
      });
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('group-info-tab-agents'), 'click');
    assert.equal(el('group-agent-auto-reply-note').hidden, false);
    const [own, other] = el('group-info-agents').children;
    assert.equal(other.children.some(child => child.tagName === 'BUTTON'), false);
    const toggle = own.children.find(child => child.tagName === 'BUTTON');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    await fire(toggle, 'click');
    assert.deepEqual(updates, [{auto_reply: true}]);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    failNext = true;
    await fire(toggle, 'click');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.match(el('group-agent-auto-reply-status').textContent, /保存失败/);
  } finally { restore(); }
});

test('a selected group mention sends the chosen owner and agent together', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const composer = el('chat-body');
  composer.setSelectionRange = (start, end) => {
    composer.selectionStart = start;
    composer.selectionEnd = end;
  };
  const posts = [];
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path.endsWith('/conv-1/messages') && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return json(201, {});
      }
      const result = await original(path);
      const body = await result.json();
      if (path.endsWith('/conv-1')) return json(200, {
        ...body, conversation: {...body.conversation, kind: 'group', agent_members: [
          {id: 'same', name: '研究助手', owner_id: 'owner-one', owner_name: '小林'},
          {id: 'same', name: '研究助手', owner_id: 'owner-two', owner_name: '小周'},
        ]},
      });
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const list = el('chat-agent-mention-options');
    const key = name => fire(composer, 'keydown', {key:name, preventDefault() {}});
    composer.value = '@';
    composer.setSelectionRange(1, 1);
    await fire(composer, 'input');
    const [everyone, first, second] = list.children;
    everyone.getBoundingClientRect = () => ({top:0, left:0, width:80});
    first.getBoundingClientRect = () => ({top:0, left:90, width:100});
    second.getBoundingClientRect = () => ({top:40, left:0, width:130});
    const active = () => composer.getAttribute('aria-activedescendant');
    assert.equal(active(), everyone.id);
    await key('ArrowRight');
    assert.equal(active(), first.id);
    await key('ArrowLeft');
    assert.equal(active(), everyone.id);
    await key('ArrowDown');
    assert.equal(active(), second.id);
    await key('ArrowUp');
    assert.equal(active(), everyone.id);
    await key('Escape');
    assert.equal(list.hidden, true);
    assert.equal(composer.value, '@');
    assert.equal(composer.selectionStart, 1);
    composer.value = '@研究';
    composer.setSelectionRange(composer.value.length, composer.value.length);
    await fire(composer, 'input');
    assert.deepEqual(list.children.map(row => row.textContent), ['研究助手 · 小林', '研究助手 · 小周']);
    await key('ArrowDown');
    await key('Enter');
    assert.deepEqual(posts, []);
    assert.equal(el('chat-agent-mentions').children[0].textContent, '@研究助手 · 小周 ×');
    composer.value = '请查一下';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    await settle();
    assert.deepEqual(posts, [{body: '请查一下', agent_mentions: [{owner_id: 'owner-two', agent_id: 'same'}]}]);
    assert.equal(el('chat-agent-mentions').hidden, true);
  } finally { restore(); }
});

test('composer mention drafts restore by group and owner, and hold send for a removed teammate', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const restore = installChatGlobals({narrow: true});
  const {view} = publicOpeningView();
  const {fetcher: original} = sessionFetcher();
  const own = {id:'same', name:'研究助手', owner_id:alice, owner_name:'小林'};
  const peer = {id:'same', name:'研究助手', owner_id:bob, owner_name:'小周'};
  const posts = [];
  let peerRemoved = false;
  async function boot(owner = alice) {
    const {doc, el} = fakeChatDocument(chatHtml());
    doc.defaultView = view;
    const composer = el('chat-body');
    composer.setSelectionRange = (start, end) => { composer.selectionStart = start; composer.selectionEnd = end; };
    await mount(doc, {fetcher: async (path, options) => {
      if (path === '/v1/auth/session') return json(200, {user: {id:owner, username:'account'}});
      if (path.endsWith('/conv-1/messages') && options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return json(201, {});
      }
      const result = await original(path);
      const body = await result.json();
      if (/\/conv-[12]$/.test(path)) {
        return json(200, {...body, conversation: {...body.conversation, kind:'group',
          agent_members: peerRemoved ? [own] : [own, peer]}});
      }
      return json(result.status, body);
    }});
    const open = id => fire(el('conversation-list'), 'click', {
      target: sessionRows(el).find(button => button.dataset.conversation === id),
    });
    await open('conv-1');
    return {el, composer, open};
  }
  try {
    const first = await boot();
    const chips = el => el('chat-agent-mentions').children;
    for (let index = 0; index < 2; index += 1) {
      first.composer.value = '@研究';
      first.composer.setSelectionRange(3, 3);
      await fire(first.composer, 'input');
      await fire(first.el('chat-agent-mention-options').children[0], 'click');
    }
    first.composer.value = '请一起复查';
    await fire(first.composer, 'input');
    t.mock.timers.tick(200);
    await first.open('conv-2');
    assert.equal(first.composer.value, '');
    assert.deepEqual(chips(first.el), []);
    await first.open('conv-1');
    assert.equal(first.composer.value, '请一起复查');
    assert.deepEqual(chips(first.el).map(button => button.textContent), ['@研究助手 · 小林 ×', '@研究助手 · 小周 ×']);

    const otherAccount = await boot(bob);
    assert.equal(otherAccount.composer.value, '');
    assert.deepEqual(chips(otherAccount.el), []);

    peerRemoved = true;
    const reopened = await boot();
    assert.equal(reopened.composer.value, '请一起复查');
    assert.deepEqual(chips(reopened.el).map(button => button.textContent), ['@研究助手 · 小林 ×', '智能体已不可用 ×']);
    assert.equal(reopened.el('chat-agent-mention-status').hidden, false);
    const send = () => fire(reopened.el('chat-form'), 'submit', {preventDefault() {}});
    await send();
    assert.deepEqual(posts, []);
    assert.equal(reopened.composer.value, '请一起复查');
    await fire(chips(reopened.el)[1], 'click');
    assert.equal(reopened.el('chat-agent-mention-status').hidden, true);
    await send();
    await settle();
    assert.deepEqual(posts, [{body:'请一起复查', agent_mentions:[{owner_id:alice, agent_id:own.id}]}]);
    assert.equal(reopened.composer.value, '');
    assert.deepEqual(chips(reopened.el), []);
    assert.equal(reopened.el('chat-agent-picker-open').hidden, false);
  } finally { restore(); }
});

test('in-chat search highlights every case-insensitive match without HTML', async () => {
  const { highlightParts } = await import('../flybot_workspace/static/chat/app.mjs');
  assert.deepEqual(highlightParts('Test a test', 'test'), [
    { text: 'Test', match: true }, { text: ' a ', match: false }, { text: 'test', match: true }]);
  assert.deepEqual(highlightParts('<b>x</b>', ''), [{ text: '<b>x</b>', match: false }]);
});

import { plusAttachAccept } from '../flybot_workspace/static/chat/app.mjs';

test('composer + attach shortcuts narrow the file picker without widening it', () => {
  const all = 'image/png, image/jpeg,video/mp4,application/pdf';
  assert.equal(plusAttachAccept('image', all), 'image/png,image/jpeg');
  assert.equal(plusAttachAccept('video', all), 'video/mp4');
  assert.equal(plusAttachAccept('any', all), 'image/png,image/jpeg,video/mp4,application/pdf');
  assert.equal(plusAttachAccept('image', ''), '');
});

test('composer + creation grid opens real editors and generation dialogs', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
  for (const kind of ['document', 'slides', 'spreadsheet']) {
    assert.ok(html.includes(`href="/space?new=${kind}" data-create-artifact="${kind}"`),kind);
  }
  const sheet = html.slice(html.indexOf('class="composer-plus-sheet"'), html.indexOf('</details>', html.indexOf('class="composer-plus-sheet"')));
  assert.match(sheet, /id="composer-resource-open"/);
  assert.doesNotMatch(sheet, /href="\/(automations|meetings|skills|memory)/);
  assert.match(html, /id="composer-website-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /id="website-create-manual" href="\/space\?new=website"/);
  assert.match(html, /id="website-create-prompt" name="prompt" maxlength="1600"/);
  assert.match(html, /<iframe id="website-create-preview"[^>]+sandbox="allow-scripts" referrerpolicy="no-referrer" hidden/);
  assert.match(html, /id="composer-video-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<video id="video-create-preview"[^>]+controls/);
  assert.match(html, /id="composer-music-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<audio id="music-create-preview"[^>]+controls/);
  assert.match(html, /id="composer-model3d-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<select name="source">\s*<option value="text"[^>]*>根据描述<\/option>\s*<option value="image"[^>]*>根据参考图<\/option>/);
  assert.match(html, /id="model3d-create-open-preview"[^>]+aria-expanded="false"/);
});

test('website creation preserves the chat draft, recovers a saved job, and tears down its lazy preview', async () => {
  const {mountWebsiteCreator} = await import('../flybot_workspace/static/chat/video-create.mjs');
  const {doc, el} = fakeChatDocument(chatHtml());
  const widget = name => el('website-create-' + name);
  const dialog = widget('dialog');
  const iframe = widget('preview');
  const prompt = widget('prompt');
  prompt.maxLength = 1600;
  widget('form').elements = {prompt};
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; return fire(dialog, 'close'); };
  Object.defineProperty(iframe, 'src', {set(url) { this.setAttribute('src', url); }});

  const workspace = alice;
  const artifact = bob;
  const jobsPath = `/v1/workspaces/${workspace}/websites`;
  const artifactPath = `/v1/workspaces/${workspace}/artifacts/${artifact}`;
  const calls = [];
  let job = null;
  let finishPreview;
  const creator = mountWebsiteCreator(doc, {
    context: () => ({workspace, scope: 'chat-1', sendLabel: '发送到会话'}),
    key: () => 'website-request',
    onOpen() {},
    async request(method, path, body, headers) {
      calls.push({method, path, body, headers});
      if (path === jobsPath && method === 'GET') return {status: 200, body: {configured: true, job}};
      if (path === jobsPath && method === 'POST') {
        job = {id: 'c'.repeat(32), prompt: body.prompt, state: 'queued', artifact_id: null};
        return {status: 202, body: {job}};
      }
      if (path === artifactPath) return new Promise(resolve => { finishPreview = resolve; });
      throw new Error('unexpected ' + path);
    },
  });
  creator.sync();

  el('chat-body').value = '未发送的聊天草稿';
  await creator.open();
  assert.equal(prompt.value, el('chat-body').value);
  assert.equal(widget('manual').href, '/space?new=website#workspace=' + workspace);
  prompt.value = '  产品展示网站  ';
  await fire(widget('form'), 'submit', {preventDefault() {}});
  assert.match(widget('status').textContent, /排队/);
  assert.equal(el('chat-body').value, '未发送的聊天草稿');
  assert.deepEqual(calls[1], {
    method: 'POST', path: jobsPath, body: {prompt: '产品展示网站'}, headers: {'Idempotency-Key': 'website-request'},
  });
  await dialog.close();
  job = {...job, state: 'succeeded', artifact_id: artifact};
  await creator.open();
  assert.match(widget('status').textContent, /私密保存/);
  assert.equal(widget('space').href, `/space?workspace=${workspace}&artifact=${artifact}`);
  assert.equal(widget('result').hidden, false);
  assert.equal(iframe.hidden, true);
  assert.equal(calls.length, 3);

  const preview = fire(widget('open-preview'), 'click');
  finishPreview({status: 200, body: {artifact: {revision: 3}}});
  await preview;
  assert.equal(iframe.getAttribute('src'), artifactPath + '/preview?revision=3');
  assert.equal(iframe.hidden, false);
  await dialog.close();
  assert.equal(iframe.getAttribute('src'), undefined);
  assert.equal(iframe.hidden, true);
});

// Media shared in a chat is uploaded to the workspace library before the
// message is sent, so the message carries an attachment with a mime type. The
// message list has to show an image as an image: the document card with a DOC
// cover and a download link is what an attachment used to look like for every
// file type, and it hides the picture a user just sent.

function attachmentFetcher(item) {
  const aliceRow = {user_id: alice, username: 'alice'};
  const conversation = {
    id: 'conv-1', kind: 'dm', title: 'bob', updated: 30,
    members: [aliceRow, {user_id: bob, username: 'bob'}],
  };
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: [conversation]});
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-1') {
      return json(200, {conversation, items: [item]});
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher};
}

const imageAttachment = {
  id: 'a'.repeat(32), title: '日落.png', mime: 'image/png',
  path: '/v1/workspaces/ws-1/artifacts/' + 'a'.repeat(32) + '/file',
};

function attachmentMessage(attachment) {
  return {
    id: 'm-1', conversation_id: 'conv-1', workspace_id: 'ws-1', user_id: bob,
    body: '附件：' + attachment.title, created: '2026-01-01T00:00:00Z', attachment,
  };
}

test('the Chat workspace invitation copies a native recipient link and discards stale receipts', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const workspace = 'a'.repeat(32), token = 'b'.repeat(32);
  const receipt = {status:201, body:{invite:{id:'issued', workspace_id:workspace}, token}};
  let active = {scope:'owner:team:chat', workspace};
  const response = Promise.withResolvers();
  const calls = [], copied = [];
  let denyCopy = false;
  const invite = mountWorkspaceInvite(doc, {
    context: () => active,
    view: {location:{origin:'https://test.example'}, navigator:{clipboard:{async writeText(value) {
      if (denyCopy) throw new Error('Clipboard declined');
      copied.push(value);
    }}}},
    async request(method, path, body) {
      calls.push([method,path,body]);
      return calls.length === 1 ? receipt : response.promise;
    },
  });
  const trigger = el('chat-invite');
  const link = el('chat-invite-link');
  link.select = () => {link.selected = true;};
  invite.sync();
  assert.equal(trigger.hidden,false);
  trigger.handlers.click[0]();
  el('chat-invite-approval').checked = true;
  const submit = () => el('chat-invite-form').handlers.submit[0]({preventDefault() {}});
  await submit();
  assert.deepEqual(calls[0], ['POST', `/v1/workspaces/${workspace}/invites`, {
    role:'member',expires_in:604800,max_uses:1,requires_approval:true,
  }]);
  assert.equal(link.value,`https://test.example/login#team-invite=${token}`);
  assert.equal(el('chat-invite-link-row').hidden,false);
  await el('chat-invite-copy').handlers.click[0]();
  assert.deepEqual(copied,[link.value]);
  denyCopy = true;
  await el('chat-invite-copy').handlers.click[0]();
  assert.equal(link.selected,true);
  assert.equal(el('chat-invite-result').textContent,'请复制选中的链接。');

  const slow = submit();
  active = null;
  invite.sync();
  response.resolve(receipt);
  await slow;
  assert.equal(trigger.hidden,true);
  assert.equal(link.value,'');
  assert.equal(el('chat-invite-link-row').hidden,true);
  assert.equal(el('chat-invite-panel').hidden,true);
});

test('group announcements display the publisher and can be cleared only by an editor', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const dialog = el('announcement-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent({type:'close'}); };
  const calls = [];
  let canEdit = false;
  const entry = {body:'Planning update', author_name:'<Ada>', updated_at:1800000000000, revision:4};
  const {refreshAnnouncement} = mountMessageUtilities(doc, {
    context: () => ({wid:'team', cid:'group', kind:'group'}),
    formatAnnouncementTime: timestamp => { assert.equal(timestamp, entry.updated_at); return '16:20'; },
    notify: () => {},
    async request(method, path, body) {
      const announcement = method === 'POST' ? {body:'',revision:5} : entry;
      calls.push({method,path,body});
      return {status:200,body:{announcement,can_edit:canEdit}};
    },
  });
  await refreshAnnouncement();
  assert.equal(el('group-announcement-preview').textContent, entry.body);
  assert.equal(el('group-announcement-meta').textContent, '<Ada> · 16:20');
  assert.equal(el('group-announcement-meta').hidden, false);

  const open = el('group-announcement-open').handlers.click[0];
  const clear = el('announcement-clear');
  await open();
  assert.equal(el('announcement-save').disabled, true);
  assert.equal(clear.hidden, true);
  await clear.handlers.click[0]();
  assert.equal(calls.some(call => call.method === 'POST'), false);
  dialog.close();

  canEdit = true;
  await open();
  assert.equal(clear.hidden, false);
  await clear.handlers.click[0]();
  assert.deepEqual(calls.at(-1), {
    method:'POST',path:'/v1/workspaces/team/social/conversations/group/announcement',body:{body:'',revision:4},
  });
  assert.equal(dialog.open, false);
  assert.equal(el('group-announcement-preview').textContent, '还没有群公告。');
  assert.equal(el('group-announcement-meta').hidden, true);
});

test('a picture shared in a chat renders as an image, not a document card', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(imageAttachment)).fetcher});
    await settle();
    const row = el('message-list').children[0];
    assert.ok(row, 'the fixture conversation renders its message');
    const image = descendants(row).find((node) => node.tagName === 'IMG');
    assert.ok(image, 'an image attachment must render as an <img>, otherwise the picture is invisible in chat');
    assert.equal(image.src, imageAttachment.path, 'the image reads the attachment the message points at');
    assert.equal(image.alt, '日落.png', 'the image alt text is the attachment title');
    assert.equal(image.getAttribute('loading'), 'lazy', 'a shared picture is not loaded before it is seen');
    assert.ok(
      !descendants(row).some((node) => String(node.textContent).trim() === 'DOC'),
      'the document cover must not label an image attachment',
    );
  } finally {
    restore();
  }
});

test('an audio attachment keeps the document card instead of becoming an image', async () => {
  const attachment = {id: 'b'.repeat(32), title: '备忘.m4a', mime: 'audio/mp4', path: '/v1/workspaces/ws-1/artifacts/' + 'b'.repeat(32) + '/file'};
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(attachment)).fetcher});
    await settle();
    const row = el('message-list').children[0];
    assert.ok(
      !descendants(row).some((node) => node.tagName === 'IMG'),
      'a non-image attachment must not be forced into an image element',
    );
    assert.ok(
      descendants(row).some((node) => String(node.textContent).trim() === 'DOC'),
      'a non-image attachment keeps the document card',
    );
  } finally {
    restore();
  }
});

test('a received GLB offers a collapsed viewer and an independent download', async () => {
  const attachment = {title: '风车.glb', mime: 'model/gltf-binary', bytes: 512, path: '/fixture/windmill.glb'};
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(attachment)).fetcher});
    await settle();
    const nodes = descendants(el('message-list').children[0]);
    const button = nodes.find(node => node.classList.contains('chat-file-model3d-toggle'));
    const frame = nodes.find(node => node.classList.contains('chat-file-model3d-preview'));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(frame.hidden, true);
    assert.equal(frame.children.length, 0);
    assert.equal(nodes.find(node => node.download === attachment.title).href, attachment.path + '?download=1');
    await fire(el('multi-select-toggle'), 'click');
    const renderedAgain = descendants(el('message-list').children[0]);
    assert.equal(renderedAgain.find(node => node.classList.contains('chat-file-model3d-preview')), frame);
  } finally {
    restore();
  }
});

test('social history pages both ways from a searched window without acknowledging it', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow:true});
  const row = seq => ({id: 'history-' + seq, seq, user_id:bob, body:'Message ' + seq, created:seq});
  const list = el('message-list');
  const scroller = el('message-scroller');
  Object.defineProperty(scroller, 'scrollHeight', {get: () => list.children.length * 100});
  scroller.clientHeight = 100;
  let latestReads = 0;
  let nextReads = 0;
  let acknowledgements = 0;
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  try {
    await mount(doc, {fetcher: async path => {
      if (path.endsWith('/conv-1')) {
        latestReads++;
        const old = await original(path);
        return json(200, {...await old.json(), items:[row(5), row(6)], cursor:5});
      }
      if (path.includes('before=5')) return json(200, {items:[row(3), row(4), row(5)],cursor:3});
      if (path.includes('around=history-1')) return json(200, {items:[row(1), row(2)],cursor:null,has_newer:true});
      if (path.includes('after=2')) {
        if (++nextReads === 1) return json(503, {});
        if (nextReads === 3) {
          started.resolve();
          return pending.promise;
        }
        return json(200, {items:[row(2),row(3),row(4)],has_newer:true,last_seq:6});
      }
      if (path.includes('after=4')) return json(200, {items:[row(5),row(6)],has_newer:false,last_seq:6});
      if (path.endsWith('/conv-1/read')) acknowledgements++;
      if (path.includes('/messages?q=')) return json(200, {items:[row(1)],cursor:null});
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const ids = () => list.children.map(item => item.dataset.messageId);
    assert.deepEqual(ids(), ['history-5','history-6']);
    const latest = el('chat-back-to-latest');
    const loadedRows = [...list.children];
    assert.equal(latest.hidden,true);
    scroller.scrollTop = 25;
    await fire(scroller,'scroll');
    assert.equal(latest.hidden,false);
    const initialReads = latestReads;
    await fire(latest,'click');
    assert.equal(scroller.scrollTop,scroller.scrollHeight);
    assert.equal(latest.hidden,true);
    assert.equal(latestReads,initialReads);
    assert.ok(loadedRows.every((node,index) => node === list.children[index]));
    scroller.scrollTop = 25;
    await fire(el('chat-load-older'), 'click');
    assert.deepEqual(ids(), ['history-3','history-4','history-5','history-6']);
    assert.equal(scroller.scrollTop,225);
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-query').value = 'Message';
    await fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    await fire(el('conversation-search-results').children[0].children[0], 'click');
    assert.deepEqual(ids(), ['history-1','history-2']);
    assert.equal(list.children[0].dataset.searchJump,'true');
    assert.equal(el('chat-back-to-latest').hidden,false);
    const newer = el('chat-load-newer');
    const status = el('chat-unread-status');
    assert.equal(newer.hidden,false);
    assert.equal(el('chat-mark-thread-read').hidden,true);
    const receiptsBeforeHistory = acknowledgements;
    await fire(newer,'click');
    assert.match(status.textContent,/加载失败|Could not load/);
    assert.deepEqual(ids(), ['history-1','history-2']);
    await fire(newer,'click');
    assert.deepEqual(ids(), ['history-1','history-2','history-3','history-4']);
    await fire(newer,'click');
    assert.deepEqual(ids(), ['history-1','history-2','history-3','history-4','history-5','history-6']);
    assert.equal(newer.hidden,true);
    assert.match(status.textContent,/已加载到最新消息|All newer messages/);
    assert.equal(acknowledgements,receiptsBeforeHistory);
    await fire(el('chat-back-to-latest'),'click');
    await settle();
    assert.deepEqual(ids(), ['history-5','history-6']);
    assert.equal(el('chat-back-to-latest').hidden,true);
    assert.equal(status.textContent,'');
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-query').value = 'Message';
    await fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    await fire(el('conversation-search-results').children[0].children[0], 'click');
    const forward = fire(newer,'click');
    await started.promise;
    await fire(latest,'click');
    await settle();
    pending.resolve(json(200,{items:[row(3),row(4)],has_newer:true,last_seq:6}));
    await forward;
    assert.deepEqual(ids(), ['history-5','history-6']);
    assert.equal(newer.hidden,true);
  } finally { restore(); }
});

test('in-chat search keeps an unavailable result open and clears the phone drawer for a real jump', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const back = doc.createElement('button');
  el('conversation-search-return').append(back);
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow:true});
  let searchReads = 0;
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/messages?q=')) {
        searchReads += 1;
        return json(200, {items:[
          {id:'jump-loaded', body:'Find me', user_id:alice, created:1767225600},
          {id:'not-loaded', body:'Earlier message', user_id:bob, created:1767225200},
        ],cursor:null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const target = el('message-list').children[0];
    target.dataset.messageId = 'jump-loaded';
    let sheetWasClosedOnScroll = false;
    target.scrollIntoView = () => { sheetWasClosedOnScroll = el('conversation-search-panel').hidden; };
    el('message-scroller').scrollTop = 41;
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-query').value = 'Find';
    await fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    const hits = el('conversation-search-results').children.map(row => row.children[0]);
    assert.equal(hits[0].tagName, 'BUTTON');
    assert.match(hits[0].getAttribute('aria-label'), /我.*Find me/);
    assert.equal(descendants(hits[0]).find(node => node.tagName === 'TIME').dateTime,
      new Date(1767225600 * 1000).toISOString());
    await fire(hits[1], 'click');
    assert.match(el('conversation-search-status').textContent, /不在当前已加载/);
    assert.equal(el('conversation-search-panel').hidden, false);
    el('message-scroller').scrollTop = 99;
    await fire(el('conversation-search-close'), 'click');
    assert.equal(el('message-scroller').scrollTop, 41);
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-results').scrollTop = 36;
    await fire(el('conversation-search-results').children[0].children[0], 'click');
    assert.equal(sheetWasClosedOnScroll, true);
    assert.equal(target.dataset.searchJump, 'true');
    assert.equal(target.focused, true);
    assert.equal(el('conversation-search-open').getAttribute('aria-expanded'), 'false');
    assert.equal(el('conversation-search-return').hidden, false);
    assert.equal(back.textContent, '返回消息结果');
    await fire(back, 'click');
    assert.equal(el('conversation-search-results').children[0].children[0], hits[0]);
    assert.equal(el('conversation-search-results').scrollTop, 36);
    assert.equal(hits[0].getAttribute('aria-current'), 'true');
    assert.equal(hits[0].focused, true);
    assert.equal(searchReads, 1);
  } finally {restore();}
});

test('conversation search cancels the superseded request and ignores a late result', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const slow = Promise.withResolvers();
  let oldSignal;
  try {
    await mount(doc, {fetcher: async (path, options) => {
      if (path.includes('/messages?q=old')) {
        oldSignal = options.signal;
        return slow.promise;
      }
      if (path.includes('/messages?q=new')) {
        return json(200, {items: [{id:'new-hit', body:'new result'}], cursor:null});
      }
      return original(path, options);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    const query = el('conversation-search-query');
    const submit = () => fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    query.value = 'old';
    const old = submit();
    assert.equal(oldSignal.aborted, false);
    query.value = 'new';
    await submit();
    assert.equal(oldSignal.aborted, true);
    slow.resolve(json(200, {items: [{id:'old-hit', body:'old result'}], cursor:null}));
    await old;
    const results = el('conversation-search-results').children;
    assert.equal(results.length, 1);
    assert.match(results[0].children[0].getAttribute('aria-label'), /new result/);
  } finally { restore(); }
});

test('removing a group agent sends nothing until the explicit confirmation', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow:true});
  try {
    await mount(doc, {fetcher: async (path, options={}) => {
      if (path.endsWith('/agents/a-1/remove')) {posts.push(path);return json(200, {});}
      if (path.endsWith('/conv-1')) {
        const result = await original(path, options);
        const body = await result.json();
        return json(200, {...body, conversation: {...body.conversation, kind:'group'}});
      }
      return original(path, options);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const remove = new FakeElement('button'); remove.dataset.removeAgent = 'a-1';
    await fire(el('group-agent-chips'), 'click', {target:remove});
    assert.equal(posts.length,0);
    let question = el('group-agent-chips').children.at(-1);
    assert.equal(question.getAttribute('role'),'alertdialog');
    await fire(question.children[1], 'click');
    assert.equal(posts.length,0);
    await fire(el('group-agent-chips'), 'click', {target:remove});
    question = el('group-agent-chips').children.at(-1);
    await fire(question.children[2], 'click');
    assert.equal(posts.length,1);
  } finally {restore();}
});

test('the composer exposes a real bold tool instead of the disabled placeholder', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="chat-format"');
  assert.ok(start > -1, 'the composer has a format control');
  const open = html.lastIndexOf('<button', start);
  const block = html.slice(open, html.indexOf('>', start) + 1);
  assert.doesNotMatch(block, /disabled/, 'the format control must not be disabled');
  assert.match(html, /id="chat-format-bold"/, 'the format menu offers bold');
});

test('wrapBold puts double asterisks around the selected text', () => {
  assert.deepEqual(wrapBold('你好世界', 2, 4), {text: '你好**世界**', start: 4, end: 6});
  assert.deepEqual(wrapBold('abc', 1, 1), {text: 'a****bc', start: 3, end: 3});
  assert.deepEqual(wrapBold('', 0, 0), {text: '****', start: 2, end: 2});
});

test('inlineBold splits text into plain and bold runs', () => {
  assert.deepEqual(inlineBold('发 **重要** 通知'), [
    {text: '发 ', bold: false}, {text: '重要', bold: true}, {text: ' 通知', bold: false},
  ]);
  assert.deepEqual(inlineBold('**未闭合'), [{text: '**未闭合', bold: false}]);
  assert.deepEqual(inlineBold(''), []);
});

test('the message menu offers delete that hides the message only for this account', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/chat/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../flybot_workspace/static/chat/app.mjs', import.meta.url), 'utf8');
  assert.match(html, /data-menu="delete"/);
  assert.doesNotMatch(html, /data-menu="delete"[^>]*disabled/);
  assert.doesNotMatch(html, /还没有删除消息接口/);
  assert.match(app, /request\('DELETE', `\$\{socialBase\(\)\}\/\$\{cid\}\/messages\/\$\{item\.id\}`\)/);
});

test('team document links open the exact same-origin workspace and document', async () => {
  const {studioDocumentHref,studioDocumentFromSearch,studioDocumentHrefInMessage} =
    await import('../flybot_workspace/static/shell/studio-link.mjs');
  const workspace = 'a'.repeat(32), id = 'b'.repeat(32), origin = 'https://example.test';
  const href = studioDocumentHref(workspace,id);
  assert.deepEqual(studioDocumentFromSearch(href.slice('/space'.length)), {workspace,id});
  assert.equal(studioDocumentHrefInMessage('讨论 ' + origin + href + '。',origin),href);
  assert.equal(studioDocumentHrefInMessage('讨论 ' + href,origin),href);
  assert.equal(studioDocumentHrefInMessage('https://elsewhere.test'+href,origin),'');
  assert.equal(studioDocumentHrefInMessage(origin+href+'&studio='+id,origin),'');
});

test('assistant Markdown tables handle alignment, optional outer pipes, escapes and code spans', () => {
  const lines = [
    '左 | 中 | 右 | 默认',
    ':--- | :---: | ---: | ---',
    '| 甲\\|乙 | `A|B` | ``C`|D`` | `E\\|F` |',
    '短行 | 中间 | 右边',
    '| 多余 | 单元格 | 会被 | 忽略 | 不属于表格 |',
    '### 后续段落 | 继续显示',
  ];
  const result = readMarkdownTable(lines, 0);
  assert.deepEqual(result, {
    next:5,
    block:{
      type:'table', header:['左','中','右','默认'], alignments:['left','center','right',null],
      rows:[['甲|乙','`A|B`','``C`|D``','`E|F`'], ['短行','中间','右边',''], ['多余','单元格','会被','忽略']],
    },
  });
  assert.equal(readMarkdownTable(['甲 | 乙','--- | ouch'], 0), null);
  assert.equal(readMarkdownTable(['甲 | 乙','--- | --- | ---'], 0), null);
  assert.equal(readMarkdownTable(['甲 \\| 乙','--- | ---'], 0), null);
  assert.deepEqual(readMarkdownTable(['| 单列 |','| --- |','| 行 |'], 0).block.rows, [['行']]);
  const rows = Array.from({length:121}, () => '甲 | 乙');
  const bounded = readMarkdownTable([lines[0],lines[1],...rows], 0);
  assert.equal(bounded.block.rows.length, 120);
  assert.equal(bounded.next, 122);
});

test('assistant Markdown tables render scoped table headers and delegate only cell content', () => {
  const {doc} = fakeChatDocument(chatHtml());
  doc.documentElement = {lang:'zh-Hans'};
  const lines = ['| 名称 | 数据 |','| --- | ---: |','| **本周** | <img src=x> |'];
  const cells = [];
  const content = renderMarkdownTable(doc, readMarkdownTable(lines, 0).block, (node, text) => {
    cells.push(text);
    node.textContent = text;
  });
  const [table] = content.children;
  const [head, body] = table.children;
  const headers = head.children[0].children;
  assert.equal(content.className, 'chat-markdown-table-scroll');
  assert.equal(content.tabIndex, 0);
  assert.equal(content.getAttribute('aria-label'), '表格');
  assert.deepEqual([table.tagName, head.tagName, body.tagName], ['TABLE','THEAD','TBODY']);
  assert.ok(headers.every(cell => cell.tagName === 'TH' && cell.getAttribute('scope') === 'col'));
  assert.equal(headers[1].getAttribute('data-align'), 'right');
  assert.deepEqual(cells, ['名称','数据','**本周**','<img src=x>']);
  assert.deepEqual(body.children[0].children.map(cell => cell.tagName), ['TD','TD']);
  assert.equal(body.children[0].children[1].textContent, '<img src=x>');
});

test('copying a streaming Chat table uses the current cells and keeps the same control', async () => {
  const {renderStreamingMarkdown} = await import('../flybot_workspace/static/chat/rich-content.mjs');
  const {doc} = fakeChatDocument(chatHtml());
  const copied = [];
  doc.documentElement = {lang:'zh-CN'};
  doc.defaultView = {navigator:{clipboard:{async writeText(text) {copied.push(text);}}}};
  const create = doc.createElement;
  doc.createElement = tag => {
    const node = create(tag);
    Object.defineProperty(node,'firstElementChild',{get:()=>node.children[0]});
    if (tag === 'table') Object.defineProperty(node,'rows',{get:()=>node.children.flatMap(section=>section.children)});
    if (tag === 'tr') Object.defineProperty(node,'cells',{get:()=>node.children});
    return node;
  };
  const body = doc.createElement('div');
  const source = '| 名称 | 状态 |\n| --- | --- |\n| **第一项** | `dev|prod` |';
  renderStreamingMarkdown(doc,body,source);
  const button = body.querySelector('.chat-table-copy');
  const region = body.querySelector('.chat-markdown-table-scroll');
  region.scrollLeft = 24;
  await fire(button,'click');
  assert.deepEqual(copied,['名称\t状态\n第一项\tdev|prod']);
  renderStreamingMarkdown(doc,body,source + '\n| 第二项 | 已完成 |');
  assert.equal(body.querySelector('.chat-table-copy'),button);
  assert.equal(body.querySelector('.chat-markdown-table-scroll'),region);
  assert.equal(region.scrollLeft,24);
  await fire(button,'click');
  assert.equal(copied.at(-1),'名称\t状态\n第一项\tdev|prod\n第二项\t已完成');
});

test('the inbox entry leaves Markdown modules outside its static dependency graph', () => {
  assert.doesNotMatch(chatHtml(), /rel="modulepreload"[^>]*href="[^"]*(?:rich-content|markdown(?:-table)?|\/rich|code-block)\.mjs"/);
  const source = readFileSync(new URL('../flybot_workspace/static/chat/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:rich-content|markdown(?:-table)?|\/rich|code-block)\.mjs['"]/);
});

test('a long rich message starts fully readable and gets one rendered body', async () => {
  const {renderMessageText} = await import('../flybot_workspace/static/chat/utilities.mjs');
  const {doc} = fakeChatDocument(chatHtml());
  const root = doc.createElement('div');
  const source = `### 后续检查\n\n${'保留完整内容。'.repeat(145)}`;
  const body = doc.createElement('div');
  renderMessageText(doc, root, source, false, (parent, text) => {
    body.textContent = text;
    parent.append(body);
  });
  assert.deepEqual(root.children,[body]);
  assert.equal(root.textContent,source);
  const heading = doc.createElement('h3');
  heading.textContent = '后续检查';
  const content = doc.createElement('p');
  content.textContent = source.split('\n\n')[1];
  body.replaceChildren(heading,content);
  assert.deepEqual(root.children,[body]);
  assert.equal(root.textContent,heading.textContent + content.textContent);
});

test('long plain messages stay complete and link previews never fetch or execute markup', async () => {
  const {renderMessageText}=await import('../flybot_workspace/static/chat/utilities.mjs');
  const document={createElement:tag=>new FakeElement(tag)}, root=new FakeElement('div');
  const full='A'.repeat(900)+' <script>untrusted</script>';
  renderMessageText(document,root,full);
  assert.equal(root.children.length,0);
  assert.equal(root.textContent,full);
  const links='https://example.invalid/path?x=1 https://user:password@example.invalid/ javascript:alert(1)';
  renderMessageText(document,root,links,false);
  assert.equal(root.children.length,0);
  renderMessageText(document,root,links,true);
  assert.equal(root.children.length,1);
  assert.equal(root.children[0].href,'https://example.invalid/path?x=1');
  assert.equal(root.children[0].rel,'noopener noreferrer');
  assert.match(root.children[0].title,/未抓取/);
});

function utilityDocument() {
  const nodes=new Map();
  const doc={createElement(tag){const e=new FakeElement(tag);e.style={};return e},getElementById(id){
    if(!nodes.has(id)){
      const e=doc.createElement('div');e.open=false;e.showModal=()=>{e.open=true};e.close=()=>{e.open=false;for(const h of e.handlers.close||[])h()};e.dispatchEvent=()=>{};nodes.set(id,e);
    }
    return nodes.get(id);
  }};
  return {doc,el:id=>doc.getElementById(id)};
}

test('resource picker cancels pending reads, inserts actual quoted content once, and never sends', async()=>{
  const {mountMessageUtilities}=await import('../flybot_workspace/static/chat/utilities.mjs');
  const {doc,el}=utilityDocument();const posts=[];let finish,mode='defer';
  const c={wid:'workspace',cid:'conversation',source:'social',kind:'group'};
  mountMessageUtilities(doc,{context:()=>c,composerContext:()=>c,notify:()=>{},request:async(method,path,body)=>{
    if(method==='POST'){posts.push(body);throw Error('no send expected')}
    if(path.endsWith('/memory/note'))return mode==='defer'?await new Promise(resolve=>{finish=resolve}):{status:200,body:{page:{title:'Original note',revision:2,body:'<script>quoted, never executable</script>'}}};
    return {status:200,body:{items:[{id:'note',title:'Original note'}]}};
  }});
  el('chat-body').value='Keep this draft';
  await fire(el('composer-memory-open'),'click');await settle(2);
  const pending=fire(el('resource-picker-list').children[0].children[0],'click');await settle(1);
  el('resource-picker').close();finish({status:200,body:{page:{title:'stale',revision:1,body:'must not insert'}}});await pending;
  assert.equal(el('chat-body').value,'Keep this draft');
  mode='success';await fire(el('composer-memory-open'),'click');await settle(2);
  await fire(el('resource-picker-list').children[0].children[0],'click');
  assert.match(el('chat-body').value,/Original note（修订 2）/u);
  assert.ok(el('chat-body').value.endsWith(JSON.stringify('<script>quoted, never executable</script>')));
  assert.equal(el('resource-picker').open,false);assert.equal(posts.length,0);
});

test('prompt templates save the current draft, bind late inserts to their conversation, and never send', async () => {
  const {mountPromptTemplates} = await import('../flybot_workspace/static/chat/prompt-templates.mjs');
  const {doc, el} = utilityDocument();
  const composer = el('chat-body');
  composer.maxLength = 4000;
  composer.value = 'Summarize {{topic}}';
  const prompt = {id: 'b'.repeat(32), title: 'Summary', variables: ['topic'], current_version: 1};
  let scope = 'owner-workspace-thread';
  let receipt;
  let changed = 0;
  composer.dispatchEvent = event => { if (event.type === 'input') changed += 1; };
  const requests = [];
  const library = mountPromptTemplates(doc, {composer, scope: () => scope, uiLabel: (_zh, en) => en,
    request: async (method, path, body) => {
      assert.equal(method, 'POST');
      assert.equal(path, '/b/api/flybot-workspace');
      requests.push(body);
      const value = body.endpoint === 'prompts/list' ? {items: [], cursor: null}
        : body.endpoint === 'prompts/create' ? {prompt} : await receipt.promise;
      return {status: 200, body: {ok: true, value}};
    },
  });
  library.open();
  await settle(2);
  el('chat-prompt-title').value = 'Summary';
  await fire(el('chat-prompt-save-form'), 'submit', {preventDefault() {}});
  await settle(2);
  assert.deepEqual(requests.map(call => call.endpoint), ['prompts/list', 'prompts/create']);
  assert.deepEqual(requests.at(-1).payload, {title: 'Summary', body: 'Summarize {{topic}}', scope: 'private'});
  const fields = el('chat-prompt-values');
  fields.querySelector('input').value = 'work';
  composer.value = 'Keep this';
  receipt = Promise.withResolvers();
  await fire(el('chat-prompt-insert-form'), 'submit', {preventDefault() {}});
  receipt.resolve({text: 'x'.repeat(4000), missing: []});
  await settle(2);
  assert.match(el('chat-prompt-status').textContent, /message limit/);
  assert.equal(composer.value, 'Keep this');
  assert.equal(changed, 0);

  receipt = Promise.withResolvers();
  await fire(el('chat-prompt-insert-form'), 'submit', {preventDefault() {}});
  scope = 'owner-workspace-other-thread';
  receipt.resolve({text: 'Summarize work', missing: []});
  await settle(2);
  assert.equal(composer.value, 'Keep this');
  assert.equal(changed, 0);

  scope = 'owner-workspace-thread';
  receipt = Promise.withResolvers();
  await fire(el('chat-prompt-insert-form'), 'submit', {preventDefault() {}});
  receipt.resolve({text: 'Summarize work', missing: []});
  await settle(2);
  assert.equal(composer.value, 'Keep this\n\nSummarize work');
  assert.equal(changed, 1);
  assert.equal(el('chat-prompt-dialog').open, false);
  assert.deepEqual(requests.slice(-3).map(call => call.payload), Array(3).fill({
    id: prompt.id, version: 1, values: {topic: 'work'},
  }));
});

test('model utility errors remain visible and retries retain identity without fake completion', async()=>{
  const {mountMessageUtilities}=await import('../flybot_workspace/static/chat/utilities.mjs');
  const {doc,el}=utilityDocument();const writes=[];const c={wid:'w',cid:'c',kind:'group'};
  const utility=mountMessageUtilities(doc,{context:()=>c,composerContext:()=>c,notify:()=>{},request:async(method,_path,body,headers)=>{
    if(method==='GET')return {status:200,body:{items:[]}};
    writes.push({body,headers});return {status:409,body:{error:{message:'Own runtime is offline'}}};
  }});
  utility.open({id:'message',revision:3},'translate');await settle(2);
  el('message-assist-instruction').value='English';
  await fire(el('message-assist-form'),'submit',{preventDefault(){}});
  assert.equal(el('message-assist-status').textContent,'Own runtime is offline');
  assert.equal(el('message-assist-submit').disabled,false);
  await fire(el('message-assist-form'),'submit',{preventDefault(){}});
  assert.equal(writes[0].headers['Idempotency-Key'],writes[1].headers['Idempotency-Key']);
  assert.equal(writes[0].body.revision,3);assert.equal(el('message-assist-history').children.length,0);
  el('message-assist-dialog').close();
});


test('new dialog and document-card surfaces use actual theme tokens, not undefined white fallbacks', () => {
  const css = readFileSync(new URL('../flybot_workspace/static/chat/app.css', import.meta.url), 'utf8');
  assert.match(css, /#message-assist-dialog, #announcement-dialog \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
  assert.match(css, /#resource-picker \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
  assert.match(css, /\.chat-document-card \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
});


test('conversation search lists photos, files and saved resource versions from real attachment fields', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const back = doc.createElement('button');
  el('conversation-search-return').append(back);
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const base = '/v1/workspaces/ws-1/social/conversations/conv-1';
  const file = (id, title, mime) => ({message_id: id, created_at: 1767225600, attachment: {
    id, title, mime, bytes: 200, path: base + '/messages/' + id + '/file',
  }});
  const photo = file('m-1', '现场照片.png', 'image/png');
  const report = file('m-2', '发布计划.pdf', 'application/pdf');
  const notes = file('m-3', '实施计划.txt', 'text/plain');
  const resource = file('m-4', '发布计划.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  resource.attachment.resource = {kind: 'document', title: '发布计划原件', revision: 2};
  resource.attachment.path += '?revision=2';
  const calls = [];
  let retry = true;
  try {
    await mount(doc, {fetcher: async path => {
      if (path.startsWith(base + '/attachments?')) {
        const params = new URL(path, 'https://flybot-workspace.test').searchParams;
        const scope = Object.fromEntries(params);
        calls.push(scope);
        if (scope.kind === 'photo') return json(200, {items: [photo], next_cursor: null});
        if (scope.kind === 'resource') return json(200, {items: [resource], next_cursor: null});
        if (scope.cursor && retry) {
          retry = false;
          return json(500, {});
        }
        return json(200, scope.cursor ? {items: [notes], next_cursor: null} : {items: [report], next_cursor: 'page-2'});
      }
      if (path.startsWith(base + '/messages?')) {
        const message = new URL(path, 'https://flybot-workspace.test').searchParams.get('around');
        assert.ok(message, 'attachment browsing does not scan history pages');
        const hit = [photo, report, notes, resource].find(row => row.message_id === message);
        return json(200, {items: [{id: message, user_id: bob, body: '', attachment: hit.attachment}], cursor: null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    await fire(el('conversation-search-tab-photos'), 'click');
    assert.equal(el('conversation-search-tab-photos').getAttribute('aria-selected'), 'true');
    const results = el('conversation-search-results');
    assert.equal(results.children.length, 1);
    assert.ok(descendants(results.children[0]).some(node => node.textContent === '现场照片.png'));
    assert.equal(descendants(results.children[0]).some(node => node.tagName === 'IMG'), false);
    assert.match(el('conversation-search-status').textContent, /已显示 1 张照片/);
    await fire(results.children[0].children[0], 'click');
    const jumped = el('message-list').children.find(node => node.dataset.messageId === 'm-1');
    assert.equal(jumped.dataset.searchJump, 'true', 'a photo hit jumps back to its message and highlights it');
    el('conversation-search-query').value = '计划';
    await fire(el('conversation-search-tab-files'), 'click');
    assert.deepEqual(calls, [{kind: 'photo', q: '', limit: '20'}, {kind: 'file', q: '计划', limit: '20'}]);
    assert.equal(results.children.length, 1);
    const [jump, download] = results.children[0].children;
    assert.ok(descendants(jump).some(node => node.textContent === '发布计划.pdf'));
    assert.equal(download.href, report.attachment.path + '?download=1');
    assert.equal(download.download, '发布计划.pdf');
    assert.match(el('conversation-search-status').textContent, /已显示 1 个文件/);
    await fire(el('conversation-search-more'), 'click');
    assert.equal(results.children.length, 1, 'a failed next page preserves results');
    assert.equal(el('conversation-search-retry').hidden, false);
    await fire(el('conversation-search-retry'), 'click');
    assert.equal(results.children.length, 2);
    assert.equal(el('conversation-search-more').hidden, true);
    assert.equal(calls[3].cursor, 'page-2');
    await fire(jump, 'click');
    const located = el('message-list').children.find(node => node.dataset.messageId === 'm-2');
    assert.equal(located.dataset.searchJump, 'true', 'a file outside the window loads and highlights its message');
    const card = located.querySelector('[data-chat-file-path]');
    assert.equal(card.dataset.attachmentJump, 'true');
    assert.equal(card.focused, true);
    results.scrollTop = 50;
    await fire(el('conversation-search-close'), 'click');
    assert.equal(el('conversation-search-return').hidden, false);
    await fire(back, 'click');
    assert.equal(results.children.length, 2);
    assert.equal(results.scrollTop, 50);
    assert.equal(jump.getAttribute('aria-current'), 'true');
    assert.equal(calls.length, 4, 'returning to loaded attachments does not re-query the first page');

    await fire(el('conversation-search-tab-resources'), 'click');
    assert.deepEqual(calls.at(-1), {kind: 'resource', q: '计划', limit: '20'});
    assert.match(el('conversation-search-status').textContent, /已显示 1 份资料/);
    const row = results.children[0];
    assert.match(row.className, /resource-search-hit/);
    const [resourceJump, resourceDownload] = row.children;
    assert.ok(descendants(resourceJump).some(node => node.textContent === '发布计划原件'));
    assert.ok(descendants(resourceJump).some(node => node.textContent === '文档 · 版本 2'));
    assert.equal(resourceDownload.href, resource.attachment.path + '&download=1');
    assert.equal(resourceDownload.download, '发布计划.docx');
    await fire(resourceJump, 'click');
    const originalShare = el('message-list').children.find(node => node.dataset.messageId === 'm-4');
    assert.equal(originalShare.dataset.searchJump, 'true');
    assert.ok(descendants(originalShare).some(node => node.textContent === '文档 · 版本 2'));
  } finally { restore(); }
});

test('attachment search ignores stale tabs and queries and gives an explicit retry and empty state', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const delayed = [];
  let failed = true;
  try {
    await mount(doc, {fetcher: async (path, options) => {
      if (path.includes('/attachments?')) {
        const params = new URL(path, 'https://flybot-workspace.test').searchParams;
        if (params.get('kind') === 'photo' || params.get('q') === 'old') {
          return new Promise(resolve => delayed.push({resolve, signal: options.signal}));
        }
        if (failed) {
          failed = false;
          return json(500, {});
        }
        return json(200, {items: [], next_cursor: null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    const photos = fire(el('conversation-search-tab-photos'), 'click');
    await fire(el('conversation-search-tab-files'), 'click');
    assert.equal(delayed[0].signal.aborted, true);
    assert.match(el('conversation-search-status').textContent, /无法搜索文件/);
    delayed[0].resolve(json(200, {items: [], next_cursor: null}));
    await photos;
    assert.match(el('conversation-search-status').textContent, /无法搜索文件/);
    await fire(el('conversation-search-retry'), 'click');
    assert.match(el('conversation-search-status').textContent, /还没有文件/);

    const submit = () => fire(el('conversation-search-form'), 'submit', {preventDefault() {}});
    const query = el('conversation-search-query');
    query.value = 'old';
    const old = submit();
    query.value = 'new';
    await submit();
    assert.equal(delayed[1].signal.aborted, true);
    delayed[1].resolve(json(200, {items: [{message_id: 'm', attachment: {id: 'm', title: 'old'}}]}));
    await old;
    assert.match(el('conversation-search-status').textContent, /没有找到匹配的文件/);
    assert.equal(el('conversation-search-results').children.length, 0);
  } finally { restore(); }
});

for (const phase of ['directory', 'fanout']) for (const target of ['ws-1','ws-2']) {
  test(`deferred ${phase} from an older load cannot overwrite the latest ${target} session list`, async () => {
    const {doc, el} = fakeChatDocument(chatHtml()); const restore = installChatGlobals();
    let release, first=true; const requests=[];
    const row=id=>({id,kind:'group',title:id,updated:30,members:[]});
    const fetcher=async path=>{
      requests.push(path);
      if(path==='/v1/auth/session')return json(200,{user:{id:'user-1',username:'alice'}});
      if(path==='/v1/onboarding')return json(200,{onboarding:{completed:true}});
      if(path==='/v1/personal-agent')return json(200,{personal_agent:{workspace:{id:'ws-1'}}});
      if(path==='/v1/workspaces?limit=100')return json(200,{items:[{id:'ws-1',name:'First'},{id:'ws-2',name:'Second'}]});
      if(path==='/v1/settings')return json(200,{settings:{values:{}}});
      if(path.endsWith('/agents?limit=100&include=conversations')){
        if(first){first=false;
          if(phase==='directory')return await new Promise(resolve=>{release=()=>resolve(json(200,{items:[{id:'old-agent',name:'old'}]}));});
          return json(200,{items:[{id:'old-agent',name:'old'}]});
        }
        return json(200,{items:[]});
      }
      if(path.includes('/agents/old-agent/conversations?'))return await new Promise(resolve=>{release=()=>resolve(json(200,{items:[{id:'stale-agent-conversation',title:'stale',updated:40}]}));});
      if(path.endsWith('/social/conversations?limit=100'))return json(200,{items:[row(release?'new-current':'old-stale')]});
      if(path.endsWith('/members')||path.endsWith('/artifacts?limit=100'))return json(200,{items:[]});
      return json(404,{error:{message:'not in synthetic fixture'}});
    };
    try{
      mount(doc,{fetcher}); await settle(); assert.equal(typeof release,'function','first real request is pending');
      el('workspace').value=target; await fire(el('workspace'),'change'); await settle();
      const ids=()=>el('conversation-list').children.map(li=>li.children[0]?.dataset.conversation).filter(Boolean);
      assert.deepEqual(ids(),['new-current']);
      release(); await settle(); assert.deepEqual(ids(),['new-current'],'late old data must not overwrite a newer successful load');
      if(phase==='directory')assert.equal(requests.some(path=>path.includes('/agents/old-agent/')),false,'stale directory must not trigger new fanout');
    }finally{restore();}
  });
}


test('native Bot Social activity starts after the directory commits and preserves linked history', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const directory = Promise.withResolvers();
  const activity = scope + '/social/conversations?view=activity';
  fixture.routes.set(scope + linkSocialDirectory, () => directory.promise);
  fixture.routes.set(activity, () => json(200, {version: 'current', items: []}));
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    t.mock.timers.tick(2100);
    await settle();
    assert.equal(fixture.calls.some(call => call.path === activity), false);
    directory.resolve(json(200, {items: []}));
    await loading;
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(fixture.calls.some(call => call.path === activity), true);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/events')), false);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    directory.resolve(json(200, {items: []}));
    fixture.restore();
  }
});


const linkWork = '1'.repeat(32);
const linkTeam = '2'.repeat(32);
const linkUnavailable = '3'.repeat(32);
const linkAgent = '4'.repeat(32);
const linkThread = '5'.repeat(32);
const linkAgentOlder = '6'.repeat(32);
const linkAgentLatest = '7'.repeat(32);
const linkSocial = 'otc_' + '8'.repeat(26);
const linkSocialOlder = 'otm_' + '9'.repeat(26);
const linkSocialLatest = 'otm_' + 'A'.repeat(26);
const linkNativeDirectory = '/agents?limit=100&include=conversations';
const linkSocialDirectory = '/social/conversations?limit=100';
const linkPersonalIdentity = '/v1/workspaces?scope=personal&include=personal-agent';
const linkPersonalDefault = '/v1/workspaces?scope=personal&include=chat';
const linkPersonalStartup = linkPersonalDefault + '&workspace=';
const linkPersonalScopeOnly = workspace => linkPersonalStartup + workspace + '&directory=0';
const linkPersonalEntry = linkPersonalStartup + linkWork + '&entry_agent=' + linkAgent;
const linkPersonalThreadEntry = linkPersonalEntry + '&entry_conversation=' + linkThread + '&directory=0';
const linkBase = workspace => '/v1/workspaces/' + workspace;
const linkNativePath = `/agents/${linkAgent}/conversations/${linkThread}`;
const linkNativeLatest = linkNativePath + '?limit=50';
const linkNativeSnapshot = linkNativeLatest + '&snapshot=1';
const linkSocialPath = '/social/conversations/' + linkSocial;
const linkMember = {user_id: alice, username: 'alice'};

function linkedChatFixture(hash, {visibility = 'visible', narrow = false} = {}) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="flybot-workspace-instance"]' ? {} : null;
  doc.visibilityState = visibility;
  const restore = installChatGlobals({narrow});
  const browser = {handlers: {}};
  globalThis.addEventListener = (type, handler) => (browser.handlers[type] ||= []).push(handler);
  globalThis.location.hash = hash;
  globalThis.history.replaceState = (_state, _unused, url) => {
    globalThis.location.hash = new URL(url, 'https://fixture.invalid').hash;
  };
  const scrolls = [];
  const element = doc.createElement;
  doc.createElement = (tag) => {
    const node = element(tag);
    node.scrollIntoView = (options) => scrolls.push({id: node.dataset.messageId, options});
    return node;
  };
  const calls = [];
  const routes = new Map();
  const agent = {id: linkAgent, name: 'Linked native agent', workspace_id: linkWork, served_by: 'ds-bot'};
  const nativeThread = {id: linkThread, agent_id: linkAgent, workspace_id: linkWork, title: 'Native history',
    unread_count: 2, updated: 5};
  const nativeRows = [
    {id: linkAgentOlder, role: 'user', body: 'Earlier native message', status: 'succeeded', created: 5},
    {id: linkAgentLatest, role: 'assistant', body: 'Latest visible native reply', status: 'succeeded', created: 10},
  ];
  const socialThread = (workspace) => ({id: linkSocial, workspace_id: workspace, kind: 'group', title: 'Linked group',
    unread_count: 3, updated: 30, last_seq: 8, members: [linkMember]});
  const socialRows = [{id: linkSocialLatest, conversation_id: linkSocial, user_id: bob, body: 'Latest group reply', seq: 8, created: 10}];
  const socialOlder = {id: linkSocialOlder, conversation_id: linkSocial, user_id: bob, body: 'Earlier group reply', seq: 2, created: 5};
  const fetcher = async (path, options = {}) => {
    const call = {path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined};
    calls.push(call);
    const compatiblePath = path === linkPersonalEntry || path === linkPersonalThreadEntry ? linkPersonalStartup + linkWork
      : [linkWork, linkTeam].some(workspace => path === linkPersonalScopeOnly(workspace)) ? path.slice(0, -'&directory=0'.length)
      : path.endsWith(linkSocialPath + '?start=unread') ? path.slice(0, -'?start=unread'.length) : path;
    const override = routes.get(path) || routes.get(compatiblePath);
    if (override) return override(call, options);
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === linkPersonalIdentity) return json(200, {items: [
      {id: linkWork, name: 'Personal', kind: 'personal', owner_id: alice},
    ], personal_agent_id: agent.id});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [
      {id: linkWork, name: 'Personal', kind: 'personal'}, {id: linkTeam, name: 'Team', kind: 'team'},
    ]});
    for (const workspace of [linkWork, linkTeam]) {
      const base = linkBase(workspace);
      if (path === base + linkNativeDirectory) return json(200,
        workspace === linkWork ? {items: [agent], conversations: [nativeThread]} : {items: [], conversations: []});
      if (path === base + linkSocialDirectory) return json(200, {items: [socialThread(workspace)]});
      if (compatiblePath === base + linkSocialPath) return json(200, {conversation: socialThread(workspace), items: socialRows, cursor: 8});
      if (path === base + linkSocialPath + '?around=' + linkSocialOlder) {
        return json(200, {conversation: socialThread(workspace), items: [socialOlder], cursor: null, has_newer: true});
      }
      if (path.startsWith(base + linkSocialPath + '/messages?around=')) {
        return json(200, {items: [socialOlder], cursor: null, has_newer: true});
      }
      if (path === base + linkSocialPath + '/read') return json(200, {unread_count: 0});
      if (path.startsWith(base + '/notifications') || path === base + '/members' || path.startsWith(base + '/artifacts?')) {
        return json(200, {items: []});
      }
    }
    if (path === linkBase(linkWork) + linkNativeLatest) return json(200, {agent, conversation: nativeThread, items: nativeRows, cursor: null});
    if (path === linkBase(linkWork) + linkNativePath + '/read') return json(200, {unread_count: 0});
    return json(404, {error: {code: 'not_found'}});
  };
  const navigate = (nextHash) => {
    globalThis.location.hash = nextHash;
    return fire(browser, 'hashchange');
  };
  const messages = () => el('message-list').children.map(node => node.dataset.messageId);
  const selected = () => sessionRows(el).find(row => row?.getAttribute('aria-current') === 'true')?.dataset.conversation;
  return {doc, el, fetcher, routes, calls, scrolls, navigate, messages, selected, agent, nativeThread, nativeRows, restore};
}

function linkedChatSnapshot(fixture, owner = alice, conversations = [fixture.nativeThread]) {
  return json(200, {
    items: [{id: linkWork, kind: 'personal', name: 'Personal', owner_id: owner}],
    personal_agent_id: linkAgent,
    chat: {items: [fixture.agent], conversations},
  });
}

test('private cards remain available after a reply settles and successful choices refresh the same transcript', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const base = linkBase(linkWork) + linkNativePath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  Object.assign(fixture.nativeThread, {archived:false, unread_count:0});
  const choice = {id:'choice-card',type:'choice',bot_name:'Personal Agent',question:'确认采用哪种方案？',
    allow_custom:true,options:[{label:'第一项'},{label:'第二项'}]};
  const approval = {id:'approval-card',type:'approval',bot_name:'Personal Agent',tool:'发布',reason:'确认发布范围'};
  const outcome = {id:'8'.repeat(32),role:'assistant',status:'succeeded',body:'已收到你的选择。',private_card_id:choice.id};
  const response = Promise.withResolvers();
  fixture.routes.set(base + '/action-cards', () => json(200,{cards:[choice,approval]}));
  fixture.routes.set(base + '?limit=50', () => json(200,{agent:fixture.agent,conversation:fixture.nativeThread,items:fixture.nativeRows.slice()}));
  fixture.routes.set(base + '/action-cards/choice-card/answer', () => response.promise);
  fixture.routes.set(base + '/action-cards/approval-card/answer', () => json(200,{ok:true}));
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    const dock = fixture.el('private-action-cards');
    assert.equal(dock.hidden,true);
    assert.equal(fixture.el('message-list').children.at(-1).dataset.messageId,linkAgentLatest);
    t.mock.timers.tick(250);
    await settle();
    const [question, operation] = dock.children;
    assert.equal(dock.hidden,false);
    assert.equal(fixture.el('group-action-cards').hidden,true);
    const [first,, custom] = question.querySelectorAll('input');
    const submit = question.querySelector('[data-card-action="submit"]');
    assert.equal(submit.disabled,true);
    assert.equal(custom.maxLength,1000);
    first.checked = true;
    await fire(first,'change');
    custom.value = '  自己的答案  ';
    await fire(custom,'input');
    assert.equal(first.checked,false);
    assert.equal(submit.disabled,false);
    const event = {preventDefault() {}};
    await fire(question,'submit',event);
    await fire(question,'submit',event);
    assert.equal(submit.disabled,true);
    const answers = () => fixture.calls.filter(call => call.path.endsWith('/answer'));
    assert.deepEqual(answers().map(call => call.body),[{custom:'自己的答案'}]);
    fixture.nativeRows.push(outcome);
    response.resolve(json(200,{ok:true}));
    await settle();
    assert.equal(fixture.el('message-list').children.at(-1).dataset.messageId,outcome.id);
    assert.deepEqual(dock.children,[operation]);
    await fire(operation.querySelector('[data-card-action="reject"]'),'click');
    await settle();
    assert.deepEqual(answers().map(call => [call.method,call.path,call.body]),[
      ['POST',base + '/action-cards/choice-card/answer',{custom:'自己的答案'}],
      ['POST',base + '/action-cards/approval-card/answer',{choice:'reject'}],
    ]);
    assert.equal(dock.hidden,true);
    t.mock.timers.tick(3000);
    await settle();
    assert.equal(dock.hidden,true,'a stale snapshot cannot revive answered cards');
  } finally {
    response.resolve(json(503,{}));
    fixture.restore();
  }
});

test('private card reads are cancelled and old card controls are detached on conversation change', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  Object.assign(fixture.nativeThread,{archived:false,unread_count:0});
  const cardPath = linkBase(linkWork) + linkNativePath + '/action-cards';
  const card = {id:'pending-approval',type:'approval',bot_name:'Personal Agent',tool:'保存'};
  const pending = Promise.withResolvers();
  let reads = 0;
  let signal;
  fixture.routes.set(cardPath, (_call,options) => {
    if (!reads++) return json(200,{cards:[card]});
    signal = options.signal;
    return pending.promise;
  });
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    t.mock.timers.tick(250);
    await settle();
    const dock = fixture.el('private-action-cards');
    const allow = dock.querySelector('[data-card-action="allow"]');
    assert.ok(allow);
    t.mock.timers.tick(3000);
    await settle();
    assert.equal(signal.aborted,false);
    await fixture.navigate(`#workspace=${linkTeam}&social=${linkSocial}`);
    await settle();
    assert.equal(signal.aborted,true);
    assert.equal(dock.hidden,true);
    await fire(allow,'click');
    pending.resolve(json(200,{cards:[card]}));
    await settle();
    assert.deepEqual(dock.children,[]);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/answer')),false);
  } finally {
    pending.resolve(json(503,{}));
    fixture.restore();
  }
});

test('long private and group replies render once even with a saved folding setting', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const title = '独立标题';
  const end = '完整回复末尾';
  const text = `### ${title}\n\n${'需要直接显示的详细内容。'.repeat(90)}\n\n${end}`;
  for (const group of [false,true]) {
    const workspace = group ? linkTeam : linkWork;
    const fixture = linkedChatFixture(`#workspace=${workspace}&${group ? 'social=' + linkSocial
      : 'agent=' + linkAgent + '&conversation=' + linkThread}`);
    const createElement = fixture.doc.createElement;
    fixture.doc.createElement = tag => {
      const node = createElement(tag);
      Object.defineProperty(node,'firstChild',{get:() => node.text ? {remove:() => { node.text = ''; }} : node.children[0]});
      node.removeChild = child => child.remove();
      return node;
    };
    fixture.routes.set('/v1/settings', () => json(200, {settings:{values:{message_folding:'compact',link_previews:false}}}));
    if (group) {
      const conversation = {id:linkSocial,workspace_id:workspace,kind:'group',title:'审核群',members:[linkMember]};
      fixture.routes.set(linkBase(workspace) + linkSocialPath, () => json(200, {conversation,items:[
        {id:linkSocialLatest,conversation_id:linkSocial,user_id:bob,role:'agent',
          agent_id:linkAgent,agent_name:'群内 Bot',body:text,seq:8,created:10},
      ]}));
    } else fixture.nativeRows[1].body = text;
    try {
      await mount(fixture.doc,{fetcher:fixture.fetcher});
      await settle();
      const row = fixture.el('message-list').children.find(item => item.dataset.messageId === (group ? linkSocialLatest : linkAgentLatest));
      const body = row.children.find(node => node.className === 'body');
      assert.match(body.textContent,new RegExp(end + '$'));
      assert.equal(body.textContent.split(title).length,2);
      assert.equal(descendants(body).some(node => node.tagName === 'DETAILS'),false);
      assert.ok(descendants(body).some(node => node.tagName === 'H3' && node.textContent === title));
    } finally { fixture.restore(); }
  }
});

for (const removed of [false, true]) {
  test(`global message search ${removed ? 'opens the latest window if the target disappeared' : 'opens the exact group window on the first read'}`, async t => {
    t.mock.timers.enable({apis:['setTimeout']});
    const fixture = linkedChatFixture('#workspace=' + linkWork);
    const base = linkBase(linkWork);
    const path = base + linkSocialPath;
    const exact = path + '?around=' + linkSocialOlder;
    const target = {id:linkSocialOlder, conversation_id:linkSocial, user_id:bob, seq:2, body:'Historical target'};
    const conversation = {id:linkSocial, workspace_id:linkWork, kind:'group', title:'Linked group',
      members:[linkMember], unread_count:3};
    fixture.routes.set(base + '/search/messages?q=historical&limit=20', () => json(200, {items:[
      {kind:'social', conversation_id:linkSocial, message_id:linkSocialOlder, title:'Linked group', snippet:'Historical target'},
    ]}));
    fixture.routes.set(exact, () => removed
      ? json(404, {error:{code:'history_anchor_missing'}})
      : json(200, {conversation, items:[target], cursor:null, has_newer:true}));
    try {
      await mount(fixture.doc, {fetcher:fixture.fetcher});
      const input = fixture.el('session-search');
      await fire(input, 'focus');
      input.value = 'historical';
      await fire(input, 'input');
      await settle();
      const result = descendants(fixture.el('search-results')).find(node => node.tagName === 'BUTTON' &&
        node.children.some(child => child.textContent === 'Historical target'));
      assert.ok(result);
      const offset = fixture.calls.length;
      await fire(result, 'click');
      await settle();
      const reads = fixture.calls.slice(offset).filter(call => call.path === path || call.path.startsWith(path + '?') ||
        call.path.startsWith(path + '/messages') || call.path === path + '/read');
      assert.deepEqual(reads.map(call => [call.method, call.path]), removed
        ? [['GET', exact], ['GET', path]]
        : [['GET', exact]]);
      assert.deepEqual(fixture.messages(), [removed ? linkSocialLatest : linkSocialOlder]);
      assert.equal(fixture.el('message-list').children[0].dataset.searchJump, removed ? undefined : 'true');
      assert.equal(fixture.el('status').textContent, removed ? '找不到这条来源消息。' : '');
    } finally {
      fixture.restore();
    }
  });
}

test('pending private text keeps its send key alongside an independent newer draft', () => {
  const {view} = publicOpeningView();
  const scope = JSON.stringify([alice,linkWork,'agent',linkAgent,linkThread]);
  const other = JSON.stringify([bob,linkWork,'agent',linkAgent,linkThread]);
  const fresh = JSON.stringify([alice,linkWork,'agent',linkAgent,null]);
  const key = 'msg-confirm-original-key';
  const message = {body:'先发出的消息',chat_language:'zh-CN'};
  assert.equal(savePendingChatText(view,scope,key,message),true);
  assert.equal(writeChatDrafts(view,alice,new Map([[scope,'后写的草稿']])),true);
  assert.deepEqual(readPendingChatText(view,scope),[{key,message}]);
  assert.deepEqual(readPendingChatText(view,other),[]);
  assert.equal(savePendingChatText(view,fresh,key,message),false);
  assert.equal(savePendingChatText(view,scope,key),true);
  assert.deepEqual(readPendingChatText(view,scope),[]);
  assert.equal(readChatDrafts(view,alice).get(scope),'后写的草稿');
});

test('a pending first private message keeps its creation key and preferences scoped to the draft agent', () => {
  const {view} = publicOpeningView();
  const blank = (owner,workspace,agent) => JSON.stringify([owner,workspace,'agent',agent,null]);
  const scope = blank(alice,linkWork,linkAgent);
  const key = 'chat-original-creation-key';
  const message = {body:'创建会话时发送的第一条',chat_language:'zh-CN',memory_scope:'off'};
  assert.equal(savePendingChatText(view,scope,key,message),true);
  assert.equal(writeChatDrafts(view,alice,new Map([[scope,'后写的草稿']])),true);
  assert.deepEqual(readPendingChatText(view,scope),[{key,message}]);
  assert.deepEqual(readPendingChatText(view,blank(bob,linkWork,linkAgent)),[]);
  assert.deepEqual(readPendingChatText(view,blank(alice,linkTeam,linkAgent)),[]);
  assert.deepEqual(readPendingChatText(view,blank(alice,linkWork,linkAgentOlder)),[]);
  assert.equal(savePendingChatText(view,scope,key),true);
  assert.deepEqual(readPendingChatText(view,scope),[]);
  assert.equal(readChatDrafts(view,alice).get(scope),'后写的草稿');
});

test('pending shared text preserves the exact quote, mention and destination alongside a newer draft', () => {
  const {view} = publicOpeningView();
  const scope = JSON.stringify([alice,linkTeam,'social',null,linkSocial]);
  const privateScope = JSON.stringify([alice,linkWork,'agent',linkAgent,linkThread]);
  const key = 'socialmsg-original-request';
  const message = {body:'先发出的群消息',reply_to:linkSocialLatest,
    agent_mentions:[{owner_id:bob,agent_id:linkAgent}],direct_agent_request:true};
  assert.equal(savePendingChatText(view,scope,key,{...message,reply:{excerpt:'只保留引用消息的 ID'}}),true);
  assert.equal(writeChatDrafts(view,alice,new Map([[scope,'新草稿']])),true);
  assert.deepEqual(readPendingChatText(view,scope),[{key,message}]);
  assert.deepEqual(readPendingChatText(view,JSON.stringify([bob,linkTeam,'social',null,linkSocial])),[]);
  assert.deepEqual(readPendingChatText(view,JSON.stringify([alice,linkWork,'social',null,linkSocial])),[]);
  assert.deepEqual(readPendingChatText(view,JSON.stringify([alice,linkTeam,'social',null,linkSocial+'X'])),[]);
  assert.equal(savePendingChatText(view,scope,key,{...message,reply_to:'../another-room'}),false);
  assert.equal(savePendingChatText(view,scope,key,{...message,reply_to:[linkSocialLatest]}),false);
  assert.equal(savePendingChatText(view,privateScope,key,message),false);
  assert.equal(savePendingChatText(view,scope,key),true);
  assert.equal(readChatDrafts(view,alice).get(scope),'新草稿');
});

test('existing private pending text can still be recovered from browser storage', () => {
  const {saved,view} = publicOpeningView();
  const scope = JSON.stringify([alice,linkWork,'agent',linkAgent,linkThread]);
  const pendingPrivateText = [{key:'msg-before-release-key',message:{body:'加载前发送的消息'}}];
  saved.set('flybot-workspace.chat-drafts:'+alice,JSON.stringify({[scope]:{body:'编辑中的草稿',pendingPrivateText}}));
  assert.deepEqual(readPendingChatText(view,scope),pendingPrivateText);
  assert.equal(readChatDrafts(view,alice).get(scope),'编辑中的草稿');
});

for (const alreadyDelivered of [false,true]) {
  test(`reopening a shared chat ${alreadyDelivered ? 'recognizes a quoted send from its receipt' : 'restores a quoted send without an automatic resend'}`, async () => {
    const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
    const {doc, el, calls, routes, restore} = fixture;
    const {view} = publicOpeningView();
    doc.defaultView = view;
    const scope = JSON.stringify([alice,linkTeam,'social',null,linkSocial]);
    const path = linkBase(linkTeam) + linkSocialPath + '/messages';
    const key = 'socialmsg-original-request';
    const body = '加载前发送的群消息';
    const message = {body,reply_to:linkSocialLatest};
    const receipt = {id:'otm_'+'B'.repeat(26),client_key:key,user_id:alice,workspace_id:linkTeam,
      conversation_id:linkSocial,body,seq:9,created:15};
    savePendingChatText(view,scope,key,message);
    writeChatDrafts(view,alice,new Map([[scope,'继续写的草稿']]));
    routes.set(path+'?limit=50', () => json(200,{items:[alreadyDelivered ? receipt : {...receipt,user_id:bob}]}));
    const writes = [];
    const fetcher = async (url, options = {}) => {
      if (url !== path || options.method !== 'POST') return fixture.fetcher(url, options);
      writes.push({key:options.headers['Idempotency-Key'],body:JSON.parse(options.body)});
      return json(201,{message:receipt});
    };
    try {
      await mount(doc,{fetcher});
      await settle();
      assert.deepEqual(writes,[]);
      assert.equal(el('chat-body').value,'继续写的草稿');
      assert.equal(calls.filter(call => call.path === path+'?limit=50' && call.method === 'GET').length,1);
      const failed = el('message-list').children.find(row => row.dataset.sendPending === 'failed');
      if (alreadyDelivered) {
        assert.equal(failed,undefined);
      } else {
        assert.ok(failed);
        const preview = failed.children.find(node => node.className === 'message-quote');
        assert.equal(preview.children[1].textContent,'Latest group reply');
        const retry = failed.children.find(node => node.className === 'send-actions').children[0];
        await fire(retry,'click');
        await settle();
        assert.deepEqual(writes,[{key,body:message}]);
      }
      assert.deepEqual(readPendingChatText(view,scope),[]);
      assert.equal(fixture.messages().filter(id => id === receipt.id).length,1);
      assert.equal(el('chat-body').value,'继续写的草稿');
    } finally {
      restore();
    }
  });
}

test('an interrupted group send checks for its exact receipt and retries the original key if no receipt exists', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, calls, routes, restore} = fixture;
  const path = linkBase(linkTeam) + linkSocialPath + '/messages';
  const receiptPath = path + '?limit=50';
  const keys = [];
  const body = '一条需要确认的群消息';
  const newer = '继续写的草稿';
  const saved = {id:'otm_' + 'C'.repeat(26),workspace_id:linkTeam,conversation_id:linkSocial,user_id:alice,
    body,seq:9,created:20};
  routes.set(receiptPath, () => json(200, {items:[
    {...saved,client_key:keys[0],user_id:bob},
    {...saved,client_key:keys[0],workspace_id:linkWork},
    {...saved,client_key:keys[0],conversation_id:linkSocialOlder},
    {...saved,client_key:'different-request'},
  ]}));
  const fetcher = async (url, options = {}) => {
    if (url !== path || options.method !== 'POST') return fixture.fetcher(url, options);
    keys.push(options.headers['Idempotency-Key']);
    assert.deepEqual(JSON.parse(options.body),{body});
    if (keys.length === 1) throw new TypeError('Connection interrupted');
    return json(201,{message:{...saved,client_key:keys[0]}});
  };
  try {
    await mount(doc,{fetcher});
    el('chat-body').value = body;
    await fire(el('chat-form'),'submit',{preventDefault() {}});
    assert.equal(el('chat-body').value,'');
    el('chat-body').value = newer;
    await fire(el('chat-body'),'input');
    await settle();
    const failed = el('message-list').children.find(row => row.dataset.sendPending === 'failed');
    assert.ok(failed);
    assert.equal(el('chat-body').value,newer);
    assert.equal(fixture.messages().includes(saved.id),false);
    assert.equal(calls.filter(call => call.path === receiptPath && call.method === 'GET').length,1);
    assert.equal(keys.length,1);
    const retry = failed.children.find(node => node.className === 'send-actions').children[0];
    await fire(retry,'click');
    await settle();
    assert.ok(keys[0]);
    assert.deepEqual(keys,[keys[0],keys[0]]);
    assert.equal(calls.filter(call => call.path === receiptPath && call.method === 'GET').length,1);
    assert.equal(el('chat-body').value,newer);
    assert.equal(fixture.messages().filter(id => id === saved.id).length,1);
  } finally {
    restore();
  }
});

test('a native group send releases the next message only after activity confirms its own exact receipt', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, calls, routes, restore} = fixture;
  const base = linkBase(linkTeam);
  const activity = base + '/social/conversations?view=activity';
  const path = base + linkSocialPath + '/messages';
  const receiptPath = path + '?limit=50';
  const heldResponse = Promise.withResolvers();
  const keys = [];
  const first = {id:'otm_' + 'B'.repeat(26), workspace_id:linkTeam, conversation_id:linkSocial,
    body:'第一条已保存的群消息', seq:10, created:10};
  const second = {id:'otm_' + 'C'.repeat(26), workspace_id:linkTeam, conversation_id:linkSocial,
    body:'第二条群消息', seq:11, created:11};
  const snapshot = (version, last_seq) => json(200, {
    version, items:[{id:linkSocial, last_seq, activity_version:version}],
  });
  routes.set(activity, () => snapshot('other-message', 9));
  routes.set(activity + '&since=other-message', () => snapshot('own-message', 10));
  routes.set(receiptPath, () => json(200, {
    items:[{...first, client_key:keys[0], user_id:'social-owner',
      mine:calls.filter(call => call.path === receiptPath).length === 2}],
  }));
  const fetcher = async (url, options = {}) => {
    if (url !== path || options.method !== 'POST') return fixture.fetcher(url, options);
    const key = options.headers['Idempotency-Key'];
    keys.push(key);
    if (JSON.parse(options.body).body === first.body) return heldResponse.promise;
    return json(201, {message:{...second, client_key:key, user_id:alice}});
  };
  const send = async body => {
    el('chat-body').value = body;
    await fire(el('chat-form'),'submit',{preventDefault() {}});
    assert.equal(el('chat-body').value,'');
  };
  try {
    await mount(doc,{fetcher});
    await send(first.body);
    await send(second.body);
    assert.equal(keys.length, 1);
    t.mock.timers.tick(2000); await settle();
    assert.equal(keys.length, 1, 'another sender cannot confirm an active send');
    assert.equal(fixture.messages().includes(first.id), false);
    t.mock.timers.tick(2000); await settle();
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0],keys[1]);
    assert.deepEqual(fixture.messages(), [linkSocialLatest,first.id,second.id]);
    assert.equal(el('message-list').children.find(row => row.dataset.messageId === first.id).className, 'mine');
    heldResponse.resolve(json(502,{}));
    await settle();
    assert.deepEqual(fixture.messages(), [linkSocialLatest,first.id,second.id]);
    assert.equal(calls.filter(call => call.path === receiptPath).length, 2);
  } finally {
    heldResponse.resolve(json(502,{}));
    restore();
  }
});

test('a lost native voice response recognizes only the owner’s matching recording receipt', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}`);
  const {doc,el,routes,calls,restore} = fixture;
  const path = linkBase(linkWork) + linkSocialPath;
  const media = new Map(['navigator','MediaRecorder'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const keys = [];
  let stored;
  let stopped = 0;
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.dispatchEvent(Object.assign(new Event('dataavailable'),{data:new Blob(['audio'])}));
      this.dispatchEvent(new Event('stop'));
    }
  }
  Object.defineProperty(globalThis,'MediaRecorder',{configurable:true,value:Recorder});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{
    async getUserMedia() { return {getTracks:()=>[{stop(){stopped++;}}]}; },
  }}});
  routes.set(path + '/messages',(call,opts)=>{
    assert.equal(call.body.voice.mime,'audio/webm');
    keys.push(opts.headers['Idempotency-Key']);
    stored = {id:'otm_' + 'D'.repeat(26),workspace_id:linkWork,conversation_id:linkSocial,user_id:alice,
      client_key:keys[0],body:'',voice:{mime:'audio/webm'},seq:9};
    return json(503,{});
  });
  routes.set(path + '/messages?limit=50',()=>json(200,{items:[{...stored,user_id:bob},...(keys.length>1?[stored]:[])]}));
  try {
    await mount(doc,{fetcher:fixture.fetcher});
    el('chat-body').value = 'Separate text draft';
    await fire(el('voice-record'),'click');
    await fire(el('voice-stop'),'click');
    assert.equal(stopped,1);
    await fire(el('voice-send'),'click');
    assert.equal(el('voice-draft-panel').hidden,false);
    assert.equal(el('voice-send').disabled,false);
    assert.deepEqual(fixture.messages(),[linkSocialLatest]);
    await fire(el('voice-send'),'click');
    assert.equal(keys.length,2);
    assert.equal(keys[0],keys[1]);
    assert.equal(el('voice-draft-panel').hidden,true);
    assert.deepEqual(fixture.messages(),[linkSocialLatest,stored.id]);
    assert.equal(el('chat-body').value,'Separate text draft');
    assert.deepEqual(calls.filter(call=>call.path===path || call.path===path+'?start=unread').map(call=>call.path),
      [path+'?start=unread']);
  } finally {
    for (const [name,descriptor] of media) {
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
    restore();
  }
});

for (const unavailable of [false,true]) {
  test(`sending from a historical group keeps the receipt ${unavailable ? 'visible when the latest read fails' : 'until the latest window arrives'}`, async () => {
    const base = linkBase(linkWork);
    const path = base + linkSocialPath;
    const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}&message=${linkSocialOlder}`);
    const {el, routes, calls, restore} = fixture;
    const conversation = {id:linkSocial, workspace_id:linkWork, kind:'group', title:'Linked group', members:[linkMember]};
    const latest = {id:linkSocialLatest, conversation_id:linkSocial, user_id:bob, seq:110, body:'Latest group context'};
    const sending = Promise.withResolvers();
    const returning = Promise.withResolvers();
    let message;
    let retriedLatest = false;
    routes.set(path + '/messages', (call, opts) => {
      message = {...latest,id:'otm_' + 'B'.repeat(26),user_id:alice,workspace_id:linkWork,
        client_key:opts.headers['Idempotency-Key'],seq:111,body:call.body.body};
      return sending.promise;
    });
    routes.set(path, () => retriedLatest ? json(200,{conversation,items:[latest,message]}) : returning.promise);
    const pendingRow = () => el('message-list').children.find(node=>node.dataset.sendPending==='pending');
    try {
      await mount(fixture.doc,{fetcher:fixture.fetcher});
      el('chat-body').value = 'Send while reading the group history';
      await fire(el('chat-form'),'submit',{preventDefault() {}});
      assert.equal(el('chat-body').value,'');
      assert.ok(pendingRow());
      el('chat-body').value = 'Independent next message';
      sending.resolve(json(201,{message}));
      await settle();
      assert.match(descendants(pendingRow()).find(node=>node.classList.contains('send-feedback')).textContent,/已发送/);
      assert.deepEqual(fixture.messages().filter(Boolean),[linkSocialOlder]);
      assert.equal(calls.filter(call=>call.path===path).length,1);
      assert.equal(el('chat-back-to-latest').disabled,true);
      returning.resolve(unavailable ? json(503,{}) : json(200,{conversation,items:[latest,message]}));
      await settle();
      if (unavailable) {
        assert.ok(pendingRow());
        assert.equal(el('chat-back-to-latest').disabled,false);
        retriedLatest = true;
        await fire(el('chat-back-to-latest'),'click');
        await settle();
      }
      assert.deepEqual(fixture.messages(),[latest.id,message.id]);
      assert.equal(pendingRow(),undefined);
      assert.equal(el('chat-body').value,'Independent next message');
      assert.equal(calls.filter(call=>call.path===path + '/messages' && call.method==='POST').length,1);
    } finally {
      sending.resolve(json(503,{}));
      returning.resolve(json(503,{}));
      restore();
    }
  });
}

test('switching workspaces records the original thread and updates the new history entry when a conversation opens', async () => {
  const original = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`;
  const fixture = linkedChatFixture(original, {narrow:true});
  const {doc, el, selected, restore} = fixture;
  const entries = [original];
  const hashFrom = url => new URL(url, 'https://fixture.invalid').hash;
  globalThis.history.pushState = (_state, _title, url) => {
    globalThis.location.hash = hashFrom(url);
    entries.push(globalThis.location.hash);
  };
  globalThis.history.replaceState = (_state, _title, url) => {
    globalThis.location.hash = hashFrom(url);
    entries[entries.length - 1] = globalThis.location.hash;
  };
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    await settle();
    assert.equal(selected(), linkThread);
    el('workspace').value = linkTeam;
    await fire(el('workspace'), 'change');
    assert.deepEqual(entries, [original, `#workspace=${linkTeam}`]);
    const group = sessionRows(el).find(row => row.dataset.conversation === linkSocial);
    await fire(el('conversation-list'), 'click', {target:group});
    assert.equal(selected(), linkSocial);
    assert.deepEqual(entries, [original, `#workspace=${linkTeam}&social=${linkSocial}`]);

    await fixture.navigate(original);
    await settle();
    assert.equal(el('workspace').value, linkWork);
    assert.equal(selected(), linkThread);
  } finally {
    await settle();
    restore();
  }
});

test('a reloaded quote keeps its text scoped and ignores a late lookup after changing workspaces', async () => {
  const initial = `#workspace=${linkTeam}&social=${linkSocial}`;
  const fixture = linkedChatFixture(initial);
  const {doc, el, routes, calls, restore} = fixture;
  const {view, saved} = publicOpeningView();
  doc.defaultView = view;
  const scope = JSON.stringify([alice,linkTeam,'social',null,linkSocial]);
  const quoteKey = 'flybot-workspace.chat-quote:' + scope;
  const draft = '引用旧消息的草稿';
  saved.set(quoteKey,linkSocialOlder);
  saved.set('flybot-workspace.chat-drafts:' + alice,JSON.stringify({[scope]:draft}));
  const pending = Promise.withResolvers();
  const path = linkBase(linkTeam) + linkSocialPath + '/messages';
  const older = {id:linkSocialOlder, conversation_id:linkSocial, workspace_id:linkTeam,
    user_id:bob, body:'核对过的原消息', seq:2, created:2};
  let reads = 0;
  routes.set(`${path}?around=${linkSocialOlder}&limit=1`, () => ++reads === 1 ? pending.promise : json(404, {}));
  try {
    await mount(doc,{fetcher:fixture.fetcher});
    assert.equal(el('chat-body').value,draft);
    assert.equal(el('chat-body').disabled,false);
    assert.equal(el('chat-send').disabled,true);
    assert.equal(el('chat-reply-preview').dataset.state,'checking');
    await fire(el('chat-form'),'submit',{preventDefault() {}});
    assert.equal(calls.some(call => call.method === 'POST' && call.path === path),false);

    await fixture.navigate(`#workspace=${linkWork}&social=${linkSocial}`);
    pending.resolve(json(200,{items:[older]}));
    await settle();
    assert.equal(el('chat-reply-preview').hidden,true);
    assert.equal(el('chat-body').value,'');
    await fixture.navigate(initial);
    await settle();
    assert.equal(reads,2);
    assert.equal(el('chat-body').value,draft);
    assert.equal(el('chat-reply-preview').dataset.state,'missing');
    assert.equal(el('chat-send').disabled,true);
    await fire(el('chat-reply-cancel'),'click');
    assert.equal(el('chat-reply-preview').hidden,true);
    assert.equal(el('chat-body').value,draft);
    assert.equal(el('chat-send').disabled,false);
    assert.equal(saved.has(quoteKey),false);
  } finally {
    pending.resolve(json(503,{}));
    restore();
  }
});

test('a definitively rejected quote preserves the newer draft and restores the original owner-specific mention for editing', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, routes, calls, restore} = fixture;
  const {view, saved} = publicOpeningView();
  doc.defaultView = view;
  const scope = JSON.stringify([alice,linkTeam,'social',null,linkSocial]);
  const quoteKey = 'flybot-workspace.chat-quote:' + scope;
  const path = linkBase(linkTeam) + linkSocialPath;
  const messagePath = path + '/messages';
  const targets = [{owner_id:bob,agent_id:linkAgent}];
  const text = '这段文字需要保留';
  const newer = '等候发送时写的另一稿';
  const reply = Promise.withResolvers();
  saved.set(quoteKey,linkSocialLatest);
  writeChatDrafts(view,alice,new Map([[scope,text]]));
  writeChatDraftMentions(view,scope,targets);
  const agentMembers = [alice,bob].map(owner_id => ({id:linkAgent,name:'相同名称',owner_id}));
  const conversation = {id:linkSocial,workspace_id:linkTeam,kind:'group',title:'聊天群',
    members:[linkMember],agent_members:agentMembers,last_seq:8};
  const source = {id:linkSocialLatest,conversation_id:linkSocial,user_id:bob,body:'即将撤回的消息',seq:8};
  routes.set(path, () => json(200,{conversation,items:[source]}));
  routes.set(messagePath, () => reply.promise);
  const submit = () => fire(el('chat-form'),'submit',{preventDefault() {}});
  const sends = () => calls.filter(call => call.path === messagePath && call.method === 'POST');
  try {
    await mount(doc,{fetcher:fixture.fetcher});
    await settle();
    assert.equal(el('chat-body').value,text);
    assert.equal(el('chat-reply-preview').hidden,false);
    await submit();
    assert.equal(el('chat-body').value,'');
    assert.deepEqual(sends()[0].body,{body:text,agent_mentions:targets,reply_to:linkSocialLatest});
    el('chat-body').value = newer;
    await fire(el('chat-body'),'input');

    reply.resolve(json(409,{error:{code:'reply_unavailable'}}));
    await settle();
    assert.equal(el('chat-body').value,newer);
    const failed = el('message-list').children.find(row => row.dataset.sendPending === 'failed');
    const restoreDraft = failed.children.find(node => node.className === 'send-actions').children[0];
    assert.match(restoreDraft.textContent,/恢复到输入框/);
    await fire(restoreDraft,'click');
    assert.equal(el('chat-body').value,newer);
    assert.equal(sends().length,1);

    el('chat-body').value = '';
    await fire(el('chat-body'),'input');
    await fire(restoreDraft,'click');
    assert.equal(el('chat-body').value,text);
    assert.equal(el('chat-reply-preview').dataset.state,'missing');
    assert.equal(el('chat-send').disabled,true);
    assert.equal(readChatDrafts(view,alice).get(scope),text);
    assert.deepEqual(readChatDraftMentions(view,scope),targets);
    assert.equal(saved.get(quoteKey),linkSocialLatest);
    await submit();
    assert.equal(sends().length,1);
    await fire(el('chat-reply-cancel'),'click');
    assert.equal(el('chat-body').value,text);
    assert.equal(el('chat-send').disabled,false);
    await submit();
    assert.deepEqual(sends()[1].body,{body:text,agent_mentions:targets});
  } finally {
    reply.resolve(json(503,{}));
    restore();
  }
});

test('a meeting discussion draft unlocks thread controls only after its exact first message is saved', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const {doc, el, routes, calls, restore} = fixture;
  const receipt = Promise.withResolvers();
  const base = linkBase(linkWork) + linkNativePath;
  const draft = {...fixture.nativeThread, deferred:true, archived:false, unread_count:0, memory_scope:'off', memory_recall:false};
  const controls = ['agent-memory-recall','private-thread-rename','private-thread-archive','history-capture-open'];
  const firstMessage = '根据会议摘要梳理后续行动';
  let payload;
  let key;
  routes.set(linkBase(linkWork) + linkNativeLatest, () => json(200, {agent:fixture.agent, conversation:draft, items:[], cursor:null}));
  const fetcher = (path, options = {}) => {
    if (path === base + '/messages' && options.method === 'POST') {
      payload = JSON.parse(options.body);
      key = options.headers['Idempotency-Key'];
      return receipt.promise;
    }
    return fixture.fetcher(path, options);
  };
  try {
    await mount(doc, {fetcher});
    assert.ok(controls.every(id => el(id).hidden));
    assert.equal(el('chat-body').disabled,false);
    assert.equal(el('chat-send').disabled,false);
    assert.match(el('chat-subtitle').textContent,/发送首条消息后保存对话/);
    await fire(el('agent-memory-recall'),'change');
    await fire(el('private-thread-archive'),'click');
    assert.equal(calls.some(call => call.method === 'POST'), false);

    el('chat-body').value = firstMessage;
    await fire(el('chat-form'),'submit',{preventDefault() {}});
    await settle();
    assert.equal(el('chat-body').value,'');
    assert.equal(payload.body,firstMessage);
    assert.equal(payload.memory_scope,undefined);
    assert.ok(controls.every(id => el(id).hidden));
    const saved = {workspace_id:linkWork,agent_id:linkAgent,conversation_id:linkThread,client_key:key,status:'succeeded',created:20};
    receipt.resolve(json(201,{message:{...saved,id:linkAgentOlder,role:'user',body:firstMessage},
      reply:{...saved,id:linkAgentLatest,role:'assistant',body:'第一条回复'}}));
    await settle();
    assert.ok(controls.every(id => !el(id).hidden));
    assert.equal(el('agent-memory-recall').value,'off');
    assert.equal(el('agent-memory-recall').disabled,false);
    assert.deepEqual(fixture.messages(),[linkAgentOlder,linkAgentLatest]);
  } finally {
    receipt.resolve(json(403,{}));
    restore();
  }
});

for (const includesReceipt of [false, true]) {
  test(`returning to a private chat shows its confirmed background send once when history ${includesReceipt ? 'already includes it' : 'arrives stale'}`, async () => {
    const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
    const {doc, el, routes, agent, nativeThread, nativeRows, messages, restore} = fixture;
    const scope = linkBase(linkWork);
    const returning = Promise.withResolvers();
    const sent = Promise.withResolvers();
    const readPath = scope + linkNativeLatest;
    const writePath = scope + linkNativePath + '/messages';
    const chat = items => json(200, {agent, conversation:nativeThread, items, cursor:null});
    let reads = 0;
    let sendKey;
    routes.set(readPath, () => ++reads === 1 ? chat(nativeRows) : returning.promise);
    const fetcher = (path, options = {}) => {
      if (path === writePath && options.method === 'POST') {
        sendKey = options.headers['Idempotency-Key'];
        return sent.promise;
      }
      return fixture.fetcher(path, options);
    };
    const click = id => fire(el('conversation-list'), 'click', {
      target: sessionRows(el).find(row => row.dataset.conversation === id),
    });
    let returningView;
    try {
      await mount(doc, {fetcher});
      await settle();
      el('chat-body').value = 'This message was sent while switching chats';
      await fire(el('chat-form'), 'submit', {preventDefault() {}});
      assert.equal(el('chat-body').value, '');
      assert.ok(sendKey);
      await click(linkSocial);
      assert.deepEqual(messages(), [linkSocialLatest]);
      el('chat-body').value = 'The other conversation has its own draft';
      await fire(el('chat-body'), 'input');
      returningView = click(linkThread);
      await settle();
      assert.equal(reads, 2);
      const saved = {workspace_id:linkWork, agent_id:linkAgent, conversation_id:linkThread, client_key:sendKey, status:'succeeded', created:20};
      const message = {...saved, id:'c'.repeat(32), role:'user', body:'This message was sent while switching chats'};
      const reply = {...saved, id:'d'.repeat(32), role:'assistant', body:'Confirmed reply'};
      sent.resolve(json(200, {message, reply}));
      await settle();
      assert.deepEqual(messages(), [linkSocialLatest]);
      const latestReply = {...reply, body:'Newer saved reply'};
      returning.resolve(chat(includesReceipt ? [...nativeRows,message,latestReply] : nativeRows));
      await returningView;
      await settle();
      assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest, message.id, reply.id]);
      assert.equal(el('chat-body').value, '');
      assert.equal(reads, 2);
      assert.match(el('message-list').children.at(-1).children[1].textContent,
        includesReceipt ? /Newer saved reply/ : /Confirmed reply/);
      await click(linkSocial);
      assert.equal(el('chat-body').value, 'The other conversation has its own draft');
      assert.deepEqual(messages(), [linkSocialLatest]);
    } finally {
      sent.resolve(json(403, {}));
      returning.resolve(chat(nativeRows));
      await returningView;
      await settle();
      restore();
    }
  });
}

test('returning to a private chat fetches once and keeps the older scroll position until the user loads the update', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const {doc, el, routes, messages, restore} = fixture;
  const returnedMessage = 'c'.repeat(32);
  const conversation = {...fixture.nativeThread, archived:false, unread_count:0};
  const update = [{id:returnedMessage, role:'user', body:'Sent from another device', status:'succeeded', created:15}];
  const resume = Promise.withResolvers();
  let reads = 0;
  routes.set(linkBase(linkWork) + linkNativeLatest, () => {
    if (++reads === 2) return resume.promise;
    return json(200, {agent:fixture.agent, conversation, items:reads === 1 ? fixture.nativeRows : update, cursor:null});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    assert.deepEqual(messages(),[linkAgentOlder,linkAgentLatest]);
    const scroller = el('message-scroller');
    Object.assign(scroller,{scrollHeight:500, clientHeight:100, scrollTop:40});
    const oldNodes = [...el('message-list').children];
    el('chat-body').value = 'unfinished draft';
    await fire(el('chat-body'),'input');
    doc.visibilityState = 'hidden';
    await fire(doc,'visibilitychange');
    assert.equal(reads,1);
    doc.visibilityState = 'visible';
    await fire(doc,'visibilitychange');
    await fire(doc,'visibilitychange');
    assert.equal(reads,2);
    resume.resolve(json(200,{agent:fixture.agent, conversation, items:update, cursor:null}));
    await settle();
    assert.deepEqual(el('message-list').children,oldNodes);
    assert.equal(scroller.scrollTop,40);
    assert.equal(el('conversation-live-update').hidden,false);
    await fire(el('conversation-live-load'),'click');
    assert.deepEqual(messages(),[returnedMessage]);
    assert.equal(el('conversation-live-update').hidden,true);
    assert.equal(el('chat-body').value,'unfinished draft');
  } finally {
    resume.resolve(json(503,{}));
    restore();
  }
});

test('reopening the current mobile conversation shows its cached messages and refreshes once in the background', async () => {
  const hash = '#' + new URLSearchParams({workspace:linkWork, agent:linkAgent, conversation:linkThread});
  const fixture = linkedChatFixture(hash, {narrow:true});
  const {doc, el, routes, messages, restore} = fixture;
  const conversation = {...fixture.nativeThread, archived:false, unread_count:0};
  const incoming = {id:'c'.repeat(32), role:'assistant', body:'Sent from another device', status:'succeeded', created:15};
  const refresh = Promise.withResolvers();
  let reads = 0;
  routes.set(linkBase(linkWork) + linkNativeLatest, () => {
    if (++reads > 1) return refresh.promise;
    return json(200, {agent:fixture.agent, conversation, items:fixture.nativeRows, cursor:null});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    const cached = [...el('message-list').children];
    const draft = el('chat-body');
    draft.value = 'unfinished mobile draft';
    await fire(draft, 'input');
    const reopen = async () => {
      await fire(el('chat-back'), 'click');
      assert.equal(doc.body.classList.contains('sessions-open'), true);
      const button = sessionRows(el).find(row => row.dataset.conversation === linkThread);
      await fire(el('conversation-list'), 'click', {target:button});
      assert.equal(doc.body.classList.contains('sessions-open'), false);
    };
    await reopen();
    assert.equal(reads, 2);
    assert.deepEqual([...el('message-list').children], cached);
    assert.equal(draft.value, 'unfinished mobile draft');
    await reopen();
    assert.equal(reads, 2, 'another return shares the pending refresh');

    refresh.resolve(json(200, {agent:fixture.agent, conversation, items:[...fixture.nativeRows,incoming], cursor:null}));
    await settle();
    assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest, incoming.id]);
    assert.equal(draft.value, 'unfinished mobile draft');
  } finally {
    refresh.resolve(json(503, {}));
    restore();
  }
});

for (const hasGap of [false, true]) {
  test(`the plain inbox sends before native history loads and ${hasGap ? 'keeps a history gap out of view' : 'shows the confirmed next message'}`, async () => {
    const fixture = linkedChatFixture('', {narrow:true});
    const {doc, el, routes, calls, messages, selected, restore} = fixture;
    const personal = Promise.withResolvers();
    const scope = linkBase(linkWork);
    const path = scope + linkSocialPath;
    const next = 'otm_' + 'B'.repeat(26);
    routes.set(linkPersonalDefault, () => personal.promise);
    routes.set(path + '?start=unread', () => json(200, {
      conversation:{id:linkSocial, workspace_id:linkWork, kind:'group', title:'Linked group', unread_count:3,
        updated:30, last_seq:8, members:[linkMember]},
      items:[{id: linkSocialLatest, conversation_id:linkSocial, user_id:bob, seq:8, body:'Unread group message'}],
      unread_window:{first:{id:linkSocialLatest, seq:8}, read_seq:7, last_seq:8, has_newer:false},
    }));
    routes.set(path + '/messages', () => json(201, {message:{
      id:next, conversation_id:linkSocial, user_id:alice, seq:hasGap ? 10 : 9, body:'Reply before the inbox finishes',
    }}));
    const loading = mount(doc, {fetcher:fixture.fetcher});
    try {
      await settle();
      assert.equal(el('workspace').value, linkWork);
      const group = sessionRows(el).find(row => row.dataset.conversation === linkSocial);
      assert.ok(group);
      await fire(el('conversation-list'), 'click', {target:group});
      assert.equal(selected(), linkSocial);
      assert.deepEqual(messages().filter(Boolean), [linkSocialLatest]);
      el('chat-body').value = 'Reply before the inbox finishes';
      await fire(el('chat-form'), 'submit', {preventDefault() {}});
      await settle();
      assert.equal(el('chat-body').value, '');
      assert.deepEqual(messages().filter(Boolean), hasGap ? [linkSocialLatest] : [linkSocialLatest,next]);
      assert.equal(el('conversation-live-update').hidden, !hasGap);
      assert.equal(calls.filter(call => call.path === path + '/messages').length, 1);
      assert.equal(calls.some(call => call.path === scope + linkNativeDirectory), false);
      personal.resolve(linkedChatSnapshot(fixture));
      await loading;
      await settle();
      assert.ok(sessionRows(el).some(row => row.dataset.conversation === linkThread));
      assert.equal(selected(), linkSocial);
      assert.equal(calls.some(call => call.path === scope + linkNativeDirectory), false);
    } finally {
      personal.resolve(json(503, {}));
      await loading;
      await settle();
      restore();
    }
  });
}

test('an exact shared chat and its group sidebar are usable while the personal startup and agent directory wait', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, calls, messages, selected, restore} = fixture;
  const personal = Promise.withResolvers();
  const agents = Promise.withResolvers();
  const scope = linkBase(linkTeam);
  routes.set(linkPersonalStartup + linkTeam, () => personal.promise);
  routes.set(scope + linkNativeDirectory, () => agents.promise);
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    await settle();
    assert.equal(el('workspace').value, linkTeam);
    assert.equal(selected(), linkSocial);
    assert.deepEqual(messages(), [linkSocialLatest]);
    assert.equal(el('chat-body').disabled, false);
    assert.ok(calls.some(call => call.path === linkPersonalScopeOnly(linkTeam)));
    assert.ok(calls.some(call => call.path === scope + linkNativeDirectory));
    assert.ok(calls.some(call => call.path === scope + linkSocialDirectory));

    await fixture.navigate(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
    assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest]);
    personal.resolve(linkedChatSnapshot(fixture));
    agents.resolve(json(200, {items:[], conversations:[]}));
    await settle();
    assert.equal(el('workspace').value, linkWork);
    assert.equal(selected(), linkThread);
    assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    personal.resolve(json(503, {}));
    agents.resolve(json(503, {}));
    restore();
  }
});

test('an authorized personal group opens while the personal snapshot and native sidebar wait', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, calls, messages, selected, restore} = fixture;
  const personal = Promise.withResolvers();
  const agents = Promise.withResolvers();
  const scope = linkBase(linkWork);
  routes.set(linkPersonalScopeOnly(linkWork), () => personal.promise);
  routes.set(scope + linkNativeDirectory, () => agents.promise);
  const loading = mount(doc, {fetcher:fixture.fetcher});
  try {
    await settle();
    assert.equal(el('workspace').value, linkWork);
    assert.equal(selected(), linkSocial);
    assert.deepEqual(messages(), [linkSocialLatest]);
    assert.equal(el('chat-body').disabled, false);
    assert.equal(calls.filter(call => call.path.startsWith(scope + linkSocialPath + '?')).length, 1);
    assert.ok(calls.some(call => call.path === linkPersonalScopeOnly(linkWork)));
  } finally {
    personal.resolve(linkedChatSnapshot(fixture));
    agents.resolve(json(200, {items:[fixture.agent], conversations:[fixture.nativeThread]}));
    await loading;
    await settle();
    restore();
  }
});

test('an authorized team workspace entry starts loading its sidebar before the personal binding returns', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkTeam}`, {narrow:true});
  const {doc, el, routes, calls, restore} = fixture;
  const personal = Promise.withResolvers();
  routes.set(linkPersonalStartup + linkTeam, () => personal.promise);
  const loading = mount(doc, {fetcher:fixture.fetcher});
  try {
    await settle();
    assert.equal(el('workspace').value, linkTeam);
    assert.ok(calls.some(call => call.path === linkBase(linkTeam) + linkSocialDirectory));
    assert.ok(calls.some(call => call.path === linkBase(linkTeam) + linkNativeDirectory));
    assert.equal(calls.some(call => call.path === linkBase(linkWork) + linkNativeDirectory), false);
  } finally {
    personal.resolve(linkedChatSnapshot(fixture));
    await loading;
    await settle();
    restore();
  }
});

test('an exact team workspace private chat opens before personal startup and keeps its draft when that startup settles', async () => {
  const hash = `#workspace=${linkTeam}&agent=${linkAgent}&conversation=${linkThread}`;
  const fixture = linkedChatFixture(hash, {narrow:true});
  const {doc, el, routes, calls, messages, restore} = fixture;
  const personal = Promise.withResolvers();
  const permission = Promise.withResolvers();
  const scope = linkBase(linkTeam);
  const startup = linkPersonalThreadEntry.replace('workspace=' + linkWork, 'workspace=' + linkTeam);
  routes.set(startup, () => personal.promise);
  routes.set('/v1/workspaces?limit=100', () => permission.promise);
  routes.set(scope + linkNativeLatest, () => json(200, {agent:{...fixture.agent, workspace_id:linkTeam},
    conversation:{...fixture.nativeThread, workspace_id:linkTeam}, items:fixture.nativeRows}));
  try {
    const opening = mount(doc, {fetcher:fixture.fetcher});
    await settle();
    assert.ok(calls.some(call => call.path === startup));
    assert.equal(calls.some(call => call.path === scope + linkNativeLatest), false);
    permission.resolve(json(200, {items:[
      {id:linkWork, name:'Personal', kind:'personal'}, {id:linkTeam, name:'Team', kind:'team'},
    ]}));
    await settle();
    assert.equal(el('workspace').value, linkTeam);
    assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(el('chat-body').disabled, false);
    el('chat-body').value = 'draft entered before personal startup';
    await fire(el('chat-body'), 'input');
    personal.resolve(linkedChatSnapshot(fixture));
    await opening;
    await settle();
    assert.deepEqual(messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(el('chat-body').value, 'draft entered before personal startup');
    assert.equal(calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
    assert.equal(calls.some(call => call.path === '/v1/personal-agent' && call.method === 'POST'), false);
  } finally {
    permission.resolve(json(503, {}));
    personal.resolve(json(503, {}));
    restore();
  }
});

test('group settings adds an owned workspace agent alongside a teammate with the same agent ID', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {doc, el, routes, fetcher, calls, restore} = linkedChatFixture(
    `#workspace=${linkTeam}&social=${linkSocial}&message=${linkSocialOlder}`, {narrow:true});
  const settingsAdd = id => el('group-info-add-agent' + (id ? `-${id}` : ''));
  const dialog = settingsAdd('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent({type:'close'}); };
  const base = linkBase(linkTeam);
  const groupPath = base + linkSocialPath;
  const cataloguePath = base + '/agents?limit=100';
  const mine = {id:'mine', name:'Already added', owner_id:alice, mine:true};
  const peer = {id:'shared-id', name:'Teammate agent', owner_id:bob, mine:false};
  const selected = {id:peer.id, name:'My workspace agent', owner_id:alice, mine:true};
  const older = {id:linkSocialOlder, conversation_id:linkSocial, user_id:bob, seq:2, body:'Earlier group text'};
  const before = {id:linkSocial, kind:'group', workspace_id:linkTeam, title:'Release group', members:[linkMember],
    activity_version:'5.2.0.0', agent_members:[mine,peer], group_agent_requests:true, group_management:{role:'owner',revision:1}};
  let reads = 0;
  let writes = 0;
  routes.set(groupPath + '?around=' + linkSocialOlder, () => json(200,{conversation:before,items:[older],has_newer:true}));
  routes.set(groupPath, () => json(200,{conversation:before,items:[]}));
  routes.set(cataloguePath, () => ++reads === 1 ? json(503, {}) : json(200,
    {items:[mine,{id:'archived',name:'Archived',archived:true}], cursor:'more'}));
  routes.set(cataloguePath + '&cursor=more', () => json(200, {items:[selected]}));
  routes.set(groupPath + '/agents', ({method}) => {
    assert.equal(method, 'POST');
    if (++writes === 1) return json(503, {});
    return json(201, {roster:{id:linkSocial,workspace_id:linkTeam,activity_version:'5.3.0.0',agent_members:[mine,peer,selected]}});
  });
  try {
    await mount(doc, {fetcher});
    assert.equal(reads, 0);
    await fire(el('group-info-toggle'), 'click');
    await fire(el('group-info-tab-people'), 'click');
    assert.equal(settingsAdd().hidden, true);
    await fire(el('group-info-tab-agents'), 'click');
    assert.equal(settingsAdd().hidden, false);
    assert.equal(reads, 0);
    await fire(settingsAdd(), 'click');
    await settle();
    assert.equal(dialog.open, true);
    assert.match(settingsAdd('status').textContent, /无法读取/);
    await fire(settingsAdd('retry'), 'click');
    await settle();
    assert.deepEqual(settingsAdd('select').options.map(option => option.value), ['', selected.id]);
    assert.equal(settingsAdd('submit').disabled, true);
    settingsAdd('select').value = selected.id;
    await fire(settingsAdd('select'), 'change');
    assert.equal(settingsAdd('submit').disabled, false);
    const submit = () => fire(settingsAdd('form'), 'submit', {preventDefault() {}});
    await submit();
    assert.equal(dialog.open, true);
    assert.match(settingsAdd('status').textContent, /当前选择重试/);
    assert.equal(settingsAdd('select').value, selected.id);
    assert.equal(settingsAdd('submit').disabled, false);
    await submit();
    assert.equal(dialog.open, false);
    assert.equal(el('group-info-panel').hidden, false);
    assert.equal(settingsAdd().focused, true);
    assert.match(settingsAdd('feedback').textContent, /已添加/);
    assert.equal(el('group-info-agents').children.length, 3);
    assert.equal(el('message-list').children[0].dataset.messageId,linkSocialOlder);
    assert.equal(calls.filter(call=>call.path===groupPath).length,0);
    await fire(el('chat-back-to-latest'),'click');
    await settle();
    assert.equal(el('group-info-agents').children.length, 3, 'a stale transcript snapshot cannot undo the accepted roster');
    assert.deepEqual(calls.filter(call => call.path === groupPath + '/agents').map(call => call.body),
      [{agent_ids:[peer.id]}, {agent_ids:[peer.id]}]);
  } finally {
    restore();
  }
});

test('group reply policy opens from the header and updates settings and composer from the saved revision', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, restore} = fixture;
  doc.documentElement = {lang:'zh-CN'};
  const control = id => el('group-management-' + id);
  const dialog = control('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent({type:'close'}); };
  const own = {id:linkAgent, owner_id:alice, name:'文案助手', mine:true, auto_reply:true};
  const peer = {id:linkAgent, owner_id:bob, name:'文案助手', owner_name:'小周', mine:false};
  const path = linkBase(linkTeam) + linkSocialPath;
  const conversation = {id:linkSocial, workspace_id:linkTeam, title:'编辑部', kind:'group', members:[linkMember],
    agent_members:[own, peer], group_agent_requests:true,
    group_agent_routing:{mode:'shared',can_edit:true,policy:{mode:'default'},native_group_host:alice},
    group_management:{revision:4}};
  const writes = [];
  routes.set(path, () => json(200, {conversation, items:[]}));
  routes.set(path + '/management', ({method,body}) => {
    assert.equal(method, 'POST');
    writes.push(body);
    const updated = {...conversation, group_management:{revision:body.revision + 1},
      group_agent_routing:{...conversation.group_agent_routing, policy:{mode:body.mode,lead:body.lead}}};
    return json(200, {conversation:updated});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    assert.equal(el('group-info-panel').hidden, true);
    assert.equal(el('group-reply-shortcut').hidden, false);
    assert.equal(el('group-reply-shortcut').getAttribute('aria-description'), '跟随群组默认 · 由群内智能体判断');
    assert.equal(el('conversation-agent-admin').textContent, '未设置管理员');
    assert.equal(el('group-agent-set-admin').hidden, false);
    assert.match(el('group-composer-routing-text').textContent, /由群内智能体按内容决定是否回复/);
    await fire(el('group-info-toggle'),'click');
    await fire(el('group-info-tab-agents'),'click');
    assert.equal(el('group-agent-auto-reply-note').hidden, true);
    assert.equal(el('group-info-agents').children.flatMap(row => row.children).some(child => child.tagName === 'BUTTON'), false);
    assert.doesNotMatch(el('group-info-agents').textContent, /自动回复/);
    await fire(el('group-info-toggle'),'click');
    await fire(el('group-reply-shortcut'),'click');
    assert.equal(dialog.open, true);
    assert.equal(el('group-info-panel').hidden, true);
    assert.equal(control('reply-mode').value, 'default');
    await fire(control('cancel'),'click');
    el('conversation-agents-sheet').open = true;
    await fire(el('group-agent-set-admin'),'click');
    assert.equal(dialog.open, true);
    assert.equal(control('heading').textContent, '设置管理员');
    assert.equal(control('reply-mode').value, 'lead');
    control('reply-lead').value = JSON.stringify([bob, linkAgent]);
    await fire(control('reply-lead'),'change');
    await fire(control('form'),'submit',{preventDefault() {}});
    assert.deepEqual(writes,[{action:'reply_policy',revision:4,mode:'lead',lead:{owner_id:bob,agent_id:linkAgent}}]);
    assert.equal(dialog.open, false);
    assert.match(el('group-reply-policy-summary').textContent, /管理员.*文案助手.*小周/);
    assert.match(el('conversation-agent-admin').textContent, /管理员.*文案助手.*小周/);
    assert.match(el('group-composer-routing-text').textContent, /文案助手.*优先判断是否回复/);

    await fire(el('group-info-toggle'),'click');
    await fire(el('group-info-tab-people'),'click');
    assert.equal(el('group-reply-policy').hidden, false);
    assert.equal(control('reply-policy').hidden, false);
    await fire(control('reply-policy'),'click');
    assert.equal(control('reply-mode').value, 'lead');
    control('reply-mode').value = 'mentions';
    await fire(control('reply-mode'),'change');
    assert.equal(control('reply-lead-row').hidden, true);
    await fire(control('form'),'submit',{preventDefault() {}});
    assert.deepEqual(writes[1],{action:'reply_policy',revision:5,mode:'mentions'});
    assert.equal(el('group-reply-policy-summary').textContent, '仅在被 @ 时回复');
    assert.equal(el('conversation-agent-admin').textContent, '未设置管理员');
    assert.match(el('group-composer-routing-text').textContent, /仅在被 @ 时回复/);
    el('chat-body').value = '@所有人 请确认';
    await fire(el('chat-body'),'input');
    assert.match(el('group-composer-routing-text').textContent, /提及所有人，并请群内智能体回复/);
  } finally {restore();}
});

test('named team group replies explicitly pin what was previewed and keep drafts across stale versions', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, routes, calls, restore} = fixture;
  const sendPath = linkBase(linkTeam) + linkSocialPath + '/agent-replies';
  const documentPath = linkBase(linkTeam) + '/studio/documents';
  const documentId = 'f'.repeat(32);
  const title = '项目文档';
  const excerpt = '甲'.repeat(2399) + '🦊';
  let revision = 1;
  const attempts = [];
  routes.set(linkBase(linkTeam) + linkSocialPath, () => json(200, {
    conversation: {id: linkSocial, workspace_id: linkTeam, title: '测试群', kind: 'group',
      members: [{user_id: alice, username: 'alice'}], agent_members: [{id: 'agent-local', name: '测试助理'}]},
    items: [],
  }));
  routes.set(documentPath, () => json(200, {items: [{id: documentId, title, revision}]}));
  routes.set(documentPath + '/' + documentId, () => json(200, {
    document: {id: documentId, title, revision, body: excerpt + '不能进入预览的片段'},
  }));
  const fetcher = (path, options) => {
    if (path !== sendPath) return fixture.fetcher(path, options);
    const sent = JSON.parse(options.body);
    attempts.push({body: sent, key: options.headers['Idempotency-Key']});
    if (attempts.length === 1) return json(503, {});
    if (sent.studio_reference.revision !== revision) return json(409, {error: {code: 'studio_reference_changed'}});
    return json(202, {message: {id: 'posted', seq: 1, body: sent.prompt, user_id: alice, created: 1,
      studio_reference: sent.studio_reference}});
  };
  const query = doc.querySelectorAll;
  doc.querySelectorAll = selector => selector === '#group-agent-choices input[name="group-agent"]:checked'
    ? el('group-agent-choices').children.map(label => label.children[0]).filter(box => box.checked)
    : query(selector);
  try {
    await mount(doc, {fetcher});
    assert.equal(el('group-studio').hidden, false);
    assert.equal(el('group-studio-send').hidden, true);
    assert.equal(calls.some(call => call.path.startsWith(documentPath)), false);
    const prompt = el('group-agent-prompt');
    prompt.value = '用这份文档回答';
    el('group-agent-choices').children[0].children[0].checked = true;
    const submit = () => fire(el('group-agent-form'), 'submit', {preventDefault() {}});
    const picker = el('group-studio-document');
    el('group-studio').open = true;
    await fire(el('group-studio'), 'toggle');
    picker.value = documentId;
    await fire(picker, 'change');
    assert.equal(el('group-agent-submit').disabled, true);
    await submit();
    assert.equal(attempts.length, 0);
    assert.equal(el('group-studio-excerpt').textContent, excerpt);
    assert.equal(el('group-studio-truncated').hidden, false);
    await fire(el('group-studio-confirm'), 'click');
    assert.equal(el('group-studio-send').hidden, false);
    await submit();
    assert.equal(prompt.value, '用这份文档回答');
    assert.equal(picker.value, documentId);
    assert.deepEqual(attempts[0].body, {agent_ids: ['agent-local'], prompt: prompt.value,
      studio_reference: {document_id: documentId, revision: 1}});
    el('status').textContent = '另一个聊天状态';
    revision = 2;
    await submit();
    assert.equal(attempts[1].key, attempts[0].key);
    assert.match(el('group-studio-status').textContent, /重新预览/);
    assert.equal(el('status').textContent, '另一个聊天状态');
    assert.equal(el('group-agent-submit').disabled, true);
    assert.equal(el('group-studio-send').hidden, true);
    await fire(el('group-studio-review'), 'click');
    assert.equal(el('group-studio-revision').textContent, '版本 2');
    assert.equal(el('group-studio-status').textContent, '');
    await fire(el('group-studio-confirm'), 'click');
    assert.equal(el('group-studio-send').hidden, false);
    await submit();
    assert.notEqual(attempts[2].key, attempts[1].key);
    assert.equal(attempts[2].body.studio_reference.revision, 2);
    const link = descendants(el('message-list')).find(node => node.classList.contains('group-studio-reference'));
    assert.equal(link.textContent, '团队文档 · 引用版本 2');
    assert.equal(link.href, `/space?workspace=${linkTeam}&studio=${documentId}&studio_revision=2`);
    assert.equal(prompt.value, '');
    assert.equal(picker.value, '');
    assert.equal(el('group-studio-excerpt').textContent, '');
  } finally { restore(); }
});

test('an original-agent link opens the personal direct chat and selects the exact owner pair without sending', async () => {
  const target = {conversation:linkSocial, ownerId:bob, agentId:linkAgent};
  const hash = directAgentAccessHref(target).slice('/chat'.length);
  assert.deepEqual(directAgentAccessFromHash(hash), target);
  assert.equal(directAgentAccessFromHash(hash + '&access_owner=' + alice), null);
  const fixture = linkedChatFixture(hash, {narrow:true});
  const {doc,el,routes,restore} = fixture;
  const path = linkBase(linkWork) + linkSocialPath;
  const agent = {id:linkAgent,name:'同名智能体'};
  routes.set(path, () => json(200,{conversation:{
    id:linkSocial,workspace_id:linkWork,kind:'dm',title:'队友',
    direct:{open:true},direct_agent_requests:true,members:[linkMember,{user_id:bob,username:'小周'}],
    agent_members:[{...agent,owner_id:alice,owner_name:'小林'},{...agent,owner_id:bob,owner_name:'小周'}],
  },items:[]}));
  try {
    await mount(doc,{fetcher:fixture.fetcher});
    assert.deepEqual(el('chat-agent-mentions').children.map(node => node.dataset.agentMentionKey),
      [JSON.stringify([bob,linkAgent])]);
    assert.equal(el('chat-body').value, '');
    assert.equal(fixture.calls.some(call => call.method === 'POST' && call.path.endsWith('/messages')), false);
    assert.equal(directAgentAccessFromHash(globalThis.location.hash), null);
  } finally { restore(); }
});

test('direct chat uses the personal catalogue and sends or removes only the selected owner pair', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, restore} = fixture;
  const path = linkBase(linkTeam) + linkSocialPath;
  const catalogue = linkBase(linkWork) + '/agents?limit=100';
  const agentName = '相同名称';
  const own = {id:linkAgent, name:agentName, owner_id:alice, owner_name:'小林', mine:true};
  const peer = {id:linkAgent, name:agentName, owner_id:bob, owner_name:'小周', mine:false};
  const normal = {id:linkSocialOlder, body:'普通消息', user_id:alice, seq:2, created:7};
  const queued = {id:linkSocialLatest, body:'仅发送当前文字', user_id:alice, seq:3, created:8,
    reply_jobs:[{id:'direct-job', agent_id:linkAgent, agent_owner_id:bob, agent_owner_name:peer.owner_name,
      agent_name:agentName, status:'queued', attempt:1}]};
  let roster = [peer];
  let history = [];
  const sendPostBodies = [];
  routes.set(path, () => json(200, {conversation:{id:linkSocial, workspace_id:linkTeam, kind:'dm', title:'私聊同事',
    direct:{open:true}, direct_agent_requests:true, members:[linkMember,{user_id:bob,username:'小周'}], agent_members:roster}, items:history}));
  routes.set(catalogue, () => json(200, {items:[own]}));
  routes.set(path + '/agents', ({body}) => {
    assert.deepEqual(body, {agent_ids:[linkAgent]});
    roster = [own, peer];
    return json(201, {added:1});
  });
  routes.set(path + '/messages', ({body}) => {
    sendPostBodies.push(body);
    if (sendPostBodies.length === 1) {
      history = [normal];
      return json(201, {message:normal});
    }
    if (sendPostBodies.length === 2) {
      history = [normal, queued];
      return json(201, {message:queued});
    }
    roster = [];
    return json(409, {error:{code:'direct_agent_unavailable'}});
  });
  routes.set(path + '/agents/' + linkAgent + '/remove', ({body}) => {
    assert.deepEqual(body, {owner_id:bob});
    roster = [own];
    return json(200, {removed:true});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    assert.equal(el('group-agent-action').hidden, false);
    assert.equal(el('group-agent-form').hidden, true);
    assert.equal(el('group-studio').hidden, true);
    assert.equal(el('conversation-agents-text').textContent, '私聊智能体');
    assert.equal(fixture.calls.some(call => call.path === catalogue), false);
    const sheet = el('conversation-agents-sheet');
    sheet.open = true;
    await fire(sheet, 'toggle');
    await settle();
    assert.deepEqual(el('group-agent-add').options.map(option => option.value), [linkAgent]);
    el('group-agent-add').value = linkAgent;
    await fire(el('group-agent-add-submit'), 'click');
    const rosterRows = el('group-agent-chips');
    const removeControl = row => row.children.find(child => child.tagName === 'BUTTON');
    assert.deepEqual(rosterRows.children.map(row => removeControl(row).dataset.agentOwnerId), [alice,bob]);

    const composer = el('chat-body');
    composer.setSelectionRange = (start, end) => { composer.selectionStart = start; composer.selectionEnd = end; };
    const send = async text => {
      composer.value = text;
      await fire(el('chat-form'), 'submit', {preventDefault() {}});
      await settle();
    };
    const choose = async index => {
      composer.value = '@相同';
      composer.setSelectionRange(3, 3);
      await fire(composer, 'input');
      await fire(el('chat-agent-mention-options').children[index], 'click');
    };
    await send('普通消息');
    await choose(1);
    await send('仅发送当前文字');
    assert.deepEqual(sendPostBodies, [{body:'普通消息'},
      {body:'仅发送当前文字', agent_mentions:[{owner_id:bob,agent_id:linkAgent}], direct_agent_request:true}]);
    assert.equal(el('message-list').children.find(row => row.dataset.replyJobId === 'direct-job').children[0].textContent,
      '相同名称 · 小周 · AI 智能体');

    const removePeer = removeControl(rosterRows.children[1]);
    await fire(rosterRows, 'click', {target:removePeer});
    assert.equal(fixture.calls.some(call => call.path.endsWith('/remove')), false);
    await fire(rosterRows.children.at(-1).children[2], 'click');
    assert.deepEqual(rosterRows.children.map(row => removeControl(row).dataset.agentOwnerId), [alice]);
    await choose(0);
    await send('目标在发送前离开了');
    assert.equal(composer.value, '目标在发送前离开了');
    assert.equal(el('chat-agent-mention-status').hidden, false);
    await send(composer.value);
    assert.equal(sendPostBodies.length,3);
  } finally {restore();}
});

test('group chat hides the Bot’s trigger preview and displays a member’s manual quote', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, routes, restore} = fixture;
  const first = {id:linkSocialOlder, user_id:bob, body:'Check the existing PRs.', created:1, seq:1};
  const bot = {id:linkSocialLatest, role:'agent', agent_id:linkAgent, agent_name:'FlyBot Lead', agent_owner_id:alice,
    body:'I will check them.', created:2, seq:2, reply_to:first.id,
    reply_preview:{available:true,message_id:first.id,author:'Bob',excerpt:first.body}};
  const manual = {id:'otm_' + 'B'.repeat(26), user_id:alice, body:'Please start with older PRs.', created:3, seq:3,
    reply_to:bot.id, reply_preview:{available:true,message_id:bot.id,author:'FlyBot Lead',excerpt:bot.body}};
  routes.set(linkBase(linkTeam) + linkSocialPath, () => json(200, {conversation:{
    id:linkSocial,workspace_id:linkTeam,title:'Development',kind:'group',members:[linkMember],
  }, items:[first,bot,manual]}));
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    const row = id => el('message-list').children.find(message => message.dataset.messageId === id);
    const quote = id => row(id).children.find(node => node.className === 'message-quote');
    assert.equal(quote(bot.id), undefined);
    assert.equal(row(bot.id).children[1].textContent, bot.body);
    assert.equal(quote(manual.id).tagName, 'BUTTON');
    assert.equal(quote(manual.id).children[1].textContent, bot.body);
  } finally {restore();}
});

test('group chat keeps roster tools near the header and shows the authority for ordinary, quoted and selected replies', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, restore} = fixture;
  const reviewer = {id:linkAgent, name:'产品校对', owner_id:alice, mine:true};
  const designer = {id:'design-agent', name:'设计助理', owner_id:bob, owner_name:'小周', mine:false};
  const conversation = {id:linkSocial, workspace_id:linkTeam, title:'设计复盘', kind:'group', members:[linkMember],
    agent_members:[reviewer, designer], group_agent_requests:true, group_agent_routing:{mode:'personal',default:'all'}};
  const reply = {id:linkSocialLatest, role:'agent', agent_id:designer.id, agent_name:designer.name, agent_owner_id:bob,
    reply_job_id:'design-reply', body:'已核对设计稿', created:1, seq:1};
  const path = linkBase(linkTeam) + linkSocialPath;
  const items = [reply];
  const sends = [];
  routes.set(path, () => json(200, {conversation, items}));
  routes.set(path + '/messages', ({body}) => {
    sends.push(body);
    const message = {id:'later-message', user_id:alice, body:body.body, created:5, seq:2,
      reply_jobs:[{id:'passed-job', status:'passed', agent_id:reviewer.id, agent_name:reviewer.name}]};
    items.push(message);
    return json(201, {message});
  });
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    assert.equal(el('main-panel').dataset.chatKind, 'group');
    assert.equal(el('chat-subtitle').textContent, '1 人 · 2 位智能体');
    assert.equal(el('conversation-agents-count').textContent, '2');
    assert.deepEqual(el('conversation-agents-preview').children.map(chip => chip.textContent), [reviewer.name, designer.name]);
    assert.equal(el('conversation-agents-sheet').open, false);
    await fire(el('chat-more'), 'click');
    assert.equal(el('chat-more').getAttribute('aria-expanded'), 'true');
    await fire(el('group-agent-manage'), 'click');
    assert.equal(el('group-info-panel').hidden, false);
    assert.equal(el('group-info-tab-agents').getAttribute('aria-selected'), 'true');
    assert.match(el('group-composer-routing-text').textContent, /按内容决定是否回复.*@所有人/);
    const agentRow = el('message-list').children.find(row => row.dataset.replyJobId === 'design-reply');
    assert.equal(agentRow.dataset.chatAuthor, 'agent');
    await fire(agentRow.children.find(child => child.getAttribute('aria-label') === '回复 设计助理'), 'click');
    assert.match(el('group-composer-routing-text').textContent, /设计助理.*引用/);
    const composer = el('chat-body');
    composer.setSelectionRange = (start, end) => { composer.selectionStart = start; composer.selectionEnd = end; };
    const suggestions = el('chat-agent-mention-options');
    composer.value = '@';
    composer.setSelectionRange(1, 1);
    await fire(composer,'input');
    assert.equal(suggestions.hidden,false);
    await fire(composer,'keydown',{key:'Tab',preventDefault() {assert.fail('Tab must allow focus to move');}});
    assert.equal(suggestions.hidden,true);
    assert.equal(composer.value,'@');
    await fire(composer,'input');
    await fire(composer,'keydown',{key:'Enter',keyCode:229,preventDefault() {assert.fail('IME must keep Enter');}});
    assert.equal(suggestions.hidden,false);
    assert.equal(composer.value,'@');
    await fire(composer,'keydown',{key:'Home',preventDefault() {assert.fail('Home must allow the caret to move');}});
    assert.equal(suggestions.hidden,true);
    composer.value = '参考 ` @everyone`、[术语 @全体](/help)';
    composer.setSelectionRange(12,12);
    await fire(composer,'input');
    assert.equal(suggestions.hidden,true);
    assert.match(el('group-composer-routing-text').textContent, /设计助理.*引用/);
    composer.value = '＠全体 请看这段';
    composer.setSelectionRange(composer.value.length,composer.value.length);
    await fire(composer,'input');
    assert.match(el('group-composer-routing-text').textContent, /将提及所有人/);
    composer.value = '@小周';
    composer.setSelectionRange(3,3);
    await fire(composer,'input');
    assert.match(suggestions.children[0].textContent, /设计助理 · 小周/);
    composer.value = '@产品';
    composer.setSelectionRange(3, 3);
    await fire(composer, 'input');
    await fire(el('chat-agent-mention-options').children[0], 'click');
    assert.match(el('group-composer-routing-text').textContent, /已指定 1 位智能体/);
    assert.equal(el('group-composer-routing').dataset.kind, 'targeted');
    composer.value = '@所有智能体 @all 保留的草稿 @产品';
    composer.setSelectionRange(composer.value.length,composer.value.length);
    await fire(composer,'input');
    assert.match(el('group-composer-routing-text').textContent, /将提及所有人/);
    await fire(el('chat-agent-mention-options').children[0],'click');
    assert.equal(composer.value,'保留的草稿 ');
    assert.match(el('group-composer-routing-text').textContent, /已指定 1 位智能体/);
    composer.value = '请 @所核对这个设计';
    composer.setSelectionRange(4, 4);
    await fire(composer,'input');
    const all = el('chat-agent-mention-options').children.find(option => Object.hasOwn(option.dataset,'mentionEveryone'));
    assert.ok(all);
    await fire(composer,'keydown',{key:'Enter',preventDefault() {}});
    assert.equal(composer.value, '请 @所有人 核对这个设计');
    assert.equal(el('chat-agent-mentions').hidden, true);
    assert.match(el('group-composer-routing-text').textContent, /将提及所有人/);
    assert.deepEqual(sends, []);
    await fire(el('chat-form'),'submit',{preventDefault() {}});
    await settle();
    assert.deepEqual(sends, [{body:'请 @所有人 核对这个设计', reply_to:reply.id}]);
    assert.equal(el('message-list').children.some(row => row.dataset.replyJobId === 'passed-job'), false);
  } finally {restore();}
});

test('a human-only group can select Everyone in the picker without sending or losing the draft', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`, {narrow:true});
  const {doc, el, routes, restore, calls} = fixture;
  const {view, saved} = publicOpeningView();
  doc.defaultView = view;
  const path = linkBase(linkTeam) + linkSocialPath;
  routes.set(path, () => json(200, {conversation:{id:linkSocial, workspace_id:linkTeam, title:'好友群', kind:'group',
    members:[linkMember], agent_members:[]}, items:[]}));
  const picker = el('chat-agent-picker');
  picker.showModal = () => { picker.open = true; };
  picker.close = () => { picker.open = false; picker.dispatchEvent({type:'close'}); };
  const results = el('chat-agent-picker-results');
  results.querySelectorAll = selector => descendants(results).filter(node => matchesSelector(node, selector));
  try {
    await mount(doc, {fetcher:fixture.fetcher});
    const launcher = el('chat-agent-picker-open');
    assert.equal(launcher.hidden, false);
    const composer = el('chat-body');
    composer.setSelectionRange = (start, end) => { composer.selectionStart = start; composer.selectionEnd = end; };
    composer.value = '请确认明天的时间 @';
    composer.setSelectionRange(composer.value.length,composer.value.length);
    await fire(composer,'input');
    await fire(launcher,'click');
    assert.equal(picker.open,true);
    assert.equal(results.children.length,1);
    const row = results.children[0];
    assert.ok(Object.hasOwn(row.dataset,'mentionEveryone'));
    const checkbox = row.children[0];
    checkbox.checked = true;
    await fire(checkbox,'change');
    await fire(el('chat-agent-picker-form'),'submit',{preventDefault() {}});
    assert.equal(picker.open,false);
    assert.equal(composer.value,'请确认明天的时间 @所有人 ');
    assert.equal(composer.selectionStart,composer.value.length);
    t.mock.timers.tick(250);
    assert.ok([...saved.values()].some(value => value.includes(composer.value)));
    assert.equal(calls.some(call => call.method === 'POST' && call.path === path + '/messages'), false);
  } finally {restore();}
});

test('team document requests distinguish the same agent id across owners and retain the draft after roster changes', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const fixture = linkedChatFixture(`#workspace=${linkTeam}&social=${linkSocial}`);
  const {doc, el, routes, restore} = fixture;
  const {view, saved} = publicOpeningView();
  doc.defaultView = view;
  const scope = JSON.stringify([alice, linkTeam, 'social', null, linkSocial]);
  const storageKey = 'flybot-workspace.group-reply-draft:' + scope;
  const promptText = '协助核对发布材料';
  const agentId = 'same-agent';
  const legacyKey = 'group-reply-legacy-edit';
  const studioReference = {document_id:'f'.repeat(32), revision:1};
  saved.set(storageKey, JSON.stringify({prompt: promptText, agentIds: [agentId], studioReference,
    attempt: {key: legacyKey, prompt: promptText, agentIds: [agentId], studioReference}}));
  const own = {id: agentId, name: '核对助手', mine: true, owner_id: 'owner-a', owner_name: 'Alice'};
  const teammate = {id: agentId, name: '核对助手', mine: false, owner_id: 'owner-b', owner_name: 'Bob'};
  const path = linkBase(linkTeam) + linkSocialPath;
  let selectedRemoved = false;
  const completedTeamReply = {id: 'previous-reply', role: 'agent', agent_id: agentId, agent_name: '核对助手',
    agent_owner_id: teammate.owner_id, agent_owner_name: teammate.owner_name, reply_job_id: 'previous-job',
    body: '已核对变更记录', created: 1, seq: 1};
  routes.set(path, () => json(200, {conversation: {id: linkSocial, workspace_id: linkTeam, title: '发布协作群',
    kind: 'group', group_agent_requests: true, members: [linkMember], agent_members: selectedRemoved ? [own] : [own, teammate]},
    items: [completedTeamReply]}));
  const attempts = [];
  const fetcher = (url, options) => {
    if (url !== path + '/agent-replies') return fixture.fetcher(url, options);
    const body = JSON.parse(options.body);
    attempts.push({body, key: options.headers['Idempotency-Key']});
    if (attempts.length < 3) return json(503, {});
    if (attempts.length === 3) {
      selectedRemoved = true;
      return json(409, {error: {code: 'group_agent_unavailable'}});
    }
    return json(202, {message: {id: 'posted', seq: 2, body: body.prompt, user_id: alice, created: 2,
      reply_jobs: [{id: 'job-own', agent_id: own.id, agent_name: own.name, agent_owner_id: own.owner_id,
        agent_owner_name: own.owner_name, status: 'queued', attempt: 1}]}});
  };
  const children = () => el('group-agent-choices').children;
  const query = doc.querySelectorAll;
  doc.querySelectorAll = selector => selector === '#group-agent-choices input[name="group-agent"]:checked'
    ? children().map(label => label.children[0]).filter(box => box.checked)
    : query(selector);
  try {
    await mount(doc, {fetcher});
    assert.deepEqual(children().map(label => label.children[0].dataset.agentOwnerId), ['owner-a', 'owner-b']);
    assert.deepEqual(children().map(label => label.children[1].children[0].textContent), [' · 我的', ' · Bob']);
    assert.deepEqual(children().map(label => label.children[0].checked), [true, false]);
    const originalRole = el('message-list').children[0].children[0];
    assert.equal(originalRole.textContent, '核对助手 · Bob · AI 智能体');
    const submit = () => fire(el('group-agent-form'), 'submit', {preventDefault() {}});
    await submit();
    assert.deepEqual(attempts[0], {body: {agent_ids: [agentId], prompt: promptText, studio_reference:studioReference}, key: legacyKey});

    children()[1].children[0].checked = true;
    await fire(el('group-agent-choices'), 'change');
    await submit();
    assert.notEqual(attempts[1].key, legacyKey);
    assert.deepEqual(attempts[1].body, {agent_targets: [
      {owner_id: own.owner_id, agent_id: agentId}, {owner_id: teammate.owner_id, agent_id: agentId},
    ], prompt: promptText, studio_reference:studioReference});
    assert.deepEqual(JSON.parse(saved.get(storageKey)).agentKeys, ['owner-a/' + agentId, 'owner-b/' + agentId]);
    await submit();
    await settle();
    assert.deepEqual(attempts[2], attempts[1]);
    assert.equal(attempts.length, 3, 'refreshing the roster does not resubmit');
    assert.equal(el('group-agent-prompt').value, promptText);
    assert.match(el('group-agent-choice-status').textContent, /请选择仍在群内/);
    assert.deepEqual(children().map(label => label.children[0].dataset.agentOwnerId), ['owner-a']);
    assert.equal(children()[0].children[0].checked, true);

    await submit();
    assert.notEqual(attempts[3].key, attempts[2].key);
    assert.deepEqual(attempts[3].body, {agent_targets: [{owner_id: own.owner_id, agent_id: agentId}], prompt: promptText, studio_reference:studioReference});
    assert.equal(el('group-agent-prompt').value, '');
    const queuedRole = el('message-list').children.find(row => row.dataset.replyJobId === 'job-own').children[0];
    assert.equal(queuedRole.textContent, '核对助手 · Alice · AI 智能体');
  } finally { restore(); }
});

function settledNativeSnapshot(fixture) {
  return {agent: fixture.agent, conversation: fixture.nativeThread, cursor: null, has_newer: false,
    items: fixture.nativeRows.map(row => ({...row, workspace_id: linkWork, agent_id: linkAgent, conversation_id: linkThread}))};
}

test('a saved pin survives a conversation directory read started before the save', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}`);
  const directory = Promise.withResolvers();
  fixture.routes.set(scope + linkSocialDirectory, () => directory.promise);
  fixture.routes.set(scope + linkSocialPath + '/preferences', () => json(200, {pinned: true}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    await fire(fixture.el('group-info-pin'), 'click');
    assert.equal(fixture.el('group-info-pin').getAttribute('aria-checked'), 'true');
    directory.resolve(json(200, {items: [{id: linkSocial, kind: 'group', title: 'Linked group', pinned: false, updated: 30}]}));
    await settle();
    const row = sessionRows(fixture.el).find(item => item.dataset.conversation === linkSocial);
    assert.equal(row.children[1].children[0].textContent, '置顶 · Linked group');
    assert.equal(fixture.el('group-info-pin').getAttribute('aria-checked'), 'true');
    assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath + '?start=unread').length, 1);
  } finally {
    directory.resolve(json(503, {}));
    fixture.restore();
  }
});

test('private reply memory citations carry the exact invoking chat and message', async () => {
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const refId = 'd'.repeat(32);
  const source = {...fixture.nativeRows[1], memory_refs: [{id: refId, workspace_id: linkWork, title: 'Saved note', revision: 2}]};
  fixture.routes.set(linkBase(linkWork) + linkNativeLatest, () =>
    json(200, {agent: fixture.agent, conversation: fixture.nativeThread, items: [source]}));
  function linkWithText(node, text) {
    if (node.tagName === 'A' && node.textContent === text) return node;
    for (const child of node.children) {
      const link = linkWithText(child, text);
      if (link) return link;
    }
  }
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    const link = linkWithText(fixture.el('message-list'), 'Saved note');
    assert.equal(link.href, '/memory?' + new URLSearchParams({
      workspace: linkWork, page: refId, revision: '2',
      from: [linkWork, linkAgent, linkThread, linkAgentLatest].join('.'),
    }));
  } finally {
    fixture.restore();
  }
});

test('desktop startup reads one bounded private candidate alongside Social, then opens and acknowledges only the winner', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture('');
  const auth = Promise.withResolvers();
  const social = Promise.withResolvers();
  const olderPrivate = {id: linkAgentOlder, agent_id: linkAgent, title: 'Older private chat', updated: 3};
  fixture.routes.set('/v1/auth/session', () => auth.promise);
  fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture, alice, [olderPrivate, fixture.nativeThread]));
  fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
  fixture.routes.set(scope + linkNativeSnapshot, () => json(200, settledNativeSnapshot(fixture)));
  try {
    const loaded = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.some(call => call.path.startsWith(scope)), false);
    auth.resolve(json(200, {user: {id: alice, username: 'alice'}}));
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkSocialDirectory));
    assert.deepEqual(fixture.calls.filter(call => call.path.endsWith('&snapshot=1')).map(call => call.path), [scope + linkNativeSnapshot]);
    assert.deepEqual(fixture.messages(), []);
    assert.equal(fixture.selected(), undefined);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    social.resolve(json(200, {items: [{id: linkSocial, kind: 'group', title: 'Older group', updated: 4}]}));
    await loaded;
    await settle();
    assert.equal(fixture.selected(), linkThread);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativeLatest || call.path === scope + linkSocialPath), false);
    assert.deepEqual(fixture.calls.filter(call => call.path.endsWith('/read')), [
      {path: scope + linkNativePath + '/read', method: 'POST', body: {message_id: linkAgentLatest}},
    ]);
  } finally {
    auth.resolve(json(401, {}));
    social.resolve(json(503, {}));
    fixture.restore();
  }
});

for (const socialWinner of [{pinned: true, updated: 2}, {pinned: false, updated: 30}]) {
  test(`desktop keeps the ${socialWinner.pinned ? 'older pinned' : 'more recent'} Social winner when a private snapshot is pending`, async () => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture('');
    const social = Promise.withResolvers();
    const snapshot = Promise.withResolvers();
    fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture));
    fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
    fixture.routes.set(scope + linkNativeSnapshot, () => snapshot.promise);
    try {
      const loaded = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.ok(fixture.calls.some(call => call.path === scope + linkNativeSnapshot));
      assert.deepEqual(fixture.messages(), []);
      social.resolve(json(200, {items: [{id: linkSocial, kind: 'group', title: 'Selected group', ...socialWinner}]}));
      await settle();
      assert.equal(fixture.selected(), linkSocial);
      assert.deepEqual(fixture.messages(), [linkSocialLatest]);
      snapshot.resolve(json(200, settledNativeSnapshot(fixture)));
      await loaded;
      await settle();
      assert.deepEqual(fixture.messages(), [linkSocialLatest]);
      assert.equal(fixture.calls.some(call => call.path === scope + linkNativeLatest || call.path === scope + linkNativePath + '/read'), false);
    } finally {
      social.resolve(json(503, {}));
      snapshot.resolve(json(409, {}));
      fixture.restore();
    }
  });
}

for (const cause of ['has no native mapping', 'contains a foreign message', 'has expired']) {
  test(`desktop falls back to the normal private open only after selection when the snapshot ${cause}`, async t => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture('');
    const social = Promise.withResolvers();
    fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture));
    fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
    const snapshot = settledNativeSnapshot(fixture);
    if (cause === 'contains a foreign message') snapshot.items[0].workspace_id = linkTeam;
    let now = 10;
    if (cause === 'has expired') t.mock.method(performance, 'now', () => now);
    fixture.routes.set(scope + linkNativeSnapshot, () => cause === 'has no native mapping' ? json(409, {}) : json(200, snapshot));
    try {
      const loaded = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.ok(fixture.calls.some(call => call.path === scope + linkNativeSnapshot));
      assert.equal(fixture.calls.some(call => call.path === scope + linkNativeLatest), false);
      assert.deepEqual(fixture.messages(), []);
      now += 2000;
      social.resolve(json(200, {items: []}));
      await loaded;
      await settle();
      assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
      assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    } finally {
      social.resolve(json(503, {}));
      fixture.restore();
    }
  });
}

test('a late private startup snapshot cannot replace an exact link opened during desktop startup', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture('');
  const social = Promise.withResolvers();
  const snapshot = Promise.withResolvers();
  fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture));
  fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
  fixture.routes.set(scope + linkNativeSnapshot, () => snapshot.promise);
  try {
    const loaded = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkNativeSnapshot));
    await fixture.navigate(`#workspace=${linkTeam}&social=${linkSocial}`);
    await settle();
    assert.equal(fixture.selected(), linkSocial);
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    social.resolve(json(200, {items: []}));
    snapshot.resolve(json(200, settledNativeSnapshot(fixture)));
    await loaded;
    await settle();
    assert.equal(fixture.selected(), linkSocial);
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativeLatest || call.path === scope + linkNativePath + '/read'), false);
  } finally {
    social.resolve(json(503, {}));
    snapshot.resolve(json(409, {}));
    fixture.restore();
  }
});

test('a mobile startup lists owned conversations without fetching the desktop snapshot', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture('', {narrow: true});
  fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture));
  fixture.routes.set(scope + linkSocialDirectory, () => json(200, {items: []}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    const listed = sessionRows(fixture.el).find(row => row?.dataset.conversation === linkThread);
    assert.ok(listed);
    assert.deepEqual(fixture.messages(), []);
    assert.equal(fixture.calls.some(call => call.path.endsWith('&snapshot=1')), false);
    await fire(fixture.el('conversation-list'), 'click', {target: listed});
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
  } finally {
    fixture.restore();
  }
});

for (const target of ['linked', 'bare agent']) {
  test(`a verified native personal snapshot opens the ${target} conversation before shared lists return`, async () => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}`
      + (target === 'linked' ? `&conversation=${linkThread}` : ''));
    const auth = Promise.withResolvers();
    const workspaces = Promise.withResolvers();
    const social = Promise.withResolvers();
    fixture.routes.set('/v1/auth/session', () => auth.promise);
    fixture.routes.set(linkPersonalStartup + linkWork, () => linkedChatSnapshot(fixture));
    fixture.routes.set('/v1/workspaces?limit=100', () => workspaces.promise);
    fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      const startupPath = target === 'linked' ? linkPersonalThreadEntry : linkPersonalEntry;
      assert.ok(fixture.calls.some(call => call.path === startupPath && call.method === 'GET'));
      assert.equal(fixture.calls.some(call => call.path.startsWith(scope + '/')), false);
      assert.equal(fixture.el('workspace').value, '');
      auth.resolve(json(200, {user: {id: alice, username: 'alice'}}));
      await settle();
      assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
      assert.equal(fixture.selected(), linkThread);
      assert.equal(fixture.el('workspace').value, linkWork);
      assert.equal(fixture.el('workspace').children.length, 1);
      assert.ok(fixture.calls.some(call => call.path === '/v1/workspaces?limit=100'));
      assert.ok(fixture.calls.some(call => call.path === scope + linkSocialDirectory));
      assert.equal(fixture.calls.some(call => call.path === scope + linkNativeDirectory), false);
      assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent'), false);
      workspaces.resolve(json(200, {items: [{id: linkTeam, kind: 'team', name: 'Team'}]}));
      social.resolve(json(200, {items: []}));
      await loading;
      await settle();
      assert.equal(fixture.el('workspace').value, linkWork);
      assert.deepEqual(fixture.el('workspace').children.map(item => item.value), [linkWork, linkTeam]);
      assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
    } finally {
      auth.resolve(json(401, {}));
      workspaces.resolve(json(503, {}));
      social.resolve(json(503, {}));
      fixture.restore();
    }
  });
}

for (const explicit of [false, true]) {
  test(`an owned ${explicit ? 'exact thread' : 'agent'} entry paints its transcript without another history read`, async () => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}${explicit ? '&conversation=' + linkThread : ''}`);
    const auth = Promise.withResolvers();
    const social = Promise.withResolvers();
    const startupPath = explicit ? linkPersonalThreadEntry : linkPersonalEntry;
    fixture.routes.set('/v1/auth/session', () => auth.promise);
    fixture.routes.set(startupPath, async () => {
      const base = await linkedChatSnapshot(fixture).json();
      return json(200, {...base, ...(explicit && {chat: undefined}), entry: settledNativeSnapshot(fixture)});
    });
    fixture.routes.set(scope + linkSocialDirectory, () => social.promise);
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.deepEqual(fixture.calls.map(call => call.path), ['/v1/auth/session', startupPath]);
      assert.deepEqual(fixture.messages(), [], 'the snapshot waits for its matching authenticated owner');
      auth.resolve(json(200, {user: {id: alice, username: 'alice'}}));
      await settle();
      assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
      assert.equal(fixture.calls.some(call => call.path.startsWith(scope + linkNativeLatest)), false);
      assert.equal(fixture.calls.some(call => call.path === scope + linkNativeDirectory), explicit);
      social.resolve(json(200, {items: []}));
      await loading;
    } finally {
      auth.resolve(json(401, {}));
      social.resolve(json(503, {}));
      fixture.restore();
    }
  });
}

test('an inline transcript for a different thread falls back to the authorized single history read', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}`);
  fixture.routes.set(linkPersonalEntry, async () => {
    const base = await linkedChatSnapshot(fixture).json();
    const entry = settledNativeSnapshot(fixture);
    entry.conversation = {...entry.conversation, id: '9'.repeat(32)};
    return json(200, {...base, entry});
  });
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    fixture.restore();
  }
});

test('a native startup snapshot from another owner cannot authorize a private conversation', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const workspaces = Promise.withResolvers();
  fixture.routes.set(linkPersonalStartup + linkWork, () => linkedChatSnapshot(fixture, bob));
  fixture.routes.set('/v1/workspaces?limit=100', () => workspaces.promise);
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.some(call => call.path.startsWith(scope + '/')), false);
    assert.deepEqual(fixture.messages(), []);
    assert.ok(fixture.calls.some(call => call.path === linkPersonalIdentity && call.method === 'GET'));
    assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent' && call.method === 'GET'), false);
    workspaces.resolve(json(200, {items: [{id: linkWork, name: 'Personal', kind: 'personal'}]}));
    await loading;
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkNativeDirectory));
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    workspaces.resolve(json(503, {}));
    fixture.restore();
  }
});

test('direct signup to Chat will not open a different account even when that account has a ready runtime', async () => {
  const fixture = linkedChatFixture('');
  const values = new Map();
  const view = {sessionStorage: {
    setItem: (key, value) => values.set(key, value),
    getItem: key => values.get(key),
    removeItem: key => values.delete(key),
  }};
  fixture.doc.defaultView = view;
  rememberSignupSession(view, bob);
  fixture.routes.set(linkPersonalDefault, () => linkedChatSnapshot(fixture, alice));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    assert.deepEqual(fixture.calls.map(call => call.path), ['/v1/auth/session', linkPersonalDefault]);
    assert.equal(fixture.el('login-panel').hidden, false);
    assert.equal(fixture.el('main-panel').hidden, true);
    assert.match(fixture.el('status').textContent, /账户已创建.*登录会话尚未确认/);
    assert.equal(pendingSignupSession(view), null);
    fixture.el('chat-body').value = 'Wrong account must never send this';
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(fixture.calls.some(call => call.method === 'POST'), false);
  } finally {
    fixture.restore();
  }
});

test('a cold native Chat boot provisions the personal workspace and ignores the earlier directory snapshot', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const earlier = Promise.withResolvers();
  const initialized = Promise.withResolvers();
  let workspaceReads = 0;
  fixture.routes.set(linkPersonalIdentity, () => json(200, {items: []}));
  fixture.routes.set('/v1/personal-agent', ({method}) => method === 'POST'
    ? initialized.promise : json(404, {}));
  fixture.routes.set('/v1/workspaces?limit=100', () => {
    workspaceReads += 1;
    return workspaceReads === 1 ? earlier.promise
      : json(200, {items: [{id:linkWork, name:'Personal', kind:'personal'}]});
  });
  try {
    const mountPromise = mount(fixture.doc, {fetcher:fixture.fetcher});
    await settle();
    assert.equal(workspaceReads, 1);
    assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent' && call.method === 'POST'), true);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativeLatest), false);
    initialized.resolve(json(201, {personal_agent: {workspace: {id:linkWork}, agent:fixture.agent}}));
    await mountPromise;
    assert.equal(workspaceReads, 2);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    earlier.resolve(json(200, {items: []}));
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    earlier.resolve(json(200, {items: []}));
    initialized.resolve(json(201, {personal_agent: {workspace: {id:linkWork}, agent:fixture.agent}}));
    fixture.restore();
  }
});

test('a link to the latest native send highlights it and keeps its pending reply live', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const scope = linkBase(linkWork);
  const hash = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`;
  const fixture = linkedChatFixture(hash);
  const {agent,nativeThread,nativeRows,routes,restore} = fixture;
  const key = 'artifact-receipt-reply';
  let items = [nativeRows[0],{...nativeRows[1],body:'',status:'running',client_key:key}];
  const linked = `${scope}${linkNativeLatest}&around=${linkAgentOlder}`;
  routes.set(linked,()=>json(200,{agent,conversation:nativeThread,items}));
  routes.set(scope + linkNativeLatest,()=>json(200,{agent,conversation:nativeThread,items}));
  const progress = scope + linkNativePath + '/reply-progress?key=' + key + '&after=0';
  routes.set(progress,()=> {
    items = [nativeRows[0],{...nativeRows[1],body:'Live reply from the receipt'}];
    return json(200,{state:'succeeded'});
  });
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    assert.deepEqual(fixture.messages(),[linkAgentOlder,linkAgentLatest]);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump,'true');
    assert.equal(fixture.el('message-scroller').dataset.readingHistory,undefined);
    assert.equal(fixture.calls.some(call=>call.path === linked),true);
    assert.equal(fixture.calls.some(call=>call.path === scope + linkNativeLatest),false);
    t.mock.timers.tick(400);
    await settle();
    assert.ok(fixture.calls.some(call=>call.path === progress));
    assert.match(fixture.el('message-list').children[1].children[1].textContent,/Live reply from the receipt/);
  } finally { restore(); }
});

test('a historical private message link with an unfinished reply stays in its history window', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`);
  const {agent,nativeThread,nativeRows,routes,restore} = fixture;
  const linked = `${scope}${linkNativeLatest}&around=${linkAgentOlder}`;
  const items = [nativeRows[0],{...nativeRows[1],body:'',status:'running',client_key:'old-pending-reply'}];
  routes.set(linked,()=>json(200,{agent,conversation:nativeThread,items,has_newer:true}));
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    assert.equal(fixture.el('chat-load-newer').hidden,false);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump,'true');
    t.mock.timers.tick(1200);
    await settle();
    assert.deepEqual(fixture.calls.filter(call=>call.path.startsWith(scope + linkNativePath)).map(call=>call.path),[linked]);
  } finally { restore(); }
});

test('a linked native history and message jump render while settings and the Social directory load', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const hash = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`;
  const fixture = linkedChatFixture(hash);
  const directory = Promise.withResolvers();
  const onboarding = Promise.withResolvers();
  const settings = Promise.withResolvers();
  const around = `${scope}${linkNativeLatest}&around=${linkAgentOlder}`;
  fixture.routes.set(scope + linkSocialDirectory, () => directory.promise);
  fixture.routes.set(scope + linkNativeLatest, () => json(200, {agent: fixture.agent, conversation: fixture.nativeThread,
    items: [fixture.nativeRows[1]], cursor: linkAgentLatest}));
  fixture.routes.set(around, () => json(200, {agent: fixture.agent, conversation: fixture.nativeThread,
    items: [fixture.nativeRows[0]], cursor: null, has_newer: true}));
  fixture.routes.set('/v1/onboarding', () => onboarding.promise);
  fixture.routes.set('/v1/settings', () => settings.promise);
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.ok(fixture.calls.some(call => call.path === '/v1/onboarding'));
    assert.ok(fixture.calls.some(call => call.path === '/v1/settings'));
    assert.ok(fixture.calls.some(call => call.path === scope + linkSocialDirectory), 'the Social directory really is pending');
    const personal = fixture.calls.findIndex(call => call.path === linkPersonalIdentity && call.method === 'GET');
    const workspaces = fixture.calls.findIndex(call => call.path === '/v1/workspaces?limit=100');
    const detail = fixture.calls.findIndex(call => call.path === around);
    assert.ok(personal >= 0 && workspaces >= 0 && personal < detail && workspaces < detail, 'workspace authorization precedes detail');
    assert.ok(fixture.calls.some(call => call.path === linkPersonalScopeOnly(linkWork)));
    assert.equal(fixture.calls.some(call => call.path.includes('entry_conversation=')), false);
    assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent' && call.method === 'POST'), false,
      'a running DS-Bot with an existing personal binding does not need to provision again');
    assert.deepEqual(fixture.messages(), [linkAgentOlder]);
    assert.equal(fixture.el('chat-title').textContent, fixture.agent.name);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump, 'true');
    assert.deepEqual(fixture.scrolls.map(row => row.id), [linkAgentOlder]);
    assert.equal(globalThis.location.hash, hash);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    assert.equal(fixture.calls.filter(call => call.path === around).length, 1);
    settings.resolve(json(200, {settings: {values: {send_shortcut: 'mod_enter'}}}));
    await settle();
    assert.equal(fixture.el('chat-body').dataset.sendShortcut, 'mod_enter');
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump, 'true');
    directory.resolve(json(200, {items: []}));
    await loading;
    await settle();
    assert.equal(fixture.selected(), linkThread);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 0);
    assert.deepEqual(fixture.messages(), [linkAgentOlder]);
    assert.equal(fixture.el('onboarding-banner').hidden, true);
    onboarding.resolve(json(200, {onboarding: {completed: false}}));
    await settle();
    assert.equal(fixture.el('onboarding-banner').hidden, false);
    await fire(fixture.el('chat-back-to-latest'), 'click');
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentLatest]);
    assert.equal(fixture.el('chat-back-to-latest').hidden, true);
    assert.deepEqual(fixture.calls.filter(call => call.path.endsWith('/read')).map(call => call.body),
      [{message_id: linkAgentLatest}]);
  } finally {
    settings.resolve(json(200, {settings: {values: {}}}));
    onboarding.resolve(json(200, {onboarding: {completed: true}}));
    directory.resolve(json(200, {items: []}));
    fixture.restore();
  }
});

test('a quick native send clears the draft and applies the saved reply language after settings reach the queue', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const settings = Promise.withResolvers();
  const sendPath = scope + linkNativePath + '/messages';
  fixture.routes.set('/v1/settings', () => settings.promise);
  fixture.routes.set(sendPath, () => json(201, {
    message:{id:'sent',role:'user',body:'hola',status:'succeeded'},
    reply:{id:'answer',role:'assistant',body:'hola',status:'succeeded'},
  }));
  try {
    await mount(fixture.doc, {fetcher:fixture.fetcher});
    assert.deepEqual(fixture.messages(), [linkAgentOlder,linkAgentLatest]);
    const field = fixture.el('chat-body');
    field.value = 'hola';
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(field.value, '');
    assert.match(fixture.el('message-list').children.at(-1).children[1].textContent, /加载聊天偏好/);
    assert.equal(fixture.calls.some(call => call.path === sendPath), false);
    field.value = 'next draft';
    settings.resolve(json(200, {settings:{values:{chat_language:'es',send_shortcut:'mod_enter'}}}));
    await settle();
    assert.deepEqual(fixture.calls.filter(call => call.path === sendPath).map(call => call.body),
      [{body:'hola',chat_language:'es',accept_pending:true}]);
    assert.equal(field.value, 'next draft');
    assert.equal(field.dataset.sendShortcut, 'mod_enter');
    assert.deepEqual(fixture.messages().slice(-2), ['sent','answer']);
  } finally {
    settings.resolve(json(500, {}));
    fixture.restore();
  }
});

test('an unavailable session keeps the prior draft and a superseded retry cannot change its destination', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const unavailable = Promise.withResolvers();
  const retry = Promise.withResolvers();
  let attempts = 0;
  let retrySignal;
  fixture.routes.set(scope + linkSocialPath, (_call, options) => {
    if (++attempts === 1) return unavailable.promise;
    retrySignal = options.signal;
    return retry.promise;
  });
  const click = cid => fire(fixture.el('conversation-list'), 'click', {
    target:sessionRows(fixture.el).find(row => row.dataset.conversation === cid),
  });
  try {
    await mount(fixture.doc, {fetcher:fixture.fetcher});
    const field = fixture.el('chat-body');
    field.value = 'keep this private draft';
    await fire(field, 'input');
    const opening = click(linkSocial);
    await settle();
    assert.equal(sessionRows(fixture.el).find(row => row.dataset.conversation === linkSocial).getAttribute('aria-busy'), 'true');
    assert.match(fixture.el('session-opening-view').textContent, /Linked group/);
    assert.equal(fixture.el('main-panel').inert, true);
    assert.equal(fixture.el('chat-send').disabled, true);
    assert.equal(fixture.selected(), linkThread);
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(fixture.calls.some(call => call.method === 'POST' && call.path.endsWith('/messages')), false);
    unavailable.resolve(json(503, {}));
    await opening;
    assert.equal(fixture.el('session-transition-retry').hidden, false);
    assert.equal(fixture.el('chat-send').disabled, false);
    assert.equal(field.value, 'keep this private draft');
    await fire(fixture.el('session-transition-retry'), 'click');
    await settle();
    assert.equal(attempts, 2);
    const countBefore = fixture.calls.length;
    const firstRow = fixture.el('message-list').children[0];
    await click(linkThread);
    assert.equal(retrySignal.aborted, true);
    assert.equal(fixture.calls.slice(countBefore).some(call => call.path === scope + linkNativeLatest), false);
    assert.equal(fixture.el('message-list').children[0], firstRow);
    retry.resolve(json(200, {conversation:{id:linkSocial,kind:'group',title:'Late group'},items:[]}));
    await settle();
    assert.equal(fixture.selected(), linkThread);
    assert.equal(fixture.el('session-transition').hidden, true);
    assert.equal(fixture.el('session-opening-view').hidden, true);
    assert.equal(fixture.el('main-panel').inert, false);
    assert.equal(field.value, 'keep this private draft');
  } finally {
    unavailable.resolve(json(503, {}));
    retry.resolve(json(503, {}));
    fixture.restore();
  }
});

test('a pending native older page cannot replace the latest view after the user returns', async () => {
  const path = linkBase(linkWork) + linkNativePath;
  const hash = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentLatest}`;
  const fixture = linkedChatFixture(hash);
  const pending = Promise.withResolvers();
  const before = `${path}?before=${linkAgentLatest}&limit=50`;
  const page = items => json(200, {agent: fixture.agent, conversation: fixture.nativeThread, items, cursor: linkAgentLatest});
  fixture.routes.set(path + '?limit=50', () => page([fixture.nativeRows[1]]));
  fixture.routes.set(before, () => pending.promise);
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    const older = fixture.el('chat-load-older');
    const latest = fixture.el('chat-back-to-latest');
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    const paging = fire(older, 'click');
    await settle();
    assert.equal(older.disabled, true);
    await fire(latest, 'click');
    await settle();
    pending.resolve(page([fixture.nativeRows[0]]));
    await paging;
    assert.deepEqual(fixture.messages(), [linkAgentLatest]);
    assert.equal(latest.hidden, true);
    assert.equal(older.disabled, false);
    assert.equal(fixture.calls.filter(call => call.path === before).length, 1);
    assert.equal(fixture.calls.filter(call => call.path.endsWith('/read')).length, 1);
  } finally {
    pending.resolve(page([]));
    fixture.restore();
  }
});

test('private pagination keeps the full rich message and replaces it if its source changes', async () => {
  const path = linkBase(linkWork) + linkNativePath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const {doc, el, fetcher, nativeRows, routes, restore} = fixture;
  const chat = items => json(200, {agent: fixture.agent, conversation: fixture.nativeThread, items, cursor: linkAgentLatest});
  const reply = {...nativeRows[1], body: `### 原回复\n\n项目 | 值\n--- | ---\n甲 | 乙\n\n${'背景说明'.repeat(210)}`};
  let latest = reply;
  routes.set(path + '?limit=50', () => chat([latest]));
  routes.set(`${path}?before=${linkAgentLatest}&limit=50`, () => chat([nativeRows[0]]));
  const body = () => el('message-list').children.find(row => row.dataset.messageId === linkAgentLatest)
    ?.children.find(node => node.className === 'body');
  try {
    await mount(doc, {fetcher});
    await settle();
    const oldBody = body();
    const markdown = oldBody.querySelector('.chat-markdown');
    const table = markdown.querySelector('.chat-markdown-table-scroll');
    table.scrollLeft = 28;
    assert.equal(oldBody.children.length,1);
    await fire(el('chat-load-older'), 'click');
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(body(), oldBody);
    assert.equal(body().querySelector('.chat-markdown-table-scroll'),table);
    assert.equal(table.scrollLeft,28);

    latest = {...reply, body: '修改后的回复'};
    await fire(el('chat-back-to-latest'), 'click');
    await settle();
    assert.notEqual(body(), oldBody);
    assert.equal(body().textContent, '修改后的回复');
  } finally {
    await settle();
    restore();
  }
});

test('sending supersedes a pending native older page while keeping the current transcript', async () => {
  const path = linkBase(linkWork) + linkNativePath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const pending = Promise.withResolvers();
  const sent = Promise.withResolvers();
  const scope = {agent: fixture.agent, conversation: fixture.nativeThread};
  const page = items => json(200, {...scope, items, cursor: linkAgentLatest});
  fixture.routes.set(path + '?limit=50', () => page([fixture.nativeRows[1]]));
  fixture.routes.set(`${path}?before=${linkAgentLatest}&limit=50`, () => pending.promise);
  fixture.routes.set(path + '/messages', () => sent.promise);
  const element = fixture.doc.createElement;
  fixture.doc.createElement = tag => {
    const node = element(tag);
    node.getBoundingClientRect = () => ({top: 0, bottom: 1});
    return node;
  };
  fixture.el('message-scroller').getBoundingClientRect = () => ({top: 0});
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    const older = fixture.el('chat-load-older');
    const paging = fire(older, 'click');
    await settle();
    assert.equal(older.disabled, true);
    const field = fixture.el('chat-body');
    field.value = 'Send while a page loads';
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(field.value, '');
    pending.resolve(page([fixture.nativeRows[0]]));
    await paging;
    assert.equal(fixture.el('chat-back-to-latest').hidden, true);
    const message = {id: 'new-sent', role: 'user', body: 'Send while a page loads'};
    const reply = {id: 'new-reply', role: 'assistant', status: 'succeeded', body: 'Reply'};
    sent.resolve(json(201, {message, reply}));
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentLatest, message.id, reply.id]);
    assert.equal(fixture.calls.filter(call => call.path === path + '?limit=50').length, 1);
  } finally {
    pending.resolve(page([]));
    sent.resolve(json(404, {}));
    fixture.restore();
  }
});

test('paging forward from a native permalink preserves drafts while an explicit jump to the latest supersedes a pending page', async () => {
  const path = linkBase(linkWork) + linkNativePath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`);
  const {el, messages, routes, restore} = fixture;
  const scope = {agent:fixture.agent,conversation:fixture.nativeThread};
  const [older, latest] = fixture.nativeRows;
  const middle = {...older,id:'c'.repeat(32),created:7,body:'Intervening message'};
  const pending = Promise.withResolvers();
  const page = (items, has_newer = false) => json(200,{...scope,items,cursor:null,has_newer});
  const query = id => `${path}?after=${id}&limit=50`;
  let attempts = 0;
  routes.set(path + '?limit=50', () => page([latest]));
  routes.set(`${path}?limit=50&around=${older.id}`, () => page([older],true));
  routes.set(query(older.id), () => ++attempts === 1 ? json(503,{}) : page([middle],true));
  routes.set(query(middle.id), () => pending.promise);
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    const newer = el('chat-load-newer');
    assert.equal(newer.hidden,false);
    assert.deepEqual(messages(),[older.id]);
    el('chat-body').value = 'draft survives history';
    await fire(el('chat-body'),'input');
    await fire(newer,'click');
    assert.match(el('chat-unread-status').textContent,/后续消息加载失败/);
    assert.equal(newer.disabled,false);
    assert.deepEqual(messages(),[older.id]);
    await fire(newer,'click');
    assert.deepEqual(messages(),[older.id,middle.id]);
    assert.equal(el('chat-body').value,'draft survives history');
    const loading = fire(newer,'click');
    assert.equal(newer.disabled,true);
    await fire(el('chat-back-to-latest'),'click');
    await settle();
    pending.resolve(page([{...middle,id:'d'.repeat(32)}]));
    await loading;
    assert.equal(newer.hidden,true);
    assert.deepEqual(messages(),[latest.id]);
    assert.equal(el('chat-body').value,'draft survives history');
  } finally {
    pending.resolve(page([]));
    restore();
  }
});

test('sending from native history clears drafts immediately and keeps sending while the latest page loads', async () => {
  const path = linkBase(linkWork) + linkNativePath;
  const hash = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`;
  const fixture = linkedChatFixture(hash);
  const latest = Promise.withResolvers();
  const sent = Promise.withResolvers();
  const sentAgain = Promise.withResolvers();
  const scope = {agent: fixture.agent, conversation: fixture.nativeThread};
  let latestCalls = 0;
  fixture.routes.set(path + '?limit=50', () => { latestCalls += 1; return latest.promise; });
  fixture.routes.set(`${path}?limit=50&around=${linkAgentOlder}`, () => json(200, {...scope, items: [fixture.nativeRows[0]]}));
  fixture.routes.set(path + '/messages', call => call.body.body === 'Send while reading' ? sent.promise : sentAgain.promise);
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    assert.deepEqual(fixture.messages(), [linkAgentOlder]);
    const field = fixture.el('chat-body');
    field.value = 'Send while reading';
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(field.value, '');
    assert.ok(fixture.el('message-list').children.some(node => node.dataset.sendPending === 'pending'));
    field.value = 'Send again before latest';
    await fire(fixture.el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(field.value, '');
    field.value = 'Next draft';
    const message = {id: 'new-sent', role: 'user', body: 'Send while reading'};
    const reply = {id: 'new-reply', role: 'assistant', status: 'succeeded', body: 'Reply'};
    sent.resolve(json(201, {message, reply}));
    await settle();
    assert.equal(fixture.calls.filter(call => call.path === path + '/messages').length, 2);
    const second = {id: 'second-sent', role: 'user', body: 'Send again before latest'};
    const secondReply = {id: 'second-reply', role: 'assistant', status: 'succeeded', body: 'Another reply'};
    sentAgain.resolve(json(201, {message: second, reply: secondReply}));
    await settle();
    assert.ok(fixture.el('message-list').children.some(node => node.dataset.sendPending === 'pending'));
    latest.resolve(json(200, {...scope, items: [fixture.nativeRows[1]]}));
    await settle();
    assert.equal(field.value, 'Next draft');
    assert.deepEqual(fixture.messages(), [linkAgentLatest, message.id, reply.id, second.id, secondReply.id]);
    assert.equal(fixture.el('chat-back-to-latest').hidden, true);
    assert.equal(latestCalls, 1);
    assert.equal(fixture.calls.filter(call => call.path === path + '/messages').length, 2);
  } finally {
    sent.resolve(json(404, {}));
    sentAgain.resolve(json(404, {}));
    latest.resolve(json(404, {}));
    fixture.restore();
  }
});

test('a linked Social history reaches its older target without waiting for the native directory or marking unread', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const hash = `#workspace=${linkWork}&social=${linkSocial}&message=${linkSocialOlder}`;
  const fixture = linkedChatFixture(hash);
  const directory = Promise.withResolvers();
  fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkNativeDirectory), 'the native directory really is pending');
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialOlder]);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump, 'true');
    assert.deepEqual(fixture.scrolls.map(row => row.id), [linkSocialOlder]);
    assert.equal(globalThis.location.hash, hash);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath + '?around=' + linkSocialOlder).length, 1);
    assert.equal(fixture.calls.some(call => call.path.startsWith(scope + linkSocialPath + '/messages?around=')), false);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    directory.resolve(json(200, {items: [], conversations: []}));
    await loading;
    await settle();
    assert.equal(fixture.selected(), linkSocial);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath).length, 0);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    assert.deepEqual(fixture.messages(), [linkSocialOlder]);
  } finally {
    directory.resolve(json(200, {items: [], conversations: []}));
    fixture.restore();
  }
});

test('a Social message link that reaches the latest window follows the group reply already in progress', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const path = linkBase(linkWork) + linkSocialPath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}&message=${linkSocialLatest}`);
  const conversation = {id:linkSocial, workspace_id:linkWork, kind:'group', title:'Linked group', members:[linkMember]};
  const source = {id:linkSocialLatest, conversation_id:linkSocial, user_id:bob, body:'Group reply source', seq:8,
    reply_jobs:[{id:'group-receipt-job',attempt:1,status:'running',agent_name:'Group assistant'}]};
  const linkRead = `${path}?around=${source.id}`;
  const progressRead = `${path}/reply-progress`;
  fixture.routes.set(linkRead,()=>json(200,{conversation,items:[source],has_newer:false}));
  fixture.routes.set(progressRead,()=>json(200,{items:[{id:'group-receipt-job',message_id:source.id,attempt:1,text:'Live group reply'}]}));
  try {
    await mount(fixture.doc,{fetcher:fixture.fetcher});
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump,'true');
    assert.equal(fixture.el('chat-back-to-latest').hidden,true);
    t.mock.timers.tick(500);
    await settle();
    const preview = descendants(fixture.el('message-list')).find(node=>node.classList.contains('group-reply-preview'));
    assert.equal(preview.textContent,'Live group reply');
    assert.equal(fixture.calls.filter(call=>call.path===progressRead).length,1);
    assert.equal(fixture.calls.some(call=>call.path===path || call.path===path+'/read'),false);
  } finally { fixture.restore(); }
});

for (const newer of [false, true]) {
  test(`a late directory snapshot ${newer ? 'retains unread newer than' : 'does not restore unread covered by'} the linked Social read`, async () => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}`);
    const directory = Promise.withResolvers();
    fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
    if (newer) fixture.routes.set(scope + linkSocialDirectory, () => json(200, {items: [
      {id: linkSocial, kind: 'group', title: 'Linked group', last_seq: 9, updated: 31, unread_count: 1, members: [linkMember]},
    ]}));
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.deepEqual(fixture.messages(), [linkSocialLatest]);
      assert.deepEqual(fixture.calls.find(call => call.path === scope + linkSocialPath + '/read')?.body, {seq: 8});
      directory.resolve(json(200, {items: [], conversations: []}));
      await loading;
      await settle();
      const linked = sessionRows(fixture.el).find(row => row?.dataset.conversation === linkSocial);
      assert.ok(linked);
      assert.equal(linked.getAttribute('aria-current'), 'true');
      const badge = descendants(linked).find(node => node.classList.contains('unread-badge'));
      assert.equal(badge?.textContent, newer ? '1' : undefined);
    } finally {
      directory.resolve(json(200, {items: [], conversations: []}));
      fixture.restore();
    }
  });
}

test('a late exact native history cannot overwrite a different workspace and Social target selected by hashchange', async () => {
  const old = linkBase(linkWork) + linkNativeLatest;
  const current = linkBase(linkTeam) + linkSocialPath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const wait = Promise.withResolvers();
  const oldOnboarding = Promise.withResolvers();
  let onboardingRequests = 0;
  fixture.routes.set(old, () => wait.promise);
  fixture.routes.set('/v1/onboarding', () => ++onboardingRequests === 1
    ? oldOnboarding.promise : json(200, {onboarding: {completed: true}}));
  try {
    const first = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.filter(call => call.path === old).length, 1);
    const newHash = `#workspace=${linkTeam}&social=${linkSocial}`;
    await fixture.navigate(newHash);
    await settle();
    assert.equal(fixture.el('workspace').value, linkTeam);
    assert.equal(fixture.calls.filter(call => call.path === current + '?start=unread').length, 1);
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    assert.deepEqual(fixture.calls.find(call => call.path === current + '/read')?.body, {seq: 8});
    oldOnboarding.resolve(json(200, {onboarding: {completed: false}}));
    wait.resolve(json(200, {agent: fixture.agent, conversation: fixture.nativeThread, items: fixture.nativeRows}));
    await first;
    await settle();
    assert.equal(globalThis.location.hash, newHash);
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    assert.equal(fixture.selected(), linkSocial);
    assert.equal(fixture.el('onboarding-banner').hidden, true);
    assert.equal(fixture.calls.some(call => call.path === linkBase(linkWork) + linkNativePath + '/read'), false);
  } finally {
    oldOnboarding.resolve(json(200, {onboarding: {completed: false}}));
    wait.resolve(json(404, {error: {code: 'not_found'}}));
    fixture.restore();
  }
});

for (const target of ['bare agent', 'default']) {
  test(`startup still waits for the directory before selecting a ${target} conversation`, async () => {
    const scope = linkBase(linkWork);
    const hash = `#workspace=${linkWork}` + (target === 'bare agent' ? `&agent=${linkAgent}` : '');
    const fixture = linkedChatFixture(hash);
    const directory = Promise.withResolvers();
    fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.ok(fixture.calls.some(call => call.path === scope + linkNativeDirectory));
      assert.equal(fixture.calls.some(call => [scope + linkNativeLatest, scope + linkSocialPath + '?start=unread'].includes(call.path)), false);
      directory.resolve(json(200, {items: [fixture.agent], conversations: [fixture.nativeThread]}));
      await loading;
      await settle();
      assert.equal(fixture.selected(), target === 'bare agent' ? linkThread : linkSocial);
      assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, target === 'bare agent' ? 1 : 0);
      assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath + '?start=unread').length, target === 'default' ? 1 : 0);
    } finally {
      directory.resolve(json(200, {items: [], conversations: []}));
      fixture.restore();
    }
  });
}

test('a failed Social directory does not hide a successful native deep link in a hidden tab', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`, {visibility: 'hidden'});
  fixture.routes.set(scope + linkSocialDirectory, () => json(503, {error: {code: 'unavailable'}}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.selected(), linkThread);
    assert.equal(fixture.el('conversations-status').hidden, false);
    assert.match(fixture.el('conversations-status').textContent, /部分对话加载失败/);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativePath + '/read'), false);
  } finally { fixture.restore(); }
});

test('an unavailable direct target keeps its own error and the directory without opening another thread', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  fixture.routes.set(scope + linkNativeLatest, () => json(404, {error: {code: 'not_found', message: '原会话已移除'}}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativeLatest).length, 1);
    assert.equal(fixture.calls.some(call => call.path === scope + linkSocialPath), false);
    assert.deepEqual(fixture.messages(), []);
    assert.ok(sessionRows(fixture.el).some(row => row?.dataset.conversation === linkSocial));
    assert.match(fixture.el('status').textContent, /原会话已移除/);
  } finally { fixture.restore(); }
});

for (const path of [linkNativePath, linkSocialPath]) {
  test(`an inactive workspace cannot dispatch a linked ${path === linkNativePath ? 'native' : 'Social'} target`, async () => {
    const target = path === linkNativePath ? `agent=${linkAgent}&conversation=${linkThread}` : `social=${linkSocial}`;
    const fixture = linkedChatFixture(`#workspace=${linkUnavailable}&${target}`);
    try {
      await mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.equal(fixture.calls.some(call => call.path.split('?')[0].endsWith(path)), false,
        'the inactive link cannot be opened, including against an active workspace picked as fallback');
      assert.equal(fixture.calls.some(call => call.path.startsWith(linkBase(linkUnavailable) + '/')), false);
      assert.deepEqual(fixture.messages(), []);
      assert.match(fixture.el('status').textContent, /无法访问此会话所在的工作区/);
    } finally { fixture.restore(); }
  });
}

const reminderRow = (id, overrides = {}) => ({
  id, title: '提醒：看这条消息', template_id: 'custom', scope: 'once', enabled: true,
  participants: [{user_id: alice, username: 'alice'}],
  schedule: {kind: 'once', date: '2026-11-19', time: '14:30', time_zone: 'UTC'},
  ...overrides,
});

test('due reminders are only my enabled one-off automations that are already due, split by their own zone', () => {
  const now = Date.parse('2026-11-19T16:05:00Z');
  const rows = [
    reminderRow('a'.repeat(32)),
    reminderRow('b'.repeat(32), {schedule: {kind: 'once', date: '2026-11-19', time: '23:00', time_zone: 'UTC'}}),
    reminderRow('c'.repeat(32), {schedule: {kind: 'daily', time: '09:00', time_zone: 'UTC'}}),
    reminderRow('d'.repeat(32), {participants: [{user_id: bob, username: 'bob'}]}),
    reminderRow('e'.repeat(32), {enabled: false}),
    reminderRow('f'.repeat(32), {schedule: {kind: 'once', date: '2026-11-18', time: '09:00', time_zone: 'UTC'}}),
    reminderRow('0'.repeat(32), {schedule: {kind: 'once', date: '2026-11-19', time: '10:30', time_zone: 'Asia/Shanghai'}}),
    reminderRow('1'.repeat(32), {participants: [{username: 'alice'}], schedule: {kind: 'once', date: '2026-11-19', time: '13:00', time_zone: 'UTC'}}),
  ];
  const {today, older} = dueReminders(rows, {id: alice, username: 'alice'}, now);
  assert.deepEqual(today.map((item) => item.id), ['a'.repeat(32), '1'.repeat(32)]);
  assert.deepEqual(older.map((item) => item.id), ['0'.repeat(32), 'f'.repeat(32)]);
  assert.equal(reminderDueLabel(today[0], now), '今天 14:30 到点');
  assert.equal(reminderDueLabel(older[0], now), '11-19 10:30 到点');
  assert.equal(reminderDueLabel(older[1], now), '11-18 09:00 到点');
  assert.deepEqual(dueReminders([], alice, now), {today: [], older: []});
  assert.deepEqual(dueReminders(null, alice, now), {today: [], older: []});
});

test('the sidebar lists 今天到点的提醒 from the automations the server returns and says 读不到 instead of 0', async () => {
  const at = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const due = {
    id: 'r'.repeat(32), title: '提醒：看这条消息', template_id: 'custom', scope: 'once', enabled: true,
    participants: [{user_id: alice, username: 'alice'}],
    schedule: {kind: 'once', date, time: '00:00', time_zone: 'UTC'},
  };
  const future = {
    ...due, id: 'q'.repeat(32), title: '提醒：明天',
    schedule: {kind: 'once', date: '2999-01-01', time: '09:00', time_zone: 'UTC'},
  };
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/automations') return json(200, {items: [due, future]});
      return original(path);
    }});
    await settle();
    assert.equal(el('due-reminders').hidden, false, 'the panel appears when something is due today');
    assert.equal(el('due-reminders-heading').textContent, '今天到点的提醒 1 条');
    const rows = el('due-reminders-list').children;
    assert.equal(rows.length, 1, 'only the due one is listed');
    const link = rows[0].children[0];
    assert.equal(link.tagName, 'A');
    assert.match(String(link.getAttribute('href') || link.href), /\/automations$/);
    assert.match(link.textContent, /提醒：看这条消息/);
    assert.equal(link.children[0].textContent, '今天 00:00 到点');
  } finally { restore(); }

  const failing = fakeChatDocument(chatHtml());
  const restore2 = installChatGlobals();
  try {
    await mount(failing.doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/automations') return json(500, {error: {code: 'internal', message: 'boom'}});
      return original(path);
    }});
    await settle();
    assert.equal(failing.el('due-reminders').hidden, false, 'a failed read is shown, not hidden as 0');
    assert.equal(failing.el('due-reminders-note').hidden, false);
    assert.equal(failing.el('due-reminders-note').textContent, '读不到到点的提醒。');
    assert.equal(failing.el('due-reminders-list').children.length, 0);
  } finally { restore2(); }
});

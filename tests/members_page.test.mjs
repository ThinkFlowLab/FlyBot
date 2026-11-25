import assert from 'node:assert/strict';
import test from 'node:test';
import { teamInviteCode, teamInviteFromHash, teamInviteUrl } from '../flybot_workspace/static/shell/team-invite-link.mjs';
import {
  addableRoles, canAdd, canChange, canInvite, canRemove, mount,
  readAccept, readAddMember, readInvite, workspaceFromHash,
} from '../flybot_workspace/static/members/app.mjs';

test('permission helpers follow the documented role defaults', () => {
  assert.deepEqual(addableRoles('owner'), ['admin', 'member']);
  assert.deepEqual(addableRoles('admin'), ['member']);
  assert.deepEqual(addableRoles('member'), []);
  assert.equal(canAdd('owner'), true);
  assert.equal(canAdd('member'), false);
  assert.equal(canChange('owner'), true);
  assert.equal(canChange('admin'), false);
  assert.equal(canInvite('admin'), true);
  assert.equal(canInvite('member'), false);
  assert.equal(canRemove('owner', {user_id: 'b', role: 'admin'}, 'a'), true);
  assert.equal(canRemove('admin', {user_id: 'b', role: 'admin'}, 'a'), false);
  assert.equal(canRemove('admin', {user_id: 'b', role: 'member'}, 'a'), true);
  assert.equal(canRemove('member', {user_id: 'b', role: 'member'}, 'a'), false);
  assert.equal(canRemove('member', {user_id: 'me', role: 'member'}, 'me'), true);
  assert.equal(canRemove('owner', {user_id: 'a', role: 'owner'}, 'a'), false);
});

test('readAddMember and readInvite map form fields', () => {
  const values = {username: ' Bob ', role: 'admin', expires_days: '7', max_uses: '2', token: ' tok '};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readAddMember({}), {username: 'Bob', role: 'admin'});
    assert.deepEqual(readInvite({}), {role: 'admin', expires_in: 604800, max_uses: 2});
    assert.deepEqual(readAccept({}), {token: 'tok'});
  } finally {
    globalThis.FormData = original;
  }
});

class FakeElement {
  constructor(tag = 'div', doc = null) {
    this.tagName = tag;
    this._doc = doc;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.type = '';
    this.id = '';
    this._text = '';
  }
  set textContent(value) {
    this._text = value;
    if (value === '') this.children = [];
  }
  get textContent() { return this._text; }
  get options() { return this.children; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    if (this.tagName === 'select' && child.tagName === 'option' && !this.value) this.value = child.value;
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  focus() { if (this._doc) this._doc.activeElement = this; }
  reset() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function roleElement(doc) {
  const select = new FakeElement('select', doc);
  for (const value of ['member', 'admin']) {
    const option = new FakeElement('option', doc);
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  return select;
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: '',
    activeElement: null,
    handlers: {},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.endsWith('-form') ? 'form'
          : id === 'workspace' ? 'select'
            : id === 'member-list' || id === 'invite-list' ? 'ul' : 'div';
        const element = new FakeElement(tag, doc);
        element.id = id;
        if (tag === 'form') element.elements = {role: roleElement(doc)};
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag, doc); },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    fire(type, event = {}) {
      const payload = {type, ...event};
      if (payload.target && typeof payload.target === 'object') {
        let node = payload.target;
        while (node) {
          for (const handler of node.handlers?.[type] || []) handler(payload);
          node = node.parentElement;
        }
      }
      for (const handler of doc.handlers[type] || []) handler(payload);
      return payload;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {doc, elements};
}

function jsonResponse(status, body) { return {status, json: async () => body}; }

function makeApi({members, invites = [], forbiddenPaths = [], notFoundPaths = [], failSocial = false}) {
  const calls = [];
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    calls.push({method, path, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers || {}});
    if (path === '/v1/auth/session') return jsonResponse(200, {user: {id: 'u-me', username: 'alice'}});
    if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
    if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {items: [{id: 'w1', name: 'W1'}]});
    if (path === '/v1/workspaces/w1/members' && method === 'GET') {
      return jsonResponse(200, {items: members.map(item => ({...item}))});
    }
    if (path === '/v1/workspaces/w1/invites' && method === 'GET') {
      return jsonResponse(200, {items: invites.map(item => ({...item}))});
    }
    if (path === '/v1/workspaces/w1/join-requests' && method === 'GET') {
      return jsonResponse(200, {items: []});
    }
    if (path === '/v1/workspaces/w1/directory' && method === 'GET') {
      return jsonResponse(200, {listing: {listed: false, summary: ''}});
    }

    const social = path === '/v1/workspaces/w1/social/conversations' && method === 'POST';
    if (social) {
      if (failSocial) return jsonResponse(400, {error: {message: '无法创建会话'}});
      return jsonResponse(200, {conversation: {id: 'c-dm-1', kind: 'dm'}});
    }

    const removal = path.match(/^\/v1\/workspaces\/w1\/members\/([^/]+)\/remove$/);
    if (removal && method === 'POST') {
      const index = members.findIndex(item => item.user_id === removal[1]);
      if (index >= 0) members.splice(index, 1);
      return jsonResponse(200, {});
    }
    const revoke = path.match(/^\/v1\/workspaces\/w1\/invites\/([^/]+)\/revoke$/);
    if (revoke && method === 'POST') {
      const invite = invites.find(item => item.id === revoke[1]);
      if (invite) invite.revoked = 1;
      return jsonResponse(200, {});
    }
    const thaw = path.match(/^\/v1\/workspaces\/w1\/invites\/([^/]+)\/(freeze|unfreeze)$/);
    if (thaw && method === 'POST') {
      const invite = invites.find(item => item.id === thaw[1]);
      if (invite && notFoundPaths.includes(thaw[1])) return jsonResponse(404, {error: {code: 'not_found', message: 'Invite not found'}});
      if (invite && forbiddenPaths.includes(thaw[1])) return jsonResponse(403, {error: {code: 'forbidden', message: 'Admins can only manage member invites'}});
      if (invite && invite.revoked) return jsonResponse(409, {error: {code: 'conflict', message: 'Revoked invites cannot be frozen or resumed'}});
      if (invite) invite.frozen = thaw[2] === 'freeze' ? 1 : 0;
      return jsonResponse(200, {});
    }
    throw new Error('unexpected request ' + method + ' ' + path);
  }
  return {api, calls};
}

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

async function mountMembers(options) {
  const {doc} = fakeDocument();
  const {api, calls} = makeApi(options);
  const assigned = [];
  await mount(doc, {fetcher: api, assign: (href) => assigned.push(href)});
  return {
    doc, calls, assigned,
    list: doc.getElementById('member-list'),
    inviteList: doc.getElementById('invite-list'),
    status: doc.getElementById('status'),
  };
}

function rowWithText(list, text) {
  return list.children.find(row => row.children.some(child => child.tagName === 'span' && child.textContent.includes(text)));
}

function rowButton(row, label) {
  return row.children.find(child => child.tagName === 'button' && child.textContent === label);
}

function confirmBox(row) {
  return row.children.find(child => child.tagName === 'span' && child.getAttribute('role') === 'alertdialog');
}

const ALICE = {user_id: 'u-me', username: 'alice', role: 'owner'};
const BOB = {user_id: 'u-bob', username: 'bob', role: 'member'};

test('removalPrompt and revokePrompt word the inline confirmation', async () => {
  const {removalPrompt, revokePrompt} = await import('../flybot_workspace/static/members/app.mjs');
  assert.deepEqual(removalPrompt({user_id: 'u-bob', username: 'bob', role: 'member'}, 'u-me'),
    {question: '移除 bob？', confirmLabel: '确认'});
  assert.deepEqual(removalPrompt({user_id: 'u-me', username: 'alice', role: 'admin'}, 'u-me'),
    {question: '退出工作区？', confirmLabel: '确认退出'});
  assert.deepEqual(removalPrompt({user_id: 'u-ghost', role: 'member'}, 'u-me'),
    {question: '移除此成员？', confirmLabel: '确认'});
  assert.deepEqual(revokePrompt({id: 'inv-1'}),
    {question: '撤销这条邀请？', confirmLabel: '确认撤销'});
});

test('removing a member asks inline before calling the API', async () => {
  const {doc, calls, list, status} = await mountMembers({members: [{...ALICE}, {...BOB}]});
  const before = calls.length;
  const row = rowWithText(list, 'bob');
  const remove = rowButton(row, '移除');

  doc.fire('click', {target: remove});

  const posts = calls.slice(before).filter(call => call.method === 'POST');
  assert.equal(posts.length, 0, 'the first click must not call the API');
  assert.equal(remove.hidden, true, 'the trigger yields its place to the confirmation');
  const box = confirmBox(row);
  assert.ok(box, 'an alertdialog appears in the same row');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  const question = box.children[0];
  assert.equal(question.textContent, '移除 bob？');
  assert.equal(box.getAttribute('aria-labelledby'), question.id);
  assert.equal(box.children[1].textContent, '取消');
  assert.equal(box.children[2].textContent, '确认');
  assert.equal(doc.activeElement, box.children[1], 'focus starts on cancel, not on the destructive action');
  assert.match(row.children[0].textContent, /bob/, 'bob is still listed');
  assert.equal(status.textContent, '', 'the status line is untouched');
});

test('cancelling the inline confirmation sends nothing and restores focus', async () => {
  const {doc, calls, list, status} = await mountMembers({members: [{...ALICE}, {...BOB}]});
  const before = calls.length;
  const row = rowWithText(list, 'bob');
  const remove = rowButton(row, '移除');
  doc.fire('click', {target: remove});
  const box = confirmBox(row);

  doc.fire('click', {target: box.children[1]});

  assert.equal(calls.length, before, 'cancel sends no request');
  assert.equal(remove.hidden, false, 'the trigger comes back');
  assert.equal(doc.activeElement, remove, 'focus returns to the trigger');
  assert.equal(confirmBox(row), undefined, 'the confirmation is gone');
  assert.equal(status.textContent, '');
  assert.match(row.children[0].textContent, /bob/);
});

test('Escape closes the inline confirmation without sending anything', async () => {
  const {doc, calls, list} = await mountMembers({members: [{...ALICE}, {...BOB}]});
  const before = calls.length;
  const row = rowWithText(list, 'bob');
  const remove = rowButton(row, '移除');
  doc.fire('click', {target: remove});

  doc.fire('keydown', {key: 'Escape'});

  assert.equal(calls.length, before, 'Escape sends no request');
  assert.equal(remove.hidden, false, 'the trigger comes back');
  assert.equal(doc.activeElement, remove, 'focus returns to the trigger');
  assert.equal(confirmBox(row), undefined, 'the confirmation is gone');
});

test('confirming the removal issues exactly one remove call and updates the list', async () => {
  const {doc, calls, list, status} = await mountMembers({members: [{...ALICE}, {...BOB}]});
  const row = rowWithText(list, 'bob');
  doc.fire('click', {target: rowButton(row, '移除')});
  const box = confirmBox(row);

  doc.fire('click', {target: box.children[2]});
  await settle();

  const removes = calls.filter(call => call.method === 'POST' && call.path === '/v1/workspaces/w1/members/u-bob/remove');
  assert.equal(removes.length, 1, 'confirm issues exactly one remove call');
  assert.equal(list.children.some(item => item.children.some(child => child.tagName === 'span' && child.textContent.includes('bob'))), false, 'bob leaves the list');
  assert.equal(status.textContent, '已移除。');
});

test('leaving names the self row and its confirmation', async () => {
  const {doc, calls, list, status} = await mountMembers({members: [
    {user_id: 'u-bob', username: 'bob', role: 'owner'},
    {...ALICE, role: 'admin'},
  ]});
  const row = rowWithText(list, 'alice');
  const leave = rowButton(row, '退出');
  assert.ok(leave, 'the self row says 退出');
  doc.fire('click', {target: leave});
  const box = confirmBox(row);
  assert.equal(box.children[0].textContent, '退出工作区？');
  assert.equal(box.children[2].textContent, '确认退出');

  doc.fire('click', {target: box.children[2]});
  await settle();

  const removes = calls.filter(call => call.method === 'POST' && call.path === '/v1/workspaces/w1/members/u-me/remove');
  assert.equal(removes.length, 1, 'leaving sends exactly one remove call');
  assert.equal(status.textContent, '已退出工作区。');
});

test('revoking an invite asks inline first', async () => {
  const {doc, calls, status} = await mountMembers({
    members: [{...ALICE}],
    invites: [{id: 'inv-1', workspace_id: 'w1', role: 'member', created: 1, expires: 2, created_by: 'u-me', max_uses: 1, use_count: 0, revoked: 0}],
  });
  const inviteRow = doc.getElementById('invite-list').children[0];
  const revoke = rowButton(inviteRow, '撤销');
  const before = calls.length;

  doc.fire('click', {target: revoke});
  assert.equal(calls.slice(before).filter(call => call.method === 'POST').length, 0, 'the first click must not call the API');
  const box = confirmBox(inviteRow);
  assert.equal(box.children[0].textContent, '撤销这条邀请？');
  assert.equal(box.children[2].textContent, '确认撤销');

  doc.fire('click', {target: box.children[2]});
  await settle();

  const revokes = calls.filter(call => call.method === 'POST' && call.path === '/v1/workspaces/w1/invites/inv-1/revoke');
  assert.equal(revokes.length, 1, 'confirm issues exactly one revoke call');
  assert.equal(status.textContent, '已撤销邀请。');
});

test('invite approval option and state labels', async () => {
  const {inviteState} = await import('../flybot_workspace/static/members/app.mjs');
  assert.equal(inviteState({revoked: 1, frozen: true}), '已撤销');
  assert.equal(inviteState({revoked: 0, frozen: true}), '已冻结');
  assert.equal(inviteState({revoked: 0, requires_approval: true}), '有效 · 需审批');
  assert.equal(inviteState({revoked: 0}), '有效');
  assert.equal(inviteState({expires: 40}, 40), '已过期');
  assert.equal(inviteState({expires: 50, max_uses: 1, use_count: 1}, 40), '使用次数已用完');
});

test('suspend permission mirrors the server rules', async () => {
  const {canSuspend} = await import('../flybot_workspace/static/members/app.mjs');
  assert.equal(canSuspend('owner', {user_id: 'a', role: 'admin'}, 'o'), true);
  assert.equal(canSuspend('admin', {user_id: 'a', role: 'admin'}, 'b'), false);
  assert.equal(canSuspend('admin', {user_id: 'm', role: 'member'}, 'b'), true);
  assert.equal(canSuspend('owner', {user_id: 'o', role: 'owner'}, 'o'), false);
  assert.equal(canSuspend('member', {user_id: 'm', role: 'member'}, 'x'), false);
});

test('team directory membership labels', async () => {
  const {directoryMembershipLabel} = await import('../flybot_workspace/static/members/app.mjs');
  assert.equal(directoryMembershipLabel({membership: 'member'}), '已加入');
  assert.equal(directoryMembershipLabel({membership: 'pending'}), '等待审批');
  assert.equal(directoryMembershipLabel({membership: null}), '');
});

function inviteFixture(overrides = {}) {
  return {id: 'inv-1', workspace_id: 'w1', role: 'member', created: 1, expires: 2,
    created_by: 'u-me', max_uses: 1, use_count: 0, revoked: 0, frozen: 0, ...overrides};
}

test('freezing an invite asks inline before calling the API and reports 已冻结', async () => {
  const {doc, calls, status} = await mountMembers({members: [{...ALICE}], invites: [inviteFixture()]});
  const inviteRow = doc.getElementById('invite-list').children[0];
  const freeze = rowButton(inviteRow, '冻结');
  assert.ok(freeze, 'a live invite offers 冻结, not 恢复');
  const before = calls.length;

  doc.fire('click', {target: freeze});

  assert.equal(calls.slice(before).filter(call => call.method === 'POST').length, 0,
    'the first click must not freeze the invite yet');
  const box = confirmBox(inviteRow);
  assert.ok(box, 'an inline confirmation appears in the invite row');
  assert.equal(box.children[0].textContent, '冻结这条邀请？');
  assert.equal(box.children[1].textContent, '取消');
  assert.equal(box.children[2].textContent, '确认冻结');
  assert.equal(doc.activeElement, box.children[1], 'focus starts on cancel, not on the state change');

  doc.fire('click', {target: box.children[2]});
  await settle();

  const freezes = calls.filter(call => call.method === 'POST' && call.path === '/v1/workspaces/w1/invites/inv-1/freeze');
  assert.equal(freezes.length, 1, 'confirm issues exactly one freeze call');
  assert.equal(status.textContent, '已冻结。');
  const detail = doc.getElementById('invite-list').children[0].children[0].textContent;
  assert.match(detail, /已冻结/, 'the invite row now reads 已冻结');
});

test('unfreezing a frozen invite asks inline and reports 已解冻', async () => {
  const {doc, calls, status} = await mountMembers({members: [{...ALICE}], invites: [inviteFixture({frozen: 1})]});
  const inviteRow = doc.getElementById('invite-list').children[0];
  const thaw = rowButton(inviteRow, '解冻');
  assert.ok(thaw, 'a frozen invite offers 解冻');

  doc.fire('click', {target: thaw});
  const box = confirmBox(inviteRow);
  assert.equal(box.children[0].textContent, '解冻这条邀请？');
  assert.equal(box.children[2].textContent, '确认解冻');

  doc.fire('click', {target: box.children[2]});
  await settle();

  const thaws = calls.filter(call => call.method === 'POST' && call.path === '/v1/workspaces/w1/invites/inv-1/unfreeze');
  assert.equal(thaws.length, 1, 'confirm issues exactly one unfreeze call');
  assert.equal(status.textContent, '已解冻。');
  const detail = doc.getElementById('invite-list').children[0].children[0].textContent;
  assert.doesNotMatch(detail, /已冻结/, 'the invite row is no longer frozen');
});

test('a refused freeze shows the Chinese reason instead of the server sentence', async () => {
  const {doc, status} = await mountMembers({
    members: [{...ALICE}],
    invites: [inviteFixture()],
    forbiddenPaths: ['inv-1'],
  });
  const inviteRow = doc.getElementById('invite-list').children[0];
  doc.fire('click', {target: rowButton(inviteRow, '冻结')});
  doc.fire('click', {target: confirmBox(inviteRow).children[2]});
  await settle();

  assert.equal(status.textContent, '只有工作区所有者或管理员可以冻结邀请。');
  assert.doesNotMatch(status.textContent, /Admins can only manage/);
});


test('other members get a working 发消息 button that opens the existing DM route', async () => {
  const {doc, calls, list, assigned} = await mountMembers({members: [{...ALICE}, {...BOB}]});
  const selfRow = rowWithText(list, 'alice');
  const bobRow = rowWithText(list, 'bob');
  assert.equal(rowButton(selfRow, '发消息'), undefined, 'the current user has no self-message button');
  const send = rowButton(bobRow, '发消息');
  assert.ok(send, 'another member can be messaged');
  doc.fire('click', {target: send});
  await settle();
  const created = calls.filter((call) => call.method === 'POST' && call.path === '/v1/workspaces/w1/social/conversations');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body, {kind: 'dm', member_ids: ['u-bob']});
  assert.match(created[0].headers['Idempotency-Key'] || '', /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(assigned, ['/chat#workspace=w1&social=c-dm-1']);
});

test('发消息 reports an error when the conversation cannot be opened', async () => {
  const {doc, list, assigned, status} = await mountMembers({members: [{...ALICE}, {...BOB}], failSocial: true});
  doc.fire('click', {target: rowButton(rowWithText(list, 'bob'), '发消息')});
  await settle();
  assert.equal(assigned.length, 0);
  assert.equal(status.textContent, '无法创建会话');
});
test('invitation links are fragment-only and belong to the current instance', () => {
  const token = 'abc_123-next-test'.repeat(2);
  const origin = 'https://workspace.test';
  const link = teamInviteUrl(token, origin);
  assert.equal(link, origin + '/login#team-invite=' + token);
  assert.equal(teamInviteCode(link, origin), token);
  assert.equal(teamInviteCode('  ' + token + ' ', origin), token);
  assert.equal(teamInviteCode(link, 'https://other.test'), '');
  assert.equal(teamInviteCode(origin + '/login?source=unsafe#team-invite=' + token, origin), '');
  assert.equal(teamInviteFromHash('#team-invite=' + token + '&redirect=/chat'), '');
});

const teamA = 'a'.repeat(32);
const teamB = 'b'.repeat(32);
const self = {id: 'u-me', username: 'alice'};
const workspaceListing = [{id: teamA, name: '团队甲'}, {id: teamB, name: '团队乙'}];

function setView(doc, hash = '') {
  doc.defaultView = {
    location: new URL('https://example.test/members' + hash),
    history: {replaceState(_state, _title, next) { doc.defaultView.location = new URL(next, doc.defaultView.location); }},
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  };
}

test('an exact members fragment selects only the accessible team and inaccessible links do not fall back', async t => {
  assert.equal(workspaceFromHash('#workspace=' + teamB), teamB);
  assert.equal(workspaceFromHash('#workspace=' + teamB + '&workspace=' + teamA), '');
  assert.equal(workspaceFromHash('#team-invite=sample'), null);
  for (const id of [teamB, 'f'.repeat(32)]) await t.test(id[0], async () => {
    const {doc, elements} = fakeDocument();
    setView(doc, '#workspace=' + id);
    const rosterReads = [];
    await mount(doc, {fetcher: async path => {
      if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
      if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {items: workspaceListing});
      if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
      if (path.endsWith('/members')) {
        rosterReads.push(path);
        return jsonResponse(200, {items: [{...ALICE, role: 'member'}]});
      }
      throw new Error(path);
    }});
    if (id === teamB) {
      assert.equal(elements.get('workspace').value, teamB);
      assert.deepEqual(rosterReads, [`/v1/workspaces/${teamB}/members`]);
    } else {
      assert.equal(elements.get('workspace').value, '');
      assert.equal(elements.get('member-workspace-field').hidden, false);
      assert.match(elements.get('status').textContent, /无法打开此工作区/);
      assert.deepEqual(rosterReads, []);
    }
  });
});

test('same-tab workspace fragments change the roster and hide a foreign team before validation', async () => {
  const {doc, elements} = fakeDocument();
  setView(doc, '#workspace=' + teamA);
  const rosterReads = [];
  const refreshed = Promise.withResolvers();
  let hold = false;
  await mount(doc, {fetcher: async path => {
    if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
    if (path === '/v1/workspaces?limit=100') {
      if (hold) await refreshed.promise;
      return jsonResponse(200, {items: workspaceListing});
    }
    if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
    if (path.endsWith('/members')) {
      rosterReads.push(path);
      return jsonResponse(200, {items: [{...ALICE, role: 'member'}]});
    }
    throw new Error(path);
  }});
  const view = doc.defaultView;
  view.location.hash = '#workspace=' + teamB;
  await view.handlers.hashchange();
  assert.equal(elements.get('workspace-chat').getAttribute('href'), '/chat#workspace=' + teamB);

  hold = true;
  view.location.hash = '#workspace=' + 'f'.repeat(32);
  const change = view.handlers.hashchange();
  assert.equal(elements.get('workspace-chat').hidden, true);
  assert.equal(elements.get('member-list').children.length, 0);
  refreshed.resolve();
  await change;
  assert.equal(elements.get('workspace').value, '');
  assert.match(elements.get('status').textContent, /无法打开此工作区/);
  assert.deepEqual(rosterReads, [`/v1/workspaces/${teamA}/members`, `/v1/workspaces/${teamB}/members`]);
});

test('joining pins the verified team, including after a lost receipt, without overriding a newer workspace switch', async t => {
  const invited = 'c'.repeat(32);
  const token = 'browser-invite-with-access';
  for (const lostReceipt of [false, true]) for (const manual of [false, true]) await t.test(
    `${lostReceipt ? 'lost receipt' : 'successful receipt'} with ${manual ? 'manual switch' : 'no switch'}`, async () => {
    const {doc, elements} = fakeDocument();
    setView(doc);
    const accept = Promise.withResolvers();
    const issued = Promise.withResolvers();
    let joined = false;
    let writes = 0;
    let reads = 0;
    const original = globalThis.FormData;
    globalThis.FormData = class { get(name) { return name === 'token' ? token : null; } };
    try {
      await mount(doc, {fetcher: async path => {
        if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
        if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {
          items: joined ? [...workspaceListing, {id: invited, name:'新加入的团队'}] : workspaceListing,
        });
        if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
        if (path === '/v1/invites/preview') {
          reads++;
          return jsonResponse(200, {invitation: {team_name: '新加入的团队', role:'member',
            ...(joined ? {membership:'member', workspace_id:invited} : {})}});
        }
        if (path === '/v1/invites/accept') {
          writes++;
          issued.resolve();
          await accept.promise;
          joined = true;
          return lostReceipt ? jsonResponse(503, {}) : jsonResponse(200, {workspace: {id: invited}});
        }
        if (path.endsWith('/members')) return jsonResponse(200, {items: [{...ALICE, role: 'member'}]});
        throw new Error(path);
      }});
      const form = elements.get('accept-form');
      const submit = () => form.handlers.submit[0]({preventDefault() {}, currentTarget: form});
      await submit();
      const response = submit();
      await issued.promise;
      if (manual) {
        const select = elements.get('workspace');
        select.value = teamB;
        await select.handlers.change[0]();
      }
      accept.resolve();
      await response;
      const expected = manual ? teamB : invited;
      assert.equal(elements.get('workspace').value, expected);
      assert.equal(doc.defaultView.location.hash, '#workspace=' + expected);
      assert.equal(elements.get('workspace-chat').hidden, false);
      assert.equal(elements.get('workspace-chat').getAttribute('href'), '/chat#workspace=' + expected);
      assert.equal(writes, 1);
      assert.equal(reads, lostReceipt ? 2 : 1);
    } finally {
      globalThis.FormData = original;
    }
  });
});

test('applicant refresh reads the durable decision and opens only an accessible approved team', async () => {
  const {doc, elements} = fakeDocument();
  setView(doc);
  const pending = {id: 'otjr_pending', workspace_id: teamB, team_name: '团队乙', role: 'member', status: 'pending'};
  const rejected = {id: 'otjr_rejected', workspace_id: 'f'.repeat(32), team_name: '未加入的团队', role: 'admin', status: 'rejected'};
  let approved = false;
  await mount(doc, {fetcher: async path => {
    if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
    if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {items: approved ? workspaceListing : workspaceListing.slice(0, 1)});
    if (path === '/v1/join-requests') return jsonResponse(200, {items: [approved ? {...pending, status: 'approved'} : pending, rejected]});
    if (path.endsWith('/members')) return jsonResponse(200, {items: [{...ALICE, role: 'member'}]});
    throw new Error(path);
  }});
  const rows = elements.get('my-join-request-list');
  assert.equal(rowWithText(rows, '团队乙').children[1].textContent, '等待审批');
  assert.equal(rowWithText(rows, '未加入的团队').children[1].textContent, '未获批准');
  assert.equal(rowButton(rowWithText(rows, '团队乙'), '打开工作区'), undefined);
  approved = true;
  await elements.get('refresh-my-join-requests').handlers.click[0]();
  const accepted = rowWithText(rows, '团队乙');
  assert.equal(accepted.children[1].textContent, '已批准');
  assert.equal(rowButton(rowWithText(rows, '未加入的团队'), '打开工作区'), undefined);
  await rowButton(accepted, '打开工作区').handlers.click[0]();
  assert.equal(elements.get('workspace').value, teamB);
  assert.equal(doc.defaultView.location.hash, '#workspace=' + teamB);
  assert.equal(doc.activeElement, elements.get('members-heading'));
});

test('late invite and approval reads cannot populate another workspace', async () => {
  const {doc, elements} = fakeDocument();
  setView(doc, '#workspace=' + teamA);
  const invites = Promise.withResolvers();
  const queue = Promise.withResolvers();
  const m = mount(doc, {fetcher: async path => {
    if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
    if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {items: workspaceListing});
    if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
    if (path === `/v1/workspaces/${teamA}/members`) return jsonResponse(200, {items: [ALICE]});
    if (path === `/v1/workspaces/${teamA}/invites`) return invites.promise;
    if (path === `/v1/workspaces/${teamA}/join-requests`) return queue.promise;
    if (path === `/v1/workspaces/${teamA}/directory`) return jsonResponse(200, {listing: {listed: false}});
    if (path === `/v1/workspaces/${teamB}/members`) return jsonResponse(200, {items: [{...ALICE, role: 'member'}, BOB]});
    throw new Error(path);
  }});
  await settle();
  const picker = elements.get('workspace');
  assert.equal(picker.value, teamA);
  picker.value = teamB;
  await picker.handlers.change[0]();
  invites.resolve(jsonResponse(200, {items: [{id: 'otiv_old', role: 'member'}]}));
  queue.resolve(jsonResponse(200, {items: [{id: 'otjr_old', role: 'member', username: 'old-team-applicant'}]}));
  await m;
  assert.equal(picker.value, teamB);
  assert.equal(elements.get('role-note').textContent, '当前角色：成员');
  assert.ok(rowWithText(elements.get('member-list'), 'bob'));
  assert.equal(elements.get('invites-panel').hidden, true);
  assert.equal(elements.get('invite-list').children.length, 0);
  assert.equal(elements.get('join-requests-panel').hidden, true);
  assert.equal(elements.get('join-request-list').children.length, 0);
});

test('returning to Members reconciles role changes and removes a workspace after access is lost', async () => {
  const {doc, elements} = fakeDocument();
  setView(doc, '#workspace=' + teamA);
  let role = 'admin';
  const selfRow = () => ({...ALICE, role});
  let sessionReads = 0;
  let rosterReads = 0;
  await mount(doc, {fetcher: async path => {
    if (path === '/v1/auth/session') {
      sessionReads += 1;
      return jsonResponse(200, {user:self});
    }
    if (path === '/v1/workspaces?limit=100') {
      return jsonResponse(200, {items:role ? workspaceListing : [workspaceListing[1]]});
    }
    if (path === `/v1/workspaces/${teamA}/members`) {
      rosterReads += 1;
      return role ? jsonResponse(200, {items:[selfRow(), BOB]})
        : jsonResponse(409, {error:{code:'membership_migration_required'}});
    }
    if (path === `/v1/workspaces/${teamA}/invites`) return jsonResponse(200, {items:[{id:'invite-test', role:'member'}]});
    return jsonResponse(200, {items:[]});
  }});
  assert.equal(elements.get('invite-form').hidden, false);
  const adminRow = elements.get('member-list').children[0];
  const inviteRow = elements.get('invite-list').children[0];

  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  await settle();
  assert.equal(rosterReads, 1);

  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  doc.defaultView.handlers.pageshow({persisted:true});
  await settle();
  assert.equal(sessionReads, 2);
  assert.equal(rosterReads, 2);
  assert.equal(elements.get('member-list').children[0], adminRow);
  assert.equal(elements.get('invite-list').children[0], inviteRow);

  role = 'member';
  doc.fire('visibilitychange');
  await settle();
  assert.equal(elements.get('role-note').textContent, '当前角色：成员');
  assert.equal(elements.get('invite-form').hidden, true);
  assert.equal(elements.get('invite-list').children.length, 0);
  assert.equal(elements.get('workspace-chat').getAttribute('href'), '/chat#workspace=' + teamA);

  role = null;
  doc.defaultView.handlers.pageshow({persisted:true});
  await settle(40);
  assert.equal(elements.get('workspace').value, '');
  assert.equal(doc.defaultView.location.hash, '#workspace=' + teamA);
  assert.equal(elements.get('member-list').children.length, 0);
  assert.equal(elements.get('workspace-chat').hidden, true);

  role = 'member';
  doc.fire('visibilitychange');
  await settle(40);
  assert.equal(elements.get('workspace').value, teamA);
  assert.equal(elements.get('role-note').textContent, '当前角色：成员');
  assert.equal(elements.get('workspace-chat').getAttribute('href'), '/chat#workspace=' + teamA);
});

test('adding a member sends once and keeps its success and the other workspace draft separate', async () => {
  const {doc,elements} = fakeDocument();
  setView(doc, '#workspace=' + teamA);
  const form = doc.getElementById('add-form');
  const username = form.elements.username = {value:''};
  form.reset = () => { username.value = ''; form.elements.role.value = 'member'; };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor(node) { this.node = node; } get(name) { return this.node.elements[name]?.value; } };
  const pending = Promise.withResolvers();
  const writes = [];
  try {
    await mount(doc,{fetcher: async (path,{method,body}) => {
      if (path === '/v1/auth/session') return jsonResponse(200,{user:self});
      if (path === '/v1/workspaces?limit=100') return jsonResponse(200,{items:workspaceListing});
      if (path === `/v1/workspaces/${teamA}/members` && method === 'POST') {
        writes.push(JSON.parse(body));
        return pending.promise;
      }
      if (path.endsWith('/members')) return jsonResponse(200,{items:[ALICE]});
      if (path.endsWith('/directory')) return jsonResponse(200,{listing:{listed:false}});
      return jsonResponse(200,{items:[]});
    }});
    const submit = () => form.handlers.submit[0]({preventDefault() {}});
    username.value = 'target-A';
    const sending = submit();
    await submit();
    assert.deepEqual(writes,[{username:'target-A',role:'member'}]);
    assert.equal(elements.get('add-member-submit').disabled,true);
    const picker = elements.get('workspace');
    picker.value = teamB;
    await picker.handlers.change[0]();
    assert.equal(username.value,'');
    assert.equal(elements.get('add-member-submit').disabled,false);
    username.value = 'target-B draft';
    form.handlers.input[0]();
    pending.resolve(jsonResponse(201,{}));
    await sending;
    assert.equal(username.value,'target-B draft');
    assert.equal(elements.get('add-member-status').hidden,true);
    picker.value = teamA;
    await picker.handlers.change[0]();
    assert.equal(username.value,'');
    assert.equal(elements.get('add-member-status').textContent,'已添加成员。');
    picker.value = teamB;
    await picker.handlers.change[0]();
    assert.equal(username.value,'target-B draft');
  } finally {
    pending.resolve(jsonResponse(500,{}));
    globalThis.FormData = original;
  }
});

test('admins cannot approve administrator applications and one pending member decision sends one request', async () => {
  const {doc, elements} = fakeDocument();
  const pending = [{id: 'otjr_admin', role: 'admin', username: 'admin-applicant'},
    {id: 'otjr_member', role: 'member', username: 'member-applicant'}];
  const decision = Promise.withResolvers();
  const sent = [];
  await mount(doc, {fetcher: async (path, {method}) => {
    if (path === '/v1/auth/session') return jsonResponse(200, {user: self});
    if (path === '/v1/workspaces?limit=100') return jsonResponse(200, {items: workspaceListing});
    if (path === '/v1/join-requests') return jsonResponse(200, {items: []});
    if (path.endsWith('/members')) return jsonResponse(200, {items: [{...ALICE, role: 'admin'}]});
    if (path.endsWith('/invites')) return jsonResponse(200, {items: [{id: 'otinv_admin', role: 'admin'}]});
    if (path.endsWith('/join-requests')) return jsonResponse(200, {items: pending});
    if (method === 'POST') { sent.push(path); return decision.promise; }
    throw new Error(path);
  }});
  const queue = elements.get('join-request-list');
  const admin = rowWithText(queue, 'admin-applicant');
  const member = rowWithText(queue, 'member-applicant');
  assert.equal(rowButton(admin, '批准'), undefined);
  assert.ok(rowButton(admin, '拒绝'));
  assert.equal(rowButton(elements.get('invite-list').children[0], '撤销'), undefined);
  const approve = rowButton(member, '批准');
  const reject = rowButton(member, '拒绝');
  const first = approve.handlers.click[0]();
  assert.equal(reject.disabled, true);
  await reject.handlers.click[0]();
  pending.pop();
  decision.resolve(jsonResponse(200, {}));
  await first;
  assert.deepEqual(sent, [`/v1/workspaces/${teamA}/join-requests/otjr_member/approve`]);
  assert.equal(rowWithText(queue, 'member-applicant'), undefined);
  assert.equal(elements.get('status').textContent, '已批准，对方已加入。');
});

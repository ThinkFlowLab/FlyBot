import assert from 'node:assert/strict';
import test from 'node:test';
import { mountGroupManagement } from '../flybot_workspace/static/chat/group-management.mjs';

const workspace = 'a'.repeat(32);
const group = 'b'.repeat(32);
const owner = {user_id: 'owner-account', group_member_id: 'owner-social', username: 'Owner'};
const member = {user_id: 'member-account', group_member_id: 'member-social', username: 'Member'};

function viewOf({actor = owner, id = group, revision = 4, management = {}} = {}) {
  return {owner: actor.user_id, workspace, conversation: {
    id, workspace_id: workspace, kind: 'group', title: 'Project work', members: [owner, member], group_management: {
      revision, owner_id: owner.group_member_id, active_member_ids: [owner.group_member_id, member.group_member_id],
      can_rename: actor === owner, can_remove: actor === owner, can_transfer: actor === owner,
      can_leave: actor !== owner, leave_requires_transfer: actor === owner, ...management,
    },
  }};
}

class Element {
  children = [];
  dataset = {};
  classList = {add() {}, toggle() {}};
  events = new Map();
  hidden = false;
  disabled = false;
  maxLength = 80;
  addEventListener(name, listener) { this.events.set(name, listener); }
  fire(name) { return this.events.get(name)?.({preventDefault() {}}); }
  click() { return this.fire('click'); }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return this.note; }
  setAttribute() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() {}
  select() {}
}

function ui(context, {request, onChanged, onLeft, onRefresh} = {}) {
  const nodes = new Map();
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const control = name => getElementById(`group-management-${name}`);
  const controller = mountGroupManagement({getElementById, createElement: () => new Element(), documentElement: {lang: 'en'}},
    {context, request, onChanged, onLeft, onRefresh});
  const memberButton = person => controller.decorateMember(new Element(), person).children[0];
  return {control, controller, memberButton};
}

test('group owner must transfer first, with explicit confirmation and authoritative member identity', async () => {
  let current = viewOf();
  const writes = [];
  const {control, memberButton} = ui(() => current, {
    request: async (method, path, body) => {
      writes.push({method, path, body});
      return {status: 200, body: {conversation: viewOf({revision: 5, management: {owner_id: member.group_member_id}}).conversation}};
    },
    onChanged: conversation => { current = {...current, conversation}; },
  });
  control('leave').click();
  assert.equal(control('choose-owner').hidden, false);
  assert.equal(control('confirm').hidden, true);
  await control('form').fire('submit');
  assert.deepEqual(writes, []);
  control('choose-owner').click();
  assert.equal(memberButton(owner), undefined);
  memberButton(member).click();
  control('transfer').click();
  assert.deepEqual(writes, []);
  await control('form').fire('submit');
  assert.deepEqual(writes, [{method: 'POST', path: `/v1/workspaces/${workspace}/social/conversations/${group}/management`,
    body: {action: 'transfer', revision: 4, member_id: member.group_member_id}}]);
  assert.equal(current.conversation.group_management.owner_id, member.group_member_id);
});

test('an active team manager can recover ownership with themselves when the owner is inactive', () => {
  const current = viewOf({actor: member, management: {owner_inactive: true, can_transfer: true, active_member_ids: [member.group_member_id]}});
  const {control, memberButton} = ui(() => current);
  memberButton(member).click();
  assert.equal(control('transfer').hidden, false);
  assert.equal(control('transfer').textContent, 'Set new owner');
  assert.equal(control('remove').hidden, true);
});

test('read-back after a version conflict preserves the draft and never retries implicitly', async () => {
  let current = viewOf();
  const writes = [];
  const {control} = ui(() => current, {
    request: async (_method, _path, body) => { writes.push(body); return {status: 409, body: {}}; },
    onRefresh: async () => { current = viewOf({revision: 5}); return true; },
  });
  control('rename').click();
  control('name').value = 'Revised group name';
  await control('form').fire('submit');
  assert.equal(control('confirm').disabled, true);
  assert.equal(control('refresh').hidden, false);
  await control('refresh').click();
  assert.equal(control('name').value, 'Revised group name');
  assert.equal(control('confirm').disabled, false);
  assert.equal(writes.length, 1);
  await control('form').fire('submit');
  assert.deepEqual(writes.map(body => [body.revision, body.title]), [[4, 'Revised group name'], [5, 'Revised group name']]);
});

test('a successful late leave receipt cannot close or change a different group', async () => {
  let current = viewOf({actor: member});
  let finish;
  const {control, controller} = ui(() => current, {
    request: () => new Promise(resolve => { finish = resolve; }),
    onLeft: () => assert.fail('late response changed a different group'),
  });
  control('leave').click();
  const pending = control('form').fire('submit');
  current = viewOf({actor: member, id: 'c'.repeat(32)});
  controller.sync();
  assert.equal(control('dialog').open, false);
  finish({status: 200, body: {left: true, conversation_id: group}});
  await pending;
});

test('reply policy preserves exact owner qualification through stale revision and hides edits from members', async () => {
  const agents = [
    {owner_id:'one', id:'same', name:'Writer', owner_name:'First owner', mine:true},
    {owner_id:'two', id:'same', name:'Writer', owner_name:'Second owner'},
  ];
  const routing = {mode:'shared', policy:{mode:'default'}, can_edit:true};
  let current = viewOf();
  Object.assign(current.conversation, {agent_members:agents, group_agent_routing:routing});
  const writes = [];
  const {control, controller} = ui(() => current, {
    request: async (_method, _path, body) => {
      writes.push(body);
      if (writes.length === 1) return {status:409, body:{error:{code:'group_management_conflict'}}};
      return {status:200, body:{conversation:{...current.conversation,
        group_management:{...current.conversation.group_management, revision:6},
        group_agent_routing:{...routing, policy:{mode:body.mode,lead:body.lead}}}}};
    },
    onRefresh: async () => {
      current.conversation.group_management.revision = 5;
      return true;
    },
    onChanged: conversation => { current = {...current, conversation}; },
  });
  controller.sync();
  assert.equal(control('reply-policy').hidden, false);
  control('reply-policy').click();
  assert.equal(control('reply-mode').value, 'default');
  control('reply-mode').value = 'lead';
  control('reply-mode').fire('change');
  assert.equal(control('confirm').disabled, true);
  const lead = control('reply-lead');
  assert.deepEqual(lead.children.map(option => option.value), ['', '["one","same"]', '["two","same"]']);
  lead.value = lead.children[2].value;
  lead.fire('change');
  assert.equal(control('confirm').disabled, false);
  await control('form').fire('submit');
  assert.equal(control('confirm').disabled, true);
  assert.equal(control('refresh').hidden, false);
  await control('refresh').click();
  assert.equal(control('reply-mode').value, 'lead');
  assert.equal(lead.value, '["two","same"]');
  assert.equal(writes.length, 1);
  await control('form').fire('submit');
  assert.deepEqual(writes, [4,5].map(revision => ({action:'reply_policy', revision, mode:'lead', lead:{owner_id:'two',agent_id:'same'}})));
  assert.equal(current.conversation.group_agent_routing.policy.lead.owner_id, 'two');
  assert.equal(control('dialog').open, false);
  current = viewOf({actor:member});
  current.conversation.group_agent_routing = {...routing, can_edit:false};
  controller.sync();
  assert.equal(control('reply-policy').hidden, true);
  control('reply-policy').click();
  assert.equal(control('dialog').open, false);
});

test('a stale preferred agent is never replaced by a matching agent from another owner', async () => {
  const original = {owner_id:'owner', id:'same', name:'Writer', mine:true};
  const teammate = {owner_id:'peer', id:'same', name:'Writer', owner_name:'Peer'};
  let current = viewOf();
  Object.assign(current.conversation, {agent_members:[original, teammate],
    group_agent_routing:{mode:'shared', can_edit:true, policy:{mode:'lead', lead:{owner_id:'owner',agent_id:'same'}}}});
  const writes = [];
  const {control} = ui(() => current, {
    request: async (_method,_path,body) => {
      writes.push(body);
      return {status:409, body:{error:{code:'group_reply_lead_unavailable'}}};
    },
    onRefresh: async () => {
      current.conversation.agent_members = [teammate];
      current.conversation.group_management.revision = 5;
      current.conversation.group_agent_routing.policy.lead_unavailable = true;
      return true;
    },
  });
  control('reply-policy').click();
  await control('form').fire('submit');
  assert.match(control('status').textContent, /selected agent is unavailable/);
  await control('refresh').click();
  assert.equal(control('reply-mode').value, 'lead');
  assert.equal(control('reply-lead').value, '');
  assert.match(control('reply-lead-note').textContent, /selection is unavailable/);
  assert.equal(control('confirm').disabled, true);
  await control('form').fire('submit');
  assert.equal(writes.length, 1);
});

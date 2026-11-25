import { conversationChatHref } from '../shell/thumb.mjs';
import { teamInviteCode, teamInviteFromHash, teamInviteHash, teamInviteUrl } from '../shell/team-invite-link.mjs';
import {groupInviteFromHash, groupInviteHash} from '../shell/group-invite-link.mjs';
import {showGroupInvitation} from './group-invite.mjs';

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};

export function readAddMember(form) {
  const data = new FormData(form);
  const role = data.get('role') === 'admin' ? 'admin' : 'member';
  return {username: (data.get('username') || '').trim(), role};
}

export function readInvite(form) {
  const data = new FormData(form);
  const days = Number(data.get('expires_days') || 7);
  const uses = Number(data.get('max_uses') || 1);
  return {
    role: data.get('role') === 'admin' ? 'admin' : 'member',
    expires_in: Math.round(days * 86400),
    max_uses: uses,
    ...(data.get('requires_approval') ? {requires_approval: true} : {}),
  };
}

export function directoryMembershipLabel(team) {
  if (team.membership === 'member') return '已加入';
  if (team.membership === 'pending') return '等待审批';
  if (team.membership === 'suspended') return '已暂停';
  return '';
}

export function workspaceFromHash(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('workspace')) return null;
  return /^#?workspace=([a-f0-9]{32})$/.exec(hash)?.[1] || '';
}

const WORKSPACE_ID = /^[a-f0-9]{32}$/;
const PENDING_INVITATION = 'flybotWorkspacePendingTeamInvite';
const JOIN_STATES = {pending: '等待审批', approved: '已批准', rejected: '未获批准'};
const unavailable = {status: 0, body: {}};

// self may be a platform user object or just an id. After the page is served by
// this user's DS-Bot, member.user_id may be a Bot Social owner id or handle.
export function samePerson(item, self) {
  if (!item || self == null || self === '') return false;
  const user = typeof self === 'object' ? self : {id: self};
  if (item.user_id && user.id && item.user_id === user.id) return true;
  const strip = (value) => String(value || '').toLowerCase().replace(/^@/, '').replace(/\.home$/, '');
  const mine = new Set([user.id, user.username, user.handle].filter(Boolean).map(strip).filter(Boolean));
  if (!mine.size) return false;
  return [item.user_id, item.username, item.handle].some((value) => value && mine.has(strip(value)));
}

export function canSuspend(actorRole, item, selfId) {
  if (!item || item.role === 'owner' || samePerson(item, selfId)) return false;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && item.role === 'member';
}

export function inviteState(item, now = Math.floor(Date.now() / 1000)) {
  if (item.revoked) return '已撤销';
  if (item.frozen) return '已冻结';
  if (item.expires && item.expires <= now) return '已过期';
  if (item.max_uses && item.use_count >= item.max_uses) return '使用次数已用完';
  return item.requires_approval ? '有效 · 需审批' : '有效';
}

export function readAccept(form) {
  const data = new FormData(form);
  return {token: (data.get('token') || '').trim()};
}

export function canAdd(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function addableRoles(actor) {
  if (actor === 'owner') return ['admin', 'member'];
  if (actor === 'admin') return ['member'];
  return [];
}

export function canChange(actor) {
  return actor === 'owner';
}

function canTransferOwnership(actor, item, self) {
  return actor === 'owner' && (item?.role === 'admin' || item?.role === 'member') && !item.suspended && !samePerson(item, self);
}

export function canInvite(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function canRemove(actor, target, selfId) {
  if (!target || target.role === 'owner') return false;
  if (samePerson(target, selfId)) return actor === 'admin' || actor === 'member';
  if (actor === 'owner') return target.role === 'admin' || target.role === 'member';
  if (actor === 'admin') return target.role === 'member';
  return false;
}

export function removalPrompt(item, selfId) {
  if (!item) return {question: '', confirmLabel: '确认'};
  if (samePerson(item, selfId)) return {question: '退出工作区？', confirmLabel: '确认退出'};
  const name = item.username || '';
  return {question: name ? `移除 ${name}？` : '移除此成员？', confirmLabel: '确认'};
}

export function revokePrompt() {
  return {question: '撤销这条邀请？', confirmLabel: '确认撤销'};
}

// Freezing pauses an invite without revoking it, so it gets the same inline
// confirmation as revoking instead of firing on one click.
export function freezePrompt(item) {
  return item && item.frozen
    ? {question: '解冻这条邀请？', confirmLabel: '确认解冻'}
    : {question: '冻结这条邀请？', confirmLabel: '确认冻结'};
}

// The server answers these codes with English sentences; the page says the
// same thing in the language the rest of the row uses.
export function inviteFailure(error, action) {
  const code = error && error.code;
  if (code === 'forbidden') {
    return action === 'revoke'
      ? '只有工作区所有者或管理员可以撤销邀请。'
      : '只有工作区所有者或管理员可以冻结邀请。';
  }
  if (code === 'conflict') return '已撤销的邀请不能冻结或解冻。';
  if (code === 'not_found') return '找不到这条邀请，可能已被撤销或删除。';
  return (error && error.message) || '无法更新邀请。';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function accessMayHaveChanged(result) {
  return [401, 403, 404].includes(result.status) ||
    (result.status === 409 && result.body.error?.code === 'membership_migration_required');
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), assign} = {}) {
  const goTo = assign || ((href) => globalThis.location.assign(href));
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const workspaceChat = document.getElementById('workspace-chat');
  const view = document.defaultView;
  const receiveForm = document.getElementById('accept-form');
  const receiveParent = receiveForm.parentNode;
  const receiveNext = receiveForm.nextSibling;
  const receiveToken = document.getElementById('receive-invite-token');
  const receiveField = document.getElementById('receive-invite-field');
  const receivePreview = document.getElementById('invitation-preview');
  const receiveButton = document.getElementById('confirm-invite');
  const addForm = document.getElementById('add-form');
  const inviteForm = document.getElementById('invite-form');
  const issuedBox = document.getElementById('issued-token');
  const issuedLink = document.getElementById('issued-invite-link');
  const memberWrite = {form:addForm, fields:['username','role'], button:document.getElementById('add-member-submit'),
    feedback:document.getElementById('add-member-status'), pending:'正在添加成员…'};
  const inviteWrite = {form:inviteForm, fields:['role','expires_days','max_uses','requires_approval'],
    button:document.getElementById('create-invite-submit'), feedback:document.getElementById('create-invite-status'), pending:'正在生成邀请…'};
  let linkedWorkspace = workspaceFromHash(view?.location?.hash);
  let previewed = '';
  let inviteRequest = 0;
  let accepting = null;
  let currentUser = null;
  let actor = null;
  let workspaces = [];
  let workspaceEpoch = 0;
  let workspaceSelection = 0;
  let rosterRead = 0;
  let queueRead = 0;
  let loadRead = 0;
  let workspaceOptionsRead = 0;
  let personalRequestsRead = 0;
  let directoryRead = 0;
  let myRequests = [];
  let myRequestsReady = false;
  let joinItems = [];
  const busyTransfers = new Set();
  const transferKey = scope => `${scope.viewer?.id}/${scope.id}`;
  const busyJoins = new Set();
  const busyDirectoryJoins = new Set();
  const workspaceWrites = new Map();
  let visibleWrites = null;
  let accessRefresh = null;
  let directoryLoaded = false;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    try {
      const response = await fetcher(path, {
        method, headers, signal, credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const parsed = await response.json().catch(() => null);
      return {status: response.status, body: parsed || {}};
    } catch {
      return unavailable;
    }
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function workspaceScope() {
    return {id: workspaceId(), viewer: currentUser, epoch: workspaceEpoch};
  }

  function inWorkspace(scope) {
    return scope.id === workspaceId() && scope.viewer === currentUser && scope.epoch === workspaceEpoch;
  }

  async function refreshWorkspaceAccess(scope = workspaceScope(), force = false) {
    const requested = linkedWorkspace;
    if ((!scope.id && !WORKSPACE_ID.test(requested)) || !scope.viewer || mainPanel.hidden || !inWorkspace(scope) ||
        (!force && accessRefresh && inWorkspace(accessRefresh))) return;
    accessRefresh = scope;
    try {
      const session = await request('GET', '/v1/auth/session', undefined, undefined, AbortSignal.timeout(8000));
      if (!inWorkspace(scope) || accessRefresh !== scope) return;
      if (session.status === 401 || (session.status === 200 && session.body.user?.id !== scope.viewer.id)) {
        await load();
      } else if (session.status === 200) {
        if (scope.id) await loadWorkspace({revalidate: true});
        else await refreshWorkspaces({preferred:requested, explicit:true});
      }
    } finally {
      if (accessRefresh === scope) accessRefresh = null;
    }
  }

  function paintWorkspaceWrites() {
    for (const [controls, state] of [[memberWrite,visibleWrites?.member],[inviteWrite,visibleWrites?.invite]]) {
      controls.button.disabled = Boolean(state?.busy);
      for (const name of controls.fields) {
        const field = controls.form.elements[name];
        if (field) field.disabled = controls.button.disabled;
      }
      controls.button.setAttribute('aria-busy', String(Boolean(state?.busy)));
      controls.feedback.textContent = state?.busy ? controls.pending : state?.message || '';
      controls.feedback.hidden = !controls.feedback.textContent;
      controls.feedback.dataset.kind = state?.kind || '';
    }
    const issued = visibleWrites?.issued;
    const usable = canInvite(actor) && issued && addableRoles(actor).includes(issued.invite.role) &&
      inviteState(issued.invite).startsWith('有效');
    issuedBox.hidden = !usable;
    const url = usable ? issued.url : '';
    if (issuedLink.value !== url) issuedLink.value = url;
  }

  function restoreWorkspaceWrites(scope) {
    if (!scope.id || !scope.viewer) return;
    const key = transferKey(scope);
    if (!workspaceWrites.has(key)) workspaceWrites.set(key, {member:{},invite:{}});
    const state = workspaceWrites.get(key);
    const changed = visibleWrites !== state;
    visibleWrites = state;
    if (changed) {
      for (const [controls, draft] of [[memberWrite,state.member],[inviteWrite,state.invite]]) {
        controls.form.reset();
        for (const [name,value] of Object.entries(draft.fields || {})) {
          const field = controls.form.elements[name];
          if (field.type === 'checkbox') field.checked = value;
          else field.value = value;
        }
      }
    }
    if (!canInvite(actor)) state.issued = null;
    paintWorkspaceWrites();
  }

  function rememberWorkspaceForm(controls, draft) {
    if (!draft) return;
    draft.fields = Object.fromEntries(controls.fields.flatMap(name => {
      const field = controls.form.elements[name];
      return field ? [[name,field.type === 'checkbox' ? field.checked : field.value]] : [];
    }));
  }

  addForm.addEventListener('input', () => rememberWorkspaceForm(memberWrite,visibleWrites?.member));
  inviteForm.addEventListener('input', () => rememberWorkspaceForm(inviteWrite,visibleWrites?.invite));

  let pendingConfirm = null;
  let confirmSerial = 0;
  let memberItems = [];
  let inviteItems = [];
  let inviteStates = [];

  function closeConfirm({restoreFocus = true} = {}) {
    if (!pendingConfirm) return;
    const {box, trigger} = pendingConfirm;
    pendingConfirm = null;
    if (box && box.parentElement) box.remove();
    if (trigger) {
      trigger.hidden = false;
      if (restoreFocus && typeof trigger.focus === 'function') trigger.focus();
    }
  }

  function openConfirm({row, trigger, prompt, action}) {
    closeConfirm();
    const questionId = `member-confirm-question-${++confirmSerial}`;
    const box = document.createElement('span');
    box.className = 'row-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', questionId);
    const question = document.createElement('span');
    question.id = questionId;
    question.textContent = prompt.question;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.dataset.confirmAction = 'cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    confirm.dataset.confirmAction = 'ok';
    box.appendChild(question);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    row.appendChild(box);
    pendingConfirm = {row, box, trigger, action};
    if (typeof cancel.focus === 'function') cancel.focus();
  }

  // One delegated listener for both lists: row buttons only carry data attributes.
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target || !target.dataset || target.disabled) return;
    if (target.dataset.confirmAction === 'cancel') {
      if (pendingConfirm?.box === target.parentElement) closeConfirm();
      return;
    }
    if (target.dataset.confirmAction === 'ok') {
      if (!pendingConfirm || pendingConfirm.box !== target.parentElement) return;
      const run = pendingConfirm.action;
      closeConfirm();
      run();
      return;
    }
    const scope = workspaceScope();
    if (!scope.id || target.dataset.workspaceEpoch !== String(scope.epoch)) return;
    if (target.dataset.rowAction === 'transfer' || target.dataset.rowAction === 'remove') {
      const transfer = target.dataset.rowAction === 'transfer';
      const item = memberItems.find(entry => entry.user_id === target.dataset.userId);
      if (!item || (transfer && !canTransferOwnership(actor, item, currentUser))) return;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: transfer ? {
          question: `将工作区转让给 ${item.username}？转让后你将成为普通成员，可以退出工作区。原有管理员邀请链接会失效。`,
          confirmLabel: '确认转让',
        } : removalPrompt(item, currentUser),
        action: () => transfer ? transferOwnership(item, scope) : removeMember(item, scope),
      });
      return;
    }
    if (target.dataset.rowAction === 'revoke') {
      const item = inviteItems.find(entry => entry.id === target.dataset.inviteId);
      if (!item) return;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: revokePrompt(item),
        action: () => inviteAction(item, 'revoke', scope),
      });
      return;
    }
    if (target.dataset.rowAction === 'freeze' || target.dataset.rowAction === 'unfreeze') {
      const item = inviteItems.find(entry => entry.id === target.dataset.inviteId);
      if (!item) return;
      const action = target.dataset.rowAction;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: freezePrompt(item),
        action: () => inviteAction(item, action, scope),
      });
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingConfirm) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    closeConfirm();
  });

  function setRoleOptions(form, actorRole) {
    const select = form.elements.role;
    const allowed = addableRoles(actorRole);
    for (const option of select.options) {
      option.hidden = !allowed.includes(option.value);
    }
    if (!allowed.includes(select.value)) select.value = allowed[0] || 'member';
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }


  function monogram(name) {
    const text = String(name || '').trim();
    const chars = Array.from(text);
    const label = (chars.slice(0, chars[0] && /[A-Za-z]/.test(chars[0]) ? 2 : 1).join('') || '?');
    let tone = 0;
    for (const ch of chars) tone += ch.codePointAt(0) || 0;
    return {label, tone: (tone % 6) + 1};
  }

  function identity(name, detail, separateDetail = false) {
    const wrap = document.createElement('span');
    wrap.className = 'member-id';
    const mark = monogram(name);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.dataset.tone = String(mark.tone);
    avatar.textContent = mark.label;
    const label = document.createElement('span');
    label.className = 'member-name';
    label.textContent = detail && !separateDetail ? `${name} · ${detail}` : (name || '');
    wrap.appendChild(avatar);
    if (separateDetail) {
      const copy = document.createElement('span');
      copy.className = 'member-copy';
      const role = document.createElement('span');
      role.className = 'note';
      role.textContent = detail;
      copy.appendChild(label);
      copy.appendChild(role);
      wrap.appendChild(copy);
    } else wrap.appendChild(label);
    // Fake-DOM tests read textContent on the wrap itself; keep a copy of the
    // visible name there when the getter does not walk children.
    if (Object.prototype.hasOwnProperty.call(wrap, '_text')) wrap._text = label.textContent;
    return wrap;
  }

  function messageKey() {
    const raw = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + 'dmxxxxxxxx');
    return ('member-dm-' + raw.replace(/-/g, '')).slice(0, 64);
  }

  async function startDirectMessage(item, scope) {
    const {id} = scope;
    if (!id || !item?.user_id || !inWorkspace(scope)) return;
    if (currentUser && samePerson(item, currentUser)) {
      show('error', '不能给自己发消息。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/social/conversations`, {
      kind: 'dm', member_ids: [item.user_id],
    }, {'Idempotency-Key': messageKey()});
    if (!inWorkspace(scope)) return;
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法打开与对方的单聊。'));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    const conversation = result.body.conversation;
    if (!conversation || !conversation.id) {
      show('error', '已发起会话，但没有返回可打开的对话。');
      return;
    }
    goTo(conversationChatHref(id, {source: 'social', id: conversation.id}));
  }

  function renderMembers(items, scope = workspaceScope()) {
    const list = document.getElementById('member-list');
    const empty = document.getElementById('members-empty');
    memberItems = items;
    if (pendingConfirm?.row.parentElement === list) closeConfirm({restoreFocus: false});
    list.textContent = '';
    empty.hidden = items.length > 0;
    const selfId = currentUser;
    for (const item of items) {
      const row = document.createElement('li');
      const roleText = (ROLE_LABELS[item.role] || item.role) + (item.suspended ? ' · 已停用' : '');
      row.appendChild(identity(item.username));
      const role = document.createElement('span');
      role.className = 'role-pill' + (item.role === 'owner' ? ' is-owner' : '');
      role.textContent = roleText;
      row.appendChild(role);
      if (!samePerson(item, selfId)) {
        const message = document.createElement('button');
        message.type = 'button';
        message.textContent = '发消息';
        message.title = '打开与对方的人与人单聊';
        message.addEventListener('click', () => startDirectMessage(item, scope));
        row.appendChild(message);
      }
      if (canSuspend(actor, item, selfId)) {
        const suspend = document.createElement('button');
        suspend.type = 'button';
        suspend.textContent = item.suspended ? '恢复访问' : '停用';
        suspend.title = item.suspended ? '恢复后对方可再次访问本工作区' : '停用后对方保留成员身份，但无法访问本工作区，可随时恢复';
        suspend.addEventListener('click', () => suspendMember(item, !item.suspended, scope));
        row.appendChild(suspend);
      }
      if (canChange(actor) && item.role !== 'owner') {
        const change = document.createElement('button');
        change.type = 'button';
        change.textContent = item.role === 'admin' ? '改为成员' : '改为管理员';
        change.addEventListener('click', () => changeRole(item, item.role === 'admin' ? 'member' : 'admin', scope));
        row.appendChild(change);
      }
      if (canTransferOwnership(actor, item, selfId)) {
        const transfer = document.createElement('button');
        transfer.type = 'button';
        transfer.textContent = '转让所有权';
        transfer.dataset.rowAction = 'transfer';
        transfer.dataset.userId = item.user_id;
        transfer.dataset.workspaceEpoch = String(scope.epoch);
        transfer.disabled = busyTransfers.has(transferKey(scope));
        row.appendChild(transfer);
      }
      if (canRemove(actor, item, selfId)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = samePerson(item, selfId) ? '退出' : '移除';
        remove.dataset.rowAction = 'remove';
        remove.dataset.userId = item.user_id;
        remove.dataset.workspaceEpoch = String(scope.epoch);
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
  }

  function renderInvites(items, scope = workspaceScope()) {
    const list = document.getElementById('invite-list');
    const empty = document.getElementById('invites-empty');
    inviteItems = items;
    inviteStates = items.map(item => inviteState(item));
    const issued = visibleWrites?.issued;
    const latest = issued && items.find(item => item.id === issued.invite.id);
    if (latest) {
      issued.invite = latest;
      paintWorkspaceWrites();
    }
    if (pendingConfirm?.row.parentElement === list) closeConfirm({restoreFocus: false});
    list.textContent = '';
    empty.hidden = items.length > 0;
    for (const [index, item] of items.entries()) {
      const row = document.createElement('li');
      const state = inviteStates[index];
      const detail = `${ROLE_LABELS[item.role] || item.role} · ${state} · 已用 ${item.use_count}/${item.max_uses}`;
      row.appendChild(identity('邀请', detail));
      const role = document.createElement('span');
      role.className = 'role-pill';
      role.textContent = ROLE_LABELS[item.role] || item.role;
      row.appendChild(role);
      if (!item.revoked && addableRoles(actor).includes(item.role)) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.dataset.rowAction = 'revoke';
        revoke.dataset.inviteId = item.id;
        revoke.dataset.workspaceEpoch = String(scope.epoch);
        const freeze = document.createElement('button');
        freeze.type = 'button';
        freeze.textContent = item.frozen ? '解冻' : '冻结';
        freeze.title = item.frozen ? '解冻后邀请可再次使用，不会撤销' : '暂停这条邀请，不撤销，可随时解冻';
        freeze.dataset.rowAction = item.frozen ? 'unfreeze' : 'freeze';
        freeze.dataset.inviteId = item.id;
        freeze.dataset.workspaceEpoch = String(scope.epoch);
        row.appendChild(freeze);
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  async function changeRole(item, role, scope) {
    const {id} = scope;
    if (!id || !inWorkspace(scope)) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}`, {role});
    if (!inWorkspace(scope)) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更改角色。'));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    show('ok', '已更改角色。');
    await loadWorkspace();
  }

  async function transferOwnership(item, scope) {
    const key = transferKey(scope);
    if (!scope.id || !inWorkspace(scope) || !canTransferOwnership(actor, item, scope.viewer) ||
        busyTransfers.has(key)) return;
    busyTransfers.add(key);
    for (const button of document.querySelectorAll('#member-list [data-row-action="transfer"]')) button.disabled = true;
    show('loading', '正在转让工作区…');
    const result = await request('POST', `/v1/workspaces/${scope.id}/members/${item.user_id}/transfer-ownership`,
      {}, undefined, AbortSignal.timeout(20000));
    busyTransfers.delete(key);
    if (scope.id !== workspaceId() || scope.viewer !== currentUser) return;
    await loadWorkspace();
    if (!inWorkspace(scope)) return;

    const newOwner = memberItems.find(member => member.role === 'owner');
    if (result.body.transferred === true || (newOwner?.user_id === item.user_id && actor !== 'owner')) {
      show('ok', `已转让给 ${item.username}。你现在可以退出工作区。`);
      document.getElementById('members-heading').focus();
    } else {
      const errors = {
        member_suspended: '请先恢复该成员的访问，再转让所有权。',
        member_not_found: '对方已不在该工作区，请选择其他成员。',
        quota: '对方已达到可拥有的团队数上限。',
        forbidden: '你的工作区角色已变更，请查看最新成员列表。',
        ownership_changed: '工作区所有权已变更，请查看最新成员列表。',
      };
      show('error', errors[result.body.error?.code] || '暂时无法确认转让结果。请查看最新成员列表。');
    }
  }

  async function suspendMember(item, suspend, scope) {
    const {id} = scope;
    if (!id || !inWorkspace(scope)) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/${suspend ? 'suspend' : 'unsuspend'}`, {});
    if (!inWorkspace(scope)) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更新成员状态。'));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    show('ok', suspend ? '已停用该成员的访问。' : '已恢复该成员的访问。');
    await loadWorkspace();
  }

  async function removeMember(item, scope) {
    const {id} = scope;
    if (!id || !inWorkspace(scope)) return;
    const leaving = samePerson(item, scope.viewer);
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/remove`, {});
    if (!inWorkspace(scope)) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, leaving ? '无法退出工作区。' : '无法移除成员。'));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    show('ok', leaving ? '已退出工作区。' : '已移除。');
    if (leaving) {
      linkedWorkspace = null;
      if (workspaceFromHash(view?.location?.hash) !== null && view?.location) {
        view.history?.replaceState(view.history.state, '', view.location.pathname + view.location.search);
      }
      workspaces = workspaces.filter(item => item.id !== id);
      showWorkspaceOptions(workspaces);
      workspaceEpoch += 1;
      renderMyRequests();
      await Promise.all([loadWorkspace({reset: true}), refreshWorkspaces()]);
    } else await loadWorkspace();
  }

  async function inviteAction(item, action, scope) {
    const {id} = scope;
    if (!id || !inWorkspace(scope) || !addableRoles(actor).includes(item.role)) return;
    const result = await request('POST', `/v1/workspaces/${id}/invites/${item.id}/${action}`, {});
    const writeState = workspaceWrites.get(transferKey(scope));
    if (result.status === 200 && writeState?.issued?.invite.id === item.id) {
      Object.assign(writeState.issued.invite, action === 'revoke' ? {revoked:true} : {frozen:action === 'freeze'});
      if (visibleWrites === writeState) paintWorkspaceWrites();
    }
    if (!inWorkspace(scope)) return;
    if (result.status !== 200) {
      show('error', inviteFailure(result.body.error, action));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    show('ok', action === 'freeze' ? '已冻结。' : action === 'unfreeze' ? '已解冻。' : '已撤销邀请。');
    await loadWorkspace();
  }

  function renderJoinRequests(items, scope = workspaceScope(), unavailable = false) {
    const list = document.getElementById('join-request-list');
    const empty = document.getElementById('join-requests-empty');
    if (!list) return;
    joinItems = items;
    list.textContent = '';
    if (empty) empty.hidden = unavailable || items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      row.appendChild(identity(item.username, '申请成为' + (ROLE_LABELS[item.role] || item.role)));
      for (const [decision, label] of [['approve', '批准'], ['reject', '拒绝']]) {
        if (decision === 'approve' && !addableRoles(actor).includes(item.role)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.disabled = busyJoins.has(`${scope.viewer?.id}/${scope.id}/${item.id}`);
        button.addEventListener('click', () => decideJoin(item, decision, scope, row));
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  }

  async function decideJoin(item, decision, scope, row) {
    const {id} = scope;
    const key = `${scope.viewer?.id}/${id}/${item.id}`;
    if (!id || !inWorkspace(scope) || !canInvite(actor) || busyJoins.has(key) ||
        (decision === 'approve' && !addableRoles(actor).includes(item.role)) || !joinItems.some(entry => entry.id === item.id)) return;
    busyJoins.add(key);
    for (const button of [...row.children].filter(child => child.type === 'button')) button.disabled = true;
    const result = await request('POST', `/v1/workspaces/${id}/join-requests/${item.id}/${decision}`, {});
    busyJoins.delete(key);
    if (!inWorkspace(scope)) {
      if (id === workspaceId() && scope.viewer === currentUser) await loadJoinQueue();
      return;
    }
    for (const button of [...row.children].filter(child => child.type === 'button')) button.disabled = false;
    if (result.status !== 200) {
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      if (!inWorkspace(scope) || !canInvite(actor)) return;
      if ([404, 409].includes(result.status)) {
        show('error', '这条申请已由其他管理员处理，正在更新列表。');
        await loadJoinQueue(scope);
      } else {
        renderJoinRequests(joinItems, scope);
        show('error', messageFor(result.body.error, '无法确认处理结果，可刷新后重试。'));
      }
      return;
    }
    renderJoinRequests(joinItems.filter(entry => entry.id !== item.id), scope);
    show('ok', decision === 'approve' ? '已批准，对方已加入。' : '已拒绝申请。');
    if (decision === 'approve') await loadWorkspace();
    else await loadJoinQueue(scope);
  }

  function clearWorkspaceView() {
    actor = null;
    visibleWrites = null;
    directoryLoaded = false;
    addForm.reset();
    inviteForm.reset();
    paintWorkspaceWrites();
    workspaceChat.hidden = true;
    workspaceChat.removeAttribute('href');
    closeConfirm({restoreFocus: false});
    renderMembers([]);
    renderInvites([]);
    renderJoinRequests([], workspaceScope(), true);
    document.getElementById('members-empty').hidden = true;
    for (const id of ['add-form', 'invite-form', 'invites-panel', 'join-requests-panel', 'directory-listing-form']) {
      document.getElementById(id).hidden = true;
    }
  }

  async function loadWorkspace({reset = false, revalidate = false} = {}) {
    const scope = workspaceScope();
    const {id} = scope;
    const seq = ++rosterRead;
    const invitesPanel = document.getElementById('invites-panel');
    const membersPanel = document.getElementById('members-panel');
    const workspaceField = document.getElementById('member-workspace-field');
    if (membersPanel) membersPanel.hidden = !id;
    if (workspaceField) workspaceField.hidden = !workspaces.length;
    const roleNote = document.getElementById('role-note');
    if (reset || !id) clearWorkspaceView();
    if (!id) {
      roleNote.textContent = workspaces.length ? '请选择工作区。' : '加入或创建团队后，可以在这里管理成员。';
      return;
    }
    if (reset) roleNote.textContent = '正在读取工作区成员…';
    const listed = await request('GET', `/v1/workspaces/${id}/members`, undefined, undefined, AbortSignal.timeout(8000));
    const inRead = () => inWorkspace(scope) && seq === rosterRead;
    if (!inRead()) return;
    if (listed.status !== 200 || !Array.isArray(listed.body.items)) {
      if (revalidate && !accessMayHaveChanged(listed)) return;
      if (accessMayHaveChanged(listed)) workspaceWrites.delete(transferKey(scope));
      clearWorkspaceView();
      roleNote.textContent = '无法读取成员列表。';
      show('error', messageFor(listed.body.error, roleNote.textContent));
      if (revalidate && listed.status === 401) return load();
      if (revalidate) await refreshWorkspaces({preferred:id, explicit:true});
      return;
    }
    const items = listed.body.items;
    const self = items.find(item => samePerson(item, currentUser));
    const previousRole = actor;
    actor = self && !self.suspended ? self.role : null;
    const keepRows = revalidate && previousRole === actor;
    restoreWorkspaceWrites(scope);
    workspaceChat.hidden = !actor || !WORKSPACE_ID.test(id);
    if (workspaceChat.hidden) workspaceChat.removeAttribute('href');
    else workspaceChat.setAttribute('href', '/chat#workspace=' + id);
    roleNote.textContent = actor ? `当前角色：${ROLE_LABELS[actor] || actor}` : '';
    if (!keepRows || JSON.stringify(items) !== JSON.stringify(memberItems)) renderMembers(items, scope);
    addForm.hidden = !canAdd(actor);
    inviteForm.hidden = !canInvite(actor);
    invitesPanel.hidden = !canInvite(actor);
    const joinPanel = document.getElementById('join-requests-panel');
    joinPanel.hidden = !canInvite(actor);
    if (canAdd(actor)) setRoleOptions(addForm, actor);
    if (actor !== 'owner') {
      document.getElementById('directory-listing-form').hidden = true;
      directoryLoaded = false;
    }
    if (!canInvite(actor)) {
      renderInvites([], scope);
      renderJoinRequests([], scope, true);
      return;
    }
    setRoleOptions(inviteForm, actor);
    await Promise.all([
      request('GET', `/v1/workspaces/${id}/invites`, undefined, undefined, AbortSignal.timeout(8000)).then(result => {
        if (!inRead()) return;
        const rows = result.status === 200 && Array.isArray(result.body.items) ? result.body.items : [];
        if (!keepRows || JSON.stringify(rows) !== JSON.stringify(inviteItems) ||
            rows.some((item, index) => inviteState(item) !== inviteStates[index])) renderInvites(rows, scope);
        const empty = document.getElementById('invites-empty');
        if (result.status !== 200) {
          empty.hidden = false;
          empty.textContent = '无法读取邀请记录。';
        } else {
          empty.hidden = rows.length > 0;
          empty.textContent = '还没有有效或已记录的邀请。';
        }
      }),
      loadJoinQueue(scope, {keepRows}),
      keepRows && directoryLoaded ? null : loadDirectoryListing(scope, inRead),
    ]);
  }

  async function loadJoinQueue(scope = workspaceScope(), {keepRows = false} = {}) {
    if (!scope.id || !inWorkspace(scope) || !canInvite(actor)) return;
    const seq = ++queueRead;
    const feedback = document.getElementById('join-requests-status');
    const refresh = document.getElementById('refresh-join-requests');
    refresh.disabled = true;
    feedback.textContent = '正在读取加入申请…';
    const result = await request('GET', `/v1/workspaces/${scope.id}/join-requests`, undefined, undefined, AbortSignal.timeout(8000));
    if (seq !== queueRead || !inWorkspace(scope) || !canInvite(actor)) return;
    refresh.disabled = false;
    const valid = result.status === 200 && Array.isArray(result.body.items);
    feedback.textContent = valid ? '' : '无法读取待审批申请，请重试。';
    if (!valid) document.getElementById('join-requests-empty').hidden = true;
    else if (!keepRows || JSON.stringify(result.body.items) !== JSON.stringify(joinItems)) renderJoinRequests(result.body.items, scope);
    else document.getElementById('join-requests-empty').hidden = result.body.items.length > 0;
  }

  async function loadDirectoryListing(scope, inRead) {
    const form = document.getElementById('directory-listing-form');
    if (!form) return;
    form.hidden = actor !== 'owner';
    if (form.hidden) return;
    const listing = await request('GET', `/v1/workspaces/${scope.id}/directory`, undefined, undefined, AbortSignal.timeout(8000));
    if (!inRead()) return;
    if (listing.status !== 200 || !listing.body.listing) { form.hidden = true; return; }
    document.getElementById('directory-listed').checked = Boolean(listing.body.listing.listed);
    document.getElementById('directory-summary').value = listing.body.listing.summary || '';
    directoryLoaded = true;
  }

  function renderMyRequests() {
    const list = document.getElementById('my-join-request-list');
    const empty = document.getElementById('my-join-requests-empty');
    list.textContent = '';
    empty.hidden = !myRequestsReady || myRequests.length > 0;
    for (const item of myRequests) {
      const row = document.createElement('li');
      const workspace = workspaces.find(entry => entry.id === item.workspace_id);
      row.appendChild(identity(item.team_name || workspace?.name || '团队', '申请成为' + (ROLE_LABELS[item.role] || '成员'), true));
      const pill = document.createElement('span');
      pill.className = 'role-pill';
      pill.dataset.state = item.status;
      pill.textContent = JOIN_STATES[item.status];
      row.appendChild(pill);
      if (item.status === 'approved' && workspace) {
        row.appendChild(openWorkspaceButton(workspace.id));
      }
      list.appendChild(row);
    }
  }

  async function loadMyRequests() {
    if (!currentUser) return;
    const viewer = currentUser, seq = ++personalRequestsRead;
    const feedback = document.getElementById('my-join-requests-status');
    const refresh = document.getElementById('refresh-my-join-requests');
    refresh.disabled = true;
    feedback.textContent = '正在读取申请状态…';
    const result = await request('GET', '/v1/join-requests');
    if (seq !== personalRequestsRead || viewer !== currentUser) return;
    refresh.disabled = false;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      feedback.textContent = '无法读取申请状态，请重试。';
      return;
    }
    myRequests = result.body.items.filter(item => item?.id && Object.hasOwn(JOIN_STATES, item.status));
    myRequestsReady = true;
    feedback.textContent = '';
    renderMyRequests();
  }

  function showWorkspaceOptions(items, preferred, explicit = false) {
    const before = workspaceId();
    const selection = items.find(item => item.id === (explicit ? preferred : preferred || before));
    workspaceSelect.textContent = '';
    if (explicit && !selection && items.length) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '选择工作区';
      workspaceSelect.appendChild(placeholder);
    }
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || item.slug || item.id;
      workspaceSelect.appendChild(option);
    }
    workspaceSelect.value = selection?.id || (explicit ? '' : items[0]?.id || '');
    return before !== workspaceId();
  }

  async function refreshWorkspaces({preferred, explicit = false, initial = false} = {}) {
    const viewer = currentUser, epoch = workspaceEpoch, seq = ++workspaceOptionsRead;
    const result = await request('GET', '/v1/workspaces?limit=100');
    if (seq !== workspaceOptionsRead || viewer !== currentUser) return;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      show('error', messageFor(result.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = result.body.items.filter(item => item?.id && item.kind !== 'personal');
    const unchanged = epoch === workspaceEpoch;
    const authoritativeLink = unchanged && explicit;
    const changed = showWorkspaceOptions(workspaces, unchanged ? preferred : null, authoritativeLink);
    renderMyRequests();
    if ((initial && unchanged) || changed) {
      workspaceEpoch += 1;
      await loadWorkspace({reset: true});
    }
    if (authoritativeLink && !workspaceId() && viewer === currentUser && seq === workspaceOptionsRead) {
      show('error', '无法打开此工作区。请选择一个可访问的团队。');
    }
  }

  function pinWorkspace(id) {
    if (!WORKSPACE_ID.test(id)) return;
    linkedWorkspace = id;
    if (view?.location) {
      view.history?.replaceState(view.history.state, '', view.location.pathname + view.location.search + '#workspace=' + id);
    }
  }

  async function selectWorkspace(id) {
    workspaceSelection += 1;
    workspaceSelect.value = id;
    pinWorkspace(id);
    workspaceEpoch += 1;
    show('', '');
    await loadWorkspace({reset: true});
  }

  function openWorkspaceButton(id) {
    const button = document.createElement('button');
    const viewer = currentUser;
    button.type = 'button';
    button.textContent = '打开工作区';
    button.addEventListener('click', async () => {
      if (viewer !== currentUser || !WORKSPACE_ID.test(id)) return;
      if (workspaces.some(entry => entry.id === id)) await selectWorkspace(id);
      else {
        workspaceSelection += 1;
        pinWorkspace(id);
        await refreshWorkspaces({preferred: id, explicit: true, initial: true});
      }
      if (viewer === currentUser && workspaceId() === id && actor) {
        document.getElementById('members-heading').focus();
      }
    });
    return button;
  }

  document.getElementById('refresh-my-join-requests').addEventListener('click', () => Promise.all([
    loadMyRequests(),
    refreshWorkspaces({preferred: linkedWorkspace, explicit: linkedWorkspace !== null}),
  ]));
  document.getElementById('refresh-join-requests').addEventListener('click', () => loadJoinQueue());

  function renderDirectory(items) {
    const list = document.getElementById('directory-results');
    list.textContent = '';
    document.getElementById('directory-empty').hidden = items.length > 0;
    const viewer = currentUser, seq = directoryRead;
    for (const team of items) {
      const li = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = team.name;
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = `${team.member_count} 人` + (team.summary ? ' · ' + team.summary : '');
      li.append(name, ' ', meta);
      const label = directoryMembershipLabel(team);
      if (label) {
        const membership = document.createElement('span');
        membership.className = 'note';
        membership.textContent = label;
        li.append(membership);
        if (team.membership === 'member' && WORKSPACE_ID.test(team.workspace_id || '')) {
          li.append(openWorkspaceButton(team.workspace_id));
        }
      } else {
        const join = document.createElement('button');
        join.type = 'button';
        join.textContent = '申请加入';
        join.addEventListener('click', async () => {
          const key = `${viewer?.id}/${team.workspace_id}`;
          if (viewer !== currentUser || seq !== directoryRead || busyDirectoryJoins.has(key) || join.disabled) return;
          busyDirectoryJoins.add(key);
          join.disabled = true;
          join.textContent = '正在提交…';
          const result = await request('POST', `/v1/team-directory/${team.workspace_id}/join`, {});
          busyDirectoryJoins.delete(key);
          if (viewer !== currentUser) return;
          if (seq !== directoryRead) {
            if ([200, 202].includes(result.status)) await loadMyRequests();
            return;
          }
          if (result.status !== 200 && result.status !== 202) {
            show('error', messageFor(result.body.error, '无法提交加入申请。'));
            join.disabled = false;
            join.textContent = '申请加入';
            return;
          }
          if (result.status === 202 || result.body.join_request?.status === 'pending') {
            show('ok', '已提交加入申请，等待所有者或管理员审批。');
            join.textContent = '等待审批';
          } else if (result.body.status === 'suspended') {
            show('error', '该团队已暂停你的访问。');
            join.textContent = '已暂停';
          } else {
            show('ok', '你已加入此团队。');
            const joined = result.body.workspace_id || team.workspace_id;
            if (WORKSPACE_ID.test(joined || '')) join.replaceWith(openWorkspaceButton(joined));
            else join.textContent = '已加入';
            await refreshWorkspaces();
          }
          await loadMyRequests();
        });
        li.append(join);
      }
      list.appendChild(li);
    }
  }

  const directoryForm = document.getElementById('directory-search-form');
  if (directoryForm) directoryForm.addEventListener('submit', async event => {
    event.preventDefault();
    const viewer = currentUser, seq = ++directoryRead;
    const q = document.getElementById('directory-query').value.trim();
    const result = await request('GET', '/v1/team-directory' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (seq !== directoryRead || viewer !== currentUser) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法搜索团队目录。'));
      return;
    }
    renderDirectory(result.body.items || []);
  });

  const listingForm = document.getElementById('directory-listing-form');
  if (listingForm) listingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = workspaceScope();
    if (!scope.id || actor !== 'owner') return;
    const result = await request('POST', `/v1/workspaces/${scope.id}/directory`, {
      listed: document.getElementById('directory-listed').checked,
      summary: document.getElementById('directory-summary').value,
    });
    if (!inWorkspace(scope)) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存目录设置。'));
      if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
      return;
    }
    show('ok', result.body.listing.listed ? '已在团队目录中公开。' : '已从团队目录移除。');
  });

  function resetInvitePreview() {
    inviteRequest++;
    previewed = '';
    receivePreview.textContent = '';
    receivePreview.hidden = true;
    if (receiveField) receiveField.hidden = false;
    receiveButton.textContent = '查看邀请';
  }

  function rememberInvitation(token, scrubFragment = false) {
    const history = view?.history;
    if (!history?.replaceState || !view.location) return;
    const state = {...history.state};
    if (token && currentUser?.id) state[PENDING_INVITATION] = {viewer:currentUser.id, token};
    else if (Object.hasOwn(state, PENDING_INVITATION)) delete state[PENDING_INVITATION];
    else if (!scrubFragment) return;
    const {pathname, search, hash} = view.location;
    const fragment = scrubFragment ? (WORKSPACE_ID.test(linkedWorkspace || '') ? '#workspace=' + linkedWorkspace : '') : hash;
    history.replaceState(state, '', pathname + search + fragment);
  }

  function resumeInvitation() {
    const pending = view?.history?.state?.[PENDING_INVITATION];
    if (currentUser?.id && pending?.viewer === currentUser.id && teamInviteHash(pending.token)) return pending.token;
    rememberInvitation(null);
    return '';
  }

  function openLinkedInvitation(token, scrubFragment = false) {
    accepting = null;
    resetInvitePreview();
    receiveForm.dataset.linked = 'true';
    mainPanel.querySelector('.page-toolbar')?.before(receiveForm);
    receiveToken.readOnly = false;
    receiveToken.type = 'password';
    receiveToken.value = token;
    if (scrubFragment) rememberInvitation(token, true);
    return previewInvite(token);
  }

  function leaveLinkedInvitation() {
    if (receiveForm.dataset.linked !== 'true') return;
    delete receiveForm.dataset.linked;
    accepting = null;
    receiveForm.reset();
    receiveToken.readOnly = false;
    receiveToken.type = 'text';
    resetInvitePreview();
    receiveButton.disabled = false;
    receiveParent?.insertBefore(receiveForm, receiveNext || null);
  }

  function invitationReceipt(result) {
    const invitation = result?.status === 200 ? result.body?.invitation : null;
    if (invitation?.membership === 'pending') return {pending: true};
    if (invitation?.membership === 'member' && WORKSPACE_ID.test(invitation.workspace_id || '')) {
      return {joined: invitation.workspace_id};
    }
    return null;
  }

  async function showInvitationReceipt({pending, joined}, selection) {
    rememberInvitation(null);
    receiveForm.reset();
    receiveToken.type = 'text';
    resetInvitePreview();
    receivePreview.hidden = false;
    receivePreview.textContent = pending ? '已提交加入申请，等待审批。' : '已加入工作区。';
    if (pending) await loadMyRequests();
    else if (selection === workspaceSelection && WORKSPACE_ID.test(joined || '')) {
      pinWorkspace(joined);
      await refreshWorkspaces({preferred: joined, explicit: true, initial: true});
    } else await refreshWorkspaces();
  }

  const readInvitation = token => request('POST', '/v1/invites/preview', {token}, undefined, AbortSignal.timeout(8000));

  async function previewInvite(token) {
    const sequence = ++inviteRequest;
    const viewer = currentUser, selection = workspaceSelection;
    previewed = '';
    receivePreview.hidden = false;
    receivePreview.textContent = '正在查看邀请…';
    receiveButton.disabled = true;
    try {
      const result = await readInvitation(token);
      if (sequence !== inviteRequest || viewer !== currentUser) return;
      const receipt = invitationReceipt(result);
      if (receipt) {
        receiveButton.disabled = false;
        await showInvitationReceipt(receipt, selection);
        return;
      }
      const invitation = result?.body?.invitation;
      if (result?.status !== 200 || !invitation?.team_name) {
        if ([403, 404, 410].includes(result?.status)) rememberInvitation(null);
        receivePreview.textContent = result?.status === 403 ? '暂时无法通过这条邀请加入工作区。'
          : result?.status === 404 || result?.status === 410 ? '这条邀请已失效。' : '暂时无法读取邀请，请重试。';
        return;
      }
      previewed = token;
      receivePreview.textContent = `团队：${invitation.team_name} · ${ROLE_LABELS[invitation.role] || '成员'}`;
      if (receiveField && receiveToken.type === 'password') receiveField.hidden = true;
      receiveButton.textContent = invitation.requires_approval ? '提交加入申请' : '确认加入';
    } finally {
      if (sequence === inviteRequest) receiveButton.disabled = false;
    }
  }

  async function load() {
    const seq = ++loadRead;
    const groupInvite = groupInviteFromHash(view?.location?.hash);
    const session = await request('GET', '/v1/auth/session');
    if (seq !== loadRead) return;
    const groupPanel = document.getElementById('group-invite-panel');
    if (groupPanel) groupPanel.hidden = true;
    if (groupInvite && session.status === 401) {
      goTo('/login' + groupInviteHash(groupInvite));
      return;
    }
    if (groupInvite && session.status === 200 && session.body.user) {
      resetInvitePreview();
      if (currentUser?.id !== session.body.user.id) workspaceWrites.clear();
      currentUser = session.body.user;
      loginPanel.hidden = mainPanel.hidden = true;
      show('', '');
      return showGroupInvitation(document, {request, token: groupInvite, goTo,
        isCurrent: () => seq === loadRead && groupInviteFromHash(view.location.hash) === groupInvite});
    }
    if (session.status === 401) {
      currentUser = null;
      accepting = null;
      rememberInvitation(null);
      workspaceWrites.clear();
      workspaces = [];
      myRequests = [];
      myRequestsReady = false;
      ++workspaceEpoch;
      clearWorkspaceView();
      showWorkspaceOptions([]);
      renderMyRequests();
      receiveForm.reset();
      receiveToken.type = 'text';
      receiveToken.readOnly = false;
      resetInvitePreview();
      receiveButton.disabled = false;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    if (currentUser?.id !== session.body.user?.id) {
      workspaceWrites.clear();
      workspaces = [];
      myRequests = [];
      myRequestsReady = false;
      clearWorkspaceView();
      showWorkspaceOptions([]);
      renderMyRequests();
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = currentUser.username;
    const linkedInvite = teamInviteFromHash(view?.location?.hash);
    const token = linkedInvite || resumeInvitation();
    if (token) void openLinkedInvitation(token, Boolean(linkedInvite));
    await Promise.all([
      refreshWorkspaces({preferred: linkedWorkspace, explicit: linkedWorkspace !== null, initial: true}),
      loadMyRequests(),
    ]);
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  const refreshMembers = document.getElementById('refresh-members');
  refreshMembers?.addEventListener('click', async () => {
    refreshMembers.disabled = true;
    try { await refreshWorkspaceAccess(workspaceScope(), true); }
    finally { refreshMembers.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshWorkspaceAccess();
  });
  view?.addEventListener?.('pageshow', event => {
    if (event.persisted) void refreshWorkspaceAccess();
  });
  workspaceSelect.addEventListener('change', () => selectWorkspace(workspaceId()));
  view?.addEventListener?.('hashchange', event => {
    if (groupInviteFromHash(view.location.hash) || (event?.oldURL && groupInviteFromHash(new URL(event.oldURL).hash))) {
      resetInvitePreview();
      return load();
    }
    const invite = teamInviteFromHash(view.location.hash);
    if (invite && currentUser) return openLinkedInvitation(invite, true);
    const requested = workspaceFromHash(view.location.hash);
    if (!currentUser || requested === null || requested === workspaceId()) return;
    if (workspaces.some(item => item.id === requested)) return selectWorkspace(requested);
    linkedWorkspace = requested;
    workspaceSelection += 1;
    workspaceEpoch += 1;
    workspaceSelect.value = '';
    clearWorkspaceView();
    document.getElementById('role-note').textContent = '正在查看工作区…';
    return refreshWorkspaces({preferred: requested, explicit: true, initial: true});
  });
  view?.addEventListener?.('popstate', () => {
    if (!currentUser || groupInviteFromHash(view.location.hash) || teamInviteFromHash(view.location.hash)) return;
    const token = resumeInvitation();
    if (token && token !== receiveToken.value) void openLinkedInvitation(token);
    if (!token) leaveLinkedInvitation();
  });

  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = workspaceScope();
    const {id} = scope;
    const writes = visibleWrites;
    if (!id || !writes || workspaceWrites.get(transferKey(scope)) !== writes || !canAdd(actor) || writes.member.busy) return;
    const values = readAddMember(addForm);
    if (!values.username) {
      show('error', '请填写用户名。');
      return;
    }
    rememberWorkspaceForm(memberWrite,writes.member);
    writes.member.busy = true;
    paintWorkspaceWrites();
    const result = await request('POST', `/v1/workspaces/${id}/members`, values, undefined, AbortSignal.timeout(15000));
    if (workspaceWrites.get(transferKey(scope)) !== writes) return;
    const saved = result.status === 200 || result.status === 201;
    writes.member.busy = false;
    writes.member.kind = saved ? 'ok' : 'error';
    writes.member.message = saved ? '已添加成员。' : messageFor(result.body.error, '无法添加成员。');
    if (saved) writes.member.fields = {};
    if (visibleWrites !== writes) return;
    if (saved) {
      addForm.reset();
      setRoleOptions(addForm, actor);
    }
    paintWorkspaceWrites();
    if (saved) await loadWorkspace();
    else if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
  });

  inviteForm.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = workspaceScope();
    const {id} = scope;
    const writes = visibleWrites;
    if (!id || !writes || workspaceWrites.get(transferKey(scope)) !== writes || !canInvite(actor) || writes.invite.busy) return;
    const values = readInvite(inviteForm);
    rememberWorkspaceForm(inviteWrite,writes.invite);
    writes.invite.busy = true;
    paintWorkspaceWrites();
    const result = await request('POST', `/v1/workspaces/${id}/invites`, values, undefined, AbortSignal.timeout(15000));
    if (workspaceWrites.get(transferKey(scope)) !== writes) return;
    const {invite,token} = result.body;
    const url = result.status === 201 && invite?.workspace_id === id && invite.id && teamInviteUrl(token, view?.location?.origin);
    if (url) writes.issued = {invite,url};
    writes.invite.busy = false;
    writes.invite.kind = url ? 'ok' : 'error';
    writes.invite.message = url ? '已生成邀请链接。' : result.status === 201 ? '无法显示这次生成的邀请链接。'
      : messageFor(result.body.error, '无法确认邀请是否已生成，请查看已发出的邀请。');
    if (visibleWrites !== writes) return;
    paintWorkspaceWrites();
    if (result.status === 201) await loadWorkspace();
    else if (accessMayHaveChanged(result)) await refreshWorkspaceAccess(scope, true);
  });

  document.getElementById('copy-issued-invite')?.addEventListener('click', async () => {
    const writes = visibleWrites;
    const value = issuedLink.value;
    if (!writes || !value) return;
    try {
      await view.navigator.clipboard.writeText(value);
      if (visibleWrites !== writes || issuedLink.value !== value) return;
      writes.invite.message = '已复制邀请链接。';
      writes.invite.kind = 'ok';
    } catch {
      if (visibleWrites !== writes || issuedLink.value !== value) return;
      issuedLink.select();
      writes.invite.message = '请复制选中的链接。';
      writes.invite.kind = 'error';
    }
    paintWorkspaceWrites();
  });

  receiveToken?.addEventListener('input', () => {
    if (accepting) return;
    rememberInvitation(null);
    resetInvitePreview();
    receiveButton.disabled = false;
  });
  receiveForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (accepting || receiveButton.disabled) return;
    const token = teamInviteCode(readAccept(event.currentTarget).token, view?.location?.origin);
    if (!token) {
      receivePreview.hidden = false;
      receivePreview.textContent = '请输入当前站点的有效邀请链接或邀请码。';
      return;
    }
    if (token !== previewed) return previewInvite(token);
    const viewer = currentUser, selection = workspaceSelection, sequence = inviteRequest;
    const attempt = {};
    accepting = attempt;
    receiveToken.readOnly = true;
    receiveButton.disabled = true;
    try {
      const result = await request('POST', '/v1/invites/accept', {token}, undefined, AbortSignal.timeout(15000));
      const current = () => viewer === currentUser && sequence === inviteRequest;
      if (!current()) return;
      if (![200, 201, 202].includes(result.status)) {
        if (result.status === 0 || result.status === 408 || result.status >= 500) {
          receivePreview.textContent = '正在确认加入结果…';
          const checked = await readInvitation(token);
          if (!current()) return;
          const receipt = invitationReceipt(checked);
          if (receipt) return await showInvitationReceipt(receipt, selection);
        }
        if (result.status === 404 || result.status === 410) {
          rememberInvitation(null);
          resetInvitePreview();
          receivePreview.hidden = false;
          receivePreview.textContent = '这条邀请已失效。';
        } else receivePreview.textContent = '暂时无法接受邀请，请重试。';
        return;
      }
      const pending = result.status === 202 || result.body.join_request?.status === 'pending';
      await showInvitationReceipt({pending, joined: result.body.workspace?.id}, selection);
    } finally {
      if (accepting === attempt) {
        accepting = null;
        receiveToken.readOnly = false;
        receiveButton.disabled = false;
      }
    }
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('add-form')) {
  mount(globalThis.document);
}

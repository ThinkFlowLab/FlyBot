import {mountMeetingAudio} from './audio.mjs';
import {mountMeetingDiscussion} from './discussion.mjs';
import {mountMeetingPrint} from './print.mjs';
import {mountTranscriptSearch, renderTranscriptMatch} from './transcript-search.mjs';
import {readWorkspaceChoices, servedByDsBot} from '../shell/dsbot-api.mjs';
import {isMeetingCallId, meetingArchiveHref, takeMeetingFromChat} from '../shell/meeting-link.mjs';
import {previewCallAudio} from '../shell/call-audio-handoff.mjs';
import {readMeetingEditor, writeMeetingEditor} from './editor-recovery.mjs';

function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatTime(seconds) {
  if (!seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function inputTime(seconds) {
  const date = seconds ? new Date(Number(seconds) * 1000) : new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseAttendees(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[,，]/)) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function actionPayload(item, done = item.done) {
  return {
    text: item.text,
    done: Boolean(done),
    owner: item.owner || '',
    ...(item.due_date ? {due_date: item.due_date} : {}),
  };
}

export function actionToggleBody(actions, index, done, revision) {
  const items = (actions || []).map((item, position) => actionPayload(item, position === index ? done : item.done));
  return {revision, changes: {action_items: items}};
}

const sameMeetingField = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const actionFields = ({text, owner, done, due_date}) => [text || '', owner || '', Boolean(done), due_date || ''];
const meetingFieldLabels = ['标题', '开始时间', '与会者', '摘要', '会议正文', '行动项'];

export function mergeMeetingFields(base, local, remote) {
  const conflicts = [];
  const fields = local.map((value, index) => {
    if (sameMeetingField(value, base[index])) return remote[index];
    if (!sameMeetingField(remote[index], base[index]) && !sameMeetingField(remote[index], value)) conflicts.push(index);
    return value;
  });
  return {fields, conflicts};
}

function conflictFieldText(value) {
  if (!Array.isArray(value)) return value || '（空）';
  return value.map(([text, owner, done, date]) => [
    done ? '已完成' : '未完成', text || '（空行动项）', owner, date,
  ].filter(Boolean).join(' · ')).join('\n') || '（没有行动项）';
}


export const MEMBER_ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};
export const ATTENDEE_EMPTY = '无匹配成员';
export const ATTENDEE_UNAVAILABLE = '读不到成员列表';
export const ATTENDEE_MIN = 2;
export const ATTENDEE_LIMIT = 6;

export function attendeeQuery(text) {
  const parts = String(text || '').split(/[,，]/);
  return parts[parts.length - 1].trim();
}

export function matchMembers(members, query, used) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < ATTENDEE_MIN) return [];
  const taken = new Set(parseAttendees(used).map(name => name.toLowerCase()));
  return (members || [])
    .filter(item => item && item.username && !taken.has(String(item.username).toLowerCase()))
    .filter(item => String(item.username).toLowerCase().includes(needle))
    .slice(0, ATTENDEE_LIMIT);
}

export function attendeeInsert(text, username) {
  const parts = String(text || '').split(/[,，]/);
  parts[parts.length - 1] = ' ' + username;
  return parts.join(',').replace(/^\s+/, '').replace(/[\s,]+$/, '') + ', ';
}

async function request(method, path, body, extra, signal) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  const options = { method, headers, credentials: 'same-origin', signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

const meetingKey = prefix => prefix + (globalThis.crypto?.randomUUID
  ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()));
const meetingIdPattern = /^[a-f0-9]{32}$/;

function linkedMeetingAction(params) {
  const index = params.get('action'), revision = params.get('revision');
  if (params.getAll('action').length !== 1 || params.getAll('revision').length !== 1 ||
      !/^(?:[0-9]|[1-4][0-9])$/.test(index ?? '') || !/^[1-9][0-9]*$/.test(revision ?? '') ||
      !Number.isSafeInteger(Number(revision))) return null;
  const inbox = params.getAll('from').length === 1 && params.get('from') === 'actions';
  const completed = inbox && params.getAll('status').length === 1 && params.get('status') === 'completed';
  return {index:Number(index), revision:Number(revision), inbox, mine:inbox && params.get('mine') === '1', completed};
}

function automationFollowupHref(workspace, meeting, action, revision) {
  return '/automations?' + new URLSearchParams({workspace, meeting, action, revision});
}

function automationFollowupLink(document) {
  const link = document.createElement('a');
  link.className = 'action-followup';
  link.textContent = '跟进自动化';
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

const unavailable = {status: 0, body: {}};
const DETAIL_READ_TIMEOUT_MS = 15000;
const SAVE_TIMEOUT_MS = 12000;
const DRAFT_WAIT_MS = 185000;
const DRAFT_POLL_MS = 1200;
const DRAFT_LABEL = {
  queued: '已排队，轮到这场会议后开始整理。', running: 'DS-Bot 正在整理纪要…',
  ready: '草稿已生成，请核对后采用。', cancelled: '已取消生成。可以重新生成草稿。',
  failed: '生成失败，请重试。', dismissed: '',
};
const draftIsActive = state => state === 'queued' || state === 'running';

function ambiguousSave(status) {
  return status === 0 || status === 408 || status >= 500;
}

function meetingMatchesChanges(meeting, changes) {
  const normalizers = {
    title: value => value.trim(),
    attendees: value => value.map(name => name.trim()),
    action_items: value => value.map(item => [item.text.trim(), (item.owner || '').trim(), Boolean(item.done), item.due_date || '']),
  };
  return Object.entries(changes).every(([field, value]) => {
    const saved = meeting[field];
    if (saved === undefined) return false;
    const normalize = normalizers[field];
    return normalize ? JSON.stringify(normalize(saved)) === JSON.stringify(normalize(value)) : saved === value;
  });
}

async function saveRequest(method, path, body, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
  try { return await request(method, path, body, headers, controller.signal); }
  catch { return unavailable; }
  finally { clearTimeout(timeout); }
}

const meetingShareRetriesKey = 'flybot-workspace.meeting-share-retries';
const meetingShareRetryLifetime = 30 * 60 * 1000;
const meetingShareRetryLimit = 12;
const shareScopeId = /^[A-Za-z0-9._-]{1,80}$/;
const shareRetryKey = /^[A-Za-z0-9_-]{16,64}$/;

function validMeetingShareRetryScope(scope) {
  if (!Array.isArray(scope) || scope.length !== 7) return false;
  const [owner, workspace, meeting, revision, kind, audience, recipients] = scope;
  return [owner, workspace, meeting].every(id => typeof id === 'string' && meetingIdPattern.test(id)) &&
    Number.isSafeInteger(revision) && revision > 0 && ['call', 'conversation'].includes(kind) &&
    typeof audience === 'string' && shareScopeId.test(audience) &&
    Array.isArray(recipients) && recipients.length > 0 && recipients.length <= 50 &&
    recipients.every(id => typeof id === 'string' && shareScopeId.test(id));
}

function meetingShareRetries(view, key) {
  const retries = new Map();
  let loaded = false;
  function restore(now) {
    loaded = true;
    try {
      const items = JSON.parse(view.sessionStorage.getItem(meetingShareRetriesKey));
      for (const entry of (Array.isArray(items) ? items.slice(-meetingShareRetryLimit) : [])) {
        const scope = entry?.scope;
        if (!validMeetingShareRetryScope(scope) ||
            typeof entry.key !== 'string' || !shareRetryKey.test(entry.key) ||
            !Number.isFinite(entry.expiry) || entry.expiry <= now || entry.expiry > now + meetingShareRetryLifetime) continue;
        retries.set(JSON.stringify(scope),entry);
      }
    } catch {}
  }
  function persist() {
    try {
      const items = [...retries.values()].filter(item => validMeetingShareRetryScope(item.scope));
      if (items.length) view.sessionStorage.setItem(meetingShareRetriesKey, JSON.stringify(items));
      else view.sessionStorage.removeItem(meetingShareRetriesKey);
    } catch {}
  }
  return {
    remember(scope) {
      const timestamp = Date.now();
      if (!loaded) restore(timestamp);
      for (const [fingerprint, item] of retries) {
        if (item.expiry <= timestamp) retries.delete(fingerprint);
      }
      const fingerprint = JSON.stringify(scope);
      const saved = retries.get(fingerprint);
      if (saved) return saved.key;
      const entry = {scope, key:key(), expiry:timestamp + meetingShareRetryLifetime};
      retries.set(fingerprint,entry);
      if (retries.size > meetingShareRetryLimit) retries.delete(retries.keys().next().value);
      persist();
      return entry.key;
    },
    confirm(scope, acknowledgedKey) {
      const fingerprint = JSON.stringify(scope);
      if (retries.get(fingerprint)?.key !== acknowledgedKey) return;
      retries.delete(fingerprint);
      persist();
    },
  };
}

export function mountMeetingShares(document, {request, context, historyWorkspace = () => '', key = () => meetingKey('meeting-share-')}) {
  const control = name => document.getElementById('meeting-share-' + name);
  const trigger = document.getElementById('share-meeting');
  const historyTrigger = document.getElementById('meeting-shares-history');
  const dialog = control('dialog');
  if (!trigger || typeof dialog?.showModal !== 'function') return {sync() {}};
  const close = control('close');
  const select = control('conversation');
  const recipients = control('recipients');
  const choices = control('recipient-items');
  const feedback = control('recipient-status');
  const submit = control('submit');
  const status = control('status');
  const sent = control('sent');
  const sentStatus = control('sent-status');
  const sentMore = control('sent-more');
  const form = control('form');
  let view;
  const retries = meetingShareRetries(document.defaultView, key);

  const call = (method, path, body, headers, signal) => request(method, path, body, headers, signal)
    .catch(() => ({status: 0, body: {}}));
  function selectedAudience(state) {
    const id = state.meeting.source_call_id;
    return isMeetingCallId(id) && select.value === 'call:' + id
      ? {call_id: id} : {conversation_id: select.value};
  }
  function isCurrent(state) {
    if (!dialog.open || view !== state || !state) return false;
    if (state.historyOnly) return historyWorkspace() === state.workspace;
    const target = context();
    return target?.workspace === state.workspace && target.owner === state.owner && target.meeting.id === state.meeting.id;
  }
  function syncForm(state) {
    close.disabled = state.busy;
    select.disabled = state.busy || select.options.length < 2;
    recipients.disabled = state.busy;
    submit.disabled = state.busy || !state.selected.size;
    sentMore.hidden = !state.sentCursor;
    sentMore.disabled = state.busy || state.sentLoading;
    for (const button of sent.querySelectorAll('button')) button.disabled = state.busy || state.sentLoading;
  }

  function renderSent(state, items) {
    sent.replaceChildren();
    sentStatus.textContent = items.length ? '' : '尚未分享。';
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.shareId = item.id;
      const info = document.createElement('p');
      info.textContent = [`版本 ${item.revision}`, formatTime(item.created), (item.recipients || []).join('、')]
        .filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'meeting-actions';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary meeting-share-revoke';
      revoke.textContent = '撤回分享';
      revoke.addEventListener('click', () => {
        if (!isCurrent(state) || state.busy || state.sentLoading) return;
        const note = document.createElement('span');
        note.textContent = '撤回后，接收人将无法打开这个副本。';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'meeting-share-revoke-confirm';
        confirm.textContent = '确认撤回';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'secondary';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => { actions.replaceChildren(revoke); revoke.focus(); });
        confirm.addEventListener('click', async () => {
          if (!isCurrent(state) || state.busy || state.sentLoading) return;
          state.sentRequest = (state.sentRequest || 0) + 1;
          state.busy = true;
          syncForm(state);
          sentStatus.textContent = '正在撤回…';
          const result = await call('POST', `${state.base}/shared/${item.id}/revoke`, {});
          if (!isCurrent(state)) return;
          state.busy = false;
          const revoked = result.status === 200 || result.status === 204;
          if (revoked) {
            state.sentItems = state.sentItems.filter(row => row.id !== item.id);
            li.remove();
            sentStatus.textContent = '已撤回分享。';
          } else {
            sentStatus.textContent = messageFor(result.body.error, '无法撤回分享，请重试。');
          }
          syncForm(state);
          if (revoked) close.focus();
        });
        actions.replaceChildren(note, confirm, cancel);
        confirm.focus();
      });
      actions.append(revoke);
      if (state.historyOnly) {
        const title = document.createElement('strong');
        title.textContent = item.title;
        li.append(title);
      }
      li.append(info, actions);
      sent.append(li);
    }
    syncForm(state);
  }

  async function loadSent(state, append = false) {
    if (!isCurrent(state) || (append && (!state.sentCursor || state.sentLoading || state.busy))) return;
    const sequence = state.sentRequest = (state.sentRequest || 0) + 1;
    state.sentLoading = true;
    syncForm(state);
    sentStatus.textContent = '正在加载分享记录…';
    const query = new URLSearchParams(state.historyOnly ? {sent: '1', limit: '100'} : {limit: '100'});
    if (append) query.set('cursor', state.sentCursor);
    const result = await call('GET', state.path + '?' + query, undefined, undefined, state.controller.signal);
    if (!isCurrent(state) || sequence !== state.sentRequest) return;
    state.sentLoading = false;
    if (result.status === 200) {
      const items = result.body.items || [];
      state.sentItems = append ? [...new Map([...state.sentItems, ...items].map(row => [row.id, row])).values()] : items;
      const cursor = result.body.cursor;
      state.sentCursor = typeof cursor === 'string' && (!append || cursor !== state.sentCursor) ? cursor : '';
      renderSent(state, state.sentItems);
    } else {
      sentStatus.textContent = messageFor(result.body.error, '无法加载分享记录。关闭后可重新打开。');
      syncForm(state);
    }
  }

  async function open(target, historyOnly = false) {
    if (!target?.workspace || dialog.open) return;
    const base = `/v1/workspaces/${target.workspace}/meetings`;
    const state = view = {
      workspace: target.workspace, owner:target.owner, meeting: {...target.meeting}, base, historyOnly,
      path: historyOnly ? base + '/shared' : `${base}/${target.meeting.id}/shares`,
      selected: new Set(), busy: false, controller: new AbortController(), sentItems: [],
    };
    control('title').textContent = historyOnly ? '分享记录' : '分享纪要';
    control('lead').textContent = historyOnly ? ''
      : `分享「${state.meeting.title}」的版本 ${state.meeting.revision}。接收人只能查看标题、时间、摘要和行动项。`;
    form.hidden = historyOnly;
    select.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = isMeetingCallId(state.meeting.source_call_id) ? '请选择接收范围' : '请选择会话';
    select.append(option);
    if (isMeetingCallId(state.meeting.source_call_id)) {
      const callOption = document.createElement('option');
      callOption.value = 'call:' + state.meeting.source_call_id;
      callOption.textContent = '这场通话的参会人';
      select.append(callOption);
    }
    select.value = '';
    choices.replaceChildren();
    sent.replaceChildren();
    status.textContent = '';
    feedback.textContent = '正在加载会话…';
    syncForm(state);
    dialog.showModal();
    void loadSent(state);
    if (historyOnly) return;
    const path = `/v1/workspaces/${state.workspace}/social/conversations?limit=100`;
    const result = await call('GET', path, undefined, undefined, state.controller.signal);
    if (!isCurrent(state)) return;
    for (const row of (result.status === 200 ? result.body.items || [] : [])) {
      if (!['group', 'dm'].includes(row.kind) || row.public_agent || row.direct?.open === false) continue;
      const entry = document.createElement('option');
      entry.value = row.id;
      entry.textContent = row.title || (row.members || []).map(member => member.username).filter(Boolean).join('、')
        || (row.kind === 'group' ? '群聊' : '单聊');
      select.append(entry);
    }
    if (!select.value) {
      feedback.textContent = select.options.length > 1 ? '' : result.status !== 200
        ? messageFor(result.body.error, '无法加载会话。关闭后可重新打开。')
        : '当前工作区没有可分享的会话。';
    }
    syncForm(state);
  }
  trigger.addEventListener('click', () => open(context()));
  historyTrigger?.addEventListener('click', () => open({workspace: historyWorkspace()}, true));
  sentMore.addEventListener('click', () => { if (view) return loadSent(view, true); });

  select.addEventListener('change', async () => {
    const state = view;
    if (!state || !isCurrent(state) || state.busy) return;
    state.recipientRequest?.abort();
    state.selected.clear();
    choices.replaceChildren();
    status.textContent = '';
    syncForm(state);
    const conversation = select.value;
    feedback.textContent = conversation ? '正在加载接收人…' : '';
    if (!conversation) return;
    const controller = state.recipientRequest = new AbortController();
    const audience = selectedAudience(state);
    const query = new URLSearchParams(audience);
    const result = await call('GET', `${state.base}/share-recipients?${query}`, undefined, undefined, controller.signal);
    if (!isCurrent(state) || state.recipientRequest !== controller || select.value !== conversation) return;
    if (result.status !== 200) {
      feedback.textContent = result.body.error?.code === 'meeting_call_active'
        ? '通话结束后才能分享纪要。' : result.body.error?.code === 'call_record_not_found'
          ? '无法访问这场通话的参会记录。'
          : messageFor(result.body.error, '无法加载接收人，请重新选择接收范围。');
      return;
    }
    for (const item of result.body.items || []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'recipient';
      box.value = item.id;
      box.addEventListener('change', () => {
        if (!isCurrent(state) || state.busy) return;
        if (box.checked && state.selected.size >= 50) {
          box.checked = false;
          feedback.textContent = '最多选择 50 位接收人。';
          return;
        }
        if (box.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        feedback.textContent = '';
        syncForm(state);
      });
      label.append(box, document.createTextNode(item.name));
      choices.append(label);
    }
    feedback.textContent = choices.children.length ? '' : audience.call_id
      ? '这场通话没有可选择的其他参会人。' : '这个会话中没有可选择的其他接收人。';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = view;
    if (!state || state.historyOnly || !isCurrent(state) || state.busy || !select.value || !state.selected.size) return;
    const body = {revision: state.meeting.revision, ...selectedAudience(state), recipient_ids: [...state.selected].sort()};
    const scope = [state.owner, state.workspace, state.meeting.id, body.revision,
      body.call_id ? 'call' : 'conversation', body.call_id || body.conversation_id, body.recipient_ids];
    const attemptKey = retries.remember(scope);
    state.busy = true;
    syncForm(state);
    status.textContent = '正在分享…';
    const result = await call('POST', state.path, body, {'Idempotency-Key': attemptKey});
    if (!isCurrent(state)) return;
    state.busy = false;
    if (![200, 201].includes(result.status) || !result.body.meeting?.id) {
      const unknown = ambiguousSave(result.status) || result.status === 200 || result.status === 201;
      status.textContent = result.status === 409 ? '纪要已更新。请关闭分享窗口，重新打开会议后再试。'
        : unknown ? '分享结果未确认。可查看分享记录，或选择相同的接收范围和接收人后重试。'
        : messageFor(result.body.error, '分享未确认，请重试。');
      syncForm(state);
      if (unknown) void loadSent(state);
      return;
    }
    retries.confirm(scope, attemptKey);
    state.selected.clear();
    for (const label of choices.children) label.children[0].checked = false;
    status.textContent = '已分享纪要。';
    syncForm(state);
    void loadSent(state);
  });
  close.addEventListener('click', () => { if (!view?.busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (view?.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    view?.controller.abort();
    view?.recipientRequest?.abort();
    view = null;
  });
  return {sync() {
    trigger.hidden = !context();
    if (historyTrigger) historyTrigger.hidden = !historyWorkspace();
    if (dialog.open && !isCurrent(view)) dialog.close();
  }};
}

function sharedActionLink(document, action) {
  const link = document.createElement('a');
  link.href = '/memory?' + new URLSearchParams({workspace:action.workspace_id, page:'todos', action:action.id});
  link.textContent = '打开我的待办';
  return link;
}

function isSavedMeetingAction(action) {
  return meetingIdPattern.test(action?.id || '') && meetingIdPattern.test(action?.workspace_id || '');
}

function hasMeetingActionStatus(action) {
  return isSavedMeetingAction(action) && Number.isSafeInteger(action.revision) && action.revision > 0 &&
    (action.status === 'open' || action.status === 'done');
}

function personalMeetingActionStatus(document, action) {
  const label = document.createElement('span');
  label.className = 'received-action-personal-status';
  label.dataset.done = String(action.status === 'done');
  label.textContent = action.status === 'done' ? '我的待办 · 已完成' : '我的待办 · 未完成';
  return label;
}

export function renderSharedMeeting(document, meeting, {copy, saved = []} = {}) {
  const title = document.getElementById('shared-meeting-title');
  title.textContent = meeting.title;
  document.getElementById('shared-meeting-meta').textContent = [
    meeting.organizer ? '组织者 ' + meeting.organizer : '',
    formatTime(meeting.started_at), `版本 ${meeting.revision}`,
  ].filter(Boolean).join(' · ');
  document.getElementById('shared-meeting-summary').textContent = meeting.summary || '没有摘要。';
  const actions = meeting.action_items || [];
  const list = document.getElementById('shared-meeting-actions');
  list.replaceChildren();
  for (const [index, item] of actions.entries()) {
    const li = document.createElement('li');
    li.dataset.sharedActionIndex = String(index);
    li.tabIndex = -1;
    const text = document.createElement('p');
    text.textContent = item.text;
    const state = document.createElement('p');
    state.className = 'note';
    state.textContent = [item.owner ? '负责人 ' + item.owner : '', item.due_date && '截止日期 ' + item.due_date,
      item.done ? '已完成' : '待完成']
      .filter(Boolean).join(' · ');
    li.append(text, state);
    if (copy && !item.done) {
      const controls = document.createElement('div');
      controls.className = 'shared-meeting-action-controls';
      const savedAction = saved.find(action => action.index === index);
      if (savedAction) {
        controls.append(sharedActionLink(document, savedAction));
        if (hasMeetingActionStatus(savedAction)) controls.append(personalMeetingActionStatus(document, savedAction));
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = '存入我的待办';
        const feedback = document.createElement('span');
        feedback.className = 'note';
        feedback.setAttribute('role', 'status');
        button.addEventListener('click', async () => {
          button.disabled = true;
          feedback.textContent = '正在保存…';
          const result = await copy(index);
          if (!result) return;
          if (result.action) {
            const link = sharedActionLink(document, result.action);
            button.replaceWith(link);
            feedback.textContent = '已保存到个人空间。';
            if (hasMeetingActionStatus(result.action)) controls.append(personalMeetingActionStatus(document, result.action));
            link.focus({preventScroll:true});
          } else {
            button.disabled = false;
            feedback.textContent = result.error;
          }
        });
        controls.append(button, feedback);
      }
      li.append(controls);
    }
    list.append(li);
  }
  list.hidden = !actions.length;
  document.getElementById('shared-meeting-no-actions').hidden = Boolean(actions.length);
  document.getElementById('shared-meeting-detail').hidden = false;
  title.focus();
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('meeting-form');
  const workspaceSelect = document.getElementById('workspace');
  const newButton = document.getElementById('new-meeting');
  const back = document.getElementById('meeting-library');
  const mobileLibrary = document.getElementById('meeting-library-mobile');
  const mobileBack = document.getElementById('meeting-back-to-list');
  const layout = document.getElementById('meeting-layout');
  const save = document.getElementById('save-meeting');
  const mobileSave = document.getElementById('save-meeting-mobile');
  const saveStatus = document.getElementById('meeting-save-status');
  const actionList = document.getElementById('action-list');
  const addAction = document.getElementById('add-action');
  const actionStatus = document.getElementById('meeting-action-status');
  const actionProgress = document.getElementById('meeting-action-progress');
  const remove = document.getElementById('remove-meeting');
  const deleteDialog = document.getElementById('meeting-delete-dialog');
  const actionCopyDialog = document.getElementById('meeting-action-copy-dialog');
  const actionCopyTitle = document.getElementById('meeting-action-copy-title');
  const actionCopyNotes = document.getElementById('meeting-action-copy-notes');
  const actionCopyDate = document.getElementById('meeting-action-copy-date');
  const actionCopyLink = document.getElementById('meeting-action-copy-link');
  const actionCopySubmit = document.getElementById('meeting-action-copy-submit');
  const actionCopyClose = document.getElementById('meeting-action-copy-close');
  const actionCopyStatus = document.getElementById('meeting-action-copy-status');
  const unsavedDialog = document.getElementById('meeting-unsaved-dialog');
  const unsavedMessage = document.getElementById('meeting-unsaved-message');
  const filters = document.getElementById('meeting-list-filters');
  const search = document.getElementById('meeting-search');
  const openOnly = document.getElementById('meeting-open-only');
  const listMore = document.getElementById('meeting-list-more');
  const listRetry = document.getElementById('meeting-list-retry');
  const listStatus = document.getElementById('meeting-list-status');
  const resume = document.getElementById('meeting-resume');
  const inbox = document.getElementById('meeting-inbox');
  const inboxOpen = document.getElementById('meeting-inbox-open');
  const inboxReturn = document.getElementById('meeting-inbox-return');
  const sharedInboxReturn = document.getElementById('shared-meeting-inbox-return');
  const inboxList = document.getElementById('meeting-inbox-list');
  const main = document.getElementById('main');
  const inboxHeading = document.getElementById('meeting-inbox-heading');
  const inboxSource = document.getElementById('meeting-inbox-source');
  const inboxState = document.getElementById('meeting-inbox-state');
  const inboxMine = document.getElementById('meeting-inbox-mine');
  const inboxMore = document.getElementById('meeting-inbox-more');
  const inboxStatus = document.getElementById('meeting-inbox-status');
  const inboxEmpty = document.getElementById('meeting-inbox-empty');
  const copyDestinations = ['artifact', 'memory'].map(kind => ({
    kind,
    button: document.getElementById('save-meeting-' + kind),
    status: document.getElementById('meeting-' + kind + '-status'),
    link: document.getElementById('meeting-' + kind + '-link'),
  }));
  const native = servedByDsBot(document);
  let workspaceLoad = 0;
  let libraryOrigin = null;
  let viewer = '';
  let viewerId = '';
  if (!status || !loginPanel || !mainPanel || !form) return;
  for (const button of document.querySelectorAll('#meeting-detail-nav [data-meeting-section]')) {
    const target = document.getElementById(button.dataset.meetingSection);
    button.addEventListener('click', () => {
      target.focus({preventScroll: true});
      target.scrollIntoView({block: 'start'});
    });
  }
  let current = null;
  let receivedMeeting = null;
  let callDraft = null;
  const callSource = document.getElementById('meeting-call-source');
  const sharedDetail = document.getElementById('shared-meeting-detail');
  const emptyDetail = document.getElementById('meeting-empty');
  const sharing = mountMeetingShares(document, {
    request,
    context: () => native && current?.id && workspaceId() && layout?.dataset.view !== 'catalogue'
      ? {owner:viewerId, workspace: workspaceId(), meeting: current} : null,
    historyWorkspace: () => servedByDsBot(document) && !document.getElementById('meeting-list-pane')?.hidden
      ? workspaceId() : '',
  });
  function notesContext() {
    const workspace = workspaceId();
    if (!native || !meetingIdPattern.test(viewerId)) return null;
    if (receivedMeeting?.workspace === workspace && !sharedDetail.hidden) {
      return {owner:viewerId, workspace, meeting:receivedMeeting.meeting, shared:true};
    }
    return current?.id && current.workspace_id === workspace && !form.hidden &&
      layout?.dataset.view !== 'catalogue' ? {owner:viewerId, workspace, meeting:current, shared:false} : null;
  }
  const printing = mountMeetingPrint(document, {
    context: () => {
      const notes = notesContext();
      return form.inert && !notes?.shared ? null : notes;
    },
    formatTime,
  });
  const discussion = mountMeetingDiscussion(document, {
    request,
    context: notesContext,
    isDirty: hasUnsavedChanges,
    openChat: href => document.defaultView.location.assign(href),
  });
  let meetings = [];
  let listCursor = '';
  let listVersion;
  let listRequest = null;
  let retryList = null;
  let searchTimer;
  let catalogueOrigin = '';
  let catalogueSize = 0;
  let catalogueTranscript = false;
  let inboxView = null;
  let inboxResume = null;
  const inboxWrites = new Set();
  let actions = [];
  let actionBoxes = [];
  let actionFollowups = [];
  let actionCopy = null;
  let copyingNotes = null;
  let writing = null;
  let saveRetry = null;
  let saveConflict = false;
  let conflictRead = null;
  let savedDraft = null;
  let editingWorkspace = '';
  let editorBaseRevision = 0;
  let editorReady = false;
  let chatDraftEditor = '';
  let continueNavigation = null;
  let watchingLeave = false;
  let deleting = null;
  const attendeeInput = document.getElementById('meeting-attendees');
  const attendeeList = document.getElementById('attendee-matches');
  let memberCache = {workspace: '', items: [], failed: false};
  let attendeeActive = -1;
  let selection = 0;
  const titleInput = document.getElementById('meeting-title');
  const transcript = document.getElementById('meeting-transcript');
  const transcriptSearch = mountTranscriptSearch(document, transcript);
  let transcriptImporter, transcriptImporterLoad;
  function transcriptImportScope() {
    const workspace = workspaceId();
    if (!native || !editorReady || form.hidden || form.inert || layout?.dataset.view !== 'editor' || layout.hidden ||
        !meetingIdPattern.test(viewerId) || !meetingIdPattern.test(workspace)) return '';
    return JSON.stringify([viewerId, workspace, selection]);
  }
  function syncTranscriptImport() {
    if (!transcriptImportScope()) return;
    transcriptImporterLoad ??= import('./transcript-import.mjs').then(({mountTranscriptImport}) => {
      const dialog = document.getElementById('meeting-transcript-import-dialog');
      if (typeof dialog?.showModal !== 'function') return;
      transcriptImporter = mountTranscriptImport(document, {transcript, scope:transcriptImportScope});
    }).catch(() => { transcriptImporterLoad = undefined; });
    void transcriptImporterLoad.then(() => transcriptImporter?.sync());
  }
  const audio = mountMeetingAudio(document, {request, base, transcript, onPendingChange: syncLeaveProtection});
  const summary = document.getElementById('meeting-summary');
  const reviewConflict = document.getElementById('review-meeting-conflict');
  const conflictDialog = document.getElementById('meeting-conflict-dialog');
  const conflictFields = document.getElementById('meeting-conflict-fields');
  const applyConflict = document.getElementById('apply-meeting-conflict');
  const draftPanel = document.getElementById('meeting-draft');
  const draftButton = document.getElementById('generate-meeting-draft');
  const stopDraftButton = document.getElementById('stop-meeting-draft-wait');
  const draftStatus = document.getElementById('meeting-draft-status');
  const draftTop = document.getElementById('meeting-draft-top');
  const draftControls = document.getElementById('meeting-draft-controls');
  const draftReview = document.getElementById('meeting-draft-review');
  const draftHeading = document.getElementById('meeting-draft-heading');
  const draftReviewError = document.getElementById('meeting-draft-review-error');
  const smallDraftViewport = globalThis.matchMedia?.('(max-width: 700px)');
  let draft = null;
  const draftRequests = new Map();
  let storedDraft = null;
  let draftPoll = 0;
  let openRetry = null;

  filters.hidden = !native;

  function show(kind, text) {
    openRetry = null;
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function showAction(kind, text) {
    actionStatus.dataset.kind = kind;
    actionStatus.textContent = text;
  }

  function readDetail(path) {
    return request('GET', path, undefined, undefined, AbortSignal.timeout(DETAIL_READ_TIMEOUT_MS))
      .catch(() => unavailable);
  }

  function showOpenError(result, message, reopen) {
    show('error', message);
    if (result.status && ![408, 429].includes(result.status) && result.status < 500) return;
    const target = scope();
    const account = viewerId;
    const button = openRetry = document.createElement('button');
    button.type = 'button';
    button.id = 'meeting-open-retry';
    button.className = 'secondary';
    button.textContent = '重试打开';
    button.addEventListener('click', () => confirmNavigation(async () => {
      if (openRetry !== button || !active(target) || viewerId !== account) return;
      await reopen();
      if (document.activeElement === document.body) openRetry?.focus();
    }));
    status.append(button);
  }

  function clearOpenRetry() {
    if (openRetry) show('', '');
  }

  function showSave(kind, text) {
    saveStatus.dataset.kind = kind;
    saveStatus.textContent = text;
  }

  function resetSave() {
    saveRetry = null;
    saveConflict = false;
    conflictRead = null;
    if (conflictDialog?.open) conflictDialog.close();
    showSave('', '');
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  const sameInboxScope = state => state.owner === viewerId && state.viewer === viewer && state.workspace === workspaceId();
  const currentInbox = state => state === inboxView && sameInboxScope(state);
  const inboxKey = (state, item) => `${state.viewer}/${state.workspace}/${item.meeting_id}`;
  const receivedActionKey = (state, item) => `${inboxKey(state, item)}/${item.revision}/${item.action_index}`;

  function inboxPosition(control = document.activeElement) {
    const row = control?.closest?.('li[data-action]');
    if (row?.parentElement !== inboxList || !control.dataset.inboxControl) return null;
    return {key:row.dataset.action, index:Array.from(inboxList.children).indexOf(row),
      control:control.dataset.inboxControl, top:control.getBoundingClientRect().top};
  }

  function focusInboxPosition(position, restorePosition = false) {
    if (!position) return;
    const rows = Array.from(inboxList.children);
    const original = rows.find(item => item.dataset.action === position.key);
    const row = original || rows[Math.min(position.index, rows.length - 1)];
    const control = row?.querySelector(`[data-inbox-control="${position.control}"]:not(:disabled)`) ||
      row?.querySelector('button[data-inbox-control="source"]');
    (control || inboxHeading).focus({preventScroll:true});
    if (restorePosition && original && control) {
      main.scrollTop += control.getBoundingClientRect().top - position.top;
    }
  }

  function renderInbox(state, position = inboxPosition()) {
    const scrollTop = main.scrollTop;
    inboxList.replaceChildren();
    for (const item of state.items) {
      const row = document.createElement('li');
      row.dataset.action = `${item.meeting_id}.${item.action_index}`;
      const copy = document.createElement('div');
      const text = document.createElement('strong');
      text.textContent = item.text;
      const details = document.createElement('p');
      details.className = 'note';
      details.textContent = [item.meeting_title, state.received ? item.organizer : item.owner || '未分配负责人',
        item.due_date && '截止日期 ' + item.due_date]
        .filter(Boolean).join(' · ');
      copy.append(text, details);
      const buttons = document.createElement('div');
      buttons.className = 'meeting-inbox-buttons';
      const source = document.createElement('button');
      source.type = 'button';
      source.dataset.inboxControl = 'source';
      const retry = state.retryMeeting;
      source.textContent = retry?.meeting_id === item.meeting_id && retry.action_index === item.action_index &&
        retry.revision === item.revision ? '重试打开会议' : state.received ? '查看共享纪要' : '查看会议';
      source.addEventListener('click', () => {
        if (!currentInbox(state)) return;
        return confirmNavigation(async () => {
          if (!currentInbox(state)) return;
          inboxResume = {state, position:inboxPosition(source), scrollTop:main.scrollTop};
          setInbox(false, {focus:false});
          const expectedSelection = selection + 1;
          const action = {index:item.action_index, revision:item.revision};
          const opened = state.received ? await openSharedMeeting(item.meeting_id, undefined, action)
            : await openMeeting(item.meeting_id, undefined, undefined,
              {...action, inbox:true, mine:state.mine, completed:state.completed});
          if (!opened && selection === expectedSelection && !inboxView && sameInboxScope(state)) {
            const notice = openRetry ? status.firstChild?.textContent || '' : status.textContent;
            const retryMeeting = openRetry ? item : null;
            show('', '');
            setInbox(true, {notice, retryMeeting});
          }
        });
      });
      buttons.append(source);
      if (state.received) {
        const saved = item.saved_action;
        const hasSaved = isSavedMeetingAction(saved);
        const pending = inboxWrites.has(receivedActionKey(state, item));
        const control = hasSaved ? sharedActionLink(document, saved) : document.createElement('button');
        if (!hasSaved) {
          control.type = 'button';
          control.textContent = pending ? '正在保存…' : '存入我的待办';
          control.disabled = pending;
          control.addEventListener('click', () => copyReceivedInboxAction(state, item, control));
        }
        control.dataset.inboxControl = 'memory';
        buttons.append(control);
        if (hasMeetingActionStatus(saved)) {
          copy.append(personalMeetingActionStatus(document, saved));
          const statusButton = document.createElement('button');
          statusButton.type = 'button';
          statusButton.className = 'secondary';
          statusButton.dataset.inboxControl = 'memory-status';
          statusButton.textContent = pending ? '正在更新…' : saved.status === 'done' ? '重开我的待办' : '完成我的待办';
          statusButton.disabled = pending;
          statusButton.addEventListener('click', () => runReceivedInboxAction(state, item, statusButton, '正在更新…',
            () => changePersonalMeetingActionStatus(state, item, saved)));
          buttons.append(statusButton);
        }
      } else {
        if (!state.completed) {
          const followup = automationFollowupLink(document);
          followup.dataset.inboxControl = 'followup';
          followup.href = automationFollowupHref(state.workspace, item.meeting_id, item.action_index, item.revision);
          buttons.append(followup);
        }
        const done = document.createElement('button');
        done.type = 'button';
        done.dataset.inboxControl = 'status';
        done.textContent = state.completed ? '重新打开' : '标记完成';
        done.disabled = inboxWrites.has(inboxKey(state, item));
        done.addEventListener('click', () => changeInboxAction(state, item, done));
        buttons.append(done);
      }
      row.append(copy, buttons);
      inboxList.append(row);
    }
    inboxMore.hidden = !state.cursor;
    inboxMore.disabled = Boolean(state.request);
    inboxEmpty.hidden = !state.loaded || state.items.length > 0;
    inboxEmpty.textContent = state.received ? '收到的纪要里没有分配给你的待办。' : state.completed
      ? state.mine ? '没有分配给你的已完成行动项。' : '没有已完成的会议行动项。'
      : state.mine ? '没有分配给你的待办行动项。' : '没有待完成的会议行动项。';
    main.scrollTop = scrollTop;
    focusInboxPosition(position, true);
  }

  async function loadInbox(state, {append = false, notice = '', minimum = Math.max(20, state.items.length)} = {}) {
    if (!currentInbox(state) || (append && (!state.cursor || state.request))) return;
    const firstNew = state.items.length;
    const paging = append && document.activeElement === inboxMore;
    state.request?.abort();
    const controller = state.request = new AbortController();
    inboxMore.disabled = true;
    inboxList.setAttribute('aria-busy', 'true');
    inboxStatus.textContent = '正在读取行动项…';
    let cursor = append ? state.cursor : '';
    let version = append ? state.version : undefined;
    const items = append ? [...state.items] : [];
    const seen = new Set(items.map(item => `${item.meeting_id}.${item.action_index}`));
    const cursors = new Set(cursor ? [cursor] : []);
    const target = append ? items.length + 20 : minimum;
    let failure = '';
    do {
      const params = new URLSearchParams({view:'actions', limit: String(Math.min(50, target - items.length))});
      if (state.mine) params.set('mine', '1');
      if (state.completed) params.set('status', 'completed');
      if (cursor) params.set('cursor', cursor);
      const path = `/v1/workspaces/${state.workspace}/meetings${state.received ? '/shared' : ''}`;
      const result = await request('GET', `${path}?${params}`, undefined, undefined, controller.signal)
        .catch(() => unavailable);
      if (!currentInbox(state) || state.request !== controller) return;
      const wrongScope = result.status === 200 &&
        (result.body.workspace_id !== state.workspace || result.body.viewer_username !== state.viewer);
      if (wrongScope || [401, 403, 404].includes(result.status)) {
        state.items = [];
        state.cursor = '';
        state.loaded = false;
        renderInbox(state);
        failure = '无法访问这个工作区的行动项。';
        break;
      }
      if (result.status !== 200 || !Array.isArray(result.body.items)) {
        failure = '无法读取行动项，请刷新重试。';
        break;
      }
      if (!state.received && cursor && result.body.activity_version !== version) {
        if (append) return loadInbox(state, {minimum, notice:'会议记录有更新，已重新加载行动项。'});
        failure = '会议记录有更新，请刷新行动项。';
        break;
      }
      version = result.body.activity_version;
      for (const row of result.body.items) {
        const item = state.received ? {...row, meeting_id:row?.share_id} : row;
        const key = `${item?.meeting_id}.${item?.action_index}`;
        if (!meetingIdPattern.test(item?.meeting_id || '') || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
            !Number.isInteger(item.action_index) || item.action_index < 0 || item.action_index >= 50 ||
            typeof item.text !== 'string' || typeof item.meeting_title !== 'string' || typeof item.owner !== 'string' || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
      const next = result.body.cursor;
      const cursorPattern = state.received ? /^[0-9a-f]{32}\.(?:[0-9]|[1-4][0-9])$/ : /^\d{1,10}\.[0-9a-f]{32}\.\d{1,2}$/;
      cursor = typeof next === 'string' && cursorPattern.test(next) && !cursors.has(next) ? next : '';
      if (cursor) cursors.add(cursor);
    } while (cursor && items.length < target);
    state.request = null;
    inboxList.setAttribute('aria-busy', 'false');
    if (failure) {
      inboxMore.disabled = false;
      inboxStatus.textContent = [notice, failure].filter(Boolean).join(' ');
      return;
    }
    state.version = version;
    state.loaded = true;
    state.items = items;
    state.cursor = cursor;
    const requestedMore = paging && (document.activeElement === inboxMore || document.activeElement === document.body);
    inboxStatus.textContent = notice;
    renderInbox(state);
    if (requestedMore && items.length > firstNew) {
      inboxList.children[firstNew]?.querySelector('button[data-inbox-control="source"]')?.focus();
    }
  }

  async function changeInboxAction(state, item, button) {
    const key = inboxKey(state, item);
    if (!currentInbox(state) || inboxWrites.has(key)) return;
    inboxWrites.add(key);
    const done = !state.completed;
    const position = inboxPosition(button);
    button.disabled = true;
    button.textContent = done ? '正在完成…' : '正在重新打开…';
    const path = `/v1/workspaces/${state.workspace}/meetings/${item.meeting_id}`;
    const result = await saveRequest('POST', path + '/action', {index:item.action_index, revision:item.revision, done});
    let meeting = result.body.meeting;
    const matchesRevision = ({status, body:{viewer_username, meeting:record}}) => status === 200 &&
      viewer_username === state.viewer && record?.id === item.meeting_id &&
      record.workspace_id === state.workspace && record.revision === item.revision + 1;
    const sameAction = action => action?.text === item.text && (action.owner || '') === item.owner &&
      (action.due_date || '') === (item.due_date || '');
    let success = matchesRevision(result) && result.body.action?.index === item.action_index && result.body.action.done === done;
    if (!success && sameInboxScope(state) && (ambiguousSave(result.status) || result.status === 200)) {
      button.textContent = '正在确认…';
      const checked = await saveRequest('GET', path);
      meeting = checked.body.meeting;
      const action = meeting?.action_items?.[item.action_index];
      success = matchesRevision(checked) && action?.done === done && sameAction(action);
    }
    inboxWrites.delete(key);
    if (!sameInboxScope(state)) return;
    if (success && current?.id === item.meeting_id && current.revision === item.revision && !writing && !saveRetry && !saveConflict) {
      const saved = current.action_items[item.action_index];
      if (sameAction(saved)) {
        saved.done = done;
        current.revision = meeting.revision;
        const draft = actions.find(row => row.savedIndex === item.action_index && sameAction(row));
        if (draft) draft.done = done;
        noteSavedAction(item.action_index, done);
        clearNoteCopies();
        document.getElementById('meeting-meta').textContent = '修订 ' + current.revision + ' · 创建者 ' + current.created_by;
        renderActions();
      }
    }
    if (!currentInbox(state)) {
      if (inboxView) void loadInbox(inboxView);
      return;
    }
    const minimum = Math.max(20, state.items.length);
    const keepPosition = document.activeElement === button || document.activeElement === document.body;
    if (success) {
      state.items = state.items.filter(row => row.meeting_id !== item.meeting_id || row.action_index !== item.action_index);
      renderInbox(state, keepPosition ? position : inboxPosition());
    } else if (button.isConnected) {
      button.disabled = false;
      button.textContent = done ? '标记完成' : '重新打开';
    }
    const notice = success ? (done ? '已标记完成。' : '已重新打开，行动项已回到待完成。')
      : result.status === 409 ? '会议已更新，请核对最新行动项。' : '暂时无法确认行动项状态，请核对最新行动项。';
    if (!success && keepPosition) focusInboxPosition(position);
    await loadInbox(state, {notice, minimum});
  }

  function copyReceivedInboxAction(state, item, button) {
    return runReceivedInboxAction(state, item, button, '正在保存…', async () => {
      const copied = await copySharedAction(state, item.meeting_id, item.revision, item.action_index);
      return {...copied, notice:copied.action ? '已保存到个人空间。' : copied.error};
    });
  }

  async function runReceivedInboxAction(state, item, button, pendingLabel, perform) {
    const key = receivedActionKey(state, item);
    if (!currentInbox(state) || inboxWrites.has(key)) return;
    const position = inboxPosition(button);
    inboxWrites.add(key);
    button.disabled = true;
    button.textContent = pendingLabel;
    const result = await perform().catch(() => ({notice:'暂时无法确认个人待办，请重试。'}));
    inboxWrites.delete(key);
    if (!sameInboxScope(state)) return;
    const visible = inboxView;
    if (!visible?.received || !currentInbox(visible)) return;
    const shown = visible.items.find(action => receivedActionKey(visible, action) === key);
    if (!shown) return;
    if (result.action !== undefined && (!result.action || !(shown.saved_action?.revision > result.action.revision))) {
      shown.saved_action = result.action;
    }
    const {notice} = result;
    const keepPosition = document.activeElement === button || (button.isConnected && document.activeElement === document.body);
    inboxStatus.textContent = notice;
    renderInbox(visible, keepPosition ? position : inboxPosition());
    if (result.sourceUnavailable || visible.request) void loadInbox(visible, {notice});
  }

  async function changePersonalMeetingActionStatus(state, item, saved) {
    const status = saved.status === 'done' ? 'open' : 'done';
    const path = `/v1/workspaces/${saved.workspace_id}/memory/actions/${saved.id}`;
    const result = await saveRequest('POST', path, {revision:saved.revision, changes:{status}});
    let action = result.status === 200 ? result.body?.action : result.body?.error?.current;
    let unavailable = result.status === 404;
    if (!action && sameInboxScope(state) && (ambiguousSave(result.status) || result.status === 200)) {
      const checked = await saveRequest('GET', path);
      if (checked.status === 200) action = checked.body?.action;
      unavailable = checked.status === 404;
    }
    if (unavailable) return {action:null, sourceUnavailable:true, notice:'找不到这条个人待办。可以重新存入。'};
    const source = action?.source;
    const valid = hasMeetingActionStatus(action) && action.id === saved.id &&
      action.workspace_id === saved.workspace_id && action.revision > saved.revision &&
      source?.kind === 'shared_meeting' && source.workspace_id === state.workspace &&
      source.share_id === item.meeting_id && source.revision === item.revision && source.action_index === item.action_index;
    if (!valid) return {notice:'暂时无法确认个人待办的状态，请刷新后重试。'};
    const {id, workspace_id, revision} = action;
    return {action:{id, workspace_id, revision, status:action.status},
      notice:action.status !== status ? '我的待办已在别处更新。请核对后重试。'
        : status === 'done' ? '已完成我的待办。' : '已重开我的待办。'};
  }

  function setInbox(open, {focus = true, notice = '', retryMeeting = null} = {}) {
    if (!inbox || !native || (open && (!viewer || !workspaceId()))) return;
    if (inboxView?.request) {
      inboxView.request.abort();
      inboxView.request = null;
    }
    inboxView = null;
    inbox.hidden = !open;
    layout.hidden = open;
    if (open) transcriptImporter?.reset();
    else syncTranscriptImport();
    inboxOpen.setAttribute('aria-expanded', String(open));
    if (open) {
      clearOpenRetry();
      const received = inboxSource?.value === 'received';
      const mine = !received && inboxMine.checked, completed = !received && inboxState?.value === 'completed';
      for (const field of [inboxMine, inboxState]) {
        const label = field?.closest?.('label');
        if (label) label.hidden = received;
      }
      const saved = inboxResume;
      inboxResume = null;
      const resumable = saved && sameInboxScope(saved.state) && saved.state.received === received &&
        saved.state.mine === mine && saved.state.completed === completed;
      inboxView = resumable ? saved.state : {workspace:workspaceId(), owner:viewerId, viewer, received, mine, completed,
        items:[], cursor:'', loaded:false};
      inboxView.retryMeeting = retryMeeting;
      if (resumable) main.scrollTop = saved.scrollTop;
      renderInbox(inboxView, resumable ? saved.position : null);
      if (!resumable && focus) {
        main.scrollTop = 0;
        inboxHeading.focus({preventScroll:true});
      }
      void loadInbox(inboxView, {notice});
    } else if (focus) {
      const narrow = globalThis.matchMedia?.('(max-width: 700px)').matches;
      (narrow && inboxReturn && !inboxReturn.hidden ? inboxReturn : inboxOpen).focus();
    }
  }

  function base() {
    return `/v1/workspaces/${workspaceId()}/meetings`;
  }

  function scope() {
    return {workspace: workspaceId(), selection, viewer};
  }

  function active(target) {
    return workspaceId() === target.workspace && selection === target.selection && viewer === target.viewer;
  }

  function syncWriting() {
    const pending = writing && active(writing) ? writing : null;
    const retry = saveRetry && active(saveRetry);
    save.disabled = Boolean(pending || saveConflict);
    save.formNoValidate = Boolean(retry);
    if (mobileSave) {
      mobileSave.disabled = save.disabled;
      mobileSave.formNoValidate = Boolean(retry);
    }
    const blocked = Boolean(pending || retry || saveConflict);
    remove.disabled = blocked;
    if (reviewConflict) {
      reviewConflict.hidden = !saveConflict || !current?.id;
      reviewConflict.disabled = Boolean(pending || conflictRead);
    }
    const label = pending?.kind === 'save' ? '保存中…' : retry ? '确认并重试保存' : '保存';
    save.textContent = label;
    if (mobileSave) mobileSave.textContent = label;
    for (const [index, box] of actionBoxes.entries()) {
      const savingThisAction = pending?.action === actions[index];
      box.disabled = blocked && !savingThisAction;
      if (savingThisAction) box.setAttribute('aria-disabled', 'true');
      else box.removeAttribute('aria-disabled');
    }
    const listedActions = actions.filter(item => item.text?.trim());
    actionProgress.hidden = !listedActions.length;
    const progress = listedActions.length ? `${listedActions.filter(item => item.done).length}/${listedActions.length} 已完成` : '';
    if (actionProgress.textContent !== progress) actionProgress.textContent = progress;
    syncSavedActions(blocked);
    syncLeaveProtection();
  }

  function syncSavedActions(pending) {
    discussion.sync(pending);
    printing.sync(pending);
    const saved = native && Boolean(current?.id);
    for (const {button} of copyDestinations) {
      button.hidden = !saved;
      button.disabled = !saved || pending || Boolean(copyingNotes && active(copyingNotes));
    }
    for (const {link, copy, action} of actionFollowups) {
      const item = saved && current.action_items?.[action.savedIndex];
      link.hidden = !item || item.done || action.done;
      const available = !link.hidden && !pending && action.text === item.text && (action.owner || '') === (item.owner || '') &&
        (action.due_date || '') === (item.due_date || '');
      copy.hidden = link.hidden || !actionCopyDialog;
      copy.disabled = !available;
      if (!available) {
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        link.title = '请先保存行动项';
        continue;
      }
      link.href = automationFollowupHref(workspaceId(), current.id, action.savedIndex, current.revision);
      link.removeAttribute('aria-disabled');
      link.title = '';
    }
  }

  function openActionCopy(action, button) {
    const item = current?.action_items?.[action.savedIndex];
    if (!item || button.disabled || actionCopyDialog.open) return;
    actionCopy = {...scope(), id:current.id, revision:current.revision, index:action.savedIndex,
      key:meetingKey('meeting-action-'), busy:false, button};
    const text = item.text.trim();
    const title = text.replace(/\s+/g, ' ');
    actionCopyTitle.value = title.length <= 80 ? title : title.slice(0, 79).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
    const date = item.due_date || '';
    actionCopyDate.value = date >= actionCopyDate.min && date <= actionCopyDate.max ? date : '';
    actionCopyNotes.value = [text !== actionCopyTitle.value ? text : '',
      item.owner ? `原负责人 ${item.owner}` : '', date && !actionCopyDate.value ? `原截止日期 ${date}` : ''].filter(Boolean).join('\n');
    document.getElementById('meeting-action-copy-source').textContent = `来自「${current.title}」的行动项 · 修订 ${current.revision}`;
    actionCopyStatus.textContent = '';
    actionCopyClose.textContent = '取消';
    actionCopySubmit.hidden = false;
    actionCopySubmit.disabled = false;
    actionCopyLink.hidden = true;
    actionCopyLink.removeAttribute('href');
    for (const input of [actionCopyTitle, actionCopyNotes, actionCopyDate]) input.readOnly = false;
    actionCopyDialog.showModal();
  }

  actionCopyClose?.addEventListener('click', () => { if (!actionCopy?.busy) actionCopyDialog.close(); });
  actionCopyDialog?.addEventListener('cancel', event => { if (actionCopy?.busy) event.preventDefault(); });
  actionCopyDialog?.addEventListener('close', () => {
    const closed = actionCopy;
    actionCopy = null;
    if (closed?.button.isConnected && active(closed)) closed.button.focus({preventScroll:true});
  });
  function finishActionCopy(target) {
    if (actionCopy !== target) return false;
    target.busy = false;
    actionCopySubmit.disabled = false;
    actionCopyClose.disabled = false;
    for (const input of [actionCopyTitle, actionCopyNotes, actionCopyDate]) input.readOnly = false;
    if (active(target)) return true;
    actionCopyDialog.close();
    return false;
  }
  document.getElementById('meeting-action-copy-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const target = actionCopy;
    if (!target || target.busy || actionCopySubmit.hidden || !active(target) || current?.id !== target.id ||
        current.revision !== target.revision) return;
    target.busy = true;
    actionCopySubmit.disabled = true;
    actionCopyClose.disabled = true;
    for (const input of [actionCopyTitle, actionCopyNotes, actionCopyDate]) input.readOnly = true;
    actionCopyStatus.textContent = '正在保存待办…';
    const listing = await request('GET', '/v1/workspaces?scope=personal').catch(() => unavailable);
    if (actionCopy !== target) return;
    if (!active(target)) { finishActionCopy(target); return; }
    const workspace = listing.status === 200 && listing.body.items?.find(item => item.kind === 'personal')?.id;
    if (!meetingIdPattern.test(workspace || '')) {
      finishActionCopy(target);
      actionCopyStatus.textContent = '暂时无法读取个人空间，请重试。';
      return;
    }
    const source = {workspace_id:target.workspace, meeting_id:target.id, action_index:target.index, revision:target.revision};
    const date = actionCopyDate.value;
    const result = await request('POST', `/v1/workspaces/${workspace}/memory/actions/from-meeting`, {
      source, title:actionCopyTitle.value.trim(), notes:actionCopyNotes.value,
      due_at:date ? Date.parse(date + 'T00:00:00Z') / 1000 : null,
    }, {'Idempotency-Key':target.key}).catch(() => unavailable);
    if (!finishActionCopy(target)) return;
    const action = result.body.action;
    if (![200,201].includes(result.status) || action?.workspace_id !== workspace || !meetingIdPattern.test(action.id || '')) {
      actionCopyStatus.textContent = messageFor(result.body.error, '暂时无法保存待办，请重试。');
      return;
    }
    actionCopyStatus.textContent = result.status === 201 ? '已保存到个人空间。' : '这条行动项已在个人待办中。';
    actionCopyLink.href = '/memory?' + new URLSearchParams({workspace,page:'todos',action:action.id});
    actionCopyLink.hidden = false;
    actionCopySubmit.hidden = true;
    actionCopyClose.textContent = '关闭';
    for (const input of [actionCopyTitle, actionCopyNotes, actionCopyDate]) input.readOnly = true;
    actionCopyLink.focus({preventScroll:true});
  });

  function clearNoteCopies() {
    for (const {status, link} of copyDestinations) {
      status.textContent = '';
      link.hidden = true;
      link.removeAttribute('href');
    }
  }

  async function copySavedNotes({kind, button, status, link}) {
    if (!native || !current?.id || button.disabled) return;
    const target = {...scope(), id: current.id, revision: current.revision};
    copyingNotes = target;
    clearNoteCopies();
    syncWriting();
    status.textContent = `正在复制修订 ${target.revision} 的纪要…`;
    const result = await request('POST', `${base()}/${target.id}/${kind}`, {revision: target.revision}).catch(() => unavailable);
    if (copyingNotes === target) copyingNotes = null;
    if (!active(target) || current?.id !== target.id) return;
    syncWriting();
    if (current.revision !== target.revision) return;
    const receipt = result.body[kind];
    if (![200, 201].includes(result.status) || !meetingIdPattern.test(receipt?.id || '') ||
        (receipt.workspace_id && receipt.workspace_id !== target.workspace)) {
      status.textContent = result.status === 409 ? '会议已在别处更新，请重新打开后再保存纪要。'
        : messageFor(result.body.error, '无法保存纪要，请重试。');
      return;
    }
    const workspace = target.workspace;
    link.hidden = false;
    if (kind === 'memory') {
      link.href = '/memory?' + new URLSearchParams({workspace, page: receipt.id});
      if (result.body.state === 'edited') {
        status.textContent = '记忆页已单独编辑，已保留你的修改。可打开记忆页继续整理。';
      } else {
        status.textContent = `修订 ${target.revision} 的纪要已存入记忆。` +
          (result.body.truncated ? ' 内容较长，完整纪要可从记忆页的来源链接查看。' : '');
      }
    } else {
      link.href = '/space?' + new URLSearchParams({workspace, artifact: receipt.id});
      status.textContent = result.status === 201
        ? `修订 ${target.revision} 的纪要已保存到资料空间。`
        : `修订 ${target.revision} 的纪要已在资料空间。`;
    }
  }

  for (const destination of copyDestinations) {
    destination.button.addEventListener('click', () => copySavedNotes(destination));
  }

  function rememberCatalogue(url) {
    const history = globalThis.history;
    if (!history?.replaceState || !globalThis.location) return;
    const workspace = workspaceId();
    const state = {...history.state};
    if (native && meetingIdPattern.test(viewerId) && meetingIdPattern.test(workspace)) {
      state.meetingCatalogue = {owner:viewerId, workspace, query:search.value.trim().slice(0, 80), open:openOnly.checked,
        origin:catalogueOrigin, size:catalogueSize, transcript:catalogueTranscript};
    }
    history.replaceState(state, '', url ?? globalThis.location.href);
  }

  function restoreCatalogue() {
    const saved = native && globalThis.history?.state?.meetingCatalogue;
    const matching = saved && meetingIdPattern.test(viewerId) && saved.owner === viewerId && saved.workspace === workspaceId();
    search.value = matching && typeof saved.query === 'string' ? saved.query.slice(0, 80) : '';
    openOnly.checked = Boolean(matching && saved.open === true);
    catalogueOrigin = matching && meetingIdPattern.test(saved.origin) ? saved.origin : '';
    catalogueSize = matching && Number.isInteger(saved.size) ? Math.max(0, Math.min(saved.size, 100)) : 0;
    catalogueTranscript = Boolean(catalogueOrigin && matching && saved.transcript === true);
  }

  function rewriteLocation(params, workspace = workspaceId()) {
    const origin = libraryOrigin;
    const fromLibrary = origin && origin.workspace === workspace && params[origin.kind] === origin.id;
    if (origin && !fromLibrary) libraryOrigin = null;
    const location = new URLSearchParams(workspace ? {workspace, ...params} : params);
    if (fromLibrary) location.set('library', origin.scope);
    rememberCatalogue('#' + location);
    syncLibraryLink();
  }

  function draftOwner() {
    return JSON.stringify([viewer, workspaceId(), current?.id || callDraft?.id || selection]);
  }

  function draftInput() {
    return {title: titleInput.value.trim(), attendees: parseAttendees(attendeeInput.value), transcript: transcript.value};
  }

  function savedDraftContext() {
    if (!native || !current?.id || !Number.isSafeInteger(current.revision)) return null;
    return {workspace:workspaceId(), meeting:current.id, revision:current.revision, viewer};
  }

  function sameDraftContext(left, right) {
    return Boolean(left && right && left.workspace === right.workspace && left.meeting === right.meeting &&
      left.revision === right.revision && left.viewer === right.viewer);
  }

  function savedDraftSource() {
    const context = savedDraftContext();
    if (!context || (current.transcript || '') !== transcript.value || current.title.trim() !== titleInput.value.trim()) return null;
    const attendees = parseAttendees(attendeeInput.value);
    const savedAttendees = parseAttendees((current.attendees || []).join(', '));
    return attendees.length === savedAttendees.length && attendees.every((name, index) => name === savedAttendees[index]) ? context : null;
  }

  function storedJob(job) {
    if (!job || !meetingIdPattern.test(job.id) || !Object.hasOwn(DRAFT_LABEL, job.state)) return null;
    return {id:job.id, state:job.state, label:job.state === 'failed' ? job.error || DRAFT_LABEL.failed : DRAFT_LABEL[job.state],
      ...(job.state === 'ready' && job.draft ? {draft:job.draft} : {})};
  }

  function storedResult(response, target) {
    const data = response.body;
    if (![200, 202].includes(response.status) || data.viewer_username !== target.viewer || data.workspace_id !== target.workspace ||
      data.meeting_id !== target.meeting || data.revision !== target.revision || !Object.hasOwn(data, 'job')) return null;
    return {job:storedJob(data.job)};
  }

  function readStoredDraft(target) {
    const query = new URLSearchParams({meeting:target.meeting, revision:target.revision});
    return request('GET', `/v1/workspaces/${target.workspace}/meetings/draft?${query}`, undefined, undefined, AbortSignal.timeout(SAVE_TIMEOUT_MS))
      .catch(() => unavailable);
  }

  function stopDraftPoll() {
    clearTimeout(draftPoll);
    draftPoll = 0;
  }

  function pollStoredDraft(target) {
    if (draftPoll || target.reading) return;
    draftPoll = setTimeout(async () => {
      draftPoll = 0;
      if (storedDraft !== target || !sameDraftContext(savedDraftSource(), target) || form.hidden || form.inert) return;
      target.reading = true;
      const version = target.version;
      const result = await readStoredDraft(target);
      target.reading = false;
      if (storedDraft !== target || !sameDraftContext(savedDraftContext(), target)) return;
      if (version !== target.version) {
        syncDraft();
        return;
      }
      const observed = storedResult(result, target);
      if (!target.command && observed) target.job = observed.job;
      else if (!target.command && [401, 403, 404, 409].includes(result.status)) {
        target.job = {state:'failed', label:'会议已变化。请重新打开会议后再生成纪要。'};
      } else if (!target.command) target.stale = true;
      if (observed) target.stale = false;
      syncDraft();
    }, DRAFT_POLL_MS);
  }

  async function controlStoredDraft(target, mode) {
    if (target.command) return;
    const prior = target.job;
    target.command = mode;
    target.version = (target.version || 0) + 1;
    syncDraft();
    const path = `/v1/workspaces/${target.workspace}/meetings/draft`;
    const body = {mode, meeting_id:target.meeting, revision:target.revision,
      ...(mode === 'start' ? {previous_job_id:prior?.id || null} : {job_id:prior.id})};
    const result = await request('POST', path, body, undefined, AbortSignal.timeout(SAVE_TIMEOUT_MS)).catch(() => unavailable);
    let observed = storedResult(result, target);
    if (!observed && ambiguousSave(result.status)) {
      observed = storedResult(await readStoredDraft(target), target);
      if (mode === 'start' && observed?.job?.id === prior?.id) observed = null;
    }
    target.command = '';
    if (storedDraft !== target || !sameDraftContext(savedDraftContext(), target)) return;
    if (observed?.job) {
      target.applied = false;
      target.stale = false;
      target.job = observed.job;
    } else if ([401, 403, 404, 409].includes(result.status)) {
      target.job = {state:'failed', label:'会议已变化。请重新打开会议后再生成纪要。'};
    } else if (mode === 'start') {
      target.job = {id:prior?.id, state:'failed', label:messageFor(result.body.error, '暂时无法确认生成请求，请重试。')};
    } else {
      target.stale = true;
    }
    syncDraft();
  }

  function showDraft(record = null) {
    const waiting = draftIsActive(record?.state) || record?.state === 'submitting';
    const next = record?.draft || null;
    const durable = sameDraftContext(savedDraftSource(), storedDraft);
    const label = record?.label || '';
    const nearTitle = Boolean(smallDraftViewport?.matches && durable && label);
    const restoreStop = document.activeElement === stopDraftButton;
    const restoreReview = document.activeElement === draftReview;
    if (nearTitle && draftStatus.parentNode !== draftTop) {
      draftTop.prepend(draftStatus, stopDraftButton);
    } else if (!nearTitle && draftStatus.parentNode !== draftControls) {
      draftControls.append(stopDraftButton, draftStatus);
    }
    draftTop.hidden = !nearTitle;
    draftReview.hidden = !nearTitle || !next;
    draftControls.hidden = nearTitle && waiting;
    draftButton.disabled = waiting || !transcript.value.trim();
    draftButton.textContent = waiting ? '正在生成…' : record?.state === 'failed' ? '重试生成' : '生成纪要草稿';
    if (stopDraftButton) {
      stopDraftButton.hidden = !waiting || record.state === 'submitting';
      stopDraftButton.textContent = durable ? '取消生成' : '停止等待';
    }
    if (restoreStop && !stopDraftButton.hidden && document.activeElement !== stopDraftButton) stopDraftButton.focus({preventScroll:true});
    draftPanel.hidden = !next;
    if ((restoreStop && stopDraftButton.hidden) || (restoreReview && draftReview.hidden)) {
      if (!draftReview.hidden) draftReview.focus({preventScroll:true});
      else if (next) draftHeading.focus({preventScroll:true});
      else if (!draftButton.disabled) draftButton.focus({preventScroll:true});
      else if (nearTitle) draftTop.focus({preventScroll:true});
    }
    if (next !== draft) draftReviewError.textContent = '';
    if (next && next !== draft) {
      document.getElementById('meeting-draft-summary').textContent = next.summary;
      const items = document.getElementById('meeting-draft-items');
      items.replaceChildren(...next.action_items.map(item => {
        const row = document.createElement('li');
        const details = [item.owner, item.due_date && '截止日期 ' + item.due_date].filter(Boolean);
        row.textContent = details.length ? `${item.text}（${details.join(' · ')}）` : item.text;
        return row;
      }));
      items.hidden = !next.action_items.length;
    }
    draft = next;
    draftStatus.dataset.state = record?.state || '';
    if (draftStatus.textContent !== label) draftStatus.textContent = label;
  }

  function draftForInput(saved = savedDraftSource()) {
    if (saved) {
      if (!sameDraftContext(saved, storedDraft)) return null;
      if (storedDraft.command) return {state:'submitting', label:storedDraft.command === 'dismiss' ? '正在丢弃草稿…'
        : storedDraft.command === 'cancel' ? '正在取消生成…' : '正在提交生成请求…'};
      if (storedDraft.applied) return null;
      const record = storedDraft.job;
      return record && storedDraft.stale ? {...record, label:draftIsActive(record.state)
        ? '暂时无法刷新生成状态，正在重试。' : '暂时无法确认操作结果，请重试。'} : record;
    }
    const record = draftRequests.get(draftOwner());
    return record?.input === JSON.stringify(draftInput()) ? record : null;
  }

  function syncDraft() {
    const saved = savedDraftSource();
    const record = draftForInput(saved);
    showDraft(record);
    if (storedDraft && !storedDraft.command && sameDraftContext(saved, storedDraft) && draftIsActive(record?.state)) {
      pollStoredDraft(storedDraft);
    } else stopDraftPoll();
  }

  function updateDraft(target) {
    if (!form.hidden && !form.inert && draftForInput() === target) showDraft(target);
  }

  function discardDraft() {
    const record = draftForInput();
    if (record) {
      draftRequests.delete(draftOwner());
      record.controller.abort();
    }
    syncDraft();
  }

  for (const field of [titleInput, attendeeInput, transcript]) field.addEventListener('input', syncDraft);
  smallDraftViewport?.addEventListener?.('change', () => showDraft(draftForInput()));
  draftReview.addEventListener('click', () => {
    if (draftPanel.hidden || !draftForInput()?.draft) return;
    draftPanel.scrollIntoView({block:'start'});
    draftHeading.focus({preventScroll:true});
  });
  stopDraftButton?.addEventListener('click', () => {
    const record = draftForInput();
    if (!draftIsActive(record?.state)) return;
    if (sameDraftContext(savedDraftSource(), storedDraft)) {
      void controlStoredDraft(storedDraft, 'cancel');
      return;
    }
    record.state = 'stopped';
    record.label = '已停止等待。可为当前正文重新生成。';
    record.controller.abort();
    syncDraft();
    draftButton.focus();
  });
  draftButton.addEventListener('click', async () => {
    if (draftButton.disabled || !workspaceId()) return;
    const saved = savedDraftSource();
    if (saved) {
      if (!sameDraftContext(saved, storedDraft)) storedDraft = {...saved, job:null};
      void controlStoredDraft(storedDraft, 'start');
      return;
    }
    const owner = draftOwner();
    const input = draftInput();
    const target = {input: JSON.stringify(input), state: 'running', label: 'DS-Bot 正在整理纪要…', controller: new AbortController()};
    draftRequests.get(owner)?.controller.abort();
    draftRequests.delete(owner);
    draftRequests.set(owner, target);
    for (const [key, record] of draftRequests) {
      if (draftRequests.size <= 12) break;
      if (record.state !== 'running') draftRequests.delete(key);
    }
    syncDraft();
    stopDraftButton?.focus();
    const timer = setTimeout(() => target.controller.abort(), DRAFT_WAIT_MS);
    const settle = (state, label, result) => {
      if (draftRequests.get(owner) !== target || target.state !== 'running') return;
      Object.assign(target, {state, label, draft: result});
      updateDraft(target);
    };
    try {
      const result = await request('POST', `${base()}/draft`, input, undefined, target.controller.signal);
      if (result.status !== 200 || !result.body.draft) {
        settle('failed', messageFor(result.body.error, '生成失败，请重试。'));
        return;
      }
      settle('ready', '草稿已生成，请核对后采用。', result.body.draft);
    } catch {
      settle('failed', target.controller.signal.aborted ? '等待超时，正文仍在。请重试。' : '连接失败，正文仍在。请重试。');
    } finally {
      clearTimeout(timer);
    }
  });
  document.getElementById('discard-meeting-draft').addEventListener('click', () => {
    if (sameDraftContext(savedDraftSource(), storedDraft)) void controlStoredDraft(storedDraft, 'dismiss');
    else discardDraft();
  });
  document.getElementById('apply-meeting-draft').addEventListener('click', () => {
    if (!draft) return;
    const note = summary.value.trim();
    const next = note && !note.includes(draft.summary) ? note + '\n\n' + draft.summary : note || draft.summary;
    const keyOf = item => JSON.stringify([item.text.trim().toLowerCase(), (item.owner || '').trim().toLowerCase()]);
    const seen = new Map(actions.map(item => [keyOf(item), item]));
    const additions = [];
    const dueUpdates = new Map();
    for (const item of draft.action_items) {
      const key = keyOf(item);
      const existing = seen.get(key);
      if (!existing) {
        const addition = {...item, done: false};
        additions.push(addition);
        seen.set(key, addition);
      } else if (!existing.done && !existing.due_date && item.due_date && !dueUpdates.has(existing)) {
        dueUpdates.set(existing, item.due_date);
      }
    }
    if (next.length > summary.maxLength || actions.length + additions.length > 50) {
      draftReviewError.textContent = '摘要或行动项已达上限。可先精简现有内容，再采用草稿。';
      return;
    }
    summary.value = next;
    for (const [item, dueDate] of dueUpdates) item.due_date = dueDate;
    actions.push(...additions);
    renderActions();
    if (sameDraftContext(savedDraftSource(), storedDraft)) {
      storedDraft.applied = true;
      syncDraft();
    } else discardDraft();
    draftStatus.textContent = '已填入摘要和行动项。确认后保存会议。';
    summary.focus({preventScroll:true});
  });

  function hideAttendees() {
    attendeeActive = -1;
    attendeeList.hidden = true;
    attendeeList.replaceChildren();
  }

  async function workspaceMembers() {
    const id = workspaceId();
    if (!id) return [];
    if (memberCache.workspace === id) return memberCache.items;
    const result = await request('GET', `/v1/workspaces/${id}/members`);
    memberCache = result.status === 200
      ? {workspace: id, items: result.body.items || [], failed: false}
      : {workspace: id, items: [], failed: true};
    return memberCache.items;
  }

  function attendeeOptions() {
    return [...attendeeList.querySelectorAll('button[data-username]')];
  }

  function highlightAttendee(index) {
    const options = attendeeOptions();
    if (!options.length) {
      attendeeActive = -1;
      return;
    }
    attendeeActive = (index + options.length) % options.length;
    options.forEach((option, at) => {
      option.setAttribute('aria-selected', at === attendeeActive ? 'true' : 'false');
    });
  }

  function chooseAttendee(username) {
    attendeeInput.value = attendeeInsert(attendeeInput.value, username);
    syncLeaveProtection();
    syncDraft();
    hideAttendees();
    attendeeInput.focus();
  }

  function attendeeNote(text) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = text;
    attendeeList.append(li);
  }

  async function refreshAttendees() {
    const query = attendeeQuery(attendeeInput.value);
    if (query.length < ATTENDEE_MIN) {
      hideAttendees();
      return;
    }
    const members = await workspaceMembers();
    if (attendeeQuery(attendeeInput.value) !== query) return;
    attendeeList.replaceChildren();
    if (memberCache.failed) {
      attendeeNote(ATTENDEE_UNAVAILABLE);
    } else {
      const matches = matchMembers(members, query, attendeeInput.value);
      if (!matches.length) attendeeNote(ATTENDEE_EMPTY);
      for (const member of matches) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.username = member.username;
        button.textContent = `${member.username} · ${MEMBER_ROLE_LABELS[member.role] || member.role}` +
          (member.suspended ? ' · 已停用' : '');
        button.addEventListener('click', () => chooseAttendee(member.username));
        li.append(button);
        attendeeList.append(li);
      }
    }
    attendeeActive = -1;
    attendeeList.hidden = false;
  }

  function renderActions() {
    actionList.replaceChildren();
    actionBoxes = [];
    actionFollowups = [];
    actions.forEach((action, index) => {
      const row = document.createElement('div');
      row.className = 'action-row';
      const text = document.createElement('input');
      text.type = 'text';
      text.className = 'action-text';
      text.maxLength = 500;
      text.placeholder = '行动项';
      text.setAttribute('aria-label', `行动项 ${index + 1}`);
      text.value = action.text || '';
      text.addEventListener('input', () => { action.text = text.value; syncWriting(); });
      const owner = document.createElement('input');
      owner.type = 'text';
      owner.maxLength = 80;
      owner.placeholder = '负责人';
      owner.setAttribute('aria-label', `行动项 ${index + 1} 的负责人`);
      owner.value = action.owner || '';
      owner.addEventListener('input', () => { action.owner = owner.value; syncWriting(); });
      const deadline = document.createElement('label');
      deadline.className = 'action-deadline';
      const date = document.createElement('input');
      date.type = 'date';
      date.min = '0001-01-01';
      date.max = '9999-12-31';
      date.setAttribute('aria-label', `行动项 ${index + 1} 的截止日期`);
      date.value = action.due_date || '';
      date.addEventListener('input', () => { action.due_date = date.value; syncWriting(); });
      deadline.append(document.createTextNode('截止日期'), date);
      const done = document.createElement('label');
      done.className = 'action-done';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(action.done);
      box.setAttribute('aria-label', `完成行动项 ${index + 1}`);
      box.addEventListener('click', event => {
        if (box.getAttribute('aria-disabled') === 'true') event.preventDefault();
      });
      box.addEventListener('change', () => persistActionToggle(action, box));
      actionBoxes.push(box);
      done.append(box, document.createTextNode('完成'));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除行动项 ${index + 1}`);
      remove.addEventListener('click', () => {
        actions.splice(index, 1);
        renderActions();
        (actionList.children[index]?.children[0] || addAction).focus();
      });
      const link = automationFollowupLink(document);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary action-memory';
      copy.textContent = '存入我的待办';
      copy.addEventListener('click', () => openActionCopy(action, copy));
      const destinations = document.createElement('div');
      destinations.className = 'action-destinations';
      destinations.append(copy, link);
      if (Number.isInteger(action.savedIndex)) row.dataset.meetingActionIndex = action.savedIndex;
      actionFollowups.push({link, copy, action});
      row.append(text, owner, deadline, done, remove, destinations);
      actionList.append(row);
    });
    syncWriting();
  }

  async function persistActionToggle(action, box) {
    const done = box.checked;
    if (writing && active(writing)) { box.checked = action.done; return; }
    const previous = action.done;
    action.done = done;
    const saved = current?.action_items?.[action.savedIndex];
    if (!current?.id || !saved || (action.text || '').trim() !== saved.text ||
        (action.owner || '').trim() !== (saved.owner || '') || (action.due_date || '') !== (saved.due_date || '')) {
      syncWriting();
      showAction('ok', '这条行动项的完成状态会在保存会议后生效。');
      return;
    }
    const meeting = current;
    const target = {...scope(), kind: 'action', action};
    const path = `${base()}/${meeting.id}`;
    const payload = actionToggleBody(meeting.action_items, action.savedIndex, done, meeting.revision);
    writing = target;
    syncWriting();
    showAction('loading', '正在保存行动项…');
    let result = await saveRequest('POST', path, payload);
    if (active(target) && (ambiguousSave(result.status) || result.status === 409)) {
      showAction('loading', '正在确认行动项是否已保存…');
      const checked = await saveRequest('GET', path);
      const observed = checked.body.meeting;
      const {title, started_at, attendees, summary, transcript} = meeting;
      const expected = {title, started_at, attendees, summary, transcript, ...payload.changes};
      if (checked.status === 200 && (!native || checked.body.viewer_username === viewer) &&
          observed?.id === meeting.id && observed.workspace_id === target.workspace &&
          observed.revision >= meeting.revision && meetingMatchesChanges(observed, expected)) result = checked;
    }
    if (writing === target) writing = null;
    if (!active(target)) return;
    if (result.status !== 200 || result.body.meeting?.id !== meeting.id || result.body.meeting.workspace_id !== target.workspace) {
      action.done = previous;
      const currentBox = actionBoxes[actions.indexOf(action)];
      if (currentBox) currentBox.checked = previous;
      syncWriting();
      showAction('error', result.status === 409 ? '会议已在别处更新，请重新打开后再勾选。'
        : messageFor(result.body.error, '无法保存这条行动项的完成状态。'));
      return;
    }
    current = result.body.meeting;
    noteSavedAction(action.savedIndex, done);
    clearNoteCopies();
    document.getElementById('meeting-meta').textContent =
      '修订 ' + current.revision + ' · 创建者 ' + current.created_by;
    meetings = meetings.map(item => item.id === current.id ? current : item);
    renderList();
    syncWriting();
    showAction('ok', done ? '已标记完成。' : '已取消完成。');
    if (native && openOnly.checked) void loadList({keepEditor: true, preserve: true});
  }

  function renderList() {
    const list = document.getElementById('meeting-list');
    list.replaceChildren();
    syncListStatus();
    for (const meeting of meetings) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meeting-row';
      button.dataset.meeting = meeting.id;
      if (current && current.id === meeting.id) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = meeting.title;
      const meta = document.createElement('span');
      meta.className = 'preview';
      meta.textContent = formatTime(meeting.started_at) + ' · ' + (meeting.attendees || []).length + ' 人';
      button.append(title, meta);
      if (meeting.action_count > 0) {
        const progress = document.createElement('span');
        progress.className = 'meeting-action-progress';
        progress.dataset.complete = String(meeting.done_count === meeting.action_count);
        progress.textContent = `${meeting.done_count}/${meeting.action_count} 行动项已完成`;
        button.append(progress);
      }
      if (meeting.transcript_match) {
        const source = document.createElement('span');
        source.className = 'meeting-source-hit';
        renderTranscriptMatch(document, source, meeting.transcript_match, '转写 · ');
        button.append(source);
      }
      li.append(button);
      list.append(li);
    }
  }

  function syncListStatus() {
    const empty = document.getElementById('meetings-empty');
    const loading = Boolean(listRequest || searchTimer);
    empty.hidden = loading || Boolean(retryList) || meetings.length > 0;
    empty.textContent = native && (search.value?.trim() || openOnly.checked)
      ? '没有符合筛选条件的会议。' : '还没有会议记录。点击「新建会议」开始。';
    listMore.hidden = !native || !listCursor;
    listMore.disabled = loading;
    listRetry.hidden = !retryList;
    listRetry.disabled = loading;
    document.getElementById('meeting-list').setAttribute('aria-busy', String(loading));
  }

  function stopList() {
    clearTimeout(searchTimer);
    searchTimer = undefined;
    listRequest?.abort();
    listRequest = null;
    retryList = null;
  }

  function resetList() {
    stopList();
    meetings = [];
    listCursor = '';
    listVersion = undefined;
    listStatus.textContent = '';
    catalogueOrigin = '';
    catalogueSize = 0;
    catalogueTranscript = false;
  }

  function focusCatalogue(fallback) {
    const origin = catalogueOrigin && document.querySelector(`#meeting-list button[data-meeting="${catalogueOrigin}"]`);
    (origin || ((search.value || openOnly.checked) ? search : fallback))?.focus();
  }

  function setReceiptMode(receipt) {
    transcriptImporter?.reset();
    const pane = document.getElementById('meeting-list-pane');
    if (pane) pane.hidden = receipt;
    layout?.classList?.toggle('is-reading-receipt', receipt);
    if (layout && receipt) layout.dataset.view = 'receipt';
    receivedMeeting = null;
    if (!receipt && sharedDetail) sharedDetail.hidden = true;
    sharing.sync();
    discussion.sync();
    printing.sync();
  }

  function syncRecord() {
    document.getElementById('remove-meeting').hidden = !current?.id;
    const exportLink = document.getElementById('export-meeting');
    if (exportLink) {
      exportLink.hidden = !current?.id;
      exportLink.href = current?.id ? `${base()}/${current.id}/export` : '#';
    }
    document.getElementById('meeting-meta').textContent = current?.id
      ? '修订 ' + current.revision + ' · 创建者 ' + current.created_by : '新会议';
    callSource.hidden = !callDraft && !isMeetingCallId(current?.source_call_id);
    sharing.sync();
    renderList();
    rewriteLocation(current?.id ? {meeting: current.id} : callDraft ? {'from-call': callDraft.id}
      : {new:'1', ...(chatDraftEditor ? {from:'chat', draft:chatDraftEditor} : {})},
      callDraft?.linkWorkspace ?? workspaceId());
  }

  function fill(meeting, source = null, draftJob = undefined, {recover = false, chatEditor = ''} = {}) {
    clearOpenRetry();
    showAction('', '');
    editorReady = false;
    if (inboxReturn) inboxReturn.hidden = true;
    if (mobileBack) mobileBack.hidden = false;
    selection += 1;
    resetSave();
    syncLibraryLink();
    audio.reset();
    hideAttendees();
    const sameMeeting = meeting?.id === current?.id && meeting?.workspace_id === current?.workspace_id && Boolean(meeting?.id);
    current = meeting;
    callDraft = source;
    chatDraftEditor = chatEditor;
    const draftContext = savedDraftContext();
    if (draftJob !== undefined || !sameDraftContext(draftContext, storedDraft)) {
      stopDraftPoll();
      storedDraft = draftContext ? {...draftContext, job:storedJob(draftJob)} : null;
    }
    resume.hidden = true;
    clearNoteCopies();
    setReceiptMode(false);
    if (layout) layout.dataset.view = 'editor';
    form.hidden = false;
    form.inert = false;
    emptyDetail.hidden = true;
    const details = meeting || source;
    titleInput.value = details?.title ?? '';
    document.getElementById('meeting-started-at').value = inputTime(details?.started_at);
    attendeeInput.value = (details?.attendees || []).join(', ');
    document.getElementById('meeting-summary').value = meeting ? (meeting.summary || '') : '';
    document.getElementById('meeting-transcript').value = meeting ? (meeting.transcript || '') : '';
    if (sameMeeting) transcriptSearch.refresh();
    else transcriptSearch.reset();
    syncDraft();
    actions = meeting ? (meeting.action_items || []).map((item, savedIndex) => ({...item, savedIndex})) : [];
    savedDraft = draftContents();
    editingWorkspace = workspaceId();
    editorBaseRevision = meeting?.revision || 0;
    if (recover) recoverEditor();
    editorReady = true;
    syncTranscriptImport();
    renderActions();
    syncRecord();
  }

  function openCatalogue({focus = false} = {}) {
    clearOpenRetry();
    selection += 1;
    resetSave();
    current = null;
    callDraft = null;
    storedDraft = null;
    stopDraftPoll();
    actions = [];
    actionFollowups = [];
    savedDraft = null;
    resume.hidden = true;
    clearNoteCopies();
    setReceiptMode(false);
    audio.reset();
    showDraft();
    hideAttendees();
    form.hidden = true;
    form.inert = false;
    transcriptSearch.reset();
    emptyDetail.hidden = false;
    if (layout) layout.dataset.view = 'catalogue';
    renderList();
    rewriteLocation();
    syncWriting();
    if (focus) {
      document.getElementById('main').scrollTop = 0;
      focusCatalogue(newButton);
    }
  }

  async function loadList({keepEditor = false, append = false, preserve = false, refresh = false} = {}) {
    const workspace = workspaceId(), pendingSelection = selection;
    if (!workspace || (append && (!listCursor || listRequest || searchTimer))) return;
    const cursor = append ? listCursor : '';
    const size = append || refresh ? 20 : Math.max(20, Math.min(100, preserve ? meetings.length : catalogueSize));
    const query = new URLSearchParams({limit: native ? size : 100});
    if (native) {
      query.set('order', 'recent');
      if (search.value?.trim()) query.set('q', search.value.trim());
      if (openOnly.checked) query.set('open', '1');
      if (cursor) query.set('cursor', cursor);
      if (!append) rememberCatalogue();
    }
    stopList();
    const controller = listRequest = new AbortController();
    listStatus.textContent = append ? '正在加载更多会议…' : refresh ? '正在重新加载会议列表…' : '正在加载会议…';
    syncListStatus();
    const result = await request('GET', `${base()}?${query}`, undefined, undefined, controller.signal).catch(() => unavailable);
    if (listRequest !== controller || workspaceId() !== workspace) return;
    listRequest = null;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      retryList = {keepEditor, append, preserve, refresh};
      listStatus.textContent = messageFor(result.body.error, '无法加载会议，请重试。');
      syncListStatus();
      return;
    }
    const version = result.body.activity_version;
    if (append && listVersion !== undefined && version !== undefined && version !== listVersion) {
      listCursor = '';
      return loadList({keepEditor: true, refresh: true});
    }
    listVersion = version;
    const seen = new Set(append ? meetings.map(item => item.id) : []);
    const items = result.body.items.filter(item => {
      if (!meetingIdPattern.test(item?.id || '') || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    meetings = append ? [...meetings, ...items] : items;
    catalogueSize = Math.min(100, meetings.length);
    const next = result.body.cursor;
    listCursor = next !== cursor && meetingIdPattern.test(next || '') ? next : '';
    listStatus.textContent = append ? `已显示 ${meetings.length} 条会议记录。` : refresh ? '会议列表已更新。' : '';
    if (native) rememberCatalogue();
    renderList();
    if (append || keepEditor || pendingSelection !== selection) return;
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      openCatalogue();
      return;
    }
    if (meetings.length && !current) await openMeeting(meetings[0].id);
    else fill(null, null, undefined, {recover:true});
  }

  async function openMeeting(id, read, transcriptQuery, actionReference) {
    printing.close();
    transcriptImporter?.reset();
    const pendingSave = writing?.kind === 'save' && active(writing) ? writing
      : saveRetry && active(saveRetry) ? saveRetry : null;
    const owner = viewer;
    const workspace = workspaceId(), pendingSelection = ++selection;
    resetSave();
    audio.reset();
    stopDraftPoll();
    showDraft();
    if (!read) {
      form.inert = true;
      show('loading', '正在打开会议…');
    }
    const result = read || await readDetail(`${base()}/${id}`);
    if (workspaceId() !== workspace || pendingSelection !== selection || viewer !== owner) return;
    form.inert = false;
    if (result.status !== 200 || (native && result.body.viewer_username !== viewer) ||
        result.body.meeting?.id !== id || result.body.meeting.workspace_id !== workspace) {
      syncTranscriptImport();
      if (pendingSave && !form.hidden) {
        saveRetry = {...pendingSave, selection};
        showSave('error', '上次保存结果还未确认。草稿已保留，请重试。');
      }
      syncWriting();
      syncDraft();
      const message = !result.status || result.status >= 500 ? '无法打开会议。'
        : messageFor(result.body.error, '无法打开会议。');
      showOpenError(result, message,
        () => openMeeting(id, undefined, transcriptQuery, actionReference));
      return;
    }
    fill(result.body.meeting, null, result.body.draft_job || null, {recover:true});
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      document.getElementById('main').scrollTop = 0;
      const focus = draftTop.hidden ? document.getElementById('meeting-editor-pane') : draftTop;
      focus?.focus({preventScroll: true});
    }
    if (transcriptQuery) transcriptSearch.open(transcriptQuery);
    show('', '');
    if (actionReference) {
      if (actionReference.inbox && inboxReturn) {
        inboxMine.checked = actionReference.mine;
        if (inboxState) inboxState.value = actionReference.completed ? 'completed' : 'open';
        inboxReturn.hidden = false;
        if (mobileBack) mobileBack.hidden = true;
      }
      const target = current.revision === actionReference.revision &&
        document.querySelector(`#action-list [data-meeting-action-index="${actionReference.index}"]`);
      if (target) {
        target.tabIndex = -1;
        target.dataset.sourceAction = '';
        target.scrollIntoView({block:'center'});
        (actionReference.inbox ? target.querySelector('input') || target : target).focus({preventScroll:true});
        rewriteLocation({meeting:id, action:actionReference.index, revision:actionReference.revision,
          ...(actionReference.inbox ? {from:'actions'} : {}), ...(actionReference.mine ? {mine:'1'} : {}),
          ...(actionReference.completed ? {status:'completed'} : {})});
      } else show('ok', '会议已更新，当前展示最新纪要。');
    }
    return true;
  }

  async function openSharedMeeting(id, read, actionReference) {
    selection += 1;
    const target = scope();
    resetSave();
    current = null;
    callDraft = null;
    storedDraft = null;
    stopDraftPoll();
    sharing.sync();
    audio.reset();
    showDraft();
    hideAttendees();
    form.hidden = true;
    transcriptSearch.reset();
    savedDraft = null;
    syncLeaveProtection();
    setReceiptMode(true);
    if (sharedInboxReturn) sharedInboxReturn.hidden = true;
    sharedDetail.hidden = true;
    emptyDetail.hidden = true;
    show('loading', '正在加载共享纪要…');
    const result = read || await readDetail(`${base()}/shared/${id}`);
    if (!active(target)) return;
    const meeting = result.body.meeting;
    if (result.status !== 200 || (native && result.body.viewer_username !== viewer) ||
        meeting?.id !== id || meeting.shared !== true) {
      showOpenError(result, result.status === 404 ? '这份共享纪要已撤回或你没有查看权限。'
        : '无法打开共享纪要。', () => openSharedMeeting(id, undefined, actionReference));
      return false;
    }
    const copy = native && result.body.received === true ? async index => {
      if (!active(target)) return;
      const saved = await copySharedAction(target, id, meeting.revision, index);
      if (active(target)) return saved;
    } : null;
    renderSharedMeeting(document, meeting, {copy, saved:result.body.saved_actions});
    if (result.body.received === true) receivedMeeting = {workspace:target.workspace, meeting};
    discussion.sync();
    printing.sync();
    show('', '');
    if (actionReference && result.body.received === true && sharedInboxReturn && inboxSource) {
      const item = meeting.action_items?.[actionReference.index];
      if (meeting.revision === actionReference.revision && item?.done === false &&
          item.owner?.toLowerCase() === target.viewer.toLowerCase()) {
        inboxSource.value = 'received';
        sharedInboxReturn.hidden = false;
        const action = document.querySelector(`#shared-meeting-actions [data-shared-action-index="${actionReference.index}"]`);
        action?.focus();
        rewriteLocation({shared:id, action:actionReference.index, revision:actionReference.revision, from:'received-actions'});
      } else show('ok', '这条待办已有更新，当前展示收到的纪要。');
    }
    return true;
  }

  async function copySharedAction({workspace, viewer}, shareId, revision, index) {
    const path = `/v1/workspaces/${workspace}/meetings/shared/${shareId}`;
    const result = await saveRequest('POST', path + '/action', {revision, index});
    const {action, viewer_username} = result.body;
    const accepted = [200, 201].includes(result.status);
    if (accepted && viewer_username === viewer && isSavedMeetingAction(action)) return {action};
    let sourceUnavailable = [403, 404].includes(result.status);
    if (accepted || ambiguousSave(result.status)) {
      const checked = await saveRequest('GET', path);
      const {meeting, saved_actions, received} = checked.body;
      if (checked.status === 200 && checked.body.viewer_username === viewer && received === true &&
          meeting?.shared === true && meeting.id === shareId && meeting.revision === revision && Array.isArray(saved_actions)) {
        const observed = saved_actions.find(item => item.index === index && isSavedMeetingAction(item));
        if (observed) return {action:observed};
      }
      sourceUnavailable = [403, 404].includes(checked.status);
    }
    return {sourceUnavailable, error:sourceUnavailable ? '这份共享纪要已撤回或你没有查看权限。'
      : messageFor(result.body.error, '暂时无法保存待办，请重试。')};
  }

  function syncLibraryLink() {
    const workspace = workspaceId();
    const origin = libraryOrigin?.workspace === workspace ? libraryOrigin : null;
    const href = meetingArchiveHref(workspace, origin ? {scope:origin.scope, focus:origin.kind + ':' + origin.id} : {});
    if (back) back.href = href;
    if (mobileLibrary) {
      mobileLibrary.href = href;
      mobileLibrary.hidden = !origin;
    }
    newButton.disabled = !workspaceId();
    search.disabled = !workspaceId();
    openOnly.disabled = !workspaceId();
    if (inboxOpen) inboxOpen.hidden = !native || !workspaceId();
    sharing.sync();
  }

  function fillWorkspaces(items, selected) {
    workspaceSelect.replaceChildren();
    for (const space of items) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (items.some(item => item.id === selected)) workspaceSelect.value = selected;
  }

  async function openCallDraft(id, read, linkedWorkspace) {
    const target = scope();
    const account = viewerId;
    show('loading', '正在打开通话纪要…');
    const result = await (read || readDetail(`${base()}/from-call/${id}`));
    if (!active(target)) return;
    const {source, meeting, viewer_username: owner, workspace_id: workspace} = result.body;
    if (result.status !== 200 || owner !== target.viewer || workspace !== target.workspace ||
        source?.id !== id || typeof source.title !== 'string' || !Number.isSafeInteger(source.started_at) ||
        !Number.isSafeInteger(source.ended_at) || source.ended_at < source.started_at ||
        !Array.isArray(source.attendees) || (meeting &&
        (!meetingIdPattern.test(meeting.id) || meeting.source_call_id !== id || meeting.workspace_id !== workspace))) {
      const code = result.body.error?.code;
      showOpenError(result, result.status === 409 && code === 'meeting_call_active' ? '通话还未结束。结束后可刷新此页面整理纪要。'
        : result.status === 404 ? '无法访问这场通话的纪要。'
        : '无法加载通话纪要。', () => openCallDraft(id, null, linkedWorkspace));
      return;
    }
    if (meeting) {
      if (!await openMeeting(meeting.id, {status: 200, body: {meeting, viewer_username: owner}})) return;
    } else {
      fill(null, {...source,linkWorkspace:linkedWorkspace}, undefined, {recover:true});
      document.getElementById('main').scrollTop = 0;
      callSource.focus({preventScroll: true});
      show('ok', '已填入通话信息。上传录音或粘贴转写后，可生成纪要。');
    }
    if (viewerId !== account || workspaceId() !== workspace || (current?.source_call_id || callDraft?.id) !== id) return;
    const editor = scope();
    try {
      const clip = await previewCallAudio({owner:account, workspace:linkedWorkspace, call:id}, document.defaultView);
      if (clip && active(editor) && viewerId === account && audio.acceptCallRecording(clip)) {
        show('ok', '已带入本次通话录音。录音暂存在本机，可先试听，再开始转写。');
      }
    } catch {
      if (active(editor) && viewerId === account) show('error', '暂时无法读取本机录音。刷新后可重试。');
    }
  }

  async function load() {
    printing.close();
    transcriptImporter?.reset();
    const seq = ++workspaceLoad;
    clearOpenRetry();
    inboxResume = null;
    setInbox(false, {focus:false});
    selection += 1;
    savedDraft = null;
    syncLeaveProtection();
    resetSave();
    resetList();
    renderList();
    const linked = new URLSearchParams((globalThis.location?.hash || '').slice(1));
    const linkedWorkspace = linked.get('workspace');
    const meetingId = linked.get('meeting') || '';
    const actionReference = meetingId ? linkedMeetingAction(linked) : null;
    const shareId = linked.get('shared') || '';
    const sharedActionReference = shareId && linked.getAll('from').length === 1 && linked.get('from') === 'received-actions'
      ? linkedMeetingAction(linked) : null;
    const fromCall = linked.has('from-call');
    const callId = linked.get('from-call');
    const validCallLink = native && isMeetingCallId(callId) && linked.getAll('from-call').length === 1 &&
      !['meeting', 'shared', 'new', 'from'].some(key => linked.has(key)) &&
      (!linked.has('workspace') || (linked.getAll('workspace').length === 1 && meetingIdPattern.test(linkedWorkspace)));
    const exact = !fromCall && meetingIdPattern.test(linkedWorkspace)
      && (linked.has('shared') ? !meetingId && meetingIdPattern.test(shareId) : meetingIdPattern.test(meetingId));
    const libraryScope = linked.get('library');
    libraryOrigin = exact && linked.getAll('library').length === 1 && ['joined', 'all'].includes(libraryScope)
      ? {workspace:linkedWorkspace, kind:shareId ? 'shared' : 'meeting', id:shareId || meetingId, scope:libraryScope}
      : null;
    const eagerDetail = native && exact
      ? readDetail(`/v1/workspaces/${linkedWorkspace}/meetings/${shareId ? 'shared/' + shareId : meetingId}`) : null;
    const eagerSource = validCallLink && linkedWorkspace
      ? readDetail(`/v1/workspaces/${linkedWorkspace}/meetings/from-call/${callId}`) : null;
    if (fromCall) {
      form.hidden = true;
      if (layout) layout.dataset.view = 'catalogue';
    }
    newButton.disabled = true;
    const session = await request('GET', '/v1/auth/session').catch(() => unavailable);
    if (seq !== workspaceLoad) return;
    if (session.status !== 200) {
      current = null;
      callDraft = null;
      viewer = '';
      viewerId = '';
      storedDraft = null;
      stopDraftPoll();
      search.value = '';
      openOnly.checked = false;
      resume.hidden = true;
      clearNoteCopies();
      sharing.sync();
      if (sharedDetail) sharedDetail.hidden = true;
      audio.reset();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    viewer = session.body.user.username;
    viewerId = session.body.user.id || '';
    document.getElementById('whoami').textContent = viewer;
    const directory = readWorkspaceChoices(request, '/v1/workspaces?limit=100');
    const detail = eagerDetail ? await eagerDetail : null;
    if (seq !== workspaceLoad) return;
    const viewerMatches = detail?.status !== 200 || detail.body.viewer_username === viewer;
    const verified = detail?.status === 200 && viewerMatches && (shareId
      ? detail.body.meeting?.id === shareId && detail.body.meeting.shared === true
      : detail.body.meeting?.id === meetingId && detail.body.meeting.workspace_id === linkedWorkspace);
    if (verified) {
      fillWorkspaces([{id: linkedWorkspace, name: '当前工作区'}], linkedWorkspace);
      restoreCatalogue();
      syncLibraryLink();
      if (shareId) void openSharedMeeting(shareId, detail, sharedActionReference);
      else {
        const transcriptQuery = catalogueTranscript && catalogueOrigin === meetingId ? search.value : '';
        void openMeeting(meetingId, detail, transcriptQuery, actionReference);
        void loadList({keepEditor: true});
      }
    }
    let {initial: listed, supplemental} = await directory;
    if (seq !== workspaceLoad) return;
    if (linkedWorkspace && !listed.body.items?.some(item => item.id === linkedWorkspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) listed = shared;
      supplemental = null;
    }
    if (seq !== workspaceLoad) return;
    const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const withVerified = items => verified && !items.some(item => item.id === linkedWorkspace)
      ? [{id: linkedWorkspace, name: '当前工作区'}, ...items] : items;
    const personal = fromCall && !linkedWorkspace
      ? workspaces.find(item => item.kind === 'personal')?.id || '' : '';
    fillWorkspaces(withVerified(workspaces), verified ? workspaceId() : linkedWorkspace || personal || workspaceId());
    void supplemental?.then(shared => {
      if (seq === workspaceLoad && shared.status === 200) fillWorkspaces(withVerified(shared.body.items || []), workspaceId());
    });
    if (verified) return;
    restoreCatalogue();
    if (linkedWorkspace && !workspaces.some(item => item.id === linkedWorkspace)) {
      workspaceSelect.value = '';
      syncLibraryLink();
      form.hidden = true;
      show('error', '无法打开此工作区的会议。请选择其他工作区。');
      return;
    }
    syncLibraryLink();
    if (!workspaces.length) {
      form.hidden = true;
      document.getElementById('meeting-empty').hidden = false;
      document.getElementById('meetings-empty').hidden = false;
      show('error', listed.status === 200 ? '还没有工作区。请先到聊天页创建。' : '无法读取工作区，请刷新重试。');
      return;
    }
    if (fromCall) {
      if (!validCallLink || (!linkedWorkspace && !personal)) {
        show('error', '通话纪要链接无效。');
        return;
      }
      await Promise.all([openCallDraft(callId, eagerSource, linkedWorkspace || ''), loadList({keepEditor: true})]);
    } else if (linked.has('shared')) {
      if (workspaceId() === linkedWorkspace && meetingIdPattern.test(shareId) && !meetingId) {
        await openSharedMeeting(shareId, viewerMatches && detail, sharedActionReference);
      } else {
        form.hidden = true;
        if (sharedDetail) sharedDetail.hidden = true;
        show('error', '共享纪要链接无效。');
      }
    } else if (workspaceId() === linkedWorkspace && meetingIdPattern.test(meetingId)) {
      const transcriptQuery = catalogueTranscript && catalogueOrigin === meetingId ? search.value : '';
      await Promise.all([openMeeting(meetingId, viewerMatches && detail, transcriptQuery, actionReference), loadList({keepEditor: true})]);
    } else if (linked.get('new') === '1') {
      let chatEditor = '', source = null;
      if (linked.get('from') === 'chat') {
        const previous = linked.get('draft');
        if (previous && /^(?:[a-f0-9]{32}|\d{13})$/.test(previous)) chatEditor = previous;
        else if (!previous) {
          source = takeMeetingFromChat(editorStorage(), viewerId, workspaceId());
          if (source) chatEditor = meetingKey('');
        }
      }
      fill(null, null, undefined, {recover:true, chatEditor});
      if (linked.get('from') === 'chat') {
        if (source) {
          titleInput.value = source.title;
          transcript.value = source.transcript;
          transcriptSearch.refresh();
          syncDraft();
          syncLeaveProtection();
          show('ok', '已填入所选聊天消息。可编辑正文，再生成纪要。');
        } else if (!hasUnsavedChanges()) {
          show('error', '无法读取聊天草稿。你可以粘贴会议正文。');
        }
      }
      await loadList({keepEditor: true});
    } else {
      await loadList();
    }
  }

  const startedInput = document.getElementById('meeting-started-at');

  function draftContents() {
    return JSON.stringify([titleInput.value, startedInput.value, attendeeInput.value, summary.value, transcript.value,
      actions.map(actionFields)]);
  }

  function editorKey() {
    if (!native || !meetingIdPattern.test(viewerId) || !meetingIdPattern.test(editingWorkspace) ||
        workspaceId() !== editingWorkspace) return '';
    return 'flybot-workspace.meeting-editor.' + [viewerId, editingWorkspace,
      current?.id || callDraft?.id || (chatDraftEditor ? 'chat-' + chatDraftEditor : 'new')].join('.');
  }

  function editorStorage() {
    try { return document.defaultView?.sessionStorage; } catch { return undefined; }
  }

  function persistEditor() {
    const key = editorKey();
    if (!key || !editorReady || savedDraft === null || form.hidden || form.inert) return false;
    const submitted = writing?.kind === 'save' && active(writing) ? writing : saveRetry && active(saveRetry) ? saveRetry : null;
    const pending = submitted?.key ? {key:submitted.key, startedAt:submitted.changes.started_at, fields:JSON.parse(submitted.draft)} : null;
    const draft = draftContents();
    if (draft === savedDraft && !pending) return writeMeetingEditor(editorStorage(), key, null);
    return writeMeetingEditor(editorStorage(), key, {revision:editorBaseRevision,
      baseline:JSON.parse(savedDraft), fields:JSON.parse(draft), pending});
  }

  function clearEditor() {
    const key = editorKey();
    if (key) writeMeetingEditor(editorStorage(), key, null);
  }

  function applyEditorFields(fields, savedActions) {
    const [title, startedAt, attendees, notes, body, nextActions] = fields;
    titleInput.value = title;
    startedInput.value = startedAt;
    attendeeInput.value = attendees;
    summary.value = notes;
    transcript.value = body;
    actions = nextActions.map(([text, owner, done, due_date], index) => ({
      text, owner, done, due_date, ...(sameMeetingField(nextActions[index], savedActions[index]) ? {savedIndex:index} : {}),
    }));
    transcriptSearch.refresh();
    syncDraft();
  }

  function recoverEditor() {
    const key = editorKey();
    const recovered = key && readMeetingEditor(editorStorage(), key);
    if (!recovered) return;
    const remote = JSON.parse(savedDraft);
    if (current && recovered.revision !== editorBaseRevision) {
      const review = mergeMeetingFields(recovered.baseline, recovered.fields, remote);
      if (sameMeetingField(review.fields, remote)) return;
      editorBaseRevision = recovered.revision;
      savedDraft = JSON.stringify(recovered.baseline);
      saveConflict = true;
      applyEditorFields(recovered.fields, remote[5]);
      showSave('error', '已恢复未保存的修改。会议有更新，请先核对最新版本。');
      return;
    }
    applyEditorFields(recovered.fields, remote[5]);
    if (!current && recovered.pending) {
      const {fields, key:retryKey, startedAt} = recovered.pending;
      saveRetry = beginSave(fields, retryKey, startedAt);
    }
    if (saveRetry) showSave('error', '已恢复上次未确认的保存。点击「确认并重试保存」继续。');
    else if (draftContents() !== savedDraft) showSave('ok', '已恢复此标签页中未保存的修改。');
  }

  function renderConflictReview(review, local, remote, revision) {
    document.getElementById('meeting-conflict-description').textContent = review.conflicts.length
      ? `请选择有冲突的字段。其他修改会合并到修订 ${revision}。`
      : `载入修订 ${revision} 后，可在编辑器里核对内容。`;
    conflictFields.replaceChildren();
    const chosen = new Set();
    for (const index of review.conflicts) {
      const field = document.createElement('fieldset');
      const label = document.createElement('legend');
      label.textContent = meetingFieldLabels[index];
      field.append(label);
      for (const [name, value] of [['我的修改', local[index]], ['最新版本', remote[index]]]) {
        const option = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'meeting-merge-' + index;
        input.setAttribute('aria-label', name);
        const choice = document.createElement('span');
        choice.textContent = name;
        const preview = document.createElement('span');
        preview.className = 'meeting-conflict-preview';
        preview.textContent = conflictFieldText(value);
        input.addEventListener('change', () => {
          review.fields[index] = value;
          chosen.add(index);
          applyConflict.disabled = chosen.size !== review.conflicts.length;
        });
        option.append(input, choice, preview);
        field.append(option);
      }
      conflictFields.append(field);
    }
    applyConflict.disabled = review.conflicts.length > 0;
  }

  reviewConflict?.addEventListener('click', async () => {
    if (!saveConflict || !current?.id || !savedDraft || conflictRead) return;
    if (audio.hasPendingWork()) {
      showSave('error', '请先完成或取消当前音频处理，再核对会议版本。');
      return;
    }
    const target = {...scope(), id:current.id};
    conflictRead = target;
    syncWriting();
    showSave('loading', '正在读取最新版本…');
    const result = await saveRequest('GET', `${base()}/${target.id}`);
    if (conflictRead !== target || !active(target) || current?.id !== target.id || !saveConflict) return;
    conflictRead = null;
    syncWriting();
    const latest = savedMeeting(result, target);
    if (!latest || latest.revision < current.revision || (native && result.body.viewer_username !== target.viewer)) {
      showSave('error', '无法读取最新版本。未保存的修改已保留。');
      return;
    }
    const local = JSON.parse(draftContents());
    const remote = [latest.title, inputTime(latest.started_at), (latest.attendees || []).join(', '),
      latest.summary || '', latest.transcript || '', (latest.action_items || []).map(actionFields)];
    const review = mergeMeetingFields(JSON.parse(savedDraft), local, remote);
    renderConflictReview(review, local, remote, latest.revision);
    showSave('', '');
    applyConflict.onclick = () => {
      if (!active(target) || current?.id !== target.id || !saveConflict || audio.hasPendingWork()) return;
      fill(latest, null, result.body.draft_job || null);
      applyEditorFields(review.fields, remote[5]);
      renderActions();
      showSave('ok', hasUnsavedChanges() ? '已载入最新版本并保留修改。请核对后保存。' : '已载入最新版本。');
      titleInput.focus({preventScroll:true});
    };
    conflictDialog.showModal();
  });
  document.getElementById('cancel-meeting-conflict')?.addEventListener('click', () => conflictDialog.close());
  conflictDialog?.addEventListener('close', () => {
    if (reviewConflict.hidden) return;
    if (saveConflict && !saveStatus.textContent) showSave('error', '纪要有更新。可核对版本后继续编辑。');
    reviewConflict.focus({preventScroll:true});
  });

  function hasUnsavedChanges() {
    return savedDraft !== null && !form.hidden && (audio.hasPendingWork() || draftContents() !== savedDraft);
  }

  function beforeLeaving(event) {
    if (!hasUnsavedChanges() || (!audio.hasPendingWork() && persistEditor())) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function syncLeaveProtection() {
    const stored = persistEditor();
    const dirty = hasUnsavedChanges() && (audio.hasPendingWork() || !stored);
    if (dirty === watchingLeave) return;
    watchingLeave = dirty;
    if (dirty) globalThis.addEventListener?.('beforeunload', beforeLeaving);
    else globalThis.removeEventListener?.('beforeunload', beforeLeaving);
  }

  function noteSavedAction(index, done) {
    if (!savedDraft) return;
    const snapshot = JSON.parse(savedDraft);
    if (!snapshot[5][index]) return;
    snapshot[5][index][2] = done;
    savedDraft = JSON.stringify(snapshot);
    editorBaseRevision = current.revision;
  }

  function confirmNavigation(leave) {
    if (!hasUnsavedChanges()) return leave();
    unsavedMessage.textContent = writing && active(writing)
      ? '保存请求仍在处理。离开后可重新打开原会议，核对保存结果。'
      : saveRetry && active(saveRetry)
        ? '上次保存结果尚未确认。离开后可重新打开原会议，核对保存结果。'
        : audio.hasPendingWork()
          ? '放弃修改会清除本页的音频、转写进度和尚未保存的内容。'
          : '选择「放弃修改」会清除这次未保存的会议内容。';
    continueNavigation = leave;
    unsavedDialog.showModal();
  }

  form.addEventListener('input', syncLeaveProtection);
  form.addEventListener('change', syncLeaveProtection);
  unsavedDialog.addEventListener('cancel', () => { continueNavigation = null; });
  document.getElementById('keep-meeting-edits').addEventListener('click', () => {
    continueNavigation = null;
    unsavedDialog.close();
  });
  document.getElementById('discard-meeting-edits').addEventListener('click', () => {
    const leave = continueNavigation;
    continueNavigation = null;
    unsavedDialog.close();
    if (!leave) return;
    clearEditor();
    if (savedDraft !== null) {
      const original = JSON.parse(savedDraft);
      editorReady = false;
      applyEditorFields(original, original[5]);
      audio.reset();
      editorReady = true;
    }
    return leave();
  });

  function beginSave(fields = JSON.parse(draftContents()), retryKey, originalStart) {
    const [editedTitle, start, names, notes, body, editedActions] = fields;
    const title = editedTitle.trim();
    const startedAt = originalStart ?? (callDraft && start === inputTime(callDraft.started_at) ? callDraft.started_at
      : Math.floor(new Date(start).getTime() / 1000));
    const attendees = callDraft && names === callDraft.attendees.join(', ') ? callDraft.attendees : parseAttendees(names);
    if (!title) { showSave('error', '请填写标题。'); return null; }
    if (!Number.isFinite(startedAt)) { showSave('error', '请选择开始时间。'); return null; }
    const payload = [], submittedActions = [];
    editedActions.forEach(([text, owner, done, due_date], index) => {
      if (!text.trim()) return;
      payload.push(actionPayload({text, owner, done, due_date}));
      const action = actions[index];
      submittedActions.push(action && sameMeetingField(actionFields(action), editedActions[index]) ? action : null);
    });
    return {
      ...scope(), kind: 'save', id: current?.id, revision: current?.revision, draft: JSON.stringify(fields), submittedActions,
      key: current?.id ? null : retryKey || meetingKey('meeting-'),
      changes: {
        title, started_at: startedAt, attendees,
        summary: notes, transcript: body,
        action_items: payload,
        ...(!current?.id && callDraft ? {source_call_id: callDraft.id} : {}),
      },
    };
  }

  function savedMeeting(result, operation) {
    const meeting = result.body.meeting;
    return [200, 201].includes(result.status) && meetingIdPattern.test(meeting?.id || '') &&
      meeting.workspace_id === operation.workspace && (!operation.id || meeting.id === operation.id) &&
      (!operation.changes?.source_call_id || meeting.source_call_id === operation.changes.source_call_id) &&
      Number.isSafeInteger(meeting.revision) && meeting.revision > 0 ? meeting : null;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.hidden || form.inert || !workspaceId() || save.disabled) return;
    const retrying = saveRetry && active(saveRetry);
    const operation = retrying ? saveRetry : beginSave();
    if (!operation) return;
    writing = operation;
    syncWriting();
    showSave('loading', retrying ? '正在确认上次保存…' : '正在保存…');
    const {id, revision, key, changes} = operation;
    const path = id ? `${base()}/${id}` : base();
    const result = await (id
      ? saveRequest('POST', path, {revision, changes})
      : saveRequest('POST', path, changes, {'Idempotency-Key': key}));
    let meeting = savedMeeting(result, operation);
    const readAfterConflict = Boolean(retrying && id && result.status === 409);
    let uncertain = ambiguousSave(result.status) || ([200, 201].includes(result.status) && !meeting) || readAfterConflict;
    let conflict = Boolean(id && result.status === 409 && result.body.error?.current);
    if (active(operation) && id && uncertain) {
      showSave('loading', '正在核对会议的最新版本…');
      const read = await saveRequest('GET', path);
      const latest = (!native || read.body.viewer_username === operation.viewer) && savedMeeting(read, operation);
      if (latest) {
        if (latest.revision >= revision && latest.revision <= revision + 1 && meetingMatchesChanges(latest, changes)) {
          meeting = latest;
        } else if (latest.revision > revision) {
          conflict = true;
          uncertain = false;
        } else if (readAfterConflict) {
          uncertain = false;
        }
      }
    }
    if (writing === operation) writing = null;
    if (!active(operation)) return;
    saveRetry = !meeting && uncertain ? operation : null;
    const newerDraft = operation.draft !== draftContents();
    const revisedCreate = meeting && !id && meeting.revision > 1;
    saveConflict = Boolean((!meeting && !uncertain && conflict) || (revisedCreate && newerDraft));
    syncWriting();
    if (!meeting) {
      if (uncertain) showSave('error', '暂时无法确认保存结果。草稿已保留，请重试。');
      else if (conflict) showSave('error', '会议已在别处更新。可核对版本后继续编辑。');
      else if (result.status === 409 && changes.source_call_id && result.body.error?.code === 'meeting_exists') {
        showSave('error', '这场通话已有纪要。草稿已保留，可复制修改后从通话链接打开已保存的纪要。');
      } else if (result.status === 409) showSave('error', '同名会议已存在。请更换标题后保存。');
      else showSave('error', messageFor(result.body.error, '保存失败。草稿已保留，请重试。'));
      return;
    }
    clearEditor();
    if (!native) meetings = [meeting, ...meetings.filter(item => item.id !== meeting.id)];
    else meetings = meetings.map(item => item.id === meeting.id ? meeting : item);
    if (!newerDraft && !audio.hasPendingWork() && layout?.dataset.view !== 'catalogue') fill(meeting);
    else {
      current = meeting;
      callDraft = null;
      savedDraft = operation.draft;
      editorBaseRevision = saveConflict ? 1 : meeting.revision;
      clearNoteCopies();
      for (const action of actions) delete action.savedIndex;
      if (!revisedCreate) operation.submittedActions.forEach((action, index) => { if (action) action.savedIndex = index; });
      syncWriting();
      syncRecord();
    }
    if (saveConflict) showSave('error', '会议已创建并在别处更新。可核对版本后继续编辑。');
    else showSave('ok', newerDraft ? '上次提交已保存。还有未保存的修改。' : '会议已保存。');
    void loadList({keepEditor: true, preserve: true});
  });

  attendeeInput.addEventListener('input', () => { refreshAttendees(); });

  attendeeInput.addEventListener('keydown', event => {
    if (attendeeList.hidden && event.key !== 'Escape') return;
    const options = attendeeOptions();
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive + 1);
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive - 1);
    } else if (event.key === 'Enter' && options.length) {
      event.preventDefault();
      chooseAttendee(options[attendeeActive >= 0 ? attendeeActive : 0].dataset.username);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideAttendees();
    }
  });

  newButton.addEventListener('click', () => {
    if (!workspaceId()) return;
    return confirmNavigation(() => {
      selection += 1;
      fill(null, null, undefined, {recover:true});
      show('', '');
      document.getElementById('main').scrollTop = 0;
      titleInput.focus?.();
    });
  });

  addAction.addEventListener('click', () => {
    if (actions.length >= 50) return;
    actions.push({text: '', owner: '', done: false});
    renderActions();
    actionList.lastElementChild?.firstElementChild.focus();
  });

  document.getElementById('cancel-meeting').addEventListener('click', () => confirmNavigation(() => {
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      openCatalogue({focus: true});
      show('', '');
    } else fill(current);
  }));

  mobileBack?.addEventListener('click', () => {
    if (!layout || form.hidden) return;
    layout.dataset.view = 'catalogue';
    transcriptImporter?.reset();
    resume.hidden = false;
    sharing.sync();
    document.getElementById('main').scrollTop = 0;
    if (current?.id === catalogueOrigin) focusCatalogue(resume);
    else resume.focus?.({preventScroll: true});
  });

  resume.addEventListener('click', () => {
    if (!layout || form.hidden) return;
    layout.dataset.view = 'editor';
    syncTranscriptImport();
    resume.hidden = true;
    sharing.sync();
    syncDraft();
    document.getElementById('main').scrollTop = 0;
    document.getElementById('meeting-editor-pane')?.focus?.({preventScroll: true});
  });

  remove.addEventListener('click', () => {
    if (!current?.id || remove.disabled) return;
    deleting = {...scope(), id: current.id, revision: current.revision};
    document.getElementById('meeting-delete-target').textContent = current.title;
    deleteDialog.showModal();
  });
  document.getElementById('cancel-remove-meeting')?.addEventListener('click', () => deleteDialog.close());
  document.getElementById('confirm-remove-meeting')?.addEventListener('click', async () => {
    const target = deleting;
    deleting = null;
    deleteDialog.close();
    if (!target || !active(target) || current?.id !== target.id || remove.disabled) return;
    const operation = {...target, kind: 'delete'};
    writing = operation;
    syncWriting();
    show('loading', '正在删除会议…');
    const body = native ? {revision: target.revision} : {};
    const result = await request('POST', `${base()}/${target.id}/remove`, body).catch(() => unavailable);
    if (writing === operation) writing = null;
    if (!active(operation)) return;
    if (native && result.status === 409) {
      saveConflict = true;
      syncWriting();
      show('', '');
      showSave('error', '会议已更新，已取消删除。请核对最新版本。');
      reviewConflict?.focus({preventScroll:true});
      return;
    }
    syncWriting();
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    const removed = result.body.removed;
    if (native && (result.body.viewer_username !== target.viewer || removed?.id !== target.id ||
        removed.workspace_id !== target.workspace || removed.revision !== target.revision)) {
      show('error', '无法确认删除结果，请重新打开会议核对。');
      return;
    }
    meetings = meetings.filter(item => item.id !== target.id);
    openCatalogue({focus: true});
    show('ok', '会议已删除。');
    if (native) void loadList({keepEditor: true, preserve: true});
  });

  document.getElementById('meeting-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-meeting]');
    if (!button) return;
    const id = button.dataset.meeting;
    const transcriptQuery = meetings.find(meeting => meeting.id === id)?.transcript_match ? search.value.trim() : '';
    if (!resume.hidden && current?.id === id) {
      resume.click();
      if (transcriptQuery) transcriptSearch.open(transcriptQuery);
    } else await confirmNavigation(() => {
      catalogueOrigin = id;
      catalogueTranscript = Boolean(transcriptQuery);
      return openMeeting(id, undefined, transcriptQuery);
    });
  });

  function filterMeetings(debounce = false) {
    if (!native || !workspaceId()) return;
    resetList();
    if (debounce) {
      searchTimer = setTimeout(() => void loadList({keepEditor: true}), 180);
      listStatus.textContent = '正在搜索会议…';
    } else void loadList({keepEditor: true});
    renderList();
  }

  search.addEventListener('input', () => filterMeetings(true));
  openOnly.addEventListener('change', () => filterMeetings());
  filters.addEventListener('submit', event => {
    event.preventDefault();
    filterMeetings();
  });
  listMore.addEventListener('click', () => loadList({keepEditor: true, append: true}));
  listRetry.addEventListener('click', () => retryList && loadList(retryList));

  inboxOpen?.addEventListener('click', () => setInbox(!inboxView));
  inboxReturn?.addEventListener('click', () => setInbox(true));
  sharedInboxReturn?.addEventListener('click', () => setInbox(true));
  inboxSource?.addEventListener('change', () => {
    if (inboxView) setInbox(true, {focus:false});
  });
  document.getElementById('meeting-inbox-close')?.addEventListener('click', () => setInbox(false));
  document.getElementById('meeting-inbox-refresh')?.addEventListener('click', () => inboxView && loadInbox(inboxView));
  inboxMore?.addEventListener('click', () => inboxView && loadInbox(inboxView, {append:true}));
  inboxMine?.addEventListener('change', () => {
    if (inboxView) setInbox(true, {focus:false});
  });
  inboxState?.addEventListener('change', () => {
    if (inboxView) setInbox(true, {focus:false});
  });

  workspaceSelect.addEventListener('change', () => {
    const next = workspaceId();
    if (hasUnsavedChanges()) workspaceSelect.value = editingWorkspace;
    return confirmNavigation(() => changeWorkspace(next));
  });

  function changeWorkspace(next) {
    workspaceSelect.value = next;
    libraryOrigin = null;
    const actionView = Boolean(inboxView);
    inboxResume = null;
    setInbox(false, {focus:false});
    workspaceLoad += 1;
    selection += 1;
    syncLibraryLink();
    audio.reset();
    showDraft();
    hideAttendees();
    memberCache = {workspace: '', items: [], failed: false};
    resetList();
    search.value = '';
    openOnly.checked = false;
    openCatalogue();
    if (actionView) setInbox(true, {focus:false});
    if (workspaceId()) void loadList({keepEditor:actionView});
  }

  const login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/login', {
        username: login.elements.username.value,
        password: login.elements.password.value,
      });
      if (result.status !== 200) {
        show('error', messageFor(result.body && result.body.error, '无法登录。'));
        return;
      }
      login.reset();
      await load();
    });
  }

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      return confirmNavigation(async () => {
        await request('POST', '/v1/auth/logout', {});
        await load();
      });
    });
  }

  load();
}

if (typeof document !== 'undefined' && document.getElementById('meeting-form')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}

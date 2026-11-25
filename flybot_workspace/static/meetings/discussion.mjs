import {readChatDrafts, writeChatDrafts} from '../home/runtime-readiness.mjs';

const ID = /^[a-f0-9]{32}$/;
const ATTEMPT_KEY = 'flybot-workspace.meeting-discussion-attempt';
const QUESTION = '请根据这份会议纪要梳理下一步，并指出需要澄清的问题。';
const SOURCE_LIMIT = 2900;
const QUESTION_LIMIT = 1000;

export function discussionContext(meeting, transcript = false) {
  const followups = (meeting.action_items || []).filter(item => !item.done).map(item =>
    '- ' + [item.text, item.owner && '负责人：' + item.owner, item.due_date && '截止：' + item.due_date]
      .filter(Boolean).join(' · ')).join('\n');
  const parts = [
    ['摘要', meeting.summary?.trim()],
    ['未完成的行动项', followups],
    ['转写 / 正文', transcript && meeting.shared !== true && meeting.transcript?.trim()],
  ].filter(([, text]) => text);
  if (!parts.length) return {text: '', clipped: false};
  const title = `会议《${meeting.title.trim()}》 · 修订 ${meeting.revision}`;
  const overhead = title.length + parts.reduce((total, [label]) => total + label.length + 3, 0);
  let remaining = SOURCE_LIMIT - overhead;
  let clipped = false;
  const blocks = parts.map(([label, text], index) => {
    const limit = Math.floor(remaining / (parts.length - index));
    if (text.length > limit) {
      clipped = true;
      text = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
    }
    remaining -= text.length;
    return label + '\n' + text;
  });
  return {text: [title, ...blocks].join('\n\n'), clipped};
}

export function mountMeetingDiscussion(document, {request, context, isDirty, openChat,
  key = () => 'meeting-discussion-' + crypto.randomUUID().replace(/-/g, '')}) {
  const button = document.getElementById('meeting-discussion');
  const dialog = document.getElementById('meeting-discussion-dialog');
  if (!button || !dialog) return {sync() {}};
  const view = document.defaultView;
  const control = name => document.getElementById('meeting-discussion-' + name);
  const form = control('form');
  const question = control('question');
  const entry = control('entry');
  const sharedEntry = document.getElementById('shared-meeting-discussion-entry');
  const sharedButton = document.getElementById('shared-meeting-discussion');
  const transcript = control('transcript');
  const transcriptOption = control('transcript-option');
  const preview = control('preview');
  const notice = control('notice');
  const status = control('status');
  const entryStatus = control('entry-status');
  const confirm = control('submit');
  const cancel = control('cancel');
  let target = null;
  let attempt = null;

  function sync(blocked = false) {
    const record = context();
    const meeting = record?.meeting;
    const useful = Boolean(meeting?.summary?.trim() || meeting?.action_items?.some(item => !item.done));
    entry.hidden = Boolean(record?.shared) || !(useful || meeting?.transcript?.trim());
    if (sharedEntry) sharedEntry.hidden = !record?.shared || !useful;
    button.disabled = blocked;
    if (sharedButton) sharedButton.disabled = blocked;
    if (entry.hidden || !isDirty()) entryStatus.textContent = '';
    if (target && !current(target)) dialog.close();
  }

  function refreshDraft() {
    if (!target) return;
    if (target.unavailable) {
      preview.value = '';
      confirm.disabled = true;
      return;
    }
    const {text, clipped} = discussionContext(target.meeting, !target.shared && transcript.checked);
    preview.value = text;
    notice.textContent = clipped ? '内容较长，预览仅包含截取的片段。'
      : target.shared ? '预览来自收到的共享纪要。打开后可在私人对话中修改，发送前智能体不会收到。'
      : !text ? '勾选转写 / 正文，添加本次会议的讨论资料。' : '';
    confirm.disabled = target.busy || !question.value.trim() || !text;
  }

  function retryKey(scope) {
    if (attempt?.scope === scope) return attempt.key;
    try {
      const stored = JSON.parse(view.sessionStorage.getItem(ATTEMPT_KEY));
      if (stored?.scope === scope && /^meeting-discussion-[a-f0-9]{32}$/.test(stored.key)) {
        attempt = stored;
        return stored.key;
      }
    } catch {}
    attempt = {scope, key: key()};
    try { view.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt)); } catch {}
    return attempt.key;
  }

  function current(candidate) {
    const record = context();
    return target === candidate && record?.owner === candidate.owner &&
      record?.workspace === candidate.workspace && record?.meeting.id === candidate.meeting.id &&
      record?.meeting.revision === candidate.meeting.revision && record.shared === candidate.shared;
  }

  function open(shared) {
    const record = context();
    if (!record || Boolean(record.shared) !== shared || (shared ? sharedButton : button).disabled) return;
    if (!shared && isDirty()) {
      entryStatus.textContent = '请先保存会议改动，再打开讨论。';
      return;
    }
    target = {...record, busy: false};
    question.value = QUESTION;
    question.disabled = false;
    cancel.disabled = false;
    transcript.checked = false;
    if (transcriptOption) transcriptOption.hidden = shared;
    transcript.disabled = shared || !record.meeting.transcript?.trim();
    status.textContent = '';
    refreshDraft();
    dialog.showModal();
  }
  button.addEventListener('click', () => open(false));
  sharedButton?.addEventListener('click', () => open(true));
  question.addEventListener('input', refreshDraft);
  transcript.addEventListener('change', refreshDraft);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (target?.busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    target = null;
    preview.value = '';
    question.value = '';
    entryStatus.textContent = '';
  });

  function validateSource(result, operation, session, reviewedText) {
    const {workspace, meeting, shared} = operation;
    const saved = result.body.meeting;
    if (shared && [403,404,410].includes(result.status)) {
      return '这份共享纪要已撤回或你没有查看权限。';
    }
    if (result.status !== 200 || saved?.id !== meeting.id || result.body.viewer_username !== session.body.user?.username ||
        (shared ? result.body.received !== true || saved.shared !== true : saved.workspace_id !== workspace)) return '';
    if (saved.revision !== meeting.revision || (shared && discussionContext(saved).text !== reviewedText)) {
      return '会议已有新版本。请重新打开会议，再从最新纪要发起讨论。';
    }
    return true;
  }
  function rejectSource(operation, result) {
    if (result) {
      status.textContent = result;
      if (operation.shared) {
        operation.unavailable = true;
        notice.textContent = '';
      }
    } else status.textContent = '无法确认会议或个人智能体。请刷新后重试。';
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const operation = target;
    const ask = question.value.trim();
    if (!operation || operation.busy || operation.unavailable || (!operation.shared && isDirty()) || !current(operation) || !ask ||
        ask.length > QUESTION_LIMIT || !preview.value) return;
    const reviewedText = preview.value;
    const draft = ask + '\n\n' + reviewedText;
    const {owner, workspace, meeting, shared} = operation;
    const sourcePath = `/v1/workspaces/${workspace}/meetings/${shared ? 'shared/' : ''}${meeting.id}`;
    operation.busy = confirm.disabled = cancel.disabled = question.disabled = transcript.disabled = true;
    status.textContent = '正在打开个人智能体对话…';
    try {
      const timeout = AbortSignal.timeout(12000);
      const [source, session, binding] = await Promise.all([
        request('GET', sourcePath, undefined, undefined, timeout),
        request('GET', '/v1/auth/session', undefined, undefined, timeout),
        request('GET', '/v1/personal-agent', undefined, undefined, timeout),
      ]);
      if (!current(operation)) return;
      const personal = binding.body.personal_agent;
      const ownWorkspace = personal?.workspace?.id, agent = personal?.agent?.id;
      if (session.status !== 200 || session.body.user?.id !== owner || binding.status !== 200 ||
          !ID.test(ownWorkspace || '') || !ID.test(agent || '')) {
        status.textContent = '无法确认会议或个人智能体。请刷新后重试。';
        return;
      }
      const authorized = validateSource(source, operation, session, reviewedText);
      if (authorized !== true) return rejectSource(operation, authorized);
      const title = ('会议讨论 · ' + meeting.title.trim().replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 120)
        .replace(/[\uD800-\uDBFF]$/, '');
      const scope = [owner, workspace, ...(shared ? ['shared'] : []), meeting.id, meeting.revision, ownWorkspace, agent].join('/');
      const path = shared ? sourcePath + '/discussion' : `/v1/workspaces/${ownWorkspace}/agents/${agent}/conversations`;
      const payload = shared ? {revision:meeting.revision} : {title, memory_recall:false};
      const result = await request('POST', path, payload, {'Idempotency-Key': retryKey(scope)}, AbortSignal.timeout(12000));
      if (!current(operation)) return;
      if (shared && [403,404,410].includes(result.status)) {
        return rejectSource(operation, '这份共享纪要已撤回或你没有查看权限。');
      }
      const conversation = shared ? result.body.discussion : result.body.conversation;
      if (![200, 201].includes(result.status) || !ID.test(conversation?.id || '') ||
          conversation?.workspace_id !== ownWorkspace || conversation?.agent_id !== agent ||
          (shared && result.body.viewer_username !== session.body.user?.username)) {
        status.textContent = shared ? '未能准备对话草稿。请重试。' : '未能确认对话已创建。请重试。';
        return;
      }
      if (shared) {
        const latest = await request('GET', sourcePath, undefined, undefined, AbortSignal.timeout(12000));
        if (!current(operation)) return;
        const authorized = validateSource(latest, operation, session, reviewedText);
        if (authorized !== true) return rejectSource(operation, authorized);
      }
      const draftScope = JSON.stringify([owner, ownWorkspace, 'agent', agent, conversation.id]);
      const drafts = readChatDrafts(view, owner);
      if (!drafts.has(draftScope)) drafts.set(draftScope, draft);
      if (!writeChatDrafts(view, owner, drafts)) {
        status.textContent = '浏览器无法保存草稿。请复制问题与上下文后重试。';
        return;
      }
      try { view.sessionStorage.removeItem(ATTEMPT_KEY); } catch {}
      attempt = null;
      openChat('/chat#' + new URLSearchParams({workspace: ownWorkspace, agent, conversation: conversation.id}));
    } catch {
      if (current(operation)) status.textContent = '暂时无法打开对话，请重试。';
    } finally {
      if (target === operation) {
        operation.busy = cancel.disabled = question.disabled = false;
        transcript.disabled = shared || !operation.meeting.transcript?.trim();
        refreshDraft();
      }
    }
  });

  return {sync};
}

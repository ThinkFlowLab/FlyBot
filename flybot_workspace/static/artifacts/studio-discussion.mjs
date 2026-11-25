const ID = /^[a-f0-9]{32}$/;
const ATTEMPT_KEY = 'flybot-workspace.studio-discussion-attempt';
const QUESTION_LIMIT = 1000;
const CONTEXT_LIMIT = 2900;

export function studioDiscussionContext(document) {
  const source = document.body.trim();
  if (!source) return {text: '', clipped: false};
  const heading = `团队文档《${document.title}》 · 版本 ${document.revision}\n\n`;
  const clipped = heading.length + source.length > CONTEXT_LIMIT;
  const excerpt = clipped ? source.slice(0, CONTEXT_LIMIT - heading.length - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : source;
  return {text: heading + excerpt, clipped};
}

export function mountStudioDiscussion(document, {request, source, openChat}) {
  const find = id => document.getElementById('studio-discussion-' + id);
  const dialog = find('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const view = document.defaultView;
  const form = find('form'), question = find('question'), include = find('include');
  const preview = find('preview'), previewWrap = find('preview-wrap'), notice = find('notice');
  const status = find('status'), submit = find('submit'), cancel = find('cancel');
  let target, attempt;

  function render(target) {
    const included = include.checked && !include.disabled;
    previewWrap.hidden = !included;
    preview.value = included ? target.context.text : '';
    notice.textContent = included && target.context.clipped ? '正文较长，草稿只会包含预览中的片段。' : '';
    submit.disabled = target.busy || !question.value.trim();
  }

  function close() {
    const operation = target;
    target = null;
    operation?.controller.abort();
    if (dialog.open) dialog.close();
    preview.value = question.value = find('source').textContent = '';
  }

  function open() {
    const snapshot = source();
    if (!snapshot || dialog.open) return;
    target = {...snapshot, context:studioDiscussionContext(snapshot.document), controller:new AbortController()};
    question.value = '请帮我梳理下一步，并指出需要澄清的问题。';
    include.checked = false;
    include.disabled = !target.context.text;
    status.textContent = '';
    find('source').textContent = snapshot.document.title + ' · 版本 ' + snapshot.document.revision;
    render(target);
    dialog.showModal();
    question.focus();
  }

  function retryKey(scope) {
    if (attempt?.scope === scope) return attempt.key;
    try {
      const entry = JSON.parse(view.sessionStorage.getItem(ATTEMPT_KEY));
      if (entry?.scope === scope && /^studio-discussion-[a-f0-9]{32}$/.test(entry.key)) {
        attempt = entry;
        return entry.key;
      }
    } catch {}
    const key = 'studio-discussion-' + view.crypto.randomUUID().replaceAll('-', '');
    attempt = {scope, key};
    try { view.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt)); } catch {}
    return key;
  }

  function sourceStillOpen(operation) {
    const current = source();
    return target === operation && current?.owner === operation.owner && current.workspace === operation.workspace &&
      current.document.id === operation.document.id && current.document.revision === operation.document.revision;
  }

  question.addEventListener('input', () => { if (target) render(target); });
  include.addEventListener('change', () => { if (target) render(target); });
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!target?.busy) close(); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const operation = target;
    const ask = question.value.trim();
    if (!operation || operation.busy || !ask || ask.length > QUESTION_LIMIT) return;
    const versionChanged = '团队文档已有更新。请关闭预览，从最新保存版本重新发起。';
    if (!sourceStillOpen(operation)) {
      status.textContent = versionChanged;
      return;
    }
    const draft = [ask, preview.value].filter(Boolean).join('\n\n');
    const {owner, workspace, document:saved} = operation;
    operation.busy = submit.disabled = cancel.disabled = question.disabled = include.disabled = true;
    status.textContent = '正在准备个人智能体草稿…';
    try {
      const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(15000)]);
      const [version, session, binding, {readChatDrafts, writeChatDrafts}] = await Promise.all([
        request('GET', `/v1/workspaces/${workspace}/studio/documents/${saved.id}`, undefined, {signal}),
        request('GET', '/v1/auth/session', undefined, {signal}),
        request('GET', '/v1/workspaces?scope=personal&include=chat&directory=0', undefined, {signal}),
        import('../home/runtime-readiness.mjs'),
      ]);
      if (target !== operation) return;
      const latest = version.body.document;
      if (version.status !== 200 || latest?.id !== saved.id) {
        status.textContent = '无法读取团队文档，请确认访问权限后重试。';
        return;
      }
      if (latest.revision !== saved.revision || latest.title !== saved.title || latest.body !== saved.body ||
          !sourceStillOpen(operation)) {
        status.textContent = versionChanged;
        return;
      }
      const personal = binding.body.items?.length === 1 ? binding.body.items[0] : null;
      const agent = binding.body.personal_agent_id, viewer = binding.body.viewer_username;
      const user = session.body.user;
      if (session.status !== 200 || user?.id !== owner || binding.status !== 200 ||
          personal?.kind !== 'personal' || !ID.test(personal.id || '') || !ID.test(agent || '') ||
          (!personal.owner_id && !viewer) || (personal.owner_id && personal.owner_id !== owner) ||
          (viewer && viewer !== user.username)) {
        status.textContent = '无法确认当前账号的个人智能体，请刷新后重试。';
        return;
      }
      const scope = [owner, workspace, saved.id, saved.revision, personal.id, agent].join('/');
      const source = {workspace_id:workspace, document_id:saved.id, revision:saved.revision};
      const opened = await request('POST', `/v1/workspaces/${personal.id}/agents/${agent}/conversations`,
        {title:'团队文档讨论', memory_recall:false, studio_source:source}, {headers:{'Idempotency-Key':retryKey(scope)},signal});
      if (target !== operation) return;
      const thread = opened.body.conversation;
      if (opened.status === 409 && opened.body.error?.code === 'studio_revision_changed') {
        status.textContent = versionChanged;
        return;
      }
      if (opened.status === 404) {
        status.textContent = '无法读取团队文档，请确认访问权限后重试。';
        return;
      }
      if (![200, 201].includes(opened.status) || !ID.test(thread?.id || '') ||
          thread.workspace_id !== personal.id || thread.agent_id !== agent ||
          thread.studio_source?.workspace_id !== workspace || thread.studio_source.document_id !== saved.id ||
          thread.studio_source.revision !== saved.revision) {
        status.textContent = '未能确认私人对话已创建，请重试。';
        return;
      }
      if (!sourceStillOpen(operation)) {
        status.textContent = versionChanged;
        return;
      }
      const draftScope = JSON.stringify([owner, personal.id, 'agent', agent, thread.id]);
      const drafts = readChatDrafts(view, owner);
      if (!drafts.has(draftScope)) drafts.set(draftScope, draft);
      if (!writeChatDrafts(view, owner, drafts)) {
        status.textContent = '浏览器无法保存草稿。请复制问题和预览内容后重试。';
        return;
      }
      try { view.sessionStorage.removeItem(ATTEMPT_KEY); } catch {}
      attempt = null;
      const path = '/chat#' + new URLSearchParams({workspace:personal.id, agent, conversation:thread.id});
      close();
      openChat(path);
    } catch {
      if (target === operation) status.textContent = '暂时无法打开私人对话，请重试。';
    } finally {
      if (target === operation) {
        operation.busy = cancel.disabled = question.disabled = false;
        include.disabled = !operation.context.text;
        render(operation);
      }
    }
  });

  return {open, close};
}

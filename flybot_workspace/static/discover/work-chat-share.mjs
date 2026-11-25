import { chatPathId, conversationLabel, idempotencyKey, socialMessageHref } from '../shell/chat-utils.mjs';

const workspaceId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function mountWorkChatShare(document, dialog, request) {
  const ui = Object.fromEntries(['panel', 'form', 'workspace', 'conversation', 'send', 'status', 'retry', 'receipt']
    .map(name => [name, document.getElementById('work-chat-share-' + name)]));
  const attempts = new Map();
  let state;

  const live = share => state === share && dialog.open && share.isCurrent();
  const status = (text, retry = false) => {
    ui.status.textContent = text;
    ui.retry.hidden = !retry;
  };
  function reset() {
    state?.read?.abort();
    state = null;
    ui.panel.hidden = true;
    ui.panel.open = false;
    ui.receipt.hidden = true;
  }

  function options(select, label, values) {
    select.replaceChildren();
    for (const [id, text] of [['', label], ...values]) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = text;
      select.append(option);
    }
    select.value = '';
  }

  async function readDirectory(share, loadWorkspaces) {
    if (!live(share) || share.sending) return;
    share.read?.abort();
    const controller = new AbortController();
    share.read = controller;
    const current = () => live(share) && share.read === controller;
    const get = path => request('GET', path, undefined, undefined, controller.signal).catch(() => ({status:0}));
    ui.send.disabled = ui.conversation.disabled = true;
    ui.receipt.hidden = true;
    share.conversations.clear();
    options(ui.conversation, '请选择会话', []);

    if (loadWorkspaces) {
      ui.workspace.disabled = true;
      status('正在读取工作区…');
      const workspaces = new Map();
      const seen = new Set();
      let cursor = '';
      do {
        const result = await get('/v1/workspaces?limit=100' + (cursor ? '&cursor=' + cursor : ''));
        if (!current()) return;
        if (result.status !== 200 || !Array.isArray(result.body?.items)) {
          status('无法读取工作区。', true);
          return;
        }
        for (const item of result.body.items) {
          if (workspaceId(item?.id) && typeof item.name === 'string') workspaces.set(item.id, item.name);
        }
        cursor = result.body.cursor;
        if (!workspaceId(cursor) || seen.has(cursor)) break;
        seen.add(cursor);
      } while (cursor);
      share.workspaces = workspaces;
      options(ui.workspace, '请选择工作区', workspaces);
      ui.workspace.value = workspaces.keys().next().value || '';
      ui.workspace.disabled = workspaces.size < 2;
    }

    const workspace = ui.workspace.value;
    if (!share.workspaces.has(workspace)) {
      status('没有可用的工作区。');
      return;
    }
    status('正在读取会话…');
    const result = await get(`/v1/workspaces/${workspace}/social/conversations?limit=100`);
    if (!current()) return;
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      status('无法读取会话。', true);
      return;
    }
    for (const row of result.body.items) {
      if (typeof row?.id === 'string' && chatPathId(row.id) && !row.public_agent && row.direct?.open !== false) {
        share.conversations.set(row.id, conversationLabel(row, share.viewer));
      }
    }
    options(ui.conversation, '请选择会话', share.conversations);
    ui.conversation.disabled = !share.conversations.size;
    status(share.conversations.size ? '' : '当前工作区没有可接收链接的会话。');
  }

  ui.panel.addEventListener('toggle', () => {
    if (state && ui.panel.open && !state.started) {
      state.started = true;
      return readDirectory(state, true);
    }
  });
  ui.workspace.addEventListener('change', () => state && readDirectory(state, false));
  ui.retry.addEventListener('click', () => state && readDirectory(state, !state.workspaces));
  ui.conversation.addEventListener('change', () => {
    ui.send.disabled = !state?.conversations.has(ui.conversation.value);
    ui.receipt.hidden = true;
    status('');
  });

  ui.form.addEventListener('submit', async event => {
    event.preventDefault();
    const share = state;
    const workspace = ui.workspace.value;
    const conversation = ui.conversation.value;
    if (!share || !live(share) || share.sending || !share.workspaces?.has(workspace) || !share.conversations.has(conversation)) return;
    const key = JSON.stringify([share.viewer.id, share.url, workspace, conversation]);
    const attempt = attempts.get(key) || idempotencyKey('work-share-');
    attempts.set(key, attempt);
    if (attempts.size > 32) attempts.delete(attempts.keys().next().value);
    share.sending = true;
    ui.workspace.disabled = ui.conversation.disabled = ui.send.disabled = true;
    status('正在发送链接…');
    const path = `/v1/workspaces/${workspace}/social/conversations/${conversation}/messages`;
    const result = await request('POST', path, {body:share.url}, {'Idempotency-Key':attempt}).catch(() => ({status:0}));
    const message = result.body?.message;
    const receipt = [200, 201].includes(result.status) && message?.workspace_id === workspace && message.conversation_id === conversation &&
      socialMessageHref({workspace, conversation, message:message.id});
    if (receipt) attempts.delete(key);
    if (!live(share)) return;
    share.sending = false;
    ui.workspace.disabled = share.workspaces.size < 2;
    ui.conversation.disabled = false;
    if (!receipt) {
      ui.send.disabled = false;
      status(result.body?.error?.message || '未能确认发送结果，请在当前会话重试。');
      return;
    }
    ui.conversation.value = '';
    status('已分享到「' + share.conversations.get(conversation) + '」。');
    ui.receipt.href = receipt;
    ui.receipt.hidden = false;
    ui.receipt.focus();
  });

  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  return {
    prepare(share) {
      reset();
      if (!share?.viewer?.id || !share.url.startsWith('http')) return;
      state = {...share, conversations:new Map()};
      ui.panel.hidden = false;
      options(ui.workspace, '请选择工作区', []);
      options(ui.conversation, '请选择会话', []);
      ui.workspace.disabled = ui.conversation.disabled = ui.send.disabled = true;
      status('');
    },
  };
}

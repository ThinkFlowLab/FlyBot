import {directAgentAccessHref} from '../shell/chat-utils.mjs';

const grantId = /^otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const conversationId = /^otc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function mountAgentSharing(document, {request, context, idempotencyKey}) {
  const node = id => document.getElementById('agent-share-' + id);
  const dialog = node('dialog');
  const recipient = node('recipient');
  const instructions = node('instructions');
  const quickStarts = node('quick-starts');
  const status = node('status');
  const submit = node('submit');
  const text = (zh, en) => document.documentElement?.lang?.startsWith('en') ? en : zh;
  const person = profile => [profile?.display_name, profile?.handle && '@' + profile.handle].filter(Boolean).join(' · ');
  const keys = new Map();
  let view;

  for (const [id, zh, en] of [
    ['recipient-label','收件人','Recipient'],
    ['recipients-more','加载更多收件人','More recipients'], ['content-label','随副本分享','Include in the copy'],
    ['instructions-label','已保存的指令','Saved instructions'], ['quick-starts-label','已保存的快捷开场','Saved quick starts'],
    ['close','关闭','Close'],
  ]) node(id).textContent = text(zh,en);

  function renderLabels(access) {
    node('title').textContent = access ? text('授权与原智能体对话','Authorize chat with the original agent')
      : text('私下分享智能体','Share agent privately');
    node('content').hidden = access;
    node('note').textContent = access
      ? text('双方可请求原智能体回复。每次只传当前文字和明确引用的一条消息。回复由所有者的独立容器生成。',
        'Both people can ask the original agent to reply. A request includes only its text and one explicitly selected quote, if any. The agent replies from its owner’s container.')
      : text('对方可将名称、简介和分类复制到个人工作区，并另行配置工具。',
        'The recipient can copy the name, summary, and category into their personal workspace and configure tools there.');
    submit.textContent = access ? text('授权对话','Authorize chat') : text('创建分享','Create share');
    node('link-label').textContent = access ? text('对话链接','Chat link') : text('收件人链接','Recipient link');
    node('sent-title').textContent = access ? text('已授权的对话','Authorized chats') : text('已发出的分享','Sent shares');
    node('sent-more').textContent = access ? text('加载更多对话','More chats') : text('加载更多分享','More shares');
    node('open-chat').textContent = text('打开对话','Open chat');
  }

  function current(state) {
    const selected = context();
    return view === state && dialog.open && selected?.user === state.user && selected.workspace === state.workspace &&
      selected.agent.id === state.agent.id && selected.agent.revision === state.agent.revision;
  }

  function controls(state) {
    recipient.disabled = state.busy || !state.recipients.items.length;
    instructions.disabled = state.busy || !state.agent.instructions;
    quickStarts.disabled = state.busy || !state.agent.quick_starts?.length;
    submit.disabled = state.busy || !state.canCreate || !state.recipients.items.some(row => row.owner_id === recipient.value);
    node('close').disabled = state.busy;
    for (const kind of ['recipients','sent']) {
      const page = state[kind];
      const more = node(kind + '-more');
      more.hidden = !page.next && !page.failed;
      more.disabled = page.loading || state.busy;
    }
  }

  function normalizeGrant(state, grant) {
    if (!state.access) return grantId.test(grant?.id || '') && grant.source_agent_id === state.agent.id ? grant : null;
    if (!conversationId.test(grant?.conversation_id || '') || grant.agent_id !== state.agent.id) return null;
    return {...grant, id:grant.conversation_id, state:grant.state || (grant.revoked_at ? 'revoked' : 'active')};
  }

  function clearLink() {
    node('link').value = '';
    node('link-field').hidden = true;
    node('open-chat').hidden = true;
    node('open-chat').removeAttribute('href');
  }

  function showLink(state, grant) {
    const path = state.access ? directAgentAccessHref({conversation:grant.id,ownerId:grant.owner_id,agentId:grant.agent_id}) ||
      '/chat#' + new URLSearchParams({social:grant.id}) : '/discover?' + new URLSearchParams({tab:'agents', share:grant.id});
    const origin = document.defaultView?.location?.origin;
    state.linkId = grant.id;
    node('link').value = origin ? origin + path : path;
    node('link-field').hidden = false;
    if (state.access) {
      node('open-chat').href = path;
      node('open-chat').hidden = false;
    }
  }

  async function copyLink(state, grant) {
    showLink(state, grant);
    try {
      await document.defaultView.navigator.clipboard.writeText(node('link').value);
      if (current(state)) status.textContent = state.access ? text('已复制对话链接。','Chat link copied.')
        : text('已复制收件人链接。', 'Recipient link copied.');
    } catch {
      if (!current(state)) return;
      node('link').focus();
      node('link').select();
      status.textContent = text('请选中并复制链接。', 'Select and copy the link.');
    }
  }

  function button(label, action) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
  }

  function renderSent(state) {
    node('sent').replaceChildren(...state.sent.items.map(grant => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const labels = {active: text('有效','Active'), revoked: text('已撤销','Revoked'), closed: text('已关闭','Closed')};
      label.textContent = person(grant.recipient) + ' · ' + labels[grant.state];
      row.append(label);
      if (grant.state !== 'active') return row;
      const copy = button(state.access ? text('复制对话链接','Copy chat link') : text('复制链接','Copy link'),
        () => { if (current(state)) void copyLink(state,grant); });
      const revoke = button(text('撤销','Revoke'), () => {
        if (!current(state) || state.busy) return;
        const confirm = button(text('确认撤销','Confirm revoke'), () => void revokeGrant(state,grant));
        const cancel = button(text('取消','Cancel'), () => { confirm.remove(); cancel.remove(); revoke.hidden = false; revoke.focus(); });
        revoke.hidden = true;
        row.append(cancel,confirm);
        cancel.focus();
      });
      row.append(copy,revoke);
      return row;
    }));
  }

  function renderRecipients(items) {
    const previous = recipient.value;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = text('选择收件人','Select recipient');
    recipient.replaceChildren(placeholder, ...items.map(profile => {
      const option = document.createElement('option');
      option.value = profile.owner_id;
      option.textContent = person(profile);
      return option;
    }));
    recipient.value = items.some(profile => profile.owner_id === previous) ? previous : '';
  }

  async function load(state, kind) {
    const page = state[kind];
    if (!current(state) || state.busy || page.loading) return;
    page.loading = true;
    controls(state);
    const query = new URLSearchParams({limit:'30'});
    if (page.next) query.set('after', page.next);
    const path = kind === 'sent' ? state.path : '/v1/agent-copy-grants/recipients';
    const result = await request('GET', path + '?' + query).catch(() => null);
    if (!current(state)) return;
    page.loading = false;
    page.failed = result?.status !== 200;
    if (page.failed) status.textContent = text('加载失败，请重试。','Could not load. Try again.');
    else {
      const items = Array.isArray(result.body.items) ? result.body.items : [];
      const key = kind === 'sent' ? 'id' : 'owner_id';
      const found = new Map(page.items.map(row => [row[key],row]));
      for (const row of items) {
        const item = kind === 'sent' ? normalizeGrant(state,row) : row;
        if (kind === 'sent') {
          if (!item) continue;
          if (item.state === 'active' && found.has(item.id) && found.get(item.id).state !== 'active') continue;
        } else if (typeof item.owner_id !== 'string') continue;
        found.set(item[key],item);
      }
      page.items = [...found.values()];
      page.next = result.body.next_cursor || '';
      if (kind === 'sent') renderSent(state);
      else {
        renderRecipients(page.items);
        if (!page.items.length) status.textContent = text('暂无符合条件的联系人或队友。','No eligible contacts or teammates.');
      }
    }
    controls(state);
  }

  async function revokeGrant(state, grant) {
    if (!current(state) || state.busy) return;
    state.busy = true;
    controls(state);
    const result = await request('POST', `${state.path}/${grant.id}/revoke`, {}).catch(() => null);
    if (!current(state)) return;
    state.busy = false;
    controls(state);
    const confirmed = state.access ? result?.body?.access?.conversation_id === grant.id || result?.body?.revoked === true
      : result?.body?.grant?.id === grant.id;
    if (result?.status !== 200 || !confirmed) {
      status.textContent = result?.body?.error?.message || (state.access ? text('无法撤销对话授权。','Could not revoke chat access.')
        : text('无法撤销分享。','Could not revoke the share.'));
      return;
    }
    const revoked = state.access ? {...grant,state:'revoked'} : result.body.grant;
    state.sent.items = state.sent.items.map(item => item.id === grant.id ? revoked : item);
    if (state.linkId === grant.id) {
      state.linkId = null;
      clearLink();
    }
    renderSent(state);
    status.textContent = state.access ? text('已撤销对话授权。','Chat access revoked.') : text('已撤销分享。','Share revoked.');
    node('close').focus({preventScroll:true});
  }

  node('form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = view;
    if (!state || !current(state) || submit.disabled) return;
    const body = {recipient_owner_id:recipient.value, revision:state.agent.revision,
      ...(!state.access ? {share_instructions:!instructions.disabled && instructions.checked,
        share_quick_starts:!quickStarts.disabled && quickStarts.checked} : {})};
    const fingerprint = JSON.stringify([state.user,state.path,body]);
    const key = keys.get(fingerprint) || idempotencyKey();
    keys.set(fingerprint,key);
    state.busy = true;
    controls(state);
    status.textContent = state.access ? text('正在授权…','Authorizing chat…') : text('正在创建分享…','Creating share…');
    const result = await request('POST', state.path, body, {'Idempotency-Key':key}).catch(() => null);
    if (!current(state)) return;
    state.busy = false;
    const grant = normalizeGrant(state,state.access ? result?.body?.access : result?.body?.grant);
    if (![200,201].includes(result?.status) || !grant || grant.recipient?.owner_id !== body.recipient_owner_id) {
      status.textContent = result?.body?.error?.message || (state.access ? text('无法确认是否已授权，请重试。','Could not confirm chat access. Try again.')
        : text('无法确认是否已创建分享，请重试。','Could not confirm the share. Try again.'));
    } else {
      keys.delete(fingerprint);
      state.sent.items = [grant,...state.sent.items.filter(item => item.id !== grant.id)];
      renderSent(state);
      showLink(state,grant);
      status.textContent = state.access ? text('已授权对话。','Chat authorized.') : text('已创建分享。','Share created.');
      recipient.value = '';
    }
    controls(state);
  });
  recipient.addEventListener('change', () => { if (view) controls(view); });
  for (const kind of ['recipients','sent']) node(kind+'-more').addEventListener('click', () => { if (view) void load(view,kind); });
  node('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (view?.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    view = null;
    recipient.replaceChildren();
    node('sent').replaceChildren();
    node('name').textContent = status.textContent = '';
    clearLink();
  });

  return {
    open({access = false} = {}) {
      const selected = context();
      if (!selected || dialog.open) return;
      const {agent,workspace} = selected;
      const state = view = {...selected, access, path:`/v1/workspaces/${workspace}/agents/${agent.id}/${access ? 'access' : 'shares'}`,
        recipients:{items:[]}, sent:{items:[]}, canCreate:!agent.archived && !agent.native_deleted};
      node('form').hidden = !state.canCreate;
      renderLabels(access);
      node('name').textContent = agent.name;
      status.textContent = '';
      clearLink();
      instructions.checked = quickStarts.checked = false;
      renderRecipients([]);
      renderSent(state);
      controls(state);
      dialog.showModal();
      if (state.canCreate) void load(state,'recipients');
      void load(state,'sent');
    },
    close() {
      view = null;
      if (dialog.open) dialog.close();
    },
  };
}

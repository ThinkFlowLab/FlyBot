const ID = /^[0-9a-f]{32}$/;
const DUE_CURSOR = /^[012]:-?\d{1,11}:[0-9a-f]{32}$/;

function actionPath(workspace, id) {
  return `/v1/workspaces/${workspace}/memory/actions${id ? '/' + id : ''}`;
}

function actionInScope(item, workspace, id = item?.id) {
  return ID.test(id || '') && item?.id === id && item.workspace_id === workspace &&
    typeof item.title === 'string' && ['open', 'done'].includes(item.status) &&
    Number.isSafeInteger(item.revision) && item.revision > 0;
}

function dueDate(value) {
  const date = new Date(value * 1000);
  return Number.isInteger(value) && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

export function mountChecklist(document, {request, newKey}) {
  const byId = id => document.getElementById(id);
  const list = byId('checklist-list');
  if (!list) return null;
  const query = byId('checklist-search');
  const filter = byId('checklist-filter');
  const status = byId('checklist-status');
  const empty = byId('checklist-empty');
  const retry = byId('checklist-retry');
  const more = byId('checklist-more');
  const open = byId('new-checklist-action');
  const editor = byId('checklist-editor');
  const cancel = byId('close-checklist-editor');
  const editorStatus = byId('checklist-editor-status');
  const save = byId('save-checklist-action');
  const schedule = byId('schedule-checklist-action');
  const source = byId('view-checklist-source');
  const fields = editor.elements;
  let active;
  let reading;
  let searchTimer;
  let editing;
  let attempt;
  let writing;

  function stopReading() {
    globalThis.clearTimeout(searchTimer);
    reading?.abort();
    reading = undefined;
  }

  function closeEditor(restoreFocus = false) {
    const opener = editing?.opener;
    editing = undefined;
    editor.hidden = true;
    editorStatus.textContent = '';
    open.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (opener?.isConnected ? opener : open).focus();
  }

  function close() {
    stopReading();
    active = undefined;
    writing = undefined;
    attempt = undefined;
    closeEditor();
  }

  function openEditor(item, opener) {
    if (writing || !active) return;
    editing = {item, opener};
    fields.title.value = item?.title || '';
    fields.notes.value = item?.notes || '';
    fields.due.value = dueDate(item?.due_at);
    byId('checklist-editor-heading').textContent = item ? '编辑待办' : '新建待办';
    editorStatus.textContent = '';
    open.setAttribute('aria-expanded', 'true');
    schedule.hidden = item?.status !== 'open';
    source.hidden = !item;
    if (item) {
      schedule.href = '/automations?' + new URLSearchParams({workspace:active.workspace, memory_action:item.id, revision:item.revision});
      source.href = '/memory?' + new URLSearchParams({workspace:active.workspace, page:'todos', action:item.id});
    }
    editor.hidden = false;
    fields.title.focus();
  }

  function render(state, focus) {
    list.replaceChildren();
    for (const item of state.items) {
      const row = document.createElement('li');
      row.dataset.highlighted = String(state.action === item.id);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'checklist-toggle';
      toggle.dataset.actionToggle = item.id;
      toggle.setAttribute('aria-label', `${item.status === 'done' ? '重新打开' : '标记完成'}：${item.title}`);
      toggle.setAttribute('aria-pressed', String(item.status === 'done'));
      toggle.disabled = state.pending.has(item.id);
      if (item.status === 'done') toggle.textContent = '✓';
      toggle.addEventListener('click', () => void changeStatus(state,item));
      const details = document.createElement('button');
      details.type = 'button';
      details.className = 'checklist-item-details';
      details.dataset.actionDetail = item.id;
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = item.title;
      copy.append(title);
      const date = dueDate(item.due_at);
      if (date || item.memory_page_title) {
        const meta = document.createElement('small');
        meta.textContent = [date && `截止 ${date}`, item.memory_page_title].filter(Boolean).join(' · ');
        copy.append(meta);
      }
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '›';
      details.append(copy,icon);
      details.addEventListener('click', () => openEditor(item,details));
      row.append(toggle,details);
      list.append(row);
      if (focus === item.id) details.focus({preventScroll:true});
    }
    empty.hidden = Boolean(state.items.length);
    empty.textContent = query.value.trim() ? '没有匹配的待办。'
      : filter.value === 'done' ? '还没有已完成的待办。' : '暂无待办。可以新建，也可以把聊天里的消息转为行动。';
    more.hidden = !state.cursor;
  }

  async function load({after = '', reveal = '', notice = ''} = {}) {
    const state = active;
    if (!state) return;
    stopReading();
    const controller = reading = new AbortController();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
    const params = new URLSearchParams({order:'due',limit:'20'});
    if (query.value.trim()) params.set('q', query.value.trim());
    if (filter.value) params.set('status', filter.value);
    if (after) params.set('after', after);
    const get = path => request('GET',path,undefined,undefined,signal).catch(() => null);
    list.setAttribute('aria-busy', 'true');
    more.disabled = true;
    retry.hidden = true;
    status.textContent = notice || '正在读取待办…';
    const [result, detail] = await Promise.all([get(actionPath(state.workspace) + '?' + params),
      reveal ? get(actionPath(state.workspace,reveal)) : null]);
    if (active !== state || reading !== controller || controller.signal.aborted) return;
    reading = undefined;
    list.setAttribute('aria-busy', 'false');
    more.disabled = false;
    if (result?.status !== 200 || !Array.isArray(result.body?.items)) {
      status.textContent = '无法读取待办。请重试。';
      retry.hidden = false;
      return;
    }
    const items = new Map((after ? state.items : []).map(item => [item.id,item]));
    for (const item of result.body.items) if (actionInScope(item,state.workspace)) items.set(item.id,item);
    const card = detail?.status === 200 && detail.body.action;
    if (actionInScope(card,state.workspace,reveal)) items.set(reveal,card);
    state.items = [...items.values()];
    const cursor = result.body.cursor;
    state.cursor = cursor !== after && DUE_CURSOR.test(cursor || '') ? cursor : '';
    status.textContent = notice || (reveal && !items.has(reveal) ? '找不到这条待办。' : '');
    render(state, reveal || (after ? result.body.items[0]?.id : undefined));
  }

  async function changeStatus(state, item) {
    if (state !== active || state.pending.has(item.id)) return;
    const desired = item.status === 'done' ? 'open' : 'done';
    state.pending.add(item.id);
    const control = list.querySelector(`[data-action-toggle="${item.id}"]`);
    if (control) control.disabled = true;
    status.textContent = '正在更新待办…';
    const path = actionPath(state.workspace,item.id);
    const result = await request('POST',path,{revision:item.revision,changes:{status:desired}},
      undefined,AbortSignal.timeout(8000)).catch(() => null);
    state.pending.delete(item.id);
    if (state !== active) return;
    const updated = result?.body?.action;
    const completed = result?.status === 200 && actionInScope(updated,state.workspace,item.id) && updated.status === desired;
    await load({notice:completed ? (desired === 'done' ? '已标记完成。' : '待办已重新打开。')
      : '无法确认状态更新，正在读取最新记录。'});
    if (state === active && document.activeElement === document.body) {
      (list.querySelector(`[data-action-toggle="${item.id}"]`) || list.querySelector('.checklist-toggle') || filter).focus();
    }
  }

  open.addEventListener('click', () => openEditor(null,open));
  cancel.addEventListener('click', () => closeEditor(true));
  query.addEventListener('input', () => {
    stopReading();
    searchTimer = globalThis.setTimeout(() => void load(),150);
  });
  filter.addEventListener('change', () => void load());
  retry.addEventListener('click', () => void load({reveal:active?.action}));
  more.addEventListener('click', () => {
    if (active?.cursor) void load({after:active.cursor});
  });
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    const state = active;
    if (!state || !editing || writing || !fields.title.value.trim()) return;
    const target = writing = editing;
    const changes = {title:fields.title.value.trim(),notes:fields.notes.value,
      due_at:fields.due.value ? Date.parse(fields.due.value + 'T00:00:00Z') / 1000 : null};
    const item = target.item;
    const payload = item ? {revision:item.revision,changes} : changes;
    const signature = JSON.stringify(changes);
    if (!item && attempt?.signature !== signature) attempt = {signature,key:newKey()};
    save.disabled = cancel.disabled = true;
    editorStatus.textContent = '正在保存待办…';
    const result = await request('POST',actionPath(state.workspace,item?.id),payload,
      item ? undefined : {'Idempotency-Key':attempt.key},AbortSignal.timeout(8000)).catch(() => null);
    if (active !== state) return;
    writing = undefined;
    save.disabled = cancel.disabled = false;
    const row = result?.body?.action;
    if ([200,201].includes(result?.status) && actionInScope(row,state.workspace,item?.id || row?.id)) {
      attempt = undefined;
      closeEditor(true);
      if (!item) filter.value = 'open';
      await load({notice:item ? '待办已更新。' : '待办已创建。'});
      return;
    }
    const current = result?.body?.error?.current;
    if (item && result?.status === 409 && actionInScope(current,state.workspace,item.id)) {
      target.item = current;
      editorStatus.textContent = '待办已在另一处修改。请核对你的输入后重新保存。';
    } else {
      editorStatus.textContent = result?.body?.error?.message || '无法确认保存，请重试。';
    }
  });

  return {close, show(workspace, owner, action = '') {
    if (active?.workspace === workspace && active.owner === owner && active.action === action) return;
    close();
    if (!ID.test(workspace || '') || !owner) return;
    active = {workspace,owner,action,items:[],pending:new Set()};
    save.disabled = cancel.disabled = false;
    query.value = '';
    filter.value = action ? '' : 'open';
    list.replaceChildren();
    empty.hidden = true;
    more.hidden = true;
    return load({reveal:action});
  }};
}

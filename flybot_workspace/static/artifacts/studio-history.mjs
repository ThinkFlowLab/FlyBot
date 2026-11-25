export function mountStudioHistory(document, {context, send, restoreVersion, savePersonal}) {
  const get = name => document.getElementById('studio-history' + (name ? '-' + name : ''));
  const dialog = get();
  const open = get('open');
  if (!dialog || !open) return {sync() {}, dismiss() {}, showVersion() {}};
  const list = get('list'), preview = get('preview'), restore = get('restore'), status = get('status');
  const refresh = get('refresh'), close = get('close');
  const personal = get('save-personal');
  const view = document.defaultView;
  let active, pending;
  let restoring = false;

  function canRestore() {
    const current = context();
    return active && current?.path === active.path && !current.dirty && !current.busy &&
      !current.unavailable && !current.blocked && active.current === current.revision &&
      active.selected > 0 && active.selected < active.current;
  }

  function sync() {
    const current = context();
    open.hidden = !current || current.unavailable;
    open.disabled = Boolean(current?.busy);
    restore.disabled = restoring || !canRestore();
    if (personal) personal.hidden = !current?.personalCopy || current.unavailable || !active?.selected || !savePersonal;
    refresh.disabled = close.disabled = restoring;
  }

  function dismiss() {
    pending?.abort();
    pending = active = undefined;
    restoring = false;
    preview.hidden = true;
    list.replaceChildren();
    get('title').textContent = get('body').textContent = '';
    status.textContent = '';
    if (dialog.open) dialog.close();
  }

  async function read(path) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const result = await send('GET', path, undefined, controller.signal);
    return active && pending === controller ? result : null;
  }

  async function choose(revision) {
    const history = active;
    history.selected = 0;
    preview.hidden = true;
    sync();
    status.textContent = '正在读取版本…';
    const result = await read(history.path + '/versions/' + revision);
    if (!result || active !== history) return;
    const version = result.body.version;
    if (result.status !== 200 || version?.revision !== revision ||
        typeof version.title !== 'string' || typeof version.body !== 'string') {
      status.textContent = result.status === 404 ? '该版本已不可用。' : '该版本暂时无法打开，请刷新版本列表。';
      return;
    }
    history.current = result.body.current_revision;
    history.selected = revision;
    get('title').textContent = '版本 ' + revision + ' · ' + version.title;
    get('body').textContent = version.body;
    preview.hidden = false;
    status.textContent = context()?.dirty ? '请先保存或放弃当前草稿，再恢复旧版本。' : '';
    sync();
  }

  async function load() {
    const history = active;
    history.selected = 0;
    preview.hidden = true;
    list.replaceChildren();
    sync();
    status.textContent = '正在读取版本历史…';
    const result = await read(history.path + '/versions');
    if (!result || active !== history) return;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      status.textContent = '版本历史暂不可用，请重试。';
      return;
    }
    history.current = result.body.current_revision;
    status.textContent = result.body.items.length
      ? '最多保留最近 ' + result.body.retained_limit + ' 个版本。' : '暂无可查看的版本。';
    for (const version of result.body.items) {
      if (!Number.isSafeInteger(version?.revision) || typeof version.title !== 'string') continue;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = [
        '版本 ' + version.revision, version.title, version.updated_by,
        version.restored_from ? '恢复自版本 ' + version.restored_from : '',
      ].filter(Boolean).join(' · ');
      button.addEventListener('click', () => { if (!restoring) void choose(version.revision); });
      item.append(button);
      list.append(item);
    }
  }

  function showVersion(revision) {
    const current = context();
    if (!current || current.unavailable || current.busy || dialog.open) return;
    active = {path:current.path};
    dialog.showModal();
    refresh.focus();
    if (revision) void choose(revision);
    else void load();
  }

  open.addEventListener('click', () => showVersion());
  personal?.addEventListener('click',()=>{ if (active?.selected) savePersonal?.(active.selected); });
  refresh.addEventListener('click', () => { if (active && !restoring) void load(); });
  close.addEventListener('click', () => { if (!restoring) dismiss(); });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!restoring) dismiss();
  });
  restore.addEventListener('click', async () => {
    if (!canRestore() || restoring) return;
    const history = active;
    if (!view.confirm('要将版本 ' + history.selected + ' 恢复为新的团队版本吗？')) return;
    restoring = true;
    sync();
    status.textContent = '正在恢复…';
    const result = await restoreVersion(history.path, history.current, history.selected);
    if (active !== history) return;
    restoring = false;
    if (result === 'restored') {
      dismiss();
      open.focus();
      return;
    }
    status.textContent = result === 'conflict' ? '团队文档已更新，请刷新后再恢复。' : '暂未确认恢复结果，请刷新版本。';
    sync();
  });

  return {sync,dismiss,showVersion};
}

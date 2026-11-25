const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const idPattern = /^[a-f0-9]{32}$/;

export function mountSpaceFileUpload(document, {scope, save, refresh, key}) {
  const ui = Object.fromEntries(['dialog', 'form', 'files', 'rows', 'status', 'submit', 'close']
    .map(name => [name, document.getElementById('space-upload-' + name)]));
  let batch;

  function current(value) {
    const active = scope();
    return batch === value && active?.workspace === value.workspace && active?.owner === value.owner;
  }

  function sync(value) {
    const pending = value.rows.some(row => !row.done && !row.invalid);
    ui.files.disabled = ui.close.disabled = value.saving;
    ui.submit.disabled = value.saving || !pending;
    ui.submit.textContent = value.saving ? '正在上传…' : '上传文件';
    ui.close.textContent = value.rows.length && !pending ? '完成' : '关闭';
  }

  function line(file) {
    const item = document.createElement('li');
    const title = document.createElement('input');
    const original = document.createElement('span');
    const feedback = document.createElement('span');
    const invalid = !file.size || file.size > MAX_UPLOAD_BYTES;
    original.className = 'space-upload-filename';
    original.textContent = file.name;
    title.type = 'text';
    title.required = true;
    title.maxLength = 80;
    title.value = file.name.trim().slice(0, 80);
    title.setAttribute('aria-label', file.name + ' 的作品标题');
    title.disabled = invalid;
    feedback.className = 'note';
    feedback.textContent = invalid ? '文件为空或大于 2 MB。' : '';
    item.append(original, title, feedback);
    return {file, item, title, feedback, invalid};
  }

  ui.files.addEventListener('change', () => {
    if (!batch || !current(batch) || batch.saving) return;
    batch.rows = Array.from(ui.files.files, line);
    ui.rows.replaceChildren(...batch.rows.map(row => row.item));
    ui.status.textContent = batch.rows.length ? '已选 ' + batch.rows.length + ' 个文件。' : '';
    sync(batch);
  });

  ui.form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = batch;
    if (!value || !current(value) || value.saving) return;
    value.saving = true;
    sync(value);
    let saved = 0;
    try {
      for (const row of value.rows) {
        if (!current(value)) return;
        if (row.done || row.invalid) continue;
        const title = row.title.value.trim();
        if (!title) {
          row.feedback.textContent = '请输入作品标题。';
          continue;
        }
        row.attempt ??= {title, key:key()};
        row.title.readOnly = true;
        row.feedback.textContent = '正在上传…';
        const result = await save(value.workspace, row.file, row.attempt, value.controller.signal)
          .catch(() => ({status:0}));
        if (!current(value)) return;
        const artifact = result.body?.artifact;
        if ([200,201].includes(result.status) && idPattern.test(artifact?.id || '') && artifact.workspace_id === value.workspace) {
          row.done = true;
          const link = document.createElement('a');
          link.href = '/space?' + new URLSearchParams({workspace:value.workspace, artifact:artifact.id});
          link.textContent = '打开文件';
          row.feedback.replaceChildren('已上传 · ', link);
          saved++;
        } else if ([400,403,404,409,413].includes(result.status)) {
          row.attempt = null;
          row.title.readOnly = false;
          row.feedback.textContent = result.status === 409 ? '作品标题已存在，请换一个标题。'
            : result.status === 413 ? '文件大于 2 MB。' : '上传失败，请检查文件后重试。';
        } else {
          row.feedback.textContent = '上传结果待确认，可以重试原请求。';
        }
      }
    } finally {
      if (current(value)) {
        value.saving = false;
        const done = value.rows.filter(row => row.done).length;
        ui.status.textContent = '已上传 ' + done + ' / ' + value.rows.length + ' 个文件。';
        sync(value);
        if (saved) refresh();
      }
    }
  });

  function close() {
    batch?.controller.abort();
    batch = null;
    ui.files.value = '';
    ui.rows.replaceChildren();
    ui.status.textContent = '';
    if (ui.dialog.open) ui.dialog.close();
  }

  ui.dialog.addEventListener('cancel', event => {
    if (batch?.saving) event.preventDefault();
  });
  ui.dialog.addEventListener('close', () => { if (!ui.dialog.open) close(); });
  ui.close.addEventListener('click', close);
  return {
    close,
    open() {
      const live = scope();
      if (!live || ui.dialog.open) return;
      batch = {...live, rows:[], saving:false, controller:new AbortController()};
      sync(batch);
      ui.dialog.showModal();
      ui.files.focus();
    },
  };
}

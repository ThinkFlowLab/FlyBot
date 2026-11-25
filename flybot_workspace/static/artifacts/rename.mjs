export function mountArtifactRename(document, {scope, request, updated}) {
  const ui = Object.fromEntries(['dialog','form','name','status','cancel','submit']
    .map(name => [name, document.getElementById('rename-artifact-' + name)]));
  let state;

  function current(value) {
    const live = scope();
    return state === value && live?.owner === value.owner && live.workspace === value.workspace;
  }

  function busy(value, pending) {
    value.pending = pending;
    ui.name.disabled = ui.cancel.disabled = ui.submit.disabled = pending;
    ui.submit.textContent = pending ? '正在保存…' : '保存名称';
  }

  function close(restoreFocus = false) {
    const value = state;
    state = null;
    value?.controller.abort();
    if (ui.dialog.open) ui.dialog.close();
    if (restoreFocus && value) {
      (document.getElementById(value.triggerId) || document.getElementById('search'))?.focus({preventScroll:true});
    }
  }

  function sameArtifact(item, value) {
    return item?.id === value.id && item.workspace_id === value.workspace &&
      Number.isSafeInteger(item.revision) && item.revision >= value.revision && typeof item.title === 'string';
  }

  ui.form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = state;
    if (!value || value.pending || !current(value)) return;
    const title = ui.name.value.trim();
    if (!title || title.length > 80) {
      ui.status.textContent = '请输入 1 至 80 字的作品名称。';
      ui.name.focus();
      return;
    }
    if (title === value.title) { close(true); return; }
    busy(value, true);
    ui.status.textContent = '';
    const path = `/v1/workspaces/${value.workspace}/artifacts/${value.id}`;
    const read = (method, body, duration) => request(method,path,body,
      AbortSignal.any([value.controller.signal, AbortSignal.timeout(duration)])).catch(() => ({status:0,body:{}}));
    const accepted = item => sameArtifact(item,value) && item.revision > value.revision && item.title === title;
    try {
      const response = await read('POST',{revision:value.revision,changes:{title}},12000);
      if (!current(value)) return;
      let saved = response.status === 200 ? response.body?.artifact : response.body?.error?.current;
      const titleConflict = response.status === 409 && response.body?.error?.code === 'title_conflict';
      if (titleConflict) {
        ui.status.textContent = '已有同名作品，请换一个名称。';
        return;
      }
      if (!accepted(saved) && (response.status === 0 || response.status >= 500 ||
          (response.status === 409 && !sameArtifact(saved,value)) || response.status === 200)) {
        const checked = await read('GET',undefined,5000);
        if (!current(value)) return;
        saved = checked.status === 200 ? checked.body?.artifact : null;
      }
      if (accepted(saved)) {
        updated(saved);
        close(true);
      } else if (sameArtifact(saved,value) && saved.revision > value.revision) {
        value.revision = saved.revision;
        value.title = saved.title;
        ui.status.textContent = `此作品已更新，当前名称为「${saved.title}」。核对后可再次保存。`;
      } else if ([400,403,404,429].includes(response.status)) {
        ui.status.textContent = {
          400:'无法使用此名称，请检查后重试。',
          403:'你没有权限重命名这件作品。',
          404:'找不到这件作品。',
          429:'这件作品的版本已达上限。',
        }[response.status];
      } else {
        ui.status.textContent = '暂时无法确认是否已保存，可以重试。';
      }
    } finally {
      if (current(value)) {
        busy(value, false);
        ui.name.focus();
      }
    }
  });

  ui.cancel.addEventListener('click', () => close(true));
  ui.dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!state?.pending) close(true);
  });

  return {
    close,
    open(item, triggerId) {
      const live = scope();
      if (!live || ui.dialog.open || item.workspace_id !== live.workspace) return;
      state = {...live,id:item.id,revision:item.revision,title:item.title,triggerId,controller:new AbortController()};
      busy(state, false);
      ui.name.value = item.title;
      ui.status.textContent = '';
      ui.dialog.showModal();
      ui.name.focus();
      ui.name.select();
    },
  };
}

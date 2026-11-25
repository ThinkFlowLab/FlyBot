import { studioDocumentHref } from '../shell/studio-link.mjs';

import { studioCopyCandidate } from './entry.mjs';

export function mountStudioCopy(document, {source, ready, request, show}) {
  const byId = id => document.getElementById('studio-copy-' + id);
  const dialog = byId('dialog');
  if (!dialog) return null;
  const title = byId('title');
  const body = byId('body');
  const target = byId('target');
  const workspaceSelect = byId('target-workspace');
  const workspaceField = byId('target-field');
  const revision = byId('revision');
  const confirm = byId('confirm');
  const dismiss = byId('dismiss');
  const link = byId('result');
  const status = byId('status');
  let review = null;
  let pending = false;

  const candidate = () => studioCopyCandidate(source());

  function close() {
    review = null;
    pending = false;
    if (dialog.open) dialog.close();
    title.textContent = '';
    body.textContent = '';
    target.textContent = '';
    workspaceSelect.replaceChildren();
    revision.textContent = '';
    status.textContent = '';
    link.removeAttribute('href');
  }

  function open() {
    const copy = candidate();
    if (!copy || dialog.open) return;
    const error = ready(copy.selection);
    if (error) {
      show('error', error);
      return;
    }
    review = copy;
    workspaceSelect.replaceChildren();
    for (const team of [{id:'', name:'请选择团队工作区'},...copy.teams]) {
      const option = document.createElement('option');
      option.value = team.id;
      option.textContent = team.name;
      workspaceSelect.append(option);
    }
    workspaceSelect.value = copy.teams.some(team => team.id === copy.selection.workspace) ? copy.selection.workspace : '';
    workspaceSelect.disabled = false;
    workspaceField.hidden = false;
    target.hidden = true;
    target.textContent = copy.teams.find(team => team.id === workspaceSelect.value)?.name || '';
    revision.textContent = '版本 ' + copy.draft.revision;
    title.textContent = copy.draft.title;
    body.textContent = copy.draft.body;
    body.hidden = !copy.draft.body;
    byId('empty').hidden = Boolean(copy.draft.body);
    status.textContent = '';
    confirm.textContent = '确认复制';
    confirm.disabled = !workspaceSelect.value;
    confirm.hidden = false;
    dismiss.textContent = '取消';
    dismiss.disabled = false;
    link.hidden = true;
    dialog.showModal();
  }

  workspaceSelect.addEventListener('change', () => {
    if (!review || pending || workspaceSelect.disabled) return;
    const team = review.teams.find(item => item.id === workspaceSelect.value);
    target.textContent = team?.name || '';
    confirm.disabled = !team;
    status.textContent = '';
  });
  dismiss.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!pending) close();
  });
  confirm.addEventListener('click', async () => {
    const copy = review;
    const current = candidate();
    if (!copy || pending) return;
    const team = copy.teams.find(item => item.id === workspaceSelect.value);
    if (!team) return;
    if (copy.selection !== current?.selection || copy.item !== current.item ||
        !current.teams.some(item => item.id === team.id && item.name === team.name)) {
      status.textContent = '作品或工作区已变更。请关闭此窗口并重新预览。';
      confirm.disabled = true;
      return;
    }
    const error = ready(copy.selection);
    if (error) {
      status.textContent = error;
      confirm.disabled = true;
      return;
    }
    pending = confirm.disabled = dismiss.disabled = workspaceSelect.disabled = true;
    status.textContent = '正在复制到团队协作…';
    let result;
    try {
      result = await request(copy.selection, copy.item.id, {...copy.draft,target_workspace_id:team.id});
    } catch {
      result = {status: 0, body: {}};
    }
    if (review !== copy) return;
    pending = dismiss.disabled = false;
    const href = result.status === 200 && result.body?.workspace_id === team.id && studioDocumentHref(team.id, result.body.id);
    if (href) {
      status.textContent = '已复制。团队成员可以编辑这份副本。';
      target.hidden = false;
      workspaceField.hidden = true;
      confirm.hidden = true;
      dismiss.textContent = '关闭';
      link.href = href;
      link.hidden = false;
      link.focus();
      return;
    }
    const code = result.body.error?.code;
    if (code === 'source_changed' || code === 'not_found') {
      status.textContent = '原文档已更新或移除。请关闭此窗口，打开最新保存版本后重新预览。';
    } else if (code === 'team_not_found' || result.status === 401 || result.status === 403) {
      status.textContent = '当前账号无法访问这个团队工作区。请刷新工作区后再试。';
    } else if (code === 'document_deleted') {
      status.textContent = '这个版本的团队副本已删除。';
    } else if (code === 'document_limit') {
      status.textContent = '这个团队工作区的协作文档数量已达到上限。';
    } else if (result.status >= 400 && result.status < 500) {
      status.textContent = '这份文档无法复制。请检查标题和正文后再试。';
    } else {
      status.textContent = '暂时没能确认复制结果。可以重试，同一版本只会生成一份团队副本。';
      confirm.textContent = '重试复制';
      confirm.disabled = false;
    }
  });

  return {close, open};
}

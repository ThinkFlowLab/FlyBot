import {groupInviteUrl} from '../shell/group-invite-link.mjs';

export function mountGroupInviteLink(document, request, isCurrent) {
  const panel = document.getElementById('group-invite-link-panel');
  const state = document.getElementById('group-invite-link-status');
  const create = document.getElementById('group-invite-link-create');
  const revoke = document.getElementById('group-invite-link-revoke');
  const copy = document.getElementById('group-invite-link-copy');
  const link = document.getElementById('group-invite-link');
  const view = document.defaultView;
  let target = null;
  let mode = 'read';

  async function run(method) {
    const opened = target;
    if (!opened || !isCurrent(opened) || create.disabled) return;
    create.disabled = revoke.disabled = true;
    create.textContent = method === 'GET' ? '正在检查…' : method === 'POST' ? '正在生成…' : '正在停用…';
    const path = '/v1/workspaces/' + opened.workspace + '/social/conversations/' + opened.conversation + '/group-invite';
    const result = await request(method, path, method === 'GET' ? undefined : {}).catch(() => null);
    if (opened !== target || !isCurrent(opened)) return;
    create.disabled = revoke.disabled = false;
    if (![200, 201].includes(result?.status)) {
      if ([403, 404].includes(result?.status)) {
        panel.hidden = true;
        return;
      }
      mode = method === 'GET' ? 'read' : 'create';
      create.textContent = method === 'GET' ? '重试' : revoke.hidden ? '生成群邀请链接' : '更新群邀请链接';
      state.textContent = '暂时无法更新邀请链接，请重试。';
      return;
    }

    mode = 'create';
    const active = Boolean(result.body?.expires_at);
    create.textContent = active ? '更新群邀请链接' : '生成群邀请链接';
    revoke.hidden = !active;
    link.value = method === 'POST' ? groupInviteUrl(result.body?.code, view.location.origin) : '';
    link.hidden = copy.hidden = !link.value;
    state.textContent = method === 'POST' ? '邀请链接已生成，有效期 7 天。'
      : method === 'DELETE' ? '邀请链接已停用。'
        : active ? '邀请链接有效。更新会停用旧链接。' : '链接有效期为 7 天。';
  }

  create.addEventListener('click', () => void run(mode === 'read' ? 'GET' : 'POST'));
  revoke.addEventListener('click', () => void run('DELETE'));
  copy.addEventListener('click', async () => {
    const opened = target, value = link.value;
    if (!opened || !value) return;
    try {
      await view.navigator.clipboard.writeText(value);
      if (target === opened && isCurrent(opened)) state.textContent = '已复制邀请链接。';
    } catch {
      if (target !== opened || !isCurrent(opened)) return;
      link.select();
      state.textContent = '已选中链接，请复制。';
    }
  });

  return (next, conversation) => {
    target = next;
    panel.hidden = !next || !conversation?.group_management?.can_rename;
    state.textContent = '';
    link.value = '';
    link.hidden = copy.hidden = revoke.hidden = true;
    create.disabled = false;
    mode = 'read';
    if (!panel.hidden) void run('GET');
  };
}

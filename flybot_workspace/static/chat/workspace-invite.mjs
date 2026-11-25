import {teamInviteUrl} from '../shell/team-invite-link.mjs';

export function mountWorkspaceInvite(document, {request, context, view = document.defaultView}) {
  const trigger = document.getElementById('chat-invite');
  const panel = document.getElementById('chat-invite-panel');
  const form = document.getElementById('chat-invite-form');
  const closeButton = document.getElementById('chat-invite-close');
  const send = document.getElementById('chat-invite-create');
  const approval = document.getElementById('chat-invite-approval');
  const output = document.getElementById('chat-invite-result');
  const receipt = document.getElementById('chat-invite-link-row');
  const link = document.getElementById('chat-invite-link');
  const copy = document.getElementById('chat-invite-copy');
  const label = (zh, en) => document.documentElement?.lang === 'en' ? en : zh;
  let opened = null;

  function close() {
    opened = null;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    send.disabled = false;
    receipt.hidden = true;
    link.value = '';
    output.textContent = '';
  }

  function sync() {
    const active = context();
    trigger.hidden = !active;
    if (opened && opened.scope !== active?.scope) close();
  }

  function current(entry) {
    return opened === entry && context()?.scope === entry.scope;
  }

  trigger.addEventListener('click', () => {
    if (opened) { close(); return; }
    opened = context();
    if (!opened) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    approval.focus();
  });
  closeButton.addEventListener('click', () => { close(); trigger.focus(); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const entry = opened;
    if (!entry || !current(entry) || send.disabled) return;
    send.disabled = true;
    receipt.hidden = true;
    link.value = '';
    output.textContent = label('正在生成邀请链接…', 'Creating invite link…');
    try {
      const result = await request('POST', `/v1/workspaces/${entry.workspace}/invites`, {
        role:'member', expires_in:7 * 86400, max_uses:1, requires_approval:approval.checked,
      }, undefined, AbortSignal.timeout(15000));
      if (!current(entry)) return;
      const invite = result.body?.invite;
      const url = result.status === 201 && invite?.workspace_id === entry.workspace && invite.id
        && teamInviteUrl(result.body.token, view?.location?.origin);
      if (!url) {
        output.textContent = [403,404].includes(result.status)
          ? label('只有工作区所有者或管理员可以生成邀请链接。', 'Only workspace owners and admins can create invite links.')
          : label('无法确认邀请是否已生成，请在「成员」页检查。', 'Could not confirm the invite. Check the Members page.');
        return;
      }
      link.value = url;
      receipt.hidden = false;
      output.textContent = label('邀请链接已生成，7 天内可使用一次。', 'Invite link created. It can be used once within 7 days.');
      link.focus();
      link.select();
    } catch {
      if (current(entry)) output.textContent = label('无法确认邀请是否已生成，请在「成员」页检查。', 'Could not confirm the invite. Check the Members page.');
    } finally {
      if (current(entry)) send.disabled = false;
    }
  });

  copy.addEventListener('click', async () => {
    const entry = opened, value = link.value;
    if (!entry || !value || !current(entry)) return;
    try {
      await view.navigator.clipboard.writeText(value);
      if (current(entry) && link.value === value) output.textContent = label('已复制邀请链接。', 'Invite link copied.');
    } catch {
      if (!current(entry) || link.value !== value) return;
      link.focus();
      link.select();
      output.textContent = label('请复制选中的链接。', 'Copy the selected invite link.');
    }
  });
  return {sync};
}

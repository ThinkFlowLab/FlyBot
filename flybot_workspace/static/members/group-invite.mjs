import {conversationChatHref} from '../shell/thumb.mjs';

export function showGroupInvitation(document, {request, token, goTo, isCurrent}) {
  const panel = document.getElementById('group-invite-panel');
  const title = document.getElementById('group-invite-title');
  const status = document.getElementById('group-invite-message');
  const action = document.getElementById('group-invite-action');
  let member = false;
  let confirmed = false;
  panel.hidden = false;

  function unavailable(result) {
    if ([400, 403, 404, 410].includes(result?.status)) {
      title.textContent = '';
      status.textContent = result.status === 403 ? '请先加入此群所在的工作区。' : '此群邀请已失效，无法加入群聊。';
      action.hidden = true;
    } else {
      status.textContent = '暂时无法打开邀请，请重试。';
      action.hidden = action.disabled = false;
      action.textContent = '重试';
    }
  }

  async function preview() {
    action.disabled = true;
    status.textContent = '正在查看邀请…';
    const result = await request('POST', '/v1/invites/group/preview', {token});
    if (!isCurrent()) return;
    if (result.status !== 200 || typeof result.body.title !== 'string') return unavailable(result);
    title.textContent = result.body.title;
    member = result.body.member === true;
    confirmed = true;
    status.textContent = member ? '你已是群成员。' : '加入后即可查看群聊并发消息。';
    action.textContent = member ? '打开群聊' : '加入群聊';
    action.hidden = action.disabled = false;
  }

  action.onclick = async () => {
    if (action.disabled || !isCurrent()) return;
    if (!confirmed) return preview();
    action.disabled = true;
    action.textContent = member ? '正在打开…' : '正在加入…';
    const result = await request('POST', '/v1/invites/group/accept', {token});
    if (!isCurrent()) return;
    if (result.status !== 200 || !/^[a-f0-9]{32}$/.test(result.body.workspace_id || '')
      || !/^[A-Za-z0-9._-]{1,80}$/.test(result.body.conversation_id || '')) return unavailable(result);
    goTo(conversationChatHref(result.body.workspace_id, {id: result.body.conversation_id}));
  };
  title.textContent = '';
  action.hidden = true;
  return preview();
}

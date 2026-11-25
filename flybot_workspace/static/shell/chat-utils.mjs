export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const chatPathId = value => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(value || '');

export function socialMessageHref({workspace = '', conversation, message}) {
  if ((workspace && !/^[0-9a-f]{32}$/.test(workspace)) || !chatPathId(conversation) || !chatPathId(message)) return '';
  const params = new URLSearchParams();
  if (workspace) params.set('workspace', workspace);
  params.set('social', conversation);
  params.set('message', message);
  return '/chat#' + params;
}

export function socialMessageFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  const workspace = params.get('workspace');
  if ((params.has('workspace') && !workspace) || params.size !== (workspace ? 3 : 2)) return '';
  return socialMessageHref({workspace: workspace || '', conversation: params.get('social'), message: params.get('message')});
}

const directId = /^otc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const nativeId = /^[0-9a-f]{32}$/;
const socialOwnerId = /^[A-Za-z0-9._-]{1,80}$/;

export function agentDirectoryHref(workspace, agent) {
  if (!nativeId.test(workspace || '')) return '/agents';
  const target = new URLSearchParams({workspace});
  if (nativeId.test(agent || '')) target.set('agent', agent);
  return '/agents#' + target;
}

export function directAgentAccessHref({conversation, ownerId, agentId: id}) {
  if (!directId.test(conversation || '') || !socialOwnerId.test(ownerId || '') || !nativeId.test(id || '')) return '';
  return '/chat#' + new URLSearchParams({social:conversation, access_owner:ownerId, access_agent:id});
}

export function directAgentAccessFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  if (params.size !== 3) return null;
  const target = {conversation:params.get('social'), ownerId:params.get('access_owner'), agentId:params.get('access_agent')};
  return directAgentAccessHref(target) ? target : null;
}

export function canManage(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function idempotencyKey(prefix) {
  const raw = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  return ((prefix || 'agent-') + raw.replace(/-/g, '')).slice(0, 64);
}

export function statusLabel(message) {
  if (!message) return '';
  if (message.status === 'queued' && message.error_code === 'no_agent') return '等待已连接的运行时。';
  if (message.status === 'queued') return '排队中。';
  if (message.status === 'running') return '生成中。';
  if (message.status === 'failed' && message.error_code === 'session/attachment-invalid') return '当前模型无法处理这个附件。';
  if (message.status === 'failed') return '回复失败' + (message.error_code ? '（' + message.error_code + '）' : '') + '。';
  if (message.status === 'cancelled') return '已取消。';
  return message.body || '';
}

function samePerson(item, self) {
  if (!item || self == null || self === '') return false;
  const user = typeof self === 'object' ? self : {id: self};
  if (item.user_id && user.id && item.user_id === user.id) return true;
  const strip = (value) => String(value || '').toLowerCase().replace(/^@/, '').replace(/\.home$/, '');
  const mine = new Set([user.id, user.username, user.handle].filter(Boolean).map(strip).filter(Boolean));
  if (!mine.size) return false;
  return [item.user_id, item.username, item.handle].some((value) => value && mine.has(strip(value)));
}

export function conversationLabel(row, currentUserId) {
  if (!row) return '';
  if (row.kind === 'group') return row.title || '群聊';
  if (row.direct && row.title) return row.title;
  const others = (row.members || []).filter(member => !samePerson(member, currentUserId));
  if (others.length) return others.map(member => member.username).join('、');
  return row.title || '单聊';
}

export function validMessage(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > 0 && value.length <= 4000;
}

export function memberChoices(members, currentUserId) {
  return (members || []).filter(member => !samePerson(member, currentUserId));
}

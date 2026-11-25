const WORKSPACE = /^[0-9a-f]{32}$/;
const CONVERSATION = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE = /^otm_[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

function isPublishedWork(item) {
  return item?.kind === 'follow_work' || (item?.kind === 'discover.published' && item.listing_kind === 'work');
}

export function workNotificationSummary(item) {
  if (item?.kind === 'artifact.shared') {
    const author = item.actor_username || '会话成员';
    return author + (item.title ? ' 分享了作品「' + item.title + '」' : ' 分享了作品');
  }
  if (!isPublishedWork(item)) return '';
  const author = item.actor_username || '你关注的作者';
  return author + (item.title ? ' 发布了新作品「' + item.title + '」' : ' 发布了新作品');
}

export function workNotificationTarget(item, workspace) {
  if (item?.kind === 'artifact.shared') {
    if (!WORKSPACE.test(workspace || '') || item.workspace_id !== workspace
      || !CONVERSATION.test(item.conversation_id || '') || !MESSAGE.test(item.message_id || '')) return null;
    const target = '/chat#' + new URLSearchParams({
      workspace, social: item.conversation_id, message: item.message_id,
    });
    return item.path == null || item.path === target ? target : null;
  }
  if (!isPublishedWork(item)) return null;
  const slug = item.slug ?? (typeof item.path === 'string' && item.path.startsWith('/w/') ? item.path.slice(3) : '');
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
  const target = '/w/' + slug;
  return item.path == null || item.path === target ? target : null;
}

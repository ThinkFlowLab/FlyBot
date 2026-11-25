// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { bodyOf, Fault } from '../../lib/b4/http.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'
import { HEX32 } from '../../featurekit/http.js'
import { automationNoticeKind, automationNoticePrefix, isAutomationNoticeId,
  listAutomationNotifications, readAutomationNotifications } from './automation-notifications.js'

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/
const CONVERSATION = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/
const MESSAGE = /^otm_[0-9A-HJKMNP-TV-Z]{26}$/
const TEAM_RUN_SHARE = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

function notificationKind(kind) {
  if (kind === undefined || kind === 'work' || kind === 'automation') return kind
  throw new Fault(400, 'invalid', '无效的通知类型。')
}

function notificationItem(notification, workspace) {
  const {id, seq, kind, data, created_at, read} = notification
  if (kind === automationNoticeKind || (typeof id === 'string' && id.startsWith(automationNoticePrefix))) return null
  const header = {id,seq,kind,created:Math.floor(created_at / 1000),read}
  if (kind === 'artifact.shared') {
    const {conversation_id,message_id,title,actor_username} = data ?? {}
    if (!CONVERSATION.test(conversation_id || '') || !MESSAGE.test(message_id || '')) return null
    const path = '/chat#' + new URLSearchParams({workspace, social: conversation_id, message: message_id})
    return {...header,conversation_id,message_id,title,actor_username,workspace_id:workspace,path}
  }
  if (kind === 'meeting.shared') {
    const {share_id,title,organizer,workspace_id} = data ?? {}
    if (typeof share_id !== 'string' || !HEX32.test(share_id) || (workspace_id && workspace_id !== workspace)) return null
    const hash = new URLSearchParams({workspace,shared:share_id})
    return {...header,share_id,title,organizer,workspace_id:workspace,path:'/meetings#' + hash}
  }
  if (kind === 'team.run_shared') {
    const {share_id, title, owner, workspace_id} = data ?? {}
    if (!TEAM_RUN_SHARE.test(share_id || '') || (workspace_id && workspace_id !== workspace)) return null
    const hash = new URLSearchParams({workspace, shared: share_id})
    return {...header, share_id, title, actor_username: owner?.display_name || owner?.handle,
      workspace_id: workspace, path: '/team-runs#' + hash}
  }
  if (kind === 'discover.published') {
    const {slug,title,creator,listing_kind = data?.kind} = data ?? {}
    const prefix = listing_kind === 'work' ? '/w/' : listing_kind === 'agent' ? '/a/' : ''
    const path = prefix && typeof slug === 'string' && SLUG.test(slug) ? prefix + slug : undefined
    return {...header,listing_kind,slug,title,actor_username:creator?.display_name || creator?.handle,path}
  }
  return {...data,...header}
}

function recentNotifications(shared, local, workspace, limit) {
  const rows = local.map(item => ({item, time:item.created * 1000}))
  for (const notice of shared) {
    const item = notificationItem(notice, workspace)
    if (item) rows.push({item, time:notice.created_at})
  }
  return rows.sort((a, b) => b.time - a.time || (b.item.seq ?? 0) - (a.item.seq ?? 0) ||
    (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0)).slice(0, limit).map(row => row.item)
}

function notificationRead(body) {
  const input = bodyOf(body, ['notification_id', 'all', 'kind'])
  const {notification_id:id, all} = input
  const one = typeof id === 'string' && id.length > 0 && id.length <= 128 && !Object.hasOwn(input, 'all')
  if (!one && !(all === true && !Object.hasOwn(input, 'notification_id'))) {
    throw new Fault(400, 'invalid', '请选择一条通知或标记全部为已读。')
  }
  const kind = notificationKind(input.kind)
  const local = one && id.startsWith(automationNoticePrefix)
  if (local && !isAutomationNoticeId(id)) throw new Fault(400, 'invalid', '无效的通知编号。')
  if (one && ((kind === 'work' && local) || (kind === 'automation' && !local))) {
    throw new Fault(404, 'not_found', '找不到这条通知。')
  }
  return {kind, local, selection:one ? {notification_id:id} : {all:true}}
}

function sharedUnread(result) {
  if (!Number.isSafeInteger(result?.unread) || result.unread < 0) {
    throw new Fault(503, 'notifications_unavailable', '暂时无法确认共享通知的未读数量。')
  }
  return result.unread
}

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  const personalScope = async workspace => (await host.call?.('agents/personal-binding', {}))?.workspace_id === workspace
  async function notificationPrefs() {
    try {
      return (await host.call?.('settings/notificationPrefs', {}))?.prefs ?? {}
    } catch (error) {
      if (error?.code === 'flybot-workspace/not-found') return {}
      throw new Fault(503, 'notifications_unavailable', '暂时无法读取通知偏好。')
    }
  }
  const excludedKinds = prefs => [
    ...(prefs.mentions === false ? ['messenger.mention'] : []),
    ...(prefs.artifacts === false ? ['artifact.shared', 'artifact'] : []),
  ].join(',') || undefined
  function checkExclusions(result, exclude) {
    if (exclude && result?.exclude !== exclude) {
      throw new Fault(503, 'notifications_unavailable', '暂时无法按通知偏好读取通知。')
    }
    return result
  }
  const listShared = async (workspace, personal, limit, unread, kind, exclude) => checkExclusions(
    await bs().get('/v1/ot/notifications' + qs({
      limit, latest:'1', ...(personal ? {personal:'1'} : {workspace_id:workspace}),
      unread:unread ? '1' : undefined, kind, exclude,
    })), exclude)
  async function readShared(workspace, personal, selection, kind, exclude) {
    // Older Bot Social versions ignore an unknown exclusion on a write.
    if (exclude) await listShared(workspace, personal, 1, true, kind, exclude)
    return checkExclusions(await bs().post('/v1/ot/notifications/read', {
      ...selection, ...(personal ? {personal:true} : {workspace_id:workspace}), kind, ...(exclude && {exclude}),
    }), exclude)
  }
  return {
    pages: ['contacts'],
    endpoints: {
      v1: compatHandler([
        { method: 'GET', path: /^\/v1\/contacts$/,
          handle: (_request, call) => wrap(async () => {
            const [data, binding] = await Promise.all([bs().get('/v1/ot/contacts'), host.call('agents/personal-binding', {})])
            const viewer = call?.request?.headers?.get('x-ot-owner-username') ?? process.env.FLYBOT_WORKSPACE_OWNER_USERNAME ?? ''
            return [200, {...data, workspace_id: binding?.workspace_id ?? null,
              ...(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(viewer) ? {viewer_username:viewer} : {})}]
          }) },
        { method: 'GET', path: /^\/v1\/contacts\/lookup$/,
          handle: ({query}) => wrap(async () => {
            const values = new URLSearchParams(query).getAll('handle')
            return [200, await bs().get('/v1/ot/contacts/lookup' + qs({handle: values.length === 1 ? values[0] : ''}))]
          }) },
        { method: 'POST', path: /^\/v1\/contacts$/,
          handle: ({body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts', {handle: body?.handle})]) },
        { method: 'POST', path: /^\/v1\/contacts\/(otcpt_[a-zA-Z0-9_-]{1,80})$/,
          handle: ({match, body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts/' + match[1], {action: body?.action})]) },
        { method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications$/,
          handle: ({ match, query }) => wrap(async () => {
            const params = new URLSearchParams(query)
            const filter = params.get('filter')
            if ([...params.keys()].some(key => !['kind', 'limit', 'filter'].includes(key) || params.getAll(key).length > 1) ||
                (filter !== null && filter !== 'all' && filter !== 'unread')) {
              throw new Fault(400, 'invalid', '无效的通知列表请求。')
            }
            const kind = notificationKind(params.get('kind') ?? undefined)
            const rawLimit = params.get('limit') ?? (kind === 'work' ? '60' : '200')
            const limit = Number(rawLimit)
            if (!/^[0-9]{1,3}$/.test(rawLimit) || limit < 1 || limit > 200) {
              throw new Fault(400, 'invalid', '无效的通知列表长度。')
            }
            const workspace = match[1], unread = filter === 'unread'
            const prefs = await notificationPrefs()
            const includeAutomation = prefs.task_completion !== false
            const [shared, local] = await Promise.all([
              kind === 'automation' ? null
                : personalScope(workspace).then(personal => listShared(workspace, personal, limit, unread, kind, excludedKinds(prefs))),
              kind === 'automation' || (kind !== 'work' && includeAutomation)
                ? listAutomationNotifications(host, workspace, {limit, unread}, kind !== 'automation') : null,
            ])
            if (shared !== null && !Array.isArray(shared?.notifications)) {
              throw new Fault(503, 'notifications_unavailable', '暂时无法读取共享通知。')
            }
            const automation = includeAutomation ? local : null
            return [200, {items:recentNotifications(shared?.notifications ?? [], automation?.items ?? [], workspace, limit),
              unread_count:(shared === null ? 0 : sharedUnread(shared)) + (automation?.unread_count ?? 0), limit}]
          }) },
        { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications\/read$/,
          handle: ({ match, body }) => wrap(async () => {
            const workspace = match[1], {kind, local, selection} = notificationRead(body)
            const prefs = await notificationPrefs()
            const includeAutomation = prefs.task_completion !== false
            if (!includeAutomation && local) throw new Fault(404, 'not_found', '找不到这条通知。')
            if (kind === 'automation') {
              if (!includeAutomation) {
                await listAutomationNotifications(host, workspace, {limit:1, unread:true}, false)
                return [200, {unread_count:0}]
              }
              const result = await readAutomationNotifications(host, workspace, selection)
              return [200, {unread_count:result.unread_count}]
            }
            const personal = await personalScope(workspace)
            const exclude = excludedKinds(prefs)
            if (kind === 'work') {
              const result = await readShared(workspace, personal, selection, kind, exclude)
              return [200, {unread_count:sharedUnread(result)}]
            }
            if (local) {
              const shared = sharedUnread(await listShared(workspace, personal, 1, true, undefined, exclude))
              const result = await readAutomationNotifications(host, workspace, selection)
              return [200, {unread_count:shared + result.unread_count}]
            }
            const before = includeAutomation ? await listAutomationNotifications(host, workspace, {limit:1, unread:true}) : null
            const shared = sharedUnread(await readShared(workspace, personal, selection, undefined, exclude))
            if (!selection.all || before === null) return [200, {unread_count:shared + (before?.unread_count ?? 0)}]
            try {
              const result = await readAutomationNotifications(host, workspace, selection)
              return [200, {unread_count:shared + result.unread_count}]
            } catch {
              throw new Fault(503, 'notifications_partial_read', '未能确认所有通知均已标记，请刷新后重试。')
            }
          }) },
      ]),
      status: async () => bs().status(),
      identity: async () => bs().identity(),
      profile: async () => bs().get('/v1/ot/me'),
      updateProfile: async (p) => bs().put('/v1/ot/profile', { display_name: p?.display_name, bio: p?.bio }),
      async notifications(p) {
        const exclude = excludedKinds(await notificationPrefs())
        return checkExclusions(await bs().get('/v1/ot/notifications' + qs({after:p?.after, limit:p?.limit, exclude})), exclude)
      },
      async readNotifications(p) {
        const exclude = excludedKinds(await notificationPrefs())
        if (exclude) checkExclusions(await bs().get('/v1/ot/notifications' + qs({limit:1, unread:'1', exclude})), exclude)
        return checkExclusions(await bs().post('/v1/ot/notifications/read', {up_to:p?.up_to, ...(exclude && {exclude})}), exclude)
      },
    },
  }
}

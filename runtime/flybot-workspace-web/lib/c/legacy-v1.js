// Legacy /v1 compatibility for Stream C pages (members, team, messenger, discover).
// When the core stream flips those pages onto the user's own DS-Bot, dsbot-api.mjs
// posts {endpoint:'<feature>/v1', payload:{method,path,body}} here. The handlers
// talk to Bot Social and return the Flask JSON shapes those pages already expect.
// Shared workspaces are Bot Social teams. The private workspace can also be
// listed from the personal-agent binding in this user's runtime.
import { createHash } from 'node:crypto'
import {structuredArtifactText} from '../../features/artifacts/catalog-search.js'
import {normalizeBoard,normalizeSlides} from '../../features/artifacts/structured.js'
import { CATEGORIES as agentCategories, LIMITS as agentLimits } from '../../features/agents/index.js'
import { compatHandler } from '../b4/compat.js'
import { Fault } from '../b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { sharedBotSocial, seg, qs } from './bot-social.js'
import { GLB_MIME } from '../glb.js'
import { studioReference } from './studio-reference.js'

const HEX = /^[0-9a-f]{32}$/
const GROUP_AGENT_ID = /^[A-Za-z0-9._:-]{1,80}$/
const PLATFORM_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/
const PUBLIC_LISTING_ID = /^otl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/
const LATEST_WORK_CURSOR = /^l\.(0|[1-9][0-9]{0,15})\.otl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}\.[a-f0-9]{24}$/
const DISCOVER_WORK_QUERY_LIMIT = 1024
const DISCOVER_WORK = '/v1/discover/works/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])'
const WORK_COMMENT = 'otwc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}'
const COMMENT_KEY = /^[A-Za-z0-9_-]{16,64}$/
const PROFILE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
const GROUP_MANAGEMENT_FIELDS = {rename:'title',remove:'member_id',transfer:'member_id',leave:'',reply_policy:'mode'}
const DISCOVER_MEDIA_KINDS = new Map([
  ['image/png', 'image'], ['image/jpeg', 'image'], ['image/gif', 'image'], ['image/webp', 'image'],
  ['audio/mpeg', 'audio'], ['audio/ogg', 'audio'], ['audio/wav', 'audio'],
  ['video/mp4', 'video'], ['video/webm', 'video'],
])
const WORK_LABELS = {
  document: '文档', spreadsheet:'电子表格', website: '网页', whiteboard: '白板', media: '媒体',
  image: '图片', audio: '音频', video: '视频', slides: '幻灯片', dashboard: '看板', model3d: '3D 作品',
}

const unix = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

const usernameOf = (profile) => {
  const handle = String(profile?.handle || '').replace(/^@/, '')
  if (!handle) return profile?.display_name || ''
  return handle.endsWith('.home') ? handle.slice(0, -5) : handle
}

function userIdOf(profile, me, env) {
  if (profile?.platform_user_id && HEX.test(String(profile.platform_user_id))) return profile.platform_user_id
  const mine = me && (profile?.handle === me.handle || profile?.owner_id === me.owner_id || profile?.owner_id === me.ownerId)
  if (mine) {
    const id = ownerId(env)
    if (HEX.test(id)) return id
  }
  return profile?.owner_id || profile?.handle || ''
}

function memberItem(row, me, env) {
  return {
    user_id: userIdOf(row, me, env),
    username: usernameOf(row) || row.display_name || '',
    handle: row.handle || null,
    role: row.role,
    created: unix(row.joined_at || row.created_at),
    suspended: !!row.suspended,
  }
}

function inviteItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    role: row.role,
    created: unix(row.created_at),
    expires: unix(row.expires_at),
    created_by: row.created_by || null,
    max_uses: row.max_uses,
    use_count: row.use_count,
    revoked: !!row.revoked,
    frozen: !!row.frozen,
    requires_approval: !!row.requires_approval,
  }
}

function requestItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    user_id: row.member?.owner_id || row.member?.platform_user_id || row.owner_id,
    username: usernameOf(row.member || row),
    role: row.role,
    status: row.status,
    created: unix(row.created_at),
    decided: unix(row.decided_at) || null,
    decided_by: row.decided_by || null,
  }
}

function conversationAgents(row) {
  return (row.agents || []).map(a => ({id:a.agent_ref, name:a.name, auto_reply:!!a.auto_reply,
    mine:a.mine === true, owner_id:a.owner?.owner_id || '', owner_name:a.owner?.display_name || a.owner?.handle || '',
    owner_handle:a.owner?.handle || ''}))
}

function agentRosterItem(row, workspaceId) {
  if (!row?.id || !Array.isArray(row.agents) || typeof row.activity_version !== 'string') return undefined
  return {id:row.id, workspace_id:workspaceId, activity_version:row.activity_version,
    agent_members:conversationAgents(row), group_agent_routing:row.group_agent_routing ?? null}
}

function conversationItem(row, me, env, workspaceId) {
  const management = row.kind === 'group' && !row.public_agent ? row.group_management : null
  const members = (row.members || []).map((m) => ({
    ...memberItem({ ...m, role: m.role || 'member' }, me, env),
    ...(management && m.owner_id ? {group_member_id: m.owner_id} : {}),
  }))
  return {
    id: row.id,
    workspace_id: workspaceId,
    kind: row.kind,
    ...(row.public_agent ? {public_agent: row.public_agent} : {}),
    ...(row.direct ? {direct: row.direct} : {}),
    ...(row.account_group ? {account_group: true} : {}),
    ...(management ? {group_management: management} : {}),
    native_room_id: row.native_room_id || null,
    native_session_id: row.native_session_id || null,
    title: row.title || '',
    created: unix(row.created_at),
    updated: unix(row.updated_at),
    activity_version: row.activity_version ?? null,
    last_seq: row.last_seq ?? 0,
    preview: row.last_message && !row.last_message.retracted ? (row.last_message.body || '') : '',
    unread_count: row.unread ?? 0,
    muted: !!row.muted,
    pinned: !!row.pinned,
    first_unread_seq: row.unread > 0 ? (row.read_seq || 0) + 1 : null,
    members,
    ...(row.group_agent_requests === true ? {group_agent_requests: true} : {}),
    ...(row.group_agent_routing ? {group_agent_routing: row.group_agent_routing} : {}),
    ...(row.kind === 'dm' && row.direct_agent_requests === true ? {direct_agent_requests:true} : {}),
    agent_members: conversationAgents(row),
  }
}

function attachmentItem({ title, mime, bytes, resource, sticker }, workspaceId, conversationId, messageId) {
  return { title, mime, bytes, id: messageId, ...(resource ? {resource} : {}),
    ...(sticker === true ? {sticker:true} : {}),
    path: `/v1/workspaces/${workspaceId}/social/conversations/${seg(conversationId)}/messages/${seg(messageId)}/file`,
  }
}

function messageItem(row, me, env, workspaceId) {
  const author = row.author || { handle: null, owner_id: row.author_id, display_name: row.agent_name }
  const agent = row.author_kind === 'agent' || author.kind === 'agent'
  const studio = !agent && !row.retracted && studioReference(row.studio_reference)
  return {
    id: row.id,
    seq: row.seq,
    ...(row.mine && row.client_key ? {client_key: row.client_key} : {}),
    conversation_id: row.conversation_id,
    workspace_id: workspaceId,
    user_id: agent ? null : userIdOf(author, me, env),
    body: row.retracted ? '' : (row.body || ''),
    created: unix(row.created_at),
    revision: row.revision || 1,
    edited: unix(row.edited_at) || null,
    retracted: !!row.retracted,
    ...(row.reactions?.length ? {reactions: row.reactions} : {}),
    ...(row.voice ? { voice: row.voice } : {}),
    ...(row.reply_preview ? {reply_preview: row.reply_preview} : {}),
    ...(row.forwarded_from ? {forwarded_from: row.forwarded_from} : {}),
    ...(studio ? {studio_reference: studio} : {}),
    ...(row.reply_jobs?.length ? {reply_jobs: row.reply_jobs} : {}),
    ...(agent && author.owner?.owner_id ? {agent_owner_id: author.owner.owner_id} : {}),
    ...(agent && row.reply_job_id ? {reply_job_id: row.reply_job_id,
      ...(author.owner?.owner_id ? {agent_owner_name: author.owner.display_name || author.owner.handle || '',
        agent_owner_handle: author.owner.handle || ''} : {})} : {}),
    ...(row.group_memory_refs?.length ? {group_memory_refs:row.group_memory_refs} : {}),
    ...(row.attachment ? { attachment: attachmentItem(row.attachment, workspaceId, row.conversation_id, row.id) } : {}),
    ...(agent ? { role: 'agent', agent_id: row.agent_ref || author.agent_ref, agent_name: row.agent_name || author.name, source: 'runtime_infer' } : {}),
  }
}

function workMatch(match) {
  if (!match || !['title', 'summary', 'body', 'creator'].includes(match.kind)
    || typeof match.text !== 'string' || match.text.length > 160
    || !Number.isInteger(match.start) || !Number.isInteger(match.end)
    || match.start < 0 || match.end <= match.start || match.end > match.text.length) return null
  return {kind: match.kind, text: match.text, start: match.start, end: match.end}
}

function workItem(row) {
  const kind = row.work_kind || (row.kind === 'work' ? 'document' : row.kind)
  const match = workMatch(row.match)
  const fileAvailable = row.file_available === true && DISCOVER_MEDIA_KINDS.get(row.file_mime) === kind
    && Number.isSafeInteger(row.file_bytes) && row.file_bytes > 0
  return {
    slug: row.slug,
    title: row.title,
    kind,
    kind_label: WORK_LABELS[kind] || kind,
    author: usernameOf(row.creator) || row.creator?.display_name || '',
    ...(row.creator?.handle ? {creator: {handle: row.creator.handle, name: row.creator.display_name || usernameOf(row.creator)}} : {}),
    updated: unix(row.updated_at),
    path: row.path || ('/w/' + row.slug),
    likes: row.likes ?? 0,
    collections: row.collections ?? 0,
    liked: !!row.liked,
    collected: !!row.collected,
    following: !!row.following,
    own_work: !!row.own,
    comment_count: row.comment_count ?? 0,
    ...(match ? {match} : {}),
    ...(kind === 'website' ? {site_available: row.site_available === true} : {}),
    ...(fileAvailable ? {file_available: true, file_mime: row.file_mime, file_bytes: row.file_bytes} : {}),
    ...(row.remix_available === true ? {remix_available: true} : {}),
  }
}

function agentItem(row) {
  return {
    slug: row.slug,
    name: row.title || row.name,
    summary: row.summary || '',
    category: row.category || '',
    creator: row.creator ? { handle: row.creator.handle, name: row.creator.display_name || usernameOf(row.creator) } : null,
    chat_enabled: row.chat_enabled === true,
    own_agent: row.own === true,
    updated: unix(row.updated_at),
    tags: [],
    members: [],
  }
}

function rethrow(error) {
  if (error instanceof Fault) throw error
  const raw = String(error?.code ?? '')
  const code = raw.replace(/^social\//, '')
  const status = Number(error?.status) || (
    code === 'not-configured' || code === 'not-connected' || raw === 'social/not-configured' || raw === 'social/not-connected' ? 503
      : code === 'unreachable' ? 503 : 500
  )
  const mapped = ({
    team_not_found: 'not_found',
    member_not_found: 'not_found',
    invite_not_found: 'not_found',
    invite_unusable: 'not_found',
    invalid_request: 'invalid',
    slug_taken: 'conflict',
    forbidden: 'forbidden',
    not_reachable: 'invalid',
    not_in_team: 'invalid',
    too_many_teams: 'quota',
    attachment_too_large: 'attachment_too_large',
    attachment_type_blocked: 'attachment_type_blocked',
    attachment_storage_full: 'attachment_storage_full',
    call_full: 'call_full',
    call_already_joined: 'call_already_joined',
    call_ended: 'call_ended',
    call_recording_busy: 'call_recording_busy',
    call_recording_changed: 'call_recording_changed',
    meeting_ended: 'meeting_ended',
    group_management_conflict: 'group_management_conflict',
    group_reply_lead_unavailable: 'group_reply_lead_unavailable',
    group_owner_transfer_required: 'group_owner_transfer_required',
    ownership_changed: 'ownership_changed',
    member_suspended: 'member_suspended',
    member_not_found: 'member_not_found',
    public_chat_closed: 'public_chat_closed',
    public_agent_changed: 'public_agent_changed',
    listing_changed: 'listing_changed',
    artifact_changed: 'artifact_changed',
    title_conflict: 'title_conflict',
    quick_start_changed: 'quick_start_changed',
    popularity_expired: 'popularity_expired',
    comment_not_found: 'not_found',
    comment_conflict: 'conflict',
    reply_unavailable: 'reply_unavailable',
    group_agent_unavailable: 'group_agent_unavailable',
    group_agent_request_conflict: 'group_agent_request_conflict',
    direct_agent_unavailable: 'direct_agent_unavailable',
    direct_agent_request_conflict: 'direct_agent_request_conflict',
    studio_reference_changed: 'studio_reference_changed',
    studio_reference_unavailable: 'studio_reference_unavailable',
  })[code] || (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 410 ? 'not_found' : status === 429 ? 'quota' : code || 'internal')
  throw new Fault(status === 410 ? 404 : status, mapped, error?.message || 'Bot Social request failed')
}

export async function wrap(fn) {
  try { return await fn() } catch (error) { rethrow(error) }
}

async function meOf(bs, env) {
  return bs.get('/v1/ot/me')
}

async function teamFor(bs, workspaceId, name, env) {
  if (!HEX.test(String(workspaceId || ''))) throw new Fault(400, 'invalid', 'Invalid workspace')
  // Workspace ownership is platform authority, never first-browser-call wins.
  // A verified migration must pre-link the team and preserve its full membership.
  try { return await bs.get(`/v1/ot/teams/by-workspace/${seg(workspaceId, 'workspace_id')}`) }
  catch (error) {
    if (error?.status === 404) throw new Fault(409, 'membership_migration_required', 'This workspace needs verified Bot Social membership migration; legacy data is unchanged')
    throw error
  }
}

function ttlDays(expiresIn) {
  const seconds = Number(expiresIn)
  if (!Number.isFinite(seconds) || seconds <= 0) return 7
  return Math.min(30, Math.max(1, Math.round(seconds / 86400) || 7))
}

function parseQuery(query) {
  return new URLSearchParams(String(query || '').replace(/^\?/, ''))
}

function client(host) {
  return sharedBotSocial(host)
}

function nativeWorkingBots(host, conversationId) {
  const rt = host.currentRuntime?.()?.rt
  if (typeof rt?.workingInRoom !== 'function') return []
  const room = Object.values(rt.state?.rooms || {}).find(room =>
    room.flybotWorkspace?.conversation_id === conversationId && room.flybotWorkspace.native_exchange)
  if (!room) return []
  return rt.workingInRoom(room).flatMap(({bot}) =>
    typeof bot?.id === 'string' && GROUP_AGENT_ID.test(bot.id) && typeof bot.name === 'string' && bot.name
      ? [{id:bot.id, name:bot.name}]
      : [])
}

function membersRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`)
          return [200, { items: (data.members || []).map((m) => memberItem(m, me, env)) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`, {
            handle: body?.username || body?.handle, role: body?.role,
          })
          // Bot Social returns the member; treat first-time add as 201 when we cannot tell.
          return [201, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`, { role: body?.role })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})\/(remove|suspend|unsuspend|transfer-ownership)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const action = match[3]
          const path = `/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`
          if (action === 'transfer-ownership') return [200, await bs.post(path + '/transfer-ownership', {})]
          const me = await meOf(bs, env)
          if (action === 'remove') {
            await bs.del(path)
            return [200, {}]
          }
          const data = await bs.patch(path, { suspended: action === 'suspend' })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
  ]
}

function invitesRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`)
          return [200, { items: (data.invites || []).map((row) => inviteItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`, {
            role: body?.role, ttl_days: ttlDays(body?.expires_in), max_uses: body?.max_uses,
            requires_approval: body?.requires_approval === true,
          })
          return [201, { invite: inviteItem(data.invite || data, match[1]), token: data.code }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites\/([A-Za-z0-9._-]{1,80})\/(revoke|freeze|unfreeze)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const action = match[3]
          const patch = action === 'revoke' ? { revoked: true } : { frozen: action === 'freeze' }
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites/${seg(match[2], 'invite_id')}`, patch)
          return [200, { invite: inviteItem(data.invite || data, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/invites\/group\/(preview|accept)$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const accepted = match[1] === 'accept'
          const binding = accepted ? await host.call('agents/personal-binding', {}) : null
          if (accepted && !HEX.test(binding?.workspace_id || '')) {
            throw new Fault(503, 'personal_binding_unavailable', '请等待个人工作区启动后重试。')
          }
          const result = await client(host).post('/v1/ot/group-invites/' + match[1], {code: body?.token})
          return [200, accepted ? {
            conversation_id: result.conversation_id,
            workspace_id: result.workspace_id || binding.workspace_id,
          } : result]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/invites\/preview$/,
      async handle({ body }) {
        return wrap(async () => {
          const token = body?.token
          if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
            throw new Fault(400, 'invalid_invite', '邀请链接格式不正确。')
          }
          const data = await client(host).post('/v1/ot/invites/preview', { code: token })
          if (data.membership === 'suspended') throw new Fault(403, 'forbidden', '此工作区已暂停你的访问。')
          const joined = data.membership === 'member' && HEX.test(data.workspace_id || '')
          const pending = data.membership === 'pending'
          if (!data.usable && !joined && !pending) throw new Fault(410, 'invite_unavailable', '这条邀请已失效。')
          return [200, { invitation: {
            team_name: String(data.team?.name || '').slice(0, 80),
            role: data.role === 'admin' ? 'admin' : 'member',
            requires_approval: data.requires_approval === true,
            ...(joined ? {membership: 'member', workspace_id: data.workspace_id}
              : pending ? {membership: 'pending'} : {}),
          } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/invites\/accept$/,
      async handle({ body }) {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.post('/v1/ot/invites/accept', { code: body?.token || body?.code })
          if (data.status === 'pending') {
            return [202, { join_request: { id: data.request_id, status: 'pending', team_id: data.team_id } }]
          }
          if (data.status === 'suspended') throw new Fault(403, 'forbidden', 'Your membership in this workspace is suspended')
          return [200, { workspace: { id: data.workspace_id || data.team_id }, member: {
            role: ['owner', 'admin'].includes(data.role) ? data.role : 'member',
          } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests` + qs({ status: 'pending' }))
          return [200, { items: (data.requests || []).map((row) => requestItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests\/([A-Za-z0-9._-]{1,80})\/(approve|reject)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests/${seg(match[2], 'request_id')}`, {
            decision: match[3],
          })
          return [200, { join_request: requestItem(data.request || data, match[1]) }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/join-requests$/,
      async handle() {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.get('/v1/ot/join-requests/mine')
          return [200, { items: (data.requests || []).map(row => ({
            ...requestItem(row),
            workspace_id: HEX.test(row.workspace_id || '') ? row.workspace_id : null,
            team_name: typeof row.team_name === 'string' ? row.team_name : '',
          })) }]
        })
      },
    },
  ]
}

function workspaceItem(team, me, env) {
  return {
    id: team.workspace_id,
    owner_id: userIdOf(team.owner || {}, me, env),
    name: team.name,
    created: unix(team.created_at),
    kind: team.slug ? 'team' : 'workspace',
    slug: team.slug || null,
    team_name: team.slug ? team.name : null,
    converted: false,
    role: team.role || null,
    member_count: team.member_count ?? 1,
  }
}

const IDEM = /^[A-Za-z0-9_-]{16,64}$/

function personalWorkspace(binding, env) {
  if (!HEX.test(binding?.workspace_id) || !HEX.test(binding?.agent_id)) return null
  const owner = ownerId(env)
  return {
    id: binding.workspace_id, owner_id: HEX.test(owner) ? owner : null,
    name: '个人工作区', created: 0, kind: 'personal', slug: null,
    team_name: null, converted: false, role: 'owner', member_count: 1,
  }
}

function teamsRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces$/,
      async handle({ query }, call) {
        return wrap(async () => {
          const q = parseQuery(query)
          const binding = host.call('agents/personal-binding', {})
          if (q.get('scope') === 'personal') {
            const localBinding = await binding
            const personal = personalWorkspace(localBinding, env)
            const result = { items: personal ? [personal] : [], cursor: null }
            const include = q.get('include')
            if (include === 'automations') {
              Object.assign(result, platformViewer(call))
              const workspaces = q.getAll('workspace')
              const personalScope = !workspaces.length || (workspaces.length === 1 && workspaces[0] === personal?.id)
              if (personal && personalScope && q.getAll('include').length === 1 && result.viewer_username) {
                const list = await host.call('automations/list', {
                  workspace_id: personal.id, category: 'mine', username: result.viewer_username,
                }).catch(() => null)
                if (Array.isArray(list?.items)) result.automations = {items: list.items}
              }
              return [200, result]
            }
            if (include === 'personal-agent') {
              Object.assign(result, platformViewer(call))
              const workspace = q.getAll('workspace')
              if (personal && (personal.owner_id || result.viewer_username) && q.getAll('include').length === 1
                  && (!workspace.length || (workspace.length === 1 && workspace[0] === personal.id))) {
                result.personal_agent_id = localBinding.agent_id
                const settings = await host.call('settings/look', {}).catch(() => null)
                result.personal_look = settings?.look ?? null
              }
              return [200, result]
            }
            if (include === 'artifacts' || include === 'chat') {
              Object.assign(result, platformViewer(call))
              if (personal && (personal.owner_id || result.viewer_username)) {
                if (include === 'chat') result.personal_agent_id = localBinding.agent_id
                if (!q.has('workspace') || q.get('workspace') === personal.id) {
                  if (include === 'chat') {
                    const agent = q.get('entry_agent')
                    const conversation = q.get('entry_conversation')
                    const entryRequested = q.get('workspace') === personal.id && q.getAll('workspace').length === 1 && HEX.test(agent || '')
                      && q.getAll('entry_agent').length === 1
                      && (conversation === null || (HEX.test(conversation) && q.getAll('entry_conversation').length === 1))
                    if (entryRequested) {
                      result.entry = await host.call('agents/startupEntry', {
                        workspace_id: personal.id, agent_id: agent, conversation_id: conversation ?? undefined,
                      }).catch(() => null)
                    }
                    // Exact conversation links can verify the same local owner
                    // binding before loading the directory independently.
                    if (q.get('directory') !== '0' || (entryRequested && conversation === null && !result.entry)) {
                      const directory = await host.call('agents/v1', {
                        method: 'GET', path: `/v1/workspaces/${personal.id}/agents?limit=100&include=conversations`,
                      }).catch(() => null)
                      if (directory?.status === 200 && Array.isArray(directory.body?.items) &&
                          Array.isArray(directory.body.conversations)) result.chat = directory.body
                    }
                  } else {
                    const order = q.get('order') === 'recent' ? '?order=recent' : ''
                    const catalog = await host.call('artifacts/v1', {
                      method: 'GET', path: `/v1/workspaces/${personal.id}/artifacts${order}`,
                    }).catch(() => null)
                    if (catalog?.status === 200 && Array.isArray(catalog.body?.items)) result.catalog = catalog.body
                  }
                }
              }
            }
            return [200, result]
          }
          const bs = client(host)
          const limit = Math.min(Math.max(Number(q.get('limit') || 20) || 20, 1), 100)
          const cursor = q.get('cursor') || ''
          const [me, data, localBinding] = await Promise.all([
            meOf(bs, env), bs.get('/v1/ot/workspaces'), binding,
          ])
          let rows = (data.workspaces || [])
            .filter((t) => HEX.test(String(t.workspace_id || '')))
            .map((t) => workspaceItem(t, me, env))
          const personal = personalWorkspace(localBinding, env)
          if (q.get('scope') === 'convertible') {
            rows = rows.filter(row => row.id !== personal?.id && row.kind === 'workspace' && row.role === 'owner')
          } else if (personal && !rows.some(row => row.id === personal.id)) {
            rows.unshift(personal)
          }
          if (cursor) {
            const at = rows.findIndex((row) => row.id === cursor)
            rows = at >= 0 ? rows.slice(at + 1) : []
          }
          const page = rows.slice(0, limit)
          return [200, { items: page, cursor: rows.length > limit ? page[page.length - 1].id : null }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          if (!name || name.length > 80) throw new Fault(400, 'invalid', 'Workspace name must be 1–80 characters without controls')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          const bs = client(host)
          const [me, team] = await Promise.all([meOf(bs, env), bs.post('/v1/ot/workspaces', { name, idempotency_key: key })])
          return [201, { workspace: workspaceItem(team, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/teams$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          const slug = body?.slug
          if (!name || !['new', 'convert'].includes(body?.mode)) throw new Fault(400, 'invalid', 'Provide a team name, a valid Team ID, and new or convert')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          if (body.mode === 'convert') {
            const binding = await host.call('agents/personal-binding', {})
            const personal = personalWorkspace(binding, env)
            if (personal && personal.id === body.workspace_id) {
              throw new Fault(409, 'conflict', 'The personal workspace cannot be converted into a team')
            }
          }
          const bs = client(host)
          const me = await meOf(bs, env)
          const team = body.mode === 'new'
            ? await bs.post('/v1/ot/workspaces', { name, slug, idempotency_key: key })
            : await bs.post(`/v1/ot/workspaces/${seg(body?.workspace_id, 'workspace_id')}/convert`, { name, slug })
          return [body.mode === 'new' ? 201 : 200, { workspace: { ...workspaceItem(team, me, env), converted: body.mode === 'convert' } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/team-directory$/,
      async handle({ query }) {
        return wrap(async () => {
          const bs = client(host)
          const q = parseQuery(query)
          const data = await bs.get('/v1/ot/directory' + qs({ q: q.get('q'), limit: q.get('limit'), cursor: q.get('cursor') }))
          return [200, {
            items: (data.teams || []).map((t) => ({
              name: t.name,
              summary: t.summary || '',
              member_count: t.member_count ?? 0,
              team_id: t.id,
              workspace_id: t.workspace_id || t.id,
              membership: t.membership || null,
            })),
            cursor: data.cursor || null,
          }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/team-directory\/([A-Za-z0-9._-]{1,80})\/join$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const id = match[1]
          const teamId = HEX.test(id)
            ? (await bs.get(`/v1/ot/teams/by-workspace/${seg(id, 'workspace_id')}`)).id
            : id
          const data = await bs.post(`/v1/ot/directory/${seg(teamId, 'team_id')}/join`)
          if (data.status === 'pending') return [202, { join_request: { id: data.request_id, status: 'pending' } }]
          return [200, {
            status: data.status || 'member',
            ...(data.status === 'member' && HEX.test(data.workspace_id || '') ? { workspace_id: data.workspace_id } : {}),
          }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          return [200, { listing: { listed: !!team.listed, summary: team.summary || '' } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.put(`/v1/ot/teams/${seg(team.id, 'team_id')}/listing`, {
            listed: body?.listed === true, summary: body?.summary,
          })
          return [200, { listing: { listed: !!data.listed, summary: data.summary || '' } }]
        })
      },
    },
  ]
}

const accountConversation = c => Boolean(c?.direct || c?.account_group)

async function messengerScope(host, bs, workspace, conversationId, messageId) {
  const binding = await host.call?.('agents/personal-binding', {})
  if (binding?.workspace_id !== workspace) {
    return {personal: false, team: await teamFor(bs, workspace, 'Workspace', process.env)}
  }
  if (!conversationId) return {personal: true}
  const path = '/v1/ot/conversations/' + seg(conversationId, 'conversation_id')
  const conversation = await bs.get(path)
  if (!conversation.public_agent && !accountConversation(conversation)) throw new Fault(404, 'not_found', '该会话不在个人工作区。')
  if (messageId) await bs.get('/v1/ot/messages/' + seg(messageId, 'message_id') + qs({conversation_id: conversationId}))
  return {personal: true, conversation}
}

async function requireSharedGroupScope(host,bs,workspace,cid) {
  if (typeof workspace !== 'string' || !HEX.test(workspace)) throw new Fault(400,'invalid','无效的工作区。')
  const scope = await messengerScope(host,bs,workspace,cid)
  const group = scope.conversation || await bs.get('/v1/ot/conversations/' + cid)
  if (group.kind !== 'group' || group.public_agent || (scope.personal ? !group.account_group : group.team_id !== scope.team.id)) {
    throw new Fault(404,'not_found','该群聊不在当前工作区。')
  }
  return group
}

function sharedAgentTargets(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5 || input.some(target =>
    !target || typeof target.owner_id !== 'string' || typeof target.agent_id !== 'string' ||
    Object.keys(target).length !== 2 || !GROUP_AGENT_ID.test(target.owner_id) || !GROUP_AGENT_ID.test(target.agent_id))) {
    throw new Fault(400, 'invalid', '请选择 1 至 5 个有效的智能体。')
  }
  const ordered = input.map(({owner_id, agent_id}) => ({owner_id, agent_id}))
  if (new Set(ordered.map(item => JSON.stringify(item))).size !== ordered.length) {
    throw new Fault(400, 'invalid', '不能重复选择同一个智能体。')
  }
  return ordered
}

export async function shareGroupMemory(host, payload) {
  const {workspace_id,conversation_id,title,body,source_message_id,sources,client_key} = payload || {}
  const bs = client(host), cid = seg(conversation_id,'conversation_id')
  await requireSharedGroupScope(host,bs,workspace_id,cid)
  return bs.post(`/v1/ot/conversations/${cid}/memories`,{title,body,source_message_id,sources,client_key})
}

export async function groupMemorySources(host, payload) {
  const {workspace_id:workspace, conversation_id:id, message_ids, after} = payload || {}
  if (typeof workspace !== 'string' || !HEX.test(workspace)) throw new Fault(400,'invalid','无效的工作区。')
  const cid = seg(id,'conversation_id')
  const binding = await host.call('agents/personal-binding', {})
  return client(host).post(`/v1/ot/conversations/${cid}/memory-sources`,{
    ...(binding?.workspace_id === workspace ? {} : {workspace_id:workspace}),
    ...(after === undefined ? {message_ids} : {after}),
  })
}

function messengerRoutes(host, wakeReplies) {
  const env = process.env
  const convPath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations$/
  const onePath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})$/
  const managementPath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/management$/
  return [
    {
      method: 'GET', path: convPath,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal, team} = await messengerScope(host, bs, match[1])
          const scope = {scope: personal ? 'personal' : 'member', team_id: team?.id}
          const q = parseQuery(query)
          if (q.get('view') === 'activity') {
            const data = await bs.get('/v1/ot/conversations' + qs({...scope, view: 'activity', since: q.get('since')}))
            return [200, data]
          }
          const me = await meOf(bs, env)
          const data = await bs.get('/v1/ot/conversations' + qs(scope))
          const items = (data.conversations || []).filter(c => personal ? (c.public_agent || accountConversation(c)) : !c.public_agent)
            .map(c => conversationItem(c, me, env, match[1]))
          return [200, { items, cursor: null }]
        })
      },
    },
    {
      method: 'POST', path: convPath,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal, team} = await messengerScope(host, bs, match[1])
          const me = await meOf(bs, env)
          const kind = body?.kind
          const ids = Array.isArray(body?.member_ids) ? body.member_ids : []
          if (kind !== 'dm' && kind !== 'group') throw new Fault(400, 'invalid', '请选择会话类型。')
          let data
          if (kind === 'dm') {
            data = await bs.post('/v1/ot/conversations', { kind: 'dm', peer: ids[0] })
          } else {
            const agentIds = body?.agent_ids ?? []
            if (!Array.isArray(agentIds) || agentIds.length > 10) throw new Fault(400, 'invalid', '最多可选 10 个智能体。')
            const agents = await Promise.all([...new Set(agentIds)].map(async id => {
              const {agent} = await host.call('agents/get', {id, workspace_id: match[1]})
              if (agent.archived) throw new Fault(400, 'invalid', '请选择可用的智能体。')
              return {agent_ref:agent.id, name:String(agent.name).slice(0,40)}
            }))
            data = await bs.post('/v1/ot/conversations', {
              kind: 'group', title: body?.title, team_id: team?.id, account_group: personal,
              members: ids, agents, idempotency_key,
            })
          }
          const conversation = conversationItem(data, me, env, match[1])
          return [data.id && conversation.id ? 201 : 200, { conversation }]
        })
      },
    },
    {
      method: 'GET', path: onePath,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const me = await meOf(bs, env)
          const conv = scope.conversation || await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`)
          const q = parseQuery(query)
          const around = q.get('around') ?? undefined
          const startUnread = q.get('start') === 'unread'
          const unread = startUnread && !conv.public_agent
          if (around !== undefined && (startUnread || q.getAll('around').length !== 1)) {
            throw new Fault(400, 'invalid', 'Choose one message cursor')
          }
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({
            limit: unread || around !== undefined ? 50 : 100, pins: 1, unread: unread ? 1 : undefined, around,
            workspace_id: !scope.personal && (unread || around !== undefined || conv.kind === 'dm') ? match[1] : undefined,
          })).catch(error => {
            if (around !== undefined && error?.code === 'social/message_not_found') {
              throw new Fault(404, 'history_anchor_missing', '找不到原来的阅读位置。')
            }
            throw error
          })
          return [200, {
            conversation: conversationItem(conv, me, env, match[1]),
            items: (page.messages || []).map((m) => messageItem({ ...m, conversation_id: conv.id }, me, env, match[1])),
            agent_replies: [],
            pinned_messages: page.pinned_messages || [],
            cursor: page.next_before ?? null,
            ...(around !== undefined ? {has_newer:page.has_newer === true} : {}),
            ...(unread ? {unread_window: {first:page.first_unread, read_seq:page.read_seq, last_seq:page.last_seq,
              has_newer:page.has_newer === true}} : {}),
          }]
        })
      },
    },
    {
      method: 'GET', path: managementPath,
      async handle({match}) {
        return wrap(async () => {
          const bs = client(host)
          const group = await requireSharedGroupScope(host,bs,match[1],match[2])
          if (!group.group_management) throw new Fault(404,'not_found','无法管理此群聊。')
          return [200,{conversation:conversationItem(group,await meOf(bs,env),env,match[1])}]
        })
      },
    },
    {
      method: 'POST', path: managementPath,
      async handle({match,body}) {
        return wrap(async () => {
          const [ , workspace, id ] = match
          const {action, revision, title, member_id:memberId, mode, lead} = body || {}
          const field = typeof action === 'string' && Object.hasOwn(GROUP_MANAGEMENT_FIELDS,action) ? GROUP_MANAGEMENT_FIELDS[action] : null
          const policy = action === 'reply_policy'
          if (field === null || !Number.isSafeInteger(revision) || revision < 0 ||
              Object.keys(body).some(key => key !== 'action' && key !== 'revision' && key !== field && !(policy && key === 'lead')) ||
              (field === 'title' && (typeof title !== 'string' || !title.trim() || title.length > 80)) ||
              (field === 'member_id' && (typeof memberId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(memberId)))) {
            throw new Fault(400, 'invalid', '群聊管理请求无效。')
          }
          if (policy) {
            if (!['default','everyone','lead','mentions'].includes(mode) || (mode !== 'lead' && Object.hasOwn(body,'lead'))) {
              throw new Fault(400, 'invalid', '请选择有效的智能体回复策略。')
            }
            if (mode === 'lead') sharedAgentTargets([lead])
          }
          const bs = client(host)
          const binding = await host.call('agents/personal-binding', {})
          const direct = binding?.workspace_id === workspace
          const result = await bs.post(`/v1/ot/conversations/${seg(id,'conversation_id')}/management`, {
            action, revision, ...(field ? {[field]:body[field]} : {}), ...(policy && mode === 'lead' ? {lead} : {}),
            ...(direct ? {direct:true} : {workspace}),
          })
          if (action === 'leave') {
            if (result.left === true && result.conversation_id === id) return [200,{left:true,conversation_id:id}]
            throw new Fault(502,'unavailable','无法确认退群结果。')
          }
          if (result.conversation?.id !== id || !result.conversation.group_management) {
            throw new Fault(502, 'unavailable', '无法确认群聊管理结果。')
          }
          const me = await meOf(bs, env)
          return [200, {conversation:conversationItem(result.conversation, me, env, workspace)}]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const me = await meOf(bs, env)
          const q = parseQuery(query)
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({
            workspace_id: !scope.personal && q.get('scope') === 'workspace' ? match[1] : undefined,
            limit: q.get('limit'), before: q.get('before') || q.get('cursor'), after: q.get('after'), around: q.get('around'), q: q.get('q'),
          }))
          return [200, {
            items: (page.messages || []).map(m => messageItem({ ...m, conversation_id: match[2] }, me, env, match[1])),
            cursor: page.next_before ?? null, has_newer: page.has_newer === true,
            ...(q.has('after') ? {last_seq:page.last_seq} : {}),
          }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages\/([A-Za-z0-9._-]{1,80})\/voice$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const conversation = seg(match[2], 'conversation_id')
          const message = seg(match[3], 'message_id')
          return [200, await bs.get(`/v1/ot/conversations/${conversation}/messages/${message}/voice`)]
        })
      },
    },
    {
      method:'GET', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory$/,
      async handle({match}) {
        return wrap(async () => {
          const bs = client(host)
          await requireSharedGroupScope(host,bs,match[1],match[2])
          const [shared, capture] = await Promise.all([
            bs.get(`/v1/ot/conversations/${match[2]}/memories`),
            host.call('memory/groupCaptureStatus',{workspace_id:match[1],conversation_id:match[2]}),
          ])
          return [200,{...shared,auto_capture:capture.enabled}]
        })
      },
    },
    {
      method:'POST', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory\/auto-capture$/,
      async handle({match,body}) {
        return wrap(async () => {
          if (typeof body?.enabled !== 'boolean') throw new Fault(400,'invalid','请选择是否自动提炼。')
          return [200,await host.call('memory/setGroupCapture',{
            workspace_id:match[1],conversation_id:match[2],enabled:body.enabled,
          })]
        })
      },
    },
    {
      method:'POST', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory\/([A-Za-z0-9._-]{1,80})\/remove$/,
      async handle({match}) {
        return wrap(async () => {
          const bs = client(host)
          await requireSharedGroupScope(host,bs,match[1],match[2])
          return [200,await bs.del(`/v1/ot/conversations/${match[2]}/memories/${match[3]}`)]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/memory\/capture$/,
      async handle({match,body}) {
        return wrap(async () => {
          const message_ids = body?.message_ids
          if (!Array.isArray(message_ids) || !message_ids.length || !message_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id))) {
            throw new Fault(400,'invalid','请选择 1 到 12 条群成员的文字消息。')
          }
          const scope = {workspace_id:match[1],conversation_id:match[2]}
          const {items} = await groupMemorySources(host,{...scope,message_ids})
          if (items.length !== message_ids.length) throw new Fault(409,'conflict','有消息已撤回、删除或无法用于提炼，请重新选择。')
          return [202,await host.call('memory/enqueueGroupHistory',{...scope,messages:items.map(({id,revision}) => ({id,revision}))})]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          if (body?.direct_agent_request !== undefined) {
            const [, workspace, conversationId] = match
            const path = '/v1/ot/conversations/' + seg(conversationId)
            const conversation = scope.conversation || await bs.get(path)
            if (conversation.kind !== 'dm' || !conversation.direct || conversation.direct_agent_requests !== true) {
              throw new Fault(404, 'not_found', '此私聊无法请求智能体。')
            }
            if (body.direct_agent_request !== true || typeof body.body !== 'string' ||
                !body.body.trim() || body.body.length > 4000 ||
                typeof idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(idempotency_key) ||
                Object.keys(body).some(k => !['body','agent_mentions','reply_to','direct_agent_request'].includes(k))) {
              throw new Fault(400, 'invalid', '只能向私聊智能体发送文字或引用一条消息。')
            }
            const data = await bs.post(path + '/messages', {
              direct:true, direct_agent_request:true, body:body.body, reply_to:body.reply_to,
              agent_mentions:sharedAgentTargets(body.agent_mentions), client_key:idempotency_key,
              ...(!scope.personal ? {workspace} : {}),
            })
            if (data.reply_jobs?.some(job => job.status === 'queued')) wakeReplies()
            const me = await meOf(bs, env)
            return [201, {message:messageItem({...data,conversation_id:conversationId},me,env,workspace)}]
          }
          let attachment
          let stickerReplay = false
          if (body?.sticker_id !== undefined) {
            if (typeof body.sticker_id !== 'string' || !HEX.test(body.sticker_id) || !idempotency_key ||
                body.artifact_id !== undefined || body.attachment !== undefined || body.voice !== undefined ||
                scope.conversation?.public_agent) {
              throw new Fault(400, 'invalid', '请选择一张可发送到此会话的贴纸。')
            }
            try {
              const snapshot = await host.call('stickers/attachment', {id:body.sticker_id})
              attachment = {...snapshot.attachment,sticker:true}
            } catch (error) {
              if (error?.status !== 404) throw error
              stickerReplay = true
            }
          } else if (body?.artifact_id !== undefined) {
            if (body.voice || body.attachment || scope.conversation?.public_agent) {
              throw new Fault(400, 'invalid', '请选择可以接收附件的群聊或单聊。')
            }
            if (body.body !== undefined && (typeof body.body !== 'string' || body.body.length > 4000)) {
              throw new Fault(400, 'invalid', '附言不能超过 4000 个字符。')
            }
            const snapshot = await host.call('artifacts/chatAttachment', {workspace_id: match[1],
              artifact_id: body.artifact_id, revision: body.artifact_revision})
            body = {...body,body:body.body?.trim() || snapshot.body}
            attachment = snapshot.attachment
          } else if (body?.attachment !== undefined) {
            const {title,mime,data} = body.attachment || {}
            attachment = {title,mime,data}
          }
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages`, {
            workspace: match[1], direct: accountConversation(scope.conversation), client_key: idempotency_key,
            ...(stickerReplay ? {sticker_replay:true} : {
              body:body?.body,voice:body?.voice,attachment,mentions:body?.mentions,agent_mentions:body?.agent_mentions,reply_to:body?.reply_to,
            }),
          })
          if (data.reply_jobs?.some(job => job.status === 'queued')) wakeReplies()
          return [201, { message: messageItem({ ...data, conversation_id: match[2] }, me, env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/read$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/read`, body?.seq === undefined ? {} : { seq: body.seq })
          return [200, { unread_count: data.unread ?? 0 }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/preferences$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const data = await bs.patch(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`, { pinned: body?.pinned, muted: body?.muted })
          return [200, { pinned: !!data.pinned, muted: !!data.muted }]
        })
      },
    },
  ]
}

// Remaining legacy messenger subroutes (message pin/react/edit/retract/delete/save,
// forward, group agents, manual agent replies). Agent replies run as one native
// turn on THIS user's DS-Bot; nothing falls back to the platform.
function messengerExtraRoutes(host, wakeReplies) {
  const env = process.env
  const base = '^\\/v1\\/workspaces\\/([0-9a-f]{32})\\/social\\/conversations\\/([A-Za-z0-9._-]{1,80})'
  const re = (tail) => new RegExp(base + tail + '$')
  const conv = (id) => `/v1/ot/conversations/${seg(id, 'conversation_id')}`
  const msg = (id) => `/v1/ot/messages/${seg(id, 'message_id')}`
  const findMessage = (bs, cid, mid) => bs.get(msg(mid) + qs({conversation_id: cid}))
  const callTeam = async (bs, workspace, cid) => {
    const scope = await messengerScope(host, bs, workspace, cid)
    if (scope.personal && !accountConversation(scope.conversation)) throw new Fault(404, 'not_found', '该会话没有通话功能。')
    return scope.team?.id
  }
  const recordingInput = body => {
    const action = body?.action
    const fields = ['call_id', 'peer_id', 'action', ...(action === 'request' ? [] : ['recording_id'])]
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
    if (!['request', 'allow', 'decline', 'stop'].includes(action) ||
        Object.keys(body).length !== fields.length || !fields.every(field => Object.hasOwn(body, field)) ||
        fields.some(field => field !== 'action' && !valid(body[field]))) {
      throw new Fault(400, 'invalid', '录制同意请求无效。')
    }
    return body
  }
  return [
    {
      method: 'POST', path: /^\/v1\/meeting-calls\/(create|preview|join|poll|signal|leave|end|recording)$/,
      handle: ({ match, body }) => wrap(async () => [200, await client(host).post('/v1/ot/meeting-calls/' + match[1],
        match[1] === 'recording' ? recordingInput(body) : body)]),
    },
    ...['GET', 'POST', 'DELETE'].map(method => ({
      method, path: re('\\/group-invite'),
      handle: ({ match }) => wrap(async () => {
        const [, workspace, conversation] = match
        const bs = client(host)
        await requireSharedGroupScope(host, bs, workspace, conversation)
        const path = conv(conversation) + '/invite'
        if (method === 'GET') return [200, await bs.get(path)]
        if (method === 'POST') return [201, await bs.post(path, {})]
        return [200, await bs.del(path)]
      }),
    })),
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/agent-retry'),
      handle: ({match, body}) => wrap(async () => {
        const [, workspace, conversation, message] = match
        const bs = client(host)
        const scope = await messengerScope(host, bs, workspace, conversation)
        const result = await bs.post(conv(conversation) + '/messages/' + seg(message) + '/agent-retry',
          {job_id:body?.job_id, attempt:body?.attempt, ...(!scope.personal ? {workspace} : {})})
        wakeReplies()
        return [200, result]
      }),
    },
    {
      method: 'GET', path: re('\\/attachments'), queryLimit: 1024,
      handle: ({ match, query }) => wrap(async () => {
        const [, workspace, conversation] = match
        const params = parseQuery(query)
        for (const name of params.keys()) {
          if (!['kind', 'q', 'cursor', 'limit'].includes(name) || params.getAll(name).length !== 1) {
            throw new Fault(400, 'invalid', '无效的附件搜索参数。')
          }
        }
        const binding = await host.call('agents/personal-binding', {})
        const path = binding?.workspace_id === workspace ? conv(conversation)
          : `/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}`
        const data = await client(host).get(path + '/attachments' + qs(Object.fromEntries(params)))
        return [200, {
          items: (data.items || []).map(row => ({
            message_id: row.message_id, created_at: unix(row.created_at),
            attachment: attachmentItem(row.attachment, workspace, conversation, row.message_id),
          })),
          next_cursor: data.next_cursor ?? null,
        }]
      }),
    },
    {
      method: 'GET', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/file'),
      handle: ({ match, query }) => wrap(async () => {
        const [, workspace, conversation, message] = match
        const bs = client(host)
        const scope = await messengerScope(host, bs, workspace, conversation)
        const path = accountConversation(scope.conversation) ? conv(conversation) : `/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}`
        const file = await bs.get(path + '/messages/' + seg(message) + '/file')
        const inline = /^(image|audio|video)\//.test(file.mime) && new URLSearchParams(query).get('download') !== '1'
        return [200, null, {filename: file.title, content_type: file.mime, data: file.data, inline}]
      }),
    },
    {
      method: 'GET', path: re('\\/call'),
      handle: async ({ match }) => wrap(async () => {
        const bs = client(host)
        const teamId = await callTeam(bs, match[1], match[2])
        return [200, await bs.get(conv(match[2]) + '/call' + qs({team_id: teamId}))]
      }),
    },
    {
      method: 'POST', path: re('\\/call\\/(join|poll|signal|leave|recording)'),
      handle: async ({ match, body }) => wrap(async () => {
        const input = match[3] === 'recording' ? recordingInput(body) : body
        const bs = client(host)
        const teamId = await callTeam(bs, match[1], match[2])
        return [200, await bs.post(conv(match[2]) + '/call/' + match[3], {...input, team_id: teamId})]
      }),
    },
    ...['GET','POST'].map(method=>({method,path:re('\\/(translation|translations)'),
      async handle(p) {
        const result=await host.call('message-assists/v1',{method,path:p.match[0],body:p.body})
        return [result.status,result.body]
      },
    })),
    ...['GET','POST'].map(method=>({method,path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/assists$/,
      async handle(p){ const out=await host.call('message-assists/v1',{method,path:p.match[0],body:p.body,idempotency_key:p.idempotency_key});return [out.status,out.body] } })),
    ...['GET', 'POST'].map(method => ({ method, path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/announcement$/,
      handle: async ({ match, body }) => wrap(async () => {
        const bs = client(host); await messengerScope(host, bs, match[1], match[2])
        const path = '/v1/ot/conversations/' + encodeURIComponent(match[2]) + '/announcement'
        return [200, method === 'GET' ? await bs.get(path) : await bs.post(path, body)]
      }) })),
    {
      method: 'POST', path: re('\\/members'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const path = conv(match[2])
          const group = scope.conversation || await bs.get(path)
          if (scope.personal ? !group.account_group : group.team_id && group.team_id !== scope.team.id) {
            throw new Fault(404, 'not_found', 'Conversation not found in this workspace')
          }
          const updated = await bs.post(path + '/members', { handles: body?.member_ids ?? [], team_id: scope.team?.id })
          return [200, { conversation: conversationItem(updated, await meOf(bs, env), env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/pin'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const data = await bs.post(`${msg(match[3])}/pin`, { on: body?.pinned !== false })
          return [200, { pinned: data.pinned, pinned_messages: data.pinned_messages || [] }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/reactions'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const data = await bs.post(`${msg(match[3])}/reactions`, { emoji: body?.emoji, on: body?.active !== false })
          return [200, { reactions: data.reactions || [] }]
        })
      },
    },
    {
      method: 'DELETE', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})'),
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          await bs.post(`${msg(match[3])}/hide`, {conversation_id: match[2]})
          return [204, {}]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/hide'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal} = await messengerScope(host, bs, match[1])
          const data = await bs.post(conv(match[2]) + '/messages/hide', {
            message_ids: body?.message_ids, ...(personal ? {direct:true} : {workspace:match[1]}),
          })
          return [200, data]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/(edit|retract)'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const me = await meOf(bs, env)
          if (match[4] === 'retract') {
            await bs.del(msg(match[3]))
            return [200, { message: messageItem({ ...(await findMessage(bs, match[2], match[3])), conversation_id: match[2] }, me, env, match[1]) }]
          }
          const data = await bs.patch(msg(match[3]), { body: body?.body })
          return [200, { message: messageItem({ ...data, conversation_id: match[2] }, me, env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/save'),
      async handle({ match, body }) {
        return wrap(async () => {
          const [, workspace, conversation, message] = match
          if (!Number.isInteger(body?.revision) || body.revision < 1) throw new Fault(400, 'invalid', 'Provide the message revision')
          const bs = client(host)
          const scope = await messengerScope(host, bs, workspace, conversation)
          const row = accountConversation(scope.conversation)
            ? {...await findMessage(bs, conversation, message), title: scope.conversation.title}
            : await bs.get(`/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}/messages/${seg(message)}`)
          if (row.retracted || row.attachment || row.voice || !row.body?.trim()) throw new Fault(409, 'conflict', '只能保存未撤回的文字消息。')
          if (row.revision !== body.revision) throw new Fault(409, 'conflict', '消息已修改，请刷新后再保存。')
          const {status, artifact} = await host.call('artifacts/saveChatMessage', {
            workspace_id: workspace, conversation_id: conversation, message_id: message,
            conversation_title: row.title, title: body.title, body: row.body,
          })
          return [status, {artifact}]
        })
      },
    },
    {
      method: 'POST', path: re('\\/forward'),
      async handle({ match, body, idempotency_key: key }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal} = await messengerScope(host, bs, match[1])
          return [201, await bs.post(conv(match[2]) + '/forward', {
            message_ids: body?.message_ids, target_conversation_id: body?.target_conversation_id,
            workspace: personal ? undefined : match[1], request_key: key,
          })]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const conversation = scope.conversation || await bs.get(conv(match[2]))
          if (!scope.personal && conversation.kind === 'group' && conversation.team_id !== scope.team.id) {
            throw new Fault(404,'not_found','该群聊不在当前工作区。')
          }
          const ids = Array.isArray(body?.agent_ids) ? body.agent_ids.slice(0, 10) : []
          if (!ids.length) throw new Fault(400, 'invalid', 'Provide agent_ids')
          let workspace = match[1]
          const direct = conversation.kind === 'dm'
          if (direct) {
            if (conversation.direct_agent_requests !== true) throw new Fault(404,'not_found','此私聊无法加入智能体。')
            workspace = (await host.call('agents/personal-binding', {}))?.workspace_id
            if (!workspace) throw new Fault(503,'unavailable','无法加载个人智能体。')
          }
          let saved
          for (const id of ids) {
            const { agent } = await host.call('agents/get', { id, workspace_id:workspace })
            if (direct && (agent.archived || agent.native_deleted)) throw new Fault(404,'not_found','该个人智能体不可用。')
            saved = await bs.put(`${conv(match[2])}/agents/${seg(agent.id, 'agent_ref')}`,
              {
                name:String(agent.name).slice(0,40), ...(!direct ? {auto_reply:false} : {}),
                ...(direct && !scope.personal ? {workspace:match[1]} : {}),
              })
          }
          const roster = agentRosterItem(saved, match[1])
          return [201, {added:ids.length, ...(roster ? {roster} : {})}]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents\\/([A-Za-z0-9._-]{1,80})\\/auto-reply'),
      async handle({ match, body }) {
        return wrap(async () => {
          if (typeof body?.auto_reply !== 'boolean') throw new Fault(400, 'invalid', 'Provide auto_reply as a boolean')
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          const result = await bs.patch(`${conv(match[2])}/agents/${seg(match[3], 'agent_ref')}`, { auto_reply: body.auto_reply })
          return [200, { auto_reply: result.auto_reply }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents\\/([A-Za-z0-9._:-]{1,80})\\/remove'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const conversation = scope.conversation || await bs.get(conv(match[2]))
          if (!scope.personal && conversation.kind === 'group' && conversation.team_id !== scope.team.id) {
            throw new Fault(404,'not_found','该群聊不在当前工作区。')
          }
          let owner = ''
          if (conversation.kind === 'dm') {
            if (conversation.direct_agent_requests !== true) throw new Fault(404,'not_found','此私聊无法移除智能体。')
            if (typeof body?.owner_id !== 'string' || !GROUP_AGENT_ID.test(body.owner_id)) {
              throw new Fault(400,'invalid','请选择要移除的智能体。')
            }
            owner = qs({owner_id:body.owner_id, ...(!scope.personal ? {workspace:match[1]} : {})})
          }
          const saved = await bs.del(`${conv(match[2])}/agents/${seg(match[3], 'agent_ref')}${owner}`)
          const roster = agentRosterItem(saved, match[1])
          return [200, {removed:true, ...(roster ? {roster} : {})}]
        })
      },
    },
    {
      method: 'GET', path: re('\\/reply-progress'),
      async handle({ match, query }) {
        return wrap(async () => {
          if (query) throw new Fault(400, 'invalid', 'Invalid reply progress request')
          const [, workspace, conversation] = match
          const binding = await host.call('agents/personal-binding', {})
          const path = binding?.workspace_id === workspace ? conv(conversation)
            : `/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}`
          const progress = await client(host).get(path + '/reply-progress')
          const working = progress.working_bots?.length ? progress.working_bots : nativeWorkingBots(host, conversation)
          return [200, working.length ? {...progress, working_bots:working} : progress]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agent-replies'),
      async handle({ match, body, idempotency_key: key }) {
        return wrap(async () => {
          const [, workspace, conversationId] = match
          const paired = body?.agent_targets !== undefined
          const ids = Array.isArray(body?.agent_ids) ? [...new Set(body.agent_ids)] : []
          const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
          if ((paired ? body.agent_ids !== undefined : !ids.length || ids.length > 5 || !ids.every(id => typeof id === 'string'))
              || !prompt || prompt.length > 4000
              || typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
            throw new Fault(400, 'invalid', 'Provide up to five group agents, a prompt and a send key')
          }
          const selected = paired ? sharedAgentTargets(body.agent_targets) : null
          const reference = body.studio_reference
          const studio = studioReference(reference)
          if (reference !== undefined && (!studio || Object.keys(reference).length !== 2)) {
            throw new Fault(400, 'invalid', '选择有效的团队文档版本。')
          }
          const bs = client(host)
          const conversation = await requireSharedGroupScope(host, bs, workspace, conversationId)
          if (studio && accountConversation(conversation)) {
            throw new Fault(404, 'studio_reference_unavailable', '此群聊无法使用团队文档。')
          }
          const me = await meOf(bs, env)
          const targets = selected || ids.map(agentId => {
            const agent = (conversation.agents || []).find(a => a.agent_ref === agentId && a.mine)
            if (!agent) throw new Fault(404, 'not_found', 'That agent of yours is not in this group')
            return {owner_id:me.owner_id, agent_id:agentId}
          })
          if (paired && conversation.group_agent_requests !== true) {
            throw new Fault(503, 'unavailable', '群内智能体请求暂时不可用，请刷新后重试。')
          }
          const source = await bs.post(`${conv(conversationId)}/messages`, {
            body:prompt, workspace, direct:accountConversation(conversation), agent_mentions:targets, client_key:key,
            ...(paired ? {group_agent_request:true} : {}),
            ...(studio ? {studio_reference:studio} : {}),
          })
          if (source.reply_jobs?.some(job => job.status === 'queued')) wakeReplies()
          return [202, {message:messageItem({...source, conversation_id:conversationId}, me, env, workspace)}]
        })
      },
    },
  ]
}

function agentPublication(row) {
  try {
    const data = JSON.parse(row?.snapshot ?? 'null')
    if (data?.version === 1) {
      const instructions = typeof data.instructions === 'string' && data.instructions.length <= agentLimits.instructions
        ? data.instructions : ''
      const sharesQuickStarts = Array.isArray(data.quick_starts)
      const quickStarts = sharesQuickStarts ? data.quick_starts.slice(0, agentLimits.quickStarts).flatMap(value => {
        if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return []
        const text = value.replace(/\s+/g, ' ').trim()
        return text && text.length <= agentLimits.quickStart ? [text] : []
      }) : []
      return { instructions, quickStarts, sharesQuickStarts }
    }
  } catch { /* Older or malformed snapshots may lack an agent publication. */ }
  return { instructions: '', quickStarts: [], sharesQuickStarts: false }
}

function remixTemplate(row) {
  const { instructions, quickStarts } = agentPublication(row)
  const template = { name: row.title, summary: row.summary || '', category: agentCategories.includes(row.category) ? row.category : null,
    instructions }
  // Keep previous no-starter revisions valid. A copy containing starters must be previewed again.
  const release = quickStarts.length ? { ...template, quick_starts: quickStarts } : template
  const revision = createHash('sha256').update(JSON.stringify([row.id, release])).digest('hex')
  return { ...template, quick_starts: quickStarts, revision }
}

function workCommentItem(row) {
  const author = row.author
  return {
    id: row.id, parent_id: row.parent_id ?? null, body: row.body, created_at: row.created_at,
    author: author ? {handle: author.handle, name: author.name} : null,
    mine: row.mine === true, can_remove: row.can_remove === true, removed: row.removed === true,
    reply_count: row.reply_count ?? 0, likes: row.likes ?? 0, liked: row.liked === true,
  }
}

function platformViewer(call) {
  // The platform gateway sets this header from the session that selected this runtime.
  const viewer = call?.request?.headers?.get('x-ot-owner-username')
  return typeof viewer === 'string' && PLATFORM_USERNAME.test(viewer) ? {viewer_username: viewer} : {}
}

function discoverRoutes(host) {
  const env = process.env
  const feed = (kind) => async ({ query }, call) => wrap(async () => {
    const bs = client(host)
    const q = parseQuery(query)
    const sort = q.get('sort')
    if (q.getAll('sort').length > 1 || (sort !== null && !['latest', 'popular', 'collected'].includes(sort))) {
      throw new Fault(400, 'invalid', '无效的发现排序。')
    }
    const popular = sort === 'popular'
    const collected = sort === 'collected'
    if (collected && (kind !== 'work' || q.get('tab') !== 'collected' || q.getAll('tab').length !== 1)) {
      throw new Fault(400, 'invalid', '收录时间排序仅用于已收录作品。')
    }
    const cursor = q.get('cursor')
    if (q.getAll('cursor').length > 1) throw new Fault(400, 'invalid', '无效的发现分页。')
    if (popular && (kind !== 'work' || (cursor !== null && !/^[A-Za-z0-9_-]{32}\.[1-9][0-9]{0,2}$/.test(cursor)))) {
      throw new Fault(400, 'invalid', '无效的热门作品请求。')
    }
    const keyset = kind === 'work' && !popular && (collected || cursor === null || cursor.startsWith('l.'))
    const position = cursor && keyset ? LATEST_WORK_CURSOR.exec(cursor) : null
    if (cursor !== null && !popular && (keyset ? !position || !Number.isSafeInteger(Number(position[1])) : !/^[0-9]{1,16}$/.test(cursor))) {
      throw new Fault(400, 'invalid', '无效的发现分页。')
    }
    const pagination = popular ? {sort, cursor}
      : keyset ? {pagination: 'keyset', cursor, ...(collected ? {sort} : {})}
        : {before: cursor}
    const data = await bs.get('/v1/ot/discover' + qs({
      kind, tab: q.get('tab'), q: q.get('q'), work_kind: q.get('kind'),
      creator: q.get('creator'), category: q.get('category'),
      ...pagination, limit: q.get('limit'),
    }))
    const items = (data.items || []).map((row) => (kind === 'agent' ? agentItem(row) : workItem(row)))
    const next = popular || keyset ? data.next_cursor : data.next_before
    return [200, {items, cursor: next ?? null, ...platformViewer(call)}]
  })
  const workListing = async (bs, artifactId) => ((await bs.get('/v1/ot/listings/mine')).listings || []).find((l) => l.kind === 'work' && l.ref === artifactId)
  const workMeta = (row) => (row && row.listed ? { listed: true, slug: row.slug, updated: unix(row.updated_at), path: row.path,
    ...(row.category ? {category:row.category} : {}),
    ...(Number.isSafeInteger(row.source_revision) && row.source_revision > 0 ? {published_revision:row.source_revision} : {}),
    ...(row.editable_remix === true ? {editable_remix:true} : {}) } : { listed: false })
  return [
    {
      method: 'GET', path: /^\/v1\/profile\/(social|follow-work)$/,
      async handle({ match, query }, call) {
        return wrap(async () => {
          const q = parseQuery(query)
          const notices = match[1] === 'follow-work'
          const keys = notices ? ['q', 'cursor', 'limit'] : ['view', 'q', 'cursor', 'limit']
          if ([...q.keys()].some(key => !keys.includes(key) || q.getAll(key).length !== 1)) {
            throw new Fault(400, 'invalid', '无效的主页列表请求。')
          }
          const result = await client(host).get('/v1/ot/profile/social' + qs({
            view: notices ? 'work-notices' : q.get('view'), q: q.get('q'), cursor: q.get('cursor'), limit: q.get('limit'),
          }))
          if (!notices && q.get('view') === 'following') {
            const {items, next_cursor} = result
            return [200, {items, next_cursor, ...platformViewer(call)}]
          }
          return [200, result]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/profile\/(social|follow-work)$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const notices = match[1] === 'follow-work'
          if (!notices && body && !Array.isArray(body) && Object.keys(body).length === 2
            && typeof body.listing_id === 'string' && PUBLIC_LISTING_ID.test(body.listing_id)
            && ['like', 'collect'].includes(body.action)) {
            const result = await client(host).post(`/v1/ot/listings/${body.listing_id}/${body.action}`, {on: false})
            const field = body.action === 'like' ? 'liked' : 'collected'
            return [200, {[field]: result[field]}]
          }
          const key = notices ? 'enabled' : 'on'
          if (!body || Array.isArray(body) || Object.keys(body).length !== 2
            || typeof body.handle !== 'string' || !PROFILE_HANDLE.test(body.handle) || typeof body[key] !== 'boolean') {
            throw new Fault(400, 'invalid', '请选择作者和更新状态。')
          }
          if (notices) {
            const result = await client(host).post('/v1/ot/follows/notifications', {handle: body.handle, enabled: body.enabled})
            return [200, {enabled: result.enabled === true}]
          }
          const result = await client(host).post('/v1/ot/follows', {handle: body.handle, on: body.on})
          return [200, {following: result.following === true}]
        })
      },
    },
    // Publish a work (artifact on this DS-Bot) to the public Bot Social catalog (/w/<slug>).
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover$/,
      async handle({ match }) { return wrap(async () => [200, { discover: workMeta(await workListing(client(host), match[2])) }]) },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const got = await host.call('artifacts/v1', { method: 'GET', path: `/v1/workspaces/${match[1]}/artifacts/${match[2]}` })
          const artifact = got?.body?.artifact
          if (!artifact) throw new Fault(404, 'not_found', 'Artifact not found')
          const editable = body?.allow_editable_remix
          if (editable !== undefined && typeof editable !== 'boolean') {
            throw new Fault(400,'invalid','请选择是否允许复制可编辑作品。')
          }
          if ((editable === true || body?.revision !== undefined) &&
              (!Number.isSafeInteger(body?.revision) || body.revision !== artifact.revision)) {
            throw new Fault(409,'artifact_changed','已保存的作品版本已更新，请重新打开后再发布。')
          }
          const prior = await workListing(bs, match[2])
          const mime = artifact.kind === 'media' ? artifact.media?.mime : undefined
          const mediaKind = mime === GLB_MIME ? 'model3d' : DISCOVER_MEDIA_KINDS.get(mime)
          if (artifact.kind === 'media' && !mediaKind) {
            throw new Fault(400, 'attachment_type_blocked', '这个文件格式无法公开发布。')
          }
          const kind = mediaKind || artifact.kind
          let editableSnapshot
          if (editable) {
            if (kind !== 'slides' && kind !== 'whiteboard') throw new Fault(400,'invalid','该作品类型无法发布可编辑版本。')
            const binding = await host.call('agents/personal-binding',{})
            if (binding?.workspace_id !== match[1]) await teamFor(bs,match[1],'Workspace',env)
            editableSnapshot = kind === 'slides' ? normalizeSlides(artifact.slides) : normalizeBoard(artifact.board)
            if (!editableSnapshot) throw new Fault(400,'invalid','这个作品没有可发布的保存版本。')
          }
          const siteHtml = kind === 'website' && typeof artifact.body === 'string' && artifact.body.trim() ? artifact.body : null
          const snapshot = siteHtml ? '' : kind === 'document' ? String(artifact.body || '') : [...structuredArtifactText(artifact)].join('\n')
          let file = {}
          if (mediaKind) {
            const result = await host.call('artifacts/chatAttachment', {
              workspace_id: match[1], artifact_id: match[2], revision: artifact.revision,
            })
            if (result?.attachment?.mime !== mime || typeof result.attachment.data !== 'string' || !result.attachment.data) {
              throw new Fault(409, 'conflict', '作品文件已更新，请刷新后重新发布。')
            }
            file = mediaKind === 'model3d' ? {model_data: result.attachment.data} : {
              media_data: result.attachment.data, media_mime: mime,
              media_filename: artifact.media.filename || result.attachment.title,
            }
          }
          const data = await bs.put('/v1/ot/listings', {
            kind: 'work', ref: match[2], slug: body?.slug, title: String(artifact.title || body?.slug).slice(0, 80),
            work_kind: kind,
            category: body?.category === undefined ? prior?.category : body.category,
            ...(Number.isSafeInteger(artifact.revision) && artifact.revision > 0 ? {source_revision:artifact.revision} : {}),
            ...(siteHtml ? {site_html: siteHtml} : {summary: snapshot.slice(0, 300), snapshot: snapshot.slice(0, 200000)}),
            ...(editableSnapshot ? {editable_snapshot:editableSnapshot} : {}),
            ...file,
          })
          return [prior ? 200 : 201, { discover: workMeta(data) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover\/revoke$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const row = await workListing(bs, match[2])
          if (row?.listed) await bs.del(`/v1/ot/listings/${seg(row.id, 'listing_id')}`)
          return [200, { discover: { listed: false } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/discover\/agents\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/start$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const input = body === undefined ? {} : body
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Fault(400, 'invalid', '无效的访客聊天请求。')
          const fields = Object.keys(input)
          const selected = Object.hasOwn(input, 'listing_id')
          const quick = fields.length > 0 && !selected
          if (selected && (fields.length !== 1 || typeof input.listing_id !== 'string' || !PUBLIC_LISTING_ID.test(input.listing_id))) {
            throw new Fault(400, 'invalid', '无效的公开智能体。')
          }
          if (quick && (fields.length !== 2 || !Number.isInteger(input.quick_start)
            || input.quick_start < 0 || input.quick_start > 4
            || typeof input.quick_start_version !== 'string' || !/^[a-f0-9]{64}$/.test(input.quick_start_version))) {
            throw new Fault(400, 'invalid', '请选择有效的快捷开场。')
          }
          const binding = await host.call('agents/personal-binding', {})
          if (!HEX.test(binding?.workspace_id || '')) throw new Fault(409, 'no_personal_workspace', '请先打开个人工作区。')
          const request = selected ? {listing_id: input.listing_id}
            : quick ? {quick_start: input.quick_start, quick_start_version: input.quick_start_version} : {}
          const result = await client(host).post(`/v1/ot/discover/${seg(match[1], 'slug')}/start`, request)
          return [200, { ...result, workspace_id: binding.workspace_id }]
        })
      },
    },
    ...['GET', 'POST'].map(method => ({
      method, path: /^\/v1\/discover\/agents\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/remix$/,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const row = await bs.get('/v1/ot/discover/' + seg(match[1], 'slug'))
          if (!row.listed || row.kind !== 'agent') throw new Fault(404, 'not_found', '该智能体已下架。')
          const template = remixTemplate(row)
          if (method === 'GET') return [200, { template }]
          if (body?.revision !== template.revision) throw new Fault(409, 'listing_changed', '发布内容已更新，请重新预览。')
          const workspaceId = body?.workspace_id
          if (!HEX.test(String(workspaceId || ''))) throw new Fault(400, 'invalid', '请选择工作区。')
          const binding = await host.call('agents/personal-binding', {})
          if (binding?.workspace_id !== workspaceId) await teamFor(bs, workspaceId, 'Workspace', env)
          try {
            const created = await host.call('agents/createRemix', {
              workspace_id: workspaceId, idempotency_key, name: body?.name ?? template.name,
              summary: template.summary, category: template.category, instructions: template.instructions,
              quick_starts: template.quick_starts,
            })
            return [created.status, { agent: { id: created.agent.id, name: created.agent.name, workspace_id: workspaceId } }]
          } catch (error) {
            if (error?.status === 409) throw new Fault(409, 'name_conflict', '工作区已有同名智能体，请换个名称。')
            throw error
          }
        })
      },
    })),
    { method: 'GET', path: /^\/v1\/discover\/agents$/, handle: feed('agent') },
    { method: 'GET', path: /^\/v1\/discover\/works$/, queryLimit: DISCOVER_WORK_QUERY_LIMIT, handle: feed('work') },
    { method: 'GET', path: /^\/v1\/discover\/me\/works$/, queryLimit: DISCOVER_WORK_QUERY_LIMIT, handle: feed('work') },
    {
      method: 'GET', path: new RegExp(`^${DISCOVER_WORK}$`),
      queryLimit: DISCOVER_WORK_QUERY_LIMIT,
      async handle({ match, query }, call) {
        return wrap(async () => {
          const q = parseQuery(query)
          if ([...q.keys()].some(key => !['tab', 'q', 'kind', 'sort', 'creator', 'category'].includes(key) || q.getAll(key).length !== 1)) {
            throw new Fault(400, 'invalid', '无效的作品浏览请求。')
          }
          const filters = {tab: q.get('tab'), q: q.get('q'), work_kind: q.get('kind'), sort: q.get('sort'),
            creator: q.get('creator'), category: q.get('category')}
          const data = await client(host).get(`/v1/ot/discover/${match[1]}/detail` + qs(filters))
          if (data?.work?.kind !== 'work' || data.work.listed !== true) throw new Fault(404, 'not_found', '找不到公开作品。')
          const adjacent = row => row ? {slug: row.slug, title: row.title} : null
          return [200, {work: workItem(data.work), previous: adjacent(data.previous), next: adjacent(data.next), ...platformViewer(call)}]
        })
      },
    },
    {
      method: 'GET', path: new RegExp(`^${DISCOVER_WORK}/remix$`),
      async handle({ match, query }, call) {
        return wrap(async () => {
          if (query) throw new Fault(400,'invalid','无效的作品复制请求。')
          const {template} = await client(host).get(`/v1/ot/discover/${match[1]}/remix`)
          return [200,{template,...platformViewer(call)}]
        })
      },
    },
    {
      method: 'POST', path: new RegExp(`^${DISCOVER_WORK}/remix$`),
      async handle({ match, query, body, idempotency_key: key }, call) {
        return wrap(async () => {
          if (query || !body || Object.keys(body).length !== 2 || !Object.hasOwn(body,'title') ||
              typeof body.revision !== 'string' || !/^[0-9a-f]{64}$/.test(body.revision) ||
              typeof key !== 'string' || !COMMENT_KEY.test(key)) {
            throw new Fault(400,'invalid','无效的作品复制请求。')
          }
          const binding = await host.call('agents/personal-binding', {})
          if (!HEX.test(binding?.workspace_id || '')) throw new Fault(409,'no_personal_workspace','请先打开个人工作区。')
          const slug = match[1]
          const payload = {slug,workspace_id:binding.workspace_id,revision:body.revision,title:body.title,idempotency_key:key}
          const previous = await host.call('artifacts/remixPublicWork',payload)
          const project = ({status,body:{artifact}}) => [status,{
            artifact:{id:artifact.id,workspace_id:artifact.workspace_id,kind:artifact.kind,title:artifact.title,revision:artifact.revision},
            ...platformViewer(call),
          }]
          if (previous) return project(previous)
          const snapshot = await client(host).get(`/v1/ot/discover/${slug}/remix` + qs({revision:body.revision}))
          if (!snapshot.source || snapshot.template?.revision !== body.revision || snapshot.template.kind !== snapshot.source.kind) {
            throw new Fault(409,'listing_changed','这个公开版本已不可用，请重新查看。')
          }
          return project(await host.call('artifacts/remixPublicWork',{...payload,source:snapshot.source}))
        })
      },
    },
    {
      method: 'GET', path: new RegExp(`^${DISCOVER_WORK}/comments$`),
      async handle({ match, query }) {
        return wrap(async () => {
          const q = parseQuery(query)
          if ([...q.keys()].some(key => !['parent_id', 'cursor', 'limit'].includes(key) || q.getAll(key).length !== 1)) {
            throw new Fault(400, 'invalid', '无效的评论分页请求。')
          }
          const params = {parent_id: q.get('parent_id'), cursor: q.get('cursor'), limit: q.get('limit')}
          const result = await client(host).get(`/v1/ot/discover/${match[1]}/comments` + qs(params))
          return [200, {items: result.items.map(workCommentItem), cursor: result.cursor ?? null, comment_count: result.comment_count}]
        })
      },
    },
    {
      method: 'POST', path: new RegExp(`^${DISCOVER_WORK}/comments$`),
      async handle({ match, body, idempotency_key: key }) {
        return wrap(async () => {
          if (typeof key !== 'string' || !COMMENT_KEY.test(key)) throw new Fault(400, 'invalid', '缺少有效的评论请求标识。')
          const result = await client(host).post(`/v1/ot/discover/${match[1]}/comments`, {
            body: body?.body, parent_id: body?.parent_id, client_key: key,
          })
          return [result.replayed === true ? 200 : 201, {
            comment: workCommentItem(result.comment), comment_count: result.comment_count,
            ...(Number.isSafeInteger(result.parent_reply_count) ? {parent_reply_count: result.parent_reply_count} : {}),
          }]
        })
      },
    },
    {
      method: 'POST', path: new RegExp(`^${DISCOVER_WORK}/comments/(${WORK_COMMENT})/(like|remove)$`),
      async handle({ match, body }) {
        return wrap(async () => {
          const [, slug, id, action] = match
          const result = await client(host).post(`/v1/ot/discover/${slug}/comments/${id}/${action}`,
            action === 'like' ? {enabled: body?.enabled} : {})
          return [200, action === 'like' ? {comment: workCommentItem(result.comment)} : {comment_count: result.comment_count}]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/discover\/works\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/engagement$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const listing = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          const action = body?.action
          const on = body?.enabled !== false
          if (action === 'like') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/like`, { on })
          else if (action === 'collect') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/collect`, { on })
          else if (action === 'follow') await bs.post('/v1/ot/follows', { handle: listing.creator?.handle, on })
          else throw new Fault(400, 'invalid', 'Provide like/collect/follow and a boolean enabled')
          const fresh = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          return [200, { likes: fresh.likes ?? 0, collections: fresh.collections ?? 0, liked: !!fresh.liked, collected: !!fresh.collected, following: !!fresh.following }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2] && l.listed)
          const listing = row ? await bs.get('/v1/ot/discover/' + seg(row.slug, 'slug')) : null
          const publication = agentPublication(listing)
          return [200, { discover: listing?.listed
            ? { listed: true, slug: row.slug, category: row.category, chat_enabled: row.chat_enabled === true, copy_instructions: Boolean(publication.instructions),
              publish_quick_starts: publication.sharesQuickStarts, updated: unix(row.updated_at) }
            : { listed: false } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const { agent } = await host.call('agents/get', { id: match[2], workspace_id: match[1] })
          if (!agent || agent.archived || agent.native_deleted) throw new Fault(404, 'not_found', '该智能体已归档。')
          if (body?.revision !== undefined && body.revision !== agent.revision) {
            throw new Fault(409, 'agent_changed', '智能体已更新，请刷新后重新预览。')
          }
          if (body?.publish_quick_starts !== undefined && typeof body.publish_quick_starts !== 'boolean') {
            throw new Fault(400, 'invalid', '请选择是否公开快捷开场。')
          }
          const instructions = body?.copy_instructions === true ? agent.instructions : ''
          const shareStarts = body?.publish_quick_starts === true
          const snapshot = instructions || shareStarts ? JSON.stringify({
            version: 1, ...(instructions ? {instructions} : {}),
            ...(shareStarts ? {quick_starts: (agent.quick_starts || []).slice(0, 5)} : {}),
          }) : undefined
          const data = await bs.put('/v1/ot/listings', {
            kind: 'agent', ref: agent.id, slug: body?.slug, title: agent.name, summary: agent.summary,
            category: agent.category, snapshot, chat_enabled: body?.chat_enabled,
          })
          return [200, { discover: { listed: true, slug: data.slug, category: data.category,
            chat_enabled: data.chat_enabled === true, copy_instructions: Boolean(instructions),
            publish_quick_starts: shareStarts, updated: unix(data.updated_at) } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover\/revoke$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2])
          if (row) await bs.del(`/v1/ot/listings/${seg(row.id, 'listing_id')}`)
          return [200, { discover: { listed: false } }]
        })
      },
    },
  ]
}

export function membersV1(host) { return compatHandler(membersRoutes(host)) }
export function invitesV1(host) { return compatHandler(invitesRoutes(host)) }
export function teamsV1(host) { return compatHandler(teamsRoutes(host)) }
export function messengerV1(host, wakeReplies = () => {}) {
  return compatHandler([...messengerRoutes(host, wakeReplies), ...messengerExtraRoutes(host, wakeReplies)])
}
export function discoverV1(host) { return compatHandler(discoverRoutes(host)) }

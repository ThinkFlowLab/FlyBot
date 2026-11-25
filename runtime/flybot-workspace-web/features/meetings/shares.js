import { HEX32, idempotencyKey, pagination, refuse, requireBodyKeys } from '../../featurekit/http.js'
import { qs, sharedBotSocial } from '../../lib/c/bot-social.js'
import { CALL_ID } from './call-source.js'

const MEMBER_ID = /^[A-Za-z0-9._-]{1,80}$/

function shareAudience({conversation_id, call_id}) {
  if (call_id === undefined && typeof conversation_id === 'string' && MEMBER_ID.test(conversation_id)) {
    return {conversation_id}
  }
  if (conversation_id === undefined && typeof call_id === 'string' && CALL_ID.test(call_id)) return {call_id}
  refuse(400, 'invalid', '请选择会话或通话参会人。')
}

async function social(req, workspace, method, suffix, body) {
  const binding = await req.host.call('agents/personal-binding', {})
  const scope = binding?.workspace_id === workspace ? '/v1/ot' : `/v1/ot/workspaces/${workspace}`
  try {
    return await sharedBotSocial(req.host).request(method, scope + suffix, body)
  } catch (error) {
    const status = error?.status
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      refuse(status, String(error.code || 'invalid').replace(/^social\//, ''), error.message)
    }
    refuse(503, 'unavailable', '暂时无法读取或分享会议纪要，请稍后重试。')
  }
}

async function recipients(req, workspace) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  if (req.query.size !== 1) refuse(400, 'invalid', '请选择会话或通话参会人。')
  const audience = shareAudience(Object.fromEntries(req.query))
  return {body:await social(req, workspace, 'GET', '/meeting-share-recipients' + qs(audience))}
}

async function shared(req, workspace) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  if (req.query.has('view')) {
    const limit = req.query.get('limit') ?? '20'
    const cursor = req.query.get('cursor')
    if (!req.ownerUsername || req.query.get('view') !== 'actions' ||
        [...req.query.keys()].some(key => !['view','limit','cursor'].includes(key) || req.query.getAll(key).length !== 1) ||
        !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) || (cursor !== null && !/^[0-9a-f]{32}\.(?:[0-9]|[1-4][0-9])$/.test(cursor))) {
      refuse(400, 'invalid', '无效的收到行动项查询。')
    }
    const data = await social(req, workspace, 'GET', '/meeting-shares' + qs({view:'actions', owner:req.ownerUsername, limit, cursor}))
    const actions = Array.isArray(data.items) ? data.items.map(({share_id, revision, action_index}) =>
      ({share_id, revision, action_index})) : []
    const saved = actions.length ? await req.host.call('memory/sharedMeetingActions', {
      workspace_id:workspace, actions,
    }).catch(() => []) : []
    const key = ({share_id, revision, action_index}) => `${share_id}.${revision}.${action_index}`
    const receipts = new Map((Array.isArray(saved) ? saved : []).map(({id, workspace_id, status, action_revision, ...source}) =>
      [key(source), {id, workspace_id, status, revision:action_revision}]))
    const items = receipts.size ? data.items.map(item => {
      const saved_action = receipts.get(key(item))
      return saved_action ? {...item, saved_action} : item
    }) : data.items
    return {body:{...data, items, workspace_id:workspace, viewer_username:req.ownerUsername}}
  }
  const { limit, cursor } = pagination(req.query, ['sent'])
  const sent = req.query.get('sent') ?? undefined
  if (sent !== undefined && sent !== '1') refuse(400, 'invalid', '无效的分享记录查询。')
  return {body:await social(req, workspace, 'GET', '/meeting-shares' + qs({limit,cursor:cursor || undefined,sent}))}
}

async function receipt(req, workspace, shareId, subpath) {
  if (req.queryString) refuse(400, 'invalid', '无效的纪要分享请求。')
  if (!subpath && req.method === 'GET') {
    const result = await social(req, workspace, 'GET', '/meeting-shares/' + shareId)
    const viewer = req.ownerUsername ? {viewer_username:req.ownerUsername} : {}
    if (!result.received) return {body:{...result, ...viewer}}
    const saved_actions = await req.host.call('memory/sharedMeetingActions', {
      workspace_id:workspace, share_id:shareId, revision:result.meeting.revision,
    }).catch(() => [])
    return {body:{...result, ...viewer, saved_actions}}
  }
  if (subpath === 'revoke' && req.method === 'POST') {
    requireBodyKeys(await req.json(), [])
    return {body:await social(req, workspace, 'POST', '/meeting-shares/' + shareId + '/revoke', {})}
  }
  if (subpath === 'action' && req.method === 'POST') return copyAction(req, workspace, shareId)
  if (subpath === 'discussion' && req.method === 'POST') return prepareDiscussion(req, workspace, shareId)
  refuse(405, 'method', 'Method not supported')
}

export async function receivedDiscussionSource(req, {workspace_id:workspace, share_id:shareId, revision} = {}) {
  if (![workspace,shareId].every(id => typeof id === 'string' && HEX32.test(id)) ||
      !Number.isSafeInteger(revision) || revision < 1) {
    refuse(400, 'invalid', '请选择共享纪要的已保存版本。')
  }
  const {meeting, received} = await social(req, workspace, 'GET', '/meeting-shares/' + shareId)
  if (received !== true || meeting?.id !== shareId || meeting.shared !== true) {
    refuse(404, 'not_found', '这份共享纪要已撤回或你没有查看权限。')
  }
  if (meeting.revision !== revision) refuse(409, 'conflict', '纪要版本不匹配，请重新打开。')
  const title = ('会议讨论 · ' + meeting.title.trim().replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 120).toWellFormed()
  return {title}
}

async function prepareDiscussion(req, workspace, shareId) {
  const {revision} = requireBodyKeys(await req.json(), ['revision'])
  const source = {workspace_id:workspace, share_id:shareId, revision}
  const key = idempotencyKey(req.headers)
  await receivedDiscussionSource(req, source)
  const discussion = await req.host.call('agents/prepareMeetingDiscussion', {source, idempotency_key:key})
  return {body:{discussion, viewer_username:req.ownerUsername}}
}

async function copyAction(req, workspace, shareId) {
  const {revision, index} = requireBodyKeys(await req.json(), ['revision','index'])
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isInteger(index) || index < 0 || index >= 50) {
    refuse(400, 'invalid', '请选择这份共享纪要中的行动项。')
  }
  const {meeting, received} = await social(req, workspace, 'GET', '/meeting-shares/' + shareId)
  if (received !== true || meeting?.id !== shareId || meeting.shared !== true) {
    refuse(404, 'not_found', '找不到这份收到的共享纪要。')
  }
  if (meeting.revision !== revision) refuse(409, 'conflict', '纪要版本不匹配，请重新打开。')
  const item = meeting.action_items?.[index]
  if (!item) refuse(404, 'not_found', '找不到这条行动项。')
  if (item.done !== false) refuse(409, 'action_completed', '这条行动项已完成。')
  const result = await req.host.call('memory/saveSharedMeetingAction', {
    source:{workspace_id:workspace, share_id:shareId, revision, action_index:index}, meeting:meeting.title, item,
  })
  return {status:result.status, body:{...result.body, viewer_username:req.ownerUsername}}
}

async function outgoing(req, workspace, meetingId) {
  if (req.method === 'GET') {
    const {limit,cursor} = pagination(req.query)
    return {body:await social(req, workspace, 'GET', '/meeting-shares' + qs({
      source_id:meetingId,limit,cursor:cursor || undefined,
    }))}
  }
  if (req.method !== 'POST' || req.queryString) refuse(405, 'method', 'Method not supported')
  const snapshot = req.store.get(`SELECT title,started_at,summary,action_items,revision,source_call_id
    FROM meetings WHERE workspace_id=? AND id=?`, workspace, meetingId)
  if (!snapshot) refuse(404, 'not_found', '找不到这份会议纪要。')
  const {revision,conversation_id,call_id,recipient_ids} = requireBodyKeys(await req.json(), ['revision','conversation_id','call_id','recipient_ids'])
  const audience = shareAudience({conversation_id,call_id})
  if (call_id !== undefined && snapshot.source_call_id !== call_id) refuse(404, 'not_found', '这份纪要不属于这场通话。')
  if (!Number.isSafeInteger(revision) || revision < 1
      || !Array.isArray(recipient_ids) || recipient_ids.length < 1 || recipient_ids.length > 50
      || new Set(recipient_ids).size !== recipient_ids.length
      || recipient_ids.some(id => typeof id !== 'string' || !MEMBER_ID.test(id))) {
    refuse(400, 'invalid', '请选择会话、参会人和已保存版本。')
  }
  if (snapshot.revision !== revision) refuse(409, 'conflict', '纪要已更新。请刷新后分享当前保存版本。')
  const {title,started_at,summary} = snapshot
  const action_items = JSON.parse(snapshot.action_items)
  if (!summary.trim() && !action_items.length) refuse(400, 'invalid', '请先保存摘要或行动项。')
  const result = await social(req, workspace, 'POST', '/meeting-shares', {
    title,started_at,summary,revision,action_items,source_id:meetingId,...audience,recipient_ids,client_key:idempotencyKey(req.headers),
  })
  return {status:result.replayed ? 200 : 201,body:{meeting:result.meeting}}
}

export const shareRoutes = [
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/share-recipients$/, handle:recipients},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/shared$/, handle:shared},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/shared\/([0-9a-f]{32})(?:\/(revoke|action|discussion))?$/, handle:receipt},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/([0-9a-f]{32})\/shares$/, handle:outgoing},
]

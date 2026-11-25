// Legacy /v1 routes for /agents/ once the core stream flips that page into
// moved_pages. Homepage, discover and runtime-binding stay on the platform
// (cross-user / provision) and are not matched here.
import { FeatureError, idempotencyKey, requireBodyKeys } from '../../featurekit/http.js'
import { PRIVATE_FILE_BYTES, PRIVATE_FILE_COUNT } from './files.js'
import { PRIVATE_TEXT_LIMIT, textReplyKey, textReplyAttempt } from './private-reply.js'
import { createV1Endpoint } from '../../featurekit/v1.js'
import { CHAT_LANGUAGE_NAMES } from '../settings/settings.js'
import { agentCopyRoutes } from './copy-grants.js'

const HEX = '([0-9a-f]{32})'

function wrap(fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof FeatureError) throw error
      const code = String(error?.code ?? 'error').replace(/^agents\//, '')
      throw new FeatureError(error?.status ?? 500, code === 'not-found' ? 'not_found' : code.replace(/-/g, '_'), error?.message ?? 'Request failed')
    }
  }
}

const publicAgent = (agent) => ({ ...agent, archived: agent.archived ? 1 : 0, homepage: agent.homepage ?? { visibility: 'restricted' } })
const chatAgent = (agent) => publicAgent(agent.archived || agent.native_deleted ? {...agent, quick_starts: []} : agent)
const publicConversation = (row, workspaceId, agentId) => ({
  id: row.id, native_bot_id: row.native_bot_id || null, native_session_id: row.native_session_id || null, workspace_id: workspaceId, agent_id: agentId, title: row.title, created: row.created, updated: row.updated, preview: row.preview ?? '', unread_count: 0,
  archived: row.archived_at != null, archived_at: row.archived_at ?? null, title_edited: row.initial_title != null,
  ...(row.deferred ? {deferred:true} : {}),
  ...(typeof row.memory_recall === 'boolean' ? {memory_recall:row.memory_recall,memory_scope:row.memory_scope} : {}),
  ...(row.studio_source ? {studio_source:JSON.parse(row.studio_source)} : {}),
})
const publicFile = ({title,mime,bytes,resource,sticker}, index, workspaceId, agentId, conversationId, messageId) => ({
  title,mime,bytes,path:`/v1/workspaces/${workspaceId}/agents/${agentId}/conversations/${conversationId}/messages/${messageId}/files/${index}`,
  ...(resource ? {resource} : {}),
  ...(sticker === true ? {sticker:true} : {}),
})
const publicMessage = (row, workspaceId, agentId) => {
  const status = row.status === 'sent' ? 'succeeded' : row.status
  let meta = row.meta
  if (typeof meta === 'string') try { meta = JSON.parse(meta) } catch { meta = {} }
  const attachments = (meta?.files || []).map((file, index) => publicFile(file, index, workspaceId, agentId, row.conversation_id, row.id))
  const canRetryText = textReplyKey(row, meta)
  return {
    ...(attachments.length ? {attachments} : {}),
    ...(row.saved_work ? {saved_work:row.saved_work} : {}),
    ...(meta?.clientKey ? {client_key:meta.clientKey} : {}),
    ...(meta?.memory_refs?.length ? {memory_refs: meta.memory_refs} : {}),
    ...(meta?.memory_profile_workspace === workspaceId ? {memory_profile_workspace: workspaceId} : {}),
    ...(canRetryText ? {attempt: textReplyAttempt(meta), can_retry: status === 'failed', ...(status === 'running' ? {can_stop:true} : {})} : {}),
    id: row.id, conversation_id: row.conversation_id, workspace_id: workspaceId, agent_id: agentId, role: row.role,
    body: row.text ?? row.body ?? '', status, created: row.created, updated: row.updated ?? row.created,
    task_id: null, error_code: meta?.error ? String(meta.error).replace(/^agents\//, '') : row.error_code ?? null, agent_revision: null,
  }
}
const publicPair = (result, workspaceId, agentId) => ({
  message: publicMessage(result.message, workspaceId, agentId),
  reply: publicMessage(result.reply, workspaceId, agentId),
})

export function agentsV1({ endpoints, chatDirectory, host, log }) {
  const call = (name, payload) => endpoints[name](payload)
  async function sendMessage(workspaceId, id, conversationId, body, key) {
    const code = body.chat_language
    const replyLanguage = typeof code === 'string' && Object.hasOwn(CHAT_LANGUAGE_NAMES, code)
      ? CHAT_LANGUAGE_NAMES[code] : body.reply_language
    const payload = {workspace_id:workspaceId,id,agent_id:id,conversation_id:conversationId,
      text:body.body ?? body.text,reply_language:replyLanguage,attachments:body.attachments,
      idempotency_key:key,return_failed:true}
    const project = result => publicPair(result, workspaceId, id)
    const reference = body.artifact_id !== undefined || body.sticker_id !== undefined
    if (reference || (body.accept_pending === true && body.attachments === undefined && key)) {
      const staged = Promise.withResolvers()
      const sending = call('send', {...payload,artifact_id:body.artifact_id,artifact_revision:body.artifact_revision,sticker_id:body.sticker_id,
        onAccepted:result => staged.resolve({status:202,body:project(result)})})
      return Promise.race([staged.promise,sending.then(result => ({status:201,body:project(result)}))])
    }
    return {status:201,body:project(await call('send', payload))}
  }

  const routes = [
    ...agentCopyRoutes(host,endpoints),
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/draft$`), handle: wrap(async (req, workspaceId) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      const {prompt} = requireBodyKeys(await req.json(8192), ['prompt'])
      return {body:await call('draft', {workspace_id:workspaceId,prompt})}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/reply-stop$`),
      handle: wrap(async (req, workspaceId, id, conversationId) => {
        if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
        if (req.query.size) throw new FeatureError(400, 'invalid', 'Invalid reply stop query')
        const {key, attempt} = requireBodyKeys(await req.json(1024), ['key', 'attempt'])
        const result = await call('stopReply', {workspace_id:workspaceId,id,conversation_id:conversationId,key,attempt})
        return {body:publicPair(result, workspaceId, id)}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/reply-progress$`),
      handle: wrap(async (req, workspaceId, id, conversationId) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        const [key, extra] = req.query.getAll('key')
        const [receipt, repeated] = req.query.getAll('receipt')
        const [after, repeatedAfter] = req.query.getAll('after')
        if (!key || extra !== undefined || repeated !== undefined || (receipt !== undefined && receipt !== '1')
            || repeatedAfter !== undefined || (after !== undefined && (receipt || !/^(0|[1-9][0-9]{0,8})$/.test(after)))
            || [...req.query.keys()].some(name => !['key','receipt','after'].includes(name))) {
          throw new FeatureError(400, 'invalid', 'Supply one message send key')
        }
        const {message, reply, ...progress} = await call('replyProgress', {
          workspace_id:workspaceId,id,conversation_id:conversationId,key,receipt:receipt === '1',
          ...(after !== undefined ? {after:Number(after),signal:req.signal} : {}),
        })
        return {body: message ? {...progress,...publicPair({message,reply}, workspaceId, id)} : progress}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/attachments$`),
      handle: wrap(async (req, workspaceId, id, conversationId) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        for (const name of req.query.keys()) {
          if (!['kind','q','cursor','limit'].includes(name) || req.query.getAll(name).length !== 1) {
            throw new FeatureError(400, 'invalid', 'Invalid attachment search parameter')
          }
        }
        const limit = req.query.get('limit') ?? '20'
        if (!/^[0-9]{1,2}$/.test(limit)) throw new FeatureError(400, 'invalid', 'Invalid attachment search limit')
        const result = await call('listAttachments', {workspace_id:workspaceId,id,conversation_id:conversationId,
          kind:req.query.get('kind'),q:req.query.get('q') ?? '',cursor:req.query.get('cursor') ?? '',limit:Number(limit)})
        return {body:{items:result.items.map(({message_id,created_at,slot,...file}) => ({
          message_id,created_at,attachment:{id:`${message_id}:${slot}`,...publicFile(file,slot,workspaceId,id,conversationId,message_id)},
        })),next_cursor:result.next_cursor}}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/files/([0-3])$`),
      handle: wrap(async (req, workspaceId, id, conversationId, messageId, index) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        const file = await call('attachment', {workspace_id:workspaceId,id,conversation_id:conversationId,message_id:messageId,index:Number(index)})
        const inline = /^(image|audio|video)\//.test(file.mime) && req.query.get('download') !== '1'
        return {status:200, raw:file.data, filename:file.title, headers:{'content-type':file.mime}, inline}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/artifact$`), handle: wrap(async (req, workspaceId, id, conversationId, messageId) => {
      if (req.method === 'GET') {
        if (req.query.size) throw new FeatureError(400, 'invalid', 'Invalid saved work request')
        return {body:await call('savedMessageWork', {workspace_id:workspaceId,id,conversation_id:conversationId,message_id:messageId})}
      }
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only GET and POST are supported')
      const body = await req.json()
      const {status, artifact} = await call('saveMessage', {workspace_id: workspaceId, id,
        conversation_id: conversationId, message_id: messageId, title: body.title})
      return {status, body: {artifact}}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/retry$`), handle: wrap(async (req, workspaceId, id, conversationId, replyId) => {
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
      if (req.query.size) throw new FeatureError(400, 'invalid', 'Invalid reply retry query')
      const body = requireBodyKeys(await req.json(1024), ['attempt'])
      const result = await call('retryReply', {workspace_id:workspaceId,id,conversation_id:conversationId,reply_id:replyId,
        attempt:body.attempt,idempotency_key:req.headers.get('idempotency-key')})
      return {status:result.status, body:publicPair(result, workspaceId, id)}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/memory/capture$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
      const body = await req.json()
      return {status:202, body:await call('captureHistory', {workspace_id:workspaceId,id,conversation_id:conversationId,message_ids:body.message_ids})}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'POST') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const body = await req.json(Math.ceil(PRIVATE_FILE_BYTES / 3) * 4 + PRIVATE_FILE_COUNT * 4 + 192*1024)
      return sendMessage(workspaceId, id, conversationId, body, req.headers.get('idempotency-key'))
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method === 'POST') {
        const body = await req.json()
        if (body?.action !== undefined) {
          const {action, title} = requireBodyKeys(body, body.action === 'rename' ? ['action', 'title'] : ['action'])
          const {conversation} = await call('organizeConversation', {workspace_id:workspaceId,id,conversation_id:conversationId,action,title})
          return {body:{conversation:publicConversation(conversation,workspaceId,id)}}
        }
        return {body:await call('setMemoryRecall', {workspace_id:workspaceId,id,conversation_id:conversationId,memory_recall:body.memory_recall,memory_scope:body.memory_scope})}
      }
      if (req.method !== 'GET') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      for (const name of req.query.keys()) {
        if (!['limit', 'before', 'after', 'around', 'snapshot'].includes(name) || req.query.getAll(name).length !== 1) {
          throw new FeatureError(400, 'invalid', 'Invalid history parameters')
        }
      }
      const snapshot = req.query.get('snapshot')
      if (snapshot !== null && snapshot !== '1') throw new FeatureError(400, 'invalid', 'Invalid history snapshot')
      let history
      if (req.query.size) {
        const limit = req.query.get('limit') ?? '50'
        if (!/^(?:[1-9]\d?|100)$/.test(limit)) throw new FeatureError(400, 'invalid', 'Invalid history limit')
        history = {limit: Number(limit), before: req.query.get('before') ?? undefined,
          after: req.query.get('after') ?? undefined, around: req.query.get('around') ?? undefined}
      }
      const {agent, conversation, items, cursor, has_newer} = await call('openConversation', {
        workspace_id: workspaceId, id, conversation_id: conversationId, history, snapshot: snapshot === '1',
      })
      return {body: {conversation: publicConversation(conversation, workspaceId, id), agent: chatAgent(agent),
        items: items.map(row => publicMessage(row, workspaceId, id)), ...(history ? {cursor, has_newer} : {})}}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations$`), handle: wrap(async (req, workspaceId, id) => {
      if (req.method === 'GET') {
        const archived = req.query.get('archived')
        if (archived !== null && (archived !== '1' || req.query.getAll('archived').length !== 1)) {
          throw new FeatureError(400, 'invalid', 'Invalid archived conversation filter')
        }
        const {items,cursor} = await call('conversations', {
          workspace_id:workspaceId,id,archived:archived === '1',
          cursor:req.query.get('cursor') ?? '',limit:Number(req.query.get('limit') ?? 50),
        })
        return { status: 200, body: { items: items.map((row) => publicConversation(row, workspaceId, id)), cursor: cursor ?? null } }
      }
      if (req.method === 'POST') {
        const body = await req.json(192 * 1024)
        let first
        let key = req.headers.get('idempotency-key')
        if (body.first_message !== undefined) {
          requireBodyKeys(body, ['title','memory_recall','memory_scope','first_message'])
          first = requireBodyKeys(body.first_message, ['body','chat_language'])
          if (typeof first.body !== 'string' || !first.body.trim() || first.body.trim().length > PRIVATE_TEXT_LIMIT ||
              (first.chat_language !== undefined && typeof first.chat_language !== 'string')) {
            throw new FeatureError(400, 'invalid', 'Invalid first chat message')
          }
          key = idempotencyKey(req.headers)
        }
        const result = await call('conversation-create', { workspace_id: workspaceId, id, title: body.title,
          memory_recall: body.memory_recall,memory_scope:body.memory_scope,idempotency_key:key,studio_source:body.studio_source })
        const conversation = publicConversation(result.conversation, workspaceId, id)
        if (!first) return {status:result.status ?? 201,body:{conversation}}
        const message = await sendMessage(workspaceId, id, conversation.id, {...first,accept_pending:true}, key)
        return {status:message.status,body:{conversation,...message.body}}
      }
      throw new FeatureError(400, 'invalid', 'Invalid conversation request')
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/archive$`), handle: wrap(async (req, workspaceId, id) => {
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
      const { archived, revision } = requireBodyKeys(await req.json(1024), ['archived', 'revision'])
      if ((archived !== undefined && typeof archived !== 'boolean') ||
          (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) ||
          (archived === false && revision === undefined)) {
        throw new FeatureError(400, 'invalid', 'Provide a valid agent archive state and revision')
      }
      const result = await call('archive', { workspace_id: workspaceId, id, archived, revision })
      return { status: 200, body: { agent: publicAgent(result.agent) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents(?:/${HEX})?$`), handle: wrap(async (req, workspaceId, id) => {
      if (!id && req.method === 'GET') {
        const includeArchived = req.query.get('include_archived') === '1'
        const archivedOnly = req.query.get('archived')
        if (archivedOnly !== null && (archivedOnly !== '1' || req.query.getAll('archived').length !== 1 ||
            req.query.has('include') || req.query.has('include_archived'))) {
          throw new FeatureError(400, 'invalid', 'Invalid agent archive filter')
        }
        const cursor = req.query.get('cursor') || ''
        const limit = Math.min(Math.max(Number(req.query.get('limit') || 20), 1), 100)
        if (req.query.get('include') === 'conversations') {
          const conversationStatus = req.query.get('conversation_status')
          if (conversationStatus !== null && (conversationStatus !== 'archived' || req.query.getAll('conversation_status').length !== 1)) {
            throw new FeatureError(400, 'invalid', 'Invalid conversation status filter')
          }
          if (conversationStatus === 'archived') return {body:await call('archivedConversationDirectory', {
            workspace_id:workspaceId,cursor,limit:Number(req.query.get('limit') ?? 50),
          })}
          const page = await chatDirectory(workspaceId, {includeArchived, cursor, limit: Math.floor(limit) || 0})
          const {items: conversations} = await call('conversationSummaries', {
            workspace_id: workspaceId, agent_ids: page.items.map(item => item.id),
          })
          return {body: {items: page.items.map(chatAgent), cursor: page.cursor, conversations}}
        }
        const active = archivedOnly ? {items: []} : await call('list', { workspace_id: workspaceId })
        const archived = archivedOnly || includeArchived
          ? await call('list', { workspace_id: workspaceId, archived: true }) : {items: []}
        const rows = [...active.items, ...archived.items].sort((a, b) => a.id.localeCompare(b.id))
        const sliced = rows.filter((row) => row.id > cursor).slice(0, limit + 1)
        const items = sliced.slice(0, limit).map(publicAgent)
        return {body: {items, cursor: sliced.length > limit ? sliced[limit - 1].id : null}}
      }
      if (!id && req.method === 'POST') {
        const body = await req.json()
        const result = await call('create', { ...body, workspace_id: workspaceId, idempotency_key: req.headers.get('idempotency-key') })
        return { status: result.status ?? 201, body: { agent: publicAgent(result.agent) } }
      }
      if (id && req.method === 'GET') {
        const { agent } = await call('get', { workspace_id: workspaceId, id })
        return { status: 200, body: { agent: publicAgent(agent) } }
      }
      if (id && req.method === 'POST') {
        const body = await req.json()
        const { revision, ...fields } = body
        const changes = {}
        for (const key of ['name', 'summary', 'instructions', 'category', 'quick_starts', 'portrait']) if (key in fields) changes[key] = fields[key]
        const result = await call('update', { workspace_id: workspaceId, id, revision, changes })
        return { status: 200, body: { agent: publicAgent(result.agent) } }
      }
      throw new FeatureError(400, 'invalid', 'Invalid agent request')
    }) },
  ]
  return createV1Endpoint({ feature: 'agents', routes, context: { log } })
}

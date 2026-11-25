// Search feature (stream B3): message and resource search over this owner's
// own data, executed inside the user's DS-Bot (legacy search.py and
// app.py search_messages/search_resources). Agent-conversation messages come
// from the agents feature, files from the artifacts feature, and notes from the
// memory/meetings/artifacts '<name>/search' endpoints, all via host.call; a
// feature that is not present contributes nothing. Shared (social) messages
// live in Bot Social and are searched there (stream C).
import { CONTROL, HEX32, refuse } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'
import { qs, sharedBotSocial } from '../../lib/c/bot-social.js'

export const QUERY_MAX = 80
export const KINDS = ['all', 'agent', 'social']
const SNIPPET_MAX = 160
const SHARED_ID = /^[A-Za-z0-9._-]{1,80}$/
const SEARCH_CURSOR = /^s1\.[A-Za-z0-9_-]{1,220}$/
const SHARED_CURSOR = /^[0-9]{1,16}:[0-9]{1,16}$/
const casefold = (v) => String(v).toLocaleLowerCase('en-US')
export const snippet = (body) => { const t = String(body ?? '').split(/\s+/).filter(Boolean).join(' '); return t.length <= SNIPPET_MAX ? t : t.slice(0, SNIPPET_MAX) + '…' }
const validQuery = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= QUERY_MAX && !CONTROL.test(v)

async function optional(host, endpoint, payload) {
  try { return await host.call(endpoint, payload) } catch (error) {
    if (error?.code === 'flybot-workspace/not-found') return null
    throw error
  }
}

async function privateHits(host, workspace, options) {
  try {
    return (await host.call('agents/searchMessages', {workspace_id: workspace, ...options})).items
  } catch (error) {
    if (error?.status === 400) refuse(400, 'invalid', 'Invalid search parameters')
    if (error?.code === 'flybot-workspace/not-found') refuse(503, 'unavailable', '智能体消息搜索暂不可用。')
    throw error
  }
}

export function parseMessageQuery(query) {
  const allowed = new Set(['q', 'kind', 'limit', 'cursor', 'conversation_id'])
  if ([...query.keys()].some((k) => !allowed.has(k) || query.getAll(k).length !== 1)) refuse(400, 'invalid', 'Invalid search parameters')
  const text = query.get('q') ?? ''
  const kind = query.get('kind') ?? 'all'
  const limit = query.get('limit') ?? '20'
  const conversationId = query.get('conversation_id')
  const cursor = query.get('cursor') ?? ''
  if (!validQuery(text) || !KINDS.includes(kind) || !/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50
      || (conversationId !== null && !(kind === 'social' ? SHARED_ID : HEX32).test(conversationId))
      || (cursor && !((kind !== 'social' && HEX32.test(cursor))
        || (kind !== 'agent' && (kind === 'social' || !conversationId) && SEARCH_CURSOR.test(cursor))))) {
    refuse(400, 'invalid', 'Invalid search parameters')
  }
  return { text: text.trim(), kind, limit: Number(limit), conversationId, cursor }
}

function decodeSearchCursor(cursor) {
  if (!cursor) return {local: null, shared: null}
  try {
    const value = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'))
    if (Array.isArray(value) && value.length === 2) {
      const [local, shared] = value
      const validLocal = local === null || (Array.isArray(local) && local.length === 2
        && Number.isSafeInteger(local[0]) && local[0] >= 0 && typeof local[1] === 'string' && HEX32.test(local[1]))
      if (validLocal && (shared === null || (typeof shared === 'string' && SHARED_CURSOR.test(shared)
        && shared.split(':').every(part => Number.isSafeInteger(Number(part)))))) return {local, shared}
    }
  } catch {}
  refuse(400, 'invalid', 'Invalid search cursor')
}

function searchSnippet(body, query) {
  const plain = String(body ?? '').replace(/\s+/g, ' ').trim()
  const match = casefold(plain).indexOf(casefold(query))
  const offset = Math.max(0, match - 48)
  return (offset ? '…' : '') + snippet(plain.slice(offset))
}

function privateHit(row, text) {
  return {kind: 'agent', agent_id: row.agent_id, conversation_id: row.conversation_id, message_id: row.id,
    title: row.title || '对话', snippet: searchSnippet(row.body, text), created: row.created,
    ...(row.role === 'user' || row.role === 'assistant' ? {role: row.role} : {}),
    ...(row.role === 'assistant' && row.agent_name ? {agent_name: row.agent_name} : {})}
}

async function sharedHits(host, workspace, {text, limit, conversationId}, before) {
  const binding = await optional(host, 'agents/personal-binding', {})
  const path = binding?.workspace_id === workspace
    ? '/v1/ot/messages/personal-search' : `/v1/ot/workspaces/${workspace}/messages/search`
  const page = await sharedBotSocial(host).get(path + qs({
    q: text, limit: limit + 1, before, conversation_id: conversationId,
  }))
  if (!Array.isArray(page?.items)) throw new Error('Invalid Bot Social search response')
  return page.items
}

async function messages(req, workspace) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const options = parseMessageQuery(req.query)
  const {text, kind, limit, conversationId, cursor} = options
  if (kind === 'agent' || (conversationId && kind !== 'social') || (cursor && HEX32.test(cursor) && kind === 'all')) {
    const page = await privateHits(req.host, workspace, {
      q: text, limit: limit + 1, cursor, conversation_id: conversationId, ascending: true,
    })
    return {body: {items: page.slice(0, limit).map(row => privateHit(row, text)), cursor: page.length > limit ? page[limit - 1].id : null}}
  }

  const position = decodeSearchCursor(cursor)
  const local = kind === 'social' ? Promise.resolve([]) : privateHits(req.host, workspace, {
    q: text, limit: limit + 1, position: position.local,
  })
  const [privateResult, sharedResult] = await Promise.allSettled([
    local,
    sharedHits(req.host, workspace, options, position.shared),
  ])
  if (sharedResult.status === 'rejected' && (kind === 'social' || privateResult.status === 'rejected')) {
    const status = sharedResult.reason?.status
    refuse(status === 404 ? 404 : 503, 'unavailable', '当前无法搜索会话消息。')
  }
  const privateRows = privateResult.status === 'fulfilled' ? privateResult.value : []
  const sharedRows = sharedResult.status === 'fulfilled' ? sharedResult.value : []
  const privateCandidates = privateRows.map(row => ({
    time: row.created * 1000, local: [row.created, row.id], item: privateHit(row, text),
  }))
  const sharedCandidates = sharedRows.map(row => ({
    time: row.created_ms, shared: row.cursor,
    item: {kind: 'social', conversation_id: row.conversation_id, message_id: row.message_id,
      title: row.title, snippet: searchSnippet(row.body, text), created: Math.floor(row.created_ms / 1000)},
  }))
  const candidates = [...privateCandidates, ...sharedCandidates].sort((a, b) => b.time - a.time)
  const items = candidates.slice(0, limit)
  for (const candidate of items) {
    if (candidate.local) position.local = candidate.local
    if (candidate.shared) position.shared = candidate.shared
  }
  const more = candidates.length > limit
  const warning = sharedResult.status === 'rejected' ? '会话消息搜索暂不可用。'
    : privateResult.status === 'rejected' ? '智能体消息搜索暂不可用。' : ''
  return {
    body: {
      items: items.map(candidate => candidate.item),
      cursor: more ? 's1.' + Buffer.from(JSON.stringify([position.local, position.shared])).toString('base64url') : null,
      ...(warning ? { warning } : {}),
    },
  }
}

const URL_RE = /https?:\/\/[^\s<>"']+/

async function resources(req, workspaceId) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const q = req.query
  const allowed = new Set(['q', 'kind', 'cursor', 'limit'])
  if ([...q.keys()].some((k) => !allowed.has(k) || q.getAll(k).length !== 1)) refuse(400, 'invalid', 'Invalid resource search parameters')
  const text = q.get('q') ?? ''
  const kind = q.get('kind') ?? ''
  const cursor = q.get('cursor') ?? ''
  const limit = q.get('limit') ?? '20'
  if (!['files', 'links'].includes(kind) || text.length > 80 || [...text].some((c) => c.charCodeAt(0) < 32)
      || !/^[0-9]{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 || (cursor && !HEX32.test(cursor))) {
    refuse(400, 'invalid', 'Invalid resource search parameters')
  }
  const n = Number(limit)
  if (kind === 'files') {
    const files = await optional(req.host, 'artifacts/files', { workspace_id: workspaceId, q: text, cursor, limit: n + 1 })
    const rows = files?.items ?? []
    return { body: { items: rows.slice(0, n), cursor: rows.length > n ? rows[n - 1].id : null } }
  }
  const rows = await privateHits(req.host, workspaceId, {q: text || 'http', cursor, limit: n + 1, ascending: true, links: true})
  const page = rows.slice(0, n)
  const items = []
  for (const row of page) {
    const match = URL_RE.exec(row.body)
    if (match) items.push({ id: row.id, title: row.title || '消息链接', preview: match[0].replace(/[.,;:!?)\]}，。]+$/, ''), href: match[0].replace(/[.,;:!?)\]}，。]+$/, '') })
  }
  return { body: { items, cursor: rows.length > n ? page.at(-1).id : null } }
}

export default defineFeature({
  name: 'search',
  routes: [
    { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/search\/messages$/, handle: messages },
    { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/search\/resources$/, handle: resources },
  ],
  endpoints: ({ host }) => ({
    // One query across this owner's moved notes: memory, meetings, artifacts.
    async all(payload) {
      const q = String(payload?.q ?? '').trim()
      if (!validQuery(q)) throw Object.assign(new Error('q must be 1–80 characters'), { code: 'search/invalid' })
      const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 50)
      const groups = await Promise.all(['memory', 'meetings', 'artifacts'].map((name) => optional(host, `${name}/search`, { q, limit })))
      const items = groups.flatMap((group) => group?.items ?? []).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, limit)
      return { items }
    },
  }),
})

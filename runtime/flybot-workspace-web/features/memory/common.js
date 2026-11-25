// Shared memory helpers: who the actor is, usernames, snippets, topics.
import { CONTROL, digest, refuse, validLongText } from '../../featurekit/http.js'

export const TITLE_MAX = 80
export const BODY_MAX = 8000
export const SNIPPET_MAX = 160
export const TOPIC_MAX = 40
export const TOPICS_PER_PAGE = 8
export const MAX_PAGES = 100
export const casefold = (value) => String(value).toLocaleLowerCase('en-US')

export function recallWorkspace(payload) {
  const id = payload?.workspace_id
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) refuse(400, 'invalid', 'Workspace ID required')
  return id
}

export function snippet(body) {
  const text = String(body ?? '').split(/\s+/).filter(Boolean).join(' ')
  return text.length <= SNIPPET_MAX ? text : text.slice(0, SNIPPET_MAX) + '…'
}

export const validTitle = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= TITLE_MAX && !CONTROL.test(v)
export const validBody = (v) => validLongText(v, BODY_MAX)
export const titleHash = (title) => digest(casefold(title.trim()))

// The actor for new rows: the platform user id when the manager provides it,
// otherwise the imported account marked is_owner, otherwise a fixed marker.
export function actor(req) {
  if (req.owner !== 'owner') return req.owner
  return req.store.get('SELECT id FROM ot_users WHERE is_owner=1 LIMIT 1')?.id ?? 'owner'
}

export function usernames(store) {
  const map = new Map(store.all('SELECT id, username FROM ot_users').map((row) => [row.id, row.username]))
  const fallback = process.env.FLYBOT_WORKSPACE_OWNER_USERNAME || store.get('SELECT username FROM ot_users WHERE is_owner=1 LIMIT 1')?.username || 'me'
  return (id) => map.get(id) ?? fallback
}

export function normalizeTopics(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > TOPICS_PER_PAGE) return null
  const names = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length < 1 || item.trim().length > TOPIC_MAX || CONTROL.test(item)) return null
    const name = item.trim()
    const key = casefold(name)
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

export function topicsFor(store, ids, workspaceId) {
  const grouped = Object.fromEntries(ids.map((id) => [id, []]))
  if (!ids.length) return grouped
  const placeholders = ids.map(() => '?').join(',')
  const scope = workspaceId ? ' AND workspace_id=?' : ''
  const args = workspaceId ? [...ids, workspaceId] : ids
  const rows = store.all(`SELECT page_id, name FROM memory_page_topics
    WHERE page_id IN (${placeholders})${scope} ORDER BY name COLLATE NOCASE, name`, ...args)
  for (const row of rows) (grouped[row.page_id] ??= []).push(row.name)
  return grouped
}

export function replaceTopics(store, workspaceId, pageId, names) {
  store.run('DELETE FROM memory_page_topics WHERE page_id=?', pageId)
  for (const name of names) store.run('INSERT INTO memory_page_topics(page_id, workspace_id, name, name_hash) VALUES(?,?,?,?)', pageId, workspaceId, name, digest(casefold(name)))
}

export const captureSourceView = row => ({
  agent_id:row.agent_id || undefined, conversation_id:row.conversation_id, message_id:row.source_message_id || row.id,
  ...(row.source_message_id ? {kind:'group', ...(row.origin === 'auto' ? {automatic:true} : {})} : {}),
  title:row.source_title, excerpt:row.excerpt,
})

export function pageView(store, row, { includeBody = true, topics, user = usernames(store) } = {}) {
  const data = {
    id: row.id, workspace_id: row.workspace_id, title: row.title, revision: row.revision,
    created: row.created, updated: row.updated, created_by: user(row.created_by), updated_by: user(row.updated_by),
  }
  if (includeBody) {
    data.body = row.body
    const source = store.get('SELECT * FROM memory_capture_items WHERE workspace_id=? AND page_id=?', row.workspace_id,row.id)
    if (source) data.source = captureSourceView(source)
    else {
      const meeting = store.get('SELECT meeting_id,meeting_revision FROM memory_meeting_sources WHERE workspace_id=? AND page_id=?', row.workspace_id,row.id)
      if (meeting) data.source = {kind:'meeting', ...meeting}
    }
  } else data.preview = snippet(row.body)
  data.topics = topics ?? topicsFor(store, [row.id])[row.id] ?? []
  return data
}

export function pagesView(store, rows, includeBody = false) {
  const grouped = topicsFor(store, rows.map((row) => row.id))
  const user = usernames(store)
  return rows.map((row) => pageView(store, row, { includeBody, topics: grouped[row.id] ?? [], user }))
}

export const loadPage = (store, workspaceId, id) => store.get('SELECT * FROM memory_pages WHERE id=? AND workspace_id=?', id, workspaceId)

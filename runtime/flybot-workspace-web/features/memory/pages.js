import { rank } from '../chat/recall.js'
import { personalMemoryWorkspace, sharedMemoryWorkspaces } from './access.js'
// Memory pages (legacy app.py memory_* + memory.py): page CRUD, bounded
// revision history with restore, Markdown export and the "做梦" duplicate-
// paragraph consolidation, all executed inside the user's DS-Bot.
import { CONTROL, digest, idempotencyKey, newId, pagination, refuse, requireBodyKeys, stableJson } from '../../featurekit/http.js'
import {
  MAX_PAGES, SNIPPET_MAX, TITLE_MAX, TOPIC_MAX, actor, casefold, loadPage, normalizeTopics, pageView, pagesView, recallWorkspace, replaceTopics, snippet,
  titleHash, topicsFor, usernames, validBody, validTitle,
} from './common.js'

export const VERSION_KEEP = 50
const W = '([0-9a-f]{32})'

function recordVersion(store, workspaceId, pageId, revision, title, body, now, userId) {
  store.run('INSERT OR IGNORE INTO memory_page_versions VALUES(?,?,?,?,?,?,?)', pageId, workspaceId, revision, title, body, now, userId)
  store.run('DELETE FROM memory_page_versions WHERE page_id=? AND revision<=?', pageId, revision - VERSION_KEEP)
}

const directoryText = text => String(text ?? '').trim().replace(/\s+/gu, ' ')
const directoryCursor = /^([01])\.(-?\d{1,16})\.([0-9a-f]{32})\.([0-9a-f]{24})$/
const pageReadJoin = ' LEFT JOIN memory_page_reads r ON r.page_id=memory_pages.id AND r.user_id=?'
const pagePinJoin = ' LEFT JOIN memory_page_pins p ON p.page_id=memory_pages.id AND p.user_id=?'
const pinnedRank = '(p.page_id IS NOT NULL)'
const unreadPage = 'memory_pages.revision>COALESCE(r.revision,0)'

function unreadTotal(store, workspace, owner) {
  return store.get(`SELECT COUNT(*) AS count FROM memory_pages ${pageReadJoin} WHERE workspace_id=? AND ${unreadPage}`,
    owner, workspace).count
}

function unfoldedRange(text, from, to) {
  let offset = 0
  let foldedOffset = 0
  let start = 0
  for (const char of text) {
    const next = foldedOffset + casefold(char).length
    if (foldedOffset <= from && from < next) start = offset
    offset += char.length
    if (to <= next) return [start, offset]
    foldedOffset = next
  }
  return [start, text.length]
}

function directoryMatch(kind, source, needle) {
  const text = directoryText(source)
  const folded = casefold(text)
  const from = folded.indexOf(needle)
  if (from < 0) return null
  const to = from + needle.length
  // A lowercase match can expand a character such as İ. Map the match back
  // onto the original UTF-16 offsets when the text length changed.
  const [start, end] = folded.length === text.length ? [from, to] : unfoldedRange(text, from, to)
  if (text.length <= SNIPPET_MAX) return { kind, text, start, end }

  const span = SNIPPET_MAX - 2
  let left = Math.max(0, Math.min(start - 48, text.length - span))
  let right = Math.min(left + span, text.length)
  if (/[\uDC00-\uDFFF]/u.test(text[left])) left += 1
  if (/[\uDC00-\uDFFF]/u.test(text[right])) right -= 1
  const prefix = left ? '…' : ''
  const suffix = right < text.length ? '…' : ''
  return {
    kind, text: prefix + text.slice(left, right) + suffix,
    start: start - left + prefix.length, end: end - left + prefix.length,
  }
}

function searchMatch(row, topics, needle) {
  const title = directoryMatch('title', row.title, needle)
  if (title) return title
  for (const name of topics) {
    const topic = directoryMatch('topic', name, needle)
    if (topic) return topic
  }
  return directoryMatch('body', row.body, needle)
}

function isPinned(store, pageId, owner) {
  return Boolean(store.get('SELECT 1 FROM memory_page_pins WHERE page_id=? AND user_id=?', pageId, owner))
}

function listRecent(req, workspaceId) {
  const args = new URLSearchParams(req.query)
  const cursor = args.get('cursor')
  if (args.getAll('cursor').length > 1) refuse(400, 'invalid', 'Invalid memory cursor')
  args.delete('cursor')
  const { limit } = pagination(args, ['order', 'q', 'topic', 'updated_after', 'unread', 'pinned'])
  const needle = casefold(directoryText(args.get('q')))
  const topic = (args.get('topic') ?? '').trim()
  const after = args.get('updated_after')
  const updatedAfter = after === null ? null : Number(after)
  const unread = args.get('unread')
  const pinned = args.get('pinned')
  if (needle.length > 80 || CONTROL.test(needle) || topic.length > TOPIC_MAX || CONTROL.test(topic) ||
      args.getAll('unread').length > 1 || (unread !== null && unread !== '1') ||
      args.getAll('pinned').length > 1 || (pinned !== null && pinned !== '1') ||
      (after !== null && (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(updatedAfter)))) {
    refuse(400, 'invalid', 'Invalid memory request')
  }

  const topicHash = topic ? digest(casefold(topic)) : null
  const owner = actor(req)
  const scope = digest(stableJson([workspaceId, owner, needle, topicHash, updatedAfter, unread, pinned])).slice(0, 24)
  const parsed = cursor ? directoryCursor.exec(cursor) : null
  const anchor = parsed ? { pinned: Number(parsed[1]), updated: Number(parsed[2]), id: parsed[3] } : null
  if (cursor && (!anchor || !Number.isSafeInteger(anchor.updated) || parsed[4] !== scope)) {
    refuse(400, 'invalid', 'Invalid memory cursor')
  }

  const store = req.store
  let where = 'workspace_id=?'
  const values = [owner, owner, workspaceId]
  if (unread) where += ' AND ' + unreadPage
  if (topicHash) {
    where += ' AND EXISTS (SELECT 1 FROM memory_page_topics t WHERE t.page_id=memory_pages.id AND t.workspace_id=memory_pages.workspace_id AND t.name_hash=?)'
    values.push(topicHash)
  }
  if (updatedAfter !== null) {
    where += ' AND updated>=?'
    values.push(updatedAfter)
  }
  const recent = ' ORDER BY updated DESC,id'
  const scopedRows = onlyPinned => onlyPinned
    ? ' FROM memory_page_pins p CROSS JOIN memory_pages ON p.page_id=memory_pages.id' + pageReadJoin + ' WHERE p.user_id=? AND ' + where
    : ' FROM memory_pages' + pageReadJoin + pagePinJoin + ' WHERE ' + where
  const select = `SELECT memory_pages.*, COALESCE(r.revision,0) AS read_revision, ${pinnedRank} AS pin_rank`
  let total, rows, topics
  const matches = new Map()
  if (needle) {
    const candidates = store.all(select + scopedRows(pinned) + ' ORDER BY pin_rank DESC,updated DESC,id', ...values)
    topics = topicsFor(store, candidates.map(row => row.id), workspaceId)
    rows = []
    total = 0
    for (const row of candidates) {
      const match = searchMatch(row, topics[row.id], needle)
      if (!match) continue
      total += 1
      if (rows.length > limit || (anchor && (row.pin_rank > anchor.pinned ||
          (row.pin_rank === anchor.pinned && (row.updated > anchor.updated ||
            (row.updated === anchor.updated && row.id <= anchor.id)))))) continue
      rows.push(row)
      matches.set(row.id, match)
    }
  } else {
    total = store.get('SELECT COUNT(*) AS count' + scopedRows(pinned), ...values).count
    // Seek within each pin bucket in recent order, without sorting the entire workspace by pin state.
    const readBucket = (rank, size) => {
      const bucket = rank ? '' : ' AND p.page_id IS NULL'
      const seek = anchor?.pinned === rank ? ' AND (updated<? OR (updated=? AND id>?))' : ''
      const boundary = seek ? [anchor.updated, anchor.updated, anchor.id] : []
      return store.all(select + scopedRows(rank) + bucket + seek + recent + ' LIMIT ?', ...values, ...boundary, size)
    }
    rows = anchor?.pinned === 0 ? [] : readBucket(1, limit + 1)
    if (!pinned && rows.length <= limit) rows.push(...readBucket(0, limit + 1 - rows.length))
  }

  const page = rows.slice(0, limit)
  topics ??= topicsFor(store, page.map(row => row.id), workspaceId)
  const user = usernames(store)
  const items = page.map(row => {
    const item = pageView(store, row, { includeBody: false, topics: topics[row.id], user })
    item.unread = row.revision > row.read_revision
    item.pinned = Boolean(row.pin_rank)
    if (needle) item.match = matches.get(row.id)
    return item
  })
  const tail = page.at(-1)
  return { body: { items, cursor: rows.length > limit ? `${tail.pin_rank}.${tail.updated}.${tail.id}.${scope}` : null, total,
    unread_total: unreadTotal(store, workspaceId, owner) } }
}

async function pinPage(req, workspace, pageId) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory request')
  const { pinned } = requireBodyKeys(await req.json(), ['pinned'])
  if (typeof pinned !== 'boolean') refuse(400, 'invalid', 'Invalid memory pin')
  const owner = actor(req)
  return req.store.transaction(store => {
    if (!loadPage(store, workspace, pageId)) refuse(404, 'not_found', 'Memory page not found')
    if (pinned) store.run('INSERT OR IGNORE INTO memory_page_pins(page_id,user_id) VALUES(?,?)', pageId, owner)
    else store.run('DELETE FROM memory_page_pins WHERE page_id=? AND user_id=?', pageId, owner)
    return {body:{page_id:pageId, workspace_id:workspace, pinned}}
  })
}

async function readPage(req, workspace, pageId) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory request')
  const { revision } = requireBodyKeys(await req.json(), ['revision'])
  if (!Number.isInteger(revision) || revision < 1 || revision > 2 ** 31) refuse(400, 'invalid', 'Invalid memory revision')
  const owner = actor(req)
  return req.store.transaction(store => {
    const page = loadPage(store, workspace, pageId)
    if (!page) refuse(404, 'not_found', 'Memory page not found')
    if (revision > page.revision) refuse(409, 'conflict', 'Memory revision is unavailable')
    store.run(`INSERT INTO memory_page_reads(page_id,user_id,revision) VALUES(?,?,?)
      ON CONFLICT(page_id,user_id) DO UPDATE SET revision=MAX(memory_page_reads.revision,excluded.revision)`, pageId, owner, revision)
    const seen = store.get('SELECT revision FROM memory_page_reads WHERE page_id=? AND user_id=?', pageId, owner).revision
    return { body: { page_id: pageId, read_revision: seen, unread_total: unreadTotal(store, workspace, owner) } }
  })
}

async function list(req, workspaceId) {
  if (req.query.get('order') === 'recent') return listRecent(req, workspaceId)
  const { limit, cursor } = pagination(req.query, ['q'])
  const needle = casefold((req.query.get('q') ?? '').trim())
  if (needle.length > 80) refuse(400, 'invalid', 'Invalid memory request')
  let rows = req.store.all('SELECT * FROM memory_pages WHERE workspace_id=? ORDER BY id', workspaceId)
  if (needle) rows = rows.filter((row) => casefold(row.title).includes(needle))
  if (cursor) rows = rows.filter((row) => row.id > cursor)
  rows = rows.slice(0, limit + 1)
  return { body: { items: pagesView(req.store, rows.slice(0, limit)), cursor: rows.length > limit ? rows[limit - 1].id : null } }
}

export function insertPage(req, workspaceId, body, key) {
  const title = body.title
  const content = body.body ?? ''
  const topics = normalizeTopics('topics' in body ? body.topics : [])
  if (!validTitle(title) || !validBody(content) || topics === null) refuse(400, 'invalid', 'Provide a memory page title and body')
  const clean = title.trim()
  const keyHash = digest('memory:' + key)
  const requestHash = digest(stableJson({ title: clean, body: content, topics }))
  const user = actor(req)
  const store = req.store
  const prior = store.get('SELECT * FROM memory_pages WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
  if (prior) {
    if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
    return { status: 200, body: { page: pageView(store, prior) } }
  }
  const hash = titleHash(clean)
  if (store.get('SELECT id FROM memory_pages WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) refuse(409, 'conflict', 'A memory page with this title already exists')
  if (store.get('SELECT COUNT(*) AS n FROM memory_pages WHERE workspace_id=?', workspaceId).n >= MAX_PAGES) refuse(429, 'quota', 'Memory page capacity reached')
  const id = newId()
  store.run('INSERT INTO memory_pages VALUES(?,?,?,?,?,1,?,?,?,?,?,?)', id, workspaceId, clean, hash, content, req.now, req.now, user, user, keyHash, requestHash)
  replaceTopics(store, workspaceId, id, topics)
  recordVersion(store, workspaceId, id, 1, clean, content, req.now, user)
  return { status: 201, body: { page: pageView(store, loadPage(store, workspaceId, id)) } }
}

async function create(req, workspaceId) {
  const body = requireBodyKeys(await req.json(), ['title', 'body', 'topics'])
  const key = idempotencyKey(req.headers)
  return req.store.transaction(() => insertPage(req, workspaceId, body, key))
}

function pageAtRevision(store, workspaceId, pageId, revision) {
  const latest = loadPage(store, workspaceId, pageId)
  if (!latest) refuse(404, 'not_found', 'Memory page not found')
  if (revision !== latest.revision) refuse(409, 'conflict', 'Memory page changed elsewhere; reload and retry', pageView(store, latest))
  return latest
}

async function update(req, workspaceId, pageId) {
  const body = requireBodyKeys(await req.json(), ['revision', 'changes'])
  const { revision, changes } = body
  if (!Number.isInteger(revision) || revision < 0 || revision > 2 ** 31 || !changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
  }
  if (Object.keys(changes).some((key) => !['title', 'body', 'topics'].includes(key))) refuse(400, 'invalid', 'Unknown memory field')
  return req.store.transaction((store) => {
    const row = pageAtRevision(store, workspaceId, pageId, revision)
    return { body: { page: pageView(store, writePage(req, row, changes)) } }
  })
}

// Update a page after the caller has checked its revision in the write transaction.
export function writePage(req, row, changes) {
  const {store, now} = req
  const workspaceId = row.workspace_id
  const title = 'title' in changes ? changes.title : row.title
  const content = 'body' in changes ? changes.body : row.body
  const current = topicsFor(store, [row.id])[row.id] ?? []
  const topics = 'topics' in changes ? normalizeTopics(changes.topics) : current
  if (!validTitle(title) || !validBody(content)) refuse(400, 'invalid', 'Provide a memory page title and body')
  if (topics === null) refuse(400, 'invalid', 'Provide valid memory topics')
  const clean = title.trim()
  if (clean === row.title && content === row.body && stableJson(topics) === stableJson(current)) return row
  const hash = titleHash(clean)
  if (clean !== row.title && store.get('SELECT id FROM memory_pages WHERE workspace_id=? AND title_hash=? AND id!=?', workspaceId, hash, row.id)) {
    refuse(409, 'conflict', 'A memory page with this title already exists')
  }
  if (!store.get('SELECT 1 AS ok FROM memory_page_versions WHERE page_id=? LIMIT 1', row.id)) {
    recordVersion(store, workspaceId, row.id, row.revision, row.title, row.body, row.updated, row.updated_by)
  }
  const user = actor(req)
  const revision = row.revision + 1
  store.run('UPDATE memory_pages SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?', clean, hash, content, revision, now, user, row.id)
  recordVersion(store, workspaceId, row.id, revision, clean, content, now, user)
  if ('topics' in changes) replaceTopics(store, workspaceId, row.id, topics)
  return loadPage(store, workspaceId, row.id)
}

async function dispatch(req, workspaceId, targetId, removing) {
  if (!targetId && req.method === 'GET') return list(req, workspaceId)
  if (!targetId && req.method === 'POST' && !req.queryString) return create(req, workspaceId)
  if (!targetId) refuse(400, 'invalid', 'Invalid memory request')
  const row = loadPage(req.store, workspaceId, targetId)
  if (!row) refuse(404, 'not_found', 'Memory page not found')
  if (removing) {
    if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory request')
    requireBodyKeys(await req.json(), [])
    const removed = pageView(req.store, row, { includeBody: false })
    req.store.run('DELETE FROM memory_pages WHERE id=?', row.id)
    return { body: { removed } }
  }
  if (req.method === 'GET' && !req.queryString) {
    return { body: { page: {...pageView(req.store, row), pinned:isPinned(req.store, row.id, actor(req))} } }
  }
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory request')
  return update(req, workspaceId, row.id)
}

const versionView = (row, user) => ({ revision: row.revision, title: row.title, summary: row.body.trim() ? snippet(row.body) : '（空白正文）', created: row.created, created_by: user(row.created_by) })
const versionBodyView = (row, user) => ({ revision: row.revision, title: row.title, body: row.body, created: row.created, created_by: user(row.created_by) })

async function versions(req, workspaceId, pageId, revision, restoring) {
  const row = loadPage(req.store, workspaceId, pageId)
  if (!row) refuse(404, 'not_found', 'Memory page not found')
  const number = revision ? Number(revision) : null
  const user = usernames(req.store)
  const loadVersion = (n) => req.store.get('SELECT * FROM memory_page_versions WHERE workspace_id=? AND page_id=? AND revision=?', workspaceId, pageId, n)
  if (req.method === 'GET' && !restoring) {
    if (number === null) {
      const cursor = req.query.get('cursor')
      if ([...req.query.keys()].some((name) => name !== 'cursor') || req.query.getAll('cursor').length > 1 ||
          (cursor !== null && !/^[1-9]\d{0,7}$/.test(cursor))) refuse(400, 'invalid', 'Invalid version history cursor')
      const before = cursor === null ? row.revision : Math.min(Number(cursor), row.revision)
      const size = 20
      const rows = req.store.all('SELECT * FROM memory_page_versions WHERE workspace_id=? AND page_id=? AND revision<? ORDER BY revision DESC LIMIT ?', workspaceId, pageId, before, size + 1)
      return { body: { current: row.revision, items: rows.slice(0, size).map((item) => versionView(item, user)),
        cursor: rows.length > size ? rows[size - 1].revision : null } }
    }
    if (req.queryString) refuse(400, 'invalid', 'Invalid version request')
    const seen = loadVersion(number) ?? (number === row.revision
      ? {...row, created:row.updated, created_by:row.updated_by} : null)
    if (!seen) refuse(404, 'not_found', 'Version not found')
    return { body: { version: versionBodyView(seen, user), current: row.revision } }
  }
  if (req.queryString || req.method !== 'POST' || number === null || restoring !== 'restore') refuse(400, 'invalid', 'Invalid version request')
  const body = requireBodyKeys(await req.json(), ['revision'])
  const by = actor(req)
  return req.store.transaction((store) => {
    const row = pageAtRevision(store, workspaceId, pageId, body.revision)
    const seen = loadVersion(number)
    if (!seen) refuse(404, 'not_found', 'Version not found')
    const hash = titleHash(seen.title)
    if (seen.title !== row.title && store.get('SELECT id FROM memory_pages WHERE workspace_id=? AND title_hash=? AND id!=?', workspaceId, hash, row.id)) {
      refuse(409, 'conflict', 'A memory page with this title already exists')
    }
    store.run('UPDATE memory_pages SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?', seen.title, hash, seen.body, row.revision + 1, req.now, by, row.id)
    recordVersion(store, workspaceId, row.id, row.revision + 1, seen.title, seen.body, req.now, by)
    return { body: { page: pageView(store, loadPage(store, workspaceId, row.id)) } }
  })
}

const flat = (value) => String(value ?? '').split(/\s+/).filter(Boolean).join(' ')
const quoted = (value) => '"' + flat(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
export function exportFilename(title) {
  const name = flat(title).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 60).replace(/^[-._]+|[-._]+$/g, '')
  return (name || 'memory') + '.md'
}
export function exportDocument(row, topics) {
  const lines = ['---', 'title: ' + quoted(row.title)]
  const names = (topics ?? []).map(flat).filter(Boolean)
  if (names.length) { lines.push('topics:'); for (const name of names) lines.push('  - ' + quoted(name)) } else lines.push('topics: []')
  lines.push('revision: ' + row.revision)
  lines.push('updated: ' + new Date(row.updated * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  lines.push('---')
  const doc = lines.join('\n') + '\n\n' + row.body
  return doc.endsWith('\n') ? doc : doc + '\n'
}

function exportPage(req, workspaceId, pageId) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  if (req.queryString) refuse(400, 'invalid', 'Invalid memory request')
  const row = loadPage(req.store, workspaceId, pageId)
  if (!row) refuse(404, 'not_found', 'Memory page not found')
  const topics = topicsFor(req.store, [row.id])[row.id] ?? []
  const fallback = exportFilename(row.title)
  return {
    raw: exportDocument(row, topics),
    filename: fallback,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(flat(row.title).slice(0, TITLE_MAX) || 'memory')}.md`,
    },
  }
}

// 做梦: one duplicate-paragraph merge suggestion; accept is the only write.
export const paragraphs = (body) => String(body ?? '').split(/\n[ \t]*\n/).map((part) => part.trim()).filter(Boolean)
const paragraphKey = (text) => casefold(text.replace(/\s+/g, ' ').trim())
export function duplicateParagraph(body) {
  const seen = new Map()
  for (const part of paragraphs(body)) {
    const key = paragraphKey(part)
    if (seen.has(key)) return [seen.get(key), part]
    seen.set(key, part)
  }
  return [null, null]
}
export function mergedBody(body, dropped) {
  const key = paragraphKey(dropped ?? '')
  let kept = false
  const out = []
  for (const part of paragraphs(body)) {
    if (paragraphKey(part) === key) { if (kept) continue; kept = true }
    out.push(part)
  }
  if (!out.length) return body
  return out.join('\n\n') + (body.endsWith('\n') ? '\n' : '')
}
function suggestionView(row) {
  if (!row) return null
  let detail = {}
  let applied = null
  try { detail = JSON.parse(row.payload) } catch { detail = {} }
  try { applied = row.applied ? JSON.parse(row.applied) : null } catch { applied = null }
  return { id: row.id, kind: row.kind, summary: row.summary, status: row.status, created: row.created, decided: row.decided,
    detail: detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {}, applied: applied && typeof applied === 'object' ? applied : null }
}

async function dream(req, workspaceId, pageId, suggestionId) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory request')
  const body = requireBodyKeys(await req.json(), suggestionId ? ['action'] : [])
  if (suggestionId && !['accept', 'ignore'].includes(body.action)) refuse(400, 'invalid', 'Provide accept or ignore')
  return req.store.transaction(store => {
    const row = loadPage(store, workspaceId, pageId)
    if (!row) refuse(404, 'not_found', 'Memory page not found')
    const load = id => store.get('SELECT * FROM memory_suggestions WHERE id=? AND workspace_id=? AND page_id=?', id, workspaceId, pageId)
    if (!suggestionId) {
      const [kept, dropped] = duplicateParagraph(row.body)
      if (kept === null) return { body: { suggestion: null, message: '这一页现在没有可以合并的重复段落，原文未改动。' } }
      const id = newId()
      store.run('INSERT INTO memory_suggestions VALUES(?,?,?,?,?,?,?,?,?,?)', id, workspaceId, pageId, 'merge_paragraphs',
        '这一页有 2 段重复的正文，可以合并成 1 段。', stableJson({ dropped, kept, revision:row.revision }), 'open', req.now, null, null)
      return { body: { suggestion: suggestionView(load(id)) } }
    }
    let suggestion = suggestionView(load(suggestionId))
    if (!suggestion) refuse(404, 'not_found', 'Memory suggestion not found')
    if (suggestion.status === 'open') {
      let applied = null
      if (body.action === 'accept') {
        if (suggestion.detail.revision !== row.revision) refuse(409, 'conflict', '记忆页已更新，请重新生成整理建议。')
        const after = mergedBody(row.body, suggestion.detail.dropped)
        const user = actor(req)
        recordVersion(store, workspaceId, row.id, row.revision, row.title, row.body, row.updated, row.updated_by)
        store.run('UPDATE memory_pages SET body=?, revision=revision+1, updated=?, updated_by=? WHERE id=?', after, req.now, user, row.id)
        recordVersion(store, workspaceId, row.id, row.revision + 1, row.title, after, req.now, user)
        applied = { after_length: after.length, before_length: row.body.length, removed: suggestion.detail.dropped }
      }
      store.run('UPDATE memory_suggestions SET status=?, decided=?, applied=? WHERE id=?',
        body.action === 'accept' ? 'accepted' : 'ignored', req.now, applied ? stableJson(applied) : null, suggestionId)
      suggestion = suggestionView(load(suggestionId))
    }
    return { body: { suggestion, page: pageView(store, loadPage(store, workspaceId, pageId)), applied:suggestion.applied } }
  })
}

export const routes = [
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/pin$`), handle: pinPage },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/read$`), handle: readPage },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/dream(?:/${W})?$`.replace(/\//g, '\\/')), handle: dream },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/export$`.replace(/\//g, '\\/')), handle: exportPage },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/versions(?:/(\\d{1,8})(?:/(restore))?)?$`.replace(/\//g, '\\/')), handle: versions },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory(?:/${W}(?:/(remove))?)?$`.replace(/\//g, '\\/')), handle: dispatch },
]

export function allPages(store, payload) {
  const workspace = recallWorkspace(payload)
  return store.all('SELECT id, workspace_id, revision, title, body, updated FROM memory_pages WHERE workspace_id=? ORDER BY updated DESC, id LIMIT 500', workspace)
}

export async function recallAcrossWorkspaces(store, host, payload) {
  const workspace = recallWorkspace(payload)
  const query = payload?.query
  if (typeof query !== 'string' || query.length > 4000 || !query.trim()) return []
  const [personal, teams] = await Promise.all([
    personalMemoryWorkspace(host),
    sharedMemoryWorkspaces(host),
  ])
  const workspaces = new Map(teams.map(team => [team.id, team.name]))
  if (personal) workspaces.set(personal,'个人工作区')
  if (!workspaces.has(workspace)) return []
  const ids = JSON.stringify([...workspaces.keys()])
  const pages = store.all(`SELECT id,workspace_id,revision,title,body FROM memory_pages
    WHERE workspace_id IN (SELECT value FROM json_each(?))`,ids)
  const actions = store.all(`SELECT a.id,a.workspace_id,a.revision,a.title,a.notes,a.status,a.due_at,p.title AS linked_title
    FROM memory_actions a LEFT JOIN memory_pages p ON p.id=a.memory_page_id AND p.workspace_id=a.workspace_id
    WHERE a.workspace_id IN (SELECT value FROM json_each(?))`,ids)
  for (const action of actions) {
    const due = action.due_at === null ? '' : ' · 截止 ' + new Date(action.due_at*1000).toISOString().slice(0,10)
    const linked = action.linked_title ? ' · 关联记忆 ' + action.linked_title : ''
    const facts = '行动项 / Action item · ' + (action.status === 'done' ? '已完成 / done' : '待完成 / open') + due + linked
    pages.push({...action,kind:'action',facts,body:[action.notes,facts].filter(Boolean).join('\n')})
  }
  for (const page of pages) page.workspace_name = workspaces.get(page.workspace_id)
  return rank(query,pages,{limit:6})
}

export async function search(store, host, needle, limit) {
  const key = casefold(needle)
  const candidates = store.all('SELECT id, workspace_id, title, body, updated FROM memory_pages ORDER BY updated DESC, id')
    .filter(row => casefold(row.title).includes(key) || casefold(row.body).includes(key))
  if (!candidates.length) return []
  const personal = await personalMemoryWorkspace(host)
  const scopes = candidates.some(row => row.workspace_id !== personal) ? await sharedMemoryWorkspaces(host) : []
  const allowed = new Set([personal, ...scopes.map(team => team.id)])
  return candidates.filter(row => allowed.has(row.workspace_id))
    .slice(0, limit).map((row) => ({ kind: 'memory', id: row.id, workspace_id: row.workspace_id, title: row.title, snippet: snippet(row.body), updated: row.updated, href: `/memory?workspace=${row.workspace_id}&page=${row.id}` }))
}

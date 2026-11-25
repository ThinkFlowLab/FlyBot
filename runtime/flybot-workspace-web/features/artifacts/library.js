// Works-library operations (legacy artifacts.py + app.py artifact_*), executed
// inside this user's DS-Bot. Share records live here; the public /share/<token>
// page is rendered by the dedicated Bot Social from a published snapshot.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { digest, HEX32, newId, nowSeconds, refuse, stableJson } from '../../featurekit/http.js'
import { GLB_MIME, MAX_GLB_BYTES } from '../../lib/glb.js'
import { catalogContentMatch, catalogMatch } from './catalog-search.js'
import {
  emptyBoard, emptyDashboard, emptySlides, FILE_MIME, MAX_MEDIA_OBJECT_BYTES, MEDIA_MIMES, preview, PREFIX_LEN, publicKind, ROW_JOINS, ROW_SELECT, SHARE_CSP, sourceView,
  SLIDES_SCHEMA, TITLE_MAX, titleHash, TOKEN, validBody, validTitle,
} from './model.js'
import { attachMedia, mediaDigests, readMediaBytes, unlinkMedia, writeMedia } from './media.js'
import {
  applyBoardOperations, boardJson, dashboardJson, decodeBoard, decodeDashboard, decodeSlides, decodeStructured,
  normalizeBoard, normalizeDashboard, normalizeSlides, slidesJson,
} from './structured.js'
import { cleanFilename, exportFilename, exportHeaders, renderBoardSvg, renderDashboardPage, renderPage, renderSlidesPage, renderWebsitePage, savedMediaFilename, sniffMime } from './render.js'
import { exportOffice } from './office.js'
import {decodeWorkbook,emptyWorkbook,normalizeWorkbook} from './workbook.js'
export const PER_WORKSPACE = 50
export const MAX_VERSIONS = 100
export const MAX_SHARES = 10
export const KEY = /^[A-Za-z0-9_-]{16,64}$/
const OFFICE = new Set(['docx', 'pdf', 'xlsx', 'pptx'])

export function usernames(store) {
  const map = new Map(store.all('SELECT id, username FROM ot_users').map((row) => [row.id, row.username]))
  const fallback = process.env.FLYBOT_WORKSPACE_OWNER_USERNAME || store.get('SELECT username FROM ot_users WHERE is_owner=1 LIMIT 1')?.username || 'me'
  return (id) => map.get(id) ?? fallback
}

const named = (row, user) => ({
  ...row, created_by_username: user(row.created_by), updated_by_username: user(row.updated_by),
})

export const canEdit = (role, userId, row) => role === 'owner' || role === 'admin' || row.created_by === userId

export function load(store, workspaceId, id) {
  const row = store.get(ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?', id, workspaceId)
  return row && named(row, usernames(store))
}

export function documentTree(store, workspaceId) {
  return store.all(`SELECT a.id, a.title, rel.parent_id ${ROW_JOINS}
    LEFT JOIN artifact_document_parents rel ON rel.artifact_id=a.id
    WHERE a.workspace_id=? AND m.render IS NULL AND md.artifact_id IS NULL AND b.artifact_id IS NULL
      AND sl.artifact_id IS NULL AND d.artifact_id IS NULL AND x.artifact_id IS NULL
    ORDER BY a.updated DESC, a.id`, workspaceId)
}

export function moveDocument(store, workspaceId, id, parentId, expectedParentId) {
  return store.transaction(() => {
    const documents = new Map(documentTree(store, workspaceId).map(row => [row.id, row]))
    const document = documents.get(id)
    const parent = documents.get(parentId)
    if (!document || (parentId !== null && !parent)) refuse(404, 'not_found', '找不到文档或目标位置。')
    if (document.parent_id !== expectedParentId && document.parent_id !== parentId) {
      refuse(409, 'document_tree_changed', '文档位置已变化，请刷新后再试。')
    }
    const visited = new Set([id])
    for (let ancestor = parent; ancestor; ancestor = documents.get(ancestor.parent_id)) {
      if (visited.has(ancestor.id)) refuse(409, 'document_tree_cycle', '不能移动到文档自身或其子文档下。')
      visited.add(ancestor.id)
    }
    if (document.parent_id !== parentId) {
      if (parentId === null) store.run('DELETE FROM artifact_document_parents WHERE artifact_id=?', id)
      else store.run(`INSERT INTO artifact_document_parents VALUES(?,?)
        ON CONFLICT(artifact_id) DO UPDATE SET parent_id=excluded.parent_id`, id, parentId)
    }
    return {id, parent: parent ? {id: parent.id, title: parent.title} : null}
  })
}

export function detailView(store, row) {
  const artifact = view(row)
  if (artifact.kind !== 'document') return artifact
  const parent = store.get(`SELECT a.id, a.title FROM artifact_document_parents rel
    JOIN artifacts a ON a.id=rel.parent_id WHERE rel.artifact_id=? AND a.workspace_id=?`, row.id, row.workspace_id)
  return parent ? {...artifact, parent} : artifact
}

function matchesFileTypes(row, kind, types) {
  if (types.has('messages') && row.chat_message_id) return true
  if (kind === 'document' && row.chat_message_id) return false
  if (kind !== 'media') return types.has(kind)
  if (row.media_mime === GLB_MIME) return types.has('model3d')
  if (row.media_mime === FILE_MIME) return types.has('file')
  return types.has(row.media_mime.split('/', 1)[0])
}

function filteredPage(store, { boundary, bindings, order, metadata }, limit, filters, user) {
  const { needle, scope, kind, owner, ownerUsername, favorites, types, creators, sessions } = filters
  const columns = metadata
    ? `SELECT a.id, a.title, a.created_by, u.username, u.is_owner, m.render, md.mime AS media_mime, md.filename AS media_filename,
       b.board <> '' AS board_json, sl.deck <> '' AS slides_json, d.dashboard <> '' AS dashboard_json,
       x.workbook <> '' AS spreadsheet_json, s.source_kind, cs.message_id AS chat_message_id, cs.conversation_id
       ${ROW_JOINS} LEFT JOIN ot_users u ON u.id=a.created_by `
    : `SELECT a.id, a.title, md.mime AS media_mime, md.filename AS media_filename
       FROM artifacts a LEFT JOIN artifact_media md ON md.artifact_id=a.id `
  const candidates = store.all(columns + boundary + order, ...bindings)
  const matches = new Map()
  const ids = []
  for (const row of candidates) {
    if (scope === 'favorites' && !favorites.has(row.id)) continue
    if (scope === 'mine' && row.created_by !== owner && !row.is_owner &&
        (!ownerUsername || row.username !== ownerUsername)) continue
    if (scope === 'memory' && (row.chat_message_id || row.source_kind !== 'agent_task')) continue
    const artifactKind = kind !== 'all' || types.size ? publicKind(row) : null
    if (kind === 'messages' ? !row.chat_message_id : kind !== 'all' && artifactKind !== kind) continue
    if (types.size && !matchesFileTypes(row, artifactKind, types)) continue
    if (creators.size && !creators.has(user(row.created_by))) continue
    if (sessions.size && !sessions.has(row.conversation_id)) continue
    if (needle) {
      let match = catalogMatch('title', row.title, needle) || catalogMatch('filename', row.media_filename, needle)
      if (!match && !row.media_mime) {
        // Decode content only for candidates that survive the catalog filters
        // and do not already match their cheap title or filename projection.
        const content = store.get(ROW_SELECT + 'WHERE a.workspace_id=? AND a.id=?', bindings[0], row.id)
        match = catalogContentMatch(content, needle)
      }
      if (!match) continue
      matches.set(row.id, match)
    }
    ids.push(row.id)
    if (ids.length >= limit) break
  }
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return store.all(ROW_SELECT + `WHERE a.workspace_id=? AND a.id IN (${placeholders})` + order, bindings[0], ...ids)
    .map(row => needle ? { ...row, match: matches.get(row.id) } : row)
}

export function listing(store, workspaceId, cursor, limit, filters) {
  let boundary = 'WHERE a.workspace_id=?'
  const bindings = [workspaceId]
  const order = filters.recent ? ' ORDER BY a.updated DESC, a.id' : ' ORDER BY a.id'
  if (cursor && filters.recent) {
    const anchor = store.get('SELECT updated FROM artifacts WHERE workspace_id=? AND id=?', workspaceId, cursor)
    if (!anchor) return []
    boundary += ' AND (a.updated<? OR (a.updated=? AND a.id>?))'
    bindings.push(anchor.updated, anchor.updated, cursor)
  } else if (cursor) {
    boundary += ' AND a.id>?'
    bindings.push(cursor)
  }
  if (filters.since !== null) {
    boundary += ' AND a.updated>=?'
    bindings.push(filters.since)
  }
  if (filters.before !== null) {
    boundary += ' AND a.updated<?'
    bindings.push(filters.before)
  }
  if (filters.scope === 'automation') boundary += " AND s.source_kind='automation_run'"
  const metadata = ['favorites', 'mine', 'memory'].includes(filters.scope) || filters.kind !== 'all' ||
    filters.types.size || filters.creators.size || filters.sessions.size
  const names = filters.creators.size ? usernames(store) : null
  const rows = filters.needle || metadata
    ? filteredPage(store, {boundary, bindings, order, metadata: metadata || filters.scope === 'automation'}, limit, filters, names)
    : store.all(ROW_SELECT + boundary + order + ' LIMIT ?', ...bindings, limit)
  if (!rows.length) return rows
  const user = names || usernames(store)
  return rows.map((row) => named(row, user))
}

export function catalogFacets(store, workspaceId) {
  const user = usernames(store)
  const authors = store.all('SELECT DISTINCT created_by FROM artifacts WHERE workspace_id=?', workspaceId)
  const creators = [...new Set(authors.map(row => user(row.created_by)))].sort()
  const sources = store.all(`SELECT cs.conversation_id, cs.conversation_title FROM artifact_chat_sources cs
    JOIN artifacts a ON a.id=cs.artifact_id WHERE a.workspace_id=? ORDER BY a.updated DESC, a.id`, workspaceId)
  const sessions = new Map()
  for (const { conversation_id: id, conversation_title: title } of sources) {
    if (id && !sessions.has(id)) sessions.set(id, {id, label: title?.trim() || '对话'})
  }
  return { creators, sessions: [...sessions.values()] }
}

export function view(row, includeBody = true, { favorited } = {}) {
  const user = (field) => row[field + '_username'] ?? row[field]
  const data = {
    id: row.id, workspace_id: row.workspace_id, title: row.title, kind: publicKind(row),
    revision: row.revision, created: row.created, updated: row.updated,
    created_by: user('created_by'), updated_by: user('updated_by'),
  }
  const source = sourceView(row)
  if (source) data.source = source
  const kind = data.kind
  if (kind === 'media') data.media = { mime: row.media_mime, bytes: row.media_bytes, filename: row.media_filename }
  else if (kind === 'whiteboard' && includeBody) data.board = decodeBoard(row.board_json) ?? emptyBoard()
  else if (kind === 'slides' && includeBody) data.slides = decodeSlides(row.slides_json) ?? emptySlides()
  else if (kind === 'dashboard' && includeBody) data.dashboard = decodeDashboard(row.dashboard_json) ?? emptyDashboard()
  else if (kind === 'spreadsheet' && includeBody) data.spreadsheet = decodeWorkbook(row.spreadsheet_json) ?? emptyWorkbook()
  else if (includeBody && (kind === 'document' || kind === 'website')) data.body = row.body
  if (!includeBody) {
    const thumb = preview(row, { decodeBoard, decodeSlides, decodeDashboard })
    if (thumb != null) data.preview = thumb
    if (row.match) data.match = row.match
  }
  if (favorited !== undefined) data.favorited = favorited
  return data
}

export function setRender(store, artifactId, kind) {
  store.run('DELETE FROM artifact_meta WHERE artifact_id=?', artifactId)
  if (kind === 'website') store.run('INSERT INTO artifact_meta VALUES(?,?)', artifactId, 'website')
}

export function attachBoard(store, artifactId, board) {
  const payload = boardJson(board)
  if (payload == null) return false
  store.run('DELETE FROM artifact_boards WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_boards VALUES(?,?)', artifactId, payload)
  return true
}
export function attachSlides(store, artifactId, deck) {
  const payload = slidesJson(deck)
  if (payload == null) return false
  store.run('DELETE FROM artifact_slides WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_slides VALUES(?,?)', artifactId, payload)
  return true
}
export function attachDashboard(store, artifactId, dashboard) {
  const payload = dashboardJson(dashboard)
  if (payload == null) return false
  store.run('DELETE FROM artifact_dashboards WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_dashboards VALUES(?,?)', artifactId, payload)
  return true
}

function attachWorkbook(store,id,workbook) {
  store.run(`INSERT INTO artifact_spreadsheets VALUES(?,?) ON CONFLICT(artifact_id)
    DO UPDATE SET workbook=excluded.workbook`,id,JSON.stringify(workbook))
}

function versionSnapshot(row) {
  const kind = publicKind(row)
  const storedKind = ['slides','dashboard','spreadsheet'].includes(kind) ? 'document' : kind
  let body = ''
  if (kind === 'slides') body = row.slides_json || slidesJson(emptySlides()) || ''
  else if (kind === 'dashboard') body = row.dashboard_json || dashboardJson(emptyDashboard()) || ''
  else if (kind === 'spreadsheet') body = row.spreadsheet_json
  else if (kind === 'document' || kind === 'website') body = row.body ?? ''
  return {kind:storedKind,body,board:kind === 'whiteboard' ? row.board_json : null,
    mime:kind === 'media' ? row.media_mime : null,byte_count:kind === 'media' ? row.media_bytes : null,
    sha256:kind === 'media' ? row.media_sha256 : null,filename:kind === 'media' ? row.media_filename : null}
}

export function recordVersion(store, row) {
  const snapshot = versionSnapshot(row)
  store.run(
    'INSERT OR IGNORE INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.revision, row.title, snapshot.kind, snapshot.body,
    snapshot.board, snapshot.mime, snapshot.byte_count, snapshot.sha256, snapshot.filename,
    row.updated, row.updated_by,
  )
}

export function saved(store, workspaceId, artifactId, status) {
  const row = load(store, workspaceId, artifactId)
  recordVersion(store, row)
  return { status, body: { artifact: detailView(store, row) } }
}

export function uniqueTitle(store, workspaceId, title, suffix) {
  let candidate = title
  if (!validTitle(candidate)) candidate = (title.slice(0, TITLE_MAX - 9) + '-' + suffix.slice(0, 8)).replace(/^-+|-+$/g, '')
  if (!store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, titleHash(candidate))) return candidate
  let fallback = (title.slice(0, TITLE_MAX - 9) + '-' + suffix.slice(0, 8)).trim()
  if (!validTitle(fallback)) fallback = suffix.slice(0, TITLE_MAX)
  return fallback
}

export function versionView(row, includeBody = true, user = (id) => id) {
  let kind = row.kind
  const data = { revision: row.revision, title: row.title, kind, created: row.created, created_by: row.created_by_username ?? user(row.created_by) }
  if (Number.isSafeInteger(row.restored_from)) data.restored_from = row.restored_from
  if (kind === 'media') {
    data.media = { mime: row.mime, bytes: row.byte_count, filename: row.filename }
  } else {
    const [structuredKind, structured] = kind === 'document' ? decodeStructured(row.body) : [null, null]
    if (structured) {
      data.kind = structuredKind
      if (includeBody) data[structuredKind] = structured
    } else if (includeBody) {
      if (kind === 'whiteboard') data.board = decodeBoard(row.board) ?? emptyBoard()
      else data.body = row.body
    }
  }
  return data
}

export function sameAsVersion(row, snapshot) {
  if (row.title !== snapshot.title) return false
  const currentKind = publicKind(row)
  if (['slides','dashboard','spreadsheet'].includes(currentKind)) {
    const [structuredKind, structured] = snapshot.kind === 'document' ? decodeStructured(snapshot.body) : [null, null]
    if (structuredKind !== currentKind) return false
    if (currentKind === 'spreadsheet') return row.spreadsheet_json === JSON.stringify(structured)
    return currentKind === 'slides' ? row.slides_json === slidesJson(structured) : row.dashboard_json === dashboardJson(structured)
  }
  if (currentKind !== snapshot.kind) return false
  if (snapshot.kind === 'media') return row.media_sha256 === snapshot.sha256 && row.media_filename === snapshot.filename
  if (snapshot.kind === 'whiteboard') return row.board_json === snapshot.board
  return row.body === snapshot.body
}

function attachKind(store, id, kind, { board, slides, dashboard } = {}) {
  setRender(store, id, kind)
  if (board && !attachBoard(store, id, board)) refuse(400, 'invalid', 'Provide a whiteboard title and board')
  if (slides && !attachSlides(store, id, slides)) refuse(400, 'invalid', 'Provide valid slide content')
  if (dashboard && !attachDashboard(store, id, dashboard)) refuse(400, 'invalid', 'Provide valid dashboard content')
}

function attachSource(store, id, workspaceId, now, source) {
  if (!source) return
  if (source.kind === 'team_run_step') {
    attachTeamRunSource(store, id, workspaceId, source)
    return
  }
  if (source.kind === 'agent_message') {
    store.run('INSERT INTO artifact_chat_sources(artifact_id, workspace_id, conversation_id, message_id, agent_id, created, conversation_title) VALUES(?,?,?,?,?,?,?)',
      id, workspaceId, source.conversation_id, source.id ?? source.message_id, source.agent_id ?? null, now, source.conversation_title ?? null)
    return
  }
  if (source.kind === 'automation_run' || source.kind === 'agent_task') {
    store.run('INSERT INTO artifact_sources VALUES(?,?,?,?,?,?,?,?)',
      id, workspaceId, source.kind, source.id, source.automation_id ?? null, source.automation_title ?? null, source.task_kind ?? null, now)
  }
}

export function attachTeamRunSource(store, artifactId, workspaceId, source) {
  store.run('INSERT INTO artifact_team_run_sources VALUES(?,?,?,?,?)', artifactId, workspaceId, source.id, source.position, source.run_title)
}

function existingSource(store, workspaceId, source) {
  if (!source) return null
  if (source.kind === 'team_run_step') {
    const row = store.get('SELECT artifact_id FROM artifact_team_run_sources WHERE workspace_id=? AND run_id=? AND position=?',
      workspaceId, source.id, source.position)
    return row ? load(store, workspaceId, row.artifact_id) : null
  }
  if (source.kind === 'agent_message') {
    const row = store.get('SELECT artifact_id FROM artifact_chat_sources WHERE workspace_id=? AND message_id=?', workspaceId, source.id ?? source.message_id)
    return row ? load(store, workspaceId, row.artifact_id) : null
  }
  if (source.kind === 'automation_run' || source.kind === 'agent_task') {
    const row = store.get('SELECT artifact_id FROM artifact_sources WHERE workspace_id=? AND source_kind=? AND source_id=?', workspaceId, source.kind, source.id)
    return row ? load(store, workspaceId, row.artifact_id) : null
  }
  return null
}

export function createArtifact(ctx, workspaceId, input, key, {reuseChatSource = false, reuseSource = false, receiptHash} = {}) {
  const { store, owner, featureDir } = ctx
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
  const title = input.title
  const content = input.body ?? ''
  const kind = input.kind ?? 'document'
  const source = input.source
  const parentId = input.parent_id
  if (parentId !== undefined && (kind !== 'document' || typeof parentId !== 'string' || !HEX32.test(parentId))) {
    refuse(400, 'invalid', '请选择有效的上级文档。')
  }
  if (source?.kind === 'agent_message' && source.agent_id && !reuseChatSource) {
    refuse(403, 'forbidden', 'Save private replies from their conversation')
  }
  if (source?.kind === 'team_run_step' && !reuseSource) refuse(403, 'forbidden', 'Save results from their team run')
  let board, slides, dashboard, spreadsheet
  if (kind === 'media') refuse(400, 'invalid', 'Upload media as multipart form data')
  if (kind === 'whiteboard') {
    board = normalizeBoard(input.board || emptyBoard())
    if (!board || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a whiteboard title and board')
  } else if (kind === 'slides') {
    slides = normalizeSlides(input.slides || emptySlides())
    if (!slides || !slides.slides.length || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a slide title and at least one slide')
  } else if (kind === 'dashboard') {
    dashboard = normalizeDashboard(input.dashboard || emptyDashboard())
    if (!dashboard || !dashboard.widgets.length || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a dashboard title and at least one widget')
  } else if (kind === 'spreadsheet') {
    spreadsheet = normalizeWorkbook(input.spreadsheet ?? emptyWorkbook())
    if (!spreadsheet || !validTitle(title) || content) refuse(400,'invalid','请填写有效的表格标题和工作表。')
  } else if (kind !== 'document' && kind !== 'website' || !validTitle(title) || !validBody(content)) {
    refuse(400, 'invalid', 'Provide a document or website title and body')
  }
  const trimmed = title.trim()
  const bodyText = validBody(content) ? content : ''
  if (!KEY.test(key ?? '')) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const payload = { title: trimmed, body: bodyText, kind }
  if (parentId) payload.parent_id = parentId
  if (board) payload.board = board
  if (slides) payload.slides = slides
  if (dashboard) payload.dashboard = dashboard
  if (spreadsheet) payload.spreadsheet = spreadsheet
  const keyHash = digest('artifact:' + key)
  const requestHash = receiptHash ?? digest(stableJson(payload))
  return store.transaction(() => {
    const already = existingSource(store, workspaceId, source)
    // Saved source snapshots survive later edits and title changes.
    if (already && (reuseChatSource || reuseSource)) return { status: 200, body: { artifact: view(already) } }
    const prior = store.get('SELECT * FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      const row = load(store, workspaceId, prior.id)
      if (source?.kind === 'team_run_step' && !sourceView(row) && publicKind(row) === 'document' &&
          store.get('SELECT body FROM artifact_versions WHERE artifact_id=? AND revision=1', row.id)?.body === bodyText) {
        attachTeamRunSource(store, row.id, workspaceId, source)
        return {status:200, body:{artifact:view(load(store, workspaceId, row.id))}}
      }
      // Older Bot Social saves used the same key without recording the source.
      if (reuseChatSource && !source.agent_id && !row.chat_message_id && !row.source_kind && publicKind(row) === 'document') {
        const first = store.get('SELECT body FROM artifact_versions WHERE artifact_id=? AND revision=1', row.id)
        if (first?.body === bodyText) {
          attachSource(store, row.id, workspaceId, row.created, source)
          return { status: 200, body: { artifact: view(load(store, workspaceId, row.id)) } }
        }
      }
      if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { status: 200, body: { artifact: detailView(store, row) } }
    }
    if (already) return { status: 200, body: { artifact: view(already) } }
    if (parentId) {
      const parent = load(store, workspaceId, parentId)
      if (!parent || publicKind(parent) !== 'document') refuse(404, 'document_parent_missing', '上级文档已不可用。')
    }
    const hash = titleHash(trimmed)
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429, 'quota', 'Artifact capacity reached')
    }
    const id = newId()
    const now = nowSeconds()
    store.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id, workspaceId, trimmed, hash, 'document', bodyText, now, now, owner, owner, keyHash, requestHash)
    attachKind(store, id, kind, { board, slides, dashboard })
    if (spreadsheet) attachWorkbook(store,id,spreadsheet)
    if (parentId) store.run('INSERT INTO artifact_document_parents VALUES(?,?)', id, parentId)
    attachSource(store, id, workspaceId, now, source)
    void featureDir
    return saved(store, workspaceId, id, 201)
  })
}

export function remixPublicWork(ctx, {workspace_id:workspace,slug,revision,title,idempotency_key:key,source} = {}) {
  if (typeof workspace !== 'string' || !HEX32.test(workspace) || typeof slug !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug) || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)
      || !validTitle(title) || /[\x00-\x1f\x7f]/.test(title) || typeof key !== 'string' || !KEY.test(key)) {
    refuse(400,'invalid','请填写副本名称并选择公开作品的版本。')
  }
  const trimmed = title.trim()
  const receiptHash = digest(stableJson({public_work:slug,revision,title:trimmed}))
  const prior = ctx.store.get('SELECT id,request_hash FROM artifacts WHERE workspace_id=? AND key_hash=?',workspace,digest('artifact:' + key))
  if (prior) {
    if (prior.request_hash !== receiptHash) refuse(409,'conflict','这次请求已用于创建其他作品。')
    return {status:200,body:{artifact:view(load(ctx.store,workspace,prior.id))}}
  }
  if (ctx.store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?',workspace,titleHash(trimmed))) {
    refuse(409,'title_conflict','已存在同名作品，请换一个名称。')
  }
  if (!source) return null
  if (source.kind === 'media') {
    const {mime, filename, bytes} = source
    const maximum = mime === GLB_MIME ? MAX_GLB_BYTES : MAX_MEDIA_OBJECT_BYTES
    if (!MEDIA_MIMES.has(mime) || typeof filename !== 'string' || !filename.trim() ||
        !Number.isSafeInteger(bytes) || bytes < 12 || bytes > maximum || typeof source.data !== 'string' ||
        source.data.length !== Math.ceil(bytes / 3) * 4) refuse(400,'invalid','这个公开文件的格式或大小不受支持。')
    const data = Buffer.from(source.data,'base64')
    if (data.length !== bytes || data.toString('base64') !== source.data || sniffMime(data) !== mime) {
      refuse(400,'invalid','这个公开文件的内容与文件类型不符。')
    }
    return createMedia(ctx,workspace,{title:trimmed,mime,filename,data,key},{receiptHash})
  }
  if (source.kind === 'slides' || source.kind === 'whiteboard') {
    const input = source.kind === 'slides' && source.slides?.schema === SLIDES_SCHEMA ? {slides:source.slides}
      : source.kind === 'whiteboard' && source.board?.schema === 'flybot-workspace.whiteboard.v1' ? {board:source.board} : null
    if (!input) refuse(400,'invalid','这个公开版本没有可复制的作品内容。')
    return createArtifact(ctx,workspace,{title:trimmed,kind:source.kind,...input},key,{receiptHash})
  }
  if (!['document','website'].includes(source.kind) || !validBody(source.body) || !source.body.trim()) {
    refuse(400,'invalid','该公开版本无法复制。')
  }
  return createArtifact(ctx,workspace,{title:trimmed,kind:source.kind,body:source.body},key,{receiptHash})
}

export function duplicateArtifact({store, owner, featureDir}, workspaceId, {artifact_id: sourceId, revision, title}, key) {
  if (typeof sourceId !== 'string' || !HEX32.test(sourceId) || !Number.isSafeInteger(revision) || revision < 1 || !validTitle(title)
      || /[\x00-\x1f\x7f]/.test(title)) refuse(400, 'invalid', '请选择已保存的版本并输入副本名称。')
  if (!KEY.test(key ?? '')) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const trimmed = title.trim()
  const hash = titleHash(trimmed)
  const keyHash = digest('artifact:' + key)
  const requestHash = digest(stableJson({duplicate_from:sourceId, revision, title:trimmed}))
  return store.transaction(() => {
    const prior = store.get('SELECT id,request_hash FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      if (prior.request_hash !== requestHash) refuse(409,'conflict','这次请求已用于创建其他作品。')
      return {status:200,body:{artifact:view(load(store,workspaceId,prior.id))}}
    }
    const source = store.get(ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?', sourceId,workspaceId)
    if (!source) refuse(404,'not_found','找不到要复制的作品。')
    const current = source.revision === revision
    const snapshot = current ? versionSnapshot(source)
      : store.get('SELECT kind,body,board,mime,byte_count,sha256,filename FROM artifact_versions WHERE artifact_id=? AND revision=?',source.id,revision)
    if (!snapshot) refuse(404,'version_not_found','这个保存版本已不可用。')
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409,'title_conflict','已存在同名作品，请换一个名称。')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429,'quota','该资料空间已达到作品容量上限。')
    }
    const sourceKind = publicKind(source)
    let kind = current ? sourceKind : snapshot.kind
    let structured = null
    if (snapshot.kind === 'document' && sourceKind !== 'document') {
      const [decodedKind, decoded] = decodeStructured(snapshot.body)
      if (decodedKind) { kind = decodedKind; structured = decoded }
      else if (current && kind !== 'document') refuse(409,'version_unavailable','该作品的保存内容暂时无法复制。')
    }
    if (kind === 'media') {
      try { readMediaBytes(featureDir,workspaceId,snapshot.sha256,snapshot.byte_count,snapshot.mime) }
      catch { refuse(409,'version_unavailable','该版本的媒体文件暂时无法复制。') }
    }
    const body = kind === 'website' || kind === 'document' ? snapshot.body : ''
    const id = newId(), now = nowSeconds()
    store.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id,workspaceId,trimmed,hash,'document',body,now,now,owner,owner,keyHash,requestHash)
    attachKind(store,id,kind,{
      board:kind === 'whiteboard' ? decodeBoard(snapshot.board) ?? emptyBoard() : undefined,
      slides:kind === 'slides' ? structured : undefined, dashboard:kind === 'dashboard' ? structured : undefined,
    })
    if (kind === 'spreadsheet') attachWorkbook(store,id,structured)
    if (kind === 'media') attachMedia(store,id,snapshot.mime,snapshot.byte_count,snapshot.sha256,snapshot.filename)
    return saved(store,workspaceId,id,201)
  })
}

export function createMedia(ctx, workspaceId, { title, data, filename, mime, key, allowFile }, {receiptHash} = {}) {
  const { store, owner, featureDir } = ctx
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
  if (!validTitle(title)) refuse(400, 'invalid', 'Provide a document title and body')
  const trimmed = title.trim()
  if (!KEY.test(key ?? '')) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const sniffed = sniffMime(data)
  const used = MEDIA_MIMES.has(sniffed) ? sniffed : allowFile ? FILE_MIME : null
  if (!used || (mime && mime !== used && !MEDIA_MIMES.has(mime))) {
    refuse(400, 'invalid', 'Upload a supported media file')
  }
  const name = savedMediaFilename(filename)
  const sha = createHash('sha256').update(data).digest('hex')
  const payload = { title: trimmed, kind: 'media', sha256: sha, mime: used, filename: name }
  const keyHash = digest('artifact:' + key)
  const requestHash = receiptHash ?? digest(stableJson(payload))
  return store.transaction(() => {
    const prior = store.get('SELECT * FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { status: 200, body: { artifact: view(load(store, workspaceId, prior.id)) } }
    }
    const hash = titleHash(trimmed)
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429, 'quota', 'Artifact capacity reached')
    }
    let stored
    try { stored = writeMedia(featureDir, workspaceId, data) } catch { refuse(503, 'unavailable', 'Storage is temporarily unavailable') }
    if (stored !== sha) refuse(500, 'internal', 'Internal service error')
    const id = newId()
    const now = nowSeconds()
    store.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id, workspaceId, trimmed, hash, 'document', '', now, now, owner, owner, keyHash, requestHash)
    attachMedia(store, id, used, data.length, sha, name)
    return saved(store, workspaceId, id, 201)
  })
}

export function updateArtifact(ctx, row, changes, revision) {
  const { store, owner } = ctx
  if (!Number.isInteger(revision) || revision < 0 || revision > 2 ** 31 || !changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
  }
  const kind = publicKind(row)
  const allowed = ['title', ...({
    whiteboard:['board','operations'], slides:['slides'], dashboard:['dashboard'],
    spreadsheet:['spreadsheet'], media:[],
  }[kind] ?? ['body'])]
  if (Object.keys(changes).some((key) => !allowed.includes(key))) refuse(400, 'invalid', 'Unknown artifact field')
  if (revision !== row.revision) refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
  let title = row.title
  let content = row.body
  let board = kind === 'whiteboard' ? decodeBoard(row.board_json) : null
  let slides = kind === 'slides' ? decodeSlides(row.slides_json) : null
  let dashboard = kind === 'dashboard' ? decodeDashboard(row.dashboard_json) : null
  let workbook = kind === 'spreadsheet' ? decodeWorkbook(row.spreadsheet_json) : null
  if ('title' in changes) {
    if (!validTitle(changes.title)) refuse(400, 'invalid', 'Provide a document title and body')
    title = changes.title.trim()
  }
  if ('body' in changes) {
    if (!validBody(changes.body)) refuse(400, 'invalid', 'Provide a document title and body')
    content = changes.body
  }
  if ('board' in changes) {
    board = normalizeBoard(changes.board)
    if (!board) refuse(400, 'invalid', 'Provide a valid board')
  }
  if ('operations' in changes) {
    board = applyBoardOperations(board || emptyBoard(), changes.operations)
    if (!board) refuse(400, 'invalid', 'Provide valid board operations')
  }
  if ('slides' in changes) {
    slides = normalizeSlides(changes.slides)
    if (!slides || !slides.slides.length) refuse(400, 'invalid', 'Provide at least one valid slide')
  }
  if ('dashboard' in changes) {
    dashboard = normalizeDashboard(changes.dashboard)
    if (!dashboard || !dashboard.widgets.length) refuse(400, 'invalid', 'Provide at least one valid dashboard widget')
  }
  if ('spreadsheet' in changes) {
    workbook = normalizeWorkbook(changes.spreadsheet)
    if (!workbook) refuse(400,'invalid','工作表名称重复、包含非法字符，或表格超出容量。')
  }
  let unchanged = title === row.title && content === row.body
  if (kind === 'whiteboard') unchanged = title === row.title && boardJson(board) === row.board_json
  else if (kind === 'slides') unchanged = title === row.title && slidesJson(slides) === row.slides_json
  else if (kind === 'dashboard') unchanged = title === row.title && dashboardJson(dashboard) === row.dashboard_json
  else if (kind === 'spreadsheet') unchanged = title === row.title && JSON.stringify(workbook) === row.spreadsheet_json
  if (unchanged) return { status: 200, body: { artifact: detailView(store, row) } }
  return ctx.store.transaction(() => {
    guardVersions(store, row.id)
    const hash = titleHash(title)
    if (title !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'title_conflict', 'A document with this title already exists')
    }
    store.run('UPDATE artifacts SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?',
      title, hash, content, row.revision + 1, nowSeconds(), owner, row.id)
    if (kind === 'whiteboard' && !attachBoard(store, row.id, board)) refuse(400, 'invalid', 'Provide a valid board')
    if (kind === 'slides' && !attachSlides(store, row.id, slides)) refuse(400, 'invalid', 'Provide valid slide content')
    if (kind === 'dashboard' && !attachDashboard(store, row.id, dashboard)) refuse(400, 'invalid', 'Provide valid dashboard content')
    if (kind === 'spreadsheet') attachWorkbook(store,row.id,workbook)
    return saved(store, row.workspace_id, row.id, 200)
  })
}

export function replaceMedia(ctx, row, { title, data, filename, mime, revision }) {
  const { store, owner, featureDir } = ctx
  if (!Number.isInteger(revision) || revision !== row.revision) {
    if (!Number.isInteger(revision)) refuse(400, 'invalid', 'Provide the current revision and a media file')
    refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
  }
  let newTitle = row.title
  if (title) {
    if (!validTitle(title)) refuse(400, 'invalid', 'Provide a document title and body')
    newTitle = title.trim()
  }
  const sniffed = sniffMime(data)
  if (!sniffed || !MEDIA_MIMES.has(sniffed)) refuse(400, 'invalid', 'Upload a supported media file')
  const name = savedMediaFilename(filename)
  return store.transaction(() => {
    const hash = titleHash(newTitle)
    if (newTitle !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'title_conflict', 'A document with this title already exists')
    }
    guardVersions(store, row.id)
    let digestHex
    try { digestHex = writeMedia(featureDir, row.workspace_id, data) } catch { refuse(503, 'unavailable', 'Storage is temporarily unavailable') }
    const previous = row.media_sha256
    store.run('UPDATE artifacts SET title=?, title_hash=?, revision=?, updated=?, updated_by=? WHERE id=?',
      newTitle, hash, row.revision + 1, nowSeconds(), owner, row.id)
    attachMedia(store, row.id, sniffed, data.length, digestHex, name)
    if (previous && previous !== digestHex) unlinkMedia(featureDir, store, row.workspace_id, previous)
    return saved(store, row.workspace_id, row.id, 200)
  })
}

function guardVersions(store, artifactId) {
  if (store.get('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?', artifactId).n >= MAX_VERSIONS) {
    refuse(429, 'quota', 'Version capacity reached')
  }
}

export function restoreArtifact(ctx, target, revision, to, key) {
  const { store, owner } = ctx
  if (!Number.isInteger(revision) || !Number.isInteger(to) || to < 1 || to > 2 ** 31 || revision < 0 || revision > 2 ** 31) {
    refuse(400, 'invalid', 'Provide the current revision and a version to restore')
  }
  if (key != null && !KEY.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const requestKey = key == null ? null : digest('artifact-restore:' + key)
  const receipt = (resultRevision) => ({ base_revision: revision, source_revision: to, result_revision: resultRevision })
  return store.transaction(() => {
    const row = load(store, target.workspace_id, target.id)
    if (!row) refuse(404, 'not_found', 'Artifact not found')
    const prior = requestKey && store.get('SELECT revision,source_revision FROM artifact_restores WHERE artifact_id=? AND request_key=?', row.id, requestKey)
    if (prior) {
      if (prior.revision !== revision + 1 || prior.source_revision !== to) {
        refuse(409, 'idempotency_conflict', 'This request already restored another version')
      }
      return { status: 200, body: { artifact: detailView(store, row), restore: receipt(prior.revision) } }
    }
    if (revision !== row.revision) refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
    const snapshot = store.get('SELECT * FROM artifact_versions WHERE artifact_id=? AND revision=?', row.id, to)
    if (!snapshot) refuse(404, 'not_found', 'Version not found')
    if (sameAsVersion(row, snapshot)) return { status: 200, body: { artifact: detailView(store, row), restore: receipt(revision) } }
    guardVersions(store, row.id)
    const title = snapshot.title
    const hash = titleHash(title)
    if (title !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'title_conflict', 'A document with this title already exists')
    }
    let kind = snapshot.kind
    let structured = null
    if (kind === 'document') {
      const decoded = decodeStructured(snapshot.body)
      if (decoded[0]) { kind = decoded[0]; structured = decoded[1] }
    }
    const content = kind === 'document' || kind === 'website' ? snapshot.body : ''
    store.run('UPDATE artifacts SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?',
      title, hash, content, row.revision + 1, nowSeconds(), owner, row.id)
    setRender(store, row.id, kind)
    const clear = (...tables) => { for (const table of tables) store.run(`DELETE FROM ${table} WHERE artifact_id=?`, row.id) }
    if (kind !== 'spreadsheet') clear('artifact_spreadsheets')
    if (kind === 'spreadsheet') {
      attachWorkbook(store,row.id,structured)
      clear('artifact_media','artifact_boards','artifact_slides','artifact_dashboards')
    } else if (kind === 'slides') {
      if (!attachSlides(store, row.id, structured)) refuse(400, 'invalid', 'Provide valid slide content')
      clear('artifact_media', 'artifact_boards', 'artifact_dashboards')
    } else if (kind === 'dashboard') {
      if (!attachDashboard(store, row.id, structured)) refuse(400, 'invalid', 'Provide valid dashboard content')
      clear('artifact_media', 'artifact_boards', 'artifact_slides')
    } else if (kind === 'whiteboard') {
      if (!attachBoard(store, row.id, decodeBoard(snapshot.board) ?? emptyBoard())) refuse(400, 'invalid', 'Provide a valid board')
      clear('artifact_slides', 'artifact_dashboards')
    } else if (kind === 'media') {
      attachMedia(store, row.id, snapshot.mime, snapshot.byte_count, snapshot.sha256, snapshot.filename)
      clear('artifact_slides', 'artifact_dashboards')
    } else {
      clear('artifact_media', 'artifact_boards', 'artifact_slides', 'artifact_dashboards')
    }
    const result = saved(store, row.workspace_id, row.id, 200)
    store.run('INSERT INTO artifact_restores VALUES(?,?,?,?)', row.id, row.revision + 1, to, requestKey)
    result.body.restore = receipt(row.revision + 1)
    return result
  })
}

export function exportBytes(row, featureDir, workspaceId, fromVersion = false) {
  const kind = fromVersion ? row.kind : publicKind(row)
  const title = row.title
  const revision = row.revision
  if (kind === 'media') {
    const mime = fromVersion ? row.mime : row.media_mime
    const digestHex = fromVersion ? row.sha256 : row.media_sha256
    const filename = fromVersion ? row.filename : row.media_filename
    const expected = fromVersion ? row.byte_count : row.media_bytes
    const payload = readMediaBytes(featureDir, workspaceId, digestHex, expected, mime)
    const name = exportFilename(title, kind, revision, filename)
    return { payload, contentType: mime, filename: name, headers: exportHeaders(mime, name) }
  }
  let structuredKind = null, structured = null
  if (kind === 'slides') { structuredKind = 'slides'; structured = decodeSlides(row.slides_json) }
  else if (kind === 'dashboard') { structuredKind = 'dashboard'; structured = decodeDashboard(row.dashboard_json) }
  else if (fromVersion && kind === 'document') [structuredKind, structured] = decodeStructured(row.body)
  if (kind === 'spreadsheet' || structuredKind === 'spreadsheet') {
    const result = exportOffice(row,'xlsx',fromVersion)
    return {...result,headers:exportHeaders(result.contentType,result.filename)}
  }
  if (structured) {
    const html = structuredKind === 'slides' ? renderSlidesPage(title, structured) : renderDashboardPage(title, structured)
    const name = exportFilename(title, structuredKind, revision)
    return { payload: html, contentType: 'text/html; charset=utf-8', filename: name, headers: exportHeaders('text/html; charset=utf-8', name) }
  }
  if (kind === 'website') {
    const name = exportFilename(title, kind, revision)
    return { payload: renderWebsitePage(title, row.body), contentType: 'text/html; charset=utf-8', filename: name, headers: exportHeaders('text/html; charset=utf-8', name) }
  }
  if (kind === 'whiteboard') {
    const raw = fromVersion ? row.board : row.board_json
    const board = decodeBoard(raw) ?? emptyBoard()
    const name = exportFilename(title, kind, revision)
    return { payload: renderBoardSvg(board), contentType: 'image/svg+xml; charset=utf-8', filename: name, headers: exportHeaders('image/svg+xml; charset=utf-8', name) }
  }
  const body = typeof row.body === 'string' ? row.body : ''
  const name = exportFilename(title, kind, revision)
  return { payload: body, contentType: 'text/plain; charset=utf-8', filename: name, headers: exportHeaders('text/plain; charset=utf-8', name) }
}


export function exportResult(row, featureDir, workspaceId, fromVersion, format) {
  if (format && OFFICE.has(format)) {
    try {
      const result = exportOffice(row, format, fromVersion)
      return { status: 200, raw: result.payload, headers: exportHeaders(result.contentType, result.filename), filename: result.filename }
    } catch (error) {
      refuse(400, 'unsupported_export', String(error?.message ?? error))
    }
  }
  if (format) refuse(400, 'invalid', 'Unsupported export format')
  try {
    const result = exportBytes(row, featureDir, workspaceId, fromVersion)
    return { status: 200, raw: result.payload, headers: result.headers, filename: result.filename }
  } catch {
    refuse(404, 'not_found', 'Artifact not found')
  }
}

export function parseExportFormat(query) {
  if (!query || ![...query.keys()].length) return null
  const keys = [...query.keys()]
  const format = query.get('format') ?? 'original'
  if (keys.some((k) => k !== 'format') || query.getAll('format').length > 1 || !['original', 'docx', 'pdf', 'xlsx', 'pptx'].includes(format)) {
    refuse(400, 'invalid', keys.length > 1 || (query.has('format') && !['original', 'docx', 'pdf', 'xlsx', 'pptx'].includes(format)) ? (OFFICE.has(format) ? 'Unsupported export format' : 'Provide only one export format') : 'Unsupported export format')
  }
  return format === 'original' ? null : format
}

function shareToken(store, id, create = false) {
  const key = 'SELECT secret FROM artifact_share_keys WHERE id=1'
  let row = store.get(key)
  if (!row && create) {
    store.run('INSERT OR IGNORE INTO artifact_share_keys(id,secret) VALUES(1,?)', randomBytes(32).toString('hex'))
    row = store.get(key)
  }
  if (!row?.secret) return null
  return createHmac('sha256',Buffer.from(row.secret,'hex')).update('artifact-read-only:' + id).digest('base64url')
}

export function recoverShareToken(store, row) {
  if (row.recovery_version !== 1) return null
  const token = shareToken(store,row.id)
  return token && digest('share:' + token) === row.token_hash ? token : null
}

export function shareView(row, { includeToken = false, token = null, store, now = null } = {}) {
  const user = store ? usernames(store) : () => null
  const revoked = Boolean(row.revoked && row.revocation_confirmed_at != null)
  const data = {
    id: row.id, artifact_id: row.artifact_id, workspace_id: row.workspace_id, prefix: row.token_prefix,
    created: row.created, created_by: row.created_by_username ?? user(row.created_by),
    expires: row.expires, revoked, revocation_pending: Boolean(row.revoked && !revoked), scope: 'read',
    ...(Number.isSafeInteger(row.source_revision) ? {revision:row.source_revision} : {}),
    ...(row.recovery_version === 1 ? {recoverable:true} : {}),
  }
  if (now != null) data.expired = row.expires != null && row.expires <= now
  if (includeToken && token) { data.token = token; data.path = '/share/' + token }
  return data
}

export function listShares(store, artifactId) {
  return store.all('SELECT * FROM artifact_shares WHERE artifact_id=? ORDER BY id', artifactId)
}

export function createShare(store, row, owner, now, expiresIn) {
  let expires = null
  if (expiresIn != null) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 2592000) refuse(400, 'invalid', 'expires_in must be 1..2592000 seconds')
    expires = now + expiresIn
  }
  const active = store.get(`SELECT COUNT(*) AS n FROM artifact_shares WHERE artifact_id=?
    AND revocation_confirmed_at IS NULL AND (expires IS NULL OR expires>?)`, row.id, now).n
  if (active >= MAX_SHARES) refuse(429, 'quota', 'Share capacity reached')
  const id = newId()
  const token = shareToken(store,id,true)
  store.run(`INSERT INTO artifact_shares
    (id,artifact_id,workspace_id,token_hash,token_prefix,created,created_by,expires,revoked,revoked_at,source_revision,recovery_version)
    VALUES(?,?,?,?,?,?,?,?,0,NULL,?,1)`,
    id, row.id, row.workspace_id, digest('share:' + token), token.slice(0, PREFIX_LEN), now, owner, expires, row.revision)
  const item = store.get('SELECT * FROM artifact_shares WHERE id=? AND artifact_id=?', id, row.id)
  return { status: 201, body: { share: shareView(item, { includeToken: true, token, store }) } }
}

export function revokeShare(store, artifactId, shareId, now, { confirmed = false } = {}) {
  const item = store.get('SELECT * FROM artifact_shares WHERE id=? AND artifact_id=?', shareId, artifactId)
  if (!item) refuse(404, 'not_found', 'Share not found')
  store.run('UPDATE artifact_shares SET revoked=1, revoked_at=? WHERE id=? AND revoked=0', now, item.id)
  if (confirmed) {
    store.run('UPDATE artifact_shares SET revocation_confirmed_at=? WHERE id=? AND revocation_confirmed_at IS NULL', now, item.id)
  }
  return { status: 200, body: { share: shareView(store.get('SELECT * FROM artifact_shares WHERE id=?', shareId), { store }) } }
}

export function content(row, featureDir, { preview: asPreview = false } = {}) {
  const kind = publicKind(row)
  if (kind === 'media' && !asPreview) {
    try {
      const payload = readMediaBytes(featureDir, row.workspace_id, row.media_sha256, row.media_bytes, row.media_mime)
      const name = savedMediaFilename(row.media_filename)
      if (row.media_mime === FILE_MIME) {
        return { status:200, raw:payload, filename:name, headers:exportHeaders(FILE_MIME, name) }
      }
      return {
        status: 200, raw: payload, inline: true,
        headers: {
          'content-type': row.media_mime,
          'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'self'; object-src 'none'",
          'content-disposition': 'inline; filename="' + cleanFilename(name) + '"',
        },
        filename: name,
      }
    } catch { refuse(404, 'not_found', 'Artifact not found') }
  }
  const html = renderPage(row)
  return {
    status: 200, raw: html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SHARE_CSP,
    },
    filename: 'artifact.html',
  }
}

export function listFiles(store, workspaceId, text, cursor, limit) {
  const rows = store.all(
    "SELECT a.id, a.title, md.filename, md.mime FROM artifacts a JOIN artifact_media md ON md.artifact_id=a.id WHERE a.workspace_id=? AND a.id>? AND instr(lower(a.title || ' ' || md.filename), lower(?))>0 ORDER BY a.id LIMIT ?",
    workspaceId, cursor || '', text, limit,
  )
  return rows.map((row) => ({
    id: row.id, title: row.title, preview: row.filename + ' · ' + row.mime,
    href: '/v1/workspaces/' + workspaceId + '/artifacts/' + row.id + '/file',
  }))
}

export function search(store, needle, limit) {
  const like = '%' + needle.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  return store.all(ROW_SELECT + "WHERE a.title LIKE ? ESCAPE '\\' OR a.body LIKE ? ESCAPE '\\' ORDER BY a.updated DESC LIMIT ?", like, like, limit)
    .map((row) => ({kind:'artifact', id:row.id, workspace_id:row.workspace_id, title:row.title,
      snippet:(row.body || row.title).slice(0,160), updated:row.updated,
      href:'/space?' + new URLSearchParams({workspace:row.workspace_id,artifact:row.id})}))
}

export { HEX32, mediaDigests, unlinkMedia, TOKEN }

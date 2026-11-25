// Artifact model (legacy flybot_workspace/artifacts.py): constants, validation,
// public views and text-only thumbnails, executed inside the user's DS-Bot.
import { GLB_MIME } from '../../lib/glb.js'
import {decodeWorkbook} from './workbook.js'
import { CONTROL, digest, validLongText } from '../../featurekit/http.js'

export const KINDS = ['document', 'website', 'whiteboard', 'media']
export const TITLE_MAX = 80
export const BODY_MAX = 8000
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024
export const MAX_MEDIA_OBJECT_BYTES = 8 * 1024 * 1024
export const MAX_GENERATED_VIDEO_BYTES = MAX_MEDIA_OBJECT_BYTES
export const BOARD_JSON_MAX = 65536
export const MAX_STROKES = 200
export const MAX_POINTS = 400
export const BOARD_MIN = 100
export const BOARD_MAX = 2000
export const HEX32 = /^[0-9a-f]{32}$/
export const SHA256 = /^[0-9a-f]{64}$/
export const TOKEN = /^[A-Za-z0-9_-]{43}$/
export const PREFIX_LEN = 8
export const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,80}$/
export const STROKE_ID = /^[A-Za-z0-9_-]{8,32}$/
export const COLOR = /^#[0-9A-Fa-f]{6}$/
export const MEDIA_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'video/mp4', 'video/webm', GLB_MIME])
export const FILE_MIME = 'application/octet-stream'
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const emptyBoard = () => ({ schema: 'flybot-workspace.whiteboard.v1', width: 800, height: 600, strokes: [] })
export const SLIDES_SCHEMA = 'flybot-workspace.slides.v1'
export const SLIDES_MAX = 30
export const SLIDE_TITLE_MAX = 120
export const SLIDE_BULLETS_MAX = 10
export const SLIDE_BULLET_MAX = 200
export const emptySlides = () => ({ schema: SLIDES_SCHEMA, slides: [] })
export const DASHBOARD_SCHEMA = 'flybot-workspace.dashboard.v1'
export const DASHBOARD_MAX_WIDGETS = 20
export const DASHBOARD_TABLE_COLUMNS_MAX = 6
export const DASHBOARD_TABLE_ROWS_MAX = 50
export const DASHBOARD_CELL_MAX = 200
export const DASHBOARD_BARS_MAX = 12
export const emptyDashboard = () => ({ schema: DASHBOARD_SCHEMA, widgets: [] })
export const SHARE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'"

export const casefold = (v) => String(v).toLocaleLowerCase('en-US')
export const validTitle = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= TITLE_MAX && !CONTROL.test(v)
export const validBody = (v) => validLongText(v, BODY_MAX)
export const titleHash = (title) => digest(casefold(title.trim()))

export const ROW_JOINS = ` FROM artifacts a
 LEFT JOIN artifact_meta m ON m.artifact_id=a.id
 LEFT JOIN artifact_sources s ON s.artifact_id=a.id
 LEFT JOIN artifact_media md ON md.artifact_id=a.id
 LEFT JOIN artifact_boards b ON b.artifact_id=a.id
 LEFT JOIN artifact_chat_sources cs ON cs.artifact_id=a.id
 LEFT JOIN artifact_team_run_sources tr ON tr.artifact_id=a.id AND tr.workspace_id=a.workspace_id
 LEFT JOIN artifact_slides sl ON sl.artifact_id=a.id
 LEFT JOIN artifact_dashboards d ON d.artifact_id=a.id
 LEFT JOIN artifact_spreadsheets x ON x.artifact_id=a.id `

// Row = artifacts.* plus the saved kinds, sources and previews.
export const ROW_SELECT = `SELECT a.*, m.render AS render, s.source_kind AS source_kind, s.source_id AS source_id,
 s.automation_id AS automation_id, s.automation_title AS automation_title, s.task_kind AS task_kind,
 md.mime AS media_mime, md.byte_count AS media_bytes, md.sha256 AS media_sha256, md.filename AS media_filename,
 b.board AS board_json, cs.message_id AS chat_message_id, cs.conversation_id AS chat_conversation_id,
 cs.agent_id AS chat_agent_id, cs.conversation_title AS chat_conversation_title,
 tr.run_id AS team_run_id, tr.position AS team_run_position, tr.run_title AS team_run_title,
 sl.deck AS slides_json, d.dashboard AS dashboard_json, x.workbook AS spreadsheet_json` + ROW_JOINS

export function publicKind(row) {
  if (row.media_mime) return 'media'
  if (row.board_json) return 'whiteboard'
  if (row.slides_json) return 'slides'
  if (row.dashboard_json) return 'dashboard'
  if (row.spreadsheet_json) return 'spreadsheet'
  return row.render === 'website' ? 'website' : 'document'
}

export function sourceView(row) {
  if (row.team_run_id) return {kind:'team_run_step', id:row.team_run_id, position:row.team_run_position, run_title:row.team_run_title}
  if (row.chat_message_id) {
    const data = { kind: 'agent_message', id: row.chat_message_id, conversation_id: row.chat_conversation_id }
    if (row.chat_agent_id) data.agent_id = row.chat_agent_id
    const title = String(row.chat_conversation_title ?? '').trim()
    if (title) data.conversation_title = title
    return data
  }
  if (!row.source_kind) return null
  const data = { kind: row.source_kind, id: row.source_id }
  if (row.automation_id) data.automation_id = row.automation_id
  if (row.automation_title) data.automation_title = row.automation_title
  if (row.task_kind) data.task_kind = row.task_kind
  return data
}

// Minimal html.unescape: named entities used in practice plus numeric refs.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', times: '×' }
export function unescapeHtml(text) {
  return String(text ?? '').replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});?/g, (all, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : all
  })
}

const PREVIEW_LINES = 4
const PREVIEW_LINE_MAX = 90
const PREVIEW_STROKES = 24
const PREVIEW_POINTS = 24
const TAG = /<[^>]*>/g
const BLOCK_TAG = /<\/?(?:p|div|h[1-6]|li|br|tr|blockquote|pre|section|article)\b[^>]*>/gi
const HEADING = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i
const pyRound = (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r }

export const previewText = (value) => unescapeHtml(value || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LINE_MAX)

export function textLines(body, html = false) {
  let source = body || ''
  if (html) source = source.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(BLOCK_TAG, '\n').replace(TAG, ' ')
  const lines = []
  for (const raw of source.split(/\r\n|\r|\n/)) {
    let line = raw.trim()
    if (!line) continue
    line = line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/[*_`~]{1,3}/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    line = previewText(line)
    if (line) lines.push(line)
    if (lines.length >= PREVIEW_LINES + 1) break
  }
  return lines
}

export function preview(row, { decodeBoard, decodeSlides, decodeDashboard }) {
  const kind = publicKind(row)
  if (kind === 'media') return null
  if (kind === 'spreadsheet') {
    const workbook = decodeWorkbook(row.spreadsheet_json)
    const first = workbook?.sheets[0]
    return {type:'document',lines:first ? [first.name,...first.rows.slice(0,3).map(row=>row.join(' '))].map(previewText).filter(Boolean) : []}
  }
  if (kind === 'whiteboard') {
    const board = decodeBoard(row.board_json) ?? emptyBoard()
    const shapes = board.strokes.slice(0, PREVIEW_STROKES).map((stroke) => {
      const item = { type: stroke.type, color: stroke.color }
      if (stroke.type === 'path') {
        const points = stroke.points
        const step = Math.max(1, Math.ceil(points.length / PREVIEW_POINTS))
        const sampled = points.filter((_, i) => i % step === 0)
        if (sampled.at(-1) !== points.at(-1)) sampled.push(points.at(-1))
        item.points = sampled.map(([x, y]) => [pyRound(x), pyRound(y)])
        item.width = stroke.width
      } else if (stroke.type === 'text') {
        Object.assign(item, { x: pyRound(stroke.x), y: pyRound(stroke.y), size: stroke.size, text: stroke.text.slice(0, 40) })
      } else {
        Object.assign(item, { x: pyRound(stroke.x), y: pyRound(stroke.y), width: pyRound(stroke.width), height: pyRound(stroke.height) })
      }
      return item
    })
    return { type: 'board', width: board.width, height: board.height, shapes, count: board.strokes.length }
  }
  if (kind === 'slides') {
    const slides = (decodeSlides(row.slides_json) ?? emptySlides()).slides
    const first = slides[0] ?? { title: '', bullets: [] }
    return { type: 'slides', title: previewText(first.title), bullets: first.bullets.slice(0, 3).map(previewText), count: slides.length }
  }
  if (kind === 'dashboard') {
    const dashboard = decodeDashboard(row.dashboard_json) ?? emptyDashboard()
    const widgets = dashboard.widgets.slice(0, 4).map((widget) => {
      const item = { type: widget.type, title: previewText(widget.title) }
      if (widget.type === 'metric') item.value = previewText(widget.value).slice(0, 24)
      else if (widget.type === 'bar') { const top = Math.max(...widget.values) || 1; item.bars = widget.values.slice(0, 8).map((v) => pyRound(v * 100 / top)) }
      else { item.columns = widget.columns.slice(0, 4).map((c) => previewText(c).slice(0, 24)); item.rows = Math.min(widget.rows.length, 99) }
      return item
    })
    return { type: 'dashboard', widgets }
  }
  const body = row.body ?? ''
  if (kind === 'website') {
    const match = HEADING.exec(body)
    const heading = match ? previewText(match[1].replace(TAG, ' ')) : ''
    let lines = textLines(body, true)
    if (heading && lines.length && lines[0] === heading) lines = lines.slice(1)
    return { type: 'website', heading, lines: lines.slice(0, PREVIEW_LINES) }
  }
  let lines = textLines(body)
  let heading = ''
  const first = body.trimStart().split('\n', 1)[0]
  if (first.startsWith('#') && lines.length) { heading = lines[0]; lines = lines.slice(1) }
  const blocks = []
  let inCode = false
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const value = raw.trim()
    if (value.startsWith('```')) { inCode = !inCode; continue }
    if (!value) continue
    const type = inCode ? 'code' : /^#{1,3}\s/.test(value) ? 'heading' : /^(?:[-*+] |[0-9]+[.)] )/.test(value) ? 'list' : value.startsWith('>') ? 'quote' : 'text'
    const text = textLines(value)
    if (text.length) blocks.push({ type, text: text[0] })
    if (blocks.length >= 6) break
  }
  return { type: 'document', heading, lines: lines.slice(0, PREVIEW_LINES), blocks }
}

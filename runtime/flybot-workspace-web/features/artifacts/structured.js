// Whiteboard, slides and dashboard content (legacy artifacts.py
// normalize_*/decode_*/*_json), validated inside the user's DS-Bot.
import { normalizeWorkbook, WORKBOOK_SCHEMA } from './workbook.js'
import { stableJson } from '../../featurekit/http.js'
import {
  BOARD_JSON_MAX, BOARD_MAX, BOARD_MIN, COLOR, DASHBOARD_BARS_MAX, DASHBOARD_CELL_MAX, DASHBOARD_MAX_WIDGETS, DASHBOARD_SCHEMA,
  DASHBOARD_TABLE_COLUMNS_MAX, DASHBOARD_TABLE_ROWS_MAX, MAX_POINTS, MAX_STROKES, SLIDE_BULLETS_MAX, SLIDE_BULLET_MAX,
  SLIDE_TITLE_MAX, SLIDES_MAX, SLIDES_SCHEMA, STROKE_ID,
} from './model.js'

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const get = (obj, key, fallback) => (Object.hasOwn(obj, key) ? obj[key] : fallback)

export function finiteNumber(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value >= lo && value <= hi ? value : null
}

export function normalizeStroke(item) {
  if (!isObject(item)) return null
  const id = item.id
  const kind = item.type
  const color = get(item, 'color', '#111111')
  if (typeof id !== 'string' || !STROKE_ID.test(id)) return null
  if (!['path', 'rect', 'ellipse', 'text'].includes(kind) || typeof color !== 'string' || !COLOR.test(color)) return null
  if (kind === 'path') {
    const points = item.points
    const width = finiteNumber(get(item, 'width', 2), 1, 40)
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS || width === null) return null
    const cleaned = []
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 2) return null
      const x = finiteNumber(point[0], 0, BOARD_MAX)
      const y = finiteNumber(point[1], 0, BOARD_MAX)
      if (x === null || y === null) return null
      cleaned.push([x, y])
    }
    return { id, type: 'path', color, width, points: cleaned }
  }
  if (kind === 'rect' || kind === 'ellipse') {
    const x = finiteNumber(item.x, 0, BOARD_MAX)
    const y = finiteNumber(item.y, 0, BOARD_MAX)
    const w = finiteNumber(item.width, 1, BOARD_MAX)
    const h = finiteNumber(item.height, 1, BOARD_MAX)
    if ([x, y, w, h].includes(null)) return null
    return { id, type: kind, color, x, y, width: w, height: h }
  }
  const text = get(item, 'text', '')
  const x = finiteNumber(item.x, 0, BOARD_MAX)
  const y = finiteNumber(item.y, 0, BOARD_MAX)
  const size = finiteNumber(get(item, 'size', 16), 8, 96)
  if (typeof text !== 'string' || text.length < 1 || text.length > 200 || text.includes('\x00') || x === null || y === null || size === null) return null
  if ([...text].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\t')) return null
  return { id, type: 'text', color, x, y, size, text }
}

export function normalizeBoard(value) {
  if (!isObject(value)) return null
  const width = finiteNumber(get(value, 'width', 800), BOARD_MIN, BOARD_MAX)
  const height = finiteNumber(get(value, 'height', 600), BOARD_MIN, BOARD_MAX)
  const strokes = get(value, 'strokes', [])
  if (width === null || height === null || !Array.isArray(strokes) || strokes.length > MAX_STROKES) return null
  const cleaned = []
  const seen = new Set()
  for (const item of strokes) {
    const stroke = normalizeStroke(item)
    if (!stroke || seen.has(stroke.id)) return null
    seen.add(stroke.id)
    cleaned.push(stroke)
  }
  return { schema: 'flybot-workspace.whiteboard.v1', width: Math.trunc(width), height: Math.trunc(height), strokes: cleaned }
}

export function decodeBoard(raw) {
  if (!raw) return null
  try { return normalizeBoard(JSON.parse(raw)) } catch { return null }
}

export function applyBoardOperations(board, operations) {
  let current = normalizeBoard(board)
  if (!current || !Array.isArray(operations) || operations.length < 1 || operations.length > MAX_STROKES) return null
  let strokes = new Map(current.strokes.map((s) => [s.id, s]))
  let order = current.strokes.map((s) => s.id)
  for (const item of operations) {
    if (!isObject(item) || Object.keys(item).some((k) => !['op', 'stroke', 'id', 'board'].includes(k))) return null
    if (item.op === 'replace') {
      current = normalizeBoard(item.board)
      if (!current) return null
      strokes = new Map(current.strokes.map((s) => [s.id, s]))
      order = current.strokes.map((s) => s.id)
    } else if (item.op === 'add') {
      const stroke = normalizeStroke(item.stroke)
      if (!stroke || strokes.has(stroke.id) || order.length >= MAX_STROKES) return null
      strokes.set(stroke.id, stroke)
      order.push(stroke.id)
    } else if (item.op === 'remove') {
      if (typeof item.id !== 'string' || !strokes.has(item.id)) return null
      strokes.delete(item.id)
      order = order.filter((k) => k !== item.id)
    } else return null
  }
  current.strokes = order.map((k) => strokes.get(k))
  return current
}

// json.dumps(ensure_ascii=True): non-ASCII escaped, insertion order kept.
export const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
export function boardJson(board) {
  const text = asciiJson(board)
  return text.length > BOARD_JSON_MAX ? null : text
}

export function normalizeSlides(value) {
  if (!isObject(value) || get(value, 'schema', SLIDES_SCHEMA) !== SLIDES_SCHEMA) return null
  const slides = value.slides
  if (!Array.isArray(slides) || slides.length > SLIDES_MAX) return null
  const out = []
  for (const slide of slides) {
    if (!isObject(slide)) return null
    const title = get(slide, 'title', '')
    const bullets = get(slide, 'bullets', [])
    if (typeof title !== 'string' || title.trim().length > SLIDE_TITLE_MAX || CONTROL.test(title)) return null
    if (!Array.isArray(bullets) || bullets.length > SLIDE_BULLETS_MAX) return null
    const clean = []
    for (const bullet of bullets) {
      if (typeof bullet !== 'string' || bullet.trim().length > SLIDE_BULLET_MAX || CONTROL.test(bullet)) return null
      if (bullet.trim()) clean.push(bullet.trim())
    }
    if (!title.trim() && !clean.length) return null
    out.push({ title: title.trim(), bullets: clean })
  }
  return { schema: SLIDES_SCHEMA, slides: out }
}

export function slidesJson(deck) {
  const normalized = normalizeSlides(deck)
  if (!normalized) return null
  const text = stableJson(normalized)
  return text.length > 65536 ? null : text
}

function parseObject(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trimStart().startsWith('{')) return null
  let value
  try { value = JSON.parse(raw) } catch { return null }
  return isObject(value) ? value : null
}

function decodeJsonObject(raw, schema) {
  const value = parseObject(raw)
  return value?.schema === schema ? value : null
}
export const decodeSlides = (raw) => { const v = decodeJsonObject(raw, SLIDES_SCHEMA); return v ? normalizeSlides(v) : null }

const dashText = (value, limit) => typeof value === 'string' && value.trim().length <= limit && !CONTROL.test(value)

export function normalizeDashboard(value) {
  if (!isObject(value) || get(value, 'schema', DASHBOARD_SCHEMA) !== DASHBOARD_SCHEMA) return null
  const widgets = value.widgets
  if (!Array.isArray(widgets) || widgets.length > DASHBOARD_MAX_WIDGETS) return null
  const out = []
  for (const widget of widgets) {
    if (!isObject(widget)) return null
    const kind = widget.type
    const title = get(widget, 'title', '')
    if (!dashText(title, SLIDE_TITLE_MAX) || !title.trim()) return null
    if (kind === 'metric') {
      const metric = get(widget, 'value', '')
      const note = get(widget, 'note', '')
      if (!dashText(metric, SLIDE_TITLE_MAX) || !dashText(note, 200)) return null
      out.push({ type: 'metric', title: title.trim(), value: metric.trim(), note: note.trim() })
    } else if (kind === 'table') {
      const columns = widget.columns
      const rows = get(widget, 'rows', [])
      if (!Array.isArray(columns) || columns.length < 1 || columns.length > DASHBOARD_TABLE_COLUMNS_MAX || columns.some((c) => !dashText(c, DASHBOARD_CELL_MAX))) return null
      if (!Array.isArray(rows) || rows.length > DASHBOARD_TABLE_ROWS_MAX) return null
      const cleanRows = []
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== columns.length || row.some((cell) => !dashText(cell, DASHBOARD_CELL_MAX))) return null
        cleanRows.push(row.map((cell) => cell.trim()))
      }
      out.push({ type: 'table', title: title.trim(), columns: columns.map((c) => c.trim()), rows: cleanRows })
    } else if (kind === 'bar') {
      const labels = widget.labels
      const values = widget.values
      if (!Array.isArray(labels) || labels.length < 1 || labels.length > DASHBOARD_BARS_MAX || labels.some((l) => !dashText(l, DASHBOARD_CELL_MAX))) return null
      if (!Array.isArray(values) || values.length !== labels.length) return null
      for (const n of values) if (typeof n !== 'number' || !(n >= 0 && n <= 1e12)) return null
      out.push({ type: 'bar', title: title.trim(), labels: labels.map((l) => l.trim()), values: [...values] })
    } else return null
  }
  return { schema: DASHBOARD_SCHEMA, widgets: out }
}

export function dashboardJson(value) {
  const normalized = normalizeDashboard(value)
  if (!normalized) return null
  const text = stableJson(normalized)
  return text.length > 65536 ? null : text
}
export const decodeDashboard = (raw) => { const v = decodeJsonObject(raw, DASHBOARD_SCHEMA); return v ? normalizeDashboard(v) : null }

const structuredKinds = new Map([
  [SLIDES_SCHEMA, ['slides', normalizeSlides]],
  [DASHBOARD_SCHEMA, ['dashboard', normalizeDashboard]],
  [WORKBOOK_SCHEMA, ['spreadsheet', normalizeWorkbook]],
])

export function decodeStructured(raw) {
  const value = parseObject(raw)
  const decoder = structuredKinds.get(value?.schema)
  if (!decoder) return [null, null]
  const [kind, normalize] = decoder
  const structured = normalize(value)
  return structured ? [kind, structured] : [null, null]
}

export const decoders = { decodeBoard, decodeSlides, decodeDashboard }

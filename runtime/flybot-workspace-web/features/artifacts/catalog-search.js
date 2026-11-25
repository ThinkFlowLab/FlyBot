import { casefold, publicKind, unescapeHtml } from './model.js'
import { decodeBoard, decodeDashboard, decodeSlides, decodeStructured } from './structured.js'
import { decodeWorkbook, workbookText } from './workbook.js'

const EXCERPT_LENGTH = 160
const TAGS = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^"'<>])*)>/gi
const RAW = new Set(['script', 'style', 'title', 'noscript', 'iframe'])
const INERT = new Set(['head', 'template'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const BLOCK = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/

export const catalogSearchText = value => String(value ?? '').trim().replace(/\s+/gu, ' ')

function hidden(attributes) {
  for (const match of attributes.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g)) {
    const name = match[1].toLowerCase()
    if (name === 'hidden') return true
    if (name === 'style' && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i
      .test(match[2] ?? match[3] ?? match[4] ?? '')) return true
  }
  return false
}

function websiteText(source) {
  const text = []
  const ignored = []
  const tags = new RegExp(TAGS)
  let offset = 0
  for (let tag; (tag = tags.exec(source));) {
    if (!ignored.length) text.push(source.slice(offset, tag.index))
    offset = tags.lastIndex
    if (!tag[2]) continue
    const name = tag[2].toLowerCase()
    if (!tag[1] && RAW.has(name)) {
      // An unclosed raw element also hides the rest of the source.
      const close = new RegExp(`</${name}\\s*>`, 'gi')
      close.lastIndex = offset
      offset = close.exec(source) ? close.lastIndex : source.length
      tags.lastIndex = offset
    } else if (tag[1]) {
      const at = ignored.lastIndexOf(name)
      if (at >= 0) ignored.length = at
    } else if (!VOID.has(name) && (ignored.length || INERT.has(name) || hidden(tag[3]))) {
      ignored.push(name)
    }
    if (!ignored.length && BLOCK.test(name)) text.push(' ')
  }
  if (!ignored.length) text.push(source.slice(offset))
  return unescapeHtml(text.join(''))
}

function unfoldedRange(text, from, to) {
  let original = 0
  let folded = 0
  let start = 0
  for (const char of text) {
    const next = folded + casefold(char).length
    if (folded <= from && from < next) start = original
    original += char.length
    if (to <= next) return [start, original]
    folded = next
  }
  return [start, text.length]
}

export function catalogMatch(kind, value, needle) {
  const text = catalogSearchText(value)
  const folded = casefold(text)
  const from = folded.indexOf(needle)
  if (from < 0) return null
  const to = from + needle.length
  const [start, end] = folded.length === text.length ? [from, to] : unfoldedRange(text, from, to)
  if (text.length <= EXCERPT_LENGTH) return {kind, text, start, end}
  const span = EXCERPT_LENGTH - 2
  let left = Math.max(0, Math.min(start - 48, text.length - span))
  let right = left + span
  if (/[\uDC00-\uDFFF]/u.test(text[left])) left += 1
  if (/[\uDC00-\uDFFF]/u.test(text[right])) right -= 1
  const leading = left ? '…' : ''
  const trailing = right < text.length ? '…' : ''
  return {
    kind, text: leading + text.slice(left, right) + trailing,
    start: start - left + leading.length, end: end - left + leading.length,
  }
}

export function* structuredArtifactText(artifact) {
  switch (artifact.kind) {
    case 'whiteboard':
      for (const stroke of artifact.board?.strokes ?? []) {
        if (stroke.type === 'text') yield stroke.text
      }
      break
    case 'slides':
      for (const slide of artifact.slides?.slides ?? []) {
        yield [slide.title, ...slide.bullets].join(' ')
      }
      break
    case 'dashboard':
      for (const widget of artifact.dashboard?.widgets ?? []) {
        if (widget.type === 'metric') yield [widget.title, widget.value, widget.note].join(' ')
        else if (widget.type === 'bar') yield [widget.title, ...widget.labels, ...widget.values].join(' ')
        else yield [widget.title, ...widget.columns, ...widget.rows.flat()].join(' ')
      }
      break
    case 'spreadsheet':
      if (artifact.spreadsheet) yield workbookText(artifact.spreadsheet)
      break
  }
}

function* artifactText(row, kind = publicKind(row), saved) {
  switch (kind) {
    case 'document':
      yield row.body
      break
    case 'website':
      yield websiteText(row.body || '')
      break
    case 'whiteboard':
      yield* structuredArtifactText({kind, board: decodeBoard(row.board_json)})
      break
    case 'slides':
      yield* structuredArtifactText({kind, slides: saved || decodeSlides(row.slides_json)})
      break
    case 'dashboard':
      yield* structuredArtifactText({kind, dashboard: saved || decodeDashboard(row.dashboard_json)})
      break
    case 'spreadsheet':
      yield* structuredArtifactText({kind, spreadsheet: saved || decodeWorkbook(row.spreadsheet_json)})
      break
  }
}

export function artifactContextExcerpt(row, kind, saved) {
  const limit = 12_000
  let result = ''
  for (const text of artifactText(row, kind, saved)) {
    if (typeof text !== 'string' || !text.trim()) continue
    const part = (result ? '\n' : '') + text
    if (result.length + part.length > limit) return (result + part.slice(0, limit - result.length - 1)).toWellFormed() + '…'
    result += part
    if (result.length === limit) break
  }
  return result
}

export function catalogContentMatch(row, needle) {
  if (!row) return null
  const kind = publicKind(row)
  const [legacyKind, structure] = kind === 'document' ? decodeStructured(row.body) : [null, null]
  for (const text of artifactText(row, legacyKind ?? kind, structure)) {
    const match = catalogMatch('body', text, needle)
    if (match) return match
  }
  return null
}

// Pure helpers for long-message folding. The client module draws the bubble
// and the document card; this file is the thresholds, the preview cut, and
// the long-document test, so unit tests can import them without React.

import { DEFAULT_FOLDING } from './message-fold-prefs.js'

export { DEFAULT_FOLDING }
export const FOLD_MODES = ['compact', 'standard', 'none']

// A message folds when it exceeds either cap for the chosen mode. The preview
// is the shorter of "first N lines" and "first M characters", ending on a line
// or word boundary. Equal-to-the-cap messages stay open — only values *over*
// the threshold fold.
export const FOLD_THRESHOLDS = {
  compact: { lines: 4, chars: 240 },
  standard: { lines: 12, chars: 800 },
}

const DOCUMENT_MIN_HEADINGS = 2
const DOCUMENT_MIN_BREAKS = 3
const MODE_SET = new Set(FOLD_MODES)

export function foldingOf(prefs) {
  const raw = prefs?.folding
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_FOLDING }
  const mode = MODE_SET.has(raw.mode) ? raw.mode : DEFAULT_FOLDING.mode
  const documentCards = typeof raw.documentCards === 'boolean' ? raw.documentCards : DEFAULT_FOLDING.documentCards
  return { mode, documentCards }
}

function clipWord(line, max) {
  if (line.length <= max) return line
  const slice = line.slice(0, max)
  let breakAt = -1
  for (const mark of [' ', '\t', '，', '。', '、', '；', '：', ',', '.', ';', ':', '！', '？', '!', '?']) {
    breakAt = Math.max(breakAt, slice.lastIndexOf(mark))
  }
  if (breakAt >= Math.min(8, Math.floor(max * 0.4))) return slice.slice(0, breakAt)
  return slice
}

// An odd number of ``` fences means the preview opened a code block it did not
// close. Cut before that opener when there is still prose; otherwise close it
// so the renderer is not left hanging.
function closeFences(preview) {
  let fence = null
  let offset = 0
  for (const line of preview.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (match) {
      const mark = match[1]
      if (!fence) fence = { char: mark[0], length: mark.length, offset }
      else if (mark[0] === fence.char && mark.length >= fence.length && match[2].trim() === '') fence = null
    }
    offset += line.length + 1
  }
  if (!fence) return preview
  if (preview.slice(0, fence.offset).trim()) return preview.slice(0, fence.offset).trimEnd()
  return `${preview}\n${fence.char.repeat(fence.length)}`
}

// Classify headings/section breaks only outside fenced code.
function proseLines(text) {
  let fence = null
  return String(text ?? '').split('\n').filter(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (match) {
      if (!fence) fence = match[1]
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null
      return false
    }
    return !fence
  })
}

export function exceedsThreshold(text, cap) {
  if (!cap) return false
  const raw = String(text ?? '')
  if (raw.length > cap.chars) return true
  return raw.split('\n').length > cap.lines
}

export function previewOf(text, mode) {
  const cap = FOLD_THRESHOLDS[mode]
  const raw = String(text ?? '')
  if (!cap) return raw
  const lines = raw.split('\n')
  const out = []
  let chars = 0
  for (let i = 0; i < lines.length && out.length < cap.lines; i++) {
    const line = lines[i]
    const extra = (out.length === 0 ? 0 : 1) + line.length
    if (out.length === 0 && line.length > cap.chars) {
      out.push(clipWord(line, cap.chars))
      break
    }
    if (out.length > 0 && chars + extra > cap.chars) {
      const budget = cap.chars - chars - 1
      if (budget > 0) out.push(clipWord(line, budget))
      break
    }
    out.push(line)
    chars += extra
  }
  return closeFences(out.join('\n'))
}

export function shouldFold(text, mode) {
  const cap = FOLD_THRESHOLDS[mode]
  if (!cap) return false
  const raw = String(text ?? '')
  if (!exceedsThreshold(raw, cap)) return false
  return previewOf(raw, mode) !== raw
}

export function documentHeadings(text) {
  const heads = []
  for (const line of proseLines(text)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) heads.push({ level: match[1].length, title: match[2] })
  }
  return heads
}

export function isLongDocument(text) {
  if (!exceedsThreshold(text, FOLD_THRESHOLDS.standard)) return false
  if (documentHeadings(text).length >= DOCUMENT_MIN_HEADINGS) return true
  const sections = proseLines(text).join('\n').split(/^\s*---\s*$/m).filter(part => part.trim() !== '')
  return sections.length >= DOCUMENT_MIN_BREAKS
}

export function documentTitle(text) {
  const first = documentHeadings(text)[0]?.title
  if (first) return first
  const line = String(text ?? '').split('\n').find(item => item.trim() !== '') ?? ''
  const plain = line.replace(/^#{1,6}\s+/, '').trim()
  return plain.length > 80 ? `${plain.slice(0, 80).trim()}…` : plain
}

export function showsDocumentCard(text, folding, { streaming = false } = {}) {
  if (streaming || folding?.mode === 'none') return false
  return Boolean(folding?.documentCards) && isLongDocument(text)
}

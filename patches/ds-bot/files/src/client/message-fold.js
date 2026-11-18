// Long-message folding in a chat bubble: the thresholds, the whole-line preview,
// and the one control that opens the whole reply. The document card and the
// folding preference are a later slice; foldingOf() is the read it will write.

import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

export const FOLD_MODES = ['compact', 'standard', 'none']

// A message folds when it exceeds either cap for the chosen mode; the preview is
// the shorter of "first N lines" and "first M characters", ending on a line or
// word boundary. Equal-to-the-cap messages stay open — only values over it fold.
export const FOLD_THRESHOLDS = {
  compact: { lines: 4, chars: 240 },
  standard: { lines: 12, chars: 800 },
}

export const DEFAULT_FOLDING = { mode: 'standard' }

const MODE_SET = new Set(FOLD_MODES)

export function foldingOf(prefs) {
  const raw = prefs?.folding
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_FOLDING }
  return { mode: MODE_SET.has(raw.mode) ? raw.mode : DEFAULT_FOLDING.mode }
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

// An odd number of code-block markers means the preview opened a block it did not
// close: cut before that opener when there is still prose, else close the block.
function closeCodeBlock(preview) {
  let block = null
  let offset = 0
  for (const line of preview.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (match) {
      const mark = match[1]
      if (!block) block = { char: mark[0], length: mark.length, offset }
      else if (mark[0] === block.char && mark.length >= block.length && match[2].trim() === '') block = null
    }
    offset += line.length + 1
  }
  if (!block) return preview
  if (preview.slice(0, block.offset).trim()) return preview.slice(0, block.offset).trimEnd()
  return `${preview}\n${block.char.repeat(block.length)}`
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
    // The first line may be over the character cap on its own; cut it at a word.
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
  return closeCodeBlock(out.join('\n'))
}

export function shouldFold(text, mode) {
  const cap = FOLD_THRESHOLDS[mode]
  if (!cap) return false
  const raw = String(text ?? '')
  if (!exceedsThreshold(raw, cap)) return false
  return previewOf(raw, mode) !== raw
}

// A reply at or under the cap, or one still streaming, is drawn by the caller
// straight away; only a longer one is handed to FoldedContent.
export function foldBody({ text, folding, streaming = false, draw }) {
  const mode = folding?.mode ?? DEFAULT_FOLDING.mode
  const raw = String(text ?? '')
  if (streaming || !shouldFold(raw, mode)) return draw ? draw(raw) : null
  return h(FoldedContent, { text: raw, folding, draw })
}

// One control under the preview: open draws the whole reply and becomes Show less.
export function FoldedContent({ text, folding, draw }) {
  const [open, setOpen] = useState(false)
  const mode = folding?.mode ?? DEFAULT_FOLDING.mode
  useEffect(() => { setOpen(false) }, [mode, text])
  const shown = open ? text : previewOf(text, mode)
  return h('div', { className: 'bt-fold', 'data-folded': open ? undefined : '' },
    h('div', { className: 'bt-fold-body' }, draw ? draw(shown) : null),
    h('button', {
      type: 'button',
      className: 'bt-fold-toggle',
      'aria-expanded': open,
      onClick: (event) => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value) },
    }, t(open ? 'Show less' : 'Show more')))
}

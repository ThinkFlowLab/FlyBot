// Long-message folding in a chat bubble: the thresholds, the whole-line preview,
// the one control that opens the whole reply, and the card a long document folds
// into — read beside the conversation from the panel, or opened in place. The
// folding mode comes from the team preferences through foldingOf().

import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CloseIcon } from './icons.js'
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

// A reply that reads as a document — long, and either headed in two places or
// broken into three sections — is drawn as a card instead of a long bubble.
const DOCUMENT_MIN_HEADINGS = 2
const DOCUMENT_MIN_SECTIONS = 3

// A heading or a section break inside a code block is content, not structure.
function proseLines(text) {
  let block = null
  return String(text ?? '').split('\n').filter((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (match) {
      if (!block) block = match[1]
      else if (match[1][0] === block[0] && match[1].length >= block.length && !match[2].trim()) block = null
      return false
    }
    return !block
  })
}

export function documentHeadings(text) {
  const heads = []
  for (const line of proseLines(text)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) heads.push({ level: match[1].length, title: match[2] })
  }
  return heads
}

export function documentSections(text) {
  return proseLines(text).join('\n').split(/^\s*---\s*$/m).filter(part => part.trim() !== '')
}

export function isLongDocument(text) {
  if (!exceedsThreshold(text, FOLD_THRESHOLDS.standard)) return false
  if (documentHeadings(text).length >= DOCUMENT_MIN_HEADINGS) return true
  return documentSections(text).length >= DOCUMENT_MIN_SECTIONS
}

export function documentTitle(text) {
  const first = documentHeadings(text)[0]?.title
  if (first) return first
  const line = String(text ?? '').split('\n').find(item => item.trim() !== '') ?? ''
  const plain = line.replace(/^#{1,6}\s+/, '').trim()
  return plain.length > 80 ? `${plain.slice(0, 80).trim()}…` : plain
}

export function documentCount(text) {
  return Math.max(documentHeadings(text).length, documentSections(text).length, 1)
}

export function showsDocumentCard(text, folding) {
  if (folding?.mode === 'none') return false
  return isLongDocument(text)
}

// A reply at or under the cap, or one still streaming, is drawn by the caller
// straight away; a long document becomes a card, and any other longer reply is
// handed to FoldedContent.
export function foldBody({ text, folding, streaming = false, draw, actions, sessionId }) {
  const mode = folding?.mode ?? DEFAULT_FOLDING.mode
  const raw = String(text ?? '')
  if (streaming) return draw ? draw(raw) : null
  if (showsDocumentCard(raw, folding)) return h(DocumentMessage, { text: raw, folding, draw, actions, sessionId })
  if (!shouldFold(raw, mode)) return draw ? draw(raw) : null
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

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

// One card in place of the long bubble: it opens the whole text in the panel
// beside the conversation and never hides it, because Show message text is under it.
export function DocumentMessage({ text, folding, draw, actions, sessionId }) {
  const [open, setOpen] = useState(false)
  const mode = folding?.mode ?? DEFAULT_FOLDING.mode
  useEffect(() => { setOpen(false) }, [mode, text])
  const raw = String(text ?? '')
  const title = documentTitle(raw) || t('Document')
  return h('div', { className: 'bt-document-message' },
    h(DocumentCard, {
      title,
      count: documentCount(raw),
      onOpen: () => actions?.openDocument?.({ title, text: raw, sessionId }),
    }),
    h('button', {
      type: 'button',
      className: 'bt-fold-toggle',
      'aria-expanded': open,
      onClick: (event) => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value) },
    }, t(open ? 'Hide message text' : 'Show message text')),
    open ? (draw ? draw(raw) : h(MarkdownText, { text: raw, labels: mdLabels(), variant: 'compact' })) : null)
}

export function DocumentCard({ title, count, onOpen }) {
  const sections = t('{count} sections', { count })
  return h('button', {
    type: 'button',
    className: 'bt-doc-card',
    'aria-label': `${title}. ${sections}. ${t('Open beside the conversation')}`,
    onClick: (event) => { event.preventDefault(); event.stopPropagation(); onOpen?.() },
  },
    h('span', { className: 'bt-doc-card-icon', 'aria-hidden': true }, h(DocIcon)),
    h('span', { className: 'bt-doc-card-copy' },
      h('span', { className: 'bt-doc-card-title' }, title),
      h('span', { className: 'bt-doc-card-meta' }, sections)),
    h('span', { className: 'bt-doc-card-go' }, t('Open beside the conversation')))
}

function DocIcon() {
  return h('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
    h('path', { d: 'M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5z' }),
    h('path', { d: 'M14 3.5V9h5.5' }),
    h('path', { d: 'M8.5 13h7M8.5 16.5h5' }))
}

// The panel's document view: the same title the card carried, the whole text, and
// one control that closes it.
export function DocumentPane({ document, onClose }) {
  const title = document?.title || t('Document')
  const text = String(document?.text ?? '')
  return h('div', { className: 'bt-doc-pane', 'aria-label': title },
    h('div', { className: 'bt-doc-pane-head' },
      h('div', { className: 'bt-doc-pane-copy' },
        h('h2', { className: 'bt-doc-pane-title' }, title),
        h('p', { className: 'bt-doc-pane-hint' }, t('Opened beside the conversation.'))),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close document'), onClick: onClose }, h(CloseIcon))),
    h('div', { className: 'bt-doc-pane-body' },
      h(MarkdownText, { text, labels: mdLabels(), variant: 'compact' })))
}

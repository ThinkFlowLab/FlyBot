// Long-message folding in chat bubbles, and the General setting that drives it.
// Compact / standard / no folding set how much of a long message is shown as a
// preview; a long document with several sections can collapse into a card
// opened beside the conversation.

import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'
import {
  DEFAULT_FOLDING, documentHeadings, documentTitle as titleOf,
  previewOf, shouldFold, showsDocumentCard,
} from '../shared/message-fold.js'

export {
  DEFAULT_FOLDING, FOLD_MODES, FOLD_THRESHOLDS, documentHeadings, documentTitle,
  exceedsThreshold, foldingOf, isLongDocument, previewOf, shouldFold, showsDocumentCard,
} from '../shared/message-fold.js'

export function FoldedContent({ text, folding, streaming = false, actions, sessionId, children }) {
  const [open, setOpen] = useState(false)
  const mode = folding?.mode ?? DEFAULT_FOLDING.mode
  const cards = folding?.documentCards === true || (folding?.documentCards !== false && DEFAULT_FOLDING.documentCards)
  useEffect(() => { setOpen(false) }, [mode, cards, text])

  const render = typeof children === 'function'
    ? children
    : (Array.isArray(children) && children.length === 1 && typeof children[0] === 'function' ? children[0] : null)
  const raw = String(text ?? '')
  if (streaming) return render ? render(raw) : null
  if (mode !== 'none' && showsDocumentCard(raw, { ...folding, documentCards: cards })) {
    const title = titleOf(raw) || t('Document')
    const count = Math.max(documentHeadings(raw).length, 1)
    return h('div', { className: 'bt-document-message' },
      h(DocumentCard, { title, count, onOpen: () => actions?.openDocument?.({ title, text: raw, sessionId }) }),
      h('button', { type: 'button', className: 'bt-fold-toggle', 'aria-expanded': open,
        onClick: () => setOpen(value => !value) }, t(open ? 'Hide message text' : 'Show message text')),
      open ? (render ? render(raw) : h(MarkdownText, { text: raw, labels: mdLabels(), variant: 'compact' })) : null)

  }
  if (!shouldFold(raw, mode)) return render ? render(raw) : null
  const shown = open ? raw : previewOf(raw, mode)
  return h('div', { className: 'bt-fold', 'data-folded': open ? undefined : '' },
    render ? render(shown) : null,
    h('button', {
      type: 'button',
      className: 'bt-fold-toggle',
      'aria-expanded': open,
      onClick: (event) => { event.preventDefault(); event.stopPropagation(); setOpen(value => !value) },
    }, t(open ? 'Show less' : 'Show more')))
}

export function DocumentCard({ title, count, onOpen }) {
  const sections = t('{count} sections', { count })
  return h('button', {
    type: 'button',
    className: 'bt-doc-card',
    onClick: (event) => { event.preventDefault(); event.stopPropagation(); onOpen?.() },
    'aria-label': `${title}. ${sections}. ${t('Open beside the conversation')}`,
  },
    h('span', { className: 'bt-doc-card-icon', 'aria-hidden': true }, h(DocIcon)),
    h('span', { className: 'bt-doc-card-copy' },
      h('span', { className: 'bt-doc-card-title' }, title),
      h('span', { className: 'bt-doc-card-meta' }, sections)),
    h('span', { className: 'bt-doc-card-go' }, t('Open beside the conversation')))
}

function DocIcon() {
  return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5z' }),
    h('path', { d: 'M14 3.5V9h5.5' }),
    h('path', { d: 'M8.5 13h7M8.5 16.5h5' }))
}

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

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

// One card component behind both boards (#1265, step 1). A delivery card and a task card draw the
// same pieces — an identity line, a title, what it wears, who has it, what it is doing — so they
// render through this one component with the `source` their card model carries.
//
// `skin` is the calling board's class vocabulary. Two skins, not a third look: the delivery board
// keeps its stylesheet and the task board keeps its own while the shape is shared, and moving the
// columns into one set (step 2) no longer has to touch either stylesheet's card markup.
import { createElement as h } from 'react'
import { t } from './i18n.js'

export const DELIVERY_SKIN = {
  card: 'bt-del-card', top: 'bt-del-card-top', id: 'bt-del-id', badge: 'bt-del-badge',
  title: 'bt-del-title', labels: 'bt-del-labels', label: 'bt-del-label', owner: 'bt-del-owner',
  linked: 'bt-del-linked', sha: 'bt-del-sha',
}

export const TASK_SKIN = {
  card: 'bt-board-card', top: 'bt-board-card-top', id: 'bt-board-id', badge: 'bt-board-badge',
  title: 'bt-board-title', labels: 'bt-board-labels', label: 'bt-board-label', owner: 'bt-board-who',
  linked: 'bt-board-linked', sha: 'bt-board-sha', note: 'bt-board-note',
}

// `attrs` is the board's own extra attributes (a task's `data-column`, a card's `data-number`), so
// the existing selectors and tests keep reading the same elements.
export function BoardCard({
  card, skin = DELIVERY_SKIN, attrs = {}, idText = '', topExtra = null, badge = '',
  meta = null, note = '', footer = null, actions = null, emptyTitle = '',
  draggable = false, dragValue = '', onDragStart = null, onDragEnd = null,
}) {
  const labels = Array.isArray(card?.labels) ? card.labels : []
  return h('article', {
    ...attrs,
    className: skin.card,
    'data-source': card?.source,
    'data-key': card?.key ?? undefined,
    draggable: draggable || undefined,
    onDragStart: draggable
      ? (event) => {
          event.dataTransfer?.setData('text/plain', dragValue)
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
          onDragStart?.()
        }
      : undefined,
    onDragEnd: draggable ? () => onDragEnd?.() : undefined,
  },
  h('span', { className: skin.top },
    h('span', { className: skin.id }, idText),
    topExtra,
    badge ? h('span', { className: skin.badge, 'data-badge': card?.badge ?? undefined }, badge) : null),
  h('span', { className: skin.title }, card?.title || emptyTitle),
  labels.length
    ? h('span', { className: skin.labels }, labels.map(name => h('span', { key: name, className: skin.label, 'data-label': name }, name)))
    : null,
  card?.owner ? h('span', { className: skin.owner, 'data-kind': card.ownerKind ?? 'human' }, card.owner) : null,
  note ? h('span', { className: skin.note ?? skin.linked }, note) : null,
  meta,
  card?.linked ? h('span', { className: skin.linked }, t('linked to #{number}', { number: card.linked })) : null,
  card?.sha ? h('span', { className: skin.sha }, card.sha) : null,
  card?.url ? h('a', { className: skin.sha, href: card.url, target: '_blank', rel: 'noreferrer' }, t('open on GitHub')) : null,
  footer,
  actions)
}

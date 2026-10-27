// The task board's card frame. A card says `source: 'task'` and carries `data-key`, and the
// board passes `TASK_SKIN` so the markup stays on this board's class names.
import { createElement as h } from 'react'

export const TASK_SKIN = {
  card: 'bt-board-card', top: 'bt-board-card-top', id: 'bt-board-id', badge: 'bt-board-badge',
  title: 'bt-board-title', labels: 'bt-board-labels', label: 'bt-board-label', owner: 'bt-board-who',
  note: 'bt-board-note',
}

// `attrs` is the board's own extra attributes (a task's `data-column`), so the existing
// selectors and tests keep reading the same elements.
export function BoardCard({
  card, skin = TASK_SKIN, attrs = {}, idText = '', topExtra = null, badge = '',
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
  note ? h('span', { className: skin.note }, note) : null,
  meta,
  footer,
  actions)
}

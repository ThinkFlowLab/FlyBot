// Filters for the sidebar session list. Only kinds the list already has:
// rooms are group chats, Bots and the coding agent are direct chats, and
// unread uses the same marks the rows already draw (completion, a pending
// bot interaction, or a manual unread mark). There is no separate "read"
// filter: it would only be the complement of unread.

export const SESSION_FILTERS = ['all', 'group', 'direct', 'unread']

export function sessionStatusOf(map, id) {
  if (id == null || map == null) return undefined
  if (typeof map.get === 'function') return map.get(id)
  return map[id]
}

// Session id for a Bot row matches currentPart in the client: sessionId ?? id.
export function sessionIsUnread(entry, statusMap, markedUnread) {
  const item = entry?.item
  if (!item) return false
  if (markedUnread?.[item.id]) return true
  if (entry.kind === 'agent') {
    return (item.sessions ?? []).some(id => sessionStatusOf(statusMap, id)?.completionUnread === true)
  }
  if (entry.kind === 'room') {
    return sessionStatusOf(statusMap, item.id)?.completionUnread === true
  }
  const part = item.sessionId ?? item.id
  const status = sessionStatusOf(statusMap, part)
  return status?.completionUnread === true || status?.pendingInteraction !== undefined
}

export function matchesSessionFilter(entry, filter, unread = false) {
  if (filter === 'group') return entry?.kind === 'room'
  if (filter === 'direct') return entry?.kind === 'bot' || entry?.kind === 'agent'
  if (filter === 'unread') return unread === true
  return true
}

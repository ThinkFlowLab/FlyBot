// Actions a message toolbar, overflow, or right-click menu may offer. Only ids the
// client can actually run belong here: a reaction stored in local UI state, a quote
// into the open composer, or a copy/download of the message text. There is no host
// API to translate, forward, save to Artifacts, recall, re-edit a turn, pin a
// message, or report one, so those ids are never returned.

export const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export function hasMessageText(text) {
  return String(text ?? '').trim() !== ''
}

export function isLockedRoster(roster) {
  return typeof roster?.readOnly === 'string' && roster.readOnly.trim() !== ''
}

// A user bubble only gets a reaction key when the turn identity is stable across reloads.
export function userMessageReactKey(sessionId, node) {
  if (sessionId == null || sessionId === '') return undefined
  const location = node?.location
  const rawTurn = location && (location.kind === 'turn' || location.kind === 'step' || location.turn != null)
    ? location.turn
    : node?.data?.turn
  const turn = typeof rawTurn === 'object' ? rawTurn?.turn : rawTurn
  if (!Number.isInteger(turn) || turn < 0) return undefined
  return `${sessionId}:${turn}:user`
}

export function messageActionIds({
  text,
  sessionId,
  canReact = false,
  canReply = false,
  locked = false,
} = {}) {
  const ids = []
  if (canReact) ids.push('react')
  if (canReply && sessionId && !locked && hasMessageText(text)) ids.push('reply')
  if (hasMessageText(text)) {
    ids.push('copy')
    ids.push('download')
  }
  return ids
}

export function hasMessageActions(flags) {
  return messageActionIds(flags).length > 0
}

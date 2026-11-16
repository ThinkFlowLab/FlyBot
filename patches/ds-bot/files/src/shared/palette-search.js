// Command-palette filters and empty copy. Message hits only come from
// turn outlines already in the session list; the UI must not claim a
// search across chats the host has not loaded.

export const PALETTE_FILTERS = ['all', 'chats', 'messages', 'commands']
export const PALETTE_MESSAGE_MIN = 2

export function paletteFilterAllows(filter, kind) {
  if (filter === 'chats') return kind === 'chats'
  if (filter === 'messages') return kind === 'messages'
  if (filter === 'commands') return kind === 'commands'
  return true
}

// kind: 'empty' | 'short' | 'none'
export function paletteEmptyKind(query, filter, min = PALETTE_MESSAGE_MIN) {
  const wanted = String(query ?? '').trim()
  if (wanted === '') return 'empty'
  if (filter === 'messages' && wanted.length < min) return 'short'
  return 'none'
}

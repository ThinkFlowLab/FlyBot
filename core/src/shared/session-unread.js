// Manual unread marks live in UI state (localStorage). Opening a chat
// clears the mark only when the session *becomes* active, so Mark as
// Unread on the open chat stays until the user leaves and comes back.
// completionUnread is a DSH flag that clears when the session is the
// main view; there is no host API to ack it without opening the chat.

export function shouldClearManualUnread({ active, wasActive, marked }) {
  return Boolean(marked) && active === true && wasActive !== true
}

// The id the sidebar stores in ui.unread: a Bot's roster id, a room id,
// or the coding agent's id — not a Bot's alternate sessionId.
export function unreadEntryId(roster, sessionId) {
  if (sessionId == null || sessionId === '') return sessionId
  if (roster?.byId?.[sessionId] || roster?.roomsById?.[sessionId]) return sessionId
  const bot = (roster?.bots ?? []).find(item => (item.sessionId ?? item.id) === sessionId)
  if (bot) return bot.id
  const agent = (roster?.agents ?? []).find(item => item.id === sessionId || (item.sessions ?? []).includes(sessionId))
  if (agent) return agent.id
  return sessionId
}

export function isManuallyUnread(unread, id) {
  return Boolean(id) && unread?.[id] === true
}

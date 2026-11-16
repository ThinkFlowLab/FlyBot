// Session pin is a host flag (`setFlags({ pinned })`). Only Bot and room rows the
// sidebar already pins may offer Pin/Unpin. Remote friend Bots, the main-Bot tile,
// agent sessions, and a read-only window have no such write.

import { isLockedRoster } from './message-actions.js'

export function sessionPinTarget(roster, sessionId) {
  if (sessionId == null || sessionId === '') return null
  return roster?.byId?.[sessionId] ?? roster?.roomsById?.[sessionId] ?? null
}

export function canPinSession(roster, sessionId) {
  if (isLockedRoster(roster)) return false
  const entry = sessionPinTarget(roster, sessionId)
  if (entry == null) return false
  if (roster?.byId?.[sessionId]?.remote) return false
  if (roster?.mainBotId === sessionId) return false
  return true
}

export function sessionPinned(roster, sessionId) {
  return sessionPinTarget(roster, sessionId)?.pinned === true
}

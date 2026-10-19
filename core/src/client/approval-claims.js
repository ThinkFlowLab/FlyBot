// Which approvals a chat draws itself, so the overlay draws no second card or pointer for them
// (#260), and which chats are open (#271). Free of the slot components: a chat cell imports it (#418).
const claims = new Map()
const claimListeners = new Set()
// Chats open right now (a session dock is mounted for them): the pointer never points at the chat you are in (#271).
const openChats = new Map()
const changed = () => { for (const fn of [...claimListeners]) fn() }
export function chatOpened(sessionId, delta) {
  const count = (openChats.get(sessionId) ?? 0) + delta
  if (count > 0) openChats.set(sessionId, count)
  else openChats.delete(sessionId)
  changed()
}
export const claimedIds = () => Object.assign(new Set([...claims.values()].flatMap(ids => [...ids])), { chats: new Set(openChats.keys()) })
export function claimApprovals(owner, ids) {
  if (!Array.isArray(ids) || ids.length === 0) claims.delete(owner)
  else claims.set(owner, new Set(ids.map(String)))
  changed()
}
export function onClaims(fn) {
  claimListeners.add(fn)
  return () => { claimListeners.delete(fn) }
}

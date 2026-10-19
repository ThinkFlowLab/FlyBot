// A friend's 1:1 chat waiting on its reply (#443): the host sets roster.remoteAwaiting[chat] when my
// message leaves and clears it when the reply is written back. A reply that never comes does not
// leave the thinking row up for good.
export const AWAIT_REPLY_MS = 10 * 60 * 1000

export function awaitingReply(roster, sessionId, now = Date.now()) {
  const at = roster?.remoteAwaiting?.[sessionId]
  if (typeof at !== 'number' || roster?.byId?.[sessionId]?.remote === undefined) return false
  return now - at < AWAIT_REPLY_MS
}

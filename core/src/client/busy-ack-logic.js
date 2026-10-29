// Pure busy-ack helpers (#1584). Kept free of React so unit tests import them without a DOM.

// No canned sentence: until the host's context-aware ack arrives the bubble is
// only the Bot's mark and a short blinking indicator (#1656).
export function busyAckText(hostAck) {
  return typeof hostAck?.text === 'string' ? hostAck.text.trim() : ''
}

export function busyAckPending(hostAck) {
  return busyAckText(hostAck) === ''
}

export function pendingBusyPlacement(submissions) {
  if (!Array.isArray(submissions)) return false
  return submissions.some(item => item?.placement === 'queued' || item?.placement === 'steering')
}

export function busyAckVisible({ hostAck, pendingBusy, streamingText }) {
  if (streamingText) return false
  return busyAckText(hostAck) !== '' || pendingBusy === true
}

// The ack a room flow draws on its member's row (#1646). The host publishes `room.busyAcks`
// keyed by the member while that member's turn runs in the room; an entry whose text is still
// empty means the host's line is not composed yet, which the client draws the way #1656 draws
// a pending own-chat ack: the mark and the blinking indicator, no fixed sentence.
export function roomBusyAck(room) {
  const entries = Object.entries(room?.busyAcks ?? {}).filter(([, ack]) => ack !== undefined && ack !== null)
  if (entries.length === 0) return null
  const [botId, ack] = entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0]
  return { botId, text: busyAckText(ack), at: ack.at ?? 0 }
}

// A room's ack is drawn while that member's turn runs: the host's line as text, or the blinking
// indicator alone while the person's line is still queued in the room and the line is not here.
export function roomBusyAckVisible({ ack, pendingBusy }) {
  if (ack === null || ack === undefined) return false
  return ack.text !== '' || pendingBusy === true
}

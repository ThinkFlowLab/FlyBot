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

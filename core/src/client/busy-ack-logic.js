// Pure busy-ack helpers (#1584). Kept free of React so unit tests import them without a DOM.

export const BUSY_ACK_KEY = 'Got it — I’ll answer properly once I finish what’s in progress.'

export function pendingBusyPlacement(submissions) {
  if (!Array.isArray(submissions)) return false
  return submissions.some(item => item?.placement === 'queued' || item?.placement === 'steering')
}

export function busyAckVisible({ hostAck, pendingBusy, streamingText }) {
  if (streamingText) return false
  return Boolean(hostAck?.text) || pendingBusy === true
}

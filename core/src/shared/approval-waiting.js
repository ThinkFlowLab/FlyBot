// One rule for "this hold still waits for the owner's decision" (#734, #754). The host creates a
// hold with `pending`, while Bot Social's own outbound hold arrives as `pending_approval` — the
// spelling its plugin side already accepts. Host and client both import this file (the
// `shared/mentions.js` precedent), so they cannot drift apart again: a `pending_approval` hold used
// to be a decision button the host refused, a card that read "Not sent", a record cleaned up
// mid-wait, a cap that did not count it, and a wait badge that never saw it.
// Anything else (`approved`, `auto`, `failed`, `rejected`, `stale`, missing) is settled; `failed`
// keeps its own "Not sent: delivery failed" + Retry treatment.
export const WAITING_STATUSES = Object.freeze(['pending', 'pending_approval'])

export function isApprovalWaiting(status) {
  return WAITING_STATUSES.includes(status)
}

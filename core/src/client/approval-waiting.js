// One rule for "this hold still waits for the owner's decision" (#734). The host creates a hold
// with `pending`, while Bot Social's own outbound hold arrives as `pending_approval` — the spelling
// its plugin side already accepts. The held-reply card and the approvals dock both ask this, so the
// two spellings cannot drift apart again: a `pending_approval` hold used to be drawn as a settled
// "Not sent" note with no Approve or Reject, and the dock skipped it.
// Anything else (`approved`, `auto`, `failed`, `rejected`, `stale`, missing) is settled; `failed`
// keeps its own "Not sent: delivery failed" + Retry treatment.
export const WAITING_STATUSES = Object.freeze(['pending', 'pending_approval'])

export function isApprovalWaiting(status) {
  return WAITING_STATUSES.includes(status)
}

// A friend's 1:1 chat (#1087). The activity row stays up from my send until their
// reply, and that wait is often their home holding the reply for approval. This
// home cannot see that card, so the row says what the wait is for instead of
// drawing the generic thinking pool ("Sorting out the details").

export const REMOTE_APPROVAL_LABEL = 'Waiting for their approval'

// The phrase for that wait, or null when a local tool is the newest activity
// (its own line stays) or the chat is not a friend's.
export function remoteApprovalPhrase(remote, { tool, inputAt = 0 } = {}) {
  if (!remote) return null
  if (tool && inputAt <= (tool.at ?? 0)) return null
  return { key: 'remote-approval', label: REMOTE_APPROVAL_LABEL, state: 'thinking' }
}

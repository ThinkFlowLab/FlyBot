// Only explicit transport loss/unavailability or missing reconciliation evidence
// is recoverable. Assertion, storage and programming errors must remain visible.
export class RuntimeRecoveryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeRecoveryError'
  }
}

export function requireRuntimeEvidence(condition, message) {
  if (!condition) throw new RuntimeRecoveryError(message)
}

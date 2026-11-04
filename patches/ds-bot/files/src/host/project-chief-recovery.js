// Recovery facts and boundaries; no business role selection or second dispatcher.
import { createHash } from 'node:crypto'
export const scopeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function chiefRecoveryError(kind, message, { retryable = false, conditions = [], actions = [], ...facts } = {}) {
  return Object.assign(new Error(message), { code: 'bot/chief-recovery', recovery: { version: 'chief-recovery/v1', kind, retryable, conditions, actions, ...facts } })
}
export function nativeChiefBoundary(state, run) {
  const boundary = run.executionBoundary
  if (boundary) {
    if (boundary.version !== 'chief-execution-boundary/v1' || boundary.kind !== 'native-in-process' || boundary.runId !== run.id || boundary.invocation !== run.invocation || !boundary.botId || !boundary.sessionId || !Number.isSafeInteger(boundary.carrierGeneration)) return null
  } else if (boundary !== undefined || run.workerId !== `native-chief-job-${run.id}`) return null
  // A native host proof must never hide an independent worker, including a
  // worker registered before its handle was copied into the Chief Run.
  const workers = Object.values(state.projectHarnessWorkers ?? {}).filter(row => row.chiefRunId === run.id && (row.chiefInvocation === undefined || row.chiefInvocation === run.invocation))
  if (workers.length) return null
  const leases = Object.values(state.projectResourceLeases ?? {}).filter(row => row.chiefRunId === run.id && (row.chiefInvocation === undefined || row.chiefInvocation === run.invocation))
  const carrier = state.projectAgents?.[`public-${run.projectId}`], request = carrier?.lastRequest
  const selected = boundary ?? (request?.chiefRunId === run.id && request.chiefInvocation === run.invocation && !request.workerId ? { version: 'chief-execution-boundary/v1', kind: 'native-in-process', runId: run.id, invocation: run.invocation, botId: carrier.botId, sessionId: carrier.sessionId, carrierGeneration: carrier.carrierGeneration, exchangeId: request.exchangeId } : null)
  if (!selected || !Number.isSafeInteger(run.invocation) || run.invocation < 1) return null
  if (leases.some(row => row.projectId !== run.projectId || row.chiefInvocation !== run.invocation || row.worker?.kind !== 'native-turn' || row.worker.botId !== selected.botId || row.worker.sessionId !== selected.sessionId || row.worker.handle !== selected.exchangeId || row.preparation?.status === 'active')) return null
  return { boundary: selected, leases }
}

export function classifyChiefRecovery(error) {
  if (error.recovery) return structuredClone(error.recovery)
  const receipt = error.receiptFeedback?.kind
  if (receipt) return { version: 'chief-recovery/v1', kind: ['stale-snapshot', 'stale-or-foreign-batch'].includes(receipt) ? 'stale-snapshot' : ['foreign-input', 'source-revoked'].includes(receipt) ? 'authority-unavailable' : receipt === 'content-changed' ? 'source-changed' : 'input-protocol', retryable: false, conditions: ['fresh scoped snapshot; retain original input state and receipt history'], actions: ['Chief reassesses current facts; never rebase an old receipt'] }
  const message = String(error.message)
  const kind = /stale|generation|snapshot.*changed/i.test(message) ? 'stale-snapshot' : /worker.*exit|confirmed.*exit|unreachable/i.test(message) ? 'worker-exit-unknown' : /interrupted delivery|candidate.*missing|matching passing tests/i.test(message) ? 'unsupported-route' : ['bot/forbidden', 'bot/delegation', 'bot/execution-revoked'].includes(error.code) ? 'authority-unavailable' : ['bot/resource', 'bot/busy'].includes(error.code) ? 'resource-unavailable' : 'execution-failed'
  return { version: 'chief-recovery/v1', kind, retryable: ['worker-exit-unknown', 'resource-unavailable'].includes(kind), conditions: kind === 'worker-exit-unknown' ? ['matching exit proof; absence of a host controller is insufficient'] : kind === 'stale-snapshot' ? ['fresh scoped snapshot'] : ['inspect current scoped evidence'], actions: kind === 'unsupported-route' ? ['select an evidence-supported role or rework explicitly'] : [] }
}

// Optional operator corroboration for pre-namespace records; scoped to one exact
// old native invocation. It is not a PID-only exit claim or a public Bot grant.
export function corroboratedNativeScope(scope, run, configuration) {
  if (scope?.pidNamespace !== undefined || configuration === undefined) return scope
  if (!Array.isArray(configuration) || configuration.length > 20) throw new Error('legacyNativeScopes must contain at most20 exact operator attestations')
  const selected = configuration.find(row => row.runId === run.id && row.invocation === run.invocation && row.scopeSha256 === scopeDigest(scope))
  if (!selected) return scope
  if (!/^pid:\[\d+\]$/.test(selected.pidNamespace ?? '') || scope?.kind !== 'unmanaged-process') throw new Error('Legacy native namespace corroboration is invalid')
  return { ...scope, pidNamespace: selected.pidNamespace }
}

export function progressCheckpoint(history = []) {
  let checkpoint = 0, lastMeaningfulProgressAt = null, progressEvidence = []
  const seen = new Set()
  for (const [index, receipt] of history.entries()) {
    const fresh = (receipt.evidence ?? []).filter(row => row.kind === 'host-tests' && row.passed === true && typeof row.sha === 'string' && typeof row.sha256 === 'string' && !seen.has(row.sha))
    for (const row of fresh) seen.add(row.sha)
    if (fresh.length) { checkpoint = index + 1; lastMeaningfulProgressAt = receipt.createdAt; progressEvidence = fresh.map(row => ({ handoffId: receipt.id, sha: row.sha, testLogSha256: row.sha256 })) }
  }
  return { checkpoint, lastMeaningfulProgressAt, progressEvidence }
}

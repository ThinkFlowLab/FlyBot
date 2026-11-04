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

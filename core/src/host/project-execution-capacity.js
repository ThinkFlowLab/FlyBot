// Waiting is a Chief/Task decision. Capacity suspension additionally requires host exit facts.
import { confirmedWorkerExit } from './project-task-sessions.js'
import { nativeExitConfirmed } from './project-native-sessions.js'
export function attemptIdle(state, attemptId) {
  const attempt = state.projectAttempts?.[attemptId], task = state.tasks?.[attempt?.taskId]
  if (!attempt || !task || task.projectId !== attempt.projectId) return false
  if (attempt.workflowDefinition && Object.values(state.projectExecutions ?? {}).some(row => row.attemptId === attemptId && ['queued', 'running', 'working', 'paused', 'legacy'].includes(row.status))) return false
  const leases = Object.values(state.projectResourceLeases ?? {}).filter(row => row.attemptId === attemptId && row.role !== 'chief')
  const sdk = Object.values(state.projectHarnessWorkers ?? {}).filter(row => row.attemptId === attemptId && row.role !== 'chief')
  const native = Object.values(state.projectNativeWorkers ?? {}).filter(row => row.attemptId === attemptId && row.role !== 'chief')
  if (Object.values(state.bots ?? {}).some(row => row.ephemeral && row.attemptId === attemptId && row.role !== 'chief')) return false
  if (sdk.some(row => !confirmedWorkerExit(state, row) || !leases.some(lease => lease.id === row.leaseId && lease.status === 'released' && lease.generation === row.generation && lease.worker?.handle === row.id))) return false
  if (native.some(row => !nativeExitConfirmed(state, row))) return false
  if (leases.some(row => row.status !== 'released' || row.worker && !['sdk', 'native'].includes(row.worker.kind) || row.worker?.kind === 'sdk' && !sdk.some(worker => worker.id === row.worker.handle) || row.worker?.kind === 'native' && !native.some(worker => worker.id === row.worker.botId) || !row.worker && row.releaseProof?.kind !== 'unbound-reservation-release')) return false
  const claim = task.collaboration?.claim
  if (claim?.workerId && claim.role !== 'chief' && !claim.chiefRunId && !sdk.some(row => row.id === claim.workerId) && !native.some(row => row.id === claim.workerId)) return false
  if (claim?.status === 'active' && !claim.workerId && !claim.chiefRunId) return false
  // All adapters register before external execution; no records means no worker started.
  return true
}
export function capacitySuspended(state, attempt) {
  const task = state.tasks?.[attempt.taskId]
  return Boolean(attempt.capacityWait && attempt.capacityWait.status !== 'admitted' && task?.deliveryAttemptId === attempt.id && attemptIdle(state, attempt.id))
}

import { progressCheckpoint } from './project-chief-recovery.js'
// Mechanical inspection lifecycle; no business routing or automatic human escalation.
export const INSPECTION_LIFECYCLE = { queueTimeoutMs: 600000, runTimeoutMs: 900000, recoveryDelayMs: 5000, maxRecoveries: 2, stopTimeoutMs: 10000, maxStopAttempts: 3, overdueMs: 3600000 }
export function inspectionLifecycle(inspection) {
  if (inspection?.lifecycle !== undefined && (!inspection.lifecycle || typeof inspection.lifecycle !== 'object' || Array.isArray(inspection.lifecycle))) throw new Error('Invalid Chief inspection lifecycle configuration')
  const value = { ...INSPECTION_LIFECYCLE, ...inspection?.lifecycle }
  for (const [key, number] of Object.entries(value)) if (!(key in INSPECTION_LIFECYCLE) || !Number.isSafeInteger(number) || number < (['maxRecoveries', 'maxStopAttempts'].includes(key) ? 0 : 1) || number > (key === 'maxRecoveries' ? 4 : key === 'maxStopAttempts' ? 10 : 86400000)) throw new Error('Invalid Chief inspection lifecycle configuration: ' + key)
  return value
}
export function inspectionHealth(state, projectId, now = Date.now()) {
  const policy = state.projectChiefPolicies?.[projectId], config = inspectionLifecycle(policy?.inspection)
  const schedule = state.projectScheduledTasks?.[policy?.scheduleId]
  const runs = Object.values(state.projectExecutions ?? {}).filter(row => row.projectId === projectId && row.kind === 'chief-control' && row.purpose === 'inspection')
  const deliveries = Object.values(schedule?.deliveries ?? {})
  const last = values => values.filter(Number.isFinite).sort((a,b) => b-a)[0] ?? null
  const lastSuccessAt = last(runs.filter(row => row.status === 'done').map(row => row.finishedAt))
  const enabled = Boolean(policy?.enabled && schedule?.enabled)
  const anchor = lastSuccessAt ?? policy?.updatedAt ?? schedule?.createdAt ?? now
  const active = runs.filter(row => (['queued', 'running', 'correction-pending', 'interrupted'].includes(row.status) || row.recovery?.exitConfirmed === false)).map(row => ({ runId: row.id, occurrenceId: row.source?.occurrenceId ?? null, status: row.status, waitingFor: row.waitingFor ?? null, ageMs: Math.max(0, now - (row.startedAt ?? row.createdAt)), failure: row.failure ?? null, recovery: row.recovery ?? null, recoveryIssue: row.recoveryIssue ?? null, nextRecoveryAt: row.recovery?.exitConfirmed === false ? (row.recovery.stopAttempts ?? 0) < config.maxStopAttempts ? row.recovery.nextStopAt ?? row.recovery.notBefore ?? null : null : row.recovery?.notBefore ?? null, deadlineAt: (row.status === 'queued' ? (row.queuedAt ?? row.createdAt) + config.queueTimeoutMs : (row.startedAt ?? row.createdAt) + config.runTimeoutMs) }))
  const latestDelivery = deliveries.toSorted((a,b) => (b.at ?? 0) - (a.at ?? 0))[0]
  const latest = runs.toSorted((a,b) => b.createdAt - a.createdAt)[0]
  return { enabled, status: !enabled ? 'disabled' : now - anchor > config.overdueMs ? 'overdue' : active.some(row => row.status === 'interrupted' || row.recovery?.exitConfirmed === false || row.deadlineAt <= now) || latestDelivery?.status === 'failed' && (latestDelivery.finishedAt ?? latestDelivery.at) >= (lastSuccessAt ?? 0) || ['failed', 'partial', 'incomplete'].includes(latest?.status) ? 'degraded' : lastSuccessAt === null ? 'pending' : 'healthy', lastOccurrenceAt: last(deliveries.map(row => row.at)), lastStartedAt: last(runs.map(row => row.startedAt)), lastCompletedAt: last(runs.map(row => row.finishedAt)), lastSuccessAt, lastMeaningfulProgressAt: last(Object.values(state.tasks ?? {}).filter(row => row.projectId === projectId).map(row => progressCheckpoint(row.collaboration?.history).lastMeaningfulProgressAt)), lastAppliedDecisionAt: last(Object.values(state.projectChiefDecisions ?? {}).filter(row => row.projectId === projectId && row.status === 'applied' && !['continue', 'needs-human'].includes(row.action)).map(row => row.finishedAt)), overdueMs: config.overdueMs, active }
}

export function scheduledInspectionState(state, row, delivery) {
  const run = delivery.runId && state.projectExecutions?.[delivery.runId] || Object.values(state.projectExecutions ?? {}).find(run => run.kind === 'chief-control' && run.projectId === row.projectId && run.source?.scheduleId === row.id && run.source?.occurrenceId === delivery.id)
  if (!run) return null
  return { runId: run.id, status: run.status === 'done' ? 'completed' : ['queued', 'running', 'correction-pending'].includes(run.status) ? 'running' : 'failed', error: run.failure ?? null, recovery: run.recovery ?? null }
}

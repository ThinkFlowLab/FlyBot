// Mechanical inspection lifecycle; no business routing or automatic human escalation.
export const INSPECTION_LIFECYCLE = { queueTimeoutMs: 600000, runTimeoutMs: 900000, recoveryDelayMs: 5000, maxRecoveries: 2, overdueMs: 3600000 }
export function inspectionLifecycle(inspection) {
  const value = { ...INSPECTION_LIFECYCLE, ...inspection?.lifecycle }
  for (const [key, number] of Object.entries(value)) if (!(key in INSPECTION_LIFECYCLE) || !Number.isSafeInteger(number) || number < (key === 'maxRecoveries' ? 0 : 1) || number > (key === 'maxRecoveries' ? 4 : 86400000)) throw new Error('Invalid Chief inspection lifecycle configuration: ' + key)
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
  const active = runs.filter(row => ['queued', 'running', 'correction-pending', 'interrupted'].includes(row.status)).map(row => ({ runId: row.id, occurrenceId: row.source?.occurrenceId ?? null, status: row.status, ageMs: Math.max(0, now - (row.startedAt ?? row.createdAt)), failure: row.failure ?? null, recovery: row.recovery ?? null, deadlineAt: (row.status === 'queued' ? (row.queuedAt ?? row.createdAt) + config.queueTimeoutMs : (row.startedAt ?? row.createdAt) + config.runTimeoutMs) }))
  const latest = runs.toSorted((a,b) => b.createdAt - a.createdAt)[0]
  return { enabled, status: !enabled ? 'disabled' : now - anchor > config.overdueMs ? 'overdue' : active.some(row => row.status === 'interrupted' || row.deadlineAt <= now) || ['failed', 'partial', 'incomplete'].includes(latest?.status) ? 'degraded' : lastSuccessAt === null ? 'pending' : 'healthy', lastOccurrenceAt: last(deliveries.map(row => row.at)), lastStartedAt: last(runs.map(row => row.startedAt)), lastCompletedAt: last(runs.map(row => row.finishedAt)), lastSuccessAt, lastAppliedDecisionAt: last(Object.values(state.projectChiefDecisions ?? {}).filter(row => row.projectId === projectId && row.status === 'applied' && !['continue', 'needs-human'].includes(row.action)).map(row => row.finishedAt)), overdueMs: config.overdueMs, active }
}

export function scheduledInspectionState(state, row, delivery) {
  const run = delivery.runId && state.projectExecutions?.[delivery.runId] || Object.values(state.projectExecutions ?? {}).find(run => run.kind === 'chief-control' && run.projectId === row.projectId && run.source?.scheduleId === row.id && run.source?.occurrenceId === delivery.id)
  if (!run) return null
  return { runId: run.id, status: run.status === 'done' ? 'completed' : ['queued', 'running', 'correction-pending'].includes(run.status) ? 'running' : 'failed', error: run.failure ?? null, recovery: run.recovery ?? null }
}

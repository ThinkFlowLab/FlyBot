import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectionLifecycle, inspectionHealth } from '../src/host/project-chief-lifecycle.js'
test('inspection configuration bounds deadlines/recovery and health distinguishes enablement from success', () => {
  for (const lifecycle of [{ maxRecoveries: 5 }, { stopTimeoutMs: 0 }, { maxStopAttempts: 11 }, { runTimeoutMs: 0 }, { recoveryDelayMs: -1 }, { overdueMs: Infinity }, { unknown: 1 }]) assert.throws(() => inspectionLifecycle({ lifecycle }), /Invalid/)
  const state = { projectChiefPolicies: { p: { enabled: true, scheduleId: 's', updatedAt: 100, inspection: { lifecycle: { overdueMs: 1000 } } } }, projectScheduledTasks: { s: { enabled: true, deliveries: {} } }, projectExecutions: {}, projectChiefDecisions: {} }
  assert.equal(inspectionHealth(state, 'p', 200).status, 'pending')
  assert.equal(inspectionHealth(state, 'p', 2000).status, 'overdue')
  state.projectExecutions.r = { id: 'r', projectId: 'p', kind: 'chief-control', purpose: 'inspection', createdAt: 200, startedAt: 201, status: 'done', finishedAt: 500 }
  assert.equal(inspectionHealth(state, 'p', 600).status, 'healthy')
  assert.equal(inspectionHealth(state, 'p', 600).lastAppliedDecisionAt, null)
  state.projectExecutions.r.status = 'partial'
  assert.equal(inspectionHealth(state, 'p', 600).status, 'degraded')
  state.projectScheduledTasks.s.enabled = false; assert.equal(inspectionHealth(state, 'p', 20000).status, 'disabled')
})

test('health retains unknown-exit cancellation and separates actual checkpoints from inspection or message churn', () => {
  const state = { projectChiefPolicies: { p: { enabled: true, scheduleId: 's', updatedAt: 100 } }, projectScheduledTasks: { s: { enabled: true } }, projectExecutions: { old: { id: 'old', projectId: 'p', kind: 'chief-control', purpose: 'inspection', createdAt: 100, status: 'cancelled', recovery: { exitConfirmed: false, stopAttempts: 3 } } }, tasks: { t: { projectId: 'p', collaboration: { history: [{ createdAt: 120, evidence: [{ kind: 'host-tests', passed: true, sha: 'candidate', sha256: 'log' }] }, { createdAt: 150, evidence: [{ kind: 'host-tests', passed: true, sha: 'candidate', sha256: 'second-log' }] }] } } } }
  const health = inspectionHealth(state, 'p', 200)
  assert.equal(health.status, 'degraded'); assert.equal(health.active[0].nextRecoveryAt, null)
  assert.equal(health.lastMeaningfulProgressAt, 120); assert.equal(health.lastSuccessAt, null)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectionLifecycle, inspectionHealth } from '../src/host/project-chief-lifecycle.js'
test('inspection configuration bounds deadlines/recovery and health distinguishes enablement from success', () => {
  for (const lifecycle of [{ maxRecoveries: 5 }, { runTimeoutMs: 0 }, { recoveryDelayMs: -1 }, { overdueMs: Infinity }, { unknown: 1 }]) assert.throws(() => inspectionLifecycle({ lifecycle }), /Invalid/)
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

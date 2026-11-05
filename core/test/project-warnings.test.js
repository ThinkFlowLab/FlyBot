import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectWarnings } from '../src/host/project-warnings.js'
import { createProjectEffects } from '../src/host/project-effects.js'
function fixture() {
  let clock = 1
  const state = { tasks: { t: { id: 't', projectId: 'p', status: 'working', deliveryAttemptId: 'a', collaboration: { generation: 1, status: 'claimed', history: [], claim: { id: 'c', status: 'active', workerId: 'w', createdAt: 1 } } } }, projectAttempts: { a: { id: 'a', projectId: 'p', taskId: 't', status: 'running', evidence: {}, workspaces: {} } }, projectHarnessWorkers: { w: { id: 'w', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', harness: 'codex', generation: 1, status: 'running', executionStartedAt: 1, lastEventAt: 1 } }, projectChiefPolicies: { p: { enabled: true, inspection: { thresholds: { maxHandoffsWithoutProgress: 4, longExecutionMs: 999999999, missingHeartbeatMs: 999999999, longWaitMs: 999999999 } } } } }
  const notices = [], rt = { state, config: {}, readOnly: () => undefined, requireProjectAccess: (actor, id) => { if (actor.memberId !== 'owner' || id !== 'p') throw Error('Denied') }, projectCan: actor => actor.memberId === 'owner', readProject: () => ({ id: 'p', status: 'active', ownerUserId: 'owner' }), projectChiefControl: { request: async (...args) => { notices.push(args); return { id: 'chief' } } } }
  rt.projectEffects = createProjectEffects(rt, { now: () => clock })
  rt.save = async () => { const capture = rt.projectEffects.capture(); rt.projectEffects.saved(capture) }
  rt.projectWarnings = createProjectWarnings(rt, { now: () => clock })
  return { rt, state, notices, tick: value => { clock = value } }
}
test('one persisted warning path emits hourly SDK summaries without ending the worker', async () => {
  const f = fixture()
  f.tick(3600001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  let rows = Object.values(f.state.projectWarnings)
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'sdk-duration')
  assert.equal(f.state.projectHarnessWorkers.w.status, 'running')
  assert.equal(f.notices.length, 1)
  await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain(); assert.equal(f.notices.length, 1)
  f.tick(7200001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  rows = Object.values(f.state.projectWarnings); assert.equal(rows.length, 2); assert.equal(f.notices.length, 2)
})

test('shared disclosure protects scope, pages evidence and marks old execution historical', async () => {
  const f = fixture(), actor = { memberId: 'owner' }
  f.state.projectAttempts.a.evidence.tests = { passed: false, sha: 'old', stdout: 'sk-fixturesecret1234567890', password: 'never-display', log: '/private/log' }
  f.tick(3600001); await f.rt.projectWarnings.reconcile()
  const list = await f.rt.projectWarnings.query({ projectId: 'p' }, actor), head = list.items[0]
  assert(head.blockers.some(s => s.includes('Tests did not pass')))
  const page = await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id, topic: 'progress', limit: 50 }, actor)
  assert.equal(page.text.length, 50); assert(page.nextOffset)
  const tail = await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id, topic: 'progress', offset: page.nextOffset, sha256: page.sha256 }, actor)
  assert(!tail.text.includes('fixturesecret')); assert(!tail.text.includes('never-display')); assert(!tail.text.includes('/private/log'))
  const unchanged = await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id, topic: 'progress', ifNoneMatch: page.sha256 }, actor)
  assert.equal(unchanged.notModified, true); assert.equal(unchanged.text, '')
  await assert.rejects(f.rt.projectWarnings.query({ projectId: 'foreign', warningId: head.id }, actor), /Denied/)
  await assert.rejects(f.rt.projectWarnings.query({ projectId: 'p' }, { memberId: 'member' }), /Denied/)
  await assert.rejects(f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id, topic: 'progress', sha256: 'old' }, actor), /changed/)
  f.state.tasks.t.collaboration.generation++
  assert.equal((await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id }, actor)).historical, true)
  await assert.rejects(f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, expectedScope: head.expectedScope, action: 'stop', requestId: 'stop' }, actor), /scope changed/)
})
test('Chief queue and execution duration warnings do not mutate runs and reach the human mailbox without Chief', async () => {
  const f = fixture(); f.state.projectHarnessWorkers = {}
  f.state.projectExecutions = { q: { id: 'q', projectId: 'p', kind: 'chief-control', purpose: 'inspection', status: 'queued', invocation: 0, createdAt: 1 }, r: { id: 'r', projectId: 'p', kind: 'chief-control', purpose: 'inspection', status: 'running', invocation: 1, createdAt: 1, startedAt: 1 } }
  f.tick(900001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  assert.equal(f.notices.length, 0)
  assert.equal(f.state.projectExecutions.q.status, 'queued'); assert.equal(f.state.projectExecutions.r.status, 'running')
  const rows = Object.values(f.state.projectWarnings)
  assert.equal(rows.length, 2); assert(rows.every(w => w.delivery.kind === 'human-mailbox'))
  await f.rt.projectWarnings.reconcile(); assert.equal(Object.values(f.state.projectWarnings).length, 2)
})
test('merge warnings repeat every two hours and failed checks remain visible without claiming merge success', async () => {
  const f = fixture(); f.state.projectHarnessWorkers = {}; f.state.tasks.t.collaboration.claim = null
  f.state.projectAttempts.a.merge = { createdAt: 1, status: 'waiting', reason: 'required-check-failed', observation: { checks: [{ name: 'test', state: 'failure' }] } }
  f.tick(7200001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  assert.equal(Object.values(f.state.projectWarnings)[0].kind, 'merge-wait')
  const head = (await f.rt.projectWarnings.query({ projectId: 'p' }, { memberId: 'owner' })).items[0]
  assert(head.blockers.includes('required-check-failed'))
  f.tick(14400001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  assert.equal(Object.values(f.state.projectWarnings).length, 2)
  f.state.projectAttempts.a.merge.status = 'merged'
  assert((await f.rt.projectWarnings.query({ projectId: 'p' }, { memberId: 'owner' })).items.every(w => w.historical))
})
test('failed warning persistence cannot notify; recovering the original Effects does not duplicate delivery', async () => {
  const f = fixture(), save = f.rt.save
  f.tick(3600001); f.rt.save = async () => { throw Error('disk failed') }
  await assert.rejects(f.rt.projectWarnings.reconcile(), /disk failed/)
  await f.rt.projectEffects.drain(); assert.equal(f.notices.length, 0); assert.equal(Object.keys(f.state.projectWarnings).length, 0)
  f.rt.save = save; await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  f.rt.projectWarnings = createProjectWarnings(f.rt, { now: () => 3600001 })
  await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  assert.equal(f.notices.length, 1)
})

test('explicit role stop preserves the Task and draft and never treats unknown exit as released', async () => {
  const f = fixture(), actor = { memberId: 'owner' }
  f.tick(3600001); await f.rt.projectWarnings.reconcile()
  const head = (await f.rt.projectWarnings.query({ projectId: 'p' }, actor)).items[0]
  let stopped = 0
  f.rt.projectPools = { revokeExecution: async () => { stopped++; f.state.tasks.t.collaboration.claim.exitConfirmed = false } }
  const result = await f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, action: 'stop', requestId: 'stop-current', expectedScope: head.expectedScope }, actor)
  assert.equal(stopped, 1); assert.equal(result.stopped, false); assert.equal(result.waitingFor, 'worker-exit')
  assert.equal(f.state.tasks.t.status, 'working'); assert.equal(f.state.projectAttempts.a.status, 'interrupted')
  assert.equal(f.state.tasks.t.collaboration.claim.status, 'interrupted')
  await assert.rejects(f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, action: 'stop', requestId: 'again', expectedScope: head.expectedScope }, actor), /active execution/)
})
test('task attention reports repeated handoffs and long waits through the same warning disclosure', async () => {
  const f = fixture(); f.state.projectHarnessWorkers = {}
  const c = f.state.tasks.t.collaboration
  c.claim = null; c.status = 'blocked'; c.history = Array.from({ length: 5 }, (_, i) => ({ createdAt: i + 1, from: 'developer', to: 'reviewer', reason: 'Missing dependency', evidence: [] }))
  f.tick(1000000100); await f.rt.projectWarnings.reconcile()
  const warnings = (await f.rt.projectWarnings.query({ projectId: 'p' }, { memberId: 'owner' })).items
  assert(warnings.some(w => w.reason.includes('Repeated handoffs')))
  assert(warnings.some(w => w.reason.includes('wait')))
  const page = await f.rt.projectWarnings.query({ projectId: 'p', warningId: warnings[0].id, topic: 'handoffs' }, { memberId: 'owner' })
  assert(page.text.includes('Missing dependency'))
})

test('explicit warning read acknowledgement persists without claiming progress or completion', async () => {
  const f = fixture(), actor = { memberId: 'owner' }
  f.tick(3600001); await f.rt.projectWarnings.reconcile()
  const head = (await f.rt.projectWarnings.query({ projectId: 'p' }, actor)).items[0]
  assert.equal(head.declaredReads.length, 0)
  await f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, action: 'acknowledge', requestId: 'read', expectedScope: head.expectedScope }, actor)
  assert.equal((await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id }, actor)).declaredReads.length, 1)
  assert.equal(f.state.tasks.t.status, 'working'); assert.equal(f.state.projectAttempts.a.evidence.tests, undefined)
})

test('disclosure validates page bounds and does not grant actions or read-only writes', async () => {
  const f = fixture(), actor = { memberId: 'owner' }
  f.tick(3600001); await f.rt.projectWarnings.reconcile()
  const head = (await f.rt.projectWarnings.query({ projectId: 'p' }, actor)).items[0]
  for (const args of [{ limit: 21 }, { offset: -1 }, { warningId: 'foreign' }, { warningId: head.id, topic: 'credentials' }, { warningId: head.id, topic: 'execution', limit: 8001 }, { warningId: head.id, topic: 'execution', offset: -1 }]) await assert.rejects(f.rt.projectWarnings.query({ projectId: 'p', ...args }, actor))
  const event = await f.rt.projectWarnings.query({ projectId: 'p', warningId: head.id, topic: 'events' }, actor)
  assert(event.text.includes('unavailable'))
  await assert.rejects(f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, expectedScope: head.expectedScope, action: 'delete', requestId: 'wrong' }, actor), /must be/)
  await assert.rejects(f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, expectedScope: head.expectedScope, action: 'inspect' }, actor), /stable requestId/)
  const inspect = await f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, expectedScope: head.expectedScope, action: 'inspect', requestId: 'inspect' }, actor)
  assert.equal(inspect.runId, 'chief')
  f.rt.readOnly = () => 'storage-refused'
  await assert.rejects(f.rt.projectWarnings.action({ projectId: 'p', warningId: head.id, expectedScope: head.expectedScope, action: 'stop', requestId: 'read-only' }, actor), /read-only/)
  const count = Object.keys(f.state.projectWarnings).length
  f.tick(7200001); await f.rt.projectWarnings.reconcile(); assert.equal(Object.keys(f.state.projectWarnings).length, count)
})
test('superseded hourly messages retain history and pending deliveries cancel instead of notifying old executions', async () => {
  const f = fixture(); f.tick(3600001); await f.rt.projectWarnings.reconcile()
  const first = Object.values(f.state.projectWarnings)[0]
  f.tick(7200001); await f.rt.projectWarnings.reconcile(); await f.rt.projectEffects.drain()
  assert.equal(f.rt.projectWarnings.isCurrent(first.id), false)
  assert.equal(f.notices.length, 1)
  assert.equal(Object.values(f.state.projectWarnings).length, 2)
  assert.equal(f.rt.projectWarnings.summaries('p').length, 1)
})

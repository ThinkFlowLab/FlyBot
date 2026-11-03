import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectPools, POOL_PROTOCOL } from '../src/host/project-pools.js'
import { validateHandoff } from '../../plugins/workflow/src/pool-contract.js'
function setup() {
  const roles = ['chief', 'developer', 'tester', 'reviewer'].map(role => ({ id: `p:${role}`, role }))
  const task = { id: 'task', projectId: 'p', title: 'Repair code', criteria: 'Actual tests pass' }
  const rt = { state: { tasks: { task }, projectHarnessWorkers: {} }, config: {}, save: async () => {}, projectAgents: { deliveryDefinitions: () => ({ revision: 7, roles }) }, projects: { requireActive() {} }, requireProjectAccess(actor, projectId) { if (actor.memberId !== 'owner' || projectId !== 'p' || rt.revoked) throw new Error('Current authority denied') } }
  const pool = createProjectPools(rt), completed = []
  const adapter = { validate: validateHandoff, complete: async input => completed.push(input), release: async () => true, rework: async ({ claim }) => claim.attemptId }
  pool.connect(adapter)
  return { rt, task, pool, adapter, completed, admit: () => pool.admit({ id: 'attempt', taskId: 'task' }, { memberId: 'owner' }), claim: () => pool.claim('task', 'p:developer') }
}
test('a logical Bot owns its pool and exactly one concurrent claim succeeds', async () => {
  const f = setup(); await f.admit()
  assert.equal(f.task.collaboration.version, POOL_PROTOCOL)
  assert.equal(f.pool.available('p', 'p:reviewer', { memberId: 'owner' }).length, 0)
  assert.equal(f.pool.available('p', 'p:developer', { memberId: 'owner' }).length, 1)
  const claims = await Promise.all([f.claim(), f.claim()])
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(f.task.collaboration.history[0].status, 'accepted')
  assert.throws(() => f.pool.available('p', 'other-project:developer', { memberId: 'owner' }), /Target/)
})

test('persisted admission and downstream handoff wake the dispatcher without waiting for a timer', async () => {
  const f = setup(), destinations = []
  f.rt.projectScheduler = { wake() { destinations.push(f.task.collaboration.botId) } }
  await f.admit()
  const claim = await f.claim()
  await f.pool.decide('task', claim, { action: 'transfer', to: 'p:tester', reason: 'Inspect the candidate' })
  assert.deepEqual(destinations, ['p:developer', 'p:tester'])
})
test('non-DAG handoff, explicit return and Chief completion requests preserve the same Task', async () => {
  const f = setup(); await f.admit()
  const dev = await f.claim()
  await f.pool.decide('task', dev, { action: 'handoff', to: 'p:reviewer', reason: 'Review the design before testing' })
  const review = await f.pool.claim('task', 'p:reviewer')
  await f.pool.decide('task', review, { action: 'return', to: 'p:developer', reason: 'The negative case needs a regression' })
  const next = await f.claim()
  await f.pool.decide('task', next, { action: 'complete', reason: 'Request final criteria judgement' })
  assert.equal(Object.keys(f.rt.state.tasks).length, 1)
  assert.equal(f.task.collaboration.status, 'arbitration')
  assert.equal(f.task.collaboration.botId, 'p:chief')
  assert.notEqual(f.task.status, 'accepted')
  assert.deepEqual(f.task.collaboration.history.map(row => row.to), ['p:developer', 'p:reviewer', 'p:developer', 'p:chief'])
  assert.equal(f.completed.length, 2)
})
test('duplicate decisions have one effect, altered retries and stale claims cannot affect a successor', async () => {
  const f = setup(); await f.admit(); const first = await f.claim()
  const decision = { action: 'handoff', to: 'p:tester', reason: 'Run candidate tests' }
  const receipt = await f.pool.decide('task', first, decision)
  assert.equal((await f.pool.decide('task', first, decision)).id, receipt.id)
  assert.equal(f.completed.length, 1)
  await assert.rejects(f.pool.decide('task', first, { ...decision, reason: 'Changed intent' }), /idempotency/)
  const next = await f.pool.claim('task', 'p:tester')
  await assert.rejects(f.pool.decide('task', { ...next, generation: first.generation }, { action: 'complete', reason: 'Stale result' }), /stale/)
  assert.equal(f.task.collaboration.claim.id, next.id)
})
test('real handoff validator refuses missing acceptance evidence and leaves a recoverable block', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  f.task.poolAcceptance = { tester: { requires: [{ pr: 99, checks: 'tests-ok' }] } }
  await assert.rejects(f.pool.decide('task', claim, { action: 'handoff', to: 'p:tester', reason: 'Missing required green check', evidence: [{ pr: 99, checks: 'tests-ok' }] }), /missing-evidence/)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.history.length, 1)
})
test('revoked authority and unconfirmed worker exit preserve the claim and prevent transfer', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  f.task.collaboration.claim.workerId = 'live-worker'; f.adapter.release = async () => false
  await assert.rejects(f.pool.decide('task', claim, { action: 'handoff', to: 'p:tester', reason: 'Transfer while alive' }), /unconfirmed/)
  assert.equal(f.task.collaboration.claim.status, 'active')
  f.rt.revoked = true
  await assert.rejects(f.pool.decide('task', claim, { action: 'arbitrate', reason: 'Authority was removed' }), /authority/)
  assert.equal(f.task.collaboration.history.length, 1)
})
test('restart fences active claims, preserves receipts and never fabricates resource release', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  f.task.collaboration.claim.workerId = 'unknown-worker'
  assert.equal(f.pool.recover(), true); assert.equal(f.pool.recover(), false)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.claim.workerId, 'unknown-worker')
  await assert.rejects(f.pool.decide('task', claim, { action: 'complete', reason: 'Late callback' }), /stale/)
})
test('cycle and quota budgets gate actual transfers instead of producing shadow-only warnings', async () => {
  const f = setup(); f.rt.config.projectHandoff = { quota: { steps: 0 } }
  await f.admit()
  await assert.rejects(f.claim(), /quota/)
  assert.equal(f.task.collaboration.status, 'blocked')
})

test('a busy receiving resource leaves the Task pending without an idle worker claim', async () => {
  const f = setup(); f.adapter.ready = () => false; await f.admit()
  assert.equal(await f.claim(), null)
  assert.equal(f.task.collaboration.status, 'queued')
  assert.equal(f.task.collaboration.claim, undefined)
  assert.equal(f.task.collaboration.history[0].status, 'pending')
})

test('late native or SDK results stay on the original run surface after restart', async () => {
  const f = setup(); await f.admit(); await f.claim()
  f.task.collaboration.claim.workerId = 'retired-worker'
  f.pool.recover()
  assert.equal(f.pool.owns('retired-worker'), true)
  assert.equal(await f.pool.result({ botId: 'retired-worker', ok: true, text: 'OUTPUT handoff: {}' }), true)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.history.length, 1)
})

test('transfer can route an uncompleted role directly without claiming candidate evidence', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  await f.pool.decide('task', claim, { action: 'transfer', to: 'p:reviewer', reason: 'Need design review before implementation' })
  assert.equal(f.completed.length, 0)
  assert.equal(f.task.collaboration.botId, 'p:reviewer')
  assert.equal(f.task.collaboration.history[0].decision.action, 'transfer')
})

test('revocation fences an active worker before stopping it and retains unconfirmed capacity', async () => {
  const f = setup(); await f.admit(); const token = await f.claim()
  f.task.collaboration.claim.workerId = 'live-worker'
  let stopped = false
  f.adapter.release = async () => { stopped = true; assert.equal(f.task.collaboration.claim.status, 'revoked'); return false }
  await f.pool.revokePrincipal('p', 'owner')
  assert.equal(stopped, true); assert.equal(f.task.collaboration.claim.exitConfirmed, false)
  assert.equal(f.task.collaboration.status, 'blocked')
  await assert.rejects(f.pool.decide('task', token, { action: 'complete', reason: 'Late result after revocation' }), /stale/)
})

test('execution admission failure retires the claim and reaches Chief instead of leaving a phantom active worker', async () => {
  const f = setup(); await f.admit()
  f.adapter.execute = async () => { throw new Error('Pool Attempt is unavailable') }
  await f.pool.pump()
  assert.equal(f.task.collaboration.status, 'arbitration')
  assert.equal(f.task.collaboration.claim, undefined)
  const failed = f.task.collaboration.history[0]
  assert.equal(failed.status, 'rejected')
  assert.equal(failed.execution.status, 'failed')
  assert.equal(failed.execution.exitConfirmed, false, 'Failure before binding must not invent exit proof')
  assert.match(f.task.collaboration.history.at(-1).reason, /Pool Attempt is unavailable/)
})

test('dispatch failure fences late results and retains unconfirmed worker occupancy for Chief', async () => {
  const f = setup(); await f.admit()
  f.adapter.execute = async () => 'live-worker'
  f.adapter.dispatch = async () => { throw new Error('dispatch rejected') }
  f.adapter.release = async () => false
  await f.pool.pump()
  const failed = f.task.collaboration.history[0].execution
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitConfirmed, false)
  assert.equal(failed.workerId, 'live-worker')
  assert.equal(f.task.collaboration.status, 'arbitration')
  await assert.rejects(f.pool.decide('task', failed, { action: 'complete', reason: 'Late result' }), /stale/)
})

test('a successful new handoff clears stale blocking UI facts while retaining their audit', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  f.task.collaboration.block = { reason: 'Old failure' }; f.task.chiefQuestion = { decisionId: 'old-question' }
  await f.pool.decide('task', claim, { action: 'transfer', to: 'p:tester', reason: 'Prerequisite repaired' })
  assert.equal(f.task.collaboration.block, undefined); assert.equal(f.task.chiefQuestion, undefined)
  assert.equal(f.task.collaboration.history.at(-1).resolvedBlock.reason, 'Old failure')
  assert.equal(f.task.collaboration.history.at(-1).resolvedChiefQuestion.decisionId, 'old-question')
})

test('Chief route can resume pre-candidate work while explicit return requests a fresh Attempt', async () => {
  for (const rework of [false, true]) {
    const f = setup(); await f.admit(); await f.claim()
    f.rt.state.projectAttempts = { attempt: { id: 'attempt', status: 'running' } }
    f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
    let force
    f.adapter.rework = async input => { force = input.force; return 'attempt' }
    await f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:developer', expectedGeneration: f.task.collaboration.generation, reason: 'Host preparation repaired', decisionId: 'resume-' + rework, rework }, { memberId: 'owner' })
    assert.equal(force, rework)
  }
})

test('an audited Chief intervention starts a new bounded routing epoch without erasing history', async () => {
  const f = setup(); await f.admit(); await f.claim()
  f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
  f.rt.config.projectHandoff = { cycleMax: 0 }
  for (let i = 0; i < 4; i++) f.task.collaboration.history.push({ from: 'p:chief', to: 'p:developer', requestId: 'old-' + i, purpose: 'chief-intervention' })
  const oldHistory = structuredClone(f.task.collaboration.history)
  await f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:developer', expectedGeneration: f.task.collaboration.generation, reason: 'A verified environment repair permits recovery', decisionId: 'new-epoch', rework: false }, { memberId: 'owner' })
  assert.deepEqual(f.task.collaboration.history.slice(1, oldHistory.length), oldHistory.slice(1))
  assert.equal(f.task.collaboration.history[0].id, oldHistory[0].id)
  assert.equal(f.task.collaboration.history[0].status, 'intervened')
  assert.equal(f.task.collaboration.history.at(-1).purpose, 'chief-intervention')
  const dev = await f.claim()
  await f.pool.decide('task', dev, { action: 'transfer', to: 'p:tester', reason: 'Test the repaired implementation' })
  const tester = await f.pool.claim('task', 'p:tester')
  await f.pool.decide('task', tester, { action: 'transfer', to: 'p:developer', reason: 'A source correction is needed' })
  const dev2 = await f.claim()
  await assert.rejects(f.pool.decide('task', dev2, { action: 'transfer', to: 'p:tester', reason: 'Repeat without Chief intervention' }), /cycle-budget/)
  assert.equal(f.task.collaboration.status, 'blocked')
})

test('Chief routing admission refusal leaves the original claim and Attempt untouched', async () => {
  const f = setup(); await f.admit(); await f.claim()
  f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
  f.task.poolAcceptance = { tester: { requires: [{ pr: 99, checks: 'tests-ok' }] } }
  const before = structuredClone(f.task)
  let reworked = false
  f.adapter.rework = async () => { reworked = true; return 'new-attempt' }
  await assert.rejects(f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:tester', expectedGeneration: f.task.collaboration.generation, reason: 'Route with missing evidence', decisionId: 'refused-route' }, { memberId: 'owner' }), /missing-evidence/)
  assert.deepEqual(f.task, before)
  assert.equal(reworked, false)
})

test('a failed Chief rework records a recoverable block instead of leaving stopping forever', async () => {
  const f = setup(); await f.admit(); await f.claim()
  f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
  f.adapter.rework = async () => { throw new Error('Registered workspace could not be prepared') }
  await assert.rejects(f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:developer', expectedGeneration: f.task.collaboration.generation, reason: 'Resume after repair', decisionId: 'failed-rework', rework: false }, { memberId: 'owner' }), /could not be prepared/)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.block.decisionId, 'failed-rework')
  assert.match(f.task.collaboration.block.reason, /could not be prepared/)
})


test('Chief intervention does not reset global usage or bypass quota', async () => {
  const f = setup(); await f.admit(); await f.claim()
  f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
  f.rt.config.projectHandoff = { quota: { steps: 0 } }
  const before = structuredClone(f.task)
  await assert.rejects(f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:developer', expectedGeneration: f.task.collaboration.generation, reason: 'No quota remains', decisionId: 'quota-chief' }, { memberId: 'owner' }), /quota/)
  assert.deepEqual(f.task, before)
})


test('a retired source can finish its frozen active claim but cannot receive new offers', async () => {
  const f = setup(); await f.admit(); const claim = await f.claim()
  const roles = f.rt.projectAgents.deliveryDefinitions().roles
  const index = roles.findIndex(row => row.role === 'developer'), retired = roles.splice(index, 1)[0]
  f.rt.state.projectRetiredRoles = { 'p:developer': { ...retired, projectId: 'p', retiredAt: 1 } }
  await f.pool.decide('task', claim, { action: 'handoff', to: 'p:tester', reason: 'Complete original responsibility and request actual testing' })
  assert.equal(f.completed[0].role, 'developer')
  assert.equal(f.task.collaboration.botId, 'p:tester')
  const tester = await f.pool.claim('task', 'p:tester')
  await assert.rejects(f.pool.decide('task', tester, { action: 'return', to: 'p:developer', reason: 'Cannot hand off to an inactive role' }), /Target/)
})
test('queued work for a retired role becomes visibly blocked without reassignment or a new worker', async () => {
  const f = setup(); await f.admit()
  const roles = f.rt.projectAgents.deliveryDefinitions().roles
  roles.splice(roles.findIndex(row => row.role === 'developer'), 1)
  assert.equal(await f.claim(), null)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.botId, 'p:developer')
  assert.match(f.task.collaboration.block.reason, /Chief must explicitly/)
  assert.equal(f.task.collaboration.claim, undefined)
})

test('host execution revocation fences the exact claim before stopping and never infers exit or reassigns', async () => {
  const f = setup(); await f.admit(); const token = await f.claim()
  f.task.collaboration.claim.workerId = 'worker'
  const events = []
  f.rt.save = async () => { events.push('saved') }
  f.adapter.release = async workerId => { events.push('stop'); assert.equal(workerId, 'worker'); assert.equal(f.task.collaboration.claim.status, 'revoked'); assert.equal(events[0], 'saved'); return false }
  assert.equal(await f.pool.revokeExecution('task', 'stale-claim', 'Wrong worker'), false)
  assert.equal(await f.pool.revokeExecution('task', token.id, 'Role resource permission revoked'), true)
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.claim.exitConfirmed, false)
  assert.equal(f.task.collaboration.history.length, 1)
  assert.equal(await f.pool.revokeExecution('task', token.id, 'Repeated observation'), false)
  await assert.rejects(f.pool.decide('task', token, { action: 'handoff', to: 'p:tester', reason: 'Stale callback' }), /stale/)
})

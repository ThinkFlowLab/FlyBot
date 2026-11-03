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

test('handoff queries distinguish pending, accepted and processed initiative without closing the Task', async () => {
  const f = setup(), actor = { memberId: 'owner' }
  const offered = await f.admit()
  const pending = f.pool.get('task', offered.id, actor)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.initiative.kind, 'pool')
  assert.equal(pending.target.role, 'developer')
  assert.equal(pending.acceptance, null)
  const claim = await f.claim()
  const accepted = f.pool.get('task', offered.id, actor)
  assert.equal(accepted.state, 'accepted')
  assert.equal(accepted.acceptance.claimId, claim.id)
  assert.equal(accepted.initiative.kind, 'execution')
  const next = await f.pool.decide('task', claim, { action: 'transfer', to: 'p:tester', reason: 'Inspect the code before continuing', completed: 'Located the affected module', next: 'Check the regression strategy' })
  const processed = f.pool.get('task', offered.id, actor)
  assert.equal(processed.state, 'processed')
  assert.equal(processed.successorId, next.id)
  assert.equal(processed.initiative.kind, 'relinquished')
  const target = f.pool.get('task', next.id, actor)
  assert.equal(target.source.execution.claimId, claim.id)
  assert.equal(target.summary.completed, 'Located the affected module')
  assert.equal(target.summary.next, 'Check the regression strategy')
  target.summary.next = 'Caller mutation'
  assert.equal(f.pool.get('task', next.id, actor).summary.next, 'Check the regression strategy')
  assert.deepEqual(target.events.map(row => row.type), ['offered'])
  assert.notEqual(f.task.status, 'accepted')
  assert.equal(f.pool.list('task', actor, { limit: 1 }).items.length, 1)
  assert.equal(f.pool.list('task', actor, { after: offered.id }).items[0].id, next.id)
  assert.equal(f.pool.list('task', actor, { after: next.id }).items.length, 0)
  assert.throws(() => f.pool.get('task', offered.id, { memberId: 'stranger' }), /authority/)
  assert.throws(() => f.pool.get('task', 'missing', actor), /Unknown/)
  assert.throws(() => f.pool.list('task', actor, { after: 'foreign' }), /cursor/)
  f.rt.revoked = true
  assert.throws(() => f.pool.get('task', offered.id, actor), /authority/)
})

test('handoff contracts resolve scoped context references without copying private or other-role history', async () => {
  const f = setup(), actor = { memberId: 'owner' }
  await f.admit()
  const claim = await f.claim()
  const scope = { projectId: 'p', taskId: 'task', attemptId: 'attempt' }
  f.rt.state.projectAttempts = { attempt: { ...scope, roleSessions: {
    developer: { ...scope, id: 'dev-session', role: 'developer', logicalSessionId: 'dev-logical', definitionRevision: 7, context: { text: 'DO NOT COPY PRIVATE TRANSCRIPT' } },
    tester: { ...scope, id: 'test-session', role: 'tester', logicalSessionId: 'test-logical', definitionRevision: 5 },
  } } }
  const receipt = await f.pool.decide('task', claim, { action: 'return', to: 'p:tester', reason: 'Return with a focused question', context: { sessionId: 'forged' } })
  const view = f.pool.get('task', receipt.id, actor)
  assert.equal(view.source.context.sessionId, 'dev-session')
  assert.equal(view.target.context.sessionId, 'test-session')
  assert.equal(JSON.stringify(view).includes('DO NOT COPY'), false)
  assert.equal(JSON.stringify(view).includes('forged'), false)
  f.rt.state.projectAttempts.attempt.roleSessions.tester.taskId = 'foreign'
  assert.equal(f.pool.get('task', receipt.id, actor).target.context.sessionId, 'test-session', 'The original handoff reference remains immutable')
  const tester = await f.pool.claim('task', 'p:tester')
  const returned = await f.pool.decide('task', tester, { action: 'return', to: 'p:developer', reason: 'Need another code change' })
  assert.equal(f.pool.get('task', returned.id, actor).source.context.sessionId, null, 'A new contract cannot resolve a foreign-scoped Session')
})

test('explicit handoff acceptance replays a lost response but never reactivates completed execution', async () => {
  const f = setup(), offered = await f.admit()
  const first = await f.pool.accept('task', 'p:developer', offered.id, 'accept-original')
  assert.equal((await f.pool.accept('task', 'p:developer', offered.id, 'accept-original')).id, first.id)
  const next = await f.pool.decide('task', first, { action: 'transfer', to: 'p:tester', reason: 'Check the code' })
  const replay = await f.pool.accept('task', 'p:developer', offered.id, 'accept-original')
  assert.equal(replay.status, 'completed')
  assert.equal(f.task.collaboration.currentHandoffId, next.id)
  assert.equal(f.task.collaboration.claim, undefined)
  await assert.rejects(f.pool.accept('task', 'p:tester', next.id, 'accept-original'), /idempotency/)
  await assert.rejects(f.pool.accept('task', 'p:tester', next.id, ''), /stable/)
  const accepted = await f.pool.accept('task', 'p:tester', next.id, 'accept-next')
  assert.equal(accepted.botId, 'p:tester')
  assert.equal(f.pool.get('task', next.id, { memberId: 'owner' }).acceptance.requestId, 'accept-next')
})

test('Chief observation cannot let a later pool bypass an earlier writer with unknown exit', async () => {
  const f = setup(); await f.admit()
  f.adapter.execute = async () => 'unknown-writer'
  f.adapter.dispatch = async () => { throw new Error('Lost response') }
  f.adapter.release = async () => false
  await f.pool.pump()
  f.rt.projectChiefControl = { requireJobActor() {}, validateActor: async () => true }
  f.rt.state.projectAttempts = { attempt: { status: 'running' } }
  await f.pool.chiefRoute({ taskId: 'task', targetBotId: 'p:tester', expectedGeneration: f.task.collaboration.generation, reason: 'Inspect after a dispatch failure', decisionId: 'chief-reroute' }, { memberId: 'owner' })
  await assert.rejects(f.pool.claim('task', 'p:tester'), /Source execution exit is unconfirmed/)
  assert.equal(f.task.collaboration.status, 'queued')
  assert.equal(f.task.collaboration.claim, undefined)
  f.adapter.release = async () => true
  assert.equal((await f.pool.claim('task', 'p:tester')).botId, 'p:tester')
})

test('an interrupted acceptance exposes a fenced initiative and recovery cause', async () => {
  const f = setup(), offered = await f.admit()
  await f.claim()
  f.task.collaboration.claim.workerId = 'unknown-writer'
  f.pool.recover()
  const view = f.pool.get('task', offered.id, { memberId: 'owner' })
  assert.equal(view.state, 'accepted')
  assert.equal(view.initiative.kind, 'fenced')
  assert.equal(view.failure.phase, 'recovery')
  assert.match(view.failure.reason, /restarted/)
})

test('a failed handoff commit retains the previous Task-role summary and its version history', async () => {
  const { readRoleSummary } = await import('../src/host/project-context-memory.js')
  const f = setup(); await f.admit()
  const first = await f.claim()
  await f.pool.decide('task', first, { action: 'transfer', to: 'p:tester', reason: 'Check the original approach', completed: 'Original developer progress' })
  const previous = readRoleSummary(f.rt.state, 'p', 'task', 'developer')
  const tester = await f.pool.claim('task', 'p:tester')
  await f.pool.decide('task', tester, { action: 'return', to: 'p:developer', reason: 'Need another focused change' })
  const returned = await f.claim()
  f.rt.projectEffects = { stage: () => ({ id: 'uncommitted', generation: 1 }), persist: async () => { throw new Error('Disk commit failed') }, discardUncommitted: () => true }
  await assert.rejects(f.pool.decide('task', returned, { action: 'transfer', to: 'p:tester', reason: 'Retry after another change', completed: 'New progress cannot commit' }), /commit failed/)
  const retained = readRoleSummary(f.rt.state, 'p', 'task', 'developer')
  assert.equal(retained.sha256, previous.sha256)
  assert.equal(retained.revision, previous.revision)
  assert.equal(f.rt.state.projectRoleMemory[retained.id].versions.length, 0)
})

test('active roles can record bounded unverified experience without changing initiative or human facts', async () => {
  const f = setup(); await f.admit(); const token = await f.claim()
  const body = { requestId: 'learn-one', factKey: 'negative-case', text: 'The missing boundary case should be checked independently' }
  const learned = await f.pool.remember('task', token, body)
  assert.equal(learned.memory.classification, 'inference')
  assert.equal(learned.authority, 'none')
  assert.equal(f.task.collaboration.claim.id, token.id)
  assert.equal((await f.pool.remember('task', token, body)).already, true)
  await assert.rejects(f.pool.remember('task', token, { ...body, classification: 'fact' }), /verified/)
  const next = await f.pool.decide('task', token, { action: 'transfer', to: 'p:tester', reason: 'Check this candidate', memory: [{ factKey: 'test-input', text: 'A failed local test is not evidence of a passing host test', classification: 'unresolved' }] })
  assert.equal(next.memoryRefs.length, 1)
  assert.equal(next.memoryRefs[0].classification, 'unresolved')
  await assert.rejects(f.pool.remember('task', token, { ...body, requestId: 'stale' }), /stale/)
})

async function projectTaskFixture() {
  const { createTaskContract, admitTask, install: installTaskLifecycle } = await import('../src/host/project-task-lifecycle.js')
  const { createProjectEffects } = await import('../src/host/project-effects.js')
  const f = setup()
  f.rt.projectPools = f.pool
  createTaskContract(f.task, { impact: 'Restore the Project build' })
  admitTask(f.task, { id: 'admit', projectId: 'p', taskId: 'task', executorRole: 'chief', runId: 'chief-run', initiatedBy: 'owner', reason: 'Requirements checked' })
  f.rt.projectEffects = createProjectEffects(f.rt)
  f.rt.save = async () => { f.rt.projectEffects.saved(f.rt.projectEffects.capture()) }
  f.rt.projectEffects.register('pool.dispatch', { run: async () => ({}) })
  installTaskLifecycle(f.rt)
  f.rt.readProject = () => ({ id: 'p', chief: { botId: 'chief-carrier' } })
  let count = 0
  f.prepared = () => count
  f.rt.prepareProjectTask = body => {
    const row = { ...body, id: 'child-' + ++count, status: 'open', requesterId: 'owner' }
    createTaskContract(row, body)
    return row
  }
  return f
}

test('split releases the parent, blocks on Chief child results and resumes its original role exactly once', async () => {
  const f = await projectTaskFixture()
  await f.admit()
  const claim = await f.claim()
  f.task.collaboration.claim.workerId = 'source-worker'
  let released = 0
  f.adapter.release = async () => { ++released; return true }
  const decision = { action: 'split', reason: 'Two independent validation goals', requestId: 'split-1', resumePoint: 'Integrate both verified results', children: [
    { title: 'Check parser', criteria: 'Parser cases pass', impact: 'Correct parser behavior' },
    { title: 'Check formatter', criteria: 'Formatter cases pass', impact: 'Correct formatter behavior' },
  ] }
  const split = await f.pool.decide('task', claim, decision)
  assert.equal(released, 1)
  assert.equal(f.task.collaboration.status, 'waiting-children')
  assert.equal(f.task.collaboration.claim.exitConfirmed, true)
  assert.equal(f.rt.state.projectTaskSessions[Object.keys(f.rt.state.projectTaskSessions)[0]].workSummaryRef.revision, 1)
  assert.deepEqual((await f.pool.decide('task', claim, decision)).childTaskIds, split.childTaskIds)
  assert.equal(f.prepared(), 2)
  await assert.rejects(f.claim(), /waiting for child/)
  const children = split.childTaskIds.map(id => f.rt.state.tasks[id])
  assert.ok(children.every(row => row.projectTask.admission.status === 'proposed'))
  children[0].status = 'accepted'; children[0].completedBy = { kind: 'chief', decisionId: 'close-1' }
  children[1].status = 'cancelled'
  assert.equal(f.rt.projectTaskLifecycle.stageDependencyResume(children[0]), null)
  children[1].status = 'accepted'; children[1].completedBy = { kind: 'chief', decisionId: 'close-2' }
  const resume = f.rt.projectTaskLifecycle.stageDependencyResume(children[1])
  await f.rt.projectEffects.persist(resume)
  const [first, duplicate] = await Promise.all([f.pool.resumeChildren('task', 'split-1'), f.pool.resumeChildren('task', 'split-1')])
  assert.equal(first.id, duplicate.id)
  assert.equal(f.task.collaboration.history.filter(row => row.purpose === 'children-completed').length, 1)
  assert.equal(f.task.collaboration.botId, 'p:developer')
  assert.notEqual(f.task.status, 'accepted')
  const resumed = await f.claim()
  assert.equal(resumed.attemptId, claim.attemptId)
  assert.notEqual(resumed.id, claim.id)
  f.rt.projectEffects.close()
})

test('unknown exit and uncommitted split cannot authorize child execution or erase prior summary', async () => {
  const f = await projectTaskFixture()
  await f.admit()
  const claim = await f.claim()
  f.task.collaboration.claim.workerId = 'source-worker'
  const decision = { action: 'split', reason: 'Parallel checks', requestId: 'failed-split', resumePoint: 'Integration', children: [
    { title: 'Child validation', criteria: 'Independent cases pass', impact: 'Project correctness' },
  ] }
  f.adapter.release = async () => false
  await assert.rejects(f.pool.decide('task', claim, decision), /unconfirmed/)
  assert.equal(Object.keys(f.rt.state.tasks).length, 1)
  assert.equal(f.task.collaboration.claim.status, 'active')
  f.adapter.release = async () => true
  f.rt.save = async () => { throw new Error('Disk unavailable') }
  await assert.rejects(f.pool.decide('task', claim, decision), /Disk unavailable/)
  assert.equal(Object.keys(f.rt.state.tasks).length, 1)
  assert.equal(f.task.projectTask.wait, undefined)
  assert.equal(Object.values(f.rt.state.projectTaskSessions).some(row => row.workSummaryRef), false)
  assert.equal(Object.values(f.rt.state.projectEffects).some(row => row.kind === 'task.intake'), false)
  assert.notEqual(f.task.status, 'accepted')
  f.rt.projectEffects.close()
})

test('restart replays committed child completion into one parent Handoff without reusing the old claim', async () => {
  const f = await projectTaskFixture()
  await f.admit(); const oldClaim = await f.claim()
  const split = await f.pool.decide('task', oldClaim, { action: 'split', reason: 'Independent validation', requestId: 'restart-split', resumePoint: 'Integrate verified result', children: [
    { title: 'Check an independent invariant', criteria: 'Invariant verified', impact: 'Project correctness' },
  ] })
  const child = f.rt.state.tasks[split.childTaskIds[0]]
  child.status = 'accepted'; child.completedBy = { kind: 'chief', decisionId: 'close-child' }
  const token = f.rt.projectTaskLifecycle.stageDependencyResume(child)
  await f.rt.projectEffects.persist(token)
  const saved = structuredClone(f.rt.state)
  await f.rt.projectEffects.close()
  const g = await projectTaskFixture()
  g.rt.state = saved
  g.rt.projectEffects.recover(); g.pool.recover(); await g.rt.save()
  await Promise.all([g.rt.projectEffects.drain(), g.rt.projectEffects.drain()])
  const parent = g.rt.state.tasks.task
  assert.equal(parent.collaboration.status, 'queued')
  assert.equal(parent.collaboration.history.filter(row => row.purpose === 'children-completed').length, 1)
  const resumed = await g.claim()
  assert.notEqual(resumed.id, oldClaim.id)
  await assert.rejects(g.pool.decide('task', oldClaim, { action: 'complete', reason: 'Late result after split' }), /idempotency|stale/)
  assert.equal(parent.collaboration.claim.id, resumed.id)
  await g.rt.projectEffects.close()
})

test('cancelled child asks Chief to review the parent plan once without falsely satisfying the dependency', async () => {
  const f = await projectTaskFixture()
  await f.admit(); const claim = await f.claim()
  const split = await f.pool.decide('task', claim, { action: 'split', reason: 'Independent work', requestId: 'review-wait', resumePoint: 'Integrate actual child outcome', children: [
    { title: 'Child goal', criteria: 'Actual result verified', impact: 'Project correctness' },
  ] })
  const child = f.rt.state.tasks[split.childTaskIds[0]]
  assert.equal(f.rt.projectTaskLifecycle.stageDependencyResume(child), null, 'A new proposed child is not an exceptional reopening')
  child.status = 'cancelled'; child.projectTask.results.push({ status: 'cancelled', decision: { id: 'cancelled-child', action: 'cancel' } })
  let requests = 0
  f.rt.state.projectChiefPolicies = { p: { enabled: true } }
  f.rt.projectChiefControl = { request: async (projectId, kind, source, taskId) => { assert.equal(projectId, 'p'); assert.equal(kind, 'dependency-review'); assert.equal(taskId, 'task'); assert.equal(source.childTaskId, child.id); ++requests; return { id: 'review-parent' } } }
  const token = f.rt.projectTaskLifecycle.stageDependencyResume(child)
  assert.equal(f.rt.state.projectEffects[token.id].kind, 'task.dependency-review')
  await f.rt.projectEffects.persist(token)
  await f.rt.projectEffects.drain()
  await f.rt.projectEffects.persist(f.rt.projectTaskLifecycle.stageDependencyResume(child))
  await f.rt.projectEffects.drain()
  assert.equal(requests, 1)
  assert.equal(f.task.projectTask.dependencies[0].status, 'waiting')
  assert.equal(f.task.collaboration.status, 'waiting-children')
  assert.equal(child.status, 'cancelled')
  await f.rt.projectEffects.close()
})

test('a sealed parent resumes through one successor Attempt while retaining its logical role continuation', async () => {
  const f = await projectTaskFixture()
  await f.admit()
  const claim = await f.claim()
  const split = await f.pool.decide('task', claim, { action: 'split', reason: 'Independent validation goal', requestId: 'sealed-split', resumePoint: 'Integrate the accepted result', children: [{ title: 'Validate independent module', criteria: 'Module result accepted', impact: 'Validate the Project module' }] })
  const child = f.rt.state.tasks[split.childTaskIds[0]]
  child.status = 'accepted'; child.completedBy = { kind: 'chief', decisionId: 'accepted-independent-result' }
  f.rt.projectTaskLifecycle.stageDependencyResume(child)
  f.rt.state.projectAttempts = { [claim.attemptId]: { id: claim.attemptId, taskId: 'task', candidateSha: 'a'.repeat(40) } }
  let successors = 0
  f.adapter.rework = async () => {
    ++successors
    const next = { id: 'successor', taskId: 'task', feedback: { previousAttemptId: claim.attemptId } }
    f.rt.state.projectAttempts[next.id] = next
    f.rt.state.projectAttempts[claim.attemptId].supersededBy = next.id
    f.task.deliveryAttemptId = next.id
    return next.id
  }
  const first = await f.pool.resumeChildren('task', 'sealed-split')
  assert.equal((await f.pool.resumeChildren('task', 'sealed-split')).id, first.id)
  assert.equal(successors, 1)
  assert.equal(first.attemptId, 'successor')
  assert.equal(first.to, 'p:developer')
  assert.equal(f.task.collaboration.attemptId, 'successor')
  assert.equal(f.rt.state.projectAttempts[claim.attemptId].candidateSha, 'a'.repeat(40))
  assert.notEqual(f.task.status, 'accepted')
  await f.rt.projectEffects.close()
})

test('failed durable acceptance cannot be replayed as a claim; retries commit one active owner', async () => {
  const f = await projectTaskFixture()
  await f.admit()
  const handoffId = f.task.collaboration.currentHandoffId, save = f.rt.save
  f.rt.save = async () => { throw new Error('fixture acceptance commit failed') }
  await assert.rejects(f.pool.accept('task', 'p:developer', handoffId, 'accept-once'), /commit failed/)
  assert.equal(f.task.collaboration.status, 'queued')
  assert.equal(f.task.collaboration.claim, undefined)
  assert.equal(f.task.collaboration.history.at(-1).acceptance, undefined)
  f.rt.save = save
  const [first, duplicate] = await Promise.all([
    f.pool.accept('task', 'p:developer', handoffId, 'accept-once'),
    f.pool.accept('task', 'p:developer', handoffId, 'accept-once'),
  ])
  assert.equal(first.id, duplicate.id)
  assert.ok(first.acceptanceEffect)
  assert.equal(f.rt.projectEffects.intentCommitted(first.acceptanceEffect), true)
  assert.equal(f.task.collaboration.history.at(-1).acceptance.effect.id, first.acceptanceEffect.id)
  assert.equal(f.task.collaboration.claim.id, first.id)
  await f.rt.projectEffects.close()
})

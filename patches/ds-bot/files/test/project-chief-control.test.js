import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectChiefControl, inspectionFacts, allocationProof, inspectionResources } from '../src/host/project-chief-control.js'
const thresholds = { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }
test('Chief inspection counts verified artifact progress rather than message or transfer churn', () => {
  const task = { id: 't', updatedAt: 1, deliveryAttemptId: 'a', collaboration: { status: 'queued', generation: 7, history: Array.from({ length: 5 }, (_, index) => ({ evidence: [], reason: 'Progress message ' + index, createdAt: index + 1 })) } }
  const state = { projectAttempts: { a: { evidence: {} } } }
  assert.equal(inspectionFacts(state, task, thresholds, 100).handoffsWithoutProgress, 5)
  assert.match(inspectionFacts(state, task, thresholds, 100).reasons[0], /without verified/)
  task.collaboration.history[3].evidence = [{ kind: 'implementation', sha: 'candidate' }]
  task.collaboration.history[4].evidence = [{ kind: 'implementation', sha: 'candidate' }]
  assert.equal(inspectionFacts(state, task, thresholds, 100).handoffsWithoutProgress, 5, 'A new implementation commit alone cannot clear the bounce count')
  task.collaboration.history[3].evidence.push({ kind: 'host-tests', passed: true, sha: 'candidate', sha256: 'host-log' })
  task.collaboration.history[4].evidence.push({ kind: 'host-tests', passed: true, sha: 'candidate', sha256: 'another-run-log' })
  const facts = inspectionFacts(state, task, thresholds, 100)
  assert.equal(facts.handoffsWithoutProgress, 1, 'Repeating tests at the same SHA cannot reset the checkpoint')
  assert.equal(facts.lastMeaningfulProgressAt, 4)
  assert.equal(facts.progressEvidence[0].testLogSha256, 'host-log')
  task.chiefObservations = { fingerprint: 'a message is not a checkpoint', handoffCount: 5 }
  task.collaboration.history.forEach(row => { row.evidence = [] })
  assert.equal(inspectionFacts(state, task, thresholds, 100).handoffsWithoutProgress, 5)
})
test('Chief inspection thresholds are configuration and identify long execution, heartbeat and waits', () => {
  const task = { id: 't', updatedAt: 1, collaboration: { status: 'claimed', history: [], claim: { status: 'active', workerId: 'w', createdAt: 1 } } }
  const state = { projectHarnessWorkers: { w: { status: 'running', createdAt: 1 } } }
  assert.equal(inspectionFacts(state, task, thresholds, 20000).reasons.length, 2)
  assert.equal(inspectionFacts(state, task, { ...thresholds, longExecutionMs: 50000, missingHeartbeatMs: 50000 }, 20000).reasons.length, 0)
  task.collaboration.status = 'blocked'
  assert.match(inspectionFacts(state, task, thresholds, 20000).reasons.at(-1), /wait/)
})
test('Chief inspection sees exhausted/slow private agent delivery without exposing private message contents', () => {
  const state = { personalAgentParticipations: { part: { carrierId: 'carrier' } }, projectAgentTranscripts: { carrier: [{ id: 'consult', text: 'Private advice must not appear', at: 1, notificationEffect: { id: 'effect' }, inbox: { phase: 'processing', updatedAt: 1 } }] }, projectEffects: { effect: { status: 'failed' } } }
  const task = { id: 'task', chiefQuestion: { recipient: { participationId: 'part', consultationId: 'consult' } } }
  const facts = inspectionFacts(state, task, { maxHandoffsWithoutProgress: 10, longExecutionMs: 10000, missingHeartbeatMs: 10000, longWaitMs: 1000 }, 2000)
  assert.equal(facts.reasons.length, 2)
  assert.ok(!JSON.stringify(facts).includes('Private advice'))
})

test('failed schedule configuration does not silently enable autonomous Chief authority', async () => {
  const rt = { state: { projectChiefPolicies: {} }, requireProjectAccess() {}, projectDelegations: { background: async () => true }, projectScheduledTasks: { save: async () => { throw new Error('Original Schedule service is unavailable') } }, save: async () => {} }
  const control = createProjectChiefControl(rt)
  await assert.rejects(control.configure({ projectId: 'p', enabled: true }, { memberId: 'owner' }), /unavailable/)
  assert.equal(rt.state.projectChiefPolicies.p, undefined)
  assert.equal(control.template.when.seconds, 1800)
})

async function controlFixture({ modern = false, dependency = false } = {}) {
  const { createProjectPools } = await import('../src/host/project-pools.js')
  const task = { id: 't', projectId: 'p', title: 'Fix code', criteria: 'Exact candidate passes', status: 'result-ready', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'owner', kind: 'code', generation: 1, status: 'arbitration', botId: 'p:chief', attemptId: 'a', currentHandoffId: 'receipt', history: [{ id: 'receipt', status: 'pending', to: 'p:chief', createdAt: 1, evidence: [] }] } }
  let request, accepted = 0, permitted = true
  const roles = ['chief', 'developer', 'tester', 'reviewer'].map(role => ({ id: `p:${role}`, role }))
  const rt = { state: { tasks: { t: task }, projectExecutions: {}, projectAttempts: { a: { id: 'a', projectId: 'p', taskId: 't', candidateSha: 'candidate', evidence: {} } }, projectChiefPolicies: { p: { enabled: true, authorityMemberId: 'owner', revision: 1, inspection: { thresholds, prompt: 'Inspect evidence' } } }, projectAgents: { 'public-p': { id: 'public-p', projectId: 'p', visibility: 'public', botId: 'chief', sessionId: 'chief', carrierGeneration: 1 } } }, config: {}, save: async () => {}, projects: { requireActive() {} }, requireProjectAccess(actor, id) { if (!permitted || actor.memberId !== 'owner' || id !== 'p') throw new Error('Current role denied') }, projectDelegations: { background: async () => true }, bindProject(body) { rt.state.projectExecutions[body.id] = { ...body }; return { id: body.projectId, status: 'active' } }, projectAgents: { deliveryDefinitions: () => ({ roles }), chiefBusy: () => false, startChiefJob: async args => { request = args; return 'native-job' } }, projectDelivery: { chiefAccept: async () => { accepted++; task.status = 'accepted' } } }
  const control = createProjectChiefControl(rt); rt.projectChiefControl = control; rt.projectPools = createProjectPools(rt)
  if (modern) {
    const { createProjectEffects } = await import('../src/host/project-effects.js')
    const { install: installLifecycle, createTaskContract } = await import('../src/host/project-task-lifecycle.js')
    task.status = 'open'; task.requesterId = 'owner'; delete task.collaboration; delete task.deliveryAttemptId
    createTaskContract(task, { impact: 'Repair the Project build' })
    rt.projectEffects = createProjectEffects(rt)
    rt.save = async () => rt.projectEffects.saved(rt.projectEffects.capture())
    rt.projectScheduler = { wake() {}, request: async () => { ++accepted; return { admitted: true } } }
    installLifecycle(rt)
    if (dependency) {
      const { createTaskContract, addTaskDependencies } = await import('../src/host/project-task-lifecycle.js')
      const child = { id: 'child', projectId: 'p', title: 'Cancelled independent goal', criteria: 'Independent result', status: 'cancelled' }
      createTaskContract(child, { impact: child.title }); rt.state.tasks.child = child
      task.collaboration = { status: 'waiting-children', generation: 1, initiatedBy: 'owner', history: [], claim: { id: 'parent-source', status: 'completed', botId: 'p:developer', exitConfirmed: true } }
      addTaskDependencies(rt.state, task, ['child'], { id: 'parent-wait', botId: 'p:developer', claimId: 'parent-source', resumePoint: 'Integrate actual remaining evidence' })
    }
    await control.request('p', 'intake', { requirementRevision: 1 }, task.id)
  }
  await control.pump()
  const result = overrides => ({ ok: true, text: JSON.stringify({ summary: 'Judgement', decisions: [{ taskId: 't', action: 'close', reason: 'Criteria met', criteria: [{ criterion: task.criteria, passed: true, evidence: 'Verified host facts' }], ...overrides }] }), executionEvidence: { kind: 'native-chief', chiefRunId: request.runId, carrierGeneration: 1, botId: 'chief', sessionId: 'chief' } })
  return { rt, task, control, request, result, accepted: () => accepted, revokeRole() { permitted = false } }
}
test('a new Chief request wakes execution and duplicate receipts do not create a wake loop', async () => {
  const f = await controlFixture()
  let wakes = 0
  f.rt.projectScheduler = { wake() { ++wakes } }
  const first = await f.control.request('p', 'inspection', { requestId: 'host-recovery' })
  assert.equal(wakes, 1)
  assert.equal(first.status, 'queued')
  const repeated = await f.control.request('p', 'inspection', { requestId: 'host-recovery' })
  assert.equal(first.id, repeated.id)
  assert.equal(wakes, 1)
})
test('Chief results cannot close a Task that progressed during reasoning or whose actor lost permission', async () => {
  const f = await controlFixture(); ++f.task.collaboration.generation
  await f.request.onResult(f.result())
  assert.equal(f.accepted(), 0); assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'failed')
  const g = await controlFixture(); g.revokeRole(); await g.request.onResult(g.result())
  assert.equal(g.accepted(), 0)
})
test('Chief cannot close another Project, bypass evidence criteria or accept a replaced carrier', async () => {
  const f = await controlFixture(); f.rt.state.tasks.foreign = { id: 'foreign', projectId: 'elsewhere', status: 'working' }
  await f.request.onResult(f.result({ taskId: 'foreign' }))
  assert.equal(f.accepted(), 0); assert.equal(f.rt.state.tasks.foreign.status, 'working')
  const g = await controlFixture(); await g.request.onResult(g.result({ criteria: [] }))
  assert.equal(g.accepted(), 0); assert.equal(Object.values(g.rt.state.projectChiefDecisions)[0].status, 'rejected')
  const h = await controlFixture(); h.rt.state.projectAgents['public-p'].carrierGeneration = 2
  await h.request.onResult(h.result()); assert.equal(h.accepted(), 0)
})
test('an unmanaged restart does not fabricate successful Chief execution or replay its old result', async () => {
  const f = await controlFixture()
  assert.equal(f.control.recover(), true); f.rt.projectPools.recover()
  const restored = createProjectChiefControl(f.rt); f.rt.projectChiefControl = restored
  await restored.pump()
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'interrupted')
  await f.request.onResult(f.result())
  assert.equal(f.accepted(), 0)
  assert.equal(f.task.status, 'result-ready')
})

test('completed Chief deferral releases its execution claim while preserving the blocked Task and current Attempt',async()=>{
  const f=await controlFixture(),attempt=f.task.deliveryAttemptId,generation=f.task.collaboration.generation
  assert.equal(f.task.collaboration.claim.status,'active')
  await f.request.onResult(f.result({action:'continue',reason:'Wait for the operator to admit the verified integration source'}))
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status,'done')
  assert.equal(f.task.collaboration.status,'blocked')
  assert.equal(f.task.collaboration.claim.status,'waiting-human')
  assert.equal(f.task.collaboration.claim.chiefRunId,f.request.runId)
  assert.equal(f.task.deliveryAttemptId,attempt)
  assert.equal(f.task.collaboration.generation,generation)
  assert.equal(f.accepted(),0)
})

test('host registration proof distinguishes never-allocated recovery from an unknown external worker', () => {
  const task = { deliveryAttemptId: 'a', collaboration: { claim: { status: 'interrupted' } } }
  const state = { projectAttempts: { a: { workspaces: {}, roleSessions: {} } } }
  assert.equal(allocationProof(state, task).status, 'not-allocated')
  state.projectResourceLeases = { l: { attemptId: 'a', status: 'unreachable' } }
  assert.equal(allocationProof(state, task).status, 'recorded-or-unknown')
  state.projectResourceLeases = {}; task.collaboration.claim.workerId = 'unknown-worker'
  assert.equal(allocationProof(state, task).status, 'recorded-or-unknown')
  delete task.collaboration.claim.workerId; state.projectAttempts.a.roleSessions.developer = { status: 'prepared' }
  assert.equal(allocationProof(state, task).status, 'recorded-or-unknown')
})


test('inspection compacts only proven released history and preserves current, unknown and foreign boundaries', () => {
  const task = { id: 't', deliveryAttemptId: 'current' }
  const state = { projectAttempts: { old: { taskId: 't' }, current: { taskId: 't' }, foreign: { taskId: 'other' } }, projectResourceLeases: {
    old: { attemptId: 'old', status: 'released', role: 'developer', releaseProof: { kind: 'sdk-stop-ack-and-process-exit' } },
    current: { attemptId: 'current', status: 'released', role: 'reviewer', releaseProof: { kind: 'sdk-stop-ack-and-process-exit' } },
    unknown: { attemptId: 'old', status: 'released', role: 'tester' },
    running: { attemptId: 'old', status: 'running', role: 'developer' },
    foreign: { attemptId: 'foreign', status: 'running', role: 'chief' },
  } }
  const before = structuredClone(state), facts = inspectionResources(state, task)
  assert.deepEqual(state, before)
  assert.equal(facts.releasedResourceHistory.count, 1)
  assert.equal(facts.resources.length, 3)
  assert.ok(facts.resources.some(row => row.attemptId === 'current'))
  assert.ok(facts.resources.some(row => row.status === 'running'))
  assert.ok(facts.resources.some(row => row.releaseProof === null))
  state.projectResourceLeases.old.releasedAt = 99
  assert.notEqual(inspectionResources(state, task).releasedResourceHistory.sha256, facts.releasedResourceHistory.sha256)
  delete state.projectResourceLeases.old
  assert.equal(inspectionResources(state, task).releasedResourceHistory, undefined)
})

test('a needs-human decision records the personal-agent recipient without transferring Task initiative', async () => {
  const f = await controlFixture()
  f.rt.projectAgents.contactUser = (task, question, actor) => {
    assert.equal(task.id, 't')
    assert.equal(question.reason, 'Need the user preference')
    assert.equal(actor.chiefJobId, f.request.runId)
    return { kind: 'personal-agent', memberId: 'owner', agentId: 'personal', consultationId: 'consult' }
  }
  await f.request.onResult(f.result({ action: 'needs-human', reason: 'Need the user preference' }))
  assert.equal(f.task.chiefQuestion.recipient.agentId, 'personal')
  assert.equal(f.task.collaboration.status, 'blocked')
  assert.equal(f.task.collaboration.botId, 'p:chief')
  assert.equal(f.accepted(), 0)
})

test('actual Chief callback admits a new Task before the committed start effect can dispatch it', async () => {
  const f = await controlFixture({ modern: true })
  assert.equal(f.task.projectTask.admission.status, 'proposed')
  assert.equal(f.accepted(), 0)
  assert.equal(f.request.projectFacts.tasks[0].taskContract.requirements.impact, 'Repair the Project build')
  await f.request.onResult(f.result({ action: 'admit', reason: 'Goal, impact, scope and criteria are clear' }))
  assert.equal(f.task.projectTask.admission.status, 'accepted')
  assert.equal(f.task.status, 'open')
  assert.equal(f.accepted(), 0, 'admission itself does not run code before outbox dispatch')
  await Promise.all([f.rt.projectEffects.drain(), f.rt.projectEffects.drain()])
  assert.equal(f.accepted(), 1)
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'done')
  await f.rt.projectEffects.close()
})

test('Chief admission rejects changed requirements and revoked authority before queuing code', async () => {
  const f = await controlFixture({ modern: true })
  ++f.task.projectTask.requirements.revision
  await f.request.onResult(f.result({ action: 'admit' }))
  await f.rt.projectEffects.drain()
  assert.equal(f.accepted(), 0)
  assert.equal(f.task.projectTask.admission.status, 'proposed')
  assert.match(f.rt.state.projectExecutions[f.request.runId].failure, /requirements changed/)
  await f.rt.projectEffects.close()
  const g = await controlFixture({ modern: true }); g.revokeRole()
  await g.request.onResult(g.result({ action: 'admit' }))
  await g.rt.projectEffects.drain()
  assert.equal(g.accepted(), 0)
  await g.rt.projectEffects.close()
})

test('protected Chief callback can judge a cancelled dependency without closing either the child or parent', async () => {
  const f = await controlFixture({ modern: true, dependency: true })
  const snapshot = f.request.projectFacts.tasks[0].taskContract.dependencies[0].current
  assert.equal(snapshot.status, 'cancelled')
  await f.request.onResult(f.result({ action: 'resolve-dependency', reason: 'The parent can satisfy its original criteria using the recorded alternative design', dependency: { taskId: 'child', version: snapshot.version, evidence: ['Verified current design decision reference'] } }))
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'done')
  assert.equal(f.task.projectTask.dependencies[0].status, 'waived')
  assert.equal(f.task.projectTask.wait.status, 'ready')
  assert.equal(f.rt.state.tasks.child.status, 'cancelled')
  assert.equal(f.task.status, 'open')
  assert.equal(Object.values(f.rt.state.projectEffects).filter(row => row.kind === 'task.resume').length, 1)
  assert.equal(f.accepted(), 0)
  await f.rt.projectEffects.close()
})


test('validated Chief completion can publish bounded role proposals but cannot apply role changes', async () => {
  const f = await controlFixture(), calls = []
  f.rt.projectAgents.proposeRoleForJob = async (actor, proposal) => {
    assert.equal(actor.chiefJobId, f.request.runId)
    calls.push(proposal)
    return { proposal: { id: 'pending-role-proposal' } }
  }
  const result = f.result(), body = JSON.parse(result.text)
  body.decisions = []
  body.roleProposals = [{ action: 'add', role: 'analyst', reason: 'Investigate architecture', fields: { policyRole: 'reviewer' }, requestId: 'untrusted-id' }]
  result.text = JSON.stringify(body)
  await f.request.onResult(result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].requestId, `chief-role-${f.request.runId}-0`)
  assert.deepEqual(f.rt.state.projectExecutions[f.request.runId].roleProposalIds, ['pending-role-proposal'])
  assert.equal(f.accepted(), 0)
  const g = await controlFixture()
  g.rt.projectAgents.proposeRoleForJob = async () => { throw Error('Must not publish') }
  const invalid = g.result(), parsed = JSON.parse(invalid.text)
  parsed.roleProposals = Array.from({ length: 5 }, () => ({})); invalid.text = JSON.stringify(parsed)
  await g.request.onResult(invalid)
  assert.equal(g.rt.state.projectExecutions[g.request.runId].status, 'failed')
  assert.match(g.rt.state.projectExecutions[g.request.runId].failure, /bounded array/)
})


test('malformed Chief admission remains visible and a valid explicit retry clears only the active failure', async () => {
  const f = await controlFixture({ modern: true })
  assert.match(f.request.prompt, /requirements\.criteria.*string/)
  await f.request.onResult(f.result({ action: 'admit', reason: 'Clarify scope', requirements: { criteria: ['Exact candidate passes'] } }))
  assert.equal(f.task.projectTask.admission.status, 'proposed')
  assert.match(f.task.projectTask.admission.failure.reason, /bounded nonempty text/)
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'failed')
  const { taskView } = await import('../src/host/project-development-service.js')
  const view = taskView(f.rt.state, f.task)
  assert.equal(view.phase, 'blocked'); assert.equal(view.waitingFor, 'chief-recovery')
  const { admitTask } = await import('../src/host/project-task-lifecycle.js')
  admitTask(f.task, { id: 'valid-retry', projectId: 'p', taskId: 't', executorRole: 'chief', runId: 'retry-run', initiatedBy: 'owner', reason: 'Original string requirements are adequate' })
  assert.equal(f.task.projectTask.admission.failure, undefined)
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'failed', 'Historical failed run is preserved')
  await f.rt.projectEffects.close()
})

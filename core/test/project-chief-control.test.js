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

async function controlFixture({ modern = false, dependency = false, withInputs = false } = {}) {
  const { createProjectPools } = await import('../src/host/project-pools.js')
  const task = { id: 't', projectId: 'p', title: 'Fix code', criteria: 'Exact candidate passes', status: 'result-ready', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'owner', kind: 'code', generation: 1, status: 'arbitration', botId: 'p:chief', attemptId: 'a', currentHandoffId: 'receipt', history: [{ id: 'receipt', status: 'pending', to: 'p:chief', createdAt: 1, evidence: [] }] } }
  let request, accepted = 0, permitted = true
  const roles = ['chief', 'developer', 'tester', 'reviewer'].map(role => ({ id: `p:${role}`, role }))
  const rt = { state: { tasks: { t: task }, projectExecutions: {}, projectAttempts: { a: { id: 'a', projectId: 'p', taskId: 't', candidateSha: 'candidate', evidence: {} } }, projectChiefPolicies: { p: { enabled: true, authorityMemberId: 'owner', revision: 1, inspection: { thresholds, prompt: 'Inspect evidence' } } }, projectAgents: { 'public-p': { id: 'public-p', projectId: 'p', visibility: 'public', botId: 'chief', sessionId: 'chief', carrierGeneration: 1 } } }, config: {}, save: async () => {}, projects: { requireActive() {} }, requireProjectAccess(actor, id) { if (!permitted || actor.memberId !== 'owner' || id !== 'p') throw new Error('Current role denied') }, projectDelegations: { background: async () => true }, bindProject(body) { rt.state.projectExecutions[body.id] = { ...body }; return { id: body.projectId, status: 'active' } }, projectAgents: { deliveryDefinitions: () => ({ roles }), chiefBusy: () => false, startChiefJob: async args => { request = args; request.capturedInvocation = rt.state.projectExecutions[args.runId].invocation; return 'native-job' } }, projectDelivery: { chiefAccept: async () => { accepted++; task.status = 'accepted' } } }
  if (withInputs) {
    const { createProjectEffects } = await import('../src/host/project-effects.js'), { install } = await import('../src/host/project-inputs.js')
    rt.projectEffects = createProjectEffects(rt); rt.save = async () => rt.projectEffects.saved(rt.projectEffects.capture()); install(rt)
    await rt.projectInputs.publish({ projectId: 'p', taskId: 't', requestId: 'receipt-fixture', text: 'Verify the accepted behavior' }, { memberId: 'owner' })
  }
  let control = createProjectChiefControl(rt); rt.projectChiefControl = control; rt.projectPools = createProjectPools(rt)
  if (modern) {
    const { createProjectEffects } = await import('../src/host/project-effects.js')
    const { install: installLifecycle, createTaskContract } = await import('../src/host/project-task-lifecycle.js')
    task.status = 'open'; task.requesterId = 'owner'; delete task.collaboration; delete task.deliveryAttemptId
    createTaskContract(task, { impact: 'Repair the Project build' })
    rt.projectEffects = createProjectEffects(rt)
    rt.save = async () => rt.projectEffects.saved(rt.projectEffects.capture())
    rt.projectScheduler = { wake() {}, request: async () => { ++accepted; return { admitted: true } } }
    installLifecycle(rt)
    control = createProjectChiefControl(rt); rt.projectChiefControl = control
    if (dependency) {
      const { createTaskContract, addTaskDependencies } = await import('../src/host/project-task-lifecycle.js')
      const child = { id: 'child', projectId: 'p', title: 'Cancelled independent goal', criteria: 'Independent result', status: 'cancelled' }
      createTaskContract(child, { impact: child.title }); rt.state.tasks.child = child
      task.collaboration = { status: 'waiting-children', generation: 1, initiatedBy: 'owner', history: [], claim: { id: 'parent-source', status: 'completed', botId: 'p:developer', exitConfirmed: true } }
      addTaskDependencies(rt.state, task, ['child'], { id: 'parent-wait', botId: 'p:developer', claimId: 'parent-source', resumePoint: 'Integrate actual remaining evidence' })
    }
    await control.request('p', 'intake', { requirementRevision: 1 }, task.id)
  }
  const originalPump = control.pump
  control.pump = async () => {
    await originalPump()
    for (let index = 0; index < 200; ++index) {
      const running = Object.values(rt.state.projectExecutions).find(row => row.status === 'running')
      if (!running || request?.runId === running.id && request.capturedInvocation === running.invocation) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Chief dispatch preparation did not settle')
  }
  await control.pump()
  if (!request) throw new Error(JSON.stringify(Object.values(rt.state.projectExecutions).map(row => ({status:row.status,failure:row.failure,dispatchFailure:row.dispatchFailure}))))
  const result = overrides => ({ ok: true, text: JSON.stringify({ summary: 'Judgement', decisions: [{ taskId: 't', action: 'close', reason: 'Criteria met', criteria: [{ criterion: task.criteria, passed: true, evidence: 'Verified host facts' }], ...overrides }] }), executionEvidence: { kind: 'native-chief', chiefRunId: request.runId, carrierGeneration: 1, botId: 'chief', sessionId: 'chief' } })
  return { rt, task, control, get request() { return request }, result, accepted: () => accepted, revokeRole() { permitted = false } }
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
  assert.equal(f.accepted(), 0); assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'correction-pending')
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
  assert.equal(f.rt.state.projectExecutions[f.request.runId].correction.feedback.at(-1).recovery.kind, 'stale-snapshot')
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
  body.decisions = [{ taskId: 't', action: 'continue', reason: 'Role proposal awaits human governance approval' }]
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
  assert.equal(g.rt.state.projectExecutions[g.request.runId].status, 'correction-pending')
  assert.match(g.rt.state.projectExecutions[g.request.runId].failure, /bounded array/)
})


test('malformed Chief admission receives structured feedback and its valid correction preserves the original failure history', async () => {
  const f = await controlFixture({ modern: true }), run = f.rt.state.projectExecutions[f.request.runId]
  assert.match(f.request.prompt, /requirements\.criteria.*string/)
  await f.request.onResult(f.result({ action: 'admit', reason: 'Clarify scope', requirements: { criteria: ['Exact candidate passes'] } }))
  assert.equal(f.task.projectTask.admission.status, 'proposed')
  assert.equal(run.status, 'correction-pending'); assert.equal(f.task.chiefDecisionIssue.status, 'pending')
  assert.equal(run.correction.feedback[0].fields[0].field, 'requirements.criteria')
  await f.control.pump(); await f.request.onResult(f.result({ action: 'admit', reason: 'Original string requirements are adequate' }))
  assert.equal(run.status, 'done', run.failure); assert.equal(f.task.projectTask.admission.status, 'accepted')
  assert.equal(run.correction.status, 'resolved'); assert.equal(run.correction.feedback.length, 1)
  assert.equal(run.invocationHistory.length, 2); assert.equal(f.task.chiefDecisionIssue, undefined)
  await f.rt.projectEffects.close()
})

for (const action of ['route', 'return']) test(action + ' missing target is fed back to Chief and a corrected decision reaches the role pool', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  f.rt.projectPools.connect({ validate: () => ({ ok: true }), rework: async () => 'a' })
  const taskId = f.task.id, attemptId = f.task.deliveryAttemptId, first = f.request
  await first.onResult(f.result({ action, reason: 'Tests failed; repair code' }))
  assert.equal(run.status, 'correction-pending')
  assert.equal(run.correction.feedback.at(-1).fields[0].field, 'targetBotId')
  assert.equal(f.task.chiefQuestion, undefined)
  await f.control.pump()
  assert.match(f.request.prompt, /targetBotId/)
  assert(f.request.projectFacts.logicalBots.some(row => row.id === 'p:developer'))
  await f.request.onResult(f.result({ action, targetBotId: 'p:developer', reason: 'Repair failing tests' }))
  assert.equal(run.status, 'done', run.failure)
  assert.equal(f.task.collaboration.botId, 'p:developer')
  assert.equal(f.task.collaboration.status, 'queued')
  assert.equal(f.task.id, taskId); assert.equal(f.task.deliveryAttemptId, attemptId)
  await first.onResult({ ok: false, text: 'Late callback' })
  assert.equal(run.status, 'done', 'old invocation cannot overwrite the corrected result')
})
test('correction budget exhaustion remains an explicit incomplete judgement and never creates a human consultation', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  run.correctionLimit = 1
  let consultations = 0; f.rt.projectAgents.contactUser = () => { consultations++; return {} }
  await f.request.onResult(f.result({ action: 'route' })); await f.control.pump()
  await f.request.onResult(f.result({ action: 'route' }))
  assert.equal(run.status, 'incomplete'); assert.equal(run.correction.status, 'exhausted')
  assert.equal(f.task.chiefDecisionIssue.status, 'exhausted')
  assert.equal(f.task.collaboration.block, undefined)
  assert.equal(consultations, 0); assert.equal(f.task.chiefQuestion, undefined)
})

test('unknown, empty, Chief and foreign routing targets return bounded feedback without route side effects', async () => {
  for (const targetBotId of ['', 7, 'p:chief', 'elsewhere:developer', 'p:retired']) {
    const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
    let routed = 0; f.rt.projectPools.chiefRoute = async () => { routed++ }
    await f.request.onResult(f.result({ action: 'route', targetBotId }))
    assert.equal(run.status, 'correction-pending'); assert.equal(routed, 0)
    assert.equal(run.correction.feedback[0].fields[0].field, 'targetBotId')
  }
})
test('permission revocation or a stale corrected snapshot cannot gain authority from feedback', async () => {
  const f = await controlFixture(); await f.request.onResult(f.result({ action: 'route' })); f.revokeRole(); await f.control.pump()
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'failed'); assert.equal(f.accepted(), 0)
  const g = await controlFixture(); await g.request.onResult(g.result({ action: 'route' })); await g.control.pump(); ++g.task.collaboration.generation
  await g.request.onResult(g.result({ action: 'route', targetBotId: 'p:developer' }))
  assert.equal(g.rt.state.projectExecutions[g.request.runId].status, 'correction-pending')
  assert.equal(g.rt.state.projectExecutions[g.request.runId].correction.feedback.at(-1).recovery.kind, 'stale-snapshot')
})
test('SDK correction waits for the exact prior worker generation and confirmed resource release', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  await f.request.onResult(f.result({ action: 'route' }))
  run.correction.priorExecution = { kind: 'sdk-chief', workerId: 'sdk', generation: 3 }
  f.rt.state.projectHarnessWorkers = { sdk: { id: 'sdk', chiefRunId: run.id, projectId: 'p', generation: 3, status: 'stopping', leaseId: 'lease' } }
  f.rt.state.projectResourceLeases = { lease: { status: 'stopping' } }
  await f.control.pump(); assert.equal(run.status, 'correction-pending')
  const worker = f.rt.state.projectHarnessWorkers.sdk; worker.status = 'released'; worker.releaseProof = { kind: 'sdk-stop-ack-and-process-exit', generation: 3 }
  await f.control.pump(); assert.equal(run.status, 'correction-pending')
  f.rt.state.projectResourceLeases.lease.status = 'released'; worker.generation = 4
  await f.control.pump(); assert.equal(run.status, 'correction-pending')
  worker.generation = 3; await f.control.pump(); assert.equal(run.status, 'running')
})
test('an uncommitted correction cannot authorize another Chief invocation after a failed save', async () => {
  const f = await controlFixture({ modern: true }), run = f.rt.state.projectExecutions[f.request.runId]
  const save = f.rt.save; f.rt.save = async () => {}
  await assert.rejects(f.request.onResult(f.result({ action: 'admit', requirements: { criteria: [] } })), /commit was not confirmed/)
  assert.equal(run.status, 'failed'); assert.equal(run.correction.status, 'commit-failed')
  f.rt.save = save; await save(); await f.control.pump()
  assert.equal(run.status, 'failed'); assert.equal(f.accepted(), 0)
  await f.rt.projectEffects.close()
})
test('an omitted task decision is protocol feedback, not an implicit human escalation', async () => {
  const f = await controlFixture(), response = f.result(); response.text = JSON.stringify({ summary: 'No decision', decisions: [] })
  await f.request.onResult(response)
  assert.equal(f.rt.state.projectExecutions[f.request.runId].status, 'correction-pending')
  assert.equal(f.task.chiefQuestion, undefined)
})

test('scheduled inspection references settle from durable run status instead of an in-memory waiter', async () => {
  const f = await controlFixture()
  const delivery = { id: 'occurrence-1' }, row = { id: 'schedule', projectId: 'p', config: { prompt: 'Inspect' } }
  const reference = await f.control.scheduled({ row, delivery })
  assert.ok(reference.runId)
  const run = f.rt.state.projectExecutions[reference.runId]
  run.status = 'failed'; run.failure = 'Confirmed refusal'
  const replay = await f.control.scheduled({ row, delivery })
  assert.equal(replay.runId, run.id)
  assert.equal(f.control.scheduledState({ row, delivery }).status, 'failed')
})

test('expired inspections revoke old callbacks, settle delivery and requeue only with confirmed exit', async () => {
  const f = await controlFixture(), now = Date.now()
  const run = f.rt.state.projectExecutions[f.request.runId]
  run.purpose = 'inspection'; run.taskId = undefined
  f.rt.state.projectChiefPolicies.p.inspection.lifecycle = { runTimeoutMs: 1, recoveryDelayMs: 1 }
  run.startedAt = now - 10000
  const old = f.request
  f.rt.projectAgents.stopChiefJob = async () => ({ confirmed: true, kind: 'native-chief-quiescent', runId: run.id })
  await f.control.pump(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(run.status, 'interrupted')
  await old.onResult({ ok: true, text: JSON.stringify({ summary: 'Late', decisions: [{taskId:'t',action:'needs-human',reason:'Late result'}] }), executionEvidence: { kind:'native-chief', botId:'chief',sessionId:'chief',chiefRunId:run.id,carrierGeneration:1 } })
  assert.equal(f.task.chiefQuestion, undefined)
  run.recovery.notBefore = Date.now() - 1
  await f.control.pump(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(run.status, 'running'); assert.equal(run.recovery.attempts, 1)
  assert.notEqual(f.request.actor.chiefToken, old.actor.chiefToken)
})

test('one refused inspection route preserves its gate while an independent Task still receives judgement', async () => {
  const f = await controlFixture()
  const run = f.rt.state.projectExecutions[f.request.runId]; run.purpose = 'inspection'; delete run.taskId
  await f.request.onResult(f.result({ action: 'continue', reason: 'Finish the fixture arbitration before a project inspection' }))
  f.rt.state.tasks.other = { id: 'other', projectId: 'p', title: 'Independent pending item', criteria: 'Checked', status: 'open' }
  f.task.collaboration.status = 'blocked'
  await f.control.request('p', 'inspection', { requestId: 'independent-inspection' })
  await f.control.pump()
  f.rt.projectPools.chiefRoute = async () => { throw new Error('Chief intervention is waiting for confirmed worker exit') }
  const request = f.request
  await request.onResult({ ...f.result({ action: 'continue' }), text: JSON.stringify({ summary: 'Inspect independent work', decisions: [{ taskId: 't', action: 'route', targetBotId: 'p:developer', reason: 'Try repairing the candidate' }, { taskId: 'other', action: 'continue', reason: 'Independent facts recorded without closure' }] }) })
  const inspected = f.rt.state.projectExecutions[request.runId]
  assert.equal(inspected.status, 'partial'); assert.equal(inspected.decisionFailures.length, 1)
  assert.ok(f.rt.state.tasks.other.chiefObservations)
  assert.match(f.task.chiefActionIssue.message, /confirmed worker exit/)
  assert.equal(f.task.status, 'result-ready')
})

test('restart requeues taskless inspection only with exact confirmed exit, current authority and committed recovery', async () => {
  for (const kind of ['confirmed', 'unknown', 'revoked', 'save-failed']) {
    const f = await controlFixture({ modern: kind === 'save-failed' })
    const run = f.rt.state.projectExecutions[f.request.runId]; run.purpose = 'inspection'; delete run.taskId
    const restored = createProjectChiefControl(f.rt); f.rt.projectChiefControl = restored
    assert.equal(restored.recover(), true)
    run.recovery = { status: 'waiting-exit', attempts: 0, notBefore: Date.now() - 1 }
    if (kind !== 'unknown') run.exitProof = { confirmed: true, kind: 'native-chief-quiescent', runId: run.id, invocation: run.invocation }
    if (kind === 'revoked') f.revokeRole()
    if (kind === 'save-failed') f.rt.save = async () => {} // No durable Effects acknowledgement.
    await restored.pump(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(run.status, kind === 'confirmed' ? 'running' : kind === 'unknown' ? 'interrupted' : 'failed', kind)
    if (kind === 'confirmed') assert.equal(run.recovery.attempts, 1)
    if (kind === 'unknown') assert.equal(run.recovery.exitConfirmed, false)
  }
})

test('taskless SDK inspection recovery refuses missing, active or mismatched lease evidence', async () => {
  for (const kind of ['confirmed', 'missing', 'active', 'generation']) {
    const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
    run.purpose = 'inspection'; delete run.taskId; run.workerId = 'sdk-chief'
    f.rt.state.projectHarnessWorkers = { 'sdk-chief': { id: 'sdk-chief', chiefRunId: run.id, chiefInvocation: run.invocation, projectId: 'p', attemptId: 'chief-a', role: 'chief', resourceId: 'r', leaseId: 'chief-l', generation: 3, status: 'released', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', generation: 3 } } }
    f.rt.state.projectResourceLeases = kind === 'missing' ? {} : { 'chief-l': { id: 'chief-l', chiefRunId: run.id, chiefInvocation: run.invocation, projectId: 'p', attemptId: 'chief-a', role: 'chief', resourceId: 'r', generation: kind === 'generation' ? 2 : 3, status: kind === 'active' ? 'running' : 'released', worker: { kind: 'sdk', handle: 'sdk-chief' } } }
    const restored = createProjectChiefControl(f.rt); f.rt.projectChiefControl = restored; restored.recover()
    run.recovery = { status: 'waiting-exit', attempts: 0, notBefore: Date.now() - 1 }
    await restored.pump(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(run.status, kind === 'confirmed' ? 'running' : 'interrupted', kind)
  }
})

test('scheduled reminder coalescing and policy changes never re-authorize stale occurrences', async () => {
  const f = await controlFixture()
  await f.request.onResult(f.result({ action: 'continue', reason: 'Finish the original turn' }))
  const policy = f.rt.state.projectChiefPolicies.p
  f.rt.projectAgents.chiefBusy = () => true
  const a = await f.control.request('p', 'inspection', { scheduleId: 's', occurrenceId: 'old' })
  const b = await f.control.request('p', 'inspection', { scheduleId: 's', occurrenceId: 'new' })
  assert.equal(a.status, 'cancelled'); assert.equal(a.recovery.supersededBy, b.id)
  policy.revision++; f.rt.projectAgents.chiefBusy = () => false
  await f.control.pump(); assert.equal(b.status, 'cancelled')
  const reference = await f.control.scheduled({ row: { id: 's', revision: 99, projectId: 'p', config: { prompt: 'Changed' } }, delivery: { id: 'old' } })
  assert.equal(reference.runId, a.id)
})


test('Chief receipt protocol correction precedes all role proposals and Task effects', async () => {
  const f = await controlFixture({ withInputs: true }), run = f.rt.state.projectExecutions[f.request.runId]
  let proposals = 0; f.rt.projectAgents.proposeRoleForJob = async () => { ++proposals; return { proposal: { id: 'proposal' } } }
  const initial = f.request, body = JSON.parse(f.result({ inputReceipts: { batchId: 'typo', read: [], handled: [] } }).text)
  body.roleProposals = [{ action: 'add', role: 'designer', reason: 'Review UI' }]
  await initial.onResult({ ...f.result(), text: JSON.stringify(body) })
  assert.equal(run.status, 'correction-pending', run.failure); assert.equal(proposals, 0); assert.equal(f.accepted(), 0)
  assert.equal(run.correction.feedback[0].receiptFeedback.kind, 'snapshot-schema')
  await f.control.pump()
  assert.equal(f.request.projectId, initial.projectId)
  assert.match(f.request.prompt, /inputReceipts/)
  const batch = f.request.projectFacts.tasks[0].taskInbox
  await f.request.onResult(f.result({ inputReceipts: { batchId: batch.batchId, read: batch.inputs.map(row => row.id), handled: batch.inputs.map(row => row.id) } }))
  assert.equal(run.status, 'done', run.failure); assert.equal(f.accepted(), 1)
  assert.equal(run.correction.status, 'resolved'); assert.equal(proposals, 0)
  await f.rt.projectEffects.close()
})

test('unsupported verification route is corrected by Chief before changing the Task generation', async () => {
  const { chiefProtocolError } = await import('../src/host/project-chief-protocol.js')
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId], generation = f.task.collaboration.generation
  f.rt.projectPools.connect({ validate: () => ({ ok: true }), validateRecovery: async ({ target }) => {
    if (target.role !== 'developer') throw Object.assign(chiefProtocolError('targetBotId', 'a sealed candidate for verification', 't'), { recovery: { kind: 'unsupported-route', actions: ['inspect candidate', 'choose explicit rework'] } })
  }, rework: async () => 'a' })
  await f.request.onResult(f.result({ action: 'route', targetBotId: 'p:reviewer', reason: 'Review candidate' }))
  assert.equal(run.status, 'correction-pending'); assert.equal(f.task.collaboration.generation, generation)
  assert.equal(run.correction.feedback[0].recovery.kind, 'unsupported-route'); assert.equal(f.task.chiefQuestion, undefined)
  await f.control.pump(); await f.request.onResult(f.result({ action: 'return', targetBotId: 'p:developer', reason: 'Produce the missing candidate' }))
  assert.equal(run.status, 'done', run.failure); assert.equal(f.task.collaboration.botId, 'p:developer')
})

test('unmanaged native exit adapter unblocks an interrupted inspection and old invocation callbacks remain fenced', async () => {
  const f = await controlFixture(), old = f.request, run = f.rt.state.projectExecutions[old.runId]
  run.purpose = 'inspection'; delete run.taskId
  let reconciled = 0
  f.rt.projectAgents.reconcileChiefExit = async current => {
    if (current.invocation === 1) { ++reconciled; current.exitProof = { confirmed: true, kind: 'native-chief-prior-host-exited', runId: current.id, invocation: 1 }; return true }
    return false
  }
  const restored = createProjectChiefControl(f.rt); f.rt.projectChiefControl = restored; restored.recover()
  run.recovery = { status: 'waiting-exit', attempts: 0, notBefore: Date.now() - 1 }
  await restored.pump(); await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(run.status, 'running'); assert.equal(run.invocation, 2); assert.equal(reconciled, 1)
  await old.onResult(f.result({ action: 'close', reason: 'Late old response' }))
  assert.equal(f.accepted(), 0, 'old response cannot act through a reused Run record')
})

test('an uncommitted stop intent cannot send a stop or consume the mechanical stop budget', async () => {
  const f = await controlFixture({ modern: true }), run = f.rt.state.projectExecutions[f.request.runId]
  run.purpose = 'inspection'; delete run.taskId
  let stopped = 0; f.rt.projectAgents.stopChiefJob = async () => { ++stopped; return { confirmed: false } }
  const restored = createProjectChiefControl(f.rt); f.rt.projectChiefControl = restored; restored.recover()
  run.recovery = { status: 'waiting-exit', attempts: 0, notBefore: Date.now() - 1 }
  f.rt.save = async () => {}
  await assert.rejects(restored.pump(), /not confirmed/)
  assert.equal(stopped, 0); assert.equal(run.recovery.stopAttempts, 0)
  await f.rt.projectEffects.close()
})

test('Chief consultation decisions carry bounded assistance to the selected operations mailbox', async () => {
  const f = await controlFixture()
  f.rt.state.projectChiefPolicies.p.operationsContact = { memberId: 'operator', agentId: 'ops' }
  f.rt.personalAgents = { agentOf: () => ({ ownerId: 'operator', status: 'active' }), participationFor: () => ({ ownerId: 'operator', status: 'active' }) }
  f.rt.projectCan = () => true
  let addressed
  f.rt.projectAgents.contactUser = (task, question) => { addressed = question; return { kind: 'personal-agent', memberId: 'operator', agentId: 'ops' } }
  const assistance = Object.fromEntries(['cause', 'evidence', 'attempted', 'requestedOperation', 'requiredPermission', 'verification', 'resumeCondition'].map(key => [key, key + ' current scoped facts']))
  await f.request.onResult(f.result({ action: 'needs-human', recipient: 'operations', assistance, reason: 'Need an approved operator fact' }))
  assert.equal(addressed.recipient, 'operations'); assert.equal(addressed.assistance.version, 'chief-assistance/v1')
  assert.equal(f.task.chiefQuestion.assistanceScope.generation, f.task.collaboration.generation)
  assert.equal(f.task.chiefQuestion.recipient.agentId, 'ops')
  assert.match(f.request.prompt, /watch does not grant SSH/)
  assert.equal(f.request.projectFacts.autonomy.maxRecoveryActions, 4)
})

test('Chief transport failure belongs to its Run and preserves business block and approved evidence', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  const evidence = { tests: { sha: 'candidate', passed: true }, review: { sha: 'candidate', verdict: 'approve' } }
  f.rt.state.projectAttempts.a.evidence = structuredClone(evidence)
  f.task.collaboration.block = { reason: 'Await the configured merge check', decisionId: 'business-decision' }
  const block = structuredClone(f.task.collaboration.block)
  await f.request.onResult({ ok: false, text: 'private transport response', recoveryIssue: { kind: 'worker-exit-unknown', retryable: false, conditions: ['exact worker exit'] } })
  assert.equal(run.status, 'failed')
  assert.deepEqual(f.task.collaboration.block, block)
  assert.deepEqual(f.rt.state.projectAttempts.a.evidence, evidence)
  assert.equal(run.failureDetail.stage, 'execution')
  assert.equal(run.failureDetail.responseSha256, null)
  assert.equal(run.failureDetail.diagnosticSha256.length, 64)
  assert.ok(!JSON.stringify(run).includes('private transport response'))
})

test('an out-of-snapshot Task gets correction without dropping or replaying a valid Task decision', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  f.rt.state.tasks.other = { id: 'other', projectId: 'p', title: 'Outside scoped arbitration', criteria: 'unrelated', status: 'working' }
  const response = f.result(), body = JSON.parse(response.text)
  body.decisions.push({ taskId: 'other', action: 'continue', reason: 'This Task is outside this invocation scope' })
  await f.request.onResult({ ...response, text: JSON.stringify(body) })
  assert.equal(f.accepted(), 1)
  assert.equal(run.status, 'correction-pending')
  assert.equal(f.rt.state.tasks.other.status, 'working')
  assert.deepEqual(run.correction.feedback.at(-1).appliedTaskIds, ['t'])
  await f.control.pump()
  await f.request.onResult({ ...f.result(), text: JSON.stringify({ summary: 'Keep the applied decision; no other Task was in scope', decisions: [] }) })
  assert.equal(run.status, 'done', run.failure); assert.equal(f.accepted(), 1)
})

test('stale Chief receipts get fresh-snapshot feedback without consuming input or blocking the new generation', async () => {
  const f = await controlFixture({ withInputs: true }), run = f.rt.state.projectExecutions[f.request.runId]
  const old = f.request.projectFacts.tasks[0].taskInbox
  const input = Object.values(f.rt.state.projectTaskInputs)[0]
  const block = { reason: 'Current business wait', decisionId: 'current' }
  f.task.collaboration.block = structuredClone(block); f.task.collaboration.generation++
  await f.request.onResult(f.result({ action: 'continue', reason: 'Assess current evidence', inputReceipts: { batchId: old.batchId, read: [input.id], handled: [input.id] } }))
  assert.equal(run.status, 'correction-pending')
  assert.equal(run.correction.feedback.at(-1).recovery.kind, 'stale-snapshot')
  assert.equal(input.status, 'accepted'); assert.deepEqual(f.task.collaboration.block, block)
  assert.equal(f.task.chiefDecisionIssue, undefined)
  await f.control.pump()
  const fresh = f.request.projectFacts.tasks[0].taskInbox
  assert.notEqual(fresh.batchId, old.batchId)
  await f.request.onResult(f.result({ action: 'continue', reason: 'Current input is understood; retain responsibility', inputReceipts: { batchId: fresh.batchId, read: [input.id], handled: [input.id] } }))
  assert.equal(run.status, 'done', run.failure); assert.equal(input.status, 'handled')
  assert.ok(!input.deliveries.find(row => row.batchId === old.batchId).handledAt)
  await f.rt.projectEffects.close()
})

test('an old Chief failure cannot change a newer active claim or its business block', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  const claim = { id: 'new-claim', status: 'active', botId: 'p:developer', generation: ++f.task.collaboration.generation }
  f.task.collaboration.claim = claim; f.task.collaboration.block = { reason: 'New-generation facts', decisionId: 'new' }
  await f.request.onResult({ ok: false, text: 'Old result' })
  assert.equal(run.status, 'failed'); assert.equal(claim.status, 'active')
  assert.equal(f.task.collaboration.block.decisionId, 'new'); assert.equal(f.task.chiefActionIssue, undefined)
})

test('malformed JSON uses existing correction with response hash and never repairs acceptance booleans', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  await f.request.onResult({ ...f.result(), text: f.result().text.replace('"passed":true', '"passed:true,"') })
  assert.equal(run.status, 'correction-pending'); assert.equal(f.accepted(), 0)
  assert.equal(run.invocationHistory[0].responseSha256, run.lastResult.responseSha256)
  assert.equal(run.correction.feedback[0].fields[0].field, 'response')
  assert.ok(!/SyntaxError|Expected.*property/.test(run.failure))
})

test('close refusal names the missing acceptance evidence rather than revoking an existing Review', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  f.rt.state.projectAttempts.a.evidence.review = { verdict: 'approve', sha: 'candidate' }
  await f.request.onResult(f.result({ criteria: [{ criterion: 'Actual condition', passed: false, evidence: '' }] }))
  assert.equal(run.recoveryIssue.kind, 'acceptance-evidence-missing')
  assert.ok(run.failureDetail.criteriaIssues.some(row => row.startsWith('criteria[0].evidence')))
  assert.equal(f.rt.state.projectAttempts.a.evidence.review.verdict, 'approve')
})

test('same protocol feedback permits different lawful Chief choices rather than a fixed recovery route', async () => {
  for (const action of ['continue', 'route']) {
    const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
    f.rt.projectPools.connect({ validate: () => ({ ok: true }), rework: async () => 'a' })
    await f.request.onResult(f.result({ action: 'route' }))
    assert.equal(run.status, 'correction-pending')
    await f.control.pump()
    await f.request.onResult(f.result({ action, ...(action === 'route' ? { targetBotId: 'p:developer' } : {}), reason: 'Choose this legal next step from current facts' }))
    assert.equal(run.status, 'done', run.failure)
    assert.equal(f.task.chiefQuestion, undefined)
    assert.equal(f.task.collaboration.status, action === 'route' ? 'queued' : 'blocked')
  }
})

test('Chief explicitly invokes the shared exit-retirement action without the host choosing a next role', async () => {
  const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
  const saved = f.request.projectFacts.tasks[0], calls = []
  f.rt.projectDelivery.reconcileExit = async (body, actor) => { calls.push(body); f.control.requireJobActor(actor, 'p'); return { generation: body.generation + 1 } }
  await f.request.onResult(f.result({ action: 'reconcile-exit', reason: 'The old exact execution is proven exited; retire responsibility only' }))
  assert.equal(run.status, 'done', run.failure); assert.equal(calls.length, 1)
  assert.equal(calls[0].claimId, saved.execution.claimId)
  assert.equal(calls[0].generation, saved.generation)
  assert.notEqual(f.task.collaboration.status, 'queued'); assert.equal(f.task.chiefQuestion, undefined)
})

test('typed criteria and null decisions return protocol correction rather than a host TypeError', async () => {
  for (const value of ['wrong-criteria', null]) {
    const f = await controlFixture(), run = f.rt.state.projectExecutions[f.request.runId]
    const result = f.result(), body = JSON.parse(result.text)
    if (value === null) body.decisions = [null]
    else body.decisions[0].criteria = value
    await f.request.onResult({ ...result, text: JSON.stringify(body) })
    assert.equal(run.status, 'correction-pending'); assert.equal(f.accepted(), 0)
    assert.ok(!/TypeError|SyntaxError/.test(run.failure))
  }
})

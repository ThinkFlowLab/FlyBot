import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { createReviewedMerge } from '../src/host/project-reviewed-merge.js'
import { assembleRolePolicy } from '../src/host/project-role-policy.js'
function fixture({ native = false } = {}) {
  let clock = 100, writes = 0, reads = 0, mode = 'merged', failSave = false
  const sha = 'a'.repeat(40), policy = assembleRolePolicy({ role: 'reviewer', sources: [], profile: 'project-decision' })
  const session = { id: 'session', projectId: 'p', taskId: 't', attemptId: 'a', role: 'reviewer', botId: 'worker', poolClaimId: 'claim', generation: 2, execution: { harness: native ? 'flybot' : 'codex' }, backendSessionId: 'thread', resourceLease: { id: 'lease', generation: 1 }, context: { sources: { policy: { sha256: policy.sha256 } } } }
  const attempt = { id: 'a', projectId: 'p', taskId: 't', candidateSha: sha, initiatedBy: 'owner', branch: 'flybot/a', requirement: { repository: 'example/demo' }, rolePolicies: { reviewer: policy }, roleSessions: { reviewer: session }, evidence: { tests: { sha, passed: true, sha256: 'test-hash' }, review: { sha, verdict: 'approve', logicalRole: 'reviewer', roleSessionId: session.id, policySha256: policy.sha256 } }, pr: { repository: 'example/demo', number: 1, sha, branch: 'flybot/a', creatorLogin: 'automation', identity: { provider: 'gh-cli', login: 'automation' }, publicationMarker: 'original' } }
  const task = { id: 't', projectId: 'p', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'owner', history: [{ execution: { id: 'claim', generation: 2, workerId: 'worker', status: 'completed', exitConfirmed: true } }] } }
  const worker = { id: 'worker', projectId: 'p', taskId: 't', attemptId: 'a', role: 'reviewer', sessionKey: 'session', backendSessionId: 'thread', status: 'released', generation: 1, leaseId: 'lease', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', workerId: 'worker', generation: 1 } }
  if (native) Object.assign(worker, { version: 'project-native-worker/v2', sessionId: 'native-session', bindingKey: 'binding', status: 'quiescent', leaseId: undefined, releaseProof: { kind: 'native-agent-quiescent', workerId: 'worker', sessionId: 'native-session', generation: 1, bindingKey: 'binding', registeredWorkEmpty: true } })
  const rt = { state: { tasks: { t: task }, projectAttempts: { a: attempt }, projectResourceLeases: { lease: { id: 'lease', status: 'released' } }, projectHarnessWorkers: native ? {} : { worker }, projectNativeWorkers: native ? { worker } : {} }, readOnly: () => undefined, requireProjectAccess(actor) { assert.equal(actor.memberId, 'owner') }, projectScheduler: { wake() {} }, async save() { if (failSave) throw new Error('disk failed'); rt.projectEffects.saved(rt.projectEffects.capture()) } }
  rt.projectEffects = createProjectEffects(rt, { now: () => clock })
  const settings = { mergePolicy: { enabled: true, branches: ['delivery'], method: 'squash', requiredChecks: [], pollIntervalMs: 5000, maxWaitMs: 10000 } }, project = { id: 'p', repository: 'example/demo', defaultBranch: 'delivery' }
  const makeHost = () => createReviewedMerge(rt, { now: () => clock, projectOf: () => project, settingsOf: () => settings, serialAttempt: (_id, fn) => fn(), validatePublication: async effect => { assert.equal(effect.payload.candidateSha, attempt.candidateSha) }, publisherOf: () => ({ async merge(_intent, _policy, beforeWrite) {
    ++reads
    if (mode === 'lost') { await beforeWrite({ operation: 'merge', candidateSha: sha }); ++writes; throw Error('lost response') }
    if (mode === 'waiting') return { status: 'waiting', reason: 'required-check-pending', observedAt: clock }
    return { status: 'merged', reason: 'provider-confirmed', mergeCommitSha: 'b'.repeat(40), observedAt: clock }
  } }) })
  let host = makeHost()
  return { rt, get host() { return host }, get attempt() { return rt.state.projectAttempts.a }, get task() { return rt.state.tasks.t }, session, worker, settings, async restart() { rt.state = structuredClone(rt.state); rt.projectEffects = createProjectEffects(rt, { now: () => clock }); host = makeHost(); rt.projectEffects.recover(); await rt.save() }, tick(value) { clock += value }, mode(value) { mode = value }, fail(value) { failSave = value }, counts: () => ({ reads, writes }) }
}
for (const native of [false, true]) test((native ? 'native' : 'SDK') + ' exact Reviewer approval stages one original Effect and records merge separately from Task acceptance', async () => {
  const f = fixture({ native }), token = await f.host.stage(f.attempt)
  assert.equal((await f.host.stage(f.attempt)).id, token.id)
  await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.status, 'merged'); assert.equal(f.attempt.merge.version, 'project-reviewed-merge/v1'); assert.equal(f.attempt.evidence.merge.sha, f.attempt.candidateSha)
  assert.equal(f.attempt.status, undefined); assert.equal(f.task.status, undefined)
  assert.equal(f.rt.state.projectEffects[token.id].status, 'done')
  assert.equal(f.host.requireMerged(f.attempt, { merged: true, mergeCommitSha: 'b'.repeat(40), baseRef: 'delivery' }), true)
  await f.rt.projectEffects.drain(); assert.equal(f.counts().reads, 1)
})
test('unknown write survives restart-style reconciliation without replaying code, tests, review or a merge write', async () => {
  const f = fixture(); f.mode('lost'); const token = await f.host.stage(f.attempt)
  await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.status, 'unknown'); assert.equal(f.counts().writes, 1)
  assert.equal(f.rt.state.projectEffects[token.id].status, 'pending')
  f.mode('merged'); f.tick(5000); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.status, 'merged'); assert.equal(f.counts().writes, 1)
  assert.deepEqual(Object.keys(f.attempt.roleSessions), ['reviewer'])
})
test('changed policy, forged role and incomplete handoff cannot borrow a prior approval', async () => {
  for (const kind of ['policy', 'role', 'claim', 'exit']) {
    const f = fixture(); await f.host.stage(f.attempt)
    if (kind === 'policy') f.settings.mergePolicy.method = 'merge'
    if (kind === 'role') f.session.role = 'developer'
    if (kind === 'claim') f.task.collaboration.history[0].execution.status = 'blocked'
    if (kind === 'exit') f.worker.status = 'unreachable'
    await f.rt.projectEffects.drain()
    assert.equal(f.counts().reads, 0, kind); assert.notEqual(f.attempt.merge.status, 'merged')
  }
})
test('new unhandled Task feedback holds merge without fabricating a receipt or rerunning the Reviewer', async () => {
  const f = fixture(); let handled = false
  f.rt.projectInputs = { requireHandled() { if (!handled) throw Error('unhandled') } }
  await f.host.stage(f.attempt); await f.rt.projectEffects.drain(); assert.equal(f.counts().reads, 0)
  handled = true; f.tick(1000); await f.rt.projectEffects.drain(); assert.equal(f.attempt.merge.status, 'merged')
})
test('failed commit cannot start a merge; terminal wait budget renews only through an authorized original Effect retry', async () => {
  const f = fixture(); f.fail(true)
  await assert.rejects(f.host.stage(f.attempt), /disk failed/); assert.equal(f.attempt.merge, undefined); assert.equal(f.counts().writes, 0)
  f.fail(false); f.mode('waiting'); const token = await f.host.stage(f.attempt)
  await f.rt.projectEffects.drain(); f.tick(11000); await f.rt.projectEffects.drain()
  assert.equal(f.rt.state.projectEffects[token.id].status, 'failed'); assert.equal(f.attempt.merge.reason, 'merge-wait-budget-exhausted')
  await f.rt.projectEffects.retry({ projectId: 'p', effectId: token.id, requestId: 'repair-ci' }, { memberId: 'owner' })
  f.mode('merged'); await f.rt.projectEffects.drain(); assert.equal(f.attempt.merge.status, 'merged')
})

test('confirmed merge hands off after notification recovery independently of the merge wait budget', async () => {
  const f = fixture(); let requests = 0
  f.rt.state.projectChiefPolicies = { p: { enabled: true, authorityMemberId: 'owner', revision: 1 } }
  f.rt.projectChiefControl = { async request() { ++requests; throw Error('simulated Chief persistence failure') } }
  const token = await f.host.stage(f.attempt)
  await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.status, 'merged')
  await f.rt.projectEffects.drain()
  assert.equal(requests, 1)
  assert.equal(f.rt.state.projectEffects[token.id].status, 'done', 'Notification failure cannot undo the completed merge Effect')
  f.rt.projectChiefControl.request = async () => { ++requests; return { id: 'recovered-chief', status: 'queued' } }
  f.tick(11000); await f.rt.projectEffects.drain()
  assert.equal(requests, 2)
  assert.equal(f.attempt.merge.status, 'merged')
  assert.equal(f.attempt.merge.chiefHandoff.runId, 'recovered-chief')
  assert.equal(f.counts().reads, 1, 'No second provider merge call is needed to hand off')
  assert.notEqual(f.task.status, 'accepted', 'Chief still owns acceptance')
})

function enableChief(f, request) {
  f.rt.state.projectChiefPolicies = { p: { enabled: true, authorityMemberId: 'owner', revision: 1 } }
  f.rt.projectChiefControl = { request: request ?? (async (projectId, purpose, source, taskId) => {
    const row = { id: 'chief-merged', kind: 'chief-control', projectId, purpose, source, taskId, status: 'queued' }
    ;(f.rt.state.projectExecutions ??= {})[row.id] = row
    return row
  }) }
}

test('restart after committed merge discovers exactly one durable scoped Chief handoff', async () => {
  const f = fixture(); let requests = 0
  enableChief(f, async (_p, _kind, source, taskId) => { ++requests; assert.equal(taskId, 't'); assert.equal(source.candidateSha, f.attempt.candidateSha); return { id: 'chief-resumed' } })
  const token = await f.host.stage(f.attempt); await f.rt.projectEffects.drain()
  assert.equal(requests, 0)
  assert.ok(f.rt.projectEffects.intentCommitted(f.attempt.merge.chiefHandoff.effect))
  await f.restart(); f.tick(11000)
  await f.host.reconcileHandoffs(); await f.rt.projectEffects.drain()
  await f.host.reconcileHandoffs(); await f.rt.projectEffects.drain()
  assert.equal(requests, 1); assert.equal(f.counts().reads, 1)
  assert.equal(f.rt.state.projectEffects[token.id].status, 'done')
})

test('lost request response reuses the persisted Chief Run after restart', async () => {
  const f = fixture(); let requests = 0
  enableChief(f, async (projectId, purpose, source, taskId) => {
    ++requests
    f.rt.state.projectExecutions = { original: { id: 'original', kind: 'chief-control', projectId, purpose, source, taskId, status: 'queued' } }
    await f.rt.save(); throw Error('response lost after Run commit')
  })
  await f.host.stage(f.attempt); await f.rt.projectEffects.drain(); await f.rt.projectEffects.drain()
  assert.equal(requests, 1)
  await f.restart(); f.tick(3000); await f.rt.projectEffects.drain()
  assert.equal(requests, 1); assert.equal(f.attempt.merge.chiefHandoff.runId, 'original')
  assert.equal(Object.keys(f.rt.state.projectExecutions).length, 1)
})

test('existing Chief execution or correction is allowed to finish before a new merge judgement', async () => {
  for (const status of ['queued', 'running', 'correction-pending', 'interrupted']) {
    const f = fixture(); enableChief(f)
    f.rt.state.projectExecutions = { old: { id: 'old', kind: 'chief-control', projectId: 'p', taskId: 't', status } }
    await f.host.stage(f.attempt); await f.rt.projectEffects.drain(); await f.rt.projectEffects.drain()
    assert.equal(f.attempt.merge.chiefHandoff.waitingRunId, 'old')
    assert.equal(Object.keys(f.rt.state.projectExecutions).length, 1)
    f.rt.state.projectExecutions.old.status = 'failed'; f.rt.state.projectExecutions.old.failure = 'Previous execution diagnostic'
    f.tick(2000); await f.rt.projectEffects.drain()
    assert.equal(f.attempt.merge.chiefHandoff.runId, 'chief-merged')
    assert.equal(f.rt.state.projectExecutions.old.failure, 'Previous execution diagnostic')
  }
})

test('historical saved merge repairs only its handoff and retains exhausted merge audit', async () => {
  const f = fixture(); enableChief(f)
  const token = await f.host.stage(f.attempt); await f.rt.projectEffects.drain()
  delete f.rt.state.projectEffects[f.attempt.merge.chiefHandoff.effect.id]; delete f.attempt.merge.chiefHandoff
  Object.assign(f.attempt.merge, { status: 'blocked', reason: 'merge-wait-budget-exhausted' })
  f.rt.state.projectEffects[token.id].status = 'failed'
  await f.restart(); f.tick(20000)
  await f.host.reconcileHandoffs(); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.status, 'merged')
  assert.equal(f.attempt.merge.chiefHandoff.runId, 'chief-merged')
  assert.equal(f.rt.state.projectEffects[token.id].status, 'failed', 'Original failure audit is not rewritten')
  assert.equal(f.counts().reads, 1, 'Backfill does not re-run an external merge')
})

test('unbound PR text, replaced candidate, cancellation and revoked authority cannot authorize closure handoff', async () => {
  for (const kind of ['candidate', 'task-attempt', 'cancelled', 'repository', 'proof', 'authority']) {
    const f = fixture(); let requests = 0; enableChief(f, async () => { ++requests; return { id: 'unexpected' } })
    await f.host.stage(f.attempt); await f.rt.projectEffects.drain()
    if (kind === 'candidate') f.attempt.candidateSha = 'c'.repeat(40)
    if (kind === 'task-attempt') f.task.deliveryAttemptId = 'replacement'
    if (kind === 'cancelled') f.attempt.cancelRequested = true
    if (kind === 'repository') f.attempt.evidence.merge.repository = 'other/project'
    if (kind === 'proof') { delete f.attempt.evidence.merge; f.attempt.pr.merged = true }
    if (kind === 'authority') f.rt.requireProjectAccess = () => { throw Object.assign(Error('revoked'), { code: 'bot/forbidden' }) }
    await f.rt.projectEffects.drain(); assert.equal(requests, 0, kind)
    assert.notEqual(f.task.status, 'accepted', kind)
  }
})

test('missing Chief authority defers notification while retaining the completed merge', async () => {
  const f = fixture(); await f.host.stage(f.attempt); await f.rt.projectEffects.drain(); await f.rt.projectEffects.drain()
  const handoff = f.rt.state.projectEffects[f.attempt.merge.chiefHandoff.effect.id]
  assert.equal(handoff.waitingFor, 'chief-authority'); assert.equal(handoff.failures, 0)
  enableChief(f); f.tick(2000); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.chiefHandoff.runId, 'chief-merged')
  assert.equal(f.attempt.merge.status, 'merged')
})

test('notification-intent save failure recovers trusted merge proof without another provider call', async () => {
  const f = fixture(); enableChief(f)
  const save = f.rt.save; let failed = false
  f.rt.save = async () => {
    if (!failed && Object.values(f.rt.state.projectEffects).some(row => row.kind === 'chief.merge-handoff')) { failed = true; throw Error('handoff snapshot write failed') }
    return save()
  }
  await f.host.stage(f.attempt); await f.rt.projectEffects.drain()
  assert.equal(failed, true); assert.ok(f.attempt.evidence.merge)
  assert.equal(f.attempt.merge.chiefHandoff, undefined)
  f.rt.save = save; await f.restart(); f.tick(20000)
  await f.host.reconcileHandoffs(); await f.rt.projectEffects.drain()
  assert.equal(f.attempt.merge.chiefHandoff.runId, 'chief-merged')
  assert.equal(f.counts().reads, 1)
  assert.equal(f.attempt.merge.status, 'merged')
})

test('handoff recovery bounds each discovery pass and eventually covers later merged Tasks', async () => {
  const f = fixture(); enableChief(f)
  const original = await f.host.stage(f.attempt); await f.rt.projectEffects.drain()
  const proof = f.attempt.evidence.merge, source = f.rt.state.projectEffects[original.id]
  delete f.rt.state.projectEffects[f.attempt.merge.chiefHandoff.effect.id]; delete f.attempt.merge.chiefHandoff
  for (let index = 1; index < 40; ++index) {
    const attempt = structuredClone(f.attempt), effect = structuredClone(source), task = structuredClone(f.task)
    attempt.id = `a${index}`; task.id = attempt.taskId = `t${index}`; task.deliveryAttemptId = attempt.id
    effect.id = attempt.merge.effectId = attempt.evidence.merge.effectId = `merge${index}`
    effect.taskId = task.id; effect.payload.attemptId = attempt.id
    f.rt.state.projectAttempts[attempt.id] = attempt; f.rt.state.tasks[task.id] = task; f.rt.state.projectEffects[effect.id] = effect
  }
  assert.equal(proof.sha, f.attempt.candidateSha)
  const first = await f.host.reconcileHandoffs()
  assert.ok(first > 0 && first < 40)
  await f.host.reconcileHandoffs()
  assert.equal(Object.values(f.rt.state.projectAttempts).filter(row => row.merge.chiefHandoff).length, 40)
  assert.equal(f.counts().reads, 1)
})

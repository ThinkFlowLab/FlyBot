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
  const host = createReviewedMerge(rt, { now: () => clock, projectOf: () => project, settingsOf: () => settings, serialAttempt: (_id, fn) => fn(), validatePublication: async effect => { assert.equal(effect.payload.candidateSha, attempt.candidateSha) }, publisherOf: () => ({ async merge(_intent, _policy, beforeWrite) {
    ++reads
    if (mode === 'lost') { await beforeWrite({ operation: 'merge', candidateSha: sha }); ++writes; throw Error('lost response') }
    if (mode === 'waiting') return { status: 'waiting', reason: 'required-check-pending', observedAt: clock }
    return { status: 'merged', reason: 'provider-confirmed', mergeCommitSha: 'b'.repeat(40), observedAt: clock }
  } }) })
  return { rt, host, attempt, task, session, worker, settings, tick(value) { clock += value }, mode(value) { mode = value }, fail(value) { failSave = value }, counts: () => ({ reads, writes }) }
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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { pinTaskRoleDefinition } from '../src/host/project-task-sessions.js'
import { createProjectNativeSessions, nativeExitConfirmed } from '../src/host/project-native-sessions.js'
function fixture() {
  let cancelled = 0, archived = [], unarchived = [], hold, failure = false
  const session = { id: 'role-1', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', generation: 1, definition: { role: 'developer', instructions: 'Original convention' }, status: 'prepared' }
  const workspace = { id: 'workspace-1', path: '/registered/task', attemptId: 'a' }
  const agent = { session: { id: 'physical-1' }, status: 'idle', cancel() { cancelled++ }, async whenIdle() { if (hold) await hold; if (failure) throw Error('native drain failed') } }
  const rt = { state: { tasks: { t: { projectId: 'p' } }, bots: { bot1: { id: 'bot1', sessionId: 'physical-1', workspaceId: workspace.id, attemptId: 'a' } } },
    ctx: { async parallel() {}, async waterfall(_event, _payload, next) { return next() }, sessions: { get: () => undefined }, agents: { get: id => id === 'physical-1' ? agent : undefined }, workspaceRegistry: { async archiveSession(id) { archived.push(id) }, async unarchiveSession(id) { unarchived.push(id) } } },
    botOf(id) { return rt.state.bots[id] }, chatOf(id) { return rt.state.bots[id]?.sessionId ?? id }, indexSessions() {}, resolveAgent: async () => agent, async save() { const captured = rt.projectEffects.capture(); rt.projectEffects.saved(captured) } }
  rt.projectEffects = createProjectEffects(rt)
  return { rt, session, workspace, agent, service: createProjectNativeSessions(rt), cancelled: () => cancelled, archived: () => archived, unarchived: () => unarchived, hold(value) { hold = value }, fail(value) { failure = value } }
}
test('native deletion or cancellation acknowledgement alone does not prove quiescence', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  let release; f.hold(new Promise(resolve => { release = resolve }))
  const stopping = f.service.stop('bot1')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.cancelled(), 1); assert.equal(f.service.admits('bot1'), false)
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), false)
  release(); await stopping
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), true)
  assert.equal((await f.service.stop('bot1')).workerId, 'bot1'); assert.equal(f.cancelled(), 1)
})
test('a fresh native carrier resumes only the exact latest released Task-role physical Session', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.stop('bot1')
  delete f.rt.state.bots.bot1
  f.rt.state.bots.bot2 = { id: 'bot2', workspaceId: 'workspace-2', attemptId: 'a2' }
  const session = { ...f.session, id: 'role-2', attemptId: 'a2', status: 'prepared' }, workspace = { ...f.workspace, id: 'workspace-2', attemptId: 'a2' }
  const result = await f.service.bind(session, workspace, 'bot2')
  await f.service.activate(session, 'bot2')
  assert.equal(result.sessionId, 'physical-1'); assert.deepEqual(f.archived(), ['bot2'])
  assert.deepEqual(f.unarchived(), ['physical-1'], 'The original archived Session must be admitted by DSH only after exact binding')
  assert.equal(f.rt.state.retiredSessions.bot2, 'bot2', 'Unused carrier Session stays managed and cannot become an unowned plain Session')
  assert.equal(f.rt.state.bots.bot1, undefined)
  assert.equal(f.rt.state.projectTaskSessions[Object.keys(f.rt.state.projectTaskSessions)[0]].bindings.length, 2)
})
test('native incompatible cwd, definition, unknown exit and foreign bindings refuse silent fresh sessions', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  assert.throws(() => f.service.previous(f.session, f.workspace), /forbidden/)
  await f.service.stop('bot1'); delete f.rt.state.bots.bot1
  for (const [session, workspace] of [[f.session, { ...f.workspace, path: '/other' }], [{ ...f.session, definition: { role: 'developer', instructions: 'Changed convention' } }, f.workspace], [{ ...f.session, role: 'reviewer' }, f.workspace]]) {
    if (session.role === 'reviewer') assert.equal(f.service.previous(session, workspace).row, null)
    else assert.throws(() => f.service.previous(session, workspace), /forbidden/)
  }
  f.rt.state.projectNativeWorkers.bot1.releaseProof.generation++
  assert.throws(() => f.service.previous(f.session, f.workspace), /forbidden/)
})
test('failed native drain keeps execution held and denies later input', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1'); f.fail(true)
  await assert.rejects(f.service.stop('bot1'), /drain failed/)
  assert.equal(f.rt.state.projectNativeWorkers.bot1.status, 'stop-unconfirmed')
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), false)
  assert.equal(f.service.admits('bot1'), false)
})


test('native restoration preserves current context parts and refuses a changed execution model', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  f.rt.state.bots.bot1.sessionId = 'physical-part-2'
  f.rt.state.bots.bot1.segments = [{ sessionId: 'physical-1', endedAt: 1 }]
  f.agent.session.id = 'physical-part-2'
  await f.service.stop('bot1'); delete f.rt.state.bots.bot1
  f.rt.state.bots.bot2 = { id: 'bot2', workspaceId: 'workspace-2', attemptId: 'a2', model: 'other-model' }
  const session = { ...f.session, id: 'role-2', attemptId: 'a2', status: 'prepared' }, workspace = { ...f.workspace, id: 'workspace-2', attemptId: 'a2' }
  await assert.rejects(f.service.bind(session, workspace, 'bot2'), /model changed/)
  delete f.rt.state.bots.bot2.model
  const result = await f.service.bind(session, workspace, 'bot2')
  await f.service.activate(session, 'bot2')
  assert.equal(result.sessionId, 'physical-part-2')
  assert.deepEqual(f.rt.state.bots.bot2.segments, [{ sessionId: 'physical-1', endedAt: 1 }])
})
test('unknown prior host and legacy native context remain explicitly fenced without reopening a Session', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  const restarted = createProjectNativeSessions(f.rt)
  await assert.rejects(restarted.stop('bot1'), /earlier host/)
  assert.equal(restarted.admits('bot1'), false); assert.equal(f.cancelled(), 0)
  const g = fixture()
  g.rt.state.projectAttempts = { old: { projectId: 'p', taskId: 't', roleSessions: { developer: { id: 'legacy-role', role: 'developer', sessionId: 'legacy-session', execution: { harness: 'flybot' } } } } }
  assert.throws(() => g.service.previous(g.session, g.workspace), /Legacy native/)
})
test('current pool claim authority is required before any native carrier binding', async () => {
  const f = fixture()
  f.session.poolClaimId = 'claim'; f.rt.state.tasks.t.deliveryAttemptId = 'a'
  f.rt.state.tasks.t.collaboration = { initiatedBy: 'owner', generation: 1, claim: { id: 'other', generation: 1, status: 'active' } }
  f.rt.requireProjectAccess = () => {}
  await assert.rejects(f.service.bind(f.session, f.workspace, 'bot1'), /claim changed/)
  assert.deepEqual(f.rt.state.projectNativeWorkers, undefined)
})
test('overlapping native binds cannot attach two carriers to the same restored physical Session', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.stop('bot1'); delete f.rt.state.bots.bot1
  let release; const gate = new Promise(resolve => { release = resolve })
  f.rt.resolveAgent = async () => { await gate; return f.agent }
  f.rt.state.bots.bot2 = { id: 'bot2', workspaceId: 'workspace-2', attemptId: 'a2' }
  f.rt.state.bots.bot3 = { id: 'bot3', workspaceId: 'workspace-2', attemptId: 'a2' }
  const session = { ...f.session, id: 'role-2', attemptId: 'a2', status: 'prepared' }, workspace = { ...f.workspace, id: 'workspace-2', attemptId: 'a2' }
  const first = f.service.bind(session, workspace, 'bot2')
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.service.bind({ ...session }, workspace, 'bot3'), /already in progress/)
  release(); await first
  const logical = Object.values(f.rt.state.projectTaskSessions)[0]
  assert.equal(logical.bindings.length, 2); assert.equal(logical.bindings.at(-1).workerId, 'bot2')
})


test('native bind rechecks pinned current permissions and rejects a claim revoked during authorization', async () => {
  const f = fixture()
  f.rt.state.projectAgentDefinitions = { p: { revision: 1, roles: [f.session.definition] } }
  const pinned = pinTaskRoleDefinition(f.rt.state, f.session, f.session.definition, 1)
  f.session.definitionRef = pinned.definitionRef
  f.session.poolClaimId = 'claim'; f.rt.state.tasks.t.deliveryAttemptId = 'a'
  f.rt.state.tasks.t.collaboration = { initiatedBy: 'owner', generation: 1, claim: { id: 'claim', generation: 1, status: 'active' } }
  let checks = 0; f.rt.requireProjectAccess = () => { checks++ }
  f.rt.projectDelegations = { background: async () => {} }
  await f.service.bind(f.session, f.workspace, 'bot1')
  assert.equal(checks, 2)
  const g = fixture()
  g.session.poolClaimId = 'claim'; g.rt.state.tasks.t.deliveryAttemptId = 'a'
  g.rt.state.tasks.t.collaboration = { initiatedBy: 'owner', generation: 1, claim: { id: 'claim', generation: 1, status: 'active' } }
  g.rt.requireProjectAccess = () => {}
  g.rt.projectDelegations = { background: async () => { g.rt.state.tasks.t.collaboration.claim.status = 'revoked' } }
  await assert.rejects(g.service.bind(g.session, g.workspace, 'bot1'), /revoked during/)
  assert.equal(g.rt.state.projectNativeWorkers, undefined)
  const h = fixture(); h.session.definitionRef = 'missing-definition'
  await assert.rejects(h.service.bind(h.session, h.workspace, 'bot1'), /definition is unavailable/)
})


test('a noncommitting native binding cannot lift archive admission or authorize new model input', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.stop('bot1'); delete f.rt.state.bots.bot1
  f.rt.state.bots.bot2 = { id: 'bot2', workspaceId: 'workspace-2', attemptId: 'a2' }
  const session = { ...f.session, id: 'role-2', attemptId: 'a2', status: 'prepared' }, workspace = { ...f.workspace, id: 'workspace-2', attemptId: 'a2' }
  f.rt.save = async () => {} // Resolving is not evidence that the binding reached disk.
  await f.service.bind(session, workspace, 'bot2')
  assert.deepEqual(f.unarchived(), [], 'Uncommitted restoration must leave the original DSH archive gate intact')
  assert.equal(f.service.admits('bot2'), false)
  await assert.rejects(f.service.activate(session, 'bot2'), /commit/)
  assert.deepEqual(f.unarchived(), [])
})


test('native activation needs committed binding and current writable epoch before input admission', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  assert.equal(f.service.admits('bot1'), false)
  await f.service.activate(f.session, 'bot1')
  assert.equal(f.service.admits('bot1'), true)
  const restarted = createProjectNativeSessions(f.rt)
  assert.equal(restarted.admits('bot1'), false, 'A previous host epoch cannot silently restart native input')
  f.rt.readOnly = () => 'Another writer holds the home'
  assert.equal(f.service.admits('bot1'), false)
  await assert.rejects(f.service.activate(f.session, 'bot1'), /writable host/)
  assert.equal(f.service.admits('unrelated-personal-chief'), true)
})

function supervisedLease(f) {
  const lease = { id: 'native-lease', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', sessionKey: f.session.id, resourceId: 'native-resource', generation: 7, status: 'running',
    worker: { kind: 'native', botId: 'bot1' }, processScope: { kind: 'systemd-control-group', killMode: 'control-group', invocationId: 'a'.repeat(32), bootId: 'same-boot', unit: 'flybot.service', controlGroup: '/system.slice/flybot.service', hostPid: 12345 } }
  f.session.resourceLease = { ...lease }
  f.rt.state.projectResourceLeases = { [lease.id]: lease }
  f.rt.state.projectAttempts = { a: { id: 'a', projectId: 'p', taskId: 't', roleSessions: { developer: f.session } } }
  return lease
}
test('supervisor-confirmed old host exit preserves the latest native context without resuming a stale worker', async () => {
  const f = fixture(), lease = supervisedLease(f)
  await f.service.bind(f.session, f.workspace, 'bot1')
  f.rt.state.bots.bot1.sessionId = 'latest-native-part'; f.rt.state.bots.bot1.segments = [{ sessionId: 'physical-1', endedAt: 1 }]
  f.rt.resolveAgent = async () => { throw Error('Must not resume old activity to manufacture exit proof') }
  let checks = 0
  const restarted = createProjectNativeSessions(f.rt, { priorExit: async scope => { checks++; return scope.invocationId === 'a'.repeat(32) } })
  const proof = await restarted.stop('bot1')
  assert.equal(checks, 1); assert.equal(f.cancelled(), 0)
  assert.equal(proof.kind, 'systemd-prior-invocation-exited'); assert.equal(proof.previousInvocationId, lease.processScope.invocationId)
  assert.equal(proof.sessionId, 'latest-native-part'); assert.equal(f.session.sessionId, 'latest-native-part')
  const row = f.rt.state.projectNativeWorkers.bot1
  assert.equal(nativeExitConfirmed(f.rt.state, row), true)
  lease.status = 'released'; lease.releaseProof = proof; delete f.rt.state.bots.bot1
  assert.equal(restarted.previous({ ...f.session, id: 'next-role' }, f.workspace).row, row)
})
test('native old-host recovery rejects missing process-group proof and scope changes during inspection', async () => {
  for (const variant of ['unconfirmed', 'unmanaged', 'changed']) {
    const f = fixture(), lease = supervisedLease(f)
    await f.service.bind(f.session, f.workspace, 'bot1')
    if (variant === 'unmanaged') lease.processScope.kind = 'unmanaged-process'
    const restarted = createProjectNativeSessions(f.rt, { priorExit: async () => {
      if (variant === 'changed') lease.generation++
      return variant !== 'unconfirmed'
    } })
    await assert.rejects(restarted.stop('bot1'), /host|scope|binding|generation/)
    assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), false)
    assert.equal(lease.status, 'running')
  }
})

test('native exit remains unconfirmed while registered jobs or subagents are still stopping', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1')
  let requested = 0
  f.rt.ctx.parallel = async (event, body) => { assert.equal(event, 'workspace/session-stop'); assert.equal(body.sessionId, 'physical-1'); requested++ }
  f.rt.ctx.waterfall = async () => [{ kind: 'job', items: [{ id: 'still-stopping-job' }] }, { kind: 'subagent', items: [{ id: 'child' }] }]
  await assert.rejects(f.service.stop('bot1'), /registered session work/)
  const row = f.rt.state.projectNativeWorkers.bot1
  assert.equal(nativeExitConfirmed(f.rt.state, row), false)
  assert.deepEqual(row.pendingWork, [{ kind: 'job', count: 1 }, { kind: 'subagent', count: 1 }])
  f.rt.ctx.waterfall = async () => []
  await f.service.stop('bot1')
  assert.equal(requested, 2); assert.equal(nativeExitConfirmed(f.rt.state, row), true)
  assert.equal(row.releaseProof.registeredWorkEmpty, true)
})
test('native admission fences subagent lineage and missing legacy execution bindings while preserving ordinary Bots', async () => {
  const f = fixture()
  f.rt.selfOf = id => id === 'physical-1' ? 'bot1' : id === 'legacy-session' ? 'legacy' : id === 'personal-session' ? 'personal' : undefined
  f.rt.state.bots.legacy = { id: 'legacy', ephemeral: { plugin: 'flybot-workflow' }, workspaceId: 'w', attemptId: 'old' }
  f.rt.state.bots.personal = { id: 'personal' }
  await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.activate(f.session, 'bot1')
  const child = { session: { id: 'child', header: { id: 'child', origin: 'subagent', parentSession: 'physical-1' } } }
  assert.equal(f.service.admitsAgent(child), true)
  await f.service.stop('bot1')
  assert.equal(f.service.admitsAgent(child), false)
  assert.equal(f.service.admitsAgent({ session: { id: 'legacy-session' } }), false)
  assert.equal(f.service.admitsAgent({ session: { id: 'personal-session' } }), true)
})
test('native host scope is captured without a resource and supports only actual supervisor exit recovery', async () => {
  const f = fixture()
  const scope = { kind: 'systemd-control-group', killMode: 'control-group', invocationId: 'b'.repeat(32), unit: 'flybot.service', controlGroup: '/system.slice/flybot.service', bootId: 'same-boot' }
  const original = createProjectNativeSessions(f.rt, { captureScope: async () => scope })
  await original.bind(f.session, f.workspace, 'bot1')
  const restarted = createProjectNativeSessions(f.rt, { priorExit: async value => value === scope })
  const proof = await restarted.stop('bot1')
  assert.equal(proof.previousInvocationId, scope.invocationId)
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), true)
})


test('native drain includes idle subagent jobs and earlier context parts before proving exit', async () => {
  const f = fixture(); await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.activate(f.session, 'bot1')
  f.rt.selfOf = id => id === 'physical-1' ? 'bot1' : undefined
  const child = { session: { id: 'child-session', header: { id: 'child-session', origin: 'subagent', parentSession: 'physical-1' } } }
  assert.equal(f.service.admitStep(child), true)
  f.rt.state.bots.bot1.segments = [{ sessionId: 'earlier-part' }]
  const stopped = []
  f.rt.ctx.parallel = async (_event, body) => { stopped.push(body.sessionId) }
  f.rt.ctx.waterfall = async (_event, body) => body.sessionId === 'child-session' ? [{ kind: 'job', items: [{ id: 'idle-child-job' }] }] : []
  await assert.rejects(f.service.stop('bot1'), /registered session work/)
  assert.ok(stopped.includes('child-session')); assert.ok(stopped.includes('earlier-part'))
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), false)
  f.rt.ctx.waterfall = async () => []
  await f.service.stop('bot1')
  assert.equal(nativeExitConfirmed(f.rt.state, f.rt.state.projectNativeWorkers.bot1), true)
})

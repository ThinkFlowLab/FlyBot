import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

test('native cwd restoration preserves logical identity and archived conclusions in a new correctly bound physical Session', async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'flybot-native-cwd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  f.rt.home = root
  const text = 'Original task goal, convention and pending handoff'
  f.session.context = { text, sha256: createHash('sha256').update(text).digest('hex') }
  f.rt.state.tasks.t.id = 't'; f.rt.state.tasks.t.title = 'Continue the original Task'
  f.rt.state.projectAttempts = { a: { id: 'a', projectId: 'p', taskId: 't', roleSessions: { developer: f.session } } }
  f.agent.session.seq = 1
  await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.stop('bot1')
  delete f.rt.state.bots.bot1
  const path = join(root, 'new-cwd'); await mkdir(path)
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: path })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim()
  const session = { ...structuredClone(f.session), id: 'role-2', attemptId: 'a2', status: 'prepared' }
  const workspace = { id: 'workspace-2', projectId: 'p', attemptId: 'a2', role: 'developer', status: 'allocated', path, materialization: { expectedCheckout: sha, actualCheckout: sha } }
  f.rt.state.projectAttempts.a2 = { id: 'a2', projectId: 'p', taskId: 't', status: 'running', roleSessions: { developer: session }, workspaces: { developer: workspace } }
  f.rt.state.projectWorkspaces = { [workspace.id]: workspace }; f.rt.state.tasks.t.deliveryAttemptId = 'a2'
  f.rt.state.bots.bot2 = { id: 'bot2', sessionId: 'physical-2', workspaceId: workspace.id, attemptId: 'a2', instructions: 'Current role policy' }
  const carrier = { session: { id: 'physical-2', header: { cwd: path }, seq: 0 }, status: 'idle', cancel() {}, async whenIdle() {} }
  f.rt.resolveAgent = async id => id === 'physical-1' ? f.agent : carrier
  f.rt.ctx.agents.get = id => id === 'physical-1' ? f.agent : carrier
  f.rt.ctx.sessionController = { async page(body) {
    assert.equal(body.address.sessionId, 'physical-1'); assert.equal(body.throughSeq, 0)
    return { records: [{ event: { seq: 0, type: 'message', data: { role: 'assistant', text: 'Retained previous conclusion; tests need another pass' } } }], hasMore: false }
  } }
  f.rt.state.projectTaskInputs = { handled: { id: 'handled', projectId: 'p', taskId: 't', status: 'handled', sha256: 'a'.repeat(64) } }
  const result = await f.service.bind(session, workspace, 'bot2')
  assert.equal(result.sessionId, 'physical-2')
  const row = f.rt.state.projectNativeWorkers.bot2
  assert.equal(row.restoration.mode, 'reconstructed'); assert.equal(row.restoration.sourceSessionId, 'physical-1')
  assert.equal(row.continuedFrom, 'bot1'); assert.equal(row.cwd, path)
  assert.equal(f.rt.state.projectTaskSessions[row.logicalSessionId].bindings.length, 2)
  const archive = JSON.parse(await readFile(session.continuationArchive.target, 'utf8'))
  assert.match(JSON.stringify(archive.previousMessages), /Retained previous conclusion/)
  assert.equal(archive.facts.inputs[0].status, 'handled')
  assert.match(f.rt.state.bots.bot2.instructions, /not replay unknown writes|not replay unknown/)
  await f.service.activate(session, 'bot2')
  assert.deepEqual(f.unarchived(), [], 'A newly reconstructed carrier cannot be called a resumed old physical Session')
  await f.service.stop('bot2')
  assert.equal(nativeExitConfirmed(f.rt.state, row), true)
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

test('actual native pre-step refuses revoked role rights while retaining the original role context', async () => {
  const f = fixture(), revoked = []
  const role = { id: 'p:developer', ...structuredClone(f.session.definition), toolPolicy: { shell: true }, execution: { harness: 'flybot', resourceIds: [] } }
  const task = f.rt.state.tasks.t
  task.deliveryAttemptId = 'a'; task.collaboration = { initiatedBy: 'owner', generation: 1, claim: { id: 'claim', botId: role.id, role: 'developer', generation: 1, status: 'active' } }
  f.session.poolClaimId = 'claim'
  f.rt.requireProjectAccess = () => {}
  f.rt.projectAgents = { deliveryDefinitions: () => ({ revision: 1, roles: [role] }) }
  f.rt.projectPools = { async revokeExecution(...args) { revoked.push(args) } }
  f.rt.state.projectAttempts = { a: { roleSessions: { developer: f.session } } }
  f.rt.selfOf = id => id === f.agent.session.id ? 'bot1' : undefined
  Object.assign(f.session, pinTaskRoleDefinition(f.rt.state, f.session, role, 1, f.rt.projectAgents.deliveryDefinitions()))
  await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.activate(f.session, 'bot1')
  const check = agent => f.service.validateStep ? f.service.validateStep(agent) : f.service.admitStep(agent)
  assert.equal(await check(f.agent), true)
  role.toolPolicy.shell = false
  assert.equal(await check(f.agent), false)
  assert.equal(revoked.length, 1)
  assert.deepEqual(revoked[0].slice(0, 2), ['t', 'claim'])
  assert.match(revoked[0][2], /revoked/)
  assert.equal(f.session.definition.instructions, 'Original convention')
})

test('native ongoing authority follows the live carrier when a resumed physical Session also appears in history', async () => {
  const f = fixture()
  f.rt.selfOf = id => id === f.agent.session.id ? (f.rt.state.bots.bot2 ? 'bot2' : 'bot1') : undefined
  const role = { id: 'p:developer', ...structuredClone(f.session.definition), execution: { harness: 'flybot', resourceIds: [] } }
  f.rt.projectAgents = { deliveryDefinitions: () => ({ revision: 1, roles: [role] }) }
  Object.assign(f.session, pinTaskRoleDefinition(f.rt.state, f.session, role, 1, f.rt.projectAgents.deliveryDefinitions()))
  f.session.poolClaimId = 'old-claim'
  f.rt.state.tasks.t.deliveryAttemptId = 'a'; f.rt.state.tasks.t.collaboration = { initiatedBy: 'owner', generation: 1, claim: { id: 'old-claim', botId: role.id, role: 'developer', generation: 1, status: 'active' } }
  f.rt.requireProjectAccess = () => {}
  f.rt.state.projectAttempts = { a: { roleSessions: { developer: f.session } } }
  await f.service.bind(f.session, f.workspace, 'bot1'); await f.service.activate(f.session, 'bot1')
  assert.equal(await f.service.validateStep(f.agent), true)
  await f.service.stop('bot1'); delete f.rt.state.bots.bot1
  const session = { ...f.session, id: 'role-2', attemptId: 'a2', generation: 2, poolClaimId: 'new-claim', status: 'prepared' }
  const task = f.rt.state.tasks.t
  task.deliveryAttemptId = 'a2'; task.collaboration = { initiatedBy: 'owner', generation: 2, claim: { id: session.poolClaimId, botId: role.id, role: 'developer', generation: 2, status: 'active' } }
  f.rt.requireProjectAccess = () => {}
  f.rt.state.projectAttempts.a2 = { roleSessions: { developer: session } }
  f.rt.state.bots.bot2 = { id: 'bot2', workspaceId: 'w2', attemptId: 'a2' }
  await f.service.bind(session, { ...f.workspace, id: 'w2', attemptId: 'a2' }, 'bot2')
  await f.service.activate(session, 'bot2')
  assert.equal(f.rt.state.projectNativeWorkers.bot1.sessionId, f.rt.state.projectNativeWorkers.bot2.sessionId)
  assert.equal(await f.service.validateStep(f.agent), true)
})

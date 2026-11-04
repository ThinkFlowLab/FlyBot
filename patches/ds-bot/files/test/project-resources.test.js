import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import { createProjectNativeSessions } from '../src/host/project-native-sessions.js'
import { createProjectResources } from '../src/host/project-resources.js'

function fixture() {
  const project = { id: 'p1', ownerUserId: 'owner-1' }
  const rt = { state: { bots: {}, projectResourceHealth: { local: { status: 'ready' }, isolated: { status: 'ready' } } }, config: { projectResources: {
    local: { type: 'local', root: '/tmp/flybot-resource-local', capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['flybot'] },
    isolated: { type: 'docker', container: 'flybot-m7-unit', user: '1000:1000', root: '/workspace', capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'] },
    hidden: { type: 'local', root: '/private', capacity: 1, allowedProjectOwnerIds: ['someone-else'], harnesses: ['flybot'] },
  } }, save: async () => {}, readProject: () => project, projectScheduler: { wake() {} } }
  const resources = createProjectResources(rt)
  return { rt, project, resources }
}

test('resource leases reserve real capacity once and never release an unconfirmed worker', async () => {
  const { resources, rt } = fixture()
  const request = { projectId: 'p1', attemptId: 'a1', role: 'developer', sessionKey: 's1', harness: 'flybot', resourceIds: ['local'] }
  const first = await resources.reserve(request)
  assert.equal((await resources.reserve(request)).id, first.id)
  await assert.rejects(resources.reserve({ ...request, sessionKey: 's2' }), /capacity/)
  await resources.markStarted(first.id, first.generation, { kind: 'native', botId: 'worker' })
  rt.state.bots.worker = { id: 'worker' }
  await resources.release(first.id, first.generation)
  assert.equal(resources.occupied('local'), 1)
  delete rt.state.bots.worker
  await resources.release(first.id, first.generation)
  assert.equal(resources.occupied('local'), 1, 'Bot absence alone is not exit proof')
  await resources.release(first.id, first.generation, { exited: true })
  assert.equal(resources.occupied('local'), 1, 'Missing handles cannot manufacture native exit')
  rt.state.bots.worker = { id: 'worker', workspaceId: 'workspace', attemptId: 'a1' }
  rt.state.tasks = { task: { projectId: 'p1' } }
  rt.botOf = id => rt.state.bots[id]; rt.chatOf = id => id
  rt.resolveAgent = async () => ({ session: { id: 'worker' }, status: 'idle', cancel() {}, async whenIdle() {} })
  rt.ctx = { async parallel() {}, async waterfall(_event, _payload, next) { return next() } }
  const native = createProjectNativeSessions(rt)
  await native.bind({ id: 's1', projectId: 'p1', taskId: 'task', attemptId: 'a1', role: 'developer', status: 'prepared', definition: { role: 'developer' }, resourceLease: first }, { id: 'workspace', path: '/registered' }, 'worker')
  await native.stop('worker')
  delete rt.state.bots.worker
  await resources.release(first.id, first.generation)
  await resources.release(first.id, first.generation)
  assert.equal(resources.occupied('local'), 0)
  await assert.rejects(resources.markStarted(first.id, first.generation, { kind: 'native', botId: 'late' }), /released/)
})

test('resource pool rejects unauthorized, incompatible and revoked resources without exposing connections', async () => {
  const { resources, rt } = fixture()
  assert.deepEqual(resources.list('p1').map(row => row.id), ['local', 'isolated'])
  assert.equal(JSON.stringify(resources.list('p1')).includes('flybot-m7-unit'), false)
  await assert.rejects(resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['hidden'] }), /authorized/)
  await assert.rejects(resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['isolated'] }), /compatible/)
  rt.config.projectResources.local.allowedProjectOwnerIds = []
  await assert.rejects(resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] }), /authorized/)
})

test('restart retains unknown-process leases until explicit reconciliation confirms release', async () => {
  const { resources, rt } = fixture()
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] })
  await resources.markStarted(lease.id, lease.generation, { kind: 'sdk', handle: 'remote-process' })
  const restarted = createProjectResources(rt)
  await restarted.reconcile()
  assert.equal(restarted.occupied('local'), 1)
  assert.equal(rt.state.projectResourceLeases[lease.id].status, 'unreachable')
  await assert.rejects(restarted.release(lease.id, lease.generation + 1), /generation/)
})


test('concurrent reservations cannot oversubscribe and failed release does not wake a new worker', async () => {
  const { resources } = fixture()
  const base = { projectId: 'p1', attemptId: 'a', role: 'developer', harness: 'flybot', resourceIds: ['local'] }
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => resources.reserve({ ...base, sessionKey: `s${i}` })))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(resources.occupied('local'), 1)
})

test('missing environment/authentication evidence blocks a resource rather than implying readiness', async () => {
  const { resources, rt } = fixture()
  delete rt.state.projectResourceHealth.local
  await assert.rejects(resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] }), /readiness/)
  await assert.rejects(resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'codex', resourceIds: ['isolated'] }), /readiness/)
})

test('changing a registered physical target cannot silently migrate an admitted lease', async () => {
  const { rt, resources } = fixture()
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'bound-target', harness: 'flybot', resourceIds: ['local'] })
  assert.equal(resources.requireBinding('p1', lease).root, '/tmp/flybot-resource-local')
  rt.config.projectResources.local.root = '/tmp/another-host-directory'
  assert.throws(() => resources.requireBinding('p1', lease), /binding changed/)
  assert.equal(resources.occupied('local'), 1)
})


test('resource commands and worker processes use the same explicit Node executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-resource-node-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'configured node runtime')
  await writeFile(executable, '#!/bin/sh\nprintf "configured-runtime"\n', { mode: 0o700 })
  const { rt } = fixture()
  rt.config.projectResources.local.root = root
  rt.config.projectResources.local.nodePath = executable
  const resources = createProjectResources(rt)
  assert.equal((await resources.command('p1', 'local', { cwd: root, argv: ['node', '-v'] })).stdout, 'configured-runtime')
  const child = resources.startProcess('p1', 'local', { cwd: root, argv: ['node', '-v'] })
  let output = ''; child.stdout.on('data', part => { output += part }); child.stderr.resume(); child.stdin.end()
  await once(child, 'close')
  assert.equal(output, 'configured-runtime')
})

test('native Harness candidate pools exclude Docker even when its operator capability list is wrong', async () => {
  const { rt, resources } = fixture()
  rt.config.projectResources.isolated.harnesses.push('flybot')
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'tester', sessionKey: 'native-compatible', harness: 'flybot', resourceIds: ['isolated', 'local'] })
  assert.equal(lease.resourceId, 'local')
})

test('unconfigured SDK roles block admission before workspace or worker allocation', () => {
  const { resources } = fixture()
  assert.throws(() => resources.plan('p1', { roles: [{ role: 'developer', execution: { harness: 'codex', resourceIds: [] } }] }), /no authorized execution resource pool/)
})

test('reconciliation cannot resurrect a concurrently confirmed released SDK lease', async () => {
  const { rt, resources } = fixture()
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'release-race', harness: 'flybot', resourceIds: ['local'] })
  await resources.markStarted(lease.id, lease.generation, { kind: 'sdk', handle: 'confirmed-worker' })
  rt.state.projectResourceLeases[lease.id].processScope = { kind: 'unmanaged-process', hostPid: process.pid }
  await Promise.all([resources.release(lease.id, lease.generation, { handle: 'confirmed-worker', exited: true }), resources.reconcile()])
  assert.equal(rt.state.projectResourceLeases[lease.id].status, 'released')
  assert.equal(resources.occupied('local'), 0)
})

test('verified supervisor exit can free a legacy native resource without claiming its context is recoverable', async () => {
  const f = fixture(), resources = createProjectResources(f.rt, { priorExit: async () => true })
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] })
  await resources.markStarted(lease.id, lease.generation, { kind: 'native', botId: 'missing-legacy-bot' })
  const stored = f.rt.state.projectResourceLeases[lease.id]
  stored.processScope = { kind: 'systemd-control-group', killMode: 'control-group', invocationId: 'a'.repeat(32), hostPid: 12345 }
  await resources.reconcile()
  assert.equal(stored.status, 'released')
  assert.equal(stored.releaseProof.kind, 'systemd-prior-invocation-exited')
  assert.equal(f.rt.state.projectNativeWorkers, undefined, 'Capacity release does not manufacture a Session binding')
})

test('supervisor inspection cannot release a binding changed while the manager yields', async () => {
  const f = fixture()
  let inspect, inspected
  const started = new Promise(resolve => { inspected = resolve })
  const resources = createProjectResources(f.rt, { priorExit: () => { inspected(); return new Promise(resolve => { inspect = resolve }) } })
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] })
  await resources.markStarted(lease.id, lease.generation, { kind: 'native', botId: 'old-worker' })
  const stored = f.rt.state.projectResourceLeases[lease.id]
  stored.processScope = { kind: 'systemd-control-group', killMode: 'control-group', invocationId: 'a'.repeat(32) }
  const releasing = resources.release(lease.id, lease.generation, { proof: { kind: 'systemd-prior-invocation-exited', previousInvocationId: stored.processScope.invocationId } })
  await started
  stored.worker = { kind: 'native', botId: 'replacement' }
  inspect(true)
  await assert.rejects(releasing, /binding changed/)
  assert.equal(stored.status, 'running')
})

test('retired unbound reservations are reclaimed but live preparation and unknown spawn remain held', async () => {
  for (const kind of ['returned', 'superseded', 'cancelled', 'active', 'scope', 'worker']) {
    const { rt, resources } = fixture()
    const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'orphan', harness: 'flybot', resourceIds: ['local'] })
    rt.state.projectAttempts = { a: { id: 'a', projectId: 'p1', taskId: 't', status: kind === 'returned' || kind === 'cancelled' ? kind : 'running', ...(kind === 'superseded' ? { supersededBy: 'b' } : {}) } }
    rt.state.tasks = { t: { id: 't', projectId: 'p1', deliveryAttemptId: 'a' } }
    if (kind === 'scope') rt.state.projectResourceLeases[lease.id].processScope = { kind: 'unmanaged-process', hostPid: process.pid }
    if (kind === 'worker') rt.state.projectHarnessWorkers = { w: { id: 'w', leaseId: lease.id, generation: lease.generation, status: 'prepared' } }
    await resources.reconcile()
    assert.equal(resources.occupied('local'), ['returned', 'superseded', 'cancelled'].includes(kind) ? 0 : 1, kind)
    if (['returned', 'superseded', 'cancelled'].includes(kind)) await assert.rejects(resources.markStarted(lease.id, lease.generation, { kind: 'sdk', handle: 'late' }), /released/)
  }
})

test('claim replacement reclaims unbound preparation and failed reclamation save keeps capacity', async () => {
  const { rt, resources } = fixture()
  rt.state.projectAttempts = { a: { id: 'a', projectId: 'p1', taskId: 't', status: 'running' } }
  rt.state.tasks = { t: { id: 't', projectId: 'p1', deliveryAttemptId: 'a', collaboration: { generation: 2, claim: { id: 'claim', generation: 2, status: 'active' } } } }
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'owned', harness: 'flybot', resourceIds: ['local'], reservationOwner: { taskId: 't', claimId: 'claim', generation: 2 } })
  await resources.reconcile(); assert.equal(resources.occupied('local'), 1)
  rt.state.tasks.t.collaboration.claim.status = 'failed'
  const save = rt.save; rt.save = async () => { throw new Error('save failed') }
  await assert.rejects(resources.reconcile(), /save failed/)
  assert.equal(resources.occupied('local'), 1)
  rt.save = save; await resources.reconcile(); assert.equal(resources.occupied('local'), 0)
  assert.equal(rt.state.projectResourceLeases[lease.id].reclamation.owner.claimId, 'claim')
})

test('a registered or spawning SDK reservation is not inferred idle from a missing controller', async () => {
  const { rt, resources } = fixture()
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'phase', harness: 'flybot', resourceIds: ['local'] })
  rt.state.projectAttempts = { a: { id: 'a', projectId: 'p1', taskId: 't', status: 'returned' } }
  rt.state.projectHarnessWorkers = { sdk: { id: 'sdk', projectId: 'p1', attemptId: 'a', role: 'developer', resourceId: 'local', leaseId: lease.id, generation: lease.generation, status: 'prepared', spawnPhase: 'starting' } }
  const row = rt.state.projectResourceLeases[lease.id]; row.worker = { kind: 'sdk', handle: 'sdk' }; row.status = 'running'
  await resources.reconcile(); assert.equal(resources.occupied('local'), 1)
  rt.state.projectHarnessWorkers.sdk.spawnPhase = 'registered'
  await resources.reconcile(); assert.equal(resources.occupied('local'), 0)
  await assert.rejects(resources.fenceSpawn(lease.id, lease.generation, 'sdk'), /released|retired/)
})

test('asynchronous preparation remains owned until its actual completion, even after claim retirement', async () => {
  const { rt, resources } = fixture()
  rt.state.projectAttempts = { a: { id: 'a', projectId: 'p1', status: 'running' } }
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'preparing', harness: 'flybot', resourceIds: ['local'] })
  const token = await resources.beginPreparation(lease.id, lease.generation)
  rt.state.projectAttempts.a.status = 'returned'
  await resources.reconcile(); assert.equal(resources.occupied('local'), 1)
  assert.equal(await resources.abortReservation(lease.id, lease.generation, 'Attempt ended during preparation'), false)
  await resources.endPreparation(token)
  await resources.reconcile(); assert.equal(resources.occupied('local'), 0)
  await assert.rejects(resources.beginPreparation(lease.id, lease.generation), /released/)
})

test('a timed out remote preparation cannot manufacture settled execution or reclaim capacity', async () => {
  const { rt, resources } = fixture()
  rt.state.projectAttempts = { a: { id: 'a', projectId: 'p1', status: 'running' } }
  const lease = await resources.reserve({ projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'uncertain-preparation', harness: 'flybot', resourceIds: ['local'] })
  const token = await resources.beginPreparation(lease.id, lease.generation)
  await resources.preparationUncertain(lease)
  await assert.rejects(resources.endPreparation(token), /stale/)
  rt.state.projectAttempts.a.status = 'returned'
  assert.equal(await resources.abortReservation(lease.id, lease.generation, 'Timeout is not exit proof'), false)
  await resources.reconcile()
  assert.equal(resources.occupied('local'), 1)
  assert.equal(rt.state.projectResourceLeases[lease.id].preparation.exitUnknown, true)
  await assert.rejects(resources.preparationUncertain({ ...lease, generation: 2 }), /owner/)
})

test('failed reservation/batch admission cannot return a capability or consume capacity', async () => {
  const { rt, resources } = fixture()
  rt.config.projectResources.local.capacity = 2
  const request = { projectId: 'p1', attemptId: 'a', role: 'developer', sessionKey: 'save-failed', harness: 'flybot', resourceIds: ['local'] }
  let writes = 0
  rt.save = async () => { if (++writes === 1) throw new Error('reservation persistence failed') }
  await assert.rejects(resources.reserve(request), /persistence failed/)
  assert.equal(resources.occupied('local'), 0)
  const old = Object.values(rt.state.projectResourceLeases)[0]
  await assert.rejects(resources.markStarted(old.id, old.generation, { kind: 'sdk', handle: 'late' }), /released/)
  writes = 0; rt.save = async () => { if (++writes === 2) throw new Error('batch persistence failed') }
  await assert.rejects(resources.reserveRoles('p1', 'batch', { roles: ['developer', 'tester'].map(role => ({ role, execution: { harness: 'flybot', resourceIds: ['local'] } })) }), /batch persistence failed/)
  assert.equal(resources.occupied('local'), 0)
  const next = await resources.reserve({ ...request, sessionKey: 'legitimate-tester', role: 'tester' })
  assert.equal(next.status, 'reserved')
})

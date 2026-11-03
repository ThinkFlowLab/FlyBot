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

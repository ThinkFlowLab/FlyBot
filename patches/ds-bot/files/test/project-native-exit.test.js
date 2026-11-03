import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectResources } from '../src/host/project-resources.js'
async function fixture(botExists) {
  const rt = { state: { bots: botExists ? { worker: { id: 'worker' } } : {}, projectResourceHealth: { local: { status: 'ready' } } },
    config: { projectResources: { local: { type: 'local', root: '/tmp/native-exit-test', capacity: 1, allowedProjectOwnerIds: ['owner'], harnesses: ['flybot'] } } },
    readProject: () => ({ id: 'p', ownerUserId: 'owner' }), save: async () => {} }
  const service = createProjectResources(rt)
  const lease = await service.reserve({ projectId: 'p', attemptId: 'a', role: 'developer', sessionKey: 's', harness: 'flybot', resourceIds: ['local'] })
  await service.markStarted(lease.id, lease.generation, { kind: 'native', botId: 'worker' })
  return { rt, service, lease }
}
test('a missing native Bot keeps its resource held until actual quiescence proof', async () => {
  const f = await fixture(false)
  await f.service.release(f.lease.id, f.lease.generation)
  assert.equal(f.service.occupied('local'), 1)
  assert.equal(f.rt.state.projectResourceLeases[f.lease.id].status, 'stopping')
})
test('an undefined handle plus exited flag cannot manufacture native exit acknowledgement', async () => {
  const f = await fixture(true)
  await f.service.release(f.lease.id, f.lease.generation, { exited: true })
  assert.equal(f.service.occupied('local'), 1)
  assert.equal(f.rt.state.projectResourceLeases[f.lease.id].releaseProof, undefined)
})

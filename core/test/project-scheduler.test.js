import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectScheduler } from '../src/host/project-scheduler.js'
import { deliveryMetrics } from '../src/host/workbench-state.js'
import { repositorySettings } from '../src/host/project-repository-policy.js'

function fixture() {
  const project = { id: 'p1', repository: 'example/repo', ownerUserId: 'owner-1', status: 'active', quota: { maxConcurrent: 1 } }
  const state = { projects: { p1: project }, bots: {}, tasks: { one: { id: 'one', projectId: 'p1', requesterId: 'bob', status: 'open' }, two: { id: 'two', projectId: 'p1', requesterId: 'bob', status: 'open' } }, projectAttempts: {}, projectExecutions: {} }
  let member = true, count = 0
  const rt = { state, config: { projectRepositories: { 'example/repo': { path: '/provisioned/repo', testCommand: ['node', '--test'], allowedPaths: ['core'] } } },
    readOnly: () => undefined, sharedProjectMode: () => true, flybotIsRead: () => true, warn() {}, save: async () => {},
    listProjects: () => [project], readProject: () => project,
    projectCan: actor => actor.memberId === 'owner-1' || member && actor.memberId === 'bob',
    requireProjectAccess(actor) { if (!rt.projectCan(actor)) throw new Error('Access denied'); return project },
    projectDelivery: { endpoint: async (_endpoint, body, actor) => {
      const id = `attempt-${++count}`
      const attempt = { id, taskId: body.taskId, projectId: 'p1', initiatedBy: actor.memberId, status: 'running' }
      state.projectAttempts[id] = attempt
      state.projectExecutions[id] = { id, taskId: body.taskId, projectId: 'p1', attemptId: id, status: 'running' }
      return { attempt }
    } },
  }
  return { rt, project, state, scheduler: createProjectScheduler(rt, { preflight: async () => repositorySettings(rt, project) }), revoke: () => { member = false } }
}

test('Project quota really queues without allocating another Attempt and drains after release', async () => {
  const { scheduler, state } = fixture()
  const actor = { memberId: 'bob' }
  await scheduler.request({ taskId: 'one', requestId: 'one' }, actor)
  const queued = await scheduler.request({ taskId: 'two', requestId: 'two' }, actor)
  assert.equal(queued.queue.status, 'waiting')
  assert.equal(Object.keys(state.projectAttempts).length, 1)
  assert.equal((await scheduler.request({ taskId: 'two', requestId: 'two' }, actor)).already, true)
  assert.equal(scheduler.slots('p1'), 1)
  state.projectAttempts['attempt-1'].status = 'waiting-acceptance'
  state.projectExecutions['attempt-1'].status = 'done'
  await scheduler.drain()
  assert.equal(state.projectQueue[queued.queue.id].status, 'started')
  assert.equal(Object.keys(state.projectAttempts).length, 2)
  assert.equal(state.projectAttempts['attempt-2'].initiatedBy, 'bob')
})

test('revoked queue authority cancels immediately and orphan Workers keep their slot until released', async () => {
  const { scheduler, state, revoke } = fixture()
  await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
  const queued = await scheduler.request({ taskId: 'two', requestId: 'two' }, { memberId: 'bob' })
  state.projectAttempts['attempt-1'].status = 'failed'
  state.projectExecutions['attempt-1'].status = 'failed'
  state.bots.worker = { id: 'worker', projectId: 'p1', ephemeral: { plugin: 'workflow' }, attemptId: 'attempt-1' }
  await scheduler.drain()
  assert.equal(state.projectQueue[queued.queue.id].status, 'waiting')
  revoke()
  assert.equal(scheduler.revalidate('p1'), true)
  assert.equal(state.projectQueue[queued.queue.id].status, 'cancelled')
  delete state.bots.worker
  await scheduler.drain()
  assert.equal(Object.keys(state.projectAttempts).length, 1)
})

test('queue startup recovery is idempotent and Project repository grants follow the provisioned owner', async () => {
  const { scheduler, state, project, rt } = fixture()
  state.projectQueue = { q: { id: 'q', status: 'starting', projectId: 'p1', taskId: 'one', requestKey: 'key' } }
  assert.equal(scheduler.recover(), true)
  assert.equal(state.projectQueue.q.status, 'waiting')
  assert.equal(scheduler.recover(), false)
  assert.equal(repositorySettings(rt, project).path, '/provisioned/repo')
  assert.throws(() => repositorySettings(rt, { ...project, ownerUserId: 'bob' }), /not provisioned/)
  rt.config.projectRepositories['example/repo'].allowedProjectOwnerIds = ['bob']
  assert.equal(repositorySettings(rt, { ...project, ownerUserId: 'bob' }).path, '/provisioned/repo')
})

test('metrics state its rolling window and use actual acceptance samples for mean/median', () => {
  const now = 10 * 24 * 3600_000
  const state = { tasks: { a: { createdAt: now - 1000 }, b: { createdAt: now - 3000 }, c: { createdAt: now - 10_000 } }, projectAttempts: {
    a: { projectId: 'p1', taskId: 'a', status: 'accepted', acceptedAt: now }, b: { projectId: 'p1', taskId: 'b', status: 'accepted', acceptedAt: now },
    old: { projectId: 'p1', taskId: 'c', status: 'accepted', acceptedAt: 1 }, missing: { projectId: 'p2', taskId: 'none', status: 'accepted', acceptedAt: now },
  } }
  const metrics = deliveryMetrics(state, 'p1', now)
  assert.equal(metrics.window.kind, 'rolling-seven-days')
  assert.equal(metrics.acceptedTasks, 2)
  assert.equal(metrics.duration.samples, 2)
  assert.equal(metrics.duration.meanMs, 2000)
  assert.equal(metrics.duration.medianMs, 2000)
  assert.equal(deliveryMetrics(state, 'empty', now).duration.meanMs, null)
})

test('resource capacity uses the existing durable queue and SDK leases keep Project slots occupied', async () => {
  const { rt, state, scheduler } = fixture()
  let full = true
  rt.projectResources = { plan() { if (full) throw new Error('Resource capacity is full') } }
  const queued = await scheduler.request({ taskId: 'one', requestId: 'resource-limited' }, { memberId: 'bob' })
  assert.equal(queued.queue.status, 'waiting')
  assert.equal(Object.keys(state.projectAttempts).length, 0)
  await scheduler.drain()
  assert.equal(state.projectQueue[queued.queue.id].status, 'waiting')
  full = false
  await scheduler.drain()
  assert.equal(state.projectQueue[queued.queue.id].status, 'started')
  state.projectAttempts['attempt-1'].status = 'failed'
  state.projectExecutions['attempt-1'].status = 'failed'
  state.projectResourceLeases = { sdk: { projectId: 'p1', attemptId: 'attempt-1', status: 'unreachable' } }
  assert.equal(scheduler.slots('p1'), 1)
  state.projectResourceLeases.sdk.status = 'released'
  assert.equal(scheduler.slots('p1'), 0)
})

test('a waiting request with invalidated provisioning is blocked before allocation', async () => {
  const { scheduler, rt, state } = fixture()
  await scheduler.request({ taskId: 'one', requestId: 'first' }, { memberId: 'bob' })
  const queued = await scheduler.request({ taskId: 'two', requestId: 'next' }, { memberId: 'bob' })
  state.projectAttempts['attempt-1'].status = 'failed'; state.projectExecutions['attempt-1'].status = 'failed'
  delete rt.config.projectRepositories['example/repo'].allowedPaths
  await scheduler.drain()
  assert.equal(state.projectQueue[queued.queue.id].status, 'blocked')
  assert.match(state.projectQueue[queued.queue.id].reason, /allowedPaths/)
  assert.equal(Object.keys(state.projectAttempts).length, 1)
})

test('wake bursts share reconciliation and preserve one follow-up after an in-flight event', async () => {
  const { rt, scheduler } = fixture()
  let release, reconciles = 0, pools = 0
  const gate = new Promise(resolve => { release = resolve })
  rt.projectResources = { async reconcile() { ++reconciles; if (reconciles === 1) await gate } }
  rt.projectPools = { pump: async () => { ++pools } }
  const first = scheduler.wake()
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 40; ++i) scheduler.wake()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reconciles, 1, 'Resource reconciliation must never overlap')
  release()
  await first
  assert.equal(reconciles, 2, 'Events arriving during execution need one fresh pass')
  assert.equal(pools, 2)
  await scheduler.wake()
  assert.equal(reconciles, 3)
})

test('a failed wake releases its lock without allocating against unknown resources', async () => {
  const { rt, scheduler } = fixture()
  let broken = true, pools = 0, warnings = 0
  rt.warn = () => { ++warnings }
  rt.projectResources = { async reconcile() { if (broken) throw new Error('Resource unavailable') } }
  rt.projectPools = { pump: async () => { ++pools } }
  await scheduler.wake()
  assert.equal(warnings, 1)
  assert.equal(pools, 0)
  broken = false
  await scheduler.wake()
  assert.equal(pools, 1)
})

test('provisioning recovery retries the original queue and identity instead of creating another request', async () => {
  const { rt, scheduler, state } = fixture()
  await scheduler.request({ taskId: 'one', requestId: 'occupy' }, { memberId: 'bob' })
  const { queue } = await scheduler.request({ taskId: 'two', requestId: 'recover' }, { memberId: 'bob' })
  state.projectAttempts['attempt-1'].status = 'failed'; state.projectExecutions['attempt-1'].status = 'failed'
  delete rt.config.projectRepositories['example/repo'].allowedPaths
  await scheduler.drain()
  assert.equal(state.projectQueue[queue.id].status, 'blocked')
  await assert.rejects(scheduler.retry({ queueId: queue.id }, { memberId: 'owner-1' }), /allowedPaths/)
  assert.equal(state.projectQueue[queue.id].status, 'blocked')
  rt.config.projectRepositories['example/repo'].allowedPaths = ['core']
  await scheduler.retry({ queueId: queue.id }, { memberId: 'owner-1' })
  await scheduler.wake()
  const saved = state.projectQueue[queue.id]
  assert.equal(saved.status, 'started')
  assert.equal(saved.memberId, 'bob')
  assert.equal(saved.recoveries[0].by, 'owner-1')
  assert.match(saved.recoveries[0].previousReason, /allowedPaths/)
  assert.equal(state.projectAttempts[saved.attemptId].initiatedBy, 'bob')
  assert.equal(Object.keys(state.projectQueue).length, 1)
})

test('queue recovery rechecks original requester authority and refuses terminal or allocated work', async () => {
  const { rt, scheduler, state, revoke } = fixture()
  state.projectQueue = { q: { id: 'q', status: 'blocked', projectId: 'p1', taskId: 'one', memberId: 'bob', requestId: 'one', reason: 'Provisioning' } }
  revoke()
  await assert.rejects(scheduler.retry({ queueId: 'q' }, { memberId: 'owner-1' }), /requester/)
  assert.equal(state.projectQueue.q.status, 'blocked')
  await assert.rejects(scheduler.retry({ queueId: 'missing' }, { memberId: 'owner-1' }), /Unknown/)
  rt.projectCan = () => true
  state.tasks.one.status = 'accepted'
  await assert.rejects(scheduler.retry({ queueId: 'q' }, { memberId: 'owner-1' }), /ended/)
  state.tasks.one.status = 'open'
  state.projectAttempts.active = { id: 'active', taskId: 'one', status: 'running' }
  await assert.rejects(scheduler.retry({ queueId: 'q' }, { memberId: 'owner-1' }), /active Attempt/)
})

test('the existing scheduler checks in-flight execution authority before resource release and new dispatch', async () => {
  const { rt, scheduler } = fixture(), calls = []
  rt.projectDelivery.reconcileExecutions = async () => { calls.push('authority') }
  rt.projectResources = { async reconcile() { calls.push('resources') } }
  rt.projectPools = { async pump() { calls.push('dispatch') } }
  await scheduler.wake()
  assert.deepEqual(calls, ['authority', 'resources', 'dispatch'])
})


test('queue restart preserves the chosen custom role and fences catalog or requirements changes', async () => {
  const f = fixture(), roles = [{ id: 'p1:builder', role: 'builder', policyRole: 'developer' }]
  let revision = 9, dispatched
  f.rt.projectAgents = { deliveryDefinitions: () => ({ revision, roles }) }
  await f.scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
  const queued = await f.scheduler.request({ taskId: 'two', requestId: 'two', targetRole: 'builder' }, { memberId: 'bob' })
  assert.equal(queued.queue.initialTarget.role, 'builder')
  assert.equal(queued.queue.initialTarget.definitionRevision, 9)
  f.state.projectAttempts = {}; f.state.projectExecutions = {}
  const original = f.rt.projectDelivery.endpoint
  f.rt.projectDelivery.endpoint = async (...args) => { dispatched = args[1]; return original(...args) }
  const restarted = createProjectScheduler(f.rt, { preflight: async () => repositorySettings(f.rt, f.project) })
  await restarted.wake()
  assert.equal(dispatched.initialTarget.role, 'builder')
  assert.equal(dispatched.initialTarget.definitionRevision, 9)
  f.state.projectAttempts = {}; f.state.projectExecutions = {}
  const again = await restarted.request({ taskId: 'one', requestId: 'again', targetRole: 'builder' }, { memberId: 'bob' })
  const waiting = await restarted.request({ taskId: 'two', requestId: 'stale', targetRole: 'builder' }, { memberId: 'bob' })
  assert.ok(again.attempt)
  revision++
  f.state.projectAttempts = {}; f.state.projectExecutions = {}
  await restarted.wake()
  assert.equal(f.state.projectQueue[waiting.queue.id].status, 'blocked')
  assert.match(f.state.projectQueue[waiting.queue.id].reason, /catalog.*changed/)
})


test('capacity queue retains the selected repository across restart and refuses revoked associations', async () => {
  const f = fixture(), link = { id: 'second', projectId: 'p1', repository: 'example/second', defaultBranch: 'main', createdAt: 10 }
  f.state.projectRepositories = { second: link }; f.project.repositoriesVersion = 1
  f.rt.config.projectRepositories['example/second'] = f.rt.config.projectRepositories['example/repo']
  await f.scheduler.request({ taskId: 'one', requestId: 'one', repository: 'example/second' }, { memberId: 'bob' })
  const queued = await f.scheduler.request({ taskId: 'two', requestId: 'two', repository: 'example/second' }, { memberId: 'bob' })
  assert.equal(queued.queue.repositoryBinding.repository, 'example/second')
  f.state.projectAttempts = {}; f.state.projectExecutions = {}
  delete f.state.projectRepositories.second
  const restarted = createProjectScheduler(f.rt, { preflight: async () => {} })
  await restarted.wake()
  assert.equal(f.state.projectQueue[queued.queue.id].status, 'blocked')
  assert.match(f.state.projectQueue[queued.queue.id].reason, /not currently associated/)
  assert.equal(Object.keys(f.state.projectAttempts).length, 0)
})

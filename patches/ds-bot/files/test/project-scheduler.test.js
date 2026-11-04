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

test('confirmed input waits release both Run and Attempt slots; resumed work waits behind admitted work', async () => {
  const { rt, state, scheduler } = fixture()
  rt.projectScheduler = scheduler
  await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
  const task = state.tasks.one, attempt = state.projectAttempts['attempt-1']
  task.deliveryAttemptId = attempt.id
  task.collaboration = { status: 'blocked', generation: 4, initiatedBy: 'bob', attemptId: attempt.id, history: [] }
  task.chiefQuestion = { decisionId: 'chief-1', reason: 'Need project input' }
  await scheduler.captureWait(task)
  assert.equal(scheduler.slots('p1'), 0)
  assert.equal(attempt.status, 'running'); assert.equal(state.projectExecutions[attempt.id].status, 'running')
  await scheduler.request({ taskId: 'two', requestId: 'two' }, { memberId: 'bob' })
  assert.equal(scheduler.slots('p1'), 1)
  delete task.chiefQuestion; task.collaboration.status = 'queued'; task.collaboration.currentHandoffId = 'resume-one'; task.collaboration.botId = 'p1:developer'; ++task.collaboration.generation
  const definition = { id: 'p1:developer', role: 'developer' }
  assert.equal(await scheduler.admitPool(task, definition), false)
  assert.equal(Object.values(state.projectQueue).filter(row => row.kind === 'resume').length, 1)
  assert.equal(await scheduler.admitPool(task, definition), false)
  assert.equal(Object.values(state.projectQueue).length, 1)
  state.projectAttempts['attempt-2'].status = 'waiting-acceptance'; state.projectExecutions['attempt-2'].status = 'done'
  await scheduler.drain()
  assert.equal(await scheduler.admitPool(task, definition), true)
  assert.equal(scheduler.slots('p1'), 1)
  assert.equal(Object.keys(state.projectAttempts).length, 2)
  assert.equal(attempt.capacityWait.status, 'admitted')
})

test('input wait never releases an unknown SDK, native Bot or unreleased lease', async () => {
  for (const kind of ['sdk', 'bot', 'lease', 'unknown-claim']) {
    const { rt, state, scheduler } = fixture(); rt.projectScheduler = scheduler
    await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
    const task = state.tasks.one; task.deliveryAttemptId = 'attempt-1'; task.chiefQuestion = { decisionId: 'chief', reason: 'input' }; task.collaboration = { status: 'blocked', history: [] }
    if (kind === 'sdk') state.projectHarnessWorkers = { w: { id: 'w', attemptId: 'attempt-1', status: 'released', generation: 1 } }
    if (kind === 'bot') state.bots.w = { id: 'w', ephemeral: true, attemptId: 'attempt-1', projectId: 'p1' }
    if (kind === 'lease') state.projectResourceLeases = { l: { id: 'l', attemptId: 'attempt-1', projectId: 'p1', status: 'unreachable' } }
    if (kind === 'unknown-claim') task.collaboration.claim = { workerId: 'lost', role: 'developer', status: 'active' }
    await scheduler.captureWait(task)
    assert.equal(scheduler.slots('p1'), 1, kind)
    assert.equal(scheduler.capacity('p1').exitUnknown, 1, kind)
  }
})

test('simultaneous continuations and new requests share FIFO quota across restart and duplicate calls', async () => {
  const f = fixture(), { rt, state, project, scheduler } = f; rt.projectScheduler = scheduler
  project.quota.maxConcurrent = 2
  for (const id of ['one', 'two']) {
    await scheduler.request({ taskId: id, requestId: id }, { memberId: 'bob' })
    const task = state.tasks[id]; task.deliveryAttemptId = id === 'one' ? 'attempt-1' : 'attempt-2'
    task.chiefQuestion = { decisionId: `chief-${id}` }; task.collaboration = { status: 'blocked', generation: 1, history: [], initiatedBy: 'bob', botId: 'p1:developer', currentHandoffId: id }
    await scheduler.captureWait(task)
  }
  assert.equal(scheduler.capacity('p1').waitingInput, 2)
  project.quota.maxConcurrent = 1
  for (const task of Object.values(state.tasks)) { delete task.chiefQuestion; task.collaboration.status = 'queued' }
  const restarted = createProjectScheduler(rt, { preflight: async () => repositorySettings(rt, project) }); rt.projectScheduler = restarted
  const definition = { id: 'p1:developer', role: 'developer' }
  const result = await Promise.all([restarted.admitPool(state.tasks.one, definition), restarted.admitPool(state.tasks.two, definition), restarted.admitPool(state.tasks.one, definition)])
  await restarted.drain()
  assert.ok(result.every(value => typeof value === 'boolean')); assert.equal(restarted.slots('p1'), 1)
  assert.equal(await restarted.admitPool(state.tasks.one, definition), true)
  assert.equal(await restarted.admitPool(state.tasks.two, definition), false)
  assert.equal(Object.values(state.projectQueue).length, 2)
  assert.equal(restarted.capacity('p1').waitingResume, 1)
  state.tasks.three = { id: 'three', projectId: 'p1', status: 'open', requesterId: 'bob' }
  const { queue } = await restarted.request({ taskId: 'three', requestId: 'three' }, { memberId: 'bob' })
  state.projectAttempts['attempt-1'].status = 'accepted'; state.projectExecutions['attempt-1'].status = 'done'
  await restarted.drain()
  assert.equal(state.projectAttempts['attempt-2'].capacityWait.status, 'admitted')
  assert.equal(state.projectQueue[queue.id].status, 'waiting'); assert.equal(Object.keys(state.projectAttempts).length, 2)
})

test('uncommitted re-admission, revoked principals and changed handoffs never start execution', async () => {
  for (const kind of ['save', 'revoked', 'stale']) {
    const { rt, state, scheduler, revoke } = fixture(); rt.projectScheduler = scheduler
    await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
    const task = state.tasks.one, attempt = state.projectAttempts['attempt-1']; task.deliveryAttemptId = attempt.id
    task.chiefQuestion = { decisionId: 'chief' }; task.collaboration = { status: 'blocked', history: [], generation: 2, currentHandoffId: 'h', initiatedBy: 'bob', botId: 'p1:developer' }
    await scheduler.captureWait(task); delete task.chiefQuestion; task.collaboration.status = 'queued'
    // Hold a real project slot so queue creation and admission can be inspected separately.
    state.projectAttempts.busy = { id: 'busy', projectId: 'p1', taskId: 'two', status: 'running' }
    assert.equal(await scheduler.admitPool(task, { id: 'p1:developer', role: 'developer' }), false)
    state.projectAttempts.busy.status = 'accepted'
    if (kind === 'save') { let once = true; rt.save = async () => { if (once) { once = false; throw new Error('disk failure') } } }
    if (kind === 'revoked') revoke()
    if (kind === 'stale') ++task.collaboration.generation
    await scheduler.drain()
    const entry = Object.values(state.projectQueue)[0]
    assert.ok(['blocked', 'cancelled'].includes(entry.status), kind)
    assert.equal(attempt.capacityWait.status, 'suspended', kind)
    assert.equal(scheduler.slots('p1'), 0, kind)
    assert.equal(attempt.id, task.deliveryAttemptId)
  }
})

test('a matching SDK exit proof releases an input wait while legacy active workflows remain held', async () => {
  const { rt, state, scheduler } = fixture(); rt.projectScheduler = scheduler
  await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
  const task = state.tasks.one, attempt = state.projectAttempts['attempt-1']; task.deliveryAttemptId = attempt.id
  task.chiefQuestion = { decisionId: 'chief' }; task.collaboration = { status: 'blocked', history: [], claim: { workerId: 'w', role: 'developer', status: 'completed' } }
  state.projectResourceLeases = { l: { id: 'l', projectId: 'p1', attemptId: attempt.id, role: 'developer', resourceId: 'docker', generation: 2, status: 'released', worker: { kind: 'sdk', handle: 'w' } } }
  state.projectHarnessWorkers = { w: { id: 'w', projectId: 'p1', attemptId: attempt.id, role: 'developer', resourceId: 'docker', leaseId: 'l', generation: 2, status: 'released', releaseProof: { kind: 'sdk-stop-ack-and-process-exit', generation: 2 } } }
  await scheduler.captureWait(task); assert.equal(scheduler.slots('p1'), 0)
  state.projectResourceLeases.l.generation = 1; assert.equal(scheduler.slots('p1'), 1)
  state.projectResourceLeases.l.generation = 2; attempt.workflowDefinition = { nodes: [] }; assert.equal(scheduler.slots('p1'), 1)
  state.projectExecutions[attempt.id].status = 'done'; assert.equal(scheduler.slots('p1'), 0)
})


test('queue creation must commit before a concurrent drain can admit continuation', async () => {
  const { rt, state, scheduler } = fixture()
  await scheduler.request({ taskId: 'one', requestId: 'one' }, { memberId: 'bob' })
  const task = state.tasks.one; task.deliveryAttemptId = 'attempt-1'
  task.chiefQuestion = { decisionId: 'chief' }; task.collaboration = { status: 'blocked', generation: 1, history: [], initiatedBy: 'bob', currentHandoffId: 'h', botId: 'p1:developer' }
  await scheduler.captureWait(task); delete task.chiefQuestion; task.collaboration.status = 'queued'
  let rejectSave, count = 0
  rt.save = async () => { if (++count === 1) await new Promise((_, reject) => { rejectSave = reject }) }
  const queued = scheduler.admitPool(task, { id: 'p1:developer', role: 'developer' })
  const rejected = assert.rejects(queued, /initial save failed/)
  await new Promise(resolve => setImmediate(resolve)); await scheduler.drain()
  assert.equal(state.projectAttempts['attempt-1'].capacityWait.status, 'suspended')
  rejectSave(new Error('initial save failed')); await rejected
  assert.equal(Object.keys(state.projectQueue).length, 0)
  assert.equal(state.projectAttempts['attempt-1'].capacityWait.status, 'suspended')
})

import { harnessProfile } from '../src/host/project-harness-auth.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { roleExecutionPrompt } from '../src/host/project-role-policy.js'
import { githubCredentialBinding } from '../src/host/project-github-app.js'
import { createProjectDelivery } from '../src/host/project-delivery.js'
import { taskView } from '../src/host/project-development-service.js'
import { createTaskContract, admitTask, addTaskDependencies } from '../src/host/project-task-lifecycle.js'
import { childResultSources } from '../src/host/project-child-inputs.js'
import { fakeContext } from './fake-ctx.js'
import { apply as applyWorkflow } from '../../plugins/workflow/index.js'
import { createWorkflowService } from '../../plugins/workflow/src/service.js'

const alice = { memberId: 'owner-1' }
const bob = { memberId: 'bob' }
const git = (path, args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function setup(t, testCommand = [process.execPath, '--test', 'code.test.mjs'], { sdkContract = false, pool = false, modern = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-delivery-'))
  const home = join(directory, 'home')
  const repository = join(directory, 'repo')
  mkdirSync(home); mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.name', 'Fixture'])
  git(repository, ['config', 'user.email', 'fixture@localhost'])
  writeFileSync(join(repository, 'code.mjs'), 'export const add = (a,b) => a-b;\n')
  writeFileSync(join(repository, 'code.test.mjs'), "import assert from 'node:assert/strict'; import {add} from './code.mjs'; assert.equal(add(2,3),5); assert.equal(add(-7,2),-5); assert.equal(add(11,13),24);\n")
  git(repository, ['add', '.']); git(repository, ['commit', '-m', 'Fixture base'])
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, members: { 'owner-1': { id: 'owner-1' }, bob: { id: 'bob' } },
    bots: { a: { id: 'a', ownerId: 'owner-1', name: 'Chief', role: 'Chief', sessionId: 'a', projectId: 'p1' } }, mainBotIds: ['a'],
    projects: { p1: { id: 'p1', name: 'Code', status: 'active', ownerUserId: 'owner-1', repository: 'example/demo', defaultBranch: 'main', roles: { members: ['bob'], maintainers: [] }, createdAt: 1, updatedAt: 1 } }, tasks: modern ? {} : { 'legacy-code-task': { id: 'legacy-code-task', projectId: 'p1', ownerBotId: 'a', requesterId: 'bob', title: 'Fix addition', criteria: 'add(2,3) must equal 5', status: 'open', actors: [], createdAt: 1, updatedAt: 1 } }, rooms: {}, projectRuns: {} }))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
    sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { home, projectWorkbench: true, projectDispatch: pool ? 'pools' : 'workflow', projectWorkspaceRoot: join(directory, 'execution'), projectRepositories: { 'example/demo': { path: repository, model: 'fixture/model', testCommand, allowedPaths: ['code.mjs', 'code.test.mjs'] } } })
  await rt.load()
  const published = []
  const publisher = { publish: async attempt => {
    const pr = { number: attempt.publicationBinding?.number ?? published.length + 1, sha: attempt.candidateSha, url: 'https://example.invalid/pr/1', repository: 'example/demo' }
    published.push(pr); return pr
  }, read: async pr => ({ sha: pr.sha, state: 'open', baseRef: 'main', baseSha: git(repository, ['rev-parse', 'main']) }) }
  rt.projectDelivery = createProjectDelivery(rt, { publisher })
  let workflow
  if (sdkContract) { ctx.flybot = rt.flybot; workflow = applyWorkflow(ctx, { persist: false }).service }
  else {
    workflow = createWorkflowService({ persist: false, readProject: id => rt.readProject(id),
    projectContext: (taskId, projectId) => rt.flybot.projects.context(taskId, projectId),
    bindRun: (id, projectId, details) => rt.flybot.projects.bindRun(id, projectId, details) })
  for (const [name, fn] of [['state', () => workflow.state()], ['create', body => workflow.create(body)], ['graph', body => workflow.saveGraph(body)], ['assign', body => workflow.assign(body)]]) rt.flybot.api.handle(`workflow/${name}`, fn, { read: name === 'state' })
  ctx.effect(() => () => workflow.dispose(), 'test workflow')
  }
  t.after(async () => { await ctx.dispose(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }) })
  // Existing delivery regressions exercise persisted pre-contract Tasks, including legacy human acceptance.
  // New admission semantics are covered with modern:true and the Chief/pool contract suites.
  const task = modern ? await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Fix addition', criteria: 'add(2,3) must equal 5', impact: 'Repair Project arithmetic' }, bob) : rt.state.tasks['legacy-code-task']
  const start = requestId => rt.projectEndpoint('project-task-run', { taskId: task.id, requestId }, bob)
  const attempt = () => Object.values(rt.state.projectAttempts).at(-1)
  const gate = (role, outputs = {}) => rt.projectDelivery.gate({ taskId: task.id, workflowId: attempt().workflowId, runId: attempt().runId, nodeId: role, outputs })
  return { rt, home, task, start, attempt, gate, repository, published, publisher, workflow, directory }
}

// Direct preparation probes emulate the pool's current claim before using a resource.
function prepareRole(rt, task, claim, definition) {
  if (definition.execution?.resourceIds?.length && task.collaboration?.claim?.id !== claim.id) {
    const c = task.collaboration
    c.generation = claim.generation; c.attemptId = claim.attemptId; c.botId = definition.id; c.status = 'claimed'
    c.claim = { ...claim, taskId: task.id, projectId: task.projectId, botId: definition.id, role: definition.role, policyRole: definition.policyRole ?? definition.role, status: 'active', createdAt: Date.now() }
  }
  return rt.projectDelivery.preparePoolRole(task, claim, definition)
}

async function implement(fixture) {
  writeFileSync(join(fixture.attempt().workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await fixture.gate('developer')
}
async function complete(fixture) {
  await implement(fixture)
  await fixture.gate('tester')
  await fixture.gate('reviewer', { review: JSON.stringify({ commit: fixture.attempt().candidateSha, verdict: 'approve', summary: 'Addition and coverage match the acceptance criteria' }) })
  fixture.rt.bindProject({ kind: 'run', id: fixture.attempt().runId, projectId: 'p1', status: 'done', taskId: fixture.task.id, attemptId: fixture.attempt().id })
}

test('delivery allocates three isolated worktrees and binds duplicate starts to one Attempt', async t => {
  const fixture = await setup(t)
  const first = await fixture.start('request-1')
  assert.equal(first.attempt.status, 'running', first.attempt.failure?.message)
  assert.equal((await fixture.start('request-1')).already, true)
  const paths = Object.values(first.attempt.workspaces).map(row => row.path)
  assert.equal(new Set(paths).size, 3)
  await implement(fixture)
  assert.match(readFileSync(join(fixture.repository, 'code.mjs'), 'utf8'), /a-b/)
  assert.equal(fixture.attempt().evidence.implementation.sha, git(paths[0], ['rev-parse', 'HEAD']))
})

test('only matching tests, independent Review, current PR head and an authorized human can accept', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  await complete(fixture)
  const attempt = fixture.attempt()
  assert.equal(attempt.status, 'waiting-acceptance')
  assert.equal(attempt.evidence.tests.sha, attempt.evidence.review.sha)
  assert.equal(attempt.pr.sha, attempt.candidateSha)
  assert.equal(fixture.rt.state.tasks[fixture.task.id].status, 'result-ready')
  await assert.rejects(fixture.rt.taskEndpoint('task-accept-result', { id: fixture.task.id }, alice), /commit-specific/)
  await assert.rejects(fixture.rt.projectEndpoint('project-task-accept', { attemptId: attempt.id }, bob), /access denied/)
  await fixture.rt.projectEndpoint('project-task-accept', { attemptId: attempt.id }, alice)
  assert.equal(attempt.status, 'accepted')
  assert.equal(fixture.rt.state.tasks[fixture.task.id].status, 'accepted')
  await fixture.rt.projectEndpoint('project-attempt-cleanup', { attemptId: attempt.id }, alice)
  assert.ok(Object.values(attempt.workspaces).every(row => row.status === 'released'))
})

test('failing tests retain evidence, cannot publish or accept, and a retry creates a new Attempt', async t => {
  const fixture = await setup(t, [process.execPath, '-e', 'process.exit(9)'])
  await fixture.start('request-1')
  await implement(fixture)
  await assert.rejects(fixture.gate('tester'), /tests failed/)
  const failed = fixture.attempt()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.evidence.tests.passed, false)
  assert.equal(fixture.published.length, 0)
  fixture.rt.bindProject({ kind: 'run', id: failed.runId, projectId: 'p1', status: 'failed', taskId: fixture.task.id, attemptId: failed.id })
  await assert.rejects(fixture.rt.projectEndpoint('project-task-accept', { attemptId: failed.id }, alice), /not produced/)
  await fixture.start('request-2')
  assert.notEqual(fixture.attempt().id, failed.id)
  assert.equal(fixture.rt.state.projectAttempts[failed.id].evidence.tests.passed, false)
})

test('a changed candidate or PR head makes existing evidence stale', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  await complete(fixture)
  const attempt = fixture.attempt()
  fixture.publisher.read = async () => ({ sha: 'different-head', state: 'open' })
  await assert.rejects(fixture.rt.projectEndpoint('project-task-accept', { attemptId: attempt.id }, alice), /PR changed/)
  fixture.publisher.read = async pr => ({ sha: pr.sha, state: 'open' })
  writeFileSync(join(attempt.workspaces.developer.path, 'code.mjs'), 'export const add = () => 5;\n')
  await assert.rejects(fixture.rt.projectEndpoint('project-task-accept', { attemptId: attempt.id }, alice), /stale/)
  assert.notEqual(fixture.rt.state.tasks[fixture.task.id].status, 'accepted')
})

test('Review must name the exact tested commit; no output can replace a missing verdict', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  await implement(fixture)
  await fixture.gate('tester')
  await assert.rejects(fixture.gate('reviewer', { review: '{"verdict":"approve","commit":"wrong","summary":"looks good"}' }), /different commit/)
  assert.equal(fixture.attempt().status, 'failed')
  assert.equal(fixture.published.length, 0)
})


test('restart explicitly interrupts an unfinished Attempt and preserves its workspace/evidence history', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  await implement(fixture)
  const snapshot = JSON.parse(readFileSync(join(fixture.home, 'state.json'), 'utf8'))
  await fixture.rt.ctx.dispose()
  writeFileSync(join(fixture.home, 'state.json'), JSON.stringify(snapshot))
  const ctx = fakeContext()
  const restarted = createRuntime(ctx, fixture.rt.config)
  await restarted.load()
  const recovered = restarted.state.projectAttempts[fixture.attempt().id]
  assert.equal(recovered.status, 'interrupted')
  assert.equal(restarted.state.tasks[fixture.task.id].status, 'failed')
  assert.equal(recovered.evidence.implementation.sha, snapshot.projectAttempts[recovered.id].candidateSha)
  assert.equal(restarted.state.projectExecutions[recovered.runId].status, 'interrupted')
  assert.equal(restarted.projectDelivery.recover(), false)
  await ctx.dispose()
})

for (const allocation of ['no-worker', 'already-blocked', 'released-worker', 'retire-then-route', 'unknown-worker']) test('persisted host restart reaches Chief and respects ' + allocation + ' when resuming the draft', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.start('before-restart')
  const previous = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const claim = await f.rt.projectPools.claim(task.id, 'p1:developer')
  const definition = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, claim, definition)
  const workspace = previous.workspaces.developer, sessionId = previous.roleSessions.developer.logicalSessionId
  writeFileSync(join(workspace.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  if (['released-worker', 'retire-then-route', 'unknown-worker'].includes(allocation)) {
    const exited = allocation !== 'unknown-worker', proof = { kind: 'sdk-stop-ack-and-process-exit', workerId: 'prior-sdk', generation: 1, at: Date.now() }
    f.rt.state.projectHarnessWorkers ??= {}; f.rt.state.projectResourceLeases ??= {}
    task.collaboration.claim.workerId = 'prior-sdk'
    f.rt.state.projectHarnessWorkers['prior-sdk'] = { id: 'prior-sdk', projectId: 'p1', taskId: task.id, attemptId: previous.id, role: 'developer', sessionKey: previous.roleSessions.developer.id, resourceId: 'prior-resource', leaseId: 'prior-lease', generation: 1, status: exited ? 'released' : 'unreachable', ...(exited ? { releaseProof: proof } : {}) }
    f.rt.state.projectResourceLeases['prior-lease'] = { id: 'prior-lease', projectId: 'p1', attemptId: previous.id, role: 'developer', resourceId: 'prior-resource', generation: 1, status: exited ? 'released' : 'unreachable', worker: { kind: 'sdk', handle: 'prior-sdk' }, ...(exited ? { releaseProof: proof } : {}) }
  }
  f.rt.state.projectAgents ??= {}; f.rt.state.projectChiefPolicies ??= {}
  f.rt.state.projectAgents['public-p1'] = { id: 'public-p1', projectId: 'p1', visibility: 'public', botId: 'a', sessionId: 'a', carrierGeneration: 1 }
  f.rt.state.projectChiefPolicies.p1 = { projectId: 'p1', enabled: true, authorityMemberId: alice.memberId, revision: 1, inspection: { thresholds: { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }, prompt: 'Inspect interrupted work' } }
  if (allocation === 'already-blocked') { f.rt.projectDelivery.recover(); f.rt.projectPools.recover() }
  await f.rt.save(); await f.rt.ctx.dispose()

  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { ...f.rt.config })
  rt.projectDelivery = createProjectDelivery(rt, { publisher: f.publisher })
  let chief, dispatched
  rt.projectAgents.startChiefJob = async args => { chief = args; return 'fixture-chief' }
  rt.projectPools.connect({ validate: () => ({ ok: true }), ready: () => true, rework: args => rt.projectDelivery.reworkPool(args), validateRecovery: args => rt.projectDelivery.validateRecovery(args),
    execute: async ({ task, claim, definition }) => { await rt.projectDelivery.preparePoolRole(task, claim, definition); return 'fixture-resumed-dev' }, dispatch: async args => { dispatched = args }, release: async id => rt.projectDelivery.exitConfirmed(id) })
  try {
    await rt.load()
    const resumedTask = rt.state.tasks[task.id]
    assert.equal(resumedTask.collaboration.status, 'blocked'); assert.match(resumedTask.collaboration.block.reason, /Host restarted/)
    assert.equal(rt.state.projectAttempts[previous.id].status, 'interrupted')
    await rt.projectScheduler.wake()
    for (let pass = 0; pass < 200 && !chief; ++pass) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(chief, 'No manual inspect or schedule delivery is needed')
    assert.equal(chief.projectFacts.tasks[0].execution.claimId, claim.id)
    if (allocation === 'retire-then-route') {
      const retiring = chief
      await retiring.onResult({ ok: true, text: JSON.stringify({ summary: 'Reconcile the exact old responsibility first', decisions: [{ taskId: task.id, action: 'reconcile-exit', reason: 'Matching SDK stop and lease release prove exit' }] }), executionEvidence: { kind: 'native-chief', chiefRunId: retiring.runId, carrierGeneration: 1, botId: 'a', sessionId: 'a' } })
      await rt.projectScheduler.wake()
      for (let pass = 0; pass < 200 && chief.runId === retiring.runId; ++pass) await new Promise(resolve => setTimeout(resolve, 5))
      assert.notEqual(chief.runId, retiring.runId, JSON.stringify(rt.state.projectExecutions[retiring.runId]))
      assert.equal(rt.state.projectEffects[resumedTask.collaboration.claim.retirement.effect.id].kind, 'pool.retire')
      assert.equal(resumedTask.collaboration.status, 'blocked', 'Confirmed retirement still leaves the next role to Chief')
    }
    await chief.onResult({ ok: true, text: JSON.stringify({ summary: 'Assess the original allocation and resume the checkpoint', decisions: [{ taskId: task.id, action: 'route', targetBotId: 'p1:developer', reason: 'Continue the preserved draft when actual exit proof permits it' }] }), executionEvidence: { kind: 'native-chief', chiefRunId: chief.runId, carrierGeneration: 1, botId: 'a', sessionId: 'a' } })
    await rt.projectScheduler.wake()
    if (allocation === 'unknown-worker') {
      assert.equal(dispatched, undefined); assert.equal(resumedTask.collaboration.status, 'blocked')
      assert.match(resumedTask.collaboration.block.reason, /confirmed worker exit/)
      assert.equal(rt.state.projectResourceLeases['prior-lease'].status, 'unreachable')
      const count = Object.keys(rt.state.projectExecutions).length
      await rt.projectScheduler.wake(); await rt.projectScheduler.wake()
      assert.equal(Object.keys(rt.state.projectExecutions).length, count, 'Unknown exit must not create a Chief notification hot loop')
      assert.equal(readFileSync(join(workspace.path, 'code.mjs'), 'utf8'), 'export const add = (a,b) => a+b;\n')
      return
    }
    assert.ok(dispatched, JSON.stringify(rt.state.projectExecutions[chief.runId]))
    assert.equal(dispatched.task.id, task.id); assert.equal(dispatched.claim.attemptId, previous.id)
    assert.equal(resumedTask.collaboration.status, 'claimed'); assert.equal(resumedTask.collaboration.block, undefined)
    assert.equal(taskView(rt.state, resumedTask).reason, null)
    assert.ok(['running', 'starting'].includes(taskView(rt.state, resumedTask).phase))
    assert.equal(resumedTask.collaboration.history.at(-1).resolvedBlock.reason.startsWith('Host restarted'), true)
    const resumed = rt.state.projectAttempts[previous.id]
    assert.equal(resumed.status, 'running'); assert.equal(resumed.workspaces.developer.path, workspace.path)
    assert.equal(resumed.roleSessions.developer.logicalSessionId, sessionId)
    assert.equal(readFileSync(join(workspace.path, 'code.mjs'), 'utf8'), 'export const add = (a,b) => a+b;\n')
    assert.equal(Object.keys(rt.state.projectAttempts).length, 1)
    assert.equal(resumedTask.status === 'accepted', false)
  } finally { await ctx.dispose() }
})

test('a code Task cannot be accepted through generic transitions before it has delivery evidence', async t => {
  const fixture = await setup(t)
  await assert.rejects(fixture.rt.taskEndpoint('task-update', { id: fixture.task.id, column: 'done' }, alice), /commit-specific/)
  assert.equal(fixture.rt.state.tasks[fixture.task.id].status, 'open')
})

test('cleanup refuses paths outside its owned root and independent Task worktrees do not share edits', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  const first = fixture.attempt()
  const other = await fixture.rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Another request', criteria: 'Separate checkout remains unchanged', impact: 'Independent Project change' }, bob)
  const { admitTask } = await import('../src/host/project-task-lifecycle.js')
  admitTask(fixture.rt.state.tasks[other.id], { id: 'other-admission', projectId: 'p1', taskId: other.id, executorRole: 'chief', runId: 'chief-fixture', initiatedBy: alice.memberId, reason: 'Independent requirements checked' })
  await fixture.rt.projectEndpoint('project-task-run', { taskId: other.id, requestId: 'other-1' }, bob)
  const second = fixture.attempt()
  assert.notEqual(first.workspaces.developer.path, second.workspaces.developer.path)
  writeFileSync(join(first.workspaces.developer.path, 'code.mjs'), 'changed only in the first worktree')
  assert.match(readFileSync(join(second.workspaces.developer.path, 'code.mjs'), 'utf8'), /a-b/)
  second.status = 'failed'
  second.workspaces.developer.path = fixture.repository
  await assert.rejects(fixture.rt.projectEndpoint('project-attempt-cleanup', { attemptId: second.id }, alice), /owned delivery root/)
  assert.match(readFileSync(join(fixture.repository, 'code.mjs'), 'utf8'), /a-b/)
})

test('repository path policy blocks unexpected files before a candidate can be published', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  writeFileSync(join(fixture.attempt().workspaces.developer.path, 'unexpected.txt'), 'outside the task paths')
  await assert.rejects(fixture.gate('developer'), /provisioned repository paths/)
  assert.equal(fixture.attempt().status, 'failed')
  assert.equal(fixture.published.length, 0)
})


test('duplicate role results reuse sealed evidence without resetting another role worktree', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  await implement(fixture)
  const attempt = fixture.attempt()
  const testerFile = join(attempt.workspaces.tester.path, 'inspection.txt')
  writeFileSync(testerFile, 'tester work in progress')
  const replay = await fixture.gate('developer')
  assert.equal(replay.already, true)
  assert.equal(readFileSync(testerFile, 'utf8'), 'tester work in progress')
  await fixture.gate('tester')
  assert.equal((await fixture.gate('tester')).already, true)
})


test('managed delivery definitions and role/model snapshots cannot be edited or reset in place', async t => {
  const fixture = await setup(t)
  await fixture.start('request-1')
  const attempt = fixture.attempt()
  assert.equal(attempt.workflowDefinition.nodes[0].model, 'fixture/model')
  for (const operation of ['graph', 'set-model', 'concurrency', 'reset', 'delete']) await assert.rejects(fixture.rt.projectEndpoint('project-workflow', { projectId: 'p1', workflowId: attempt.workflowId, operation, nodes: [] }, alice), /immutable/)
  assert.equal(attempt.workflowVersion, 'project-delivery/v9')
})


test('only managers stop one delivery Run and failed Worker release retains its capacity', async t => {
  const fixture = await setup(t)
  await fixture.start('stop-one')
  const { rt } = fixture, attempt = fixture.attempt()
  let resets = 0
  rt.flybot.api.handle('workflow/reset', body => {
    assert.equal(body.runId, attempt.runId)
    assert.equal(body.workflowId, attempt.workflowId)
    resets++
    return { ok: true }
  })
  rt.state.bots.worker = { id: 'worker', projectId: 'p1', ephemeral: { plugin: 'workflow' }, attemptId: attempt.id }
  await assert.rejects(rt.projectEndpoint('project-attempt-stop', { attemptId: attempt.id }, bob), /denied/)
  const stopping = await rt.projectEndpoint('project-attempt-stop', { attemptId: attempt.id }, alice)
  assert.equal(stopping.stopping, true)
  assert.equal(rt.projectScheduler.slots('p1'), 1)
  await assert.rejects(fixture.gate('developer'), /stopped/)
  delete rt.state.bots.worker
  const stopped = await rt.projectEndpoint('project-attempt-stop', { attemptId: attempt.id }, alice)
  assert.equal(stopped.attempt.status, 'cancelled')
  assert.equal(resets, 2)
})


test('human return preserves old evidence and retry can only accept its own newly verified commit', async t => {
  const fixture = await setup(t)
  await fixture.start('before-return')
  await complete(fixture)
  const old = structuredClone(fixture.attempt())
  assert.match(old.evidence.implementation.diffStat, /code\.mjs/)
  for (const nodeId of ['developer', 'tester', 'reviewer']) fixture.workflow.advance({ workflowId: old.workflowId, runId: old.runId, nodeId, outcome: 'done' })
  await assert.rejects(fixture.rt.projectEndpoint('project-task-reject', { attemptId: old.id, reason: 'Add negative cases' }, bob), /denied/)
  await fixture.rt.projectEndpoint('project-task-reject', { attemptId: old.id, reason: 'Add negative cases' }, alice)
  assert.equal(fixture.rt.state.projectAttempts[old.id].status, 'failed')
  assert.equal(fixture.rt.state.projectAttempts[old.id].evidence.tests.sha, old.candidateSha)
  const retry = await fixture.start('after-return')
  assert.equal(retry.attempt.status, 'running', retry.attempt.failure?.message)
  assert.equal(retry.attempt.feedback.previousAttemptId, old.id)
  assert.equal(retry.attempt.feedback.reason, 'Add negative cases')
  assert.match(fixture.rt.projectDelivery.context(fixture.task.id).brief, /Add negative cases/)
  await complete(fixture)
  const next = fixture.attempt()
  assert.notEqual(next.id, old.id)
  assert.notEqual(next.workspaces.developer.path, old.workspaces.developer.path)
  await assert.rejects(fixture.rt.projectEndpoint('project-task-accept', { attemptId: old.id }, alice), /evidence/)
  await fixture.rt.projectEndpoint('project-task-accept', { attemptId: next.id }, alice)
  assert.equal(next.status, 'accepted')
  assert.equal(fixture.rt.state.tasks[fixture.task.id].status, 'accepted')
  assert.equal(fixture.rt.state.projectAttempts[old.id].status, 'failed')
})


test('temporary role context freezes memory, repository instructions and session ownership', async t => {
  const fixture = await setup(t)
  writeFileSync(join(fixture.repository, 'AGENTS.md'), 'Repository rule: verify negative inputs')
  git(fixture.repository, ['add', 'AGENTS.md']); git(fixture.repository, ['commit', '-m', 'Repository instructions'])
  const saved = await fixture.rt.projectEndpoint('project-role-memory-write', { projectId: 'p1', role: 'developer', text: 'Preserve input precision', source: { kind: 'human', reference: 'explicit published rule' } }, alice)
  await fixture.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', memoryRefs: [saved.memory.id] }, alice)
  await fixture.start('session-first')
  const first = fixture.attempt()
  const descriptor = first.roleSessions.developer
  assert.match(roleExecutionPrompt('Work', descriptor), /Repository rule: verify negative inputs/)
  assert.match(descriptor.context.text, /complete-policy-reference/)
  assert.match(descriptor.context.text, /Preserve input precision/)
  assert.match(descriptor.context.text, /add\(2,3\) must equal 5/)
  assert.equal(descriptor.attemptId, first.id)
  const worker = { id: 'worker-test', sessionId: 'worker-session' }
  await fixture.rt.projectDelivery.bindSession(first.workspaces.developer, worker)
  assert.equal(descriptor.sessionId, worker.sessionId)
  await assert.rejects(fixture.rt.projectDelivery.bindSession(first.workspaces.developer, { id: 'another', sessionId: 'another-session' }), /already bound/)
  await fixture.rt.projectDelivery.releaseSession(worker.id)
  assert.equal(descriptor.status, 'released')
  await assert.rejects(fixture.rt.projectDelivery.bindSession(first.workspaces.developer, worker), /released/)
  await fixture.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', instructions: 'New persona' }, alice)
  assert.doesNotMatch(descriptor.context.text, /New persona/)
  fixture.rt.bindProject({ kind: 'run', id: first.runId, projectId: 'p1', status: 'failed', taskId: fixture.task.id, attemptId: first.id })
  await fixture.start('session-second')
  assert.notEqual(fixture.attempt().roleSessions.developer.id, descriptor.id)
  assert.doesNotMatch(fixture.attempt().roleSessions.developer.context.text, /New persona/)
  assert.equal(fixture.attempt().roleSessions.developer.definitionRef, descriptor.definitionRef)
  assert.equal(fixture.attempt().roleSessions.developer.definitionChange.retainedOriginalDefinition, true)
  assert.match(fixture.attempt().roleSessions.developer.context.text, /previousAttemptId/)
})


test('host sealing collapses worker intermediate history before candidate handoff', async t => {
  const fixture = await setup(t)
  await fixture.start('collapse-worker-history')
  const attempt = fixture.attempt(), cwd = attempt.workspaces.developer.path
  writeFileSync(join(cwd, 'intermediate-only.txt'), 'Do not transfer transient worker content')
  git(cwd, ['add', '.']); git(cwd, ['-c', 'user.name=Worker', '-c', 'user.email=worker@localhost', 'commit', '-m', 'Transient worker checkpoint'])
  rmSync(join(cwd, 'intermediate-only.txt'))
  writeFileSync(join(cwd, 'code.mjs'), 'export const add=(a,b)=>a+b;\n')
  git(cwd, ['add', '-A']); git(cwd, ['-c', 'user.name=Worker', '-c', 'user.email=worker@localhost', 'commit', '-m', 'Final worker code'])
  await fixture.gate('developer')
  assert.equal(git(cwd, ['rev-list', '--count', `${attempt.baseSha}..${attempt.candidateSha}`]), '1')
  assert.equal(git(cwd, ['rev-parse', `${attempt.candidateSha}^`]), attempt.baseSha)
  assert.deepEqual(attempt.evidence.implementation.paths, ['code.mjs'])
})

test('SDK role completion requires matching sealed event evidence, and tampering blocks later gates', async t => {
  const fixture = await setup(t)
  await fixture.start('sdk-evidence')
  const attempt = fixture.attempt(), session = attempt.roleSessions.developer
  session.execution.harness = 'codex'; session.botId = 'sdk-worker'; session.backendSessionId = 'thread'; session.resourceLease = { generation: 1 }
  writeFileSync(join(attempt.workspaces.developer.path, 'code.mjs'), 'export const add=(a,b)=>a+b;\n')
  await assert.rejects(fixture.gate('developer'), /SDK execution evidence/)
  const log = join(fixture.home, 'sealed-sdk.jsonl'), text = '{"type":"completed","sessionId":"thread"}\n'
  writeFileSync(log, text)
  const row = { id: 'sdk-worker', projectId: 'p1', taskId: fixture.task.id, attemptId: attempt.id, role: 'developer', sessionKey: session.id, generation: 1, backendSessionId: 'thread', harness: 'codex', sdkVersion: '0.166.0', resourceId: 'local', sealedLog: log, eventSha256: createHash('sha256').update(text).digest('hex'), resultHash: 'result-hash' }
  await assert.rejects(fixture.rt.projectDelivery.recordExecution({ ...row, projectId: 'foreign' }), /does not belong/)
  await fixture.rt.projectDelivery.recordExecution(row)
  await fixture.gate('developer')
  writeFileSync(log, 'tampered events')
  await assert.rejects(fixture.gate('tester'), /SDK execution evidence/)
  assert.equal(fixture.published.length, 0)
})

test('workspace cleanup refuses orphan native workers and unknown SDK leases after a terminal Run', async t => {
  const fixture = await setup(t)
  await fixture.start('cleanup-worker-proof')
  const attempt = fixture.attempt()
  fixture.rt.bindProject({ kind: 'run', id: attempt.runId, projectId: 'p1', status: 'failed', taskId: fixture.task.id, attemptId: attempt.id })
  fixture.rt.state.bots.orphan = { id: 'orphan', ephemeral: { plugin: 'workflow' }, attemptId: attempt.id }
  await assert.rejects(fixture.rt.projectEndpoint('project-attempt-cleanup', { attemptId: attempt.id }, alice), /Native worker release/)
  delete fixture.rt.state.bots.orphan
  fixture.rt.state.projectResourceLeases = { unknown: { attemptId: attempt.id, status: 'unreachable' } }
  await assert.rejects(fixture.rt.projectEndpoint('project-attempt-cleanup', { attemptId: attempt.id }, alice), /resource release/)
  fixture.rt.state.projectResourceLeases.unknown.status = 'released'
  await fixture.rt.projectEndpoint('project-attempt-cleanup', { attemptId: attempt.id }, alice)
})


test('existing Workflow executes three SDK contract workers through seal/test/review/accept and releases every lease', async t => {
  const fixture = await setup(t, undefined, { sdkContract: true })
  const { rt, directory } = fixture, runtimeDir = join(directory, 'contract-runtime')
  writeFileSync(join(fixture.repository, 'AGENTS.md'), 'Complete policy.\n'.repeat(500) + '\nSDK_MODEL_POLICY_TAIL\n')
  git(fixture.repository, ['add', '.']); git(fixture.repository, ['commit', '-m', 'Complete runtime policy'])
  mkdirSync(join(runtimeDir, 'src/host'), { recursive: true })
  writeFileSync(join(runtimeDir, 'src/host/project-harness-worker.mjs'), `
import {createInterface} from 'node:readline';import{writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0','claude-agent':'0.3.316'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}
if(m.type!=='start')return;
if(!m.prompt.includes('project-role-context/v1') || !m.prompt.includes('project-role-policy/v1') || !m.prompt.includes('SDK_MODEL_POLICY_TAIL')){write({type:'failure',reason:'Missing model-visible role context'});return;}
let text;if(!m.settings.readOnly){writeFileSync('code.mjs','export const add=(a,b)=>a+b;\\n');text='OUTPUT implementation: fixed addition';}
else if(m.prompt.includes('Independently review the candidate diff')){const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();text='OUTPUT review: '+JSON.stringify({commit,verdict:'approve',summary:'Contract reviewer inspected the exact candidate'});}
else text='OUTPUT tests: inspected the committed tests';
write({type:'sdk-event',event:{type:'thread.started',thread_id:'contract-'+process.pid}});
write({type:'completed',sessionId:'contract-'+process.pid,text,usage:{input_tokens:1}});
});`)
  rt.config.projectResources = { execution: { type: 'local', root: directory, runtimeDir, capacity: 3, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex', 'claude-agent'],
    profiles: { 'owner-1': { codex: { home: join(directory, 'codex-home'), configDir: join(directory, 'codex-config'), model: 'contract-model' }, 'claude-agent': { home: join(directory, 'claude-home'), configDir: join(directory, 'claude-config'), model: 'contract-model' } } } } }
  rt.state.projectResourceHealth = { execution: { status: 'ready', at: Date.now() } }
  rt.state.projectHarnessHealth = { 'p1:execution:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['execution'], rt.readProject('p1'), 'execution', 'codex').profile }, 'p1:execution:claude-agent': { status: 'ready', profile: harnessProfile(rt.config.projectResources['execution'], rt.readProject('p1'), 'execution', 'claude-agent').profile } }
  for (const role of ['developer', 'tester', 'reviewer']) await rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role, execution: { harness: role === 'developer' ? 'codex' : 'claude-agent', resourceIds: ['execution'] } }, alice)
  const started = await fixture.start('full-sdk-contract')
  assert.equal(started.attempt.status, 'running', started.attempt.failure?.message)
  for (let n = 0; n < 400; n++) { if (['waiting-acceptance', 'failed'].includes(fixture.attempt().status) && Object.values(rt.state.projectHarnessWorkers ?? {}).every(row => row.status === 'released')) break; await new Promise(resolve => setTimeout(resolve, 15)) }
  const attempt = fixture.attempt()
  assert.equal(attempt.status, 'waiting-acceptance', attempt.failure?.message)
  assert.equal(rt.state.projectExecutions[attempt.runId].status, 'done')
  assert.equal(Object.keys(attempt.evidence.execution).length, 3)
  assert.equal(attempt.evidence.tests.passed, true)
  assert.equal(attempt.evidence.tests.sha, attempt.evidence.review.sha)
  assert.equal(rt.projectResources.occupied('execution'), 0)
  assert.ok(Object.values(rt.state.projectHarnessWorkers).every(row => row.status === 'released'))
  await rt.projectEndpoint('project-task-accept', { attemptId: attempt.id }, alice)
  assert.equal(attempt.status, 'accepted')
  await rt.projectEndpoint('project-attempt-cleanup', { attemptId: attempt.id }, alice)
})

test('repository preflight rejects a missing path allowlist before any execution allocation', async t => {
  const fixture = await setup(t)
  delete fixture.rt.config.projectRepositories['example/demo'].allowedPaths
  await assert.rejects(fixture.start('missing-allowlist'), /allowedPaths/)
  assert.equal(Object.keys(fixture.rt.state.projectAttempts ?? {}).length, 0)
  assert.equal(Object.keys(fixture.rt.state.projectWorkspaces ?? {}).length, 0)
  assert.equal(Object.keys(fixture.rt.state.projectResourceLeases ?? {}).length, 0)
  assert.equal(fixture.rt.state.tasks[fixture.task.id].status, 'open')
})

test('repository preflight rejects an unavailable test runtime before model execution', async t => {
  const fixture = await setup(t)
  fixture.rt.config.projectRepositories['example/demo'].testCommand = ['/missing/flybot-test-runtime']
  await assert.rejects(fixture.start('missing-runtime'), /testCommand/)
  assert.equal(Object.keys(fixture.rt.state.projectAttempts ?? {}).length, 0)
  assert.equal(Object.keys(fixture.rt.state.projectWorkspaces ?? {}).length, 0)
})

test('candidate seal distinguishes no change and refuses a changed symbolic link leaving its workspace', async t => {
  const fixture = await setup(t)
  await fixture.start('no-change')
  await assert.rejects(fixture.gate('developer'), /no code change/)
  const symlink = await setup(t)
  await symlink.start('symlink')
  const file = join(symlink.attempt().workspaces.developer.path, 'code.mjs')
  const fs = await import('node:fs')
  fs.rmSync(file); fs.symlinkSync(join(symlink.repository, 'outside'), file)
  fs.writeFileSync(join(symlink.repository, 'outside'), 'private outside file')
  await assert.rejects(symlink.gate('developer'), /symbolic link outside/)
  assert.equal(fixture.published.length, 0)
})

test('complete role policy reaches the execution prompt and remains pinned to its source commit', async t => {
  const fixture = await setup(t)
  const fs = await import('node:fs')
  fs.mkdirSync(join(fixture.repository, '.claude/skills/review-pr'), { recursive: true })
  writeFileSync(join(fixture.repository, 'AGENTS.md'), 'Policy preamble.\n'.repeat(500) + '\nREQUIRED_END_OF_FULL_POLICY\n')
  writeFileSync(join(fixture.repository, '.claude/skills/review-pr/SKILL.md'), 'FULL_REVIEW_PROTOCOL: use Ran and Not run at the exact tip.')
  git(fixture.repository, ['add', '.']); git(fixture.repository, ['commit', '-m', 'Policy sources'])
  await fixture.start('full-policy')
  const attempt = fixture.attempt()
  assert.ok(attempt.rolePolicies?.developer?.text.includes('REQUIRED_END_OF_FULL_POLICY'), 'Do not truncate governing rules at the old 6000-character preview limit')
  assert.ok(attempt.rolePolicies.reviewer.text.includes('FULL_REVIEW_PROTOCOL'))
  assert.equal(attempt.rolePolicies.developer.sources.find(row => row.name === 'AGENTS.md').sha256, createHash('sha256').update(readFileSync(join(fixture.repository, 'AGENTS.md'))).digest('hex'))
  assert.equal(attempt.rolePolicies.developer.commit, attempt.baseSha)
  assert.equal(attempt.roleSessions.developer.context.sources.policy.sha256, attempt.rolePolicies.developer.sha256)
  assert.ok(roleExecutionPrompt(attempt.workflowDefinition.nodes.find(node => node.id === 'developer').prompt, attempt.roleSessions.developer).includes('REQUIRED_END_OF_FULL_POLICY'), 'The runtime prompt, not only stored metadata, must carry the full policy')
  let nativeInput
  fixture.rt.createBot = async input => {
    nativeInput = input
    const bot = { id: 'native-policy-worker', sessionId: 'native-policy-session', ...input }
    fixture.rt.state.bots[bot.id] = bot
    return bot
  }
  await fixture.rt.flybot.scope('policy-test').bot.create({ name: 'Native policy worker', ephemeral: true, executionProjectId: 'p1', executionWorkDir: attempt.workspaces.developer.path, instructions: 'Cleaned short node prompt' })
  assert.match(nativeInput.systemPrompt, /REQUIRED_END_OF_FULL_POLICY/)
  assert.match(nativeInput.instructions, /project-role-policy\/v1/)
  await implement(fixture)
  attempt.rolePolicies.reviewer.text += 'changed rules'
  await assert.rejects(fixture.gate('tester'), /policy evidence/)
})

test('a required role convention source cannot silently disappear', async t => {
  const fixture = await setup(t)
  fixture.rt.config.projectRepositories['example/demo'].requiredRolePolicySources = { developer: ['MISSING_POLICY.md'] }
  const started = await fixture.start('required-policy')
  assert.equal(started.attempt.status, 'failed')
  assert.match(started.attempt.failure.message, /Required role policy source/)
  assert.equal(Object.keys(fixture.rt.state.projectHarnessWorkers ?? {}).length, 0)
})


test('default per-Bot pools execute a non-DAG SDK return/rework path with one resource and Chief completion inbox', async t => {
  const fixture = await setup(t, undefined, { sdkContract: true, pool: true })
  const { rt, directory } = fixture, runtimeDir = join(directory, 'pool-runtime')
  mkdirSync(join(runtimeDir, 'src/host'), { recursive: true })
  writeFileSync(join(runtimeDir, 'src/host/project-harness-worker.mjs'), `
import{createInterface}from'node:readline';import{writeFileSync,readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}if(m.type!=='start')return;
const code=readFileSync('code.mjs','utf8');let decision;
if(!m.settings.readOnly){
const rework=code.includes('stage-one');writeFileSync('code.mjs',rework?'export const add=(a,b)=>a+b;\\n':'export const add=(a,b)=>a+b; // stage-one\\n');
if(rework)writeFileSync('code.test.mjs',readFileSync('code.test.mjs','utf8')+'assert.equal(add(-4.5,0),-4.5);\\n');
decision={action:'handoff',to:'p1:reviewer',reason:rework?'Regression added; run tests':'Review before testing',outputs:{implementation:'Fixed addition'}};
}else if(m.prompt.includes('Independently review the candidate diff')){
if(code.includes('stage-one'))decision={action:'return',to:'p1:developer',reason:'Add fractional negative-zero regression before further verification'};
else if(!m.prompt.includes('\"passed\":true'))decision={action:'transfer',to:'p1:tester',reason:'Run tests before final review'};\nelse decision={action:'complete',reason:'Candidate matches criteria; request Chief judgement',outputs:{review:JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),verdict:'approve',summary:'Inspected exact candidate and regression'})}};
}else decision={action:'handoff',to:'p1:reviewer',reason:'Host tests should verify this candidate',outputs:{tests:'Inspected regression'}};
write({type:'sdk-event',event:{type:'thread.started',thread_id:m.settings.sessionId??('pool-'+process.pid)}});write({type:'completed',sessionId:m.settings.sessionId??('pool-'+process.pid),text:'OUTPUT handoff: '+JSON.stringify(decision),usage:{input_tokens:1}});
});`)
  rt.config.projectResources = { one: { type: 'local', root: directory, runtimeDir, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(directory, 'sdk-home'), configDir: join(directory, 'sdk-config'), model: 'contract-model' } } } } }
  rt.state.projectResourceHealth = { one: { status: 'ready', at: Date.now() } }
  rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['one'], rt.readProject('p1'), 'one', 'codex').profile } }
  for (const role of ['developer', 'tester', 'reviewer']) await rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role, execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  const started = await fixture.start('dynamic-pool')
  assert.ok(started.attempt, `One free resource must admit only the receiving role, instead of reserving the full DAG: ${JSON.stringify(started.queue)}`)
  assert.equal(started.attempt.status, 'running', started.attempt.failure?.message)
  assert.equal(started.attempt.workflowId, undefined)
  assert.equal(Object.keys(started.attempt.workspaces).length, 0)
  assert.equal(rt.projectResources.occupied('one'), 0)
  for (let n = 0; n < 400; n++) {
    await rt.projectPools.pump()
    if (['arbitration', 'blocked'].includes(rt.state.tasks[fixture.task.id].collaboration.status)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(rt.state.tasks[fixture.task.id].collaboration.status, 'arbitration', JSON.stringify(rt.state.tasks[fixture.task.id].collaboration.block))
  assert.deepEqual(rt.state.tasks[fixture.task.id].collaboration.history.map(row => row.to), ['p1:developer', 'p1:reviewer', 'p1:developer', 'p1:reviewer', 'p1:tester', 'p1:reviewer', 'p1:chief'])
  assert.equal(Object.values(rt.state.projectAttempts).length, 2)
  assert.equal(Object.values(rt.state.tasks).filter(row => row.projectId === 'p1').length, 1)
  assert.equal(rt.projectResources.occupied('one'), 0)
  assert.equal(Object.values(rt.state.projectAttempts)[0].status, 'returned')
  assert.equal(fixture.attempt().evidence.tests.passed, true)
  const reviewLogs = Object.values(rt.state.projectHarnessWorkers).filter(row => row.role === 'reviewer').map(row => row.sealedLog)
  assert.equal(new Set(reviewLogs).size, 3, 'Revisited role Sessions must retain distinct immutable SDK logs')
  assert.equal(fixture.attempt().roleSessionHistory.length, 1)
  const devSessions = Object.values(rt.state.projectAttempts).map(a => a.roleSessions.developer)
  assert.ok(devSessions.every(row => row.logicalSessionId && row.logicalSessionId === devSessions[0].logicalSessionId), 'A Task role retains its logical Session through rework')
  const devWorkspaces = Object.values(rt.state.projectAttempts).map(a => a.workspaces.developer.path)
  assert.equal(new Set(devWorkspaces).size, 1, 'Task-role SDK rework retains its bound cwd')
  const developerWorkers = Object.values(rt.state.projectHarnessWorkers).filter(row => row.role === 'developer')
  assert.equal(developerWorkers.length, 2)
  assert.equal(developerWorkers[1].continuedFrom, developerWorkers[0].id)
  assert.equal(developerWorkers[1].backendSessionId, developerWorkers[0].backendSessionId)
  assert.equal(developerWorkers[1].cwd, developerWorkers[0].cwd)
  const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
  assert.ok(saved.projectTaskSessions[developerWorkers[1].logicalSessionId].bindings.length >= 2, 'Thread bindings survive the ordinary store snapshot')

  assert.equal(fixture.attempt().status, 'waiting-acceptance', JSON.stringify(rt.state.tasks[fixture.task.id].collaboration.history.at(-1)))
  assert.equal(fixture.workflow.state().workflows.filter(row => row.projectId === 'p1').length, 0)
  await assert.rejects(rt.projectEndpoint('project-task-accept', { attemptId: fixture.attempt().id }, alice), /Chief arbitration/)
})

test('a Chief SDK contract process returns incomplete coverage then closes the same Task after a fresh Attempt', async t => {
  const fixture = await setup(t, undefined, { sdkContract: true, pool: true })
  const { rt, directory } = fixture, runtimeDir = join(directory, 'chief-contract-runtime')
  mkdirSync(join(runtimeDir, 'src/host'), { recursive: true })
  writeFileSync(join(runtimeDir, 'src/host/project-harness-worker.mjs'), `
import{createInterface}from'node:readline';import{writeFileSync,readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');write({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){write({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}if(m.type!=='start')return;
let text;if(m.settings.noTools){const context=JSON.parse(m.prompt.split('<untrusted-role-context>\\n')[1].split('\\n</untrusted-role-context>')[0]);const missing=!context.projectFacts.tasks[0].evidence.implementation.paths.includes('code.test.mjs');text=JSON.stringify({summary:'Chief checked exact candidate and requested fractional regression before closure',decisions:[{taskId:${JSON.stringify(fixture.task.id)},action:missing?'return':'close',targetBotId:'p1:developer',reason:missing?'Add the explicit fractional regression required by acceptance criteria':'Requested code fix and draft delivery evidence are complete',criteria:[{criterion:context.projectFacts.tasks[0].criteria,passed:true,evidence:'Matching host test SHA, sealed SDK review and open candidate PR'}]}]});}
else if(!m.settings.readOnly){if(readFileSync('code.mjs','utf8').includes('a+b'))writeFileSync('code.test.mjs',readFileSync('code.test.mjs','utf8')+'assert.equal(add(-4.5,1.5),-3);\\n');writeFileSync('code.mjs','export const add=(a,b)=>a+b;\\n');text='OUTPUT handoff: '+JSON.stringify({action:'handoff',to:'p1:tester',reason:'Implementation ready for tests',outputs:{implementation:'Fixed addition'}});}
else if(m.prompt.includes('Independently review the candidate diff')){text='OUTPUT handoff: '+JSON.stringify({action:'complete',reason:'Request Chief final judgement',outputs:{review:JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),verdict:'approve',summary:'Reviewed exact candidate'})}});}
else text='OUTPUT handoff: '+JSON.stringify({action:'handoff',to:'p1:reviewer',reason:'Configured tests will verify candidate',outputs:{tests:'Inspect actual host result'}});
write({type:'sdk-event',event:{type:'thread.started',thread_id:m.settings.sessionId??('chief-contract-'+process.pid)}});write({type:'completed',sessionId:m.settings.sessionId??('chief-contract-'+process.pid),text,usage:{input_tokens:1}});
});`)
  rt.config.projectResources = { one: { type: 'local', root: directory, runtimeDir, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(directory, 'chief-sdk-home'), configDir: join(directory, 'chief-sdk-config'), model: 'contract-model' } } } } }
  rt.state.projectResourceHealth = { one: { status: 'ready', at: Date.now() } }; rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources['one'], rt.readProject('p1'), 'one', 'codex').profile } }
  for (const role of ['chief', 'developer', 'tester', 'reviewer']) await rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role, execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  rt.state.projectAgents ??= {}
  rt.state.projectAgents['public-p1'] = { id: 'public-p1', projectId: 'p1', visibility: 'public', memberId: null, botId: 'a', sessionId: 'a', carrierGeneration: 1 }
  rt.state.bots.a.projectAgent = { id: 'public-p1', visibility: 'public', memberId: null }; rt.readProject('p1').chief = { botId: 'a', sessionId: 'a' }
  await rt.projectEndpoint('project-chief-configure', { projectId: 'p1', enabled: true, inspection: { enabled: false } }, alice)
  rt.state.tasks[fixture.task.id].criteria += '; include an explicit fractional regression test'
  await fixture.start('chief-final-accept')
  for (let n = 0; n < 500; n++) {
    await rt.projectPools.pump(); await rt.projectChiefControl.pump()
    const task = rt.state.tasks[fixture.task.id]
    if (task.status === 'accepted' && rt.projectResources.occupied('one') === 0 || task.collaboration.status === 'blocked') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const task = rt.state.tasks[fixture.task.id], chiefRuns = Object.values(rt.state.projectExecutions).filter(run => run.kind === 'chief-control')
  assert.equal(task.status, 'accepted', JSON.stringify({ block: task.collaboration.block, chiefRuns }))
  assert.equal(fixture.attempt().status, 'accepted')
  assert.equal(task.collaboration.status, 'closed')
  assert.equal(task.collaboration.history.at(-1).status, 'completed')
  assert.ok(fixture.attempt().acceptedViaChief)
  assert.equal(rt.projectResources.occupied('one'), 0)
  assert.equal(chiefRuns.length, 2)
  assert.equal(Object.values(rt.state.projectAttempts).length, 2)
  assert.ok(chiefRuns.every(run => run.status === 'done'))
  assert.equal(chiefRuns[0].executionEvidence.kind, 'sdk-chief')
  assert.equal(chiefRuns[0].executionEvidence.chiefRunId, chiefRuns[0].id)
  assert.ok(rt.state.bots.a, 'Logical Chief remains resident after its SDK turn ends')
  assert.equal(rt.readProject('p1').kind, undefined, 'Run metadata must not be written onto the Project returned by bindProject')
  assert.equal(Object.values(rt.state.tasks).length, 1)
})

test('Chief recovery before any sealed candidate pins a fresh Attempt to the current repaired repository base', async t => {
  const f = await setup(t, undefined, { pool: true })
  await f.start('before-backend-repair')
  const previous = f.attempt(), base = previous.baseSha
  writeFileSync(join(f.repository, 'host-repair.txt'), 'Verified repair to the execution backend\n')
  git(f.repository, ['add', 'host-repair.txt']); git(f.repository, ['commit', '-m', 'Repair host before retry'])
  const current = git(f.repository, ['rev-parse', 'HEAD'])
  previous.status = 'interrupted'
  const id = await f.rt.projectDelivery.reworkPool({ task: f.rt.state.tasks[f.task.id], claim: { id: 'chief-recovery', attemptId: previous.id, botId: 'p1:chief' }, reason: 'Confirmed prior exit; retry on repaired host', force: true })
  assert.equal(f.rt.state.projectAttempts[id].baseSha, current)
  assert.equal(previous.baseSha, base)
  assert.equal(f.rt.state.projectAttempts[id].taskId, f.task.id)
  assert.equal(previous.status, 'interrupted')
})

test('Chief route resumes interrupted unsealed code only with confirmed worker release and retains failure history', async t => {
  const f = await setup(t, undefined, { pool: true }); await f.start('resume-unsealed')
  const previous = f.attempt(), path = join(f.directory, 'unsealed-worktree')
  git(f.repository, ['worktree', 'add', '--detach', path, previous.baseSha])
  writeFileSync(join(path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  previous.workspaces.developer = { id: 'resume-w', kind: 'worktree', status: 'allocated', repository: f.repository, path }
  previous.status = 'interrupted'; previous.failure = { message: 'Restart while awaiting host preparation' }
  const oldRunId = previous.runId; f.rt.state.projectExecutions[oldRunId].status = 'failed'
  f.rt.state.projectHarnessWorkers = { stopped: { id: 'stopped', attemptId: previous.id, status: 'released' } }
  f.rt.state.projectResourceLeases = { lease: { id: 'lease', attemptId: previous.id, status: 'released' } }
  const id = await f.rt.projectDelivery.reworkPool({ task: f.rt.state.tasks[f.task.id], claim: { id: 'resume-claim', attemptId: previous.id, botId: 'p1:chief' }, reason: 'Git index capability repaired', force: false, decisionId: 'chief-resume' })
  assert.equal(id, previous.id); assert.equal(previous.status, 'running')
  assert.equal(readFileSync(join(path, 'code.mjs'), 'utf8'), 'export const add = (a,b) => a+b;\n')
  assert.equal(previous.resumptions[0].failure.message, 'Restart while awaiting host preparation')
  assert.equal(previous.resumptions[0].decisionId, 'chief-resume')
  assert.notEqual(previous.runId, oldRunId); assert.equal(f.rt.state.projectExecutions[oldRunId].status, 'failed')
  assert.equal(previous.failure, undefined)
  previous.status = 'interrupted'; f.rt.state.projectResourceLeases.lease.status = 'unreachable'
  f.rt.state.projectResourceLeases.lease.worker = { kind: 'sdk', handle: 'unknown-worker' }
  f.rt.state.projectHarnessWorkers.stopped.status = 'unreachable'
  const next = await f.rt.projectDelivery.reworkPool({ task: f.rt.state.tasks[f.task.id], claim: { id: 'unknown-exit', attemptId: previous.id, botId: 'p1:chief' }, reason: 'Unknown worker requires isolation', force: false })
  assert.notEqual(next, previous.id, 'Unknown capacity never permits reuse of the old working directory')
  assert.equal(f.rt.state.projectResourceLeases.lease.status, 'unreachable')
})

test('a transferred unsealed implementation is a labelled draft reference, not a missing or accepted candidate', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.start('draft-reference')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const defs = f.rt.projectAgents.deliveryDefinitions('p1').roles
  const dev = defs.find(row => row.role === 'developer'), tester = defs.find(row => row.role === 'tester')
  await prepareRole(f.rt, task, { id: 'draft-dev', attemptId: attempt.id, generation: 1 }, dev)
  const path = attempt.workspaces.developer.path
  writeFileSync(join(path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await prepareRole(f.rt, task, { id: 'draft-test', attemptId: attempt.id, generation: 2 }, tester)
  const facts = JSON.parse(attempt.roleSessions.tester.context.text.split('<untrusted-role-context>\n')[1].split('\n</untrusted-role-context>')[0]).projectFacts
  assert.equal(facts.candidateSha, null)
  assert.equal(facts.workingDraft.kind, 'unverified-workspace-reference')
  assert.equal(facts.workingDraft.path, path)
  assert.equal(attempt.evidence.implementation, undefined)
  assert.notEqual(readFileSync(join(attempt.workspaces.tester.path, 'code.mjs'), 'utf8'), readFileSync(join(path, 'code.mjs'), 'utf8'))
})

test('restart preserves a tested pool checkpoint waiting for Chief only when every execution is released', async t => {
  for (const variant of ['quiescent', 'unknown-lease', 'unknown-worker', 'active-claim']) {
    const f = await setup(t, undefined, { pool: true }); f.rt.projectPools.connect({ validate: () => ({ ok: true }) }); await f.start('checkpoint-' + variant)
    const a = f.attempt(), task = f.rt.state.tasks[f.task.id]
    const roles = f.rt.projectAgents.deliveryDefinitions('p1').roles
    await prepareRole(f.rt, task, { id: 'dev', attemptId: a.id, generation: 1 }, roles.find(r => r.role === 'developer'))
    writeFileSync(join(a.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
    await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: a.id }, role: 'developer', outputs: {} })
    await prepareRole(f.rt, task, { id: 'test', attemptId: a.id, generation: 2 }, roles.find(r => r.role === 'tester'))
    await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: a.id }, role: 'tester', outputs: {} })
    task.collaboration.status = 'blocked'
    task.collaboration.claim = { botId: 'p1:chief', status: variant === 'active-claim' ? 'active' : 'waiting-human', workerId: 'chief-worker', chiefRunId: 'chief-run' }
    f.rt.state.projectExecutions['chief-run'] = { status: 'done' }
    f.rt.state.projectHarnessWorkers = { 'chief-worker': { status: 'released', leaseId: 'chief-lease' }, dev: { attemptId: a.id, status: variant === 'unknown-worker' ? 'unreachable' : 'released' } }
    f.rt.state.projectResourceLeases = { 'chief-lease': { status: 'released' }, lease: { attemptId: a.id, status: variant === 'unknown-lease' ? 'unreachable' : 'released' } }
    const sha = a.candidateSha, tests = structuredClone(a.evidence.tests)
    const delivery = createProjectDelivery(f.rt)
    assert.equal(delivery.recover(), true)
    assert.equal(delivery.recover(), false)
    if (variant === 'quiescent') {
      assert.equal(a.status, 'running')
      assert.equal(a.restartCheckpoints[0].kind, 'quiescent-chief-wait')
      assert.equal(a.candidateSha, sha)
      assert.deepEqual(a.evidence.tests, tests)
      assert.equal(task.collaboration.claim.status, 'waiting-human')
    } else assert.equal(a.status, 'interrupted')
  }
})

test('published pool rework retains its PR binding and seals a descendant of the retained candidate', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.start('published-rework')
  const task = f.rt.state.tasks[f.task.id], first = f.attempt()
  const developer = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'first-dev', attemptId: first.id, generation: 1 }, developer)
  writeFileSync(join(first.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: first.id }, role: 'developer', outputs: {} })
  const original = first.candidateSha
  first.pr = { number: 48, repository: 'example/demo', sha: original, url: 'https://example.invalid/pr/48' }
  first.status = 'waiting-acceptance'
  first.pr.sha = 'f'.repeat(40)
  await assert.rejects(f.rt.projectDelivery.reworkPool({ task, claim: { id: 'bad-return', attemptId: first.id, botId: 'p1:chief' }, reason: 'Reject inconsistent prior evidence' }), /binding is inconsistent/)
  assert.equal(first.status, 'waiting-acceptance')
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  first.pr.sha = original
  const id = await f.rt.projectDelivery.reworkPool({ task, claim: { id: 'chief-return', attemptId: first.id, botId: 'p1:chief' }, reason: 'Maintain the existing PR after its base advanced' })
  const next = f.rt.state.projectAttempts[id]
  assert.deepEqual(next.publicationBinding, { number: 48, repository: 'example/demo', branch: first.branch, previousSha: original, upstreamSha: first.baseSha, upstreamRef: 'main' })
  await prepareRole(f.rt, task, { id: 'next-dev', attemptId: id, generation: 2 }, developer)
  writeFileSync(join(next.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => Number(a)+Number(b); // intermediate\n')
  git(next.workspaces.developer.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-am', 'Private intermediate work'])
  writeFileSync(join(next.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => Number(a)+Number(b);\n')
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'developer', outputs: {} })
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', next.candidateSha + '^']), original)
  assert.equal(first.candidateSha, original)
  assert.equal(first.pr.number, 48)
  assert.notEqual(next.branch, first.branch, 'independent worktrees retain distinct local branches')
  assert.equal(Object.keys(f.rt.state.tasks).length, 1)
})


test('human retry of a published delivery preserves its PR and rejects inconsistent bindings before admission', async t => {
  const f = await setup(t)
  await f.start('first-publication'); await complete(f)
  const first = f.attempt(), sha = first.candidateSha
  await f.rt.projectEndpoint('project-task-reject', { attemptId: first.id, reason: 'Add a regression' }, alice)
  const retry = await f.start('human-retry')
  assert.deepEqual(retry.attempt.publicationBinding, { publicationMarker: `<!-- flybot-publication:${first.publicationEffectId} -->`, number: first.pr.number, repository: first.pr.repository, branch: first.branch, previousSha: sha, upstreamSha: first.baseSha, upstreamRef: 'main' })
  assert.equal(git(retry.attempt.workspaces.developer.path, ['rev-parse', 'HEAD']), sha)
  f.rt.projectDelivery.runReported({ id: retry.attempt.runId, taskId: f.task.id, attemptId: retry.attempt.id, projectId: 'p1', status: 'failed' })
  f.attempt().publicationBinding.repository = 'other/repo'
  const count = Object.keys(f.rt.state.projectAttempts).length
  await assert.rejects(f.start('inconsistent-retry'), /binding is inconsistent/)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, count)
})

test('published rework pins the actual target and seals both published and resolved upstream histories', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'committed merge' : 'resolved merge index', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) }); await f.start('upstream-rework')
  const task = f.rt.state.tasks[f.task.id], first = f.attempt()
  const developer = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'dev-before', attemptId: first.id, generation: 1 }, developer)
  writeFileSync(join(first.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: first.id }, role: 'developer', outputs: {} })
  const seed = first.candidateSha
  writeFileSync(join(f.repository, 'code.mjs'), 'export const add = (a,b) => a-b;\nexport const contract = () => "backend-v2";\n')
  writeFileSync(join(f.repository, 'code.test.mjs'), 'import assert from "node:assert/strict"; import {add,contract} from "./code.mjs"; assert.equal(add(2,3),5); assert.equal(contract(),"backend-v2");\n')
  git(f.repository, ['add', '.']); git(f.repository, ['commit', '-m', 'Advance trusted upstream backend'])
  const upstream = git(f.repository, ['rev-parse', 'HEAD'])
  f.publisher.read = async pr => ({ sha: pr.sha, state: 'open', baseRef: 'main', baseSha: upstream })
  first.pr = { number: 48, repository: 'example/demo', sha: seed }; first.status = 'waiting-acceptance'
  const currentRead = f.publisher.read
  for (const remote of [{ sha: seed, state: 'closed', baseRef: 'main', baseSha: upstream }, { sha: seed, state: 'open', baseRef: 'main', baseSha: '0'.repeat(40) }]) {
    f.publisher.read = async () => remote
    await assert.rejects(f.rt.projectDelivery.reworkPool({ task, claim: { id: 'unavailable-target', attemptId: first.id, botId: 'p1:chief' }, reason: 'Reject stale or unprovisioned upstream before allocation' }), /target is stale|not provisioned/)
    assert.equal(first.status, 'waiting-acceptance')
    assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  }
  f.publisher.read = currentRead
  const id = await f.rt.projectDelivery.reworkPool({ task, claim: { id: 'upstream-return', attemptId: first.id, botId: 'p1:chief' }, reason: 'Integrate current backend without losing published history' })
  const next = f.rt.state.projectAttempts[id]
  assert.equal(next.publicationBinding.upstreamSha, upstream)
  await prepareRole(f.rt, task, { id: 'dev-after', attemptId: id, generation: 2 }, developer)
  const path = next.workspaces.developer.path
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'developer', outputs: {} }), /merge the pinned upstream/)
  assert.equal(git(path, ['rev-parse', 'HEAD']), seed)
  const mergePath = git(path, ['rev-parse', '--git-path', 'MERGE_HEAD'])
  writeFileSync(mergePath, first.baseSha + '\n')
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'developer', outputs: {} }), /merge the pinned upstream/)
  rmSync(mergePath)
  assert.throws(() => git(path, ['merge', '--no-commit', '--no-ff', upstream]), /Command failed/)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'developer', outputs: {} }), /unresolved/)
  writeFileSync(join(path, 'code.mjs'), 'export const add = (a,b) => a+b;\nexport const contract = () => "backend-v2";\n')
  git(path, ['add', '.'])
  if (committed) git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Resolved merge before host sealing'])
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'developer', outputs: {} })
  assert.deepEqual(git(path, ['show', '-s', '--format=%P', next.candidateSha]).split(' '), [seed, upstream])
  assert.equal(first.candidateSha, seed)
  assert.equal(next.evidence.upstreamIntegration.sha, upstream)
  const tester = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'tester')
  await prepareRole(f.rt, task, { id: 'test-after', attemptId: id, generation: 3 }, tester)
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: id }, role: 'tester', outputs: {} })
  assert.equal(next.evidence.tests.passed, true)
  })
})

test('context admission checkpoints require host rejection and no external execution', async t => {
  for (const variant of ['safe','session','worker','bound','started','receipt','chief','cancel']) {
    const f=await setup(t,undefined,{pool:true}); f.rt.projectPools.connect({validate:()=>({ok:true})}); await f.start('admission-'+variant)
    const a=f.attempt(),task=f.rt.state.tasks[f.task.id]
    const execution={id:'failed-admission',status:'failed',attemptId:a.id,taskId:task.id,failure:'Execution admission failed: Role context exceeds 48000 characters'}
    task.collaboration.status='blocked'
    task.collaboration.history=[{attemptId:a.id,to:'p1:developer',status:'rejected',execution}]
    task.collaboration.claim={botId:'p1:chief',status:'waiting-human',workerId:'chief',chiefRunId:'chief-run'}
    f.rt.state.projectExecutions['chief-run']={status:'done'}
    f.rt.state.projectHarnessWorkers={chief:{status:'released',leaseId:'chief-lease',releaseProof:{kind:'sdk-stop-ack-and-process-exit'}}}
    f.rt.state.projectResourceLeases={'chief-lease':{status:'released'},reserved:{id:'reserved',attemptId:a.id,status:'reserved'}}
    if(variant==='session')a.roleSessions={developer:{id:'prepared'}}
    if(variant==='worker')f.rt.state.projectHarnessWorkers.dev={attemptId:a.id,status:'released'}
    if(variant==='bound')f.rt.state.projectResourceLeases.reserved.worker={kind:'sdk',handle:'unknown'}
    if(variant==='started')f.rt.state.projectResourceLeases.reserved.startedAt=1
    if(variant==='receipt')task.collaboration.history=[]
    if(variant==='chief')f.rt.state.projectHarnessWorkers.chief.releaseProof={kind:'assertion'}
    if(variant==='cancel')a.cancelRequested=true
    const before=structuredClone(task)
    createProjectDelivery(f.rt).recover()
    assert.equal(a.status,variant==='safe'?'running':'interrupted',variant)
    if(variant==='safe'){
      assert.equal(a.restartCheckpoints[0].kind,'quiescent-preparation-admission')
      assert.deepEqual(task,before)
      assert.equal(f.rt.state.projectResourceLeases.reserved.status,'reserved','delivery does not release live resources')
      await f.rt.projectResources.release('reserved',undefined)
      assert.equal(f.rt.state.projectResourceLeases.reserved.releaseProof.kind,'unbound-reservation-release')
    }
  }
})

test('failed context admission preserves an existing unsealed developer workspace',async t=>{
  const f=await setup(t,undefined,{pool:true}); f.rt.projectPools.connect({validate:()=>({ok:true})}); await f.start('context-retry')
  const a=f.attempt(),task=f.rt.state.tasks[f.task.id],dev=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r=>r.role==='developer')
  await prepareRole(f.rt, task,{id:'first',attemptId:a.id,generation:1},dev)
  const path=a.workspaces.developer.path
  writeFileSync(join(path,'code.mjs'),'export const preserved = true;\n')
  a.seedSha=a.baseSha
  a.feedback='x'.repeat(49000) // Required current Task input cannot be summarized away.
  await assert.rejects(prepareRole(f.rt, task,{id:'second',attemptId:a.id,generation:2},dev),/exceeds/)
  assert.equal(readFileSync(join(path,'code.mjs'),'utf8'),'export const preserved = true;\n')
  assert.equal(a.preparationFailures.at(-1).releasedBeforeExternalStart,false)
  assert.equal(a.roleSessions.developer.poolClaimId,'first')
})

test('context failure releases an actual unbound reservation before registering any SDK Session',async t=>{
  const f=await setup(t,undefined,{pool:true});f.rt.projectPools.connect({validate:()=>({ok:true})})
  f.rt.config.projectResources={one:{type:'local',root:f.directory,capacity:1,allowedProjectOwnerIds:['owner-1'],harnesses:['codex'],profiles:{'owner-1':{codex:{home:join(f.directory,'sdk-home'),configDir:join(f.directory,'sdk-config'),model:'fixture/model'}}}}}
  f.rt.state.projectResourceHealth={one:{status:'ready',at:Date.now()}};f.rt.state.projectHarnessHealth={'p1:one:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['one'], f.rt.readProject('p1'), 'one', 'codex').profile }}
  await f.rt.projectEndpoint('project-agent-definition',{projectId:'p1',role:'developer',execution:{harness:'codex',resourceIds:['one']}},alice)
  await f.start('unbound-context-failure')
  const a=f.attempt(),task=f.rt.state.tasks[f.task.id],dev=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r=>r.role==='developer')
  dev.instructions='x'.repeat(49000) // Required persona cannot be summarized away.
  await assert.rejects(prepareRole(f.rt, task,{id:'rejected',attemptId:a.id,generation:1},dev),/exceeds/)
  const lease=Object.values(f.rt.state.projectResourceLeases).find(x=>x.attemptId===a.id)
  assert.equal(lease.status,'released')
  assert.equal(lease.releaseProof.kind,'unbound-reservation-release')
  assert.equal(a.preparationFailures.at(-1).releasedBeforeExternalStart,true)
  assert.deepEqual(a.roleSessions,{})
  assert.equal(Object.values(f.rt.state.projectHarnessWorkers??{}).filter(x=>x.attemptId===a.id).length,0)
  assert.equal(a.workspaces.developer.status,'allocated')
})

test('a preparation-only successor retains its inherited sealed seed across another rework', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectScheduler.wake = () => {}
  f.rt.projectPools.connect({validate: () => ({ok: true})})
  await f.start('retain-seed')
  const first = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, {id: 'original-dev', attemptId: first.id, generation: 1}, dev)
  writeFileSync(join(first.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({task, claim: {attemptId: first.id}, role: 'developer', outputs: {implementation: 'Fixed'}})
  const seed = first.candidateSha
  const nextId = await f.rt.projectDelivery.reworkPool({task, claim: {attemptId: first.id, id: 'return-one', botId: 'chief'}, reason: 'Continue native UI', force: true})
  const next = f.rt.state.projectAttempts[nextId]
  assert.equal(next.seedSha, seed)
  next.status = 'interrupted'
  const finalId = await f.rt.projectDelivery.reworkPool({task, claim: {attemptId: nextId, id: 'preparation-retry', botId: 'chief'}, reason: 'Context preparation repaired', force: true})
  const final = f.rt.state.projectAttempts[finalId]
  assert.equal(final.seedSha, seed)
  await prepareRole(f.rt, task, {id: 'recovered-dev', attemptId: finalId, generation: 3}, dev)
  assert.match(readFileSync(join(final.workspaces.developer.path, 'code.mjs'), 'utf8'), /a\+b/)
  assert.equal(next.status, 'interrupted', 'Original failed preparation history remains')
})

test('a rework receiver gets hash-verified bounded failed-test facts instead of an inaccessible hash alone', async t => {
  const f = await setup(t, [process.execPath, '-e', "console.log('not ok 1 - popup layer regression');console.log('  error: missing z-index');console.log('padding\\n'.repeat(12000));console.log('# fail 1');process.exit(1)"], {pool: true})
  f.rt.projectScheduler.wake = () => {}
  f.rt.projectPools.connect({validate: () => ({ok: true})})
  await f.start('failure-feedback')
  const a = f.attempt(), task = f.rt.state.tasks[f.task.id], roles = f.rt.projectAgents.deliveryDefinitions('p1').roles
  const dev = roles.find(row => row.role === 'developer'), tester = roles.find(row => row.role === 'tester')
  await prepareRole(f.rt, task, {id: 'dev', attemptId: a.id, generation: 1}, dev)
  writeFileSync(join(a.workspaces.developer.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({task, claim: {attemptId: a.id}, role: 'developer', outputs: {}})
  await prepareRole(f.rt, task, {id: 'test', attemptId: a.id, generation: 2}, tester)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task, claim: {attemptId: a.id}, role: 'tester', outputs: {tests: 'Run host tests'}}), /tests failed/)
  const id = await f.rt.projectDelivery.reworkPool({task, claim: {attemptId: a.id, id: 'failed-test-return', botId: 'chief'}, reason: 'Fix actual failure', force: true})
  const next = f.rt.state.projectAttempts[id]
  await prepareRole(f.rt, task, {id: 'repair', attemptId: id, generation: 3}, dev)
  const context = next.roleSessions.developer.context.text
  assert.ok(context.includes('popup layer regression'))
  assert.ok(context.includes(a.evidence.tests.sha256))
  assert.ok(context.length < 48000)
  const deepId = await f.rt.projectDelivery.reworkPool({task, claim: {attemptId: id, id: 'preparation-only-return', botId: 'chief'}, reason: 'Preserve failure across preparation retry', force: true})
  await prepareRole(f.rt, task, {id: 'deep-repair', attemptId: deepId, generation: 4}, dev)
  assert.ok(f.rt.state.projectAttempts[deepId].roleSessions.developer.context.text.includes('popup layer regression'))
  writeFileSync(a.evidence.tests.log, 'tampered failure')
  await assert.rejects(prepareRole(f.rt, task, {id: 'stale-log', attemptId: deepId, generation: 5}, dev), /log changed/)
  a.projectId = 'another-project'
  await assert.rejects(prepareRole(f.rt, task, {id: 'foreign-log', attemptId: deepId, generation: 6}, dev), /another Task or Project/)
})

test('workspace allocation failure releases an actual reservation before any external execution', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  f.rt.projectScheduler.wake = () => {}
  f.rt.config.projectResources = { one: { type: 'local', root: f.directory, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(f.directory, 'sdk-home'), configDir: join(f.directory, 'sdk-config'), model: 'fixture/model' } } } } }
  f.rt.state.projectResourceHealth = { one: { status: 'ready', at: Date.now() } }
  f.rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['one'], f.rt.readProject('p1'), 'one', 'codex').profile } }
  await f.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  await f.start('allocation-failure')
  const a = f.attempt(), task = f.rt.state.tasks[f.task.id]
  // A real filesystem obstacle after reservation and before git worktree creation.
  writeFileSync(join(f.directory, 'delivery'), 'Not a directory')
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await assert.rejects(prepareRole(f.rt, task, { id: 'failed-allocation', attemptId: a.id, generation: 1 }, dev), /ENOTDIR|EEXIST/)
  const lease = Object.values(f.rt.state.projectResourceLeases).find(row => row.attemptId === a.id)
  assert.equal(lease.status, 'released')
  assert.equal(lease.releaseProof.kind, 'unbound-reservation-release')
  assert.equal(a.preparationFailures.at(-1).releasedBeforeExternalStart, true)
  assert.deepEqual(a.roleSessions, {})
  assert.equal(Object.values(f.rt.state.projectHarnessWorkers ?? {}).filter(row => row.attemptId === a.id).length, 0)
})

test('every pool receiver is host-prepared in its own checkout before registering a role Session', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  const settings = f.rt.config.projectRepositories['example/demo']
  // A real child process verifies the cwd and creates only ignored dependency data.
  settings.workspacePrepareCommand = [process.execPath, '-e', "const fs=require('fs');if(!fs.existsSync('code.mjs'))process.exit(31);fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/ready',process.cwd())"]
  await f.start('prepare-receivers')
  const a = f.attempt(), task = f.rt.state.tasks[f.task.id]
  for (const [index, role] of ['developer', 'tester', 'reviewer'].entries()) {
    const definition = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === role)
    const node = await prepareRole(f.rt, task, { id: `prepare-${role}`, attemptId: a.id, generation: index + 1 }, definition)
    assert.equal(readFileSync(join(node.executionWorkDir, 'node_modules/ready'), 'utf8'), node.executionWorkDir)
    assert.equal(a.workspacePreparations.at(-1).workspaceId, a.workspaces[role].id)
    assert.equal(a.roleSessions[role].status, 'prepared')
  }
  assert.equal(a.workspacePreparations.length, 3)
  assert.equal(new Set(Object.values(a.workspaces).map(row => row.path)).size, 3)
  settings.workspacePrepareCommand = [process.execPath, '-e', 'process.exit(37)']
  const previous = structuredClone(a.roleSessions.reviewer)
  const reviewer = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'reviewer')
  await assert.rejects(prepareRole(f.rt, task, { id: 'prepare-failed', attemptId: a.id, generation: 9 }, reviewer), error => error.code === 37)
  assert.deepEqual(a.roleSessions.reviewer, previous)
  assert.equal(a.workspacePreparations.length, 3)
  assert.equal(a.preparationFailures.at(-1).role, 'reviewer')
})

test('independent host tests prepare dependencies after cleaning their exact candidate checkout', async t => {
  const f = await setup(t, [process.execPath, '-e', "const fs=require('fs');if(fs.readFileSync('node_modules/ready','utf8')!==process.cwd())process.exit(33)"])
  f.rt.config.projectRepositories['example/demo'].workspacePrepareCommand = [process.execPath, '-e', "const fs=require('fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/ready',process.cwd())"]
  await f.start('host-preparation')
  await implement(f)
  const a = f.attempt(), path = a.workspaces.tester.path
  mkdirSync(join(path, 'node_modules')); writeFileSync(join(path, 'node_modules/stale'), 'Must be removed')
  await f.gate('tester')
  assert.equal(a.evidence.tests.passed, true)
  assert.equal(a.workspacePreparations.at(-1).workspaceId, a.workspaces.tester.id)
  assert.equal((await import('node:fs')).existsSync(join(path, 'node_modules/stale')), false)
})

test('environment preparation failure records not-run tests and repaired dependencies rerun the same sealed candidate', async t => {
  const f = await setup(t, [process.execPath, '-e', 'require("node:assert/strict").equal(require("./node_modules/local-fixture"),42)'], { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.start('environment-retry')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const definitions = f.rt.projectAgents.deliveryDefinitions('p1').roles
  await prepareRole(f.rt, task, { id: 'environment-dev', attemptId: attempt.id, generation: 1 }, definitions.find(row => row.role === 'developer'))
  writeFileSync(join(attempt.workspaces.developer.path, 'code.mjs'), 'export const add=(a,b)=>a+b;\n')
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: 'developer', outputs: { implementation: 'Correct implementation' } })
  await prepareRole(f.rt, task, { id: 'environment-test', attemptId: attempt.id, generation: 2 }, definitions.find(row => row.role === 'tester'))
  const settings = f.rt.config.projectRepositories['example/demo'], sha = attempt.candidateSha
  settings.dependencyEnvironment = { requiredPaths: ['node_modules/local-fixture/index.js'], tools: [{ argv: [process.execPath, '--version'], expectedOutput: process.version }], network: 'offline' }
  settings.workspacePrepareCommand = [process.execPath, '-e', 'process.exit(37)']
  const finish = () => f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: 'tester', outputs: { tests: 'Request exact host verification' } })
  await assert.rejects(finish(), /environment is blocked/)
  const failed = structuredClone(attempt.evidence.tests)
  assert.equal(failed.passed, false); assert.equal(failed.status, 'environment-blocked'); assert.equal(failed.testsStarted, false)
  assert.equal(failed.executor, 'independent-host-controller'); assert.equal(failed.sha, sha)
  assert.equal(failed.preparation.status, 'environment-blocked')
  const oldLog = readFileSync(failed.log, 'utf8')
  settings.workspacePrepareCommand = [process.execPath, '-e', 'const fs=require("fs");fs.mkdirSync("node_modules/local-fixture",{recursive:true});fs.writeFileSync("node_modules/local-fixture/index.js","module.exports=42")']
  await finish()
  assert.equal(attempt.candidateSha, sha); assert.equal(attempt.evidence.tests.sha, sha)
  assert.equal(attempt.evidence.tests.passed, true); assert.equal(attempt.evidence.tests.status, 'passed')
  assert.equal(attempt.evidence.tests.testsStarted, true); assert.equal(attempt.evidence.tests.preparation.status, 'ready')
  assert.deepEqual(attempt.testHistory[0], failed); assert.notEqual(attempt.evidence.tests.log, failed.log)
  assert.equal(readFileSync(failed.log, 'utf8'), oldLog)
  settings.testCommand = [process.execPath, '-e', 'require("node:assert/strict").equal(1,2)']
  await assert.rejects(finish(), /Configured tests failed/)
  assert.equal(attempt.evidence.tests.status, 'assertion-failed'); assert.equal(attempt.evidence.tests.testsStarted, true)
  assert.equal(attempt.testHistory.at(-1).passed, true)
})

test('independent verification preserves dependency diagnostics without declaring assertion failure', async t => {
  const f = await setup(t, [process.execPath, '-e', 'console.error("npm error ENOTCACHED only-if-cached");process.exit(1)'])
  await f.start('offline-diagnostic')
  await implement(f)
  await assert.rejects(f.gate('tester'), /Configured tests failed|environment is blocked/)
  const tests = f.attempt().evidence.tests
  assert.equal(tests.passed, false)
  assert.equal(tests.status, 'environment-blocked')
  assert.equal(tests.testsStarted, true)
  assert.match(readFileSync(tests.log, 'utf8'), /ENOTCACHED/)
})

test('npm test missing vitest after clean is runner-startup blockage and preparation reruns real assertions on the same candidate', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  const settings = f.rt.config.projectRepositories['example/demo']
  settings.allowedPaths.push('package.json')
  const wrapper = 'const cp=require("node:child_process");const r=cp.spawnSync("npm",["--offline","test"],{stdio:"inherit",env:{...process.env,HOME:process.argv[1],npm_config_cache:process.argv[1]+"/npm-cache"}});process.exit(r.status??1)'
  settings.testCommand = [process.execPath, '-e', wrapper, f.directory]
  await f.start('missing-vitest')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id], roles = f.rt.projectAgents.deliveryDefinitions('p1').roles
  await prepareRole(f.rt, task, { id: 'missing-runner-dev', attemptId: attempt.id, generation: 1 }, roles.find(row => row.role === 'developer'))
  writeFileSync(join(attempt.workspaces.developer.path, 'code.mjs'), 'export const add=(a,b)=>a+b;\n')
  writeFileSync(join(attempt.workspaces.developer.path, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: 'developer', outputs: { implementation: 'Implement addition' } })
  await prepareRole(f.rt, task, { id: 'missing-runner-test', attemptId: attempt.id, generation: 2 }, roles.find(row => row.role === 'tester'))
  const sha = attempt.candidateSha, path = attempt.workspaces.tester.path
  mkdirSync(join(path, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(path, 'node_modules/stale'), 'Must be cleaned')
  const finish = () => f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: 'tester', outputs: { tests: 'Request host verification' } })
  await assert.rejects(finish(), /Configured tests failed|environment is blocked/)
  const failed = structuredClone(attempt.evidence.tests)
  assert.equal(failed.status, 'environment-blocked'); assert.equal(failed.stage, 'runner-startup')
  assert.equal(failed.testsStarted, true); assert.equal(failed.preparation, null); assert.equal(failed.passed, false)
  assert.match(readFileSync(failed.log, 'utf8'), /vitest: (?:command )?not found/)
  assert.equal((await import('node:fs')).existsSync(join(path, 'node_modules/stale')), false)
  // A transport runner fixture delegates to the real Node assertions; this is
  // not an installed Vitest or a paid-model acceptance claim.
  const runner = '#!/usr/bin/env node\nconst r=require("node:child_process").spawnSync(process.execPath,["--test","--test-reporter=tap","code.test.mjs"],{stdio:"inherit"});process.exit(r.status??1)\n'
  settings.workspacePrepareCommand = [process.execPath, '-e', `const fs=require('fs');fs.mkdirSync('node_modules/.bin',{recursive:true});fs.writeFileSync('node_modules/.bin/vitest',${JSON.stringify(runner)},{mode:0o755})`]
  await finish()
  assert.equal(attempt.candidateSha, sha); assert.equal(attempt.evidence.tests.sha, sha)
  assert.equal(attempt.evidence.tests.status, 'passed'); assert.equal(attempt.evidence.tests.stage, 'tests')
  assert.equal(attempt.evidence.tests.preparation.status, 'ready')
  assert.deepEqual(attempt.testHistory[0], failed)
  assert.match(readFileSync(attempt.evidence.tests.log, 'utf8'), /# pass 1/)
})

test('independent test timeout remains incomplete verification with an immutable log', async t => {
  const f = await setup(t, [process.execPath, '-e', 'setTimeout(()=>{},10000)'])
  await f.start('test-timeout')
  await implement(f)
  f.rt.config.projectRepositories['example/demo'].testTimeoutMs = 20
  await assert.rejects(f.gate('tester'), /timed out/)
  const tests = f.attempt().evidence.tests
  assert.equal(tests.passed, false); assert.equal(tests.status, 'execution-timeout'); assert.equal(tests.testsStarted, true)
  assert.equal(tests.exitConfirmed, true)
})

test('bound-resource preparation executes before SDK registration and failure retains unknown occupancy', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  f.rt.projectScheduler.wake = () => {}
  f.rt.config.projectResources = { one: { type: 'local', root: f.directory, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(f.directory, 'sdk-home'), configDir: join(f.directory, 'sdk-config'), model: 'fixture/model' } } } } }
  f.rt.state.projectResourceHealth = { one: { status: 'ready', at: Date.now() } }
  f.rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['one'], f.rt.readProject('p1'), 'one', 'codex').profile } }
  await f.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  const settings = f.rt.config.projectRepositories['example/demo']
  settings.workspacePrepareCommand = [process.execPath, '-e', "if(!require('fs').existsSync('code.mjs'))process.exit(31)"]
  await f.start('resource-preparation')
  const a = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'prepared-resource', attemptId: a.id, generation: 1 }, dev)
  assert.equal(a.workspacePreparations.at(-1).resourceId, 'one')
  const original = structuredClone(a.roleSessions.developer)
  const first = a.resourceLeases.developer
  await f.rt.projectResources.release(first.id, first.generation)
  const preparationCommand = settings.workspacePrepareCommand
  settings.workspacePrepareCommand = [process.execPath, '-e', 'process.exit(37)']
  await assert.rejects(prepareRole(f.rt, task, { id: 'resource-command-failed', attemptId: a.id, generation: 2 }, dev), error => error.code === 37)
  assert.equal(f.rt.state.projectResourceLeases[a.resourceLeases.developer.id].status, 'released')
  assert.equal(a.preparationFailures.at(-1).releasedBeforeExternalStart, true)
  settings.workspacePrepareCommand = preparationCommand
  const command = f.rt.projectResources.command
  f.rt.projectResources.command = async (...args) => {
    const lease = a.resourceLeases.developer
    await f.rt.projectResources.markStarted(lease.id, lease.generation, { kind: 'sdk', handle: 'unknown-worker' })
    await command(...args)
    throw new Error('Connection lost after external registration')
  }
  const unknownClaim = { id: 'unknown-preparation', attemptId: a.id, generation: 2 }
  await assert.rejects(prepareRole(f.rt, task, unknownClaim, dev), /Connection lost/)
  const held = f.rt.state.projectResourceLeases[a.resourceLeases.developer.id]
  assert.equal(held.status, 'running')
  assert.equal(held.worker.handle, 'unknown-worker')
  assert.equal(a.preparationFailures.at(-1).releasedBeforeExternalStart, false)
  assert.deepEqual(a.roleSessions.developer, original)
})

test('unstarted bound delivery refreshes a verified descendant target without replacing its draft or Attempt',async t=>{
  for(const variant of ['safe','reserved','unknown','worker','session','history','execution','candidate','cancel','native','unproven-release','released-bound','stale-state','unrelated','missing','moved-head','moved-ref']){
    const f=await setup(t,undefined,{pool:true});f.rt.projectScheduler.wake=()=>{} // Keep deliberate lease snapshots stable during admission checks.
    f.rt.projectPools.connect({validate:()=>({ok:true})});await f.start('target-refresh-'+variant)
    const a=f.attempt(),task=f.rt.state.tasks[f.task.id],dev=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r=>r.role==='developer'),base=a.baseSha
    a.seedSha=base;a.publicationBinding={number:48,repository:'example/demo',branch:'original-delivery',previousSha:base,upstreamSha:base,upstreamRef:'main'}
    const originalInstructions=dev.instructions;dev.instructions='x'.repeat(49000)
    await assert.rejects(prepareRole(f.rt, task,{id:'before',attemptId:a.id,generation:1},dev),/exceeds/)
    dev.instructions=originalInstructions
    const path=a.workspaces.developer.path;writeFileSync(join(path,'code.mjs'),'export const preservedDraft = true;\n')
    writeFileSync(join(f.repository,'backend.mjs'),'export const backend = 2;\n');git(f.repository,['add','backend.mjs']);git(f.repository,['commit','-m','Advance trusted target'])
    const target=git(f.repository,['rev-parse','HEAD']),old=structuredClone(a.publicationBinding)
    if(['reserved','unknown'].includes(variant))f.rt.state.projectResourceLeases={held:{attemptId:a.id,status:variant==='reserved'?'reserved':'unreachable'}}
    if(variant==='worker')f.rt.state.projectHarnessWorkers={old:{attemptId:a.id,status:'released'}}
    if(variant==='session')a.roleSessions.developer={id:'external-session'}
    if(variant==='history')a.roleSessionHistory=[{id:'past-session'}]
    if(variant==='execution')a.evidence.execution={developer:{id:'recorded'}}
    if(variant==='candidate')a.candidateSha=base
    if(variant==='cancel')a.cancelRequested=true
    if(variant==='native')f.rt.state.bots.live={ephemeral:true,attemptId:a.id}
    if(variant==='unproven-release')f.rt.state.projectResourceLeases={held:{attemptId:a.id,status:'released'}}
    if(variant==='released-bound')f.rt.state.projectResourceLeases={held:{attemptId:a.id,status:'released',releaseProof:{kind:'unbound-reservation-release'},worker:{kind:'sdk',handle:'missing'}}}
    if(variant==='stale-state')f.publisher.read=async()=>{a.status='interrupted';return{sha:base,state:'open',baseRef:'main',baseSha:target}}
    if(variant==='unrelated'){
      const unrelated=git(f.repository,['commit-tree',git(f.repository,['rev-parse','HEAD^{tree}']),'-m','Unrelated target'])
      f.publisher.read=async()=>({sha:base,state:'open',baseRef:'main',baseSha:unrelated})
    }
    if(variant==='missing')f.publisher.read=async()=>({sha:base,state:'open',baseRef:'main',baseSha:'1'.repeat(40)})
    if(variant==='moved-head')f.publisher.read=async()=>({sha:target,state:'open',baseRef:'main',baseSha:target})
    if(variant==='moved-ref')f.publisher.read=async()=>({sha:base,state:'open',baseRef:'other',baseSha:target})
    const prepare=()=>prepareRole(f.rt, task,{id:'after',attemptId:a.id,generation:2},dev)
    if(variant==='safe'){
      await prepare();assert.equal(a.publicationBinding.upstreamSha,target);assert.equal(a.publicationBindingHistory.length,1)
      assert.deepEqual(a.publicationBindingHistory[0].previous,old);assert.deepEqual(a.publicationBindingHistory[0].current,a.publicationBinding)
      assert.equal(a.publicationBindingHistory[0].claimId,'after');assert.equal(a.publicationBindingHistory[0].generation,2)
      assert.equal(a.seedSha,base);assert.equal(a.baseSha,base);assert.equal(a.id,task.deliveryAttemptId)
      assert.match(a.roleSessions.developer.context.text,new RegExp(target));assert.equal(Object.values(f.rt.state.projectAttempts).length,1)
    }else{
      await assert.rejects(prepare(),/recorded or unknown execution|descendant|not provisioned|stale or unavailable/,variant)
      assert.deepEqual(a.publicationBinding,old);assert.equal(a.publicationBindingHistory,undefined)
    }
    assert.equal(readFileSync(join(path,'code.mjs'),'utf8'),'export const preservedDraft = true;\n')
    assert.equal(git(path,['rev-parse','HEAD']),base)
  }
})

async function publicationFailure(t) {
  const f = await setup(t)
  await f.start('publication-recovery')
  await implement(f); await f.gate('tester')
  const a = f.attempt()
  f.rt.state.projectHarnessWorkers ??= {}; f.rt.state.projectResourceLeases ??= {}
  a.publicationBinding = { number: 48, repository: 'example/demo', branch: a.branch, previousSha: a.baseSha, upstreamSha: a.baseSha, upstreamRef: 'main' }
  f.publisher.publish = async () => { throw new Error('PR head does not match the tested candidate') }
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task: { ...f.task, collaboration: { kind: 'code' } }, claim: { attemptId: a.id }, role: 'reviewer', outputs: { review: JSON.stringify({ commit: a.candidateSha, verdict: 'approve', summary: 'Independent exact-commit review' }) } }), /PR head does not match/)
  assert.equal(a.status, 'running'); assert.equal(a.pr, undefined)
  f.publisher.publish = async attempt => { const pr = { number: 48, sha: attempt.candidateSha, repository: 'example/demo' }; f.published.push(pr); return pr }
  const retry = actor => f.rt.projectEndpoint('project-attempt-publication-retry', { attemptId: a.id }, actor ?? alice)
  return { ...f, a, retry }
}

test('existing-PR recovery reuses sealed tests/Review and stays subject to Chief acceptance', async t => {
  const f = await publicationFailure(t), a = f.a
  a.protocol = 'project-handoff/v1'
  const evidence = structuredClone(a.evidence), sessions = structuredClone(a.roleSessions)
  const first = await f.retry()
  assert.equal(first.attempt.pr.number, 48); assert.equal(first.attempt.status, 'waiting-acceptance')
  assert.equal(f.rt.state.tasks[f.task.id].status, 'result-ready')
  assert.deepEqual(a.evidence, evidence); assert.deepEqual(a.roleSessions, sessions)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  assert.equal((await f.retry()).already, true)
  assert.equal(a.publicationRecoveries.length, 1)
  await assert.rejects(f.rt.projectEndpoint('project-task-accept', { attemptId: a.id }, alice), /Chief arbitration/)
})

test('publication recovery refuses unauthorized, stale and still-executing evidence before any push', async t => {
  const f = await publicationFailure(t), a = f.a
  await assert.rejects(f.retry(bob), /access denied/)
  for (const mutate of [
    () => { a.evidence.tests.sha = 'wrong' },
    () => { a.evidence.review.verdict = 'request-changes' },
    () => { f.rt.state.tasks[f.task.id].criteria = 'changed' },
    () => { a.cancelRequested = true },
    () => { a.status = 'returned' },
    () => { delete a.publicationBinding },
    () => { delete a.roleSessions.reviewer },
    () => { f.rt.state.projectHarnessWorkers.fake = { attemptId: a.id, status: 'running' } },
    () => { f.rt.state.projectResourceLeases.fake = { attemptId: a.id, status: 'reserved' } },
    () => { f.rt.state.tasks[f.task.id].deliveryAttemptId = 'other' },
    () => { a.evidence.tests.sha256 = 'changed' },
    () => { a.roleSessions.reviewer.execution.harness = 'codex-sdk' },
  ]) {
    const before = structuredClone(a), task = structuredClone(f.rt.state.tasks[f.task.id])
    mutate(); await assert.rejects(f.retry()); assert.equal(f.published.length, 0)
    for (const key of Object.keys(a)) delete a[key]
    Object.assign(a, before); f.rt.state.tasks[f.task.id] = task
    delete f.rt.state.projectHarnessWorkers.fake; delete f.rt.state.projectResourceLeases.fake
  }
  writeFileSync(join(a.workspaces.developer.path, 'code.mjs'), 'modified after testing')
  await assert.rejects(f.retry(), /Candidate changed/); assert.equal(f.published.length, 0)
})

test('failed PR reconciliation never fabricates a receipt or consumes prior evidence', async t => {
  const f = await publicationFailure(t), before = structuredClone(f.a.evidence)
  f.publisher.publish = async () => { throw new Error('Existing PR upstream changed') }
  await assert.rejects(f.retry(), /upstream changed/)
  assert.equal(f.a.pr, undefined); assert.equal(f.a.status, 'running')
  assert.deepEqual(f.a.evidence, before)
  f.publisher.publish = async () => ({ number: 48, sha: 'wrong' })
  await assert.rejects(f.retry(), /does not match candidate/)
  assert.equal(f.a.pr, undefined)
})


test('SDK Task rework preserves an unsealed same-base draft and old cleanup cannot remove the live cwd', async t => {
  const f=await setup(t,undefined,{pool:true})
  f.rt.projectScheduler.wake=()=>{};f.rt.projectPools.connect({validate:()=>({ok:true})})
  f.rt.config.projectResources={one:{type:'local',root:f.directory,capacity:1,allowedProjectOwnerIds:['owner-1'],harnesses:['codex'],profiles:{'owner-1':{codex:{home:join(f.directory,'sdk-home'),configDir:join(f.directory,'sdk-config'),model:'fixture/model'}}}}}
  f.rt.state.projectResourceHealth={one:{status:'ready',at:Date.now()}};f.rt.state.projectHarnessHealth={'p1:one:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['one'], f.rt.readProject('p1'), 'one', 'codex').profile }}
  await f.rt.projectEndpoint('project-agent-definition',{projectId:'p1',role:'developer',execution:{harness:'codex',resourceIds:['one']}},alice)
  await f.start('retained-draft')
  const previous=f.attempt(),task=f.rt.state.tasks[f.task.id],dev=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r=>r.role==='developer')
  await prepareRole(f.rt, task,{id:'first',attemptId:previous.id,generation:1},dev)
  const cwd=previous.workspaces.developer.path
  writeFileSync(join(cwd,'code.mjs'),'export const preservedDraft = true;\n')
  const lease=previous.resourceLeases.developer
  await f.rt.projectResources.release(lease.id,lease.generation)
  previous.status='interrupted'
  const id=await f.rt.projectDelivery.reworkPool({task,claim:{id:'recover',attemptId:previous.id,botId:'p1:chief'},reason:'Resume confirmed idle draft',force:true})
  const next=f.rt.state.projectAttempts[id]
  await prepareRole(f.rt, task,{id:'second',attemptId:id,generation:2},dev)
  assert.equal(next.workspaces.developer.path,cwd)
  assert.equal(next.workspaces.developer.retainedDraft,true)
  assert.equal(readFileSync(join(cwd,'code.mjs'),'utf8'),'export const preservedDraft = true;\n')
  f.rt.state.projectWorkspaces=structuredClone(f.rt.state.projectWorkspaces) // Store reload gives each snapshot its own objects.
  await f.rt.projectEndpoint('project-attempt-cleanup',{attemptId:previous.id},alice)
  assert.equal(f.rt.state.projectWorkspaces[previous.workspaces.developer.id].status,'released')
  assert.equal(readFileSync(join(cwd,'code.mjs'),'utf8'),'export const preservedDraft = true;\n')
})

test('a returned SDK draft reuses its Task workspace after exact supervisor exit proof', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  f.rt.config.projectResources = { one: { type: 'local', root: f.directory, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'] } }
  f.rt.config.projectResources.one.profileRoot = join(f.directory, 'proof-profile')
  f.rt.state.projectResourceHealth = { one: { status: 'ready' } }
  f.rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['one'], f.rt.readProject('p1'), 'one', 'codex').profile } }
  await f.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  await f.start('supervised-draft')
  const previous = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'old', attemptId: previous.id, generation: 1 }, dev)
  const workspace = previous.workspaces.developer, lease = f.rt.state.projectResourceLeases[previous.resourceLeases.developer.id]
  writeFileSync(join(workspace.path, 'code.mjs'), 'export const add = (a,b) => a+b; // retained draft\n')
  const proof = { kind: 'systemd-prior-invocation-exited', previousInvocationId: 'a'.repeat(32), at: Date.now() }
  Object.assign(lease, { status: 'released', worker: { kind: 'sdk', handle: 'old-worker' }, processScope: { kind: 'systemd-control-group', killMode: 'control-group', invocationId: proof.previousInvocationId }, releaseProof: proof })
  f.rt.state.projectHarnessWorkers = { 'old-worker': { id: 'old-worker', projectId: 'p1', taskId: task.id, attemptId: previous.id, role: 'developer', leaseId: lease.id, resourceId: 'one', generation: lease.generation, status: 'released', releaseProof: proof } }
  const id = await f.rt.projectDelivery.reworkPool({ task, claim: { id: 'return', attemptId: previous.id, botId: dev.id }, reason: 'Resume the retained draft after supervisor restart', force: true })
  await prepareRole(f.rt, task, { id: 'next', attemptId: id, generation: 2 }, dev)
  const current = f.rt.state.projectAttempts[id].workspaces.developer
  assert.equal(current.path, workspace.path)
  assert.equal(current.reusesWorkspaceId, workspace.id)
  assert.equal(current.retainedDraft, true)
  assert.match(readFileSync(join(current.path, 'code.mjs'), 'utf8'), /retained draft/)
  assert.equal(workspace.status, 'retained')
  assert.equal(previous.status, 'returned')
  assert.equal(f.rt.state.projectHarnessWorkers['old-worker'].releaseProof, proof)
})

async function additionalIntegrationFixture(t, { conflict = false, merge = true } = {}) {
  const f=await setup(t,undefined,{pool:true})
  f.rt.projectScheduler.wake=()=>Promise.resolve()
  f.rt.projectPools.connect({validate:()=>({ok:true})})
  f.rt.config.projectRepositories['example/demo'].allowedPaths.push('backend.mjs')
  const base=git(f.repository,['rev-parse','HEAD'])
  git(f.repository,['switch','-c','operator-source'])
  writeFileSync(join(f.repository,'backend.mjs'),'export const serviceVersion = 1;\n')
  if(conflict)writeFileSync(join(f.repository,'code.mjs'),'export const add = (a,b) => a*b;\n')
  git(f.repository,['add','.']);git(f.repository,['commit','-m','Verified backend source'])
  const source=git(f.repository,['rev-parse','HEAD']),ref='refs/remotes/operator/verified-backend'
  git(f.repository,['update-ref',ref,source]);git(f.repository,['switch','main'])
  git(f.repository,['switch','-c','published-ui'])
  writeFileSync(join(f.repository,'code.mjs'),'export const add = (a,b) => a+b;\n')
  git(f.repository,['add','code.mjs']);git(f.repository,['commit','-m','Previous frontend candidate'])
  const seed=git(f.repository,['rev-parse','HEAD']);git(f.repository,['switch','main'])
  await f.start('additional-source')
  const attempt=f.attempt(),task=f.rt.state.tasks[f.task.id]
  attempt.seedSha=seed
  attempt.publicationBinding={number:7,repository:'example/demo',branch:'published-ui',previousSha:seed,upstreamSha:base,upstreamRef:'main'}
  const developer=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row=>row.role==='developer')
  await prepareRole(f.rt, task,{id:'integration-claim',attemptId:attempt.id,generation:1},developer)
  const path=attempt.workspaces.developer.path
  if(merge){if(conflict)assert.throws(()=>git(path,['merge','--no-commit','--no-ff',source]));else git(path,['merge','--no-commit','--no-ff',source])}
  return {...f,base,source,ref,seed,path,task,attempt,developer}
}

test('an approved extra merge seals when the published upstream is already an ancestor', async t => {
  const f=await additionalIntegrationFixture(t)
  const snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  await integrationCall(f,'command','attempt.integration-bind',{inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot})
  const tree=git(f.path,['write-tree'])
  await f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{implementation:'Resolved the approved backend integration'}})
  const candidate=f.attempt.candidateSha
  assert.equal(git(f.path,['rev-parse',candidate+'^{tree}']),tree)
  assert.deepEqual(git(f.path,['rev-list','--parents','-n','1',candidate]).split(' ').slice(1),[f.seed,f.source])
  assert.equal(git(f.path,['status','--porcelain']),'')
  assert.throws(()=>git(f.path,['rev-parse','--verify','MERGE_HEAD']))
  assert.equal(readFileSync(join(f.path,'backend.mjs'),'utf8'),'export const serviceVersion = 1;\n')
  assert.equal(f.attempt.status,'running')
  assert.equal(f.attempt.pr,undefined)
})

const integrationCall = (f, kind, name, payload, actor = alice, requestId = `integration-${f.integrationSequence = (f.integrationSequence ?? 0) + 1}`) => f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind, name, projectId: 'p1', ...(kind === 'command' ? { requestId } : {}), payload: { attemptId: f.attempt.id, ...payload } }, actor)
const indexBytes = f => createHash('sha256').update(readFileSync(git(f.path,['rev-parse','--git-path','index']))).digest('hex')

test('manager explicitly pins integration input through service snapshot without changing index or approving delivery', async t => {
  const f=await additionalIntegrationFixture(t),before=indexBytes(f)
  const snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  const payload={inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot}
  const approved=await integrationCall(f,'command','attempt.integration-bind',payload,alice,'approve-backend')
  assert.equal(approved.result.already,false)
  assert.equal(approved.result.admission.generation,snapshot.generation+1)
  assert.equal(indexBytes(f),before)
  assert.equal(git(f.path,['rev-parse','MERGE_HEAD']),f.source)
  const reordered={...payload,expectedWorkspace:Object.fromEntries(Object.entries(payload.expectedWorkspace).reverse())}
  const replay=await integrationCall(f,'command','attempt.integration-bind',reordered,alice,'approve-backend')
  assert.equal(replay.replayed,true)
  assert.equal(replay.result.admission.id,approved.result.admission.id)
  assert.equal(f.attempt.integrationAdmissions.length,1)
  assert.equal(f.attempt.candidateSha,undefined)
  const node=await prepareRole(f.rt, f.task,{id:'resumed-integration',attemptId:f.attempt.id,generation:99},f.developer)
  assert.match(node.prompt,/do not git commit/)
  const text=f.attempt.roleSessions.developer.context.text
  assert.ok(text.includes(f.source))
  assert.equal(git(f.path,['rev-parse','MERGE_HEAD']),f.source)
  await f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{implementation:'Ready for host sealing'}})
  assert.ok(f.attempt.candidateSha)
  assert.equal(f.attempt.evidence.approvedIntegrations.mergeHead,f.source)
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload,alice,'new-after-sealing'),/unsealed/)
})

test('integration admission denies member, foreign source, stale snapshot and unknown execution without mutation', async t => {
  const f=await additionalIntegrationFixture(t),before=indexBytes(f)
  const snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  const payload={inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload,bob),/access denied/)
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',{...payload,inputs:[{ref:'refs/heads/operator-source',sha:f.source}]}),/operator source/)
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',{...payload,generation:snapshot.generation+1}),/generation/)
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',{...payload,expectedWorkspace:{...snapshot.snapshot,indexSha256:'0'.repeat(64)}}),/workspace changed/)
  f.rt.state.projectExecutions['pending-chief']={id:'pending-chief',kind:'chief-control',projectId:'p1',status:'running'}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/confirmed execution exit/)
  delete f.rt.state.projectExecutions['pending-chief']
  f.task.collaboration.claim={id:'not-yet-spawned',status:'active',generation:f.task.collaboration.generation,botId:'p1:developer'}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/confirmed execution exit/)
  delete f.task.collaboration.claim
  f.rt.state.projectHarnessWorkers={unknown:{id:'unknown',attemptId:f.attempt.id,status:'released',generation:1}}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/confirmed execution exit/)
  f.rt.state.projectHarnessWorkers.unknown.status='running'
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/confirmed execution exit/)
  assert.equal(indexBytes(f),before)
  assert.equal(f.attempt.integrationInputs,undefined)
  assert.equal(git(f.path,['rev-parse','HEAD']),f.seed)
})

test('integration admission separates released historical Chief turns from current or unconfirmed occupancy', async t => {
  const f=await additionalIntegrationFixture(t)
  const worker={id:'old-chief',projectId:'p1',chiefRunId:'old-run',attemptId:'old-turn',status:'released',generation:1}
  f.rt.state.projectHarnessWorkers={historical:worker}
  const saved=(await integrationCall(f,'query','attempt.integration-state',{})).result
  assert.equal(saved.attemptId,f.attempt.id)
  worker.status='unreachable'
  await assert.rejects(integrationCall(f,'query','attempt.integration-state',{}),/confirmed execution exit/)
  worker.status='released'
  f.task.collaboration.claim={id:'current-chief',chiefRunId:'old-run',status:'waiting-human'}
  await assert.rejects(integrationCall(f,'query','attempt.integration-state',{}),/confirmed execution exit/)
  worker.releaseProof={kind:'sdk-stop-ack-and-process-exit',generation:1}
  await integrationCall(f,'query','attempt.integration-state',{})
  delete f.task.collaboration.claim
  delete worker.releaseProof
  await integrationCall(f,'command','attempt.integration-bind',{inputs:[{ref:f.ref,sha:f.source}],generation:saved.generation,expectedWorkspace:saved.snapshot})
  assert.equal(f.attempt.integrationInputs[0].sha,f.source)
})

test('unapproved and moved integration parents are refused before index or branch writes', async t => {
  const f=await additionalIntegrationFixture(t),before=indexBytes(f)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{}}),/not a pinned upstream or approved/)
  assert.equal(indexBytes(f),before)
  f.attempt.integrationInputs=[{version:'project-integration-input/v1',repository:'example/demo',ref:f.ref,sha:f.source}]
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{}}),/no confirmed durable intent/)
  delete f.attempt.integrationInputs
  const snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  await integrationCall(f,'command','attempt.integration-bind',{inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot})
  git(f.repository,['update-ref',f.ref,f.base])
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{}}),/source ref moved/)
  assert.equal(indexBytes(f),before)
  assert.equal(git(f.path,['rev-parse','HEAD']),f.seed)
  assert.equal(git(f.path,['rev-parse','MERGE_HEAD']),f.source)
})

test('conflicted approved merges remain untouched by admission or sealing', async t => {
  const f=await additionalIntegrationFixture(t,{conflict:true,merge:false})
  const initial=(await integrationCall(f,'query','attempt.integration-state',{})).result
  await integrationCall(f,'command','attempt.integration-bind',{inputs:[{ref:f.ref,sha:f.source}],generation:initial.generation,expectedWorkspace:initial.snapshot})
  assert.throws(()=>git(f.path,['merge','--no-commit','--no-ff',f.source]))
  const before=indexBytes(f),snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',{inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot},alice,'conflicted-admission'),/unresolved paths/)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{}}),/unresolved paths/)
  assert.equal(indexBytes(f),before)
  assert.equal(git(f.path,['rev-parse','HEAD']),f.seed)
  assert.equal(git(f.path,['rev-parse','MERGE_HEAD']),f.source)
})

test('an approved operator object reaches a resource clone through the existing verified bundle adapter', async t => {
  const f=await setup(t,undefined,{pool:true})
  f.rt.projectScheduler.wake=()=>Promise.resolve();f.rt.projectPools.connect({validate:()=>({ok:true})})
  f.rt.config.projectRepositories['example/demo'].allowedPaths.push('backend.mjs')
  const base=git(f.repository,['rev-parse','HEAD'])
  writeFileSync(join(f.repository,'backend.mjs'),'export const serviceVersion = 1;\n')
  git(f.repository,['add','backend.mjs']);git(f.repository,['commit','-m','Verified operator source'])
  const sha=git(f.repository,['rev-parse','HEAD']),ref='refs/remotes/operator/remote-source'
  git(f.repository,['update-ref',ref,sha]);git(f.repository,['reset','--hard',base])
  const remote=join(f.directory,'emulated-resource');mkdirSync(remote)
  f.rt.config.projectResources={remote:{type:'docker',root:remote,container:'fixture',user:'1000:1000',capacity:1,allowedProjectOwnerIds:['owner-1'],harnesses:['codex']}}
  f.rt.config.projectResources.remote.profileRoot = join(f.directory, 'proof-profile')
  f.rt.state.projectResourceHealth={remote:{status:'ready'}};f.rt.state.projectHarnessHealth={'p1:remote:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['remote'], f.rt.readProject('p1'), 'remote', 'codex').profile }}
  // Local transport emulation exercises real Git/bundle hashes, not Docker isolation.
  f.rt.projectResources.command=async(_p,_r,{argv,cwd})=>({stdout:execFileSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']})})
  f.rt.projectResources.uploadFile=async(_p,_r,source,target)=>copyFileSync(source,target)
  await f.rt.projectEndpoint('project-agent-definition',{projectId:'p1',role:'developer',execution:{harness:'codex',resourceIds:['remote']}},alice)
  await f.start('remote-integration')
  const attempt=f.attempt(),task=f.rt.state.tasks[f.task.id]
  const query=await f.rt.projectEndpoint('project-development',{version:'project-development/v1',kind:'query',name:'attempt.integration-state',projectId:'p1',payload:{attemptId:attempt.id}},alice)
  await f.rt.projectEndpoint('project-development',{version:'project-development/v1',kind:'command',name:'attempt.integration-bind',projectId:'p1',requestId:'remote-source',payload:{attemptId:attempt.id,inputs:[{ref,sha}],generation:query.result.generation,expectedWorkspace:null}},alice)
  const developer=f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row=>row.role==='developer')
  await prepareRole(f.rt, task,{id:'remote-claim',attemptId:attempt.id,generation:9},developer)
  const workspace=attempt.workspaces.developer
  assert.equal(workspace.kind,'resource-clone')
  assert.equal(git(workspace.path,['cat-file','-t',sha]),'commit')
  assert.ok(workspace.transfers.some(row=>row.commit===sha&&row.sha256.length===64))
  assert.equal(attempt.candidateSha,undefined,'Provisioning an approved object does not seal or approve a candidate')
  assert.equal(git(workspace.path,['rev-parse','HEAD']),base)
})

test('failed/no-op admission saves cannot authorize an integration or invalidate its previous generation', async t => {
  const f=await additionalIntegrationFixture(t),before=indexBytes(f)
  const snapshot=(await integrationCall(f,'query','attempt.integration-state',{})).result
  const payload={inputs:[{ref:f.ref,sha:f.source}],generation:snapshot.generation,expectedWorkspace:snapshot.snapshot},save=f.rt.save
  f.rt.save=async()=>{}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/commit was not confirmed/)
  assert.equal(f.attempt.integrationInputs,undefined)
  assert.equal(f.task.collaboration.generation,snapshot.generation)
  f.rt.save=async()=>{throw Error('Injected disk failure')}
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',payload),/disk failure/)
  assert.equal(f.attempt.integrationInputs,undefined)
  assert.equal(f.task.collaboration.generation,snapshot.generation)
  assert.equal(indexBytes(f),before)
  f.rt.save=save
  const accepted=await integrationCall(f,'command','attempt.integration-bind',payload)
  assert.equal(f.rt.projectEffects.intentCommitted(accepted.result.admission.effect),true)
})

test('approved object availability alone cannot replace a real merge or reuse an admission for different content', async t => {
  const f=await additionalIntegrationFixture(t,{merge:false})
  const state=(await integrationCall(f,'query','attempt.integration-state',{})).result
  const payload={inputs:[{ref:f.ref,sha:f.source}],generation:state.generation,expectedWorkspace:state.snapshot}
  await integrationCall(f,'command','attempt.integration-bind',payload,alice,'reuse-source')
  const before=indexBytes(f)
  await assert.rejects(integrationCall(f,'command','attempt.integration-bind',{...payload,generation:state.generation+1},alice,'reuse-source'),/requestId was reused/)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({task:f.task,claim:{attemptId:f.attempt.id},role:'developer',outputs:{}}),/merge every pinned integration/)
  assert.equal(indexBytes(f),before)
  assert.equal(git(f.path,['rev-parse','HEAD']),f.seed)
  assert.equal(f.attempt.candidateSha,undefined)
})

test('Chief non-rework recovery retains a clean interrupted Attempt and its approved integration metadata', async t => {
  const f=await setup(t,undefined,{pool:true});await f.start('resume-clean-approved')
  const a=f.attempt(),path=join(f.directory,'clean-worktree')
  git(f.repository,['worktree','add','--detach',path,a.baseSha])
  a.workspaces.developer={id:'clean-w',kind:'worktree',status:'allocated',repository:f.repository,path}
  a.status='interrupted';a.integrationInputs=[{ref:'refs/remotes/operator/backend',sha:a.baseSha}]
  a.integrationAdmissions=[{id:'immutable-admission'}]
  const before={head:git(path,['rev-parse','HEAD']),status:git(path,['status','--porcelain']),inputs:structuredClone(a.integrationInputs),admissions:structuredClone(a.integrationAdmissions)}
  const id=await f.rt.projectDelivery.reworkPool({task:f.rt.state.tasks[f.task.id],claim:{id:'clean-resume',attemptId:a.id,botId:'p1:chief'},reason:'Operator restart completed, no code rework',force:false})
  assert.equal(id,a.id);assert.equal(a.status,'running');assert.equal(f.rt.state.tasks[f.task.id].deliveryAttemptId,a.id)
  assert.deepEqual(a.integrationInputs,before.inputs);assert.deepEqual(a.integrationAdmissions,before.admissions)
  assert.equal(git(path,['rev-parse','HEAD']),before.head);assert.equal(git(path,['status','--porcelain']),before.status)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length,1)
})

test('new Project Tasks wait for Chief admission and cannot run or lower requirements through old endpoints', async t => {
  const f = await setup(t, undefined, { modern: true })
  const proposed = await f.start('pending')
  assert.equal(proposed.waitingFor, 'chief')
  assert.equal(f.attempt(), undefined)
  await f.rt.taskBotDeleted('a', 'Source carrier was replaced')
  assert.equal(f.rt.state.tasks[f.task.id].status, 'open')
  assert.equal(f.rt.state.tasks[f.task.id].projectTask.carrierNotice.botId, 'a')
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', { taskId: f.task.id, requestId: 'bypass' }, bob), /Chief admission/)
  await assert.rejects(f.rt.taskEndpoint('task-update', { id: f.task.id, criteria: 'Skip regression tests' }, bob), /Chief confirmation/)
  await assert.rejects(f.rt.taskEndpoint('task-update', { id: f.task.id, column: 'done' }, alice), /Chief/)
  const { admitTask } = await import('../src/host/project-task-lifecycle.js')
  const row = f.rt.state.tasks[f.task.id]
  // Trusted pure decision fixture; actual Chief actor validation is covered in its callback suite.
  admitTask(row, { id: 'admit-fixture', projectId: 'p1', taskId: row.id, executorRole: 'chief', runId: 'chief-fixture', initiatedBy: alice.memberId, reason: 'Goal, impact and acceptance checked' })
  const started = await f.start('accepted')
  assert.equal(started.attempt.status, 'running')
  await assert.rejects(f.rt.projectEndpoint('project-workflow', { projectId: 'p1', operation: 'assign', workflowId: started.attempt.workflowId, taskId: row.id }, bob), /task.run|controller/)
  await complete(f)
  await assert.rejects(f.rt.projectEndpoint('project-task-accept', { attemptId: f.attempt().id }, alice), /Chief/)
})

test('changing only Project Task scope invalidates an Attempt acceptance snapshot', async t => {
  const f = await setup(t, undefined, { modern: true })
  const { admitTask, reviseTask } = await import('../src/host/project-task-lifecycle.js')
  const task = f.rt.state.tasks[f.task.id]
  const decision = { id: 'admitted', taskId: task.id, projectId: 'p1', executorRole: 'chief', runId: 'chief-fixture', initiatedBy: alice.memberId, reason: 'Explicit requirements checked' }
  admitTask(task, decision)
  await f.start('versioned-requirements')
  assert.equal(f.attempt().requirement.projectTaskRevision, 1)
  reviseTask(task, { scope: 'Also include the negative-input path' }, { ...decision, id: 'revised-scope' })
  assert.equal(task.criteria, f.attempt().requirement.criteria, 'Only scope changed; title/criteria comparisons are insufficient')
  f.rt.projectChiefControl.requireJobActor = () => {} // Isolate evidence versioning; real Chief authorization has its own callback suite.
  await assert.rejects(f.rt.projectDelivery.chiefAccept({ taskId: task.id, expectedSha: null, decision }, { ...alice, chiefJobId: 'chief-fixture' }), /requirements version/i)
  assert.notEqual(task.status, 'accepted')
  const previous = f.attempt()
  const nextId = await f.rt.projectDelivery.reworkPool({ task, claim: { id: 'rework', attemptId: previous.id, botId: 'p1:chief' }, reason: 'Implement the Chief-confirmed scope increment' })
  assert.notEqual(nextId, previous.id)
  assert.equal(f.rt.state.projectAttempts[nextId].requirement.projectTaskRevision, 2)
  assert.equal(previous.requirement.projectTaskRevision, 1, 'Old evidence retains its original requirement version')
})

test('a failed Project Attempt blocks its Task without cancelling or closing the action commitment', async t => {
  const f = await setup(t, [process.execPath, '-e', 'process.exit(9)'], { modern: true })
  const { admitTask } = await import('../src/host/project-task-lifecycle.js')
  const task = f.rt.state.tasks[f.task.id]
  admitTask(task, { id: 'admitted', taskId: task.id, projectId: 'p1', executorRole: 'chief', runId: 'chief-fixture', initiatedBy: alice.memberId, reason: 'Requirements checked' })
  await f.start('failed-attempt')
  await implement(f)
  await assert.rejects(f.gate('tester'), /tests failed/)
  assert.equal(f.attempt().status, 'failed')
  assert.equal(task.status, 'blocked')
  assert.equal(task.projectTask.block.attemptId, f.attempt().id)
  assert.equal(task.projectTask.admission.status, 'accepted')
  assert.equal(task.completedBy, undefined)
})

async function secondIntegrationSource(f) {
  git(f.repository, ['switch', '-c', 'second-input', f.base])
  writeFileSync(join(f.repository, 'code.test.mjs'), readFileSync(join(f.repository, 'code.test.mjs'), 'utf8') + '// Independent child regression coverage.\n')
  git(f.repository, ['add', 'code.test.mjs']); git(f.repository, ['commit', '-m', 'Independent test change'])
  const sha = git(f.repository, ['rev-parse', 'HEAD']), ref = 'refs/remotes/operator/second-input'
  git(f.repository, ['update-ref', ref, sha]); git(f.repository, ['switch', 'main'])
  return { sha, ref }
}

test('every pending merge head needs admission; a second unapproved head cannot hide behind the first', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false }), second = await secondIntegrationSource(f)
  const saved = (await integrationCall(f, 'query', 'attempt.integration-state', {})).result
  await integrationCall(f, 'command', 'attempt.integration-bind', { inputs: [{ ref: f.ref, sha: f.source }], generation: saved.generation, expectedWorkspace: saved.snapshot })
  git(f.path, ['merge', '--no-commit', '--no-ff', f.source, second.sha])
  const before = indexBytes(f)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task: f.task, claim: { attemptId: f.attempt.id }, role: 'developer', outputs: {} }), /not a pinned upstream or approved/)
  assert.equal(indexBytes(f), before)
  assert.equal(f.attempt.candidateSha, undefined)
})

test('an actual multi-source Git merge seals every approved parent and its exact tree', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false }), second = await secondIntegrationSource(f)
  const saved = (await integrationCall(f, 'query', 'attempt.integration-state', {})).result
  await integrationCall(f, 'command', 'attempt.integration-bind', { inputs: [{ ref: f.ref, sha: f.source }, second], generation: saved.generation, expectedWorkspace: saved.snapshot })
  git(f.path, ['merge', '--no-commit', '--no-ff', f.source, second.sha])
  await f.rt.projectDelivery.completePoolRole({ task: f.task, claim: { attemptId: f.attempt.id }, role: 'developer', outputs: {} })
  const parents = git(f.path, ['show', '-s', '--format=%P', f.attempt.candidateSha]).split(' ')
  assert.deepEqual(new Set(parents), new Set([f.seed, f.source, second.sha]))
  assert.match(readFileSync(join(f.path, 'backend.mjs'), 'utf8'), /serviceVersion/)
  assert.match(readFileSync(join(f.path, 'code.test.mjs'), 'utf8'), /Independent child/)
})

// Child acceptance records below are deterministic host fixtures. The Git merges,
// Effects persistence, permission checks and candidate sealing are actual operations.
async function childIntegrationFixture(t) {
  const f = await additionalIntegrationFixture(t, { merge: false }), second = await secondIntegrationSource(f)
  f.task.projectTaskKind = 'code'
  createTaskContract(f.task, { impact: 'Integrate independent Project improvements' })
  admitTask(f.task, { id: 'admit-parent', projectId: 'p1', taskId: f.task.id, executorRole: 'chief', runId: 'fixture-chief', initiatedBy: alice.memberId, reason: 'Fixture admission' })
  f.attempt.requirement.projectTaskRevision = f.task.projectTask.requirements.revision
  const children = [f.source, second.sha].map((sha, index) => {
    const id = `fixture-child-${index}`, decisionId = `fixture-accepted-${index}`, attemptId = `fixture-child-attempt-${index}`
    const child = { id, projectId: 'p1', projectTaskKind: 'code', title: 'Independent improvement', criteria: 'Corresponding tests pass', status: 'accepted', deliveryAttemptId: attemptId, completedBy: { kind: 'chief', decisionId } }
    createTaskContract(child, { impact: 'Independent test result' })
    f.rt.state.tasks[id] = child
    f.rt.state.projectAttempts[attemptId] = { id: attemptId, projectId: 'p1', taskId: id, status: 'accepted', acceptedViaChief: decisionId, candidateSha: sha, requirement: { repository: 'example/demo', projectTaskRevision: 1 }, evidence: {
      implementation: { sha }, tests: { sha, passed: true, sha256: 'b'.repeat(64) }, review: { sha, verdict: 'approve' },
    } }
    return child
  })
  addTaskDependencies(f.rt.state, f.task, children.map(row => row.id), { id: 'parallel-fixture', botId: f.developer.id, claimId: 'released-source', resumePoint: 'Integrate both child results' })
  f.task.projectTask.wait.status = 'resumed'
  const claim = { id: 'parent-reserved', botId: f.developer.id, attemptId: f.attempt.id, generation: f.task.collaboration.generation, status: 'active' }
  f.task.collaboration.claim = claim
  f.task.collaboration.status = 'working'
  await f.rt.save()
  return { ...f, children, claim, sources: childResultSources(f.rt.state, f.task, 'example/demo') }
}

test('a reserved parent admits only accepted child sources and seals their actual integrated tree', async t => {
  const f = await childIntegrationFixture(t), before = indexBytes(f), generation = f.claim.generation
  const admitted = await f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim)
  assert.equal(admitted.admission.origin, 'project-child-results')
  assert.equal(admitted.admission.sourcesFingerprint.length, 64)
  assert.equal(admitted.admission.childResults.length, 2)
  assert.equal(f.task.collaboration.generation, generation)
  assert.equal(indexBytes(f), before)
  assert.equal(f.attempt.candidateSha, undefined)
  for (const source of f.sources) assert.equal(git(f.repository, ['rev-parse', source.ref]), source.sha)
  assert.equal((await f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim)).already, true)
  git(f.path, ['merge', '--no-commit', '--no-ff', ...f.sources.map(row => row.sha)])
  const tree = git(f.path, ['write-tree'])
  await f.rt.projectDelivery.completePoolRole({ task: f.task, claim: f.claim, role: 'developer', outputs: { implementation: 'Both child improvements integrated' } })
  const sha = f.attempt.candidateSha
  assert.equal(git(f.path, ['rev-parse', sha + '^{tree}']), tree)
  assert.deepEqual(new Set(git(f.path, ['show', '-s', '--format=%P', sha]).split(' ')), new Set([f.seed, ...f.sources.map(row => row.sha)]))
  assert.notEqual(f.task.status, 'accepted')
})

test('child admission cannot forge configure permission or overwrite a moved source ref', async t => {
  const f = await childIntegrationFixture(t)
  await assert.rejects(integrationCall(f, 'command', 'attempt.integration-bind', { inputs: f.sources, generation: f.claim.generation, expectedWorkspace: null, origin: 'project-child-results' }, bob), /permission|access|forbidden|role|configure/i)
  const source = f.sources[0]
  git(f.repository, ['update-ref', source.ref, f.base])
  await assert.rejects(f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim), /reference moved/)
  assert.equal(git(f.repository, ['rev-parse', source.ref]), f.base)
  assert.equal(f.attempt.integrationAdmissions, undefined)
})

test('uncommitted source intent, an active writer, or revoked child evidence cannot admit parent inputs', async t => {
  const f = await childIntegrationFixture(t), originalSave = f.rt.save
  f.rt.save = async () => { throw new Error('fixture disk unavailable') }
  await assert.rejects(f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim), /disk unavailable/)
  for (const source of f.sources) assert.throws(() => git(f.repository, ['rev-parse', '--verify', source.ref]))
  f.rt.save = originalSave
  f.claim.workerId = 'still-running'
  await assert.rejects(f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim), /unstarted parent claim/)
  delete f.claim.workerId
  f.rt.state.projectAttempts[f.children[0].deliveryAttemptId].evidence.tests.passed = false
  await assert.rejects(f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim), /unverified/)
  assert.equal(f.attempt.integrationAdmissions, undefined)
})

test('a parent cannot seal skipped or subsequently invalidated child integrations', async t => {
  const f = await childIntegrationFixture(t)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task: f.task, claim: f.claim, role: 'developer', outputs: {} }), /durable source admission/)
  await f.rt.projectDelivery.admitChildInputs(f.task.id, f.claim)
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task: f.task, claim: f.claim, role: 'developer', outputs: {} }), /integration|integrat|ancestor/i)
  f.children[0].status = 'open'
  await assert.rejects(f.rt.projectDelivery.completePoolRole({ task: f.task, claim: f.claim, role: 'developer', outputs: {} }), /invalidated|unresolved|child/i)
  assert.equal(f.attempt.candidateSha, undefined)
})

test('approved custom role capabilities preserve logical identities while sealing testing and reviewing real code', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  // Explicit setup is a write; definition metadata reads do not materialize catalogs.
  await f.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', name: 'Developer' }, alice)
  const original = f.rt.projectAgents.deliveryDefinitions('p1')
  const names = { developer: 'implementer', tester: 'validator', reviewer: 'auditor' }
  // Governance approval is tested through real host APIs separately. This fixture
  // starts from an approved catalog and exercises the actual artifact controller.
  for (const [policyRole, role] of Object.entries(names)) {
    const definition = structuredClone(original.roles.find(row => row.role === policyRole))
    delete definition.memory; delete definition.resolvedSkills; delete definition.definitionRevision
    f.rt.state.projectAgentDefinitions.p1.roles.push({ ...definition, id: `p1:${role}`, role, policyRole, name: role })
  }
  ++f.rt.state.projectAgentDefinitions.p1.revision
  await f.start('custom-role-artifacts')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id]
  const prepare = async (policyRole, generation) => {
    const role = names[policyRole], definition = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === role)
    await prepareRole(f.rt, task, { id: `custom-${role}`, attemptId: attempt.id, generation }, definition)
    return role
  }
  const dev = await prepare('developer', 1)
  const workspace = attempt.workspaces[dev]
  assert.equal(workspace.role, 'implementer')
  const backup = { ...structuredClone(f.rt.state.projectAgentDefinitions.p1.roles.find(row => row.role === 'implementer')), id: 'p1:backup', role: 'backup' }
  f.rt.state.projectAgentDefinitions.p1.roles.push(backup); ++f.rt.state.projectAgentDefinitions.p1.revision
  f.rt.config.projectRepositories['example/demo'].requiredRolePolicySources = { backup: ['MISSING.md'] }
  await assert.rejects(prepareRole(f.rt, task, { id: 'bad-backup', attemptId: attempt.id, generation: 2 }, f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'backup')), /Required role policy source is missing/)
  assert.equal(attempt.roleAssignments.developer, 'implementer', 'Failed preparation cannot replace the actual artifact producer')
  assert.match(attempt.roleSessions[dev].policy.text, /Never invent passing tests/)
  writeFileSync(join(workspace.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: dev, outputs: { implementation: 'Correct addition' } })
  assert.equal(attempt.evidence.implementation.sha, attempt.candidateSha)
  const tester = await prepare('tester', 2)
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: tester, outputs: { tests: 'Request actual configured host checks' } })
  assert.equal(attempt.evidence.tests.passed, true)
  const reviewer = await prepare('reviewer', 3)
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: attempt.id }, role: reviewer, outputs: { review: JSON.stringify({ commit: attempt.candidateSha, verdict: 'approve', summary: 'Fixture candidate recommendation, not signed forge review' }) } })
  assert.equal(attempt.evidence.review.sha, attempt.candidateSha)
  assert.equal(attempt.pr.sha, attempt.candidateSha)
  assert.deepEqual(attempt.roleAssignments, names)
  assert.equal(attempt.evidence.implementation.logicalRole, dev)
  assert.equal(attempt.evidence.tests.logicalRole, tester)
  assert.equal(attempt.evidence.review.logicalRole, reviewer)
  for (const role of Object.values(names)) assert.equal(attempt.roleSessions[role].logicalSessionId, Object.values(f.rt.state.projectTaskSessions).find(row => row.role === role).id)
})


test('Task execution selects an associated repository and retains it after the Project default changes', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.rt.projectLifecycle.endpoint('project-repository-link', { projectId: 'p1', repository: 'example/second', defaultBranch: 'main' }, alice)
  const second = join(f.directory, 'second-repo')
  git(f.directory, ['clone', f.repository, second])
  f.rt.config.projectRepositories['example/second'] = { ...f.rt.config.projectRepositories['example/demo'], path: second }
  const started = await f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'other-repo', repository: 'example/second' }, bob)
  assert.equal(started.attempt.requirement.repository, 'example/second')
  f.rt.state.projects.p1.repository = 'unprovisioned/changed-default'
  const attempt = f.rt.state.projectAttempts[started.attempt.id]
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r => r.role === 'developer')
  await prepareRole(f.rt, f.task, { id: 'repo-dev', attemptId: attempt.id, generation: 1 }, dev)
  assert.equal(attempt.repositoryBinding.repository, 'example/second')
  assert.equal(attempt.workspaces.developer.repository, second)
  const association = Object.values(f.rt.state.projectRepositories).find(row => row.repository === 'example/second')
  delete f.rt.state.projectRepositories[association.id]
  await assert.rejects(prepareRole(f.rt, f.task, { id: 'revoked-repo', attemptId: attempt.id, generation: 2 }, dev), /not currently associated/)
  assert.equal(attempt.requirement.repository, 'example/second')
})

test('a repository-free decision Task prepares a scoped workspace and records verifiable outputs', async t => {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  f.rt.state.projects.p1.repository = null
  f.task.projectTaskKind = 'decision'
  const started = await f.start('decision-no-repo')
  assert.equal(started.attempt.status, 'running')
  const attempt = f.rt.state.projectAttempts[started.attempt.id]
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(r => r.role === 'developer')
  const spec = await prepareRole(f.rt, f.task, { id: 'decision-dev', attemptId: attempt.id, generation: 1 }, dev)
  assert.equal(attempt.baseSha, undefined)
  assert.equal(attempt.workspaces.developer.kind, 'decision-directory')
  assert.match(spec.prompt, /no repository/i)
  await f.rt.projectDelivery.completePoolRole({ task: f.task, claim: { attemptId: attempt.id }, role: 'developer', outputs: { decision: 'Adopt the documented architecture with tradeoffs' } })
  assert.ok(attempt.evidence.developer.sha256)
  assert.equal(attempt.candidateSha, undefined)
  f.rt.projectChiefControl.requireJobActor = () => {} // Chief identity validation is exercised by its own callback regressions.
  f.rt.projectInputs.requireHandled = () => {} // Isolate decision-output acceptance from the input receipt suite.
  f.rt.projectInputs.commitChief = () => {}
  await f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: null, decision: { id: 'decision-accepted', reason: 'The recorded tradeoffs satisfy the requirements' } }, { ...alice, chiefJobId: 'fixture-chief' })
  assert.equal(attempt.status, 'accepted')
  assert.equal(f.task.completedBy.decisionId, 'decision-accepted')
})


test('sealed Attempt logs are bounded UTF-8 pages with exact hash and stale-cursor refusal', async t => {
  const f = await setup(t)
  await f.start('paged-log')
  const a = f.attempt(), text = '日志😀\n'.repeat(20000), path = join(f.home, 'large-sealed.log')
  writeFileSync(path, text)
  a.evidence.tests = { log: path, sha256: createHash('sha256').update(text).digest('hex'), sha: 'a'.repeat(40) }
  const first = await f.rt.projectEndpoint('project-attempt-log', { attemptId: a.id, limit: 64 }, alice)
  assert.ok(Buffer.byteLength(first.text) <= 64)
  assert.equal(first.text.includes('\uFFFD'), false)
  assert.ok(first.nextOffset > 0)
  const next = await f.rt.projectEndpoint('project-attempt-log', { attemptId: a.id, offset: first.nextOffset, limit: 64, expectedSha256: first.sha256 }, alice)
  assert.equal(next.offset, first.nextOffset)
  await assert.rejects(f.rt.projectEndpoint('project-attempt-log', { attemptId: a.id, expectedSha256: '0'.repeat(64) }, alice), /changed|stale/)
  writeFileSync(path, text + 'tampered')
  await assert.rejects(f.rt.projectEndpoint('project-attempt-log', { attemptId: a.id }, alice), /changed|stale/)
})


test('Release Task closes only after explicit durable authorization and current provider evidence', async t => {
  const f = await setup(t, undefined, { pool: true, modern: true })
  const task = f.rt.state.tasks[f.task.id]
  task.projectTaskKind = 'release'
  const decision = { id: 'release-admit', taskId: f.task.id, projectId: 'p1', executorRole: 'chief', runId: 'fixture-chief', initiatedBy: alice.memberId, reason: 'Release target and requirements checked' }
  admitTask(task, decision)
  f.rt.config.projectRepositories['example/demo'].release = { provider: 'github', enabled: true }
  let proof, posts = 0
  const provider = { inspect: async () => proof, publish: async spec => { posts++; proof = { provider: 'github', repository: spec.repository, tag: spec.tag, sha: spec.sha, releaseId: 7, publishedAt: '2026-11-03T00:00:00Z', marker: true } } }
  f.rt.projectDelivery = createProjectDelivery(f.rt, { publisher: f.publisher, releaseProvider: provider })
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  await f.start('release-task')
  const a = f.attempt()
  const dev = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'release-dev', attemptId: a.id, generation: 1 }, dev)
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: a.id }, role: 'developer', outputs: { releasePlan: 'Publish the explicitly authorized base commit' } })
  const envelope = { version: 'project-development/v1', kind: 'command', projectId: 'p1', name: 'release.request', requestId: 'publish-release', payload: { attemptId: a.id, tag: 'v1.0.0', sha: a.baseSha, mode: 'publish' } }
  await assert.rejects(f.rt.projectEndpoint('project-development', envelope, bob), /denied/i)
  const requested = await f.rt.projectEndpoint('project-development', envelope, alice)
  assert.ok(requested.result.release.id)
  await f.rt.projectEffects.drain()
  assert.equal(posts, 1)
  const observed = await f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', projectId: 'p1', name: 'release.status', payload: { attemptId: a.id } }, bob)
  assert.equal(observed.result.release.status, 'observed')
  assert.notEqual(task.status, 'accepted')
  f.rt.projectChiefControl.requireJobActor = () => {} // Isolate artifact closure from independently covered Chief identity callbacks.
  f.rt.projectInputs.requireHandled = () => {}; f.rt.projectInputs.commitChief = () => {}
  await f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: null, decision: { id: 'release-close', reason: 'Published tag resolves to the authorized commit' } }, { ...alice, chiefJobId: 'fixture-chief' })
  assert.equal(task.status, 'accepted')
  assert.equal(a.acceptedViaChief, 'release-close')
  assert.equal(posts, 1)
})

test('publication recovery pins the original App identity and preserves evidence after connection changes', async t => {
  const f = await setup(t); await f.start('app-fence'); await complete(f)
  const attempt = f.attempt(), original = { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: '/never-read.pem' }
  attempt.publicationCredential = githubCredentialBinding(original, 'example/demo')
  f.rt.config.projectRepositories['example/demo'].github = { ...original, installationId: 99 }
  f.rt.projectDelivery = createProjectDelivery(f.rt)
  const count = f.published.length
  await assert.rejects(f.rt.projectEffects.perform({ kind: 'github.publish', key: 'connection-change-probe', projectId: 'p1', taskId: f.task.id, payload: { attemptId: attempt.id, candidateSha: attempt.candidateSha, initiatedBy: 'owner-1' } }), /connection changed/)
  assert.equal(f.published.length, count); assert.equal(attempt.evidence.tests.passed, true); assert.equal(attempt.pr.sha, attempt.candidateSha)
})

test('publication revalidates operator repository capability before any provider operation', async t => {
  const f = await setup(t); await f.start('app-repository-fence'); await complete(f)
  const attempt = f.attempt()
  f.rt.config.projectRepositories['example/demo'].allowedProjectOwnerIds = []
  f.rt.projectDelivery = createProjectDelivery(f.rt)
  await assert.rejects(f.rt.projectEffects.perform({ kind: 'github.publish', key: 'repository-revoked-probe', projectId: 'p1', taskId: f.task.id, payload: { attemptId: attempt.id, candidateSha: attempt.candidateSha, initiatedBy: 'owner-1' } }), /not provisioned/)
  assert.equal(attempt.evidence.tests.passed, true); assert.equal(f.published.length, 1)
})

async function baselineResourceFixture(t, kind = 'local') {
  const f = await setup(t, undefined, { pool: true })
  f.rt.projectScheduler.wake = () => Promise.resolve(); f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  const resourceRoot = join(f.directory, 'resource'); mkdirSync(resourceRoot)
  f.rt.config.projectResources = { baseline: { type: kind, root: resourceRoot, ...(kind === 'docker' ? { container: 'isolated-fixture', user: '1000:1000' } : {}), capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(f.directory, 'sdk-home'), configDir: join(f.directory, 'sdk-config'), model: 'fixture/model' } } } } }
  f.rt.state.projectResourceHealth = { baseline: { status: 'ready' } }; f.rt.state.projectHarnessHealth = { 'p1:baseline:codex': { status: 'ready', profile: harnessProfile(f.rt.config.projectResources['baseline'], f.rt.readProject('p1'), 'baseline', 'codex').profile } }
  if (kind === 'docker') {
    // Real Git and bundle verification, emulated transport; actual Docker acceptance is separate.
    f.rt.projectResources.command = async (_p, _r, { argv, cwd }) => ({ stdout: execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })
    f.rt.projectResources.uploadFile = async (_p, _r, source, target) => copyFileSync(source, target)
  }
  await f.rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role: 'developer', execution: { harness: 'codex', resourceIds: ['baseline'] } }, alice)
  await f.start('baseline-recovery')
  const previous = f.attempt(), task = f.rt.state.tasks[f.task.id], definition = f.rt.projectAgents.deliveryDefinitions('p1').roles.find(row => row.role === 'developer')
  await prepareRole(f.rt, task, { id: 'first-baseline', attemptId: previous.id, generation: 1 }, definition)
  const workspace = previous.workspaces.developer, lease = previous.resourceLeases.developer
  await f.rt.projectResources.release(lease.id, lease.generation); previous.status = 'interrupted'
  task.collaboration.claim.status = 'failed'; task.collaboration.status = 'blocked'
  writeFileSync(join(f.repository, 'host-repair.txt'), 'Updated trusted baseline\n'); git(f.repository, ['add', 'host-repair.txt']); git(f.repository, ['commit', '-m', 'Advance trusted base'])
  const latest = git(f.repository, ['rev-parse', 'HEAD'])
  const recover = async () => {
    const id = await f.rt.projectDelivery.reworkPool({ task, claim: { id: 'baseline-rework', attemptId: previous.id, botId: 'p1:chief' }, reason: 'Use repaired baseline', force: true })
    return { next: f.rt.state.projectAttempts[id], prepare: () => prepareRole(f.rt, task, { id: 'next-baseline', attemptId: id, generation: 2 }, definition) }
  }
  return { ...f, previous, task, definition, workspace, latest, recover }
}
for (const kind of ['local', 'docker']) test(kind + ' recovery materializes the new baseline in the actual reused SDK checkout', async t => {
  const f = await baselineResourceFixture(t, kind), { next, prepare } = await f.recover()
  assert.equal(next.baseSha, f.latest)
  await prepare()
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), f.latest)
  assert.equal(readFileSync(join(next.workspaces.developer.path, 'host-repair.txt'), 'utf8'), 'Updated trusted baseline\n')
  assert.equal(next.workspaces.developer.path, f.workspace.path)
  assert.equal(next.workspaces.developer.materialization.expectedCheckout, f.latest)
  assert.equal(next.workspaces.developer.materialization.actualCheckout, f.latest)
})
test('a changed baseline cannot overwrite a retained unsealed SDK draft', async t => {
  const f = await baselineResourceFixture(t)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  const { next, prepare } = await f.recover()
  await assert.rejects(prepare(), error => error.code === 'bot/workspace-baseline' && error.details?.recovery === 'preserve-draft-and-admit-input')
  assert.equal(readFileSync(join(f.workspace.path, 'code.mjs'), 'utf8'), 'export const preservedDraft = true;\n')
  assert.equal(next.candidateSha, undefined)
})

test('an explicitly admitted updated baseline preserves a dirty SDK draft for real integration', async t => {
  const f = await baselineResourceFixture(t)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  const ref = 'refs/remotes/operator/repaired-base'; git(f.repository, ['update-ref', ref, f.latest])
  const { next, prepare } = await f.recover()
  const state = await f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', name: 'attempt.integration-state', projectId: 'p1', payload: { attemptId: next.id } }, alice)
  assert(state.result.availableInputs.some(row => row.sha === f.latest && row.ref === ref))
  await f.rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'command', name: 'attempt.integration-bind', projectId: 'p1', requestId: 'retain-and-integrate-base', payload: { attemptId: next.id, generation: state.result.generation, expectedWorkspace: null, inputs: [{ ref, sha: f.latest }] } }, alice)
  await prepare()
  assert.equal(readFileSync(join(next.workspaces.developer.path, 'code.mjs'), 'utf8'), 'export const preservedDraft = true;\n')
  assert.equal(next.workspaces.developer.materialization.retainedDraft, true)
  assert.notEqual(next.workspaces.developer.materialization.actualCheckout, next.baseSha)
  assert.equal(next.integrationInputs[0].sha, f.latest)
})

test('inspect-only approved PR input is available without becoming a required merge or candidate parent', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false })
  const snapshot = (await integrationCall(f, 'query', 'attempt.integration-state', {})).result
  await integrationCall(f, 'command', 'attempt.integration-bind', { inputs: [{ ref: f.ref, sha: f.source, purpose: 'inspect' }], generation: snapshot.generation, expectedWorkspace: snapshot.snapshot }, alice, 'inspect-pr-only')
  writeFileSync(join(f.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  await f.rt.projectDelivery.completePoolRole({ task: f.task, claim: { attemptId: f.attempt.id }, role: 'developer', outputs: {} })
  assert.equal(f.attempt.evidence.approvedIntegrations, undefined)
  assert.notEqual(f.attempt.candidateSha, f.source)
  assert.throws(() => git(f.repository, ['merge-base', '--is-ancestor', f.source, f.attempt.candidateSha]))
})

test('actual Chief route admits a pinned inspect input and Dev receives the PR object on the resource', async t => {
  const f = await baselineResourceFixture(t, 'docker'), attempt = f.previous, task = f.task
  attempt.status = 'running'
  const head = git(f.repository, ['rev-parse', 'HEAD'])
  writeFileSync(join(f.repository, 'pr-input.txt'), 'A PR commit outside the pinned base\n'); git(f.repository, ['add', 'pr-input.txt']); git(f.repository, ['commit', '-m', 'Independent PR input'])
  const sha = git(f.repository, ['rev-parse', 'HEAD']), ref = 'refs/remotes/operator/pr-2'
  git(f.repository, ['update-ref', ref, sha]); git(f.repository, ['reset', '--hard', head])
  assert.throws(() => git(f.workspace.path, ['cat-file', '-e', sha]))
  const carrier = { id: 'public-p1', projectId: 'p1', visibility: 'public', botId: 'a', sessionId: 'a', carrierGeneration: 1 }
  f.rt.state.projectAgents ??= {}; f.rt.state.projectAgents['public-p1'] = carrier
  f.rt.state.projectChiefPolicies = { p1: { enabled: true, authorityMemberId: alice.memberId, revision: 1, inspection: { thresholds: { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }, prompt: 'Inspect' } } }
  let chief
  f.rt.projectAgents.startChiefJob = async args => { chief = args; return 'deterministic-chief' }
  f.rt.projectPools.connect({ validate: () => ({ ok: true }), rework: args => f.rt.projectDelivery.reworkPool(args) })
  const run = await f.rt.projectChiefControl.request('p1', 'inspection', { requestId: 'recover-pr-input' })
  await f.rt.projectChiefControl.pump()
  for (let pass = 0; pass < 200 && !chief; ++pass) await new Promise(resolve => setTimeout(resolve, 5))
  const facts = chief.projectFacts.tasks.find(row => row.taskId === task.id)
  assert(facts.repositoryRecovery.availableInputs.some(row => row.sha === sha))
  await assert.rejects(f.rt.projectDelivery.admitChiefInputs(task.id, [{ ref, sha }], alice, facts), /Chief job authority/)
  await assert.rejects(f.rt.projectDelivery.admitChiefInputs(task.id, [{ ref: 'refs/remotes/operator/foreign', sha }], chief.actor, facts), /outside the approved snapshot/)
  await assert.rejects(f.rt.projectDelivery.admitChiefInputs(task.id, [{ ref, sha }], chief.actor, { ...facts, generation: facts.generation - 1 }), /generation changed/)
  assert.equal(attempt.integrationInputs, undefined)
  await chief.onResult({ ok: true, text: JSON.stringify({ summary: 'Inspect the requested PR', decisions: [{ taskId: task.id, action: 'route', targetBotId: 'p1:developer', reason: 'The PR object is approved; inspect it', repositoryInputs: [{ ref, sha, purpose: 'inspect' }] }] }), executionEvidence: { kind: 'native-chief', chiefRunId: run.id, carrierGeneration: carrier.carrierGeneration, botId: carrier.botId, sessionId: carrier.sessionId } })
  assert.equal(run.status, 'done', run.failure)
  assert.equal(attempt.integrationInputs[0].purpose, 'inspect')
  assert.equal(task.collaboration.botId, 'p1:developer')
  await prepareRole(f.rt, task, { id: 'inspect-after-chief', attemptId: attempt.id, generation: task.collaboration.generation }, f.definition)
  assert.equal(git(attempt.workspaces.developer.path, ['cat-file', '-t', sha]), 'commit')
  assert.equal(git(attempt.workspaces.developer.path, ['rev-parse', 'HEAD']), attempt.baseSha)
  assert.equal(attempt.candidateSha, undefined)
})


async function chiefBaselineFixture(t, kind = 'local', prepare) {
  const f = await baselineResourceFixture(t, kind)
  f.previous.seedSha = f.previous.baseSha
  if (prepare) await prepare(f)
  const carrier = { id: 'public-p1', projectId: 'p1', visibility: 'public', botId: 'a', sessionId: 'a', carrierGeneration: 1 }
  f.rt.state.projectAgents ??= {}; f.rt.state.projectAgents[carrier.id] = carrier
  f.rt.state.projectChiefPolicies = { p1: { enabled: true, authorityMemberId: alice.memberId, revision: 1, inspection: { correctionBudget: 1, thresholds: { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }, prompt: 'Inspect' } } }
  let chief
  f.rt.projectAgents.startChiefJob = async args => { chief = args; return 'deterministic-chief' }
  const run = await f.rt.projectChiefControl.request('p1', f.task.collaboration.status === 'arbitration' ? 'arbitration' : 'inspection', { requestId: 'choose-baseline' }, f.task.id)
  await f.rt.projectChiefControl.pump()
  for (let pass = 0; pass < 200 && !chief; ++pass) await new Promise(resolve => setTimeout(resolve, 5))
  assert(chief)
  const facts = chief.projectFacts.tasks.find(row => row.taskId === f.task.id)
  const respond = decision => chief.onResult({ ok: true, text: JSON.stringify({ summary: 'Choose the verified baseline', decisions: [decision] }), executionEvidence: { kind: 'native-chief', chiefRunId: run.id, carrierGeneration: carrier.carrierGeneration, botId: carrier.botId, sessionId: carrier.sessionId } })
  return { ...f, chief, run, facts, respond }
}
for (const mode of ['latest', 'continue']) test('Chief explicitly chooses ' + mode + ' and the actual resource checkout matches', async t => {
  const f = await chiefBaselineFixture(t, 'docker'), options = f.facts.repositoryRecovery.continuationOptions
  assert(options, 'Chief needs the existing continuation snapshot instead of guessing the baseline')
  assert.equal(options.latestBaseSha, f.latest)
  const continuation = { mode, previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, ...(mode === 'latest' ? { expectedBaseSha: options.latestBaseSha } : {}) }
  await f.respond({ taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'Explicit baseline judgement', continuation })
  assert.equal(f.run.status, 'done', f.run.failure)
  const next = f.rt.state.projectAttempts[f.task.deliveryAttemptId]
  assert.notEqual(next.id, f.previous.id)
  assert.equal(next.continuation.mode, mode)
  assert.equal(next.continuation.previousAttemptId, f.previous.id)
  assert.equal(f.task.collaboration.botId, 'p1:developer')
  assert.equal(f.previous.status, 'interrupted')
  await prepareRole(f.rt, f.task, { id: 'chief-baseline-prepare', attemptId: next.id, generation: f.task.collaboration.generation }, f.definition)
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), mode === 'latest' ? f.latest : f.previous.seedSha)
  assert.equal(next.workspaces.developer.materialization.actualCheckout, mode === 'latest' ? f.latest : f.previous.seedSha)
  assert.equal(next.evidence.tests, undefined)
})

for (const mutation of ['old-head', 'bad-workspace', 'bad-generation', 'wrong-attempt', 'unknown-mode', 'wrong-role', 'wrong-action', 'mixed-inputs', 'host-advanced', 'workspace-changed']) test('Chief baseline rejects ' + mutation + ' through bounded correction without creating an Attempt', async t => {
  const f = await chiefBaselineFixture(t), options = f.facts.repositoryRecovery.continuationOptions
  const decision = { taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'Select a baseline', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } }
  if (mutation === 'old-head') decision.continuation.expectedBaseSha = f.previous.baseSha
  if (mutation === 'bad-workspace') decision.continuation.expectedWorkspace = null
  if (mutation === 'bad-generation') --decision.continuation.generation
  if (mutation === 'wrong-attempt') decision.continuation.previousAttemptId = 'foreign-attempt'
  if (mutation === 'unknown-mode') decision.continuation.mode = 'reset'
  if (mutation === 'wrong-role') decision.targetBotId = 'p1:reviewer'
  if (mutation === 'wrong-action') decision.action = 'continue'
  if (mutation === 'mixed-inputs') decision.repositoryInputs = []
  if (mutation === 'host-advanced') { writeFileSync(join(f.repository, 'another.txt'), 'Advance after snapshot'); git(f.repository, ['add', '.']); git(f.repository, ['commit', '-m', 'Advance after snapshot']) }
  if (mutation === 'workspace-changed') writeFileSync(join(f.workspace.path, 'draft.txt'), 'Draft after snapshot')
  const count = Object.keys(f.rt.state.projectAttempts).length
  await f.respond(decision)
  assert.equal(f.run.status, 'correction-pending', f.run.failure)
  assert.equal(f.task.deliveryAttemptId, f.previous.id)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, count)
  assert.equal(git(f.workspace.path, ['rev-parse', 'HEAD']), f.previous.seedSha)
})

test('Chief latest preserves a dirty draft and the ordinary checkout guard refuses silent reset', async t => {
  const f = await chiefBaselineFixture(t, 'local', f => writeFileSync(join(f.workspace.path, 'draft.txt'), 'Keep this work'))
  const options = f.facts.repositoryRecovery.continuationOptions
  assert.equal(options.retainedDraft, true)
  await f.respond({ taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'Choose latest without losing the retained draft', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } })
  assert.equal(f.run.status, 'done', f.run.failure)
  const next = f.rt.state.projectAttempts[f.task.deliveryAttemptId]
  await assert.rejects(prepareRole(f.rt, f.task, { id: 'dirty-latest', attemptId: next.id, generation: f.task.collaboration.generation }, f.definition), error => error.code === 'bot/workspace-baseline')
  assert.equal(readFileSync(join(f.workspace.path, 'draft.txt'), 'utf8'), 'Keep this work')
  assert.equal(git(f.workspace.path, ['rev-parse', 'HEAD']), f.previous.seedSha)
})

test('Chief arbitration can use existing successor admission without mistaking its own claim for a live Developer', async t => {
  const f = await chiefBaselineFixture(t, 'local', f => {
    const c = f.task.collaboration
    delete c.claim; c.status = 'arbitration'; c.botId = 'p1:chief'
    c.history.push({ id: 'chief-baseline-handoff', status: 'pending', from: 'p1:developer', to: 'p1:chief', attemptId: f.previous.id, purpose: 'arbitrate', reason: 'Baseline selection needed', generation: c.generation })
    c.currentHandoffId = 'chief-baseline-handoff'
  })
  const options = f.facts.repositoryRecovery.continuationOptions, claim = structuredClone(f.task.collaboration.claim)
  assert.equal(claim.status, 'active'); assert.equal(claim.chiefRunId, f.run.id)
  await f.respond({ taskId: f.task.id, action: 'route', targetBotId: 'p1:developer', reason: 'Use current observed base', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } })
  assert.equal(f.run.status, 'done', f.run.failure)
  assert.equal(f.task.collaboration.status, 'queued')
  const handoff = f.task.collaboration.history.at(-1)
  assert.equal(handoff.from, 'p1:chief')
  assert.equal(handoff.sourceExecution.id, claim.id)
  assert.equal(handoff.sourceExecution.chiefRunId, f.run.id)
  assert.notEqual(f.task.deliveryAttemptId, f.previous.id)
})

test('Chief baseline options retain unavailable execution and permission boundaries', async t => {
  const f = await baselineResourceFixture(t)
  assert.equal((await f.rt.projectDelivery.recoveryFacts(f.task, bob)).continuationOptions.status, 'unavailable')
  f.task.collaboration.claim.status = 'active'
  const facts = await f.rt.projectDelivery.recoveryFacts(f.task, alice)
  assert.equal(facts.continuationOptions.status, 'unavailable')
  assert.equal(facts.baseSha, f.previous.baseSha)
  assert(facts.executionCheckpoint.blockers.some(row => row.kind === 'claim-active'))
  f.previous.status = 'running'
  assert.equal((await f.rt.projectDelivery.recoveryFacts(f.task, alice)).continuationOptions, null)
})

test('Chief latest keeps an existing PR seed even when its requested base is newer', async t => {
  const f = await chiefBaselineFixture(t, 'local', f => { f.previous.publicationBinding = { number: 7, repository: 'example/demo', branch: 'existing-pr', previousSha: f.previous.seedSha } })
  const options = f.facts.repositoryRecovery.continuationOptions
  await f.respond({ taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'Retain published ancestry while selecting updated upstream', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } })
  assert.equal(f.run.status, 'done', f.run.failure)
  const next = f.rt.state.projectAttempts[f.task.deliveryAttemptId]
  assert.equal(next.baseSha, f.latest)
  assert.equal(next.seedSha, f.previous.seedSha)
  assert.equal(next.publicationBinding.number, 7)
  await prepareRole(f.rt, f.task, { id: 'bound-pr-latest', attemptId: next.id, generation: f.task.collaboration.generation }, f.definition)
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), f.previous.seedSha)
})

for (const status of ['interrupted', 'running']) test(status + ' Chief continuation refuses an unconfirmed durable save without creating a successor', async t => {
  const f = await chiefBaselineFixture(t, 'local', f => { f.previous.status = status }), options = f.facts.repositoryRecovery.continuationOptions
  const count = Object.keys(f.rt.state.projectAttempts).length, save = f.rt.save
  f.rt.save = async () => {}
  await f.respond({ taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'Choose observed latest', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } })
  f.rt.save = save
  assert.equal(f.run.status, 'partial')
  assert.match(f.run.decisionFailures[0].message, /commit was not confirmed/)
  assert.equal(f.previous.status, status)
  assert.equal(f.previous.supersededBy, undefined)
  assert.equal(f.task.deliveryAttemptId, f.previous.id)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, count)
  assert.equal(git(f.workspace.path, ['rev-parse', 'HEAD']), f.previous.seedSha)
})

test('Chief chooses latest for an exited but still running blocked Attempt without cancelling it', async t => {
  const f = await chiefBaselineFixture(t, 'local', f => { f.previous.status = 'running' })
  const options = f.facts.repositoryRecovery.continuationOptions
  assert(options, 'An idle blocked Attempt also needs an explicit baseline choice')
  await f.respond({ taskId: f.task.id, action: 'return', targetBotId: 'p1:developer', reason: 'The old execution exited; use the updated base', continuation: { mode: 'latest', previousAttemptId: options.attemptId, generation: options.generation, expectedWorkspace: options.snapshot, expectedBaseSha: options.latestBaseSha } })
  assert.equal(f.run.status, 'done', f.run.failure)
  const next = f.rt.state.projectAttempts[f.task.deliveryAttemptId]
  assert.equal(f.previous.status, 'returned')
  assert.equal(f.previous.supersededBy, next.id)
  assert.equal(f.previous.cancelRequested, undefined)
  assert.equal(f.rt.projectEffects.intentCommitted(next.continuation.effect), true)
  await prepareRole(f.rt, f.task, { id: 'idle-running-latest', attemptId: next.id, generation: f.task.collaboration.generation }, f.definition)
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), f.latest)
})

test('public continuation cannot supersede running work or forge current Chief authority', async t => {
  const f = await baselineResourceFixture(t)
  f.previous.status = 'running'
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { projectId: 'p1', attemptId: f.previous.id }, alice)
  const body = { taskId: f.task.id, requestId: 'forged-chief-choice', continuation: { mode: 'latest', previousAttemptId: facts.attemptId, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', body, alice), /active Attempt/)
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', body, { ...alice, chiefJobId: 'invented-run' }), /Chief job authority/)
  assert.equal(f.task.deliveryAttemptId, f.previous.id)
  assert.equal(f.previous.status, 'running')
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
})

test('a newly created unsealed successor after failure pins current host HEAD even for non-forced routing', async t => {
  const f = await baselineResourceFixture(t)
  f.previous.status = 'failed'
  const id = await f.rt.projectDelivery.reworkPool({ task: f.task, claim: { id: 'failed-route', attemptId: f.previous.id, botId: 'p1:chief' }, reason: 'Host repair is complete; route back', force: false })
  const next = f.rt.state.projectAttempts[id]
  assert.notEqual(id, f.previous.id); assert.equal(next.baseSha, f.latest)
  await prepareRole(f.rt, f.task, { id: 'failed-route-prepare', attemptId: id, generation: 2 }, f.definition)
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), f.latest)
})

for (const role of ['tester', 'reviewer']) test('interrupted sealed candidate resumes ' + role + ' in the same Attempt only with current evidence', async t => {
  const f = await setup(t); await f.start('resume-' + role); await implement(f)
  if (role === 'reviewer') await f.gate('tester')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id], sha = attempt.candidateSha, oldRun = attempt.runId
  task.collaboration = { kind: 'code', attemptId: attempt.id, generation: 3 }; attempt.status = 'interrupted'
  const target = { id: 'p1:' + role, role }
  await f.rt.projectDelivery.validateRecovery({ task, target })
  await f.rt.projectDelivery.resumeVerification({ task, target, decisionId: 'recovery-decision', reason: 'Continue verification of the original sealed candidate' })
  assert.equal(attempt.status, 'running'); assert.equal(attempt.candidateSha, sha); assert.equal(task.deliveryAttemptId, attempt.id)
  assert.notEqual(attempt.runId, oldRun); assert.equal(attempt.resumptions.length, 1)
  await f.rt.projectDelivery.resumeVerification({ task, target, decisionId: 'recovery-decision', reason: 'Duplicate delivery' })
  assert.equal(attempt.resumptions.length, 1); assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  assert.equal(git(attempt.workspaces.developer.path, ['rev-parse', 'HEAD']), sha)
})

test('verification recovery preflight rejects unsealed/stale candidates and Reviewer without tests before routing effects', async t => {
  const f = await setup(t); await f.start('recovery-gates')
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id], target = { id: 'p1:reviewer', role: 'reviewer' }
  task.collaboration = { kind: 'code', attemptId: attempt.id, generation: 3 }
  await assert.rejects(f.rt.projectDelivery.validateRecovery({ task, target }), error => error.code === 'bot/chief-protocol' && error.recovery.kind === 'unsupported-route')
  assert.equal(task.collaboration.generation, 3)
  await implement(f); attempt.status = 'interrupted'
  await assert.rejects(f.rt.projectDelivery.validateRecovery({ task, target }), /passing host tests/)
  await f.rt.projectDelivery.validateRecovery({ task, target: { id: 'p1:tester', role: 'tester' } })
  attempt.status = 'running'; await f.gate('tester'); attempt.status = 'interrupted'
  await f.rt.projectDelivery.validateRecovery({ task, target })
  writeFileSync(attempt.evidence.tests.log, 'changed test evidence')
  await assert.rejects(f.rt.projectDelivery.validateRecovery({ task, target }), /unchanged matching host test log/)
  writeFileSync(join(attempt.workspaces.developer.path, 'code.mjs'), '// unverified mutation')
  await assert.rejects(f.rt.projectDelivery.validateRecovery({ task, target: { id: 'p1:tester', role: 'tester' } }), /unchanged clean sealed candidate/)
  assert.equal(attempt.status, 'interrupted'); assert.equal(task.collaboration.generation, 3)
})

test('unknown SDK or native allocation exit cannot be bypassed by choosing another verification role', async t => {
  const f = await setup(t); await f.start('unknown-verification-exit'); await implement(f)
  const attempt = f.attempt(), task = f.rt.state.tasks[f.task.id]
  task.collaboration = { kind: 'code', attemptId: attempt.id, generation: 3 }; attempt.status = 'interrupted'
  f.rt.state.projectHarnessWorkers ??= {}
  f.rt.state.projectHarnessWorkers.unknown = { id: 'unknown', attemptId: attempt.id, status: 'unreachable' }
  await assert.rejects(f.rt.projectDelivery.resumeVerification({ task, target: { id: 'p1:tester', role: 'tester' }, decisionId: 'unknown', reason: 'Cannot bypass unknown exit' }), error => error.code === 'bot/chief-recovery' && error.recovery.kind === 'worker-exit-unknown')
  assert.equal(attempt.status, 'interrupted'); assert.equal(attempt.resumptions, undefined)
})

test('Reviewer approve automatically commits a host merge intent after the exact candidate publication', async t => {
  const f = await setup(t)
  f.rt.config.projectRepositories['example/demo'].mergePolicy = { enabled: true, branches: ['main'], method: 'squash', requiredChecks: [] }
  await f.start('reviewed-merge-admission'); await complete(f)
  const attempt = f.attempt(), effect = Object.values(f.rt.state.projectEffects).find(row => row.kind === 'github.merge')
  assert.ok(effect, 'Approved publication must automatically enter the existing host merge Effect flow')
  assert.equal(effect.payload.candidateSha, attempt.candidateSha)
  assert.equal(effect.payload.intent.number, attempt.pr.number)
  assert.equal(effect.payload.intent.repository, 'example/demo')
  assert.equal(effect.payload.intent.candidateSha, attempt.evidence.review.sha)
  assert.equal(attempt.status, 'waiting-acceptance'); assert.notEqual(f.rt.state.tasks[f.task.id].status, 'accepted')
  assert.equal(attempt.evidence.review.report.repositoryVerdict, 'INC', 'Host merge authorization must not fabricate a signed forge Review PASS')
})

test('role App delivery adopts the actual SDK commit and existing Draft before tests instead of resealing another SHA', async t => {
  const f = await setup(t)
  await f.start('sdk-commit-adoption')
  const attempt = f.attempt(), workspace = attempt.workspaces.developer
  f.rt.config.projectGithubConnections = { dev: { credential: 'github-app', appId: 7, installationId: 70, projectIds: ['p1'], repositories: ['example/demo'] } }
  f.rt.config.projectRepositories['example/demo'].roleGithub = { enabled: true, revision: 1, branches: ['main'], roles: { developer: { connectionId: 'dev' } } }
  let observations = 0
  f.rt.projectDelivery = createProjectDelivery(f.rt, { publisher: f.publisher, roleArtifacts: { publication: async (_attempt, { sha }) => { observations++; return { number: 18, sha, repository: 'example/demo', url: 'https://github.com/example/demo/pull/18', identity: { provider: 'github-app', appId: 7, login: 'dev-app[bot]' } } }, review: async current => ({ id: 25, sha: current.candidateSha, identity: { provider: 'github-app', appId: 8, login: 'review-app[bot]' }, independent: true }) } })
  writeFileSync(join(workspace.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  git(workspace.path, ['add', '.']); git(workspace.path, ['commit', '-m', 'SDK-authored candidate retained verbatim'])
  const candidate = git(workspace.path, ['rev-parse', 'HEAD'])
  await f.gate('developer')
  assert.equal(attempt.candidateSha, candidate)
  assert.equal(attempt.pr.number, 18)
  assert.equal(attempt.sdkPublication.sha, candidate)
  assert.equal(f.rt.state.projectEffects[attempt.sdkCandidateEffect.id].status, 'done')
  assert.equal(attempt.evidence.tests, undefined, 'Early Draft is not tested or reviewed delivery')
  assert.equal(f.published.length, 0, 'The host does not create another PR')
  assert.equal(observations, 1)
  await f.gate('developer'); assert.equal(observations, 1)
  await f.gate('tester'); assert.equal(attempt.evidence.tests.sha, candidate)
  await f.gate('reviewer', { review: JSON.stringify({ commit: candidate, verdict: 'approve', summary: 'Exact SDK candidate independently reviewed' }) })
  assert.equal(attempt.evidence.review.forgeReview.id, 25)
  assert.equal(attempt.pr.sha, candidate); assert.equal(attempt.status, 'waiting-acceptance')
  assert.equal(f.published.length, 0); assert.equal(observations, 2)
})

test('SDK publication observed before a writeback failure is reconciled through the original candidate Effect without a second PR', async t => {
  const f = await setup(t); await f.start('sdk-candidate-reconcile')
  const attempt = f.attempt(), workspace = attempt.workspaces.developer
  f.rt.config.projectGithubConnections = { dev: { credential: 'github-app', appId: 7, installationId: 70, projectIds: ['p1'], repositories: ['example/demo'] } }
  f.rt.config.projectRepositories['example/demo'].roleGithub = { enabled: true, revision: 1, branches: ['main'], roles: { developer: { connectionId: 'dev' } } }
  let observations = 0, writebackFailure = true
  f.rt.projectDelivery = createProjectDelivery(f.rt, { publisher: f.publisher, roleArtifacts: { publication: async (_attempt, { sha }) => { observations++; if (writebackFailure) throw Error('Remote PR exists; writeback interrupted'); return { number: 18, sha, repository: 'example/demo', url: 'https://github.com/example/demo/pull/18', roleScopeSha256: 'a'.repeat(64) } } } })
  writeFileSync(join(workspace.path, 'code.mjs'), 'export const add = (a,b) => a+b;\n')
  git(workspace.path, ['add', '.']); git(workspace.path, ['commit', '-m', 'Original published SDK commit'])
  const sha = git(workspace.path, ['rev-parse', 'HEAD'])
  await assert.rejects(f.gate('developer'), /writeback interrupted/)
  assert.equal(attempt.candidateSha, undefined); assert.equal(attempt.pr, undefined)
  const effect = f.rt.state.projectEffects[attempt.sdkCandidateEffect.id]
  assert.equal(effect.status, 'pending'); assert.equal(effect.executions, 1)
  writebackFailure = false
  const recovered = await f.rt.projectEndpoint('project-attempt-publication-retry', { attemptId: attempt.id, phase: 'candidate' }, alice)
  assert.equal(recovered.attempt.candidateSha, sha); assert.equal(attempt.pr.number, 18)
  assert.equal(effect.id, attempt.sdkCandidateEffect.id); assert.equal(effect.status, 'done')
  assert.equal(f.published.length, 0); assert.equal(observations, 2)
  assert.equal(attempt.publicationRecoveries[0].kind, 'sdk-candidate-reconcile')
})

test('proven exited active claim retires durably before a fresh integration snapshot, without cancellation', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false })
  const c = f.task.collaboration, generation = c.generation
  Object.assign(f.attempt.roleSessions.developer, { id: 'retiring-session', poolClaimId: 'retiring-claim', generation })
  const proof = { kind: 'sdk-stop-ack-and-process-exit', workerId: 'retiring-worker', generation: 7, at: Date.now() }
  const lease = { id: 'retiring-lease', projectId: 'p1', taskId: f.task.id, attemptId: f.attempt.id, resourceId: 'test', role: 'developer', principalId: 'owner-1', generation: 7, status: 'released', worker: { kind: 'sdk', handle: 'retiring-worker' }, releaseProof: proof }
  f.rt.state.projectResourceLeases[lease.id] = lease
  f.rt.state.projectHarnessWorkers = { 'retiring-worker': { id: 'retiring-worker', projectId: 'p1', taskId: f.task.id, attemptId: f.attempt.id, role: 'developer', sessionKey: 'retiring-session', resourceId: 'test', principalId: 'owner-1', leaseId: lease.id, generation: 7, status: 'released', releaseProof: proof } }
  c.claim = { id: 'retiring-claim', taskId: f.task.id, projectId: 'p1', attemptId: f.attempt.id, botId: 'p1:developer', workerId: 'retiring-worker', generation, status: 'active', exitConfirmed: false }
  await assert.rejects(integrationCall(f, 'query', 'attempt.integration-state', {}), /confirmed execution exit/)
  assert.equal((await f.rt.projectDelivery.recoveryFacts(f.task)).executionCheckpoint.blockers[0].kind, 'claim-active')
  const payload = { generation, claimId: c.claim.id, reason: 'Execution exited without transferring its claim; preserve the draft' }
  await assert.rejects(integrationCall(f, 'command', 'attempt.reconcile-exit', payload, bob), /access denied/)
  const save = f.rt.save
  f.rt.save = async () => {}
  await assert.rejects(f.rt.projectDelivery.endpoint('project-attempt-reconcile-exit', { projectId: 'p1', attemptId: f.attempt.id, ...payload }, alice), /commit was not confirmed/)
  assert.equal(c.claim.status, 'active'); assert.equal(c.generation, generation)
  f.rt.save = save
  const result = await integrationCall(f, 'command', 'attempt.reconcile-exit', payload, alice, 'retire-exact-claim')
  assert.equal(result.result.retirement.claimId, 'retiring-claim')
  assert.equal(c.claim.status, 'interrupted'); assert.equal(c.generation, generation + 1)
  assert.ok(f.rt.projectEffects.intentCommitted(c.claim.retirement.effect))
  assert.equal(f.attempt.cancelRequested, undefined)
  assert.equal((await integrationCall(f, 'command', 'attempt.reconcile-exit', payload, alice, 'retire-exact-claim')).replayed, true)
  await integrationCall(f, 'command', 'attempt.reconcile-exit', payload, alice, 'repeat-retirement')
  assert.equal(c.generation, generation + 1)
  await assert.rejects(f.rt.projectPools.decide(f.task.id, { ...c.claim, generation }, { action: 'arbitrate', reason: 'Late old result' }), /stale/)
  const saved = (await integrationCall(f, 'query', 'attempt.integration-state', {})).result
  await integrationCall(f, 'command', 'attempt.integration-bind', { inputs: [{ ref: f.ref, sha: f.source }], generation: saved.generation, expectedWorkspace: saved.snapshot })
  assert.equal(f.attempt.integrationInputs[0].sha, f.source)
  assert.equal(f.attempt.candidateSha, undefined); assert.equal(f.attempt.evidence.tests, undefined)
  const disk = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  assert.equal(disk.tasks[f.task.id].collaboration.claim.status, 'interrupted')
})

test('exit retirement refuses guessed proof, pending results, cancellation and changed claims', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false }), c = f.task.collaboration
  const session = f.attempt.roleSessions.developer
  Object.assign(session, { poolClaimId: 'exact', generation: c.generation })
  const proof = { kind: 'sdk-stop-ack-and-process-exit', workerId: 'worker', generation: 4, at: 123 }
  const lease = { id: 'lease', projectId: 'p1', attemptId: f.attempt.id, role: 'developer', resourceId: 'r', generation: 4, status: 'released', worker: { kind: 'sdk', handle: 'worker' }, releaseProof: proof }
  f.rt.state.projectResourceLeases.lease = lease
  const worker = { id: 'worker', projectId: 'p1', taskId: f.task.id, attemptId: f.attempt.id, role: 'developer', sessionKey: session.id, resourceId: 'r', leaseId: 'lease', generation: 4, status: 'released', releaseProof: proof }
  f.rt.state.projectHarnessWorkers = { worker }
  c.claim = { id: 'exact', taskId: f.task.id, projectId: 'p1', attemptId: f.attempt.id, botId: 'p1:developer', workerId: worker.id, generation: c.generation, status: 'active', exitConfirmed: true }
  const payload = { generation: c.generation, claimId: 'exact', reason: 'Retire only the confirmed allocation' }
  const denied = pattern => assert.rejects(integrationCall(f, 'command', 'attempt.reconcile-exit', payload), pattern)
  delete worker.releaseProof; await denied(/confirmed execution exit/); worker.releaseProof = proof
  lease.resourceId = 'foreign'; await denied(/allocation/); lease.resourceId = 'r'
  session.poolClaimId = 'different'; await denied(/confirmed execution exit/); session.poolClaimId = 'exact'
  worker.resultHash = 'pending'; await denied(/pending worker result/); delete worker.resultHash
  f.rt.state.projectEffects.unknown = { taskId: f.task.id, kind: 'github.publish', status: 'running', payload: { attemptId: f.attempt.id } }
  await denied(/pending external writes/); delete f.rt.state.projectEffects.unknown
  f.attempt.cancelRequested = true; await denied(/cancelled/); delete f.attempt.cancelRequested
  const background = f.rt.projectDelegations.background
  f.rt.projectDelegations.background = async () => { c.generation++ }
  await denied(/snapshot changed/)
  f.rt.projectDelegations.background = background
  assert.equal(c.claim.status, 'active'); assert.equal(c.claim.retirement, undefined)
})

test('native exited claim and old Chief invocation use their existing exact exit contracts', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false }), c = f.task.collaboration
  const session = f.attempt.roleSessions.developer
  Object.assign(session, { poolClaimId: 'native-claim', generation: c.generation })
  const row = { id: 'native-id', version: 'project-native-worker/v2', status: 'quiescent', projectId: 'p1', taskId: f.task.id, attemptId: f.attempt.id, role: 'developer', sessionKey: session.id, sessionId: 'physical', bindingKey: 'binding', generation: 1 }
  row.releaseProof = { kind: 'native-agent-quiescent', registeredWorkEmpty: true, workerId: row.id, sessionId: row.sessionId, bindingKey: row.bindingKey, generation: 1 }
  f.rt.state.projectNativeWorkers = { [row.id]: row }
  c.claim = { id: 'native-claim', taskId: f.task.id, projectId: 'p1', attemptId: f.attempt.id, botId: 'p1:developer', workerId: row.id, generation: c.generation, status: 'interrupted' }
  c.generation++ // Restart fenced the execution generation before explicit retirement.
  await integrationCall(f, 'command', 'attempt.reconcile-exit', { generation: c.generation, claimId: c.claim.id, reason: 'Native registered work is quiescent' })
  assert.equal(c.claim.retirement.proof.workerId, row.id)
  const generation = c.generation
  const run = { id: 'old-chief-run', projectId: 'p1', kind: 'chief-control', invocation: 1, status: 'interrupted', exitProof: { kind: 'native-chief-prior-host-exited', confirmed: true, runId: 'old-chief-run', invocation: 1 } }
  f.rt.state.projectExecutions[run.id] = run
  c.claim = { id: 'chief-claim', taskId: f.task.id, projectId: 'p1', attemptId: f.attempt.id, botId: 'p1:chief', chiefRunId: run.id, generation, status: 'active' }
  await integrationCall(f, 'command', 'attempt.reconcile-exit', { generation, claimId: c.claim.id, reason: 'The exact native Chief invocation has exited' })
  assert.equal(c.claim.retirement.proof.chiefRunId, run.id)
  assert.equal(c.generation, generation + 1)
})

for (const kind of ['local', 'docker']) test(kind + ' cancelled successor explicitly continues the original seed and draft without a PR binding', async t => {
  const f = await baselineResourceFixture(t, kind)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  const oldSeed = f.previous.seedSha ?? f.previous.baseSha
  f.previous.status = 'running'
  await f.rt.projectEndpoint('project-attempt-stop', { attemptId: f.previous.id }, alice)
  assert.equal(f.previous.status, 'cancelled')
  f.rt.state.projectWorkspaces = structuredClone(f.rt.state.projectWorkspaces)
  const snapshot = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { projectId: 'p1', attemptId: f.previous.id }, alice)
  const started = await f.rt.projectDelivery.endpoint('project-task-run', { taskId: f.task.id, requestId: 'continue-cancelled', continuation: { mode: 'continue', previousAttemptId: f.previous.id, generation: snapshot.generation, expectedWorkspace: snapshot.snapshot } }, alice)
  const next = f.rt.state.projectAttempts[started.attempt.id]
  assert.notEqual(next.id, f.previous.id); assert.equal(next.seedSha, oldSeed)
  assert.equal(next.continuation.previousAttemptId, f.previous.id)
  assert.equal(next.continuation.sourceWorkspaceId, f.workspace.id)
  assert.equal(next.publicationBinding, undefined); assert.equal(next.evidence.tests, undefined)
  await prepareRole(f.rt, f.task, { id: 'continued', attemptId: next.id, generation: 20 }, f.definition)
  assert.equal(next.workspaces.developer.path, f.workspace.path)
  assert.equal(git(next.workspaces.developer.path, ['rev-parse', 'HEAD']), oldSeed)
  assert.match(readFileSync(join(f.workspace.path, 'code.mjs'), 'utf8'), /preservedDraft/)
  assert.equal(f.previous.status, 'cancelled')
})

test('draft continuation is an explicit durable choice and never inherits stale inputs or tests', async t => {
  const f = await baselineResourceFixture(t)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  f.previous.status = 'running'
  await f.rt.projectEndpoint('project-attempt-stop', { attemptId: f.previous.id }, alice)
  const query = () => f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { projectId: 'p1', attemptId: f.previous.id }, alice)
  const snapshot = await query(), before = Object.keys(f.rt.state.projectAttempts).length
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', { taskId: f.task.id, requestId: 'no-choice' }, alice), error => error.code === 'bot/workspace-baseline' && error.details?.kind === 'continuation-required')
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, before)
  const continuation = { mode: 'continue', previousAttemptId: f.previous.id, generation: snapshot.generation, expectedWorkspace: snapshot.snapshot }
  const body = { taskId: f.task.id, requestId: 'chosen-continuation', continuation }
  writeFileSync(join(f.workspace.path, 'new-draft.txt'), 'Concurrent draft edit\n')
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', body, alice), /workspace or generation changed/)
  continuation.expectedWorkspace = (await query()).snapshot
  const save = f.rt.save; f.rt.save = async () => {}
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', body, alice), /commit was not confirmed/)
  assert.equal(f.task.deliveryAttemptId, f.previous.id)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, before)
  f.rt.save = save
  f.previous.integrationInputs = [{ version: 'project-integration-input/v1', repository: 'example/demo', ref: 'refs/remotes/operator/moved', sha: f.latest }]
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', body, alice), /git|source|reference|ref|command/i)
  delete f.previous.integrationInputs
  const result = await f.rt.projectDelivery.endpoint('project-task-run', body, alice)
  assert.equal((await f.rt.projectDelivery.endpoint('project-task-run', body, alice)).already, true)
  await assert.rejects(f.rt.projectDelivery.endpoint('project-task-run', { ...body, continuation: { ...continuation, mode: 'latest' } }, alice), /content changed/)
  const next = f.rt.state.projectAttempts[result.attempt.id]
  assert.ok(f.rt.projectEffects.intentCommitted(next.continuation.effect))
  assert.equal(next.evidence.tests, undefined)
})

test('latest-baseline successor preserves draft and reports the old workspace before explicit integration', async t => {
  const f = await baselineResourceFixture(t)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  f.previous.status = 'running'
  await f.rt.projectEndpoint('project-attempt-stop', { attemptId: f.previous.id }, alice)
  const saved = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { projectId: 'p1', attemptId: f.previous.id }, alice)
  const result = await f.rt.projectDelivery.endpoint('project-task-run', { taskId: f.task.id, requestId: 'choose-latest', continuation: { mode: 'latest', expectedBaseSha: saved.latestBaseSha, previousAttemptId: f.previous.id, generation: saved.generation, expectedWorkspace: saved.snapshot } }, alice)
  const next = f.rt.state.projectAttempts[result.attempt.id]
  assert.equal(next.baseSha, f.latest)
  await assert.rejects(prepareRole(f.rt, f.task, { id: 'latest-admission', attemptId: next.id, generation: 20 }, f.definition), error => error.code === 'bot/workspace-baseline')
  const recovery = await f.rt.projectDelivery.recoveryFacts(f.task)
  assert.equal(recovery.continuation.sourceWorkspaceId, f.workspace.id)
  assert.equal(recovery.baselineIssue.details.workspaceId, f.workspace.id)
  assert.equal(Object.keys(next.workspaces).length, 0)
  assert.match(readFileSync(join(f.workspace.path, 'code.mjs'), 'utf8'), /preservedDraft/)
  assert.equal(next.integrationInputs, undefined)
})

test('capacity queue preserves explicit continuation and rejects changed replay intent', async t => {
  const f = await baselineResourceFixture(t)
  writeFileSync(join(f.workspace.path, 'code.mjs'), 'export const preservedDraft = true;\n')
  f.previous.status = 'running'
  await f.rt.projectEndpoint('project-attempt-stop', { attemptId: f.previous.id }, alice)
  const saved = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { projectId: 'p1', attemptId: f.previous.id }, alice)
  const continuation = { mode: 'continue', previousAttemptId: f.previous.id, generation: saved.generation, expectedWorkspace: saved.snapshot }
  f.rt.state.projects.p1.quota = { maxConcurrent: 1 }
  f.rt.state.projectAttempts.busy = { id: 'busy', projectId: 'p1', taskId: 'other', status: 'running' }
  const body = { taskId: f.task.id, requestId: 'queued-continuation', continuation }
  const result = await f.rt.projectScheduler.request(body, alice)
  assert.deepEqual(result.queue.continuation, continuation)
  await assert.rejects(f.rt.projectScheduler.request({ ...body, continuation: { ...continuation, mode: 'latest' } }, alice), /target cannot change/)
  delete f.rt.state.projectAttempts.busy
  await f.rt.projectScheduler.drain()
  const row = f.rt.state.projectQueue[result.queue.id]
  assert.equal(row.status, 'started', row.reason)
  assert.equal(f.rt.state.projectAttempts[row.attemptId].seedSha, saved.seedSha)
  assert.equal(f.previous.status, 'cancelled')
})

test('protected Chief exit retirement excludes only its exact current coordination lease', async t => {
  const f = await additionalIntegrationFixture(t, { merge: false }), c = f.task.collaboration
  const old = { id: 'prior-exited-chief', projectId: 'p1', kind: 'chief-control', status: 'interrupted', invocation: 1, exitProof: { kind: 'native-chief-prior-host-exited', confirmed: true, runId: 'prior-exited-chief', invocation: 1 } }
  const current = { id: 'current-inspection', projectId: 'p1', kind: 'chief-control', status: 'running', invocation: 2 }
  Object.assign(f.rt.state.projectExecutions, { [old.id]: old, [current.id]: current })
  const actor = { memberId: 'owner-1', chiefJobId: current.id }, lease = { id: 'inspection-lease', projectId: 'p1', attemptId: current.id, chiefRunId: current.id, chiefInvocation: 2, role: 'chief', status: 'running' }
  f.rt.state.projectResourceLeases[lease.id] = lease
  f.rt.projectChiefControl.requireJobActor = candidate => { assert.equal(candidate, actor, 'Only the current protected job supplies the exclusion') }
  c.claim = { id: 'old-responsibility', projectId: 'p1', taskId: f.task.id, attemptId: f.attempt.id, botId: 'p1:chief', chiefRunId: old.id, generation: c.generation, status: 'active' }
  const payload = { projectId: 'p1', attemptId: f.attempt.id, claimId: c.claim.id, generation: c.generation, reason: 'Retire the exited old claim while this read-only inspection coordinates' }
  lease.chiefInvocation = 1
  await assert.rejects(f.rt.projectDelivery.reconcileExit(payload, actor), /lease-not-released/)
  lease.chiefInvocation = 2
  await f.rt.projectDelivery.reconcileExit(payload, actor)
  assert.equal(c.claim.status, 'interrupted')
  assert.equal(lease.status, 'running', 'The current Chief execution was not falsely released')
})

async function mergedDelivery(t, { modern = false } = {}) {
  const f = await setup(t, undefined, { modern })
  if (modern) {
    f.task = f.rt.state.tasks[f.task.id]
    const { reviseTask } = await import('../src/host/project-task-lifecycle.js')
    const decision = { id: 'initial', taskId: f.task.id, projectId: 'p1', executorRole: 'chief', runId: 'fixture-chief', initiatedBy: alice.memberId, reason: 'Confirm first deliverable' }
    admitTask(f.task, decision); reviseTask(f.task, { scope: 'First delivery' }, { ...decision, id: 'revision-two' })
  }
  await f.start('merged-delivery'); await complete(f)
  const a = f.attempt()
  git(f.repository, ['merge', '--ff-only', a.candidateSha])
  f.publisher.read = async pr => ({ sha: pr.sha, state: 'closed', merged: true, mergeCommitSha: a.candidateSha, baseRef: 'main', baseSha: git(f.repository, ['rev-parse', 'main']) })
  const originalJobAuthority = f.rt.projectChiefControl.requireJobActor
  f.rt.projectChiefControl.requireJobActor = actor => { if (actor.chiefJobId !== 'fixture-chief') throw Error('Chief job required') }
  f.rt.projectPools.connect({ validate: () => ({ ok: true }) })
  const actor = { ...alice, chiefJobId: 'fixture-chief' }
  const settle = () => f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: a.candidateSha, decision: { id: 'accept-current', action: 'accept-attempt', reason: 'Accept arithmetic delivery while the original goal continues', delivery: { completed: 'Addition implementation and regression verified', remaining: 'Cover the next independently deliverable requirement', evidence: ['current candidate, host tests and Review'] } } }, actor)
  return { ...f, a, actor, settle, originalJobAuthority }
}
test('merged Attempt can be accepted without closing its Task, then start a separate delivery on verified target HEAD', async t => {
  const f = await mergedDelivery(t)
  await f.settle()
  assert.equal(f.a.status, 'accepted')
  assert.notEqual(f.task.status, 'accepted', 'Attempt acceptance must not close the entire Task')
  assert.equal(f.a.settlement.completed, 'Addition implementation and regression verified')
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  assert.deepEqual(facts.modes, ['next'])
  const choice = { mode: 'next', previousAttemptId: f.a.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha }
  const next = await f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'next-delivery', continuation: choice }, alice)
  assert.notEqual(next.attempt.id, f.a.id)
  assert.equal(next.attempt.baseSha, f.a.candidateSha)
  assert.equal(next.attempt.publicationBinding, undefined)
  assert.equal(git(next.attempt.workspaces.developer.path, ['rev-parse', 'HEAD']), f.a.candidateSha)
  assert.equal(f.a.pr.number, 1)
  assert.equal((await f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'next-delivery', continuation: choice }, alice)).already, true)
})

test('scoped Attempt acceptance rolls back a failed or no-op save and remains idempotent after commit', async t => {
  const f = await mergedDelivery(t), save = f.rt.save, original = f.a.status
  f.task.collaboration = { initiatedBy: alice.memberId, generation: 1, status: 'chief-working', botId: 'p1:chief', history: [], claim: { id: 'chief-claim', botId: 'p1:chief', chiefRunId: 'fixture-chief', status: 'active', generation: 1 } }
  for (const failure of [async () => { throw Error('save unavailable') }, async () => {}]) {
    f.rt.save = failure
    await assert.rejects(f.settle())
    assert.equal(f.a.status, original)
    assert.equal(f.a.settlement, undefined)
    assert.equal(f.task.collaboration.claim.status, 'active'); assert.equal(f.task.collaboration.status, 'chief-working')
    assert.notEqual(f.task.status, 'accepted')
  }
  f.rt.save = save
  await f.settle()
  const receipt = structuredClone(f.a.settlement)
  assert.equal((await f.settle()).already, true)
  assert.deepEqual(f.a.settlement, receipt)
  assert.notEqual(f.task.status, 'accepted')
})
for (const changed of ['candidate', 'requirements', 'provider', 'authority', 'exit']) test('scoped Attempt acceptance refuses changed ' + changed, async t => {
  const f = await mergedDelivery(t)
  if (changed === 'candidate') f.a.evidence.tests.sha = 'old'
  if (changed === 'requirements') { const read = f.publisher.read; f.publisher.read = async (...args) => { const result = await read(...args); f.task.criteria += ' new requirement'; return result } }
  if (changed === 'provider') f.publisher.read = async pr => ({ sha: pr.sha, state: 'open', merged: false, baseRef: 'main' })
  if (changed === 'authority') f.rt.projectChiefControl.requireJobActor = () => { throw Error('authority revoked') }
  if (changed === 'exit') { f.rt.state.projectResourceLeases.late = { id: 'late', projectId: 'p1', attemptId: f.a.id, resourceId: 'unknown', generation: 1, role: 'developer', worker: { kind: 'sdk', handle: 'late-worker' }, status: 'unreachable' }; (f.rt.state.projectHarnessWorkers ??= {})['late-worker'] = { id: 'late-worker', leaseId: 'late', projectId: 'p1', attemptId: f.a.id, role: 'developer', resourceId: 'unknown', generation: 1, status: 'unreachable' } }
  await assert.rejects(f.settle())
  assert.equal(f.a.settlement, undefined)
  assert.notEqual(f.task.status, 'accepted')
})
test('next delivery refuses moved remote target, unrelated target and retained draft without clearing old binding', async t => {
  const f = await mergedDelivery(t)
  await f.settle()
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  const body = { taskId: f.task.id, requestId: 'stale-next', continuation: { mode: 'next', previousAttemptId: f.a.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }
  writeFileSync(join(f.repository, 'later'), 'advanced target'); git(f.repository, ['add', 'later']); git(f.repository, ['commit', '-m', 'Target advanced'])
  await assert.rejects(f.rt.projectEndpoint('project-task-run', body, alice), /snapshot|baseline/)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  const current = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  body.continuation.expectedBaseSha = current.latestBaseSha; body.continuation.expectedWorkspace = current.snapshot
  writeFileSync(join(f.a.workspaces.developer.path, 'code.mjs'), 'retained unsealed draft\n')
  await assert.rejects(f.rt.projectEndpoint('project-task-run', body, alice), /draft|snapshot/)
  assert.equal(readFileSync(join(f.a.workspaces.developer.path, 'code.mjs'), 'utf8'), 'retained unsealed draft\n')
  assert.equal(f.a.pr.number, 1)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
})
test('post-merge read reports unknown provider results and refuses a mixed local snapshot', async t => {
  const f = await mergedDelivery(t)
  f.publisher.read = async () => { throw Error('provider unavailable') }
  const choices = await f.rt.projectDelivery.deliveryOptions(f.task, alice)
  assert.equal(choices.actions.find(row => row.action === 'accept-attempt').status, 'unknown')
  f.publisher.read = async pr => { f.task.criteria += ' changed during read'; return { sha: pr.sha, state: 'closed', merged: true, mergeCommitSha: f.a.candidateSha, baseRef: 'main' } }
  await assert.rejects(f.rt.projectDelivery.deliveryOptions(f.task, alice), /fresh delivery facts/)
  assert.equal(f.a.status, 'waiting-acceptance')
})

test('accepted Attempt can later satisfy overall Task closure without reopening or rewriting its settlement', async t => {
  const f = await mergedDelivery(t)
  await f.settle()
  const settlement = structuredClone(f.a.settlement)
  await f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: f.a.candidateSha, decision: { id: 'close-whole-goal', action: 'close', reason: 'Every original criterion is now met' } }, f.actor)
  assert.equal(f.task.status, 'accepted')
  assert.deepEqual(f.a.settlement, settlement)
})
test('pending external write and unknown native exit block scoped acceptance; current settlement cannot be cleaned early', async t => {
  const f = await mergedDelivery(t)
  f.rt.state.projectEffects.unknownWrite = { id: 'unknownWrite', kind: 'github.review', status: 'running', payload: { attemptId: f.a.id } }
  await assert.rejects(f.settle(), /pending external/)
  delete f.rt.state.projectEffects.unknownWrite
  f.rt.state.projectNativeWorkers = { old: { id: 'old', attemptId: f.a.id, projectId: 'p1', status: 'unreachable' } }
  await assert.rejects(f.settle(), /native-exit-unknown/)
  delete f.rt.state.projectNativeWorkers.old
  await f.settle()
  await assert.rejects(f.rt.projectEndpoint('project-attempt-cleanup', { attemptId: f.a.id }, alice), /unsettled Task/)
})

test('Chief chooses acceptance then a fresh explicit next delivery through its original decision loop', async t => {
  const f = await mergedDelivery(t, { modern: true }), requests = [], rt = f.rt
  const { reviseTask } = await import('../src/host/project-task-lifecycle.js')
  const revision = { projectId: 'p1', taskId: f.task.id, executorRole: 'chief', runId: 'fixture-chief', initiatedBy: alice.memberId, reason: 'Record remaining work' }
  reviseTask(f.task, { scope: 'Remaining MVP' }, { ...revision, id: 'next-scope' })
  reviseTask(f.task, { criteria: 'Finish remaining MVP' }, { ...revision, id: 'next-criteria' })
  rt.projectChiefControl.requireJobActor = f.originalJobAuthority
  const carrier = { id: 'public-p1', projectId: 'p1', visibility: 'public', botId: 'a', sessionId: 'a', carrierGeneration: 1 }
  rt.state.projectAgents ??= {}; rt.state.projectAgents[carrier.id] = carrier
  rt.state.projectChiefPolicies = { p1: { enabled: true, authorityMemberId: alice.memberId, revision: 1, inspection: { thresholds: { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }, prompt: 'Inspect current delivery' } } }
  rt.projectAgents.startChiefJob = async args => { requests.push(args); return 'fixture-chief-turn' }
  const waitRequest = async count => { for (let pass = 0; pass < 400 && requests.length < count; ++pass) { await rt.projectChiefControl.pump(); await new Promise(resolve => setTimeout(resolve, 5)) }; assert.ok(requests.length >= count) }
  const reply = (request, decision) => request.onResult({ ok: true, text: JSON.stringify({ summary: 'Chief recommendation based on current facts', decisions: [{ taskId: f.task.id, ...decision }] }), executionEvidence: { kind: 'native-chief', chiefRunId: request.runId, carrierGeneration: 1, botId: 'a', sessionId: 'a' } })
  const { deliveryScope } = await import('../src/host/project-delivery-options.js')
  rt.state.projectChiefDecisions = Object.fromEntries(Array.from({ length: 4 }, (_, index) => ['old-refusal-' + index, { id: 'old-refusal-' + index, projectId: 'p1', taskId: f.task.id, status: 'rejected', expectedScope: deliveryScope(rt.state, f.task), action: 'accept-attempt', failure: 'Current requirements changed; inspect fresh delivery facts', at: index }]))
  await rt.projectChiefControl.request('p1', 'inspection', { requestId: 'post-merge-judgement' }, f.task.id)
  await waitRequest(1)
  assert.equal(requests[0].projectFacts.tasks[0].repositoryRecovery.nextActions.actions.find(row => row.action === 'accept-attempt').status, 'ready')
  assert.equal(requests[0].projectFacts.tasks[0].repositoryRecovery.nextActions.requirements.attemptRevision, 2)
  assert.equal(requests[0].projectFacts.tasks[0].repositoryRecovery.nextActions.requirements.taskRevision, 4)
  assert.equal(requests[0].projectFacts.tasks[0].inspection.chiefActionsWithoutProgress, 4)
  assert.equal(requests[0].projectFacts.tasks[0].repositoryRecovery.nextActions.requirements.priorValues.scope, 'First delivery')
  assert.match(requests[0].prompt, /repositoryRecovery\.nextActions and continuationOptions in projectFacts/)
  assert.match(requests[0].prompt, /Public TaskView\.nextActions lists caller-permitted service commands, not all Chief decision actions/)
  assert.match(requests[0].prompt, /not an instruction or permission to clear publicationBinding/)
  await reply(requests[0], { action: 'accept-attempt', reason: 'Accept the first verified delivery, keep the overall goal open', delivery: { completed: 'Verified addition implementation', remaining: 'Deliver the next requirement', evidence: ['candidate, tests, Review and provider merge'] } })
  assert.equal(rt.state.projectExecutions[requests[0].runId].status, 'done')
  assert.equal(f.a.status, 'accepted'); assert.notEqual(f.task.status, 'accepted')
  assert.equal(Object.keys(rt.state.projectAttempts).length, 1, 'Acceptance must not automatically dispatch Developer')
  await rt.projectEffects.drain(); await waitRequest(2)
  const saved = requests[1].projectFacts.tasks.find(row => row.taskId === f.task.id), facts = saved.repositoryRecovery.continuationOptions
  assert.deepEqual(facts.modes, ['next'])
  assert.equal(saved.repositoryRecovery.nextActions.actions.find(row => row.action === 'start-next').status, 'ready')
  assert.equal(saved.repositoryRecovery.nextActions.actions.find(row => row.action === 'return').status, 'blocked')
  assert.equal(saved.repositoryRecovery.nextActions.recommendation.action, 'accept-attempt')
  assert.equal(saved.repositoryRecovery.nextActions.recommendation.alreadyApplied, true)
  await reply(requests[1], { action: 'start-next', targetBotId: 'p1:developer', reason: 'Choose the next independent delivery from verified target HEAD', continuation: { mode: 'next', previousAttemptId: facts.attemptId, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } })
  assert.equal(rt.state.projectExecutions[requests[1].runId].status, 'done', rt.state.projectExecutions[requests[1].runId].failure)
  const next = rt.state.projectAttempts[f.task.deliveryAttemptId]
  assert.notEqual(next.id, f.a.id); assert.equal(next.baseSha, f.a.candidateSha); assert.equal(next.publicationBinding, undefined)
  assert.equal(next.requirement.projectTaskRevision, 4)
  assert.notEqual(f.task.status, 'accepted'); assert.equal(f.task.chiefQuestion, undefined)
})

test('two real SDK-protocol pool deliveries retain the Task-role thread and create a new PR after scoped acceptance', async t => {
  const f = await setup(t, undefined, { sdkContract: true, pool: true }), { rt, directory } = f, runtimeDir = join(directory, 'next-sdk-runtime')
  mkdirSync(join(runtimeDir, 'src/host'), { recursive: true })
  writeFileSync(join(runtimeDir, 'src/host/project-harness-worker.mjs'), `
import{createInterface}from'node:readline';import{writeFileSync,readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');send({type:'ready',sdk:{codex:'0.166.0'}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='stop'){send({type:'stopped',released:true});setTimeout(()=>process.exit(0),20);return;}if(m.type!=='start')return;
let d;if(!m.settings.readOnly){const next=readFileSync('code.mjs','utf8').includes('a+b');writeFileSync('code.mjs','export const add=(a,b)=>a+b;'+(next?' // next delivery':'')+'\\n');d={action:'handoff',to:'p1:tester',reason:'Host-test this implementation',outputs:{implementation:'Delivered requested improvement'}};}
else if(m.prompt.includes('Independently review the candidate diff'))d={action:'complete',reason:'Verified the exact candidate',outputs:{review:JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),verdict:'approve',summary:'Exact candidate and host tests inspected'})}};
else d={action:'handoff',to:'p1:reviewer',reason:'Request host test execution and review',outputs:{tests:'Run configured host tests'}};
const id=m.settings.sessionId??('sdk-thread-'+process.pid);send({type:'sdk-event',event:{type:'thread.started',thread_id:id}});send({type:'completed',sessionId:id,text:'OUTPUT handoff: '+JSON.stringify(d)});});`)
  rt.config.projectResources = { one: { type: 'local', root: directory, runtimeDir, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(directory, 'sdk-home'), configDir: join(directory, 'sdk-config'), model: 'contract-model' } } } } }
  rt.state.projectResourceHealth = { one: { status: 'ready', at: Date.now() } }
  rt.state.projectHarnessHealth = { 'p1:one:codex': { status: 'ready', profile: harnessProfile(rt.config.projectResources.one, rt.readProject('p1'), 'one', 'codex').profile } }
  for (const role of ['developer', 'tester', 'reviewer']) await rt.projectEndpoint('project-agent-definition', { projectId: 'p1', role, execution: { harness: 'codex', resourceIds: ['one'] } }, alice)
  const wait = async a => { for (let pass = 0; pass < 800; ++pass) { await rt.projectPools.pump(); if (a.status === 'waiting-acceptance' && rt.projectResources.occupied('one') === 0 && f.task.collaboration.status === 'arbitration') return; await new Promise(resolve => setTimeout(resolve, 10)) }; assert.fail(JSON.stringify({ status: a.status, collaboration: f.task.collaboration, failure: a.failure })) }
  await f.start('first-sdk-delivery'); const first = f.attempt(); await wait(first)
  const dev = Object.values(rt.state.projectHarnessWorkers).find(row => row.attemptId === first.id && row.role === 'developer')
  git(f.repository, ['merge', '--ff-only', first.candidateSha])
  f.publisher.read = async pr => ({ sha: pr.sha, state: pr.number === first.pr.number ? 'closed' : 'open', merged: pr.number === first.pr.number, mergeCommitSha: first.candidateSha, baseRef: 'main', baseSha: git(f.repository, ['rev-parse', 'main']) })
  rt.projectChiefControl.requireJobActor = () => {}
  await rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: first.candidateSha, decision: { id: 'sdk-accept', action: 'accept-attempt', reason: 'The first delivery is accepted; continue original goal', delivery: { completed: 'Addition implementation', remaining: 'Implement the next requested improvement', evidence: ['host tests, released SDK execution, exact Review and merge'] } } }, { ...alice, chiefJobId: 'sdk-chief' })
  const facts = await rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: first.id }, alice)
  const result = await rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'next-sdk-delivery', targetRole: 'developer', continuation: { mode: 'next', previousAttemptId: first.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }, alice)
  const second = rt.state.projectAttempts[result.attempt.id]; await wait(second)
  const resumed = Object.values(rt.state.projectHarnessWorkers).find(row => row.attemptId === second.id && row.role === 'developer')
  assert.equal(resumed.continuedFrom, dev.id); assert.equal(resumed.backendSessionId, dev.backendSessionId)
  assert.equal(second.roleSessions.developer.logicalSessionId, first.roleSessions.developer.logicalSessionId)
  assert.equal(second.baseSha, first.candidateSha); assert.equal(second.publicationBinding, undefined)
  assert.notEqual(second.branch, first.branch); assert.notEqual(second.pr.number, first.pr.number)
  assert.equal(second.feedback.reason, 'Implement the next requested improvement')
  assert.equal(first.pr.number, 1); assert.notEqual(f.task.status, 'accepted')
})

test('next baseline must contain the accepted merge and changed replay content cannot rewrite settlement', async t => {
  const f = await mergedDelivery(t)
  await f.settle()
  f.publisher.read = async pr => ({ sha: pr.sha, state: 'closed', merged: true, mergeCommitSha: f.a.candidateSha, baseRef: 'main', baseSha: f.a.baseSha })
  await assert.rejects(f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice), /does not contain/)
  const different = { id: 'changed-scope', action: 'accept-attempt', delivery: { completed: 'Different delivery', remaining: 'Changed remaining scope', evidence: ['new statement'] } }
  await assert.rejects(f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: f.a.candidateSha, decision: different }, f.actor), /scope cannot change/)
  assert.equal(f.a.settlement.completed, 'Addition implementation and regression verified')
})

test('committed scoped acceptance survives Store restart and notifies only a fresh Chief inspection', async t => {
  const f = await mergedDelivery(t)
  f.rt.state.projectChiefPolicies = { p1: { enabled: true, authorityMemberId: alice.memberId, revision: 1, inspection: { thresholds: { maxHandoffsWithoutProgress: 3, longExecutionMs: 10000, missingHeartbeatMs: 5000, longWaitMs: 8000 }, prompt: 'Inspect current delivery' } } }
  f.rt.projectChiefControl.request = async () => { throw Error('controller unavailable before restart') }
  await f.settle()
  const token = structuredClone(f.a.settlement.effect)
  await f.rt.ctx.dispose()
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  const restarted = createRuntime(ctx, f.rt.config)
  restarted.projectDelivery = createProjectDelivery(restarted, { publisher: f.publisher })
  t.after(() => ctx.dispose())
  await restarted.load()
  assert.equal(restarted.state.projectAttempts[f.a.id].status, 'accepted')
  assert.equal(restarted.projectEffects.intentCommitted(token), true)
  assert.notEqual(restarted.state.tasks[f.task.id].status, 'accepted')
  // Observe the original durable queue receipt; no model execution is needed here.
  await restarted.projectEffects.drain()
  const runs = Object.values(restarted.state.projectExecutions).filter(row => row.source?.acceptanceEffectId === token.id)
  assert.equal(runs.length, 1)
  await restarted.projectEffects.drain()
  assert.equal(Object.values(restarted.state.projectExecutions).filter(row => row.source?.acceptanceEffectId === token.id).length, 1)
  assert.equal(Object.keys(restarted.state.projectAttempts).length, 1)
})

test('invalid scoped acceptance and wrong expected candidate fail before committing any settlement', async t => {
  const f = await mergedDelivery(t)
  for (const delivery of [undefined, { completed: 'result', remaining: '', evidence: ['evidence'] }, { completed: 'result', remaining: 'next', evidence: [] }, { completed: 'result', remaining: 'next', evidence: ['x'.repeat(1201)] }]) {
    await assert.rejects(f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: f.a.candidateSha, decision: { id: 'invalid', action: 'accept-attempt', delivery } }, f.actor), /delivery needs/)
  }
  await assert.rejects(f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: 'old', decision: { id: 'wrong-sha', action: 'accept-attempt', delivery: { completed: 'done', remaining: 'next', evidence: ['host evidence'] } } }, f.actor), /current candidate/)
  assert.equal(f.a.settlement, undefined)
})

test('principal revocation during provider evidence read prevents scoped acceptance before commit', async t => {
  const f = await mergedDelivery(t), read = f.publisher.read
  let revoked = false
  f.rt.projectDelegations.background = async () => { if (revoked) throw Error('principal revoked after provider read') }
  f.publisher.read = async (...args) => { const result = await read(...args); revoked = true; return result }
  await assert.rejects(f.settle(), /principal revoked/)
  assert.equal(f.a.settlement, undefined)
  assert.equal(f.a.status, 'waiting-acceptance')
})

test('next delivery checks its scope again after asynchronous principal validation', async t => {
  const f = await mergedDelivery(t)
  await f.settle()
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  let changed = false
  f.rt.projectDelegations.background = async () => { changed = true; f.task.criteria += ' changed during validation' }
  await assert.rejects(f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'authority-race-next', continuation: { mode: 'next', previousAttemptId: f.a.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }, alice), /fresh next-delivery scope/)
  assert.equal(changed, true)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  assert.equal(f.a.status, 'accepted')
})

test('next delivery pins a distinct provider squash commit and reports missing exact target objects to Chief', async t => {
  const f = await mergedDelivery(t), merge = git(f.repository, ['commit-tree', `${f.a.candidateSha}^{tree}`, '-p', f.a.baseSha, '-m', 'Provider squash merge'])
  assert.notEqual(merge, f.a.candidateSha)
  git(f.repository, ['reset', '--hard', merge])
  f.publisher.read = async pr => ({ sha: pr.sha, state: 'closed', merged: true, mergeCommitSha: merge, baseRef: 'main', baseSha: merge })
  await f.settle()
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  assert.equal(facts.target.mergeCommitSha, merge)
  const read = f.publisher.read, missing = 'f'.repeat(40)
  f.publisher.read = async pr => ({ ...await read(pr), baseSha: missing })
  const blocked = await f.rt.projectDelivery.recoveryFacts(f.task, f.actor)
  assert.equal(blocked.continuationOptions.status, 'unavailable')
  assert.equal(blocked.continuationOptions.details.kind, 'target-objects-unavailable')
  assert.equal(blocked.continuationOptions.details.targetSha, missing)
  assert.equal(Object.keys(f.rt.state.projectAttempts).length, 1)
  f.publisher.read = read
  const result = await f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'next-after-squash', continuation: { mode: 'next', previousAttemptId: f.a.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }, alice)
  assert.equal(result.attempt.baseSha, merge)
  assert.equal(git(result.attempt.workspaces.developer.path, ['rev-parse', 'HEAD']), merge)
  assert.equal(result.attempt.publicationBinding, undefined)
})

test('evolving Task rev4 accepts merged Attempt rev2 and starts the next delivery with current requirements', async t => {
  const f = await mergedDelivery(t, { modern: true }), original = structuredClone(f.a.requirement)
  const { reviseTask } = await import('../src/host/project-task-lifecycle.js')
  const decision = { taskId: f.task.id, projectId: 'p1', executorRole: 'chief', runId: 'fixture-chief', initiatedBy: alice.memberId, reason: 'Record delivered scope and remaining goal' }
  reviseTask(f.task, { scope: 'Remaining MVP' }, { ...decision, id: 'revision-three' })
  reviseTask(f.task, { title: 'Complete remaining MVP', criteria: 'Remaining features verified' }, { ...decision, id: 'revision-four' })
  assert.equal(f.a.requirement.projectTaskRevision, 2); assert.equal(f.task.projectTask.requirements.revision, 4)
  const choices = await f.rt.projectDelivery.deliveryOptions(f.task, f.actor)
  assert.equal(choices.actions.find(row => row.action === 'accept-attempt').status, 'ready', JSON.stringify(choices.actions))
  assert.deepEqual(choices.requirements.changedFields, ['revision', 'title', 'criteria', 'scope'])
  assert.equal(choices.requirements.source.section, 'requirement')
  assert.equal(choices.requirements.priorValues.criteria, original.criteria)
  await f.settle()
  assert.equal(f.a.settlement.requirementsRevision, 2); assert.equal(f.a.settlement.taskRequirementsRevision, 4)
  assert.deepEqual(f.a.requirement, original); assert.equal(f.task.status, 'result-ready')
  await assert.rejects(f.rt.projectDelivery.chiefAccept({ taskId: f.task.id, expectedSha: f.a.candidateSha, decision: { id: 'close-new-goal', action: 'close' } }, f.actor), /requirements version/i)
  const facts = await f.rt.projectDelivery.endpoint('project-attempt-continuation-state', { attemptId: f.a.id }, alice)
  const next = await f.rt.projectEndpoint('project-task-run', { taskId: f.task.id, requestId: 'next-current-requirements', continuation: { mode: 'next', previousAttemptId: f.a.id, generation: facts.generation, expectedWorkspace: facts.snapshot, expectedBaseSha: facts.latestBaseSha } }, alice)
  assert.equal(next.attempt.requirement.projectTaskRevision, 4)
  assert.equal(next.attempt.requirement.criteria, f.task.criteria)
  assert.equal(next.attempt.publicationBinding, undefined); assert.equal(f.a.pr.number, 1)
})

test('historical parent settlement retains the original durable child admission revision', async t => {
  const f = await childIntegrationFixture(t), a = f.attempt, task = f.task
  await f.rt.projectDelivery.admitChildInputs(task.id, f.claim)
  git(f.path, ['merge', '--no-commit', '--no-ff', ...f.sources.map(row => row.sha)])
  await f.rt.projectDelivery.completePoolRole({ task, claim: f.claim, role: 'developer', outputs: {} })
  const roles = f.rt.projectAgents.deliveryDefinitions('p1').roles
  await prepareRole(f.rt, task, { id: 'test-parent', attemptId: a.id, generation: 2 }, roles.find(r => r.role === 'tester'))
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: a.id }, role: 'tester', outputs: {} })
  await prepareRole(f.rt, task, { id: 'review-parent', attemptId: a.id, generation: 3 }, roles.find(r => r.role === 'reviewer'))
  await f.rt.projectDelivery.completePoolRole({ task, claim: { attemptId: a.id }, role: 'reviewer', outputs: { review: JSON.stringify({ commit: a.candidateSha, verdict: 'approve', summary: 'Original parent and child results verified' }) } })
  git(f.repository, ['merge', '--ff-only', a.candidateSha])
  f.publisher.read = async pr => ({ sha: pr.sha, state: 'closed', merged: true, mergeCommitSha: a.candidateSha, baseRef: 'main', baseSha: a.candidateSha })
  task.collaboration.claim.status = 'completed'; task.collaboration.claim.exitConfirmed = true
  const { reviseTask } = await import('../src/host/project-task-lifecycle.js')
  reviseTask(task, { scope: 'Additional parent goal' }, { id: 'parent-next-goal', projectId: 'p1', taskId: task.id, executorRole: 'chief', runId: 'parent-chief', initiatedBy: alice.memberId, reason: 'Plan remaining goal after merged child integration' })
  const accepted = () => f.rt.projectDelivery.chiefAccept({ taskId: task.id, expectedSha: a.candidateSha, decision: { id: 'settle-parent', action: 'accept-attempt', delivery: { completed: 'Parent integrated the original accepted children', remaining: 'Additional parent goal', evidence: ['original durable child admission, tested candidate and merged PR'] } } }, { ...alice, chiefJobId: 'parent-chief' })
  f.rt.projectChiefControl.requireJobActor = actor => { assert.equal(actor.chiefJobId, 'parent-chief') }
  const admission = a.integrationAdmissions.find(row => row.origin === 'project-child-results'), originalFingerprint = admission.sourcesFingerprint
  const effect = f.rt.state.projectEffects[admission.effect.id], beforeEffect = structuredClone(effect)
  delete f.rt.state.projectEffects[admission.effect.id]
  await assert.rejects(accepted(), /durable source admission/)
  f.rt.state.projectEffects[admission.effect.id] = beforeEffect
  await accepted()
  assert.equal(a.status, 'accepted'); assert.equal(a.settlement.requirementsRevision, 1); assert.equal(a.settlement.taskRequirementsRevision, 2)
  assert.equal(admission.sourcesFingerprint, originalFingerprint); assert.notEqual(task.status, 'accepted')
})

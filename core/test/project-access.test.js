import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createWorkflowService } from '../../plugins/workflow/src/service.js'
import { createProjectScheduler } from '../src/host/project-scheduler.js'
import { fakeContext } from './fake-ctx.js'

const alice = { memberId: 'owner-1' }
const bob = { memberId: 'bob' }
const outsider = { memberId: 'outsider' }
async function setup(t, tasks = {}) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-access-'))
  const state = { version: 2, mainBotIds: ['a'], members: { 'owner-1': { id: 'owner-1' }, bob: { id: 'bob' }, outsider: { id: 'outsider' } },
    bots: { a: { id: 'a', name: 'Chief', ownerId: 'owner-1', role: 'Owner', sessionId: 'a', projectId: 'p1', createdAt: 1 } },
    projects: { p1: { id: 'p1', name: 'Shared', ownerUserId: 'owner-1', status: 'active', createdAt: 1, updatedAt: 1, roles: { maintainers: [], members: ['bob'] } },
      p2: { id: 'p2', name: 'Private', ownerUserId: 'outsider', status: 'active', createdAt: 1, updatedAt: 1 } },
    rooms: {}, tasks, projectRuns: {}, exchanges: [], exchangeTurns: {}, agents: {} }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] },
    workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
    sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  const rt = createRuntime(ctx, { home, projectWorkbench: true })
  rt.testHttp = async (endpoint, payload = { projectId: 'p1' }) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers: { 'x-flybot-member-session': 'unit-session' }, body: JSON.stringify({ endpoint, payload }) }))).json()
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return rt
}

test('only current Project members see shared state; body identity and AI roles grant nothing', async t => {
  const rt = await setup(t)
  assert.deepEqual((await rt.projectEndpoint('projects', {}, bob)).projects.map(row => row.id), ['p1'])
  await assert.rejects(rt.projectEndpoint('project-detail', { id: 'p2', role: 'owner', memberId: 'outsider' }, bob), /access denied/)
  await assert.rejects(rt.projectEndpoint('project-board', { id: 'p1', actorId: 'owner-1' }, outsider), /access denied/)
  await assert.rejects(rt.projectEndpoint('project-archive', { id: 'p1' }, bob), /access denied/)
  assert.equal(rt.state.projects.p1.status, 'active')
})

test('Project invitations are hashed, single use and grant membership to the authenticated actor', async t => {
  const rt = await setup(t)
  const invite = await rt.projectEndpoint('project-invite', { id: 'p1', role: 'owner' }, alice)
  assert.ok(invite.token)
  assert.ok(!JSON.stringify(rt.state.projectInvites).includes(invite.token))
  await rt.projectEndpoint('project-join', { token: invite.token, memberId: 'bob', role: 'owner' }, outsider)
  assert.equal(rt.projectRoleOf(rt.state.projects.p1, 'outsider'), 'member')
  await assert.rejects(rt.projectEndpoint('project-join', { token: invite.token }, bob), /unavailable/)
  await assert.rejects(rt.projectEndpoint('project-invite', { id: 'p1' }, bob), /access denied/)
})

test('members create shared Tasks but cannot accept deliveries or update someone else’s request', async t => {
  const rt = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Bob request', requesterId: 'owner-1' }, bob)
  assert.equal(task.requesterId, 'bob')
  assert.equal(task.projectId, 'p1')
  assert.equal(rt.taskVisible(rt.state.tasks[task.id], alice), true)
  const own = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Alice request' }, alice)
  await assert.rejects(rt.taskEndpoint('task-update', { id: own.id, title: 'Foreign change' }, bob), /cannot|Only|denied/)
  rt.state.tasks[task.id].status = 'result-ready'
  await assert.rejects(rt.taskEndpoint('task-accept-result', { id: task.id }, bob), /denied/)
  await assert.rejects(rt.taskEndpoint('task-accept-result', { id: task.id }, alice), /Project delivery acceptance/)
  assert.equal(rt.state.tasks[task.id].status, 'result-ready')
  assert.equal(rt.state.tasks[task.id].projectTask.admission.status, 'proposed')
})

test('membership removal immediately revokes existing actor and task access while preserving work', async t => {
  const rt = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Keep work' }, bob)
  await rt.projectEndpoint('project-member-remove', { id: 'p1', memberId: 'bob' }, alice)
  await assert.rejects(rt.projectEndpoint('project-detail', { id: 'p1' }, bob), /access denied/)
  await assert.rejects(rt.taskEndpoint('task-update', { id: task.id, note: 'Stale page' }, bob), /cannot|Only|denied/)
  assert.equal(rt.taskVisible(rt.state.tasks[task.id], bob), false)
  assert.equal(rt.state.tasks[task.id].requesterId, 'bob')
  assert.equal(rt.state.tasks[task.id].status, 'open')
})

test('a maintainer may invite Members and configure quota but may not re-role owners', async t => {
  const rt = await setup(t)
  await rt.projectEndpoint('project-role', { id: 'p1', memberId: 'bob', role: 'maintainer' }, alice)
  assert.ok((await rt.projectEndpoint('project-invite', { id: 'p1' }, bob)).token)
  assert.deepEqual(await rt.projectEndpoint('project-quota', { id: 'p1', maxConcurrent: 1 }, bob), { quota: { maxConcurrent: 1 } })
  await assert.rejects(rt.projectEndpoint('project-role', { id: 'p1', memberId: 'owner-1', role: 'member' }, bob), /access denied/)
  await assert.rejects(rt.projectEndpoint('project-member-remove', { id: 'p1', memberId: 'owner-1' }, bob), /owner/)
})


test('explicit null cannot detach a new shared Task from membership revocation', async t => {
  const rt = await setup(t)
  await assert.rejects(rt.taskEndpoint('task-create', { botId: 'a', projectId: null, title: 'Escape' }, bob), /another Project/)
  assert.deepEqual(rt.state.tasks, {})
})

test('Workflow gateway isolates projects, serializes quota admission and makes duplicate starts harmless', async t => {
  // Compatibility graphs continue only pre-cutover work; new Tasks must use the controller.
  const legacy = id => ({ id, projectId: 'p1', requesterId: 'bob', ownerBotId: 'a', title: id, criteria: 'Result verified', status: 'open', actors: [], createdAt: 1 })
  const rt = await setup(t, { first: legacy('first'), second: legacy('second') })
  const service = createWorkflowService({ persist: false, readProject: id => rt.readProject(id),
    projectContext: (taskId, projectId) => rt.flybot.projects.context(taskId, projectId),
    bindRun: (id, projectId, details) => rt.flybot.projects.bindRun(id, projectId, details) })
  rt.ctx.effect(() => () => service.dispose(), 'test workflow')
  rt.flybot.api.handle('workflow/state', () => service.state(), { read: true })
  rt.flybot.api.handle('workflow/create', body => service.create(body))
  rt.flybot.api.handle('workflow/graph', body => service.saveGraph(body))
  rt.flybot.api.handle('workflow/assign', body => service.assign(body))
  const create = async (projectId, actor, name) => rt.projectEndpoint('project-workflow', { projectId, operation: 'create', name,
    nodes: [{ id: 'dev', name: 'Dev', prompt: 'Implement', tools: [] }], edges: [] }, actor)
  const shared = await create('p1', alice, 'Shared graph')
  assert.equal(shared.ok, true)
  await create('p2', outsider, 'Hidden graph')
  const graph = shared.workflows.find(row => row.name === 'Shared graph')
  const snapshot = await rt.projectEndpoint('project-workflow', { projectId: 'p1' }, bob)
  assert.deepEqual(snapshot.workflows.map(row => row.name), ['Shared graph'])
  await assert.rejects(create('p1', bob, 'Forbidden'), /access denied/)
  const first = rt.state.tasks.first, second = rt.state.tasks.second
  const canonical = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'New work', criteria: 'New result verified', impact: 'New Project change' }, bob)
  await rt.projectEndpoint('project-quota', { id: 'p1', maxConcurrent: 1 }, alice)
  const start = taskId => rt.projectEndpoint('project-workflow', { projectId: 'p1', operation: 'assign', workflowId: graph.id, taskId }, bob)
  await assert.rejects(start(canonical.id), /Chief admission/)
  const { admitTask } = await import('../src/host/project-task-lifecycle.js')
  admitTask(rt.state.tasks[canonical.id], { id: 'admit-' + canonical.id, taskId: canonical.id, projectId: 'p1', executorRole: 'chief', runId: 'chief-fixture', initiatedBy: alice.memberId, reason: 'Scoped requirements fixture' })
  await assert.rejects(start(canonical.id), /task.run|controller/)
  rt.state.projectExecutions['chief-job'] = { id: 'chief-job', projectId: 'p1', kind: 'chief-control', status: 'running' }
  const results = await Promise.allSettled([start(first.id), start(second.id)])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.match(results.find(row => row.status === 'rejected').reason.message, /quota/)
  assert.equal((await start(first.id)).already, true)
  assert.equal(Object.values(rt.state.projectExecutions).filter(run => run.kind !== 'chief-control' && run.status === 'running').length, 1)
  assert.equal(rt.authorize(bob, 'flybot/workflow/state', {}).ok, false)
  await assert.rejects(rt.projectEndpoint('project-workflow', { projectId: 'p1', operation: 'create', name: 'Ambient credentials', nodes: [{ id: 'x', tools: ['github'] }] }, alice), /credentials/)
})

test('unscoped plugin reads and global usage cannot leak other Projects in workbench mode', async t => {
  const rt = await setup(t)
  for (const endpoint of ['flybot/workflow/state', 'flybot/tree/state', 'flybot/timeline/state', 'workflows', 'workflow-save', 'usage']) assert.equal(rt.authorize(bob, endpoint, {}).ok, false, endpoint)
  rt.state.bots.a.systemPrompt = 'Alice private configuration'
  assert.deepEqual(await rt.flybotEndpoint('bots', {}, { actor: bob }), [])
  await rt.projectEndpoint('project-member-remove', { id: 'p1', memberId: 'bob' }, alice)
  assert.deepEqual(await rt.flybotEndpoint('changes', {}, { actor: bob }).then(result => result.changes), [])
})


test('demoting an inviter immediately invalidates its outstanding invitations', async t => {
  const rt = await setup(t)
  await rt.projectEndpoint('project-role', { id: 'p1', memberId: 'bob', role: 'maintainer' }, alice)
  const invite = await rt.projectEndpoint('project-invite', { id: 'p1' }, bob)
  await rt.projectEndpoint('project-role', { id: 'p1', memberId: 'bob', role: 'member' }, alice)
  await assert.rejects(rt.projectEndpoint('project-join', { token: invite.token }, outsider), /unavailable/)
  assert.equal(rt.projectCan(outsider, 'p1'), false)
})


test('runtime, terminal and execution-input HTTP endpoints reach Project authorization instead of the resource read model', async t => {
  const rt = await setup(t)
  rt.authenticate = async () => alice
  rt.projectEndpoint = async endpoint => ({ routedProjectEndpoint: endpoint })
  rt.workbenchEndpoint = async () => ({ readModelOnly: true })
  for (const endpoint of ['project-resource-environment-check', 'project-execution-input', 'project-runtime-check', 'project-terminal-open', 'project-terminal-poll', 'project-terminal-input', 'project-terminal-resize', 'project-terminal-close']) {
    const result = await rt.testHttp(endpoint)
    assert.equal(result.ok, true, endpoint)
    assert.equal(result.value.routedProjectEndpoint, endpoint, endpoint)
  }
})

test('repair pool, query, delegation and Chief endpoints reach the actual HTTP Project dispatcher', async t => {
  const rt = await setup(t)
  rt.authenticate = async () => alice
  const prior = rt.projectEndpoint
  rt.projectEndpoint = async endpoint => ({ routedProjectEndpoint: endpoint })
  for (const endpoint of ['project-queue-retry', 'project-rooms', 'project-room-create', 'project-room-read', 'project-room-message', 'project-room-attachment', 'project-room-stop', 'project-agent-stop', 'project-task-pools', 'project-chief-question', 'project-github-read', 'project-agent-mode', 'project-chief-state', 'project-chief-configure', 'project-chief-inspect', 'project-scheduled-task']) {
    const result = await rt.testHttp(endpoint)
    assert.equal(result.ok, true, endpoint)
    assert.equal(result.value.routedProjectEndpoint, endpoint)
  }
  rt.projectEndpoint = prior
  rt.authenticate = async () => outsider
  const denied = await rt.testHttp('project-chief-state')
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'bot/forbidden')
})

test('scoped Chief inspection keeps human authority and rejects other Project Tasks',async t=>{
 const rt=await setup(t);rt.state.tasks.owned={id:'owned',projectId:'p1'};rt.state.tasks.other={id:'other',projectId:'p2'};let source
 rt.projectChiefControl.request=async(projectId,kind,input)=>{source=input;return{id:'inspection'}}
 await rt.projectEndpoint('project-chief-inspect',{projectId:'p1',requestId:'scoped',taskId:'owned'},alice)
 assert.equal(source.blockedTaskId,'owned')
 await assert.rejects(rt.projectEndpoint('project-chief-inspect',{projectId:'p1',requestId:'other',taskId:'other'},alice),/Inspection Task/)
 await assert.rejects(rt.projectEndpoint('project-chief-inspect',{projectId:'p1',requestId:'missing',taskId:'missing'},alice),/Inspection Task/)
 await assert.rejects(rt.projectEndpoint('project-chief-inspect',{projectId:'p1',requestId:'member',taskId:'owned'},bob),/access denied/)
 await rt.projectEndpoint('project-chief-inspect',{projectId:'p1',requestId:'whole'},alice);assert.equal(source.blockedTaskId,undefined)
})

test('board summaries retain authorized cards without full audit payloads', async t => {
  const rt = await setup(t)
  rt.state.tasks.card = { id: 'card', projectId: 'p1', title: 'Visible', status: 'open', requesterId: 'bob', result: 'large private audit', collaboration: { botId: 'chief', claim: { context: 'large execution context' } } }
  const full = await rt.projectEndpoint('project-detail', { projectId: 'p1' }, bob)
  const summary = await rt.projectEndpoint('project-detail', { projectId: 'p1', view: 'summary' }, bob)
  assert.equal(full.tasks[0].result, 'large private audit')
  assert.equal(summary.tasks[0].title, 'Visible')
  assert.equal(summary.tasks[0].result, undefined)
  assert.equal(summary.tasks[0].collaboration.claim, undefined)
  assert.equal(summary.runs, undefined)
  await assert.rejects(rt.projectEndpoint('project-detail', { projectId: 'p1', view: 'summary' }, outsider), /access denied/)
  const resources = await rt.workbenchEndpoint('project-resources', { projectId: 'p1', view: 'summary' }, bob)
  assert.equal(resources.harnessWorkers, undefined)
  assert.equal(resources.resourceLeases, undefined)
  assert.equal(resources.taskExecution[0].taskId, 'card')
  assert.equal(rt.state.tasks.card.result, 'large private audit')
  rt.state.tasks.card.collaboration = { status: 'claimed', claim: { status: 'active', workerId: 'native-test' } }
  rt.state.bots['native-test'] = { id: 'native-test', projectId: 'p1' }
  rt.activityView = () => ({ 'native-test': { turn: 1 } })
  assert.equal((await rt.workbenchEndpoint('project-resources', { projectId: 'p1', view: 'summary' }, bob)).taskExecution[0].phase, 'running')
  rt.activityView = () => ({})
  assert.equal((await rt.workbenchEndpoint('project-resources', { projectId: 'p1', view: 'summary' }, bob)).taskExecution[0].phase, 'starting', 'stored Bot existence is not execution evidence')
})

test('queue recovery reaches live HTTP manager checks and cannot borrow a forged body identity', async t => {
  const rt = await setup(t)
  rt.state.tasks.queued = { id: 'queued', projectId: 'p1', requesterId: 'bob', status: 'open', projectTaskKind: 'decision' }
  rt.state.projectQueue = { q: { id: 'q', projectId: 'p1', taskId: 'queued', memberId: 'bob', status: 'blocked', requestId: 'original', reason: 'Missing dependencies' } }
  rt.state.projectAttempts = { busy1: { projectId: 'p1', status: 'running', id: 'busy1' }, busy2: { projectId: 'p1', status: 'running', id: 'busy2' } }
  rt.projectScheduler = createProjectScheduler(rt, { preflight: async () => ({}) })
  rt.authenticate = async () => bob
  const payload = { queueId: 'q', memberId: 'owner-1', projectId: 'p2' }
  const denied = await rt.testHttp('project-queue-retry', payload)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'bot/forbidden')
  assert.equal(rt.state.projectQueue.q.status, 'blocked')
  rt.authenticate = async () => alice
  const allowed = await rt.testHttp('project-queue-retry', payload)
  assert.equal(allowed.ok, true)
  assert.equal(allowed.value.queue.memberId, 'bob')
  assert.equal(allowed.value.queue.projectId, 'p1')
  assert.equal(allowed.value.queue.recoveries[0].by, 'owner-1')
  await rt.projectScheduler.wake()
  assert.equal(rt.state.projectQueue.q.status, 'waiting')
})

test('development v1 reaches HTTP authorization, preserves legacy details and refuses forged commands', async t => {
  const rt = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Service boundary' }, alice)
  rt.authenticate = async () => bob
  const query = { version: 'project-development/v1', kind: 'query', name: 'task', projectId: 'p1', payload: { taskId: task.id } }
  const result = await rt.testHttp('project-development', query)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.value.result.task.phase, 'awaiting-chief')
  assert.deepEqual(result.value.result.task.nextActions, [])
  assert.equal((await rt.projectEndpoint('project-task-detail', { taskId: task.id }, bob)).view.taskId, task.id)
  const wrongProject = await rt.testHttp('project-development', { ...query, projectId: 'p2' })
  assert.equal(wrongProject.error.code, 'bot/forbidden')
  const command = await rt.testHttp('project-development', { ...query, kind: 'command', name: 'chief.inspect', requestId: 'r', payload: { memberId: alice.memberId } })
  assert.equal(command.error.code, 'bot/forbidden')
  rt.readOnly = () => 'Read replica'
  assert.equal((await rt.testHttp('project-development', query)).ok, true)
  assert.equal((await rt.testHttp('project-development', { ...query, kind: 'command', name: 'task.run', requestId: 'r' })).error.code, 'bot/read-only')
  rt.state.projects.p1.roles.members = []
  assert.equal((await rt.testHttp('project-development', query)).error.code, 'bot/forbidden')
})


test('Project execution principal is server-derived rather than the caller session field', async t => {
  const rt = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p1', title: 'Scoped admission', criteria: 'Principal remains scoped', impact: 'Project correctness', sessionId: 'forged-session' }, { ...bob, sessionId: 'authenticated-session' })
  assert.equal(rt.state.tasks[task.id].projectTask.executionRequester.memberId, bob.memberId)
  assert.equal(rt.state.tasks[task.id].projectTask.executionRequester.sessionId, 'authenticated-session')
})

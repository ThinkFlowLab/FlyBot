import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const owner = { memberId: 'owner' }
const maintainer = { memberId: 'maintainer' }
const member = { memberId: 'member' }
async function setup(t, previous) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-lifecycle-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(previous ?? {
    version: 2, mainBotIds: ['chief'], members: { owner: { id: 'owner' }, maintainer: { id: 'maintainer' }, member: { id: 'member' }, outsider: { id: 'outsider' } },
    bots: { chief: { id: 'chief', name: 'Chief', ownerId: 'owner', sessionId: 'chief', createdAt: 1, projectId: 'p' } },
    projects: { p: { id: 'p', name: 'Project', repository: 'example/original', ownerUserId: 'owner', status: 'active', createdAt: 1, updatedAt: 1, roles: { maintainers: ['maintainer'], members: ['member'] } } },
    rooms: {}, tasks: {}, projectRuns: {}, exchanges: [], exchangeTurns: {}, agents: {},
    projectMemory: { p: { decisions: [{ text: 'Keep shared history' }], questions: [] } },
  }))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  const rt = createRuntime(ctx, { home, projectWorkbench: true })
  rt.testHttp = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers: { 'x-flybot-member-session': 'test-session' }, body: JSON.stringify({ endpoint, payload }) }))).json()
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, home }
}

test('repository associations support zero/many projects and preserve legacy selection and task identity', async t => {
  const { rt, home } = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'chief', projectId: 'p', title: 'Original task' }, member)
  const old = await rt.projectEndpoint('project-repositories', { projectId: 'p' }, member)
  assert.deepEqual(old.repositories.map(row => row.repository), ['example/original'])
  await rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: 'example/second', defaultBranch: 'develop' }, maintainer)
  await rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: 'example/second', defaultBranch: 'develop' }, maintainer)
  assert.equal((await rt.projectEndpoint('project-repositories', { projectId: 'p' }, member)).repositories.length, 2)
  const second = rt.createProject({ name: 'Shared repository', repository: 'example/second', ownerUserId: 'owner' })
  const empty = rt.createProject({ name: 'No repository', ownerUserId: 'owner' })
  assert.equal((await rt.projectEndpoint('project-repositories', { projectId: second.id }, owner)).repositories.length, 1)
  assert.deepEqual((await rt.projectEndpoint('project-repositories', { projectId: empty.id }, owner)).repositories, [])
  await rt.projectEndpoint('project-repository-unlink', { projectId: 'p', repository: 'example/second' }, owner)
  assert.equal(rt.readProject('p').repository, 'example/original')
  assert.equal(rt.state.tasks[task.id].projectId, 'p')
  await rt.save()
  const restarted = await setup(t, JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
  assert.equal((await restarted.rt.projectEndpoint('project-repositories', { projectId: 'p' }, member)).repositories.length, 1)
})

test('only Owner confirms closure, unfinished work is recorded without deleting memory or task history', async t => {
  const { rt, home } = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'chief', projectId: 'p', title: 'Unfinished task' }, member)
  const suggestion = await rt.projectEndpoint('project-close-request', { projectId: 'p', reason: 'Project no longer needed' }, maintainer)
  assert.equal(suggestion.request.requestedBy, 'maintainer')
  await assert.rejects(rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Keep final record' }, maintainer), /owner|denied/i)
  const prepared = await rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Keep final record' }, owner)
  assert.equal(rt.readProject('p').status, 'active')
  assert.ok(!JSON.stringify(rt.state).includes(prepared.confirmationToken))
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, maintainer), /owner|denied/i)
  const closed = await rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, owner)
  assert.equal(closed.project.status, 'closed')
  assert.equal(closed.project.closure.finalRecord, 'Keep final record')
  assert.deepEqual(closed.project.closure.unfinishedTasks.map(row => row.id), [task.id])
  assert.ok(rt.state.projectMemory.p)
  assert.equal(rt.state.tasks[task.id].status, task.status)
  assert.equal(rt.readProject('p').repository, 'example/original')
  assert.equal((await rt.projectEndpoint('project-read', { id: 'p' }, member)).project.closure.finalRecord, 'Keep final record')
  await assert.rejects(rt.taskEndpoint('task-create', { botId: 'chief', projectId: 'p', title: 'No new work' }, member), /denied|archived|closed/i)
  await assert.rejects(rt.projectEndpoint('project-delete', { id: 'p' }, owner), /closed|history|denied/i)
  assert.equal((await rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, owner)).already, true)
  const restarted = await setup(t, JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
  assert.equal(restarted.rt.readProject('p').closure.finalRecord, 'Keep final record')
})

test('closure confirmation rejects changed, expired and foreign challenges and rechecks current ownership', async t => {
  const { rt } = await setup(t)
  const first = await rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'First record' }, owner)
  const second = await rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Second record' }, owner)
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: first.confirmationToken }, owner), /confirmation|conflict/i)
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: second.confirmationToken, memberId: 'owner' }, { memberId: 'outsider' }), /denied|owner/i)
  rt.state.projects.p.closeConfirmation.expiresAt = 0
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: second.confirmationToken }, owner), /expired|confirmation/i)
  assert.equal(rt.readProject('p').status, 'active')
})

test('repository commands validate permissions and schema before changing records', async t => {
  const { rt } = await setup(t)
  const before = JSON.stringify(rt.state.projectRepositories)
  await assert.rejects(rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: 'example/other', memberId: 'owner' }, member), /denied/i)
  await assert.rejects(rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: '../bad' }, owner), /repository/i)
  await assert.rejects(rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: 'example/other', defaultBranch: '-bad' }, owner), /branch/i)
  assert.equal(JSON.stringify(rt.state.projectRepositories), before)
})

test('primary repository can be removed after its work ends, and empty associations stay empty after reload', async t => {
  const { rt, home } = await setup(t)
  const task = await rt.taskEndpoint('task-create', { botId: 'chief', projectId: 'p', title: 'Pinned work' }, member)
  await assert.rejects(rt.projectEndpoint('project-repository-unlink', { projectId: 'p', repository: 'example/original' }, owner), /unfinished/)
  await assert.rejects(rt.taskEndpoint('task-cancel', { id: task.id }, owner), /Chief/)
  const { cancelTask } = await import('../src/host/project-task-lifecycle.js')
  cancelTask(rt.state.tasks[task.id], { id: 'cancel-fixture', taskId: task.id, projectId: 'p', executorRole: 'chief', runId: 'chief-fixture', initiatedBy: owner.memberId, reason: 'Scoped cancellation fixture after judgement' })
  await rt.save()
  await rt.projectEndpoint('project-repository-unlink', { projectId: 'p', repository: 'example/original' }, owner)
  assert.equal(rt.readProject('p').repository, null)
  const restarted = await setup(t, JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
  assert.deepEqual((await restarted.rt.projectEndpoint('project-repositories', { projectId: 'p' }, member)).repositories, [])
})

test('multi-repository creation validates everything before writing and preserves project goal/scope', async t => {
  const { rt } = await setup(t)
  const before = Object.keys(rt.state.projects)
  assert.throws(() => rt.createProject({ name: 'Invalid', repositories: [{ repository: 'example/valid' }, { repository: 'bad' }] }), /Repository/)
  assert.throws(() => rt.createProject({ name: 'Invalid', repository: 'example/valid', defaultBranch: '-invalid' }), /branch/)
  assert.deepEqual(Object.keys(rt.state.projects), before)
  const project = rt.createProject({ name: 'Two', ownerUserId: 'owner', goal: 'Shared outcome', scope: 'Two repositories', repositories: [{ repository: 'example/one', defaultBranch: 'develop' }, { repository: 'example/two' }] })
  assert.equal(project.repository, 'example/one')
  assert.equal(project.defaultBranch, 'develop')
  assert.equal((await rt.projectEndpoint('project-read', { id: project.id }, owner)).project.goal, 'Shared outcome')
  assert.equal((await rt.projectEndpoint('project-repositories', { projectId: project.id }, owner)).repositories.length, 2)
})

test('closure rejects delegated confirmation, changed project state and disabled owners', async t => {
  const { rt } = await setup(t)
  const prepared = await rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Final' }, owner)
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, { ...owner, agentId: 'personal-agent' }), /personally/)
  rt.state.projects.p.name = 'Changed project'
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, owner), /conflicts/)
  rt.state.members.owner.status = 'disabled'
  await assert.rejects(rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Final' }, owner), /denied/)
})

test('failed durable closure save restores active state and preserves the prior confirmation', async t => {
  const { rt } = await setup(t)
  const prepared = await rt.projectEndpoint('project-close-prepare', { projectId: 'p', finalRecord: 'Final' }, owner)
  const save = rt.save
  rt.save = async () => { throw new Error('Injected disk failure') }
  await assert.rejects(rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, owner), /disk failure/)
  assert.equal(rt.readProject('p').status, 'active')
  assert.equal(rt.readProject('p').closure, undefined)
  rt.save = save
  assert.equal((await rt.projectEndpoint('project-close-confirm', { projectId: 'p', confirmationToken: prepared.confirmationToken }, owner)).project.status, 'closed')
})


test('new endpoints traverse authenticated HTTP and the restricted gateway allowlist', async t => {
  const { rt } = await setup(t)
  const { WORKBENCH_ENDPOINTS } = await import('../src/host/workbench-gateway.js')
  for (const endpoint of ['project-repositories', 'project-repository-link', 'project-repository-unlink', 'project-close-request', 'project-close-prepare', 'project-close-confirm']) assert.ok(WORKBENCH_ENDPOINTS.has(endpoint))
  rt.authenticate = async () => member
  const query = await rt.testHttp('project-repositories', { projectId: 'p' })
  assert.equal(query.ok, true, JSON.stringify(query.error))
  assert.equal(query.value.repositories.length, 1)
  const refused = await rt.testHttp('project-close-prepare', { projectId: 'p', finalRecord: 'Unauthorized', memberId: 'owner' })
  assert.equal(refused.ok, false)
  rt.authenticate = async () => owner
  const prepared = await rt.testHttp('project-close-prepare', { projectId: 'p', finalRecord: 'HTTP closure' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared.error))
  const closed = await rt.testHttp('project-close-confirm', { projectId: 'p', confirmationToken: prepared.value.confirmationToken })
  assert.equal(closed.ok, true, JSON.stringify(closed.error))
  assert.equal(closed.value.project.status, 'closed')
  rt.authenticate = async () => null
  assert.equal((await rt.testHttp('project-repositories', { projectId: 'p' })).ok, false)
})

test('read-only hosts retain association queries but refuse mutation through direct and HTTP paths', async t => {
  const { rt } = await setup(t)
  rt.authenticate = async () => owner
  rt.readOnly = () => 'Injected read-only host'
  assert.equal((await rt.testHttp('project-repositories', { projectId: 'p' })).ok, true)
  assert.equal((await rt.testHttp('project-close-prepare', { projectId: 'p', finalRecord: 'No write' })).error.code, 'bot/read-only')
  await assert.rejects(rt.projectEndpoint('project-repository-link', { projectId: 'p', repository: 'example/no-write' }, owner), /read-only/)
  assert.equal(rt.projectLifecycle.list('p').length, 1)
})

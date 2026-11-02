import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const alice = { memberId: 'alice' }, bob = { memberId: 'bob' }
async function setup(t, data) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-personal-agents-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(data ?? { version: 2, members: { alice: { id: 'alice' }, bob: { id: 'bob' } }, bots: {}, mainBotIds: [], rooms: {}, tasks: {}, agents: {}, exchanges: [], exchangeTurns: {}, projectRuns: {},
    projects: { p1: { id: 'p1', name: 'First', status: 'active', ownerUserId: 'alice', roles: { maintainers: [], members: ['bob'] } }, p2: { id: 'p2', name: 'Second', status: 'active', ownerUserId: 'alice' } } }))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  const rt = createRuntime(ctx, { home, projectWorkbench: true })
  rt.testHttp = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers: { 'x-flybot-member-session': 'test-session' }, body: JSON.stringify({ endpoint, payload }) }))).json()
  await rt.load()
  let sequence = 0
  rt.createBot = async spec => { const id = `carrier-${++sequence}`; const bot = { ...spec, id, sessionId: id, createdAt: Date.now() }; rt.state.bots[id] = bot; rt.indexSessions?.(); return bot }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, home }
}
const api = (rt, endpoint, body = {}, actor = alice) => rt.projectEndpoint(endpoint, body, actor)

test('personal agents exist independently of projects and one identity participates in two isolated scopes', async t => {
  const { rt } = await setup(t)
  const created = await api(rt, 'personal-agent-create', { name: 'My agent' })
  assert.equal(created.agent.ownerId, 'alice')
  assert.equal(created.agent.projectId, undefined)
  const agentId = created.agent.id
  const one = await api(rt, 'personal-agent-join', { agentId, projectId: 'p1' })
  const two = await api(rt, 'personal-agent-join', { agentId, projectId: 'p2' })
  assert.equal(one.participation.agentId, two.participation.agentId)
  assert.notEqual(one.participation.id, two.participation.id)
  assert.notEqual(one.participation.carrierId, two.participation.carrierId)
  assert.equal((await api(rt, 'personal-agent-list')).agents.length, 1)
  assert.deepEqual((await api(rt, 'personal-agent-list', {}, bob)).agents, [])
})

test('membership and agent ownership are revalidated and body identities grant nothing', async t => {
  const { rt } = await setup(t)
  const agentId = (await api(rt, 'personal-agent-create', { name: 'Bob agent', ownerId: 'alice' }, bob)).agent.id
  assert.equal((await api(rt, 'personal-agent-read', { agentId }, bob)).agent.ownerId, 'bob')
  await api(rt, 'personal-agent-join', { agentId, projectId: 'p1' }, bob)
  await assert.rejects(api(rt, 'personal-agent-join', { agentId, projectId: 'p2', memberId: 'alice' }, bob), /denied/)
  await assert.rejects(api(rt, 'personal-agent-read', { agentId }, alice), /own|denied/)
  rt.state.projects.p1.roles.members = []
  await assert.rejects(api(rt, 'personal-agent-default', { agentId, projectId: 'p1' }, bob), /denied/)
})

test('default choice selects one participation without combining notes or transcripts', async t => {
  const { rt } = await setup(t)
  const first = (await api(rt, 'personal-agent-create', { name: 'First' })).agent
  const second = (await api(rt, 'personal-agent-create', { name: 'Second' })).agent
  const one = (await api(rt, 'personal-agent-join', { agentId: first.id, projectId: 'p1' })).participation
  const two = (await api(rt, 'personal-agent-join', { agentId: second.id, projectId: 'p1' })).participation
  rt.state.projectAgentMemory ??= {}
  rt.state.projectAgentMemory[one.carrierId] = [{ text: 'First private note' }]
  await api(rt, 'personal-agent-default', { agentId: second.id, projectId: 'p1' })
  assert.equal(rt.projectAgents.privateIdentity('p1', 'alice'), two.carrierId)
  assert.deepEqual(rt.state.projectAgentMemory[one.carrierId], [{ text: 'First private note' }])
  assert.equal(rt.state.projectAgentMemory[two.carrierId], undefined)
})

test('legacy project-specific identities keep IDs, histories and private memory during migration and reload', async t => {
  const { rt } = await setup(t)
  const data = structuredClone(rt.state)
  data.projectAgents = { old1: { id: 'old1', visibility: 'private', memberId: 'alice', projectId: 'p1', botId: 'b1', sessionId: 's1' }, old2: { id: 'old2', visibility: 'private', memberId: 'alice', projectId: 'p2', botId: 'b2', sessionId: 's2' } }
  data.projectAgentMemory = { old1: [{ text: 'Project one private' }], old2: [{ text: 'Project two private' }] }
  data.projectAgentTranscripts = { old1: [{ text: 'Original conversation' }] }
  data.bots = { b1: { id: 'b1', ownerId: 'alice', sessionId: 's1' }, b2: { id: 'b2', ownerId: 'alice', sessionId: 's2' } }
  const migrated = await setup(t, data)
  const one = migrated.rt.state.projectAgents.old1, two = migrated.rt.state.projectAgents.old2
  assert.ok(one.personalAgentId)
  assert.equal(one.personalAgentId, two.personalAgentId)
  assert.equal(one.sessionId, 's1')
  assert.equal(migrated.rt.projectAgents.privateIdentity('p1', 'alice'), 'old1')
  assert.deepEqual(migrated.rt.state.projectAgentMemory, data.projectAgentMemory)
  assert.deepEqual(migrated.rt.state.projectAgentTranscripts, data.projectAgentTranscripts)
  const restarted = await setup(t, JSON.parse(readFileSync(join(migrated.home, 'state.json'), 'utf8')))
  assert.equal(restarted.rt.state.projectAgents.old1.personalAgentId, one.personalAgentId)
})

test('external agent registration records an identity without pretending provider authentication succeeded', async t => {
  const { rt } = await setup(t)
  const created = await api(rt, 'personal-agent-create', { name: 'External agent', kind: 'external', provider: 'custom-bridge', endpoint: 'https://agent.example.com/flybot' })
  assert.equal(created.agent.connection.status, 'unverified')
  assert.equal(created.agent.botId, undefined)
  const joined = await api(rt, 'personal-agent-join', { agentId: created.agent.id, projectId: 'p1' })
  assert.equal(joined.participation.agentId, created.agent.id)
  assert.equal(rt.state.bots[joined.participation.carrierId], undefined)
})

test('leaving or retiring an agent fences its carrier and watch grant without revoking another agent', async t => {
  const { rt } = await setup(t)
  const one = (await api(rt, 'personal-agent-create', { name: 'One' })).agent
  const two = (await api(rt, 'personal-agent-create', { name: 'Two' })).agent
  const p1 = (await api(rt, 'personal-agent-join', { agentId: one.id, projectId: 'p1' })).participation
  const p2 = (await api(rt, 'personal-agent-join', { agentId: two.id, projectId: 'p1' })).participation
  const carrier = { id: p1.carrierId, personalAgentId: one.id, participationId: p1.id, memberId: 'alice', projectId: 'p1' }
  rt.state.projectAgentGrants = { g1: { id: 'g1', agentId: p1.carrierId, status: 'active', generation: 1 }, g2: { id: 'g2', agentId: p2.carrierId, status: 'active', generation: 1 } }
  rt.state.projectAgentTranscripts = { [p1.carrierId]: [{ text: 'Original private conversation' }] }
  await api(rt, 'personal-agent-leave', { agentId: one.id, projectId: 'p1' })
  assert.throws(() => rt.personalAgents.requireParticipation(carrier), /unavailable/)
  assert.throws(() => rt.personalAgents.ensure('p1', 'alice'), /explicitly rejoin/)
  assert.equal(rt.state.projectAgentGrants.g1.status, 'revoked')
  assert.equal(rt.state.projectAgentGrants.g2.status, 'active')
  assert.equal((await api(rt, 'personal-agent-history', { agentId: one.id, projectId: 'p1' })).items[0].text, 'Original private conversation')
  await api(rt, 'personal-agent-join', { agentId: one.id, projectId: 'p1' })
  assert.equal(rt.state.projectAgentGrants.g1.status, 'revoked')
  await api(rt, 'personal-agent-retire', { agentId: one.id })
  assert.equal(rt.state.personalAgents[two.id].status, 'active')
  assert.equal((await api(rt, 'personal-agent-history', { agentId: one.id, projectId: 'p1' })).items.length, 1)
})


test('native HTTP reaches personal identity permissions and refuses anonymous or delegated registration', async t => {
  const { rt } = await setup(t)
  rt.authenticate = async () => alice
  const created = await rt.testHttp('personal-agent-create', { name: 'HTTP identity', ownerId: 'bob' })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  assert.equal(created.value.agent.ownerId, 'alice')
  rt.authenticate = async () => bob
  assert.equal((await rt.testHttp('personal-agent-read', { agentId: created.value.agent.id })).ok, false)
  rt.authenticate = async () => null
  assert.equal((await rt.testHttp('personal-agent-list', {})).ok, false)
  await assert.rejects(api(rt, 'personal-agent-create', { name: 'Delegated impersonation' }, { ...alice, agentId: 'claimed-agent' }), /user session/)
  rt.authenticate = async () => alice
  rt.readOnly = () => 'Read-only host'
  assert.equal((await rt.testHttp('personal-agent-list', {})).ok, true)
  assert.equal((await rt.testHttp('personal-agent-create', { name: 'No write' })).error.code, 'bot/read-only')
})

test('registration validation and failed saves do not leave partial identities or participation changes', async t => {
  const { rt } = await setup(t)
  for (const body of [{ name: '' }, { name: 'Bad', kind: 'unknown' }, { name: 'Bad', kind: 'external', provider: 'custom', endpoint: 'http://agent.example.com' }, { name: 'Bad', kind: 'external', provider: 'custom', endpoint: 'https://token@agent.example.com' }]) await assert.rejects(api(rt, 'personal-agent-create', body))
  assert.deepEqual((await api(rt, 'personal-agent-list')).agents, [])
  const agent = (await api(rt, 'personal-agent-create', { name: 'Durable identity' })).agent
  const save = rt.save
  rt.save = async () => { throw new Error('Injected save failure') }
  await assert.rejects(api(rt, 'personal-agent-create', { name: 'Unsaved identity' }), /save failure/)
  await assert.rejects(api(rt, 'personal-agent-join', { agentId: agent.id, projectId: 'p1' }), /save failure/)
  assert.deepEqual((await api(rt, 'personal-agent-participations')).participations, [])
  rt.save = save
  assert.equal((await api(rt, 'personal-agent-list')).agents.length, 1)
})

test('failed participation save never restores an unrelated grant revoked concurrently', async t => {
  const { rt } = await setup(t)
  const agent = (await api(rt, 'personal-agent-create', { name: 'Current agent' })).agent
  rt.state.projectAgentGrants = { unrelated: { id: 'unrelated', status: 'active', generation: 1 } }
  const save = rt.save
  rt.save = async () => {
    rt.state.projectAgentGrants.unrelated.status = 'revoked'
    rt.state.projectAgentGrants.unrelated.generation++
    throw new Error('Injected concurrent save failure')
  }
  await assert.rejects(api(rt, 'personal-agent-join', { agentId: agent.id, projectId: 'p1' }), /save failure/)
  rt.save = save
  assert.equal(rt.state.projectAgentGrants.unrelated.status, 'revoked')
  assert.deepEqual((await api(rt, 'personal-agent-participations')).participations, [])
})

test('existing native Project agent APIs carry one personal identity across isolated project sessions', async t => {
  const { rt } = await setup(t)
  const one = await api(rt, 'project-agents', { projectId: 'p1' })
  const two = await api(rt, 'project-agents', { projectId: 'p2' })
  assert.ok(one.mine.personalAgentId)
  assert.equal(one.mine.personalAgentId, two.mine.personalAgentId)
  assert.notEqual(one.mine.sessionId, two.mine.sessionId)
  await api(rt, 'project-agent-memory-write', { projectId: 'p1', text: 'Only project one' })
  const other = await api(rt, 'project-agents', { projectId: 'p2' })
  assert.deepEqual(other.privateMemory, [])
  assert.equal((await api(rt, 'personal-agent-list')).agents.length, 1)
})

test('rollback does not undo a newer revocation of the same grant', async t => {
  const { rt } = await setup(t)
  const agent = (await api(rt, 'personal-agent-create', { name: 'Retiring agent' })).agent
  const participation = (await api(rt, 'personal-agent-join', { agentId: agent.id, projectId: 'p1' })).participation
  rt.state.projectAgentGrants = { g: { id: 'g', agentId: participation.carrierId, status: 'active', generation: 1 } }
  const save = rt.save
  rt.save = async () => { rt.state.projectAgentGrants.g.generation++; throw new Error('Concurrent revocation') }
  await assert.rejects(api(rt, 'personal-agent-retire', { agentId: agent.id }), /revocation/)
  rt.save = save
  assert.equal(rt.state.personalAgents[agent.id].status, 'active')
  assert.equal(rt.state.projectAgentGrants.g.status, 'revoked')
  assert.equal(rt.state.projectAgentGrants.g.generation, 3)
})

test('pagination is owner-scoped and rejects foreign cursors and unbounded reads', async t => {
  const { rt } = await setup(t)
  const one = (await api(rt, 'personal-agent-create', { name: 'One' })).agent
  await api(rt, 'personal-agent-create', { name: 'Two' })
  const foreign = (await api(rt, 'personal-agent-create', { name: 'Bob' }, bob)).agent
  const first = await api(rt, 'personal-agent-list', { limit: 1 })
  assert.ok(first.next)
  const second = await api(rt, 'personal-agent-list', { limit: 1, after: first.next })
  assert.equal(second.agents.length, 1)
  assert.notEqual(second.agents[0].id, first.agents[0].id)
  assert.equal(second.next, null)
  await assert.rejects(api(rt, 'personal-agent-list', { after: foreign.id }), /cursor/)
  await assert.rejects(api(rt, 'personal-agent-list', { limit: 201 }), /Limit/)
  const participation = (await api(rt, 'personal-agent-join', { agentId: one.id, projectId: 'p1' })).participation
  rt.state.projectAgentTranscripts = { [participation.carrierId]: [{ text: 'one' }, { text: 'two' }] }
  const history = await api(rt, 'personal-agent-history', { agentId: one.id, projectId: 'p1', limit: 1 })
  assert.equal(history.nextOffset, 1)
  assert.equal((await api(rt, 'personal-agent-history', { agentId: one.id, projectId: 'p1', offset: history.nextOffset, limit: 1 })).items[0].text, 'two')
  await assert.rejects(api(rt, 'personal-agent-history', { agentId: one.id, projectId: 'p1', limit: 101 }), /page/)
})

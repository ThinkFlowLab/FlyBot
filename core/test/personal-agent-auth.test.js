import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const alice = { memberId: 'alice' }, bob = { memberId: 'bob' }
async function setup(t, prior) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-agent-auth-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(prior ?? { version: 2, members: { alice: { id: 'alice' }, bob: { id: 'bob' } }, bots: { chief: { id: 'chief', ownerId: 'alice', sessionId: 'chief', name: 'Chief', projectId: 'p1' } }, mainBotIds: ['chief'], rooms: {}, tasks: {}, agents: {}, exchanges: [], exchangeTurns: {}, projectRuns: {},
    authSessions: { human: { id: 'human', memberId: 'alice', tokenHash: createHash('sha256').update('test-human-token').digest('hex') } },
    projects: { p1: { id: 'p1', name: 'First', status: 'active', ownerUserId: 'alice', roles: { maintainers: [], members: ['bob'] } }, p2: { id: 'p2', name: 'Second', status: 'active', ownerUserId: 'alice' } } }))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} }, sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  const rt = createRuntime(ctx, { home, projectWorkbench: true })
  await rt.load()
  let sequence = 0
  rt.createBot = async spec => { const id = `carrier-${++sequence}`; const bot = { ...spec, id, sessionId: id, createdAt: Date.now() }; rt.state.bots[id] = bot; rt.indexSessions?.(); return bot }
  const http = async (token, endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers: { 'x-flybot-member-session': token }, body: JSON.stringify({ endpoint, payload }) }))).json()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, home, http, fetch: request => route.fetch(request) }
}
const api = (rt, endpoint, body, actor = alice) => rt.projectEndpoint(endpoint, body, actor)
async function external(rt, actor = alice, projectId = 'p1') {
  const agent = (await api(rt, 'personal-agent-create', { name: 'External HTTP client', kind: 'external', provider: 'contract-fixture', endpoint: 'https://agent.example.com/flybot' }, actor)).agent
  await api(rt, 'personal-agent-join', { agentId: agent.id, projectId }, actor)
  const issued = await api(rt, 'personal-agent-token-create', { agentId: agent.id, projectIds: [projectId] }, actor)
  return { agent, ...issued }
}

test('external credential authenticates the real owner and filters all project reads by participation scope', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt)
  assert.ok(!JSON.stringify(rt.state).includes(connection.token))
  const who = await http(connection.token, 'auth-whoami')
  assert.equal(who.value.memberId, 'alice')
  assert.equal(who.value.agentId, connection.agent.id)
  const projects = await http(connection.token, 'projects')
  assert.deepEqual(projects.value.projects.map(row => row.id), ['p1'])
  assert.equal((await http(connection.token, 'project-read', { id: 'p2', memberId: 'alice' })).ok, false)
  assert.equal((await http(connection.token, 'state')).ok, false)
})

test('safe external agent creates only a private proposal; human approval publishes it', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt)
  assert.equal((await http(connection.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'Unauthorized direct task' })).ok, false)
  const proposed = await http(connection.token, 'personal-agent-propose-task', { projectId: 'p1', title: 'Fix login', criteria: 'Login succeeds', impact: 'Restore account access', scope: 'Login validation', projectTaskKind: 'code', requestId: 'proposal-1' })
  assert.equal(proposed.ok, true, JSON.stringify(proposed.error))
  assert.equal(proposed.value.proposal.fields.impact, 'Restore account access')
  assert.equal(proposed.value.proposal.fields.scope, 'Login validation')
  assert.equal(Object.keys(rt.state.tasks).length, 0)
  assert.equal((await http(connection.token, 'project-agent-proposal-apply', { projectId: 'p1', proposalId: proposed.value.proposal.id })).ok, false)
  const approved = await api(rt, 'project-agent-proposal-apply', { projectId: 'p1', proposalId: proposed.value.proposal.id })
  assert.equal(approved.task.requesterId, 'alice')
  assert.equal(approved.task.personalAgentSource.agentId, connection.agent.id)
  assert.equal(rt.state.tasks[approved.task.id].personalAgentSource.agentId, connection.agent.id)
  assert.equal(rt.state.tasks[approved.task.id].projectTask.requirements.impact, 'Restore account access')
  const replay = await http(connection.token, 'personal-agent-propose-task', { projectId: 'p1', title: 'Fix login', criteria: 'Login succeeds', impact: 'Restore account access', scope: 'Login validation', projectTaskKind: 'code', requestId: 'proposal-1' })
  assert.equal(replay.value.proposal.id, proposed.value.proposal.id)
})

test('watch uses existing scoped delegation and current membership, but cannot confirm closure or grant itself rights', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt)
  await api(rt, 'personal-agent-delegation-set', { agentId: connection.agent.id, projectId: 'p1', mode: 'watch' })
  const created = await http(connection.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'Authorized code task' })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  assert.equal(created.value.personalAgentSource.agentId, connection.agent.id)
  assert.equal((await http(connection.token, 'project-close-prepare', { projectId: 'p1', finalRecord: 'Agent cannot confirm' })).ok, false)
  assert.equal((await http(connection.token, 'personal-agent-token-create', { agentId: connection.agent.id, projectIds: ['p2'] })).ok, false)
  await api(rt, 'personal-agent-delegation-set', { agentId: connection.agent.id, projectId: 'p1', mode: 'safe' })
  assert.equal((await http(connection.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'No longer allowed' })).ok, false)
  assert.ok(rt.state.tasks[created.value.id])
})

test('revocation, expiry, disabled users and removal invalidate credentials while human sessions remain separate', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt)
  await api(rt, 'personal-agent-token-revoke', { credentialId: connection.credential.id })
  assert.equal((await http(connection.token, 'projects')).ok, false)
  assert.equal((await http('test-human-token', 'projects')).ok, true)
  const expired = await external(rt)
  rt.state.personalAgentCredentials[expired.credential.id].expiresAt = 0
  assert.equal((await http(expired.token, 'projects')).ok, false)
  const disabled = await external(rt)
  rt.state.members.alice.status = 'disabled'
  assert.equal((await http(disabled.token, 'projects')).ok, false)
})

test('a member agent cannot use body owner claims, foreign projects or another agent’s token', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt, bob)
  await api(rt, 'personal-agent-delegation-set', { agentId: connection.agent.id, projectId: 'p1', mode: 'watch' }, bob)
  const denied = await http(connection.token, 'project-quota', { id: 'p1', maxConcurrent: 8, memberId: 'alice', role: 'owner' })
  assert.equal(denied.ok, false)
  await assert.rejects(api(rt, 'personal-agent-token-create', { agentId: connection.agent.id, projectIds: ['p2'] }, bob), /denied/)
  await assert.rejects(api(rt, 'personal-agent-token-revoke', { credentialId: connection.credential.id }), /own|denied/)
  rt.state.projects.p1.roles.members = []
  assert.equal((await http(connection.token, 'project-read', { id: 'p1' })).ok, false)
})

test('agent tokens survive process reload without borrowing a browser session and logout revokes only that connection', async t => {
  const { rt, home, http } = await setup(t)
  const connection = await external(rt)
  const reloaded = await setup(t, JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')))
  assert.equal((await reloaded.http(connection.token, 'projects')).ok, true)
  assert.equal((await http(connection.token, 'auth-revoke')).ok, true)
  assert.equal((await http(connection.token, 'projects')).ok, false)
  assert.equal((await http('test-human-token', 'projects')).ok, true)
})


test('member personal agents may suggest closure without obtaining Owner confirmation rights', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt, bob)
  const suggestion = await http(connection.token, 'project-close-request', { projectId: 'p1', reason: 'Suggest recording final results' })
  assert.equal(suggestion.ok, true, JSON.stringify(suggestion.error))
  assert.equal(suggestion.value.request.personalAgentId, connection.agent.id)
  assert.equal(rt.readProject('p1').status, 'active')
  assert.equal((await http(connection.token, 'project-close-confirm', { projectId: 'p1', confirmationToken: 'invented' })).ok, false)
})

test('mode changes cannot be smuggled through v1 and token scope does not follow default-agent selection', async t => {
  const { rt, http } = await setup(t)
  const one = await external(rt)
  const two = await external(rt)
  await api(rt, 'personal-agent-delegation-set', { agentId: one.agent.id, projectId: 'p1', mode: 'watch' })
  const smuggled = await http(one.token, 'project-development', { version: 'project-development/v1', projectId: 'p1', kind: 'command', name: 'agent.mode', requestId: 'self-grant', payload: { mode: 'watch', personalAgentId: two.agent.id } })
  assert.equal(smuggled.ok, false)
  assert.equal((await http(two.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'No transferred grant' })).ok, false)
  await api(rt, 'personal-agent-default', { projectId: 'p1', agentId: two.agent.id })
  assert.equal((await http(two.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'Still no grant' })).ok, false)
  assert.equal((await http(one.token, 'project-agent-history', { projectId: 'p1', visibility: 'private' })).ok, false)
  assert.equal((await http(one.token, 'project-agents', { projectId: 'p1' })).ok, false)
})

test('credential and proposal validation reject bad scope, expiry, replay intent and failed issuance persistence', async t => {
  const { rt, http } = await setup(t)
  const one = await external(rt)
  await assert.rejects(api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: ['p1'], ttlSeconds: 0 }), /TTL/)
  await assert.rejects(api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: [] }), /scopes/)
  await assert.rejects(api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: ['p2'] }), /participation/)
  const credentials = Object.keys(rt.state.personalAgentCredentials)
  const save = rt.save
  rt.save = async () => { throw new Error('Injected disk failure') }
  await assert.rejects(api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: ['p1'] }), /disk failure/)
  assert.deepEqual(Object.keys(rt.state.personalAgentCredentials), credentials)
  rt.save = save
  const payload = { projectId: 'p1', title: 'Intent', criteria: 'Verify it', projectTaskKind: 'code', requestId: 'same-intent' }
  assert.equal((await http(one.token, 'personal-agent-propose-task', payload)).ok, true)
  assert.equal((await http(one.token, 'personal-agent-propose-task', { ...payload, title: 'Changed intent' })).error.code, 'bot/conflict')
  rt.state.personalAgentCredentials[one.credential.id].tokenHash = 'corrupt'
  assert.equal((await http(one.token, 'projects')).ok, false)
})

test('credential revocation does not revoke another connection and agent retirement fences all its tokens', async t => {
  const { rt, http } = await setup(t)
  const one = await external(rt)
  const another = await api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: ['p1'] })
  await api(rt, 'personal-agent-token-revoke', { credentialId: one.credential.id })
  assert.equal((await http(another.token, 'projects')).ok, true)
  const listed = await api(rt, 'personal-agent-token-list', { agentId: one.agent.id })
  assert.ok(!JSON.stringify(listed).includes(another.token))
  assert.ok(!JSON.stringify(listed).includes('tokenHash'))
  await api(rt, 'personal-agent-retire', { agentId: one.agent.id })
  assert.equal((await http(another.token, 'projects')).ok, false)
})


test('an external TCP HTTP client authenticates and submits authorized work without a browser session', async t => {
  const fixture = await setup(t)
  const agent = (await api(fixture.rt, 'personal-agent-create', { name: 'Wire client', kind: 'external', provider: 'controlled-client', endpoint: 'https://agent.example.com' })).agent
  await api(fixture.rt, 'personal-agent-join', { agentId: agent.id, projectId: 'p1' })
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const result = await fixture.fetch(new Request(`http://127.0.0.1:${server.address().port}/api/bot`, { method: 'POST', headers: request.headers, body: Buffer.concat(chunks) }))
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(await result.text())
    } catch { response.writeHead(500); response.end('{}') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const post = async (token, endpoint, payload) => (await fetch(`http://127.0.0.1:${server.address().port}/api/bot`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flybot-Member-Session': token }, body: JSON.stringify({ endpoint, payload }) })).json()
  const issued = await post('test-human-token', 'personal-agent-token-create', { agentId: agent.id, projectIds: ['p1'] })
  assert.equal(issued.ok, true)
  assert.deepEqual((await post(issued.value.token, 'projects', {})).value.projects.map(row => row.id), ['p1'])
  await post('test-human-token', 'personal-agent-delegation-set', { agentId: agent.id, projectId: 'p1', mode: 'watch' })
  const task = await post(issued.value.token, 'task-create', { projectId: 'p1', botId: 'chief', title: 'Wire-authorized task' })
  assert.equal(task.ok, true, JSON.stringify(task.error))
  assert.equal(task.value.personalAgentSource.agentId, agent.id)
  const saved = JSON.parse(readFileSync(join(fixture.home, 'state.json'), 'utf8'))
  assert.equal(saved.tasks[task.value.id].personalAgentSource.agentId, agent.id)
  assert.ok(!JSON.stringify(saved).includes(issued.value.token))
})

test('credential pages are bounded and malformed or future credential protocols fail closed', async t => {
  const { rt, http } = await setup(t)
  const one = await external(rt)
  await api(rt, 'personal-agent-token-create', { agentId: one.agent.id, projectIds: ['p1'] })
  const first = await api(rt, 'personal-agent-token-list', { agentId: one.agent.id, limit: 1 })
  const second = await api(rt, 'personal-agent-token-list', { agentId: one.agent.id, limit: 1, after: first.next })
  assert.equal(first.credentials.length, 1)
  assert.notEqual(first.credentials[0].id, second.credentials[0].id)
  assert.equal(second.next, null)
  await assert.rejects(api(rt, 'personal-agent-token-list', { agentId: one.agent.id, limit: 201 }), /limit/)
  await assert.rejects(api(rt, 'personal-agent-token-list', { agentId: one.agent.id, after: 'foreign-cursor' }), /cursor/)
  const credential = rt.state.personalAgentCredentials[one.credential.id]
  const expiresAt = credential.expiresAt
  credential.expiresAt = 'malformed'
  assert.equal((await http(one.token, 'projects')).ok, false)
  credential.expiresAt = expiresAt
  credential.version = 'future/v2'
  assert.equal((await http(one.token, 'projects')).ok, false)
})

test('safe external consultation uses the authenticated agent mailbox and cannot borrow another agent history', async t => {
  const { rt, http } = await setup(t)
  rt.deliver = async ({ sessionId, exchangeId }) => rt.projectAgents.onEvent({ id: sessionId }, { type: 'exchange/start', data: { exchangeId } })
  const connection = await external(rt)
  const response = await http(connection.token, 'project-consultation-ask', { projectId: 'p1', requestId: 'safe-question', text: 'What is the shared project goal?' })
  assert.equal(response.ok, true, JSON.stringify(response))
  assert.equal(response.value.consultation.agentId, connection.agent.id)
  assert.equal(response.value.consultation.initiativeTransferred, false)
  assert.equal(Object.keys(rt.state.tasks).length, 0)
  const other = await external(rt)
  const query = { projectId: 'p1', consultationId: response.value.consultation.id, agentId: connection.agent.id }
  assert.equal((await http(other.token, 'project-consultation-get', query)).ok, false)
  assert.equal((await http(connection.token, 'project-consultation-get', query)).ok, true)
  const envelope = await http(connection.token, 'project-development', { version: 'project-development/v1', kind: 'query', projectId: 'p1', name: 'consultation.get', payload: { consultationId: query.consultationId } })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.result.consultation.id, query.consultationId)
  assert.equal((await http(connection.token, 'project-consultation-ask', { ...query, projectId: 'p2', requestId: 'foreign-question', text: 'Cross project?' })).ok, false)
  await api(rt, 'personal-agent-token-revoke', { credentialId: connection.credential.id, agentId: connection.agent.id })
  assert.equal((await http(connection.token, 'project-consultation-get', query)).ok, false)
})

test('Chief contacts a selected personal agent first; safe suggestions require human approval and watch replies use existing input admission', async t => {
  const { rt, http } = await setup(t)
  const connection = await external(rt)
  await api(rt, 'personal-agent-default', { projectId: 'p1', agentId: connection.agent.id })
  rt.projectChiefControl.requireJobActor = actor => { assert.equal(actor.chiefJobId, 'test-chief-run') }
  const task = { id: 't', projectId: 'p1', requesterId: 'alice', title: 'Implement the selected solution', status: 'open', collaboration: { status: 'blocked', initiatedBy: 'alice', history: [], generation: 1 } }
  rt.state.tasks.t = task
  const ask = async (id, requiresHuman = false) => {
    const recipient = rt.projectAgents.contactUser(task, { id, reason: 'Which approved option should we use?', requiresHuman }, { memberId: 'alice', chiefJobId: 'test-chief-run' })
    task.chiefQuestion = { decisionId: id, reason: 'Which option?', recipient }
    await rt.save()
    return recipient
  }
  const recipient = await ask('decision-one')
  assert.equal(recipient.kind, 'personal-agent')
  assert.equal(recipient.agentId, connection.agent.id)
  const inbox = await http(connection.token, 'project-consultation-list', { projectId: 'p1' })
  assert.equal(inbox.value.items[0].direction, 'incoming')
  assert.equal(inbox.value.items[0].linkedTaskId, 't')
  const answer = { projectId: 'p1', consultationId: recipient.consultationId, requestId: 'one-answer', text: 'Choose the smaller approved change', publish: true }
  const safe = await http(connection.token, 'project-consultation-reply', answer)
  assert.equal(safe.ok, true, JSON.stringify(safe))
  assert.equal(safe.value.published, false)
  assert.equal(safe.value.requiresUserApproval, true)
  assert.equal(Object.keys(rt.state.projectTaskInputs ?? {}).length, 0)
  const approved = await api(rt, 'project-consultation-reply', { ...answer, agentId: connection.agent.id })
  assert.equal(approved.published, true)
  assert.equal((await api(rt, 'project-consultation-reply', { ...answer, agentId: connection.agent.id })).input.id, approved.input.id)
  assert.equal(Object.keys(rt.state.projectTaskInputs).length, 1)
  assert.equal(task.collaboration.status, 'blocked', 'Explicit advice is new input; Chief still decides the next execution')
  await api(rt, 'personal-agent-delegation-set', { projectId: 'p1', agentId: connection.agent.id, mode: 'watch' })
  const second = await ask('decision-two')
  const watched = await http(connection.token, 'project-consultation-reply', { ...answer, consultationId: second.consultationId })
  assert.equal(watched.ok, true, JSON.stringify(watched))
  assert.equal(watched.value.published, true)
  const third = await ask('decision-personal', true)
  const personalOnly = await http(connection.token, 'project-consultation-reply', { ...answer, consultationId: third.consultationId })
  assert.equal(personalOnly.value.published, false)
  assert.equal(personalOnly.value.requiresUserApproval, true)
  assert.equal(task.status, 'open')
  assert.equal(Object.keys(rt.state.tasks).length, 1)
})

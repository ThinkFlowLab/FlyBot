// #1836: the Project role switch is a write the channel already dispatches (`channel.js`) and the
// store already implements (`store.js`), so on a host with a member session the only missing piece
// was its line in authz's explicit `TASK_ENDPOINTS` list — the third of the family after #1713
// (`project-board`) and #1759 (`project-assistant-owner`). Before the fix the gate answered
// `bot/not-found: Unknown endpoint project-role` before the handler could run.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { install as installAuthz } from '../src/host/authz.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'maint-1': { id: 'maint-1', createdAt: 2 },
    'plain-1': { id: 'plain-1', createdAt: 3 },
  },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  authSessions: { 's-m': { memberId: 'maint-1', tokenHash: 'm' } },
  projects: {
    'project-p1': {
      id: 'project-p1',
      name: 'P1',
      repository: 'ThinkFlowLab/FlyBot',
      defaultBranch: 'main',
      ownerUserIds: ['owner-1'],
      createdAt: 1,
      updatedAt: 1,
      status: 'active',
      roles: { maintainers: ['maint-1'], members: ['plain-1'] },
    },
  },
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-role-authz-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  // One member has signed in, so the gate is enforced: the actor comes from the session cookie only.
  rt.authenticate = async (token) => {
    if (token === 'tok-maint') return { memberId: 'maint-1' }
    if (token === 'tok-owner') return { memberId: 'owner-1' }
    if (token === 'tok-plain') return { memberId: 'plain-1' }
    return null
  }
  rt.state.authSessions = { 's-m': { memberId: 'maint-1', tokenHash: 'm' } }
  const callAs = async (endpoint, payload, token) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-flybot-member-session': token }) },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, callAs, stop, home }
}

test('#1836: a signed-in maintainer may use the role switch, and the new role is saved', async () => {
  const { callAs, stop, home } = await start()
  try {
    const answer = await callAs('project-role', { id: 'project-p1', role: 'member' }, 'tok-maint')
    assert.notEqual(answer.error?.code, 'bot/not-found', `the endpoint is not missing from authz: ${JSON.stringify(answer)}`)
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(answer.value.changed, true)
    assert.deepEqual(answer.value.roles, { maintainers: [], members: ['plain-1', 'maint-1'] })
    // The write lands where the page reads it, and it is on disk, not only in the reply.
    const read = await callAs('projects', {}, 'tok-maint')
    assert.equal(read.ok, true, JSON.stringify(read))
    assert.equal(read.value.projects.find(project => project.id === 'project-p1').role, 'member')
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.deepEqual(saved.projects['project-p1'].roles, { maintainers: [], members: ['plain-1', 'maint-1'] })
  } finally { await stop() }
})

test('#1836: a maintainer still cannot re-role another member, and the record does not move', async () => {
  const { rt, callAs, stop } = await start()
  try {
    const before = JSON.stringify(rt.state.projects['project-p1'])
    const answer = await callAs('project-role', { id: 'project-p1', memberId: 'plain-1', role: 'maintainer' }, 'tok-maint')
    assert.notEqual(answer.error?.code, 'bot/not-found', `the endpoint is not missing from authz: ${JSON.stringify(answer)}`)
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.deepEqual({ changed: answer.value.changed, reason: answer.value.reason }, { changed: false, reason: 'not-owner' })
    assert.equal(JSON.stringify(rt.state.projects['project-p1']), before, 'the roles are byte-identical')
  } finally { await stop() }
})

test('#1836: the role switch still needs a signed-in actor', async () => {
  const { callAs, stop } = await start()
  try {
    const answer = await callAs('project-role', { id: 'project-p1', role: 'member' })
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'bot/unauthorized')
    assert.equal(answer.error.message, 'Sign in first')
  } finally { await stop() }
})

// The root cause as an invariant, so the fourth occurrence is a red check and not a person: a name
// `channel.js` dispatches must not be `bot/not-found: Unknown endpoint` at the gate. The gate may
// allow it or refuse it with a reason (`bot/forbidden`, `bot/unauthorized`, ...) — it may not say
// it never heard of a name the channel hands it. Every case label of the one `switch (endpoint)`,
// not only the `project-*` ones, and every violation is reported at once: a fail-fast would take
// one missing name per red run. No server, no disk: the gate is a pure function over this state.
test('#1836: no endpoint the channel dispatches answers Unknown endpoint at the gate', () => {
  const channel = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const labels = [...new Set([...channel.matchAll(/^ {8}case '([a-z][a-z0-9-]*)':/gm)].map(match => match[1]))]
  assert.ok(labels.length >= 100, `the switch's cases are read, not guessed: ${labels.length}`)
  assert.ok(labels.includes('project-role'), 'the case this issue is about is among them')
  const rt = {
    state: {
      authSessions: { 's-1': { memberId: 'maint-1', tokenHash: 'a' } },
      members: { 'maint-1': { id: 'maint-1', createdAt: 1 }, 'other-1': { id: 'other-1', createdAt: 2 } },
      bots: {}, rooms: {}, projects: {}, tasks: {}, questions: {},
    },
  }
  installAuthz(rt)
  const actor = { memberId: 'maint-1' }
  const answers = new Map(labels.map(name => [name, rt.authorize(actor, name, {}) ?? {}]))
  const violations = [...answers].filter(([, answer]) => answer.code === 'bot/not-found')
    .map(([name, answer]) => `${name} -> ${answer.code}: ${answer.message}`)
  assert.deepEqual(violations, [], 'dispatched endpoints the gate does not know')
  // The three answers the gate may give, so the check above is not a tautology: it allows some and
  // refuses others with a reason, and only the third shape is a violation.
  assert.ok([...answers.values()].some(answer => answer.ok === true), 'some cases answer ALLOW')
  assert.ok([...answers.values()].some(answer => answer.ok !== true && answer.code !== 'bot/not-found'), 'some cases refuse with a reason')
  // Not vacuous: a name the channel does not dispatch still reads as unknown.
  const stranger = rt.authorize(actor, 'no-such-endpoint', {})
  assert.equal(stranger.code, 'bot/not-found')
  assert.equal(stranger.message, 'Unknown endpoint no-such-endpoint')
})

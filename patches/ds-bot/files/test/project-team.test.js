// #1864: the Project board's team dossier. One read-only `project-team` endpoint answers, for the
// Project's Chief, its assistant and the pool members the Project names, the persona (`instructions`),
// the memory head and topic names, and the attached skills — capped, and with a missing Bot as a
// `null` row instead of an error for the whole answer.
//
// Before the slice the host answered `Unknown endpoint project-team` before any handler ran, so the
// first two tests are the red half: they call the endpoint through the same route the browser uses.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { install } from '../src/host/project-team.js'
import { fakeContext } from './fake-ctx.js'

const LONG = 'x'.repeat(5000)

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['bot-chief'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'bot-chief' },
    'peer-1': { id: 'peer-1', createdAt: 2 },
  },
  bots: {
    'bot-chief': {
      id: 'bot-chief', name: 'Project Chief (FlyBot)', role: 'Project Chief', sessionId: 'bot-chief',
      createdAt: 11, ownerId: 'owner-1', model: 'deepseek-chat', color: '#112233',
      instructions: 'You are the Project Chief of FlyBot.', capabilities: ['ship-it'],
    },
    'bot-assistant': {
      id: 'bot-assistant', name: 'Project Assistant (FlyBot)', role: 'Project Assistant', sessionId: 'bot-assistant',
      createdAt: 12, ownerId: 'owner-1', model: 'deepseek-chat', color: '#445566',
      instructions: 'You are the Project Assistant of FlyBot.', capabilities: ['ship-it', 'not-a-skill'],
    },
    'bot-dev': {
      id: 'bot-dev', name: 'Dev', role: 'Dev', sessionId: 'bot-dev',
      createdAt: 13, ownerId: 'owner-1', model: 'deepseek-reasoner', color: '#778899',
      instructions: 'You implement issues.', capabilities: [],
    },
  },
  rooms: {
    r1: { id: 'r1', name: 'FlyBot dev', members: ['bot-chief', 'bot-dev'], mode: 'admin', admin: 'bot-chief', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-1' },
    r2: { id: 'r2', name: 'Far Project room', members: ['bot-dev'], mode: 'admin', admin: 'bot-dev', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-2' },
  },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  capabilities: {
    items: {
      'ship-it': { name: 'ship-it', kind: 'skill', description: 'Ship things' },
      'not-a-skill': { name: 'not-a-skill', kind: 'mcp', description: 'Not a skill' },
    },
  },
  projects: {
    'project-1': {
      id: 'project-1', name: 'FlyBot', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main',
      ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active',
      chief: { botId: 'bot-chief', sessionId: 'bot-chief', createdAt: 1 },
      assistant: { botId: 'bot-assistant', sessionId: 'bot-assistant', createdAt: 1 },
      roles: { maintainers: ['bot-dev'], members: ['bot-gone'] },
    },
    'project-2': {
      id: 'project-2', name: 'Far', repository: null, defaultBranch: 'main',
      ownerUserId: 'owner-1', createdAt: 2, updatedAt: 2, status: 'active',
    },
  },
})

const memory = (home, botId, head, topics = []) => {
  const dir = join(home, 'memory', 'bots', botId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), head)
  for (const topic of topics) writeFileSync(join(dir, `${topic}.md`), `- a fact about ${topic}\n`)
}

async function start({ signedIn = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-team-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  memory(home, 'bot-chief', 'The Chief remembers the Project.\n', ['travel', 'work'])
  memory(home, 'bot-assistant', 'The assistant remembers the board.\n', ['board'])
  memory(home, 'bot-dev', 'Dev memory.\n')
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
  const callAs = async (endpoint, payload, token) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-flybot-member-session': token }) },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  if (signedIn) {
    rt.authenticate = async token => (token === 'tok-owner' ? { memberId: 'owner-1' } : null)
    rt.state.authSessions = { 's-owner': { memberId: 'owner-1', tokenHash: 'o' } }
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { callAs, home, rt, stop }
}

const ROW_KEYS = ['botId', 'color', 'createdAt', 'memory', 'model', 'name', 'persona', 'role', 'rooms', 'skills']

test('project-team answers persona, memory and skills for the Chief, the assistant and the pool', async (t) => {
  const { callAs, stop } = await start()
  t.after(stop)
  const answer = await callAs('project-team', { id: 'project-1' })
  assert.equal(answer.ok, true, 'the endpoint is dispatched through the channel, not Unknown endpoint')
  const rows = answer.value.rows
  assert.equal(rows.length, 4, 'Chief, assistant and the two pool members, in that order')
  assert.deepEqual(rows.slice(0, 3).map(row => row.botId), ['bot-chief', 'bot-assistant', 'bot-dev'])
  assert.equal(rows[3], null, 'a pool member whose Bot is gone is a null row, not an error')

  const chief = rows[0]
  assert.deepEqual(Object.keys(chief).sort(), ROW_KEYS, 'exactly the documented keys, no secret-bearing field')
  assert.equal(chief.name, 'Project Chief (FlyBot)')
  assert.equal(chief.role, 'Project Chief')
  assert.equal(chief.model, 'deepseek-chat')
  assert.equal(chief.color, '#112233')
  assert.equal(chief.createdAt, 11)
  assert.equal(chief.persona, 'You are the Project Chief of FlyBot.', 'persona is the Bot instructions')
  assert.deepEqual(chief.memory, { head: 'The Chief remembers the Project.\n', topics: ['travel', 'work'] })
  assert.deepEqual(chief.skills, ['ship-it'], 'only attached skills, not every attached capability')
  assert.deepEqual(chief.rooms, [{ id: 'r1', name: 'FlyBot dev' }], 'only this Project\'s rooms')

  assert.deepEqual(rows[1].memory, { head: 'The assistant remembers the board.\n', topics: ['board'] })
  assert.deepEqual(rows[1].skills, ['ship-it'])
  assert.deepEqual(rows[2].rooms, [{ id: 'r1', name: 'FlyBot dev' }], 'the far Project\'s room is not listed')
})

test('project-team caps persona, memory head and topics', async (t) => {
  const { callAs, home, rt, stop } = await start()
  t.after(stop)
  rt.state.bots['bot-chief'].instructions = LONG
  memory(home, 'bot-chief', LONG, Array.from({ length: 70 }, (_, at) => `topic-${String(at).padStart(2, '0')}`))
  const rows = (await callAs('project-team', { id: 'project-1' })).value.rows
  assert.equal(rows[0].persona.length, 4000, 'persona is capped at 4000 characters')
  assert.equal(rows[0].memory.head.length, 4000, 'the memory head is capped at 4000 characters')
  assert.equal(rows[0].memory.topics.length, 64, 'at most 64 topic names')
})

test('a deleted Chief is a null row while the rest of the team still answers', async (t) => {
  const { callAs, rt, stop } = await start()
  t.after(stop)
  delete rt.state.bots['bot-chief']
  const rows = (await callAs('project-team', { id: 'project-1' })).value.rows
  assert.equal(rows[0], null, 'the missing Chief is null')
  assert.equal(rows[1].botId, 'bot-assistant', 'the assistant still answers')
  assert.equal(rows[2].botId, 'bot-dev', 'the pool still answers')
})

test('project-team reads with the project-read class of caller, including a signed-in member', async (t) => {
  const { callAs, stop } = await start({ signedIn: true })
  t.after(stop)
  const answer = await callAs('project-team', { id: 'project-1' }, 'tok-owner')
  assert.equal(answer.ok, true, 'the endpoint belongs beside project-read in authz, not behind the owner gate')
  assert.equal(answer.value.rows[0].botId, 'bot-chief')
  const unknown = await callAs('project-team', { id: 'project-none' }, 'tok-owner')
  assert.deepEqual(unknown.value.rows, [], 'an unknown Project answers no rows instead of an error')
})

// #1979: a group name is text another home supplied, and its 200-unit bound must not end on the
// first half of a surrogate pair.
test('project-team cuts a room name from another home at 200 without splitting an emoji', async (t) => {
  const { callAs, rt, stop } = await start()
  t.after(stop)
  const name = 'a'.repeat(199) + '😀' + 'tail'
  rt.state.rooms.r1.name = name
  const rows = (await callAs('project-team', { id: 'project-1' })).value.rows
  const kept = rows[0].rooms.find(room => room.id === 'r1').name
  assert.equal(kept.isWellFormed(), true, 'the group name is well formed, never a lone high surrogate')
  assert.equal(kept, 'a'.repeat(199), 'the 200th unit was the first half of the pair, so the pair is dropped, not split')
  assert.ok(name.startsWith(kept), 'a code-point prefix of the group name')
  assert.ok(kept.length <= 200, 'the budget of 200 UTF-16 units is unchanged')
})

// #2005: `capped()` bounds the name, role, persona, model and color of a dossier row, and every
// one of those bounds must land on a code point. A bot name whose 200th unit is the first half of
// an emoji used to reach the panel as an unpaired surrogate.
test('#2005: project-team caps a bot name at a code point, never inside an emoji', async (t) => {
  const { callAs, rt, stop } = await start()
  t.after(stop)
  rt.state.bots['bot-chief'].name = `${'a'.repeat(199)}😀`
  const rows = (await callAs('project-team', { id: 'project-1' })).value.rows
  assert.equal(rows[0].name.isWellFormed(), true, 'the name is well formed, never a lone high surrogate')
  assert.equal(rows[0].name, 'a'.repeat(199), 'the 200th unit was the first half of the pair, so the pair is dropped whole')
})

// #2005: the dossier's memory head is bounded at 4,000 units, and that bound must land on a code
// point too; a memory file whose 4,000th unit is the first half of an emoji used to reach the
// panel as half a character.
test('#2005: project-team cuts the memory head at a code point, never inside an emoji', async (t) => {
  const { callAs, home, stop } = await start()
  t.after(stop)
  memory(home, 'bot-chief', `${'a'.repeat(3999)}😀`)
  const rows = (await callAs('project-team', { id: 'project-1' })).value.rows
  assert.equal(rows[0].memory.head.isWellFormed(), true, 'the head is well formed, never a lone high surrogate')
  assert.equal(rows[0].memory.head, 'a'.repeat(3999), 'the 4,000th unit was the first half of the pair, so the pair is dropped whole')
})

// #2005: the head is bounded twice on purpose — once where `memoryDigest` reads it, and once in the
// dossier row itself, which is where the module promises that every string it answers is capped. The
// second bound cannot be reached through the reader (a 4,000-unit head is already well formed), so it
// is pinned by a direct call that hands the module a 4,001-unit head itself.
test('#2005: project-team cuts a head handed to it directly at a code point', () => {
  const head = `${'a'.repeat(3999)}😀`
  const rt = {
    state: { rooms: {} },
    readProject: () => ({ id: 'project-1', chief: { botId: 'bot-chief' }, assistant: { botId: '' }, maintainers: [], members: [] }),
    botOf: id => (id === 'bot-chief' ? { id, name: 'Chief', role: 'Chief', instructions: '', model: 'deepseek-chat', color: '#112233', capabilities: [], createdAt: 1 } : null),
    memoryDigest: () => ({ head, topics: [] }),
  }
  install(rt)
  const row = rt.projectTeam('project-1').rows[0]
  assert.equal(head.length, 4001, 'the caller handed the dossier 4,001 units')
  assert.equal(row.memory.head.isWellFormed(), true, 'the head is well formed, never a lone high surrogate')
  assert.equal(row.memory.head, 'a'.repeat(3999), 'the pair at the bound is dropped whole instead of keeping its first half')
})

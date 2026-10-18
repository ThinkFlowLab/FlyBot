import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { CONNECTOR_IDS, connectorOfTool } from '../src/host/connector-access.js'
import { sharedWith } from '../src/host/reach.js'
import { fakeContext } from './fake-ctx.js'

// #335: the connector tools are mounted once for the whole DSH profile; each Bot sees them only
// when its owner turned that connector on for it, and never while it is shared with anyone.

const COMPOSIO = ['mcp__composio__COMPOSIO_SEARCH_TOOLS', 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL']
const GITHUB = ['mcp__github__create_issue', 'mcp__github__get_me']
const OWN = ['read', 'ask_user']

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { writer: 'room-writer' }, admin: 'chief', mode: 'everyone' } },
  agents: { dsh: { id: 'dsh', name: 'DSH Agent', sessions: ['plain'], createdAt: 3 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

// dsh keeps one Agent per Session; restrict() hides tools from that Agent's own list the way the real
// registry does (and refuses a name it does not serve). `served` is the profile's tool list and can
// change while the test runs, as it does when a connector mounts.
async function setup({ state = team() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-connector-access-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const agents = new Map()
  const masks = new Map()
  const live = { served: [...OWN, ...COMPOSIO, ...GITHUB] }
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const hiddenFrom = id => new Set([...(masks.get(id) ?? [])].flatMap(mask => [...mask]).filter(name => connectorOfTool(name) !== undefined))
  const agentFor = async (id, { parent } = {}) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id, header: parent === undefined ? {} : { origin: 'subagent', parentSession: parent } },
      ctx: {
        tools: {
          restrict: ({ deny }) => {
            const unknown = deny.filter(name => !live.served.includes(name))
            if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tools ${unknown.join(', ')}`)
            const mask = new Set(deny)
            masks.set(id, [...(masks.get(id) ?? []), mask])
            ctx.emit('tools/change')
            return () => { masks.set(id, (masks.get(id) ?? []).filter(entry => entry !== mask)); ctx.emit('tools/change') }
          },
        },
        effect: execute => execute(),
      },
    }
    agents.set(id, agent)
    await created(agent)
    return agent
  }
  const allHidden = id => new Set([...(masks.get(id) ?? [])].flatMap(mask => [...mask]))
  ctx.tools.schemas = agent => live.served.filter(name => !allHidden(agent?.id).has(name)).map(name => ({ name }))
  let sessions = 0
  Object.assign(ctx, {
    sessions: { get: id => agents.get(id)?.session },
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `new${++sessions}` }), resolveAgent: async id => ({ agent: await agentFor(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home, github: false, composio: false, diagnosticsFile: false })
  await rt.load()
  const guard = (name, sessionId) => ctx.guards.map(check => check({ name, agent: sessionId === undefined ? undefined : { id: sessionId, session: agents.get(sessionId)?.session } })).find(reason => reason !== undefined)
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, live, agentFor, hiddenFrom, guard, call, stop }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('connector tool names map to their connector, and nothing else does', () => {
  assert.deepEqual(CONNECTOR_IDS, ['github', 'composio'])
  assert.equal(connectorOfTool('mcp__composio__COMPOSIO_SEARCH_TOOLS'), 'composio')
  assert.equal(connectorOfTool('mcp__github__create_issue'), 'github')
  for (const name of ['read', 'ask_user', 'mcp__notes__search', 'mcp__composioish__x', undefined]) assert.equal(connectorOfTool(name), undefined)
})

test('fresh install: a connected connector gives no Bot its tools; the DSH Agent and plain Sessions keep them', async (t) => {
  const { agentFor, hiddenFrom, guard, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) await agentFor(id)
  for (const id of ['chief', 'writer', 'room-writer']) {
    assert.deepEqual([...hiddenFrom(id)].sort(), [...COMPOSIO, ...GITHUB].sort(), id)
  }
  assert.deepEqual([...hiddenFrom('plain')], [])
  assert.deepEqual([...hiddenFrom('elsewhere')], [])
  // The guard refuses a call even where the list was not trimmed, and says how to turn it on.
  for (const name of [...COMPOSIO, ...GITHUB]) assert.match(guard(name, 'writer'), /not turned on for Writer/)
  assert.match(guard(COMPOSIO[0], 'room-writer'), /not turned on for Writer/)
  assert.equal(guard('read', 'writer'), undefined)
  assert.equal(guard(COMPOSIO[0], 'plain'), undefined)
  assert.equal(guard(COMPOSIO[0], 'elsewhere'), undefined)
  assert.equal(guard(COMPOSIO[0], undefined), undefined)
})

test('a Bot the owner turned a connector on for gets that connector only; its other Sessions and other Bots do not', async (t) => {
  const { agentFor, hiddenFrom, guard, call, rt, home, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer']) await agentFor(id)

  const on = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.deepEqual(on.value, { botId: 'writer', connectors: { composio: true } })
  // The list and the guard follow at once, in the Bot's own chat and in its group Session.
  for (const id of ['writer', 'room-writer']) assert.deepEqual([...hiddenFrom(id)].sort(), [...GITHUB].sort(), id)
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined)
  assert.equal(guard(COMPOSIO[1], 'room-writer'), undefined)
  assert.match(guard(GITHUB[0], 'writer'), /github connector is not turned on for Writer/)
  // Chief is another Bot of the same owner: still off.
  assert.deepEqual([...hiddenFrom('chief')].sort(), [...COMPOSIO, ...GITHUB].sort())
  assert.match(guard(COMPOSIO[0], 'chief'), /not turned on for Chief/)
  // It is saved, and the state the client reads carries it.
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.writer.connectors, { composio: true })
  const view = (await call('state', {})).value.bots.find(bot => bot.id === 'writer')
  assert.deepEqual(view.connectors, { composio: true })
  assert.deepEqual(view.sharedWith, [])

  const off = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false })
  assert.equal(off.ok, true)
  assert.equal(rt.botOf('writer').connectors, undefined)
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...COMPOSIO, ...GITHUB].sort())
  assert.match(guard(COMPOSIO[0], 'writer'), /not turned on/)
})

test('a connector that mounts after the Bot\'s Agent was set up is hidden from it too', async (t) => {
  const { ctx, agentFor, hiddenFrom, live, stop } = await setup()
  t.after(stop)
  live.served = [...OWN]
  await agentFor('writer')
  live.served = [...OWN, ...COMPOSIO]
  ctx.emit('tools/change')
  await tick()
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...COMPOSIO].sort())
})

test('a shared Bot gets no connector tools, whatever its switch says', async (t) => {
  const { rt, agentFor, hiddenFrom, guard, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await call('bot-connectors', { botId: 'writer', connector: 'github', enabled: true })
  assert.equal(guard(GITHUB[0], 'writer'), undefined)

  // Sharing the Bot with a friend drops its switches...
  await rt.setGrants('writer', [{ grantee: '@bob.home', name: 'Bob' }])
  assert.equal(rt.botOf('writer').connectors, undefined)
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...COMPOSIO, ...GITHUB].sort())
  assert.match(guard(GITHUB[0], 'writer'), /not turned on for Writer/)
  // ...and turning one on is refused, naming the friend.
  const refused = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Writer is shared with Bob, so it cannot use connectors/)
  assert.equal(rt.botOf('writer').connectors, undefined)
  assert.deepEqual((await call('state', {})).value.bots.find(bot => bot.id === 'writer').sharedWith, ['Bob'])

  // Even a switch that is on in the saved state (an older file, a hand edit) is overruled while shared.
  rt.botOf('writer').connectors = { composio: true, github: true }
  assert.match(guard(COMPOSIO[0], 'writer'), /not available to Writer while it is shared/)
  assert.match(guard(GITHUB[1], 'writer'), /not available to Writer while it is shared/)
  await agentFor('room-writer')
  assert.deepEqual([...hiddenFrom('room-writer')].sort(), [...COMPOSIO, ...GITHUB].sort())
  // The owner's other Bots are unaffected by it.
  await call('bot-connectors', { botId: 'chief', connector: 'composio', enabled: true })
  assert.equal(guard(COMPOSIO[0], 'chief'), undefined)
  // Unsharing does not bring the tools back by itself.
  delete rt.botOf('writer').connectors
  await rt.setGrants('writer', [])
  assert.match(guard(COMPOSIO[0], 'writer'), /not turned on for Writer/)
})

test('a Bot in a room with a friend\'s Bot, another person, another owner\'s Bot or a room code counts as shared', async (t) => {
  const state = team()
  state.rooms.room.participants = [
    { kind: 'human', id: 'owner', role: 'admin', displayName: 'You', joinedSeq: 0 },
    { kind: 'bot', id: 'chief', role: 'member', joinedSeq: 0 },
    { kind: 'bot', id: 'writer', role: 'member', joinedSeq: 0 },
  ]
  for (const bot of Object.values(state.bots)) bot.ownerId = 'owner'
  const alone = structuredClone(state)
  assert.deepEqual(sharedWith(alone, 'writer'), [])
  assert.deepEqual(sharedWith(alone, 'nobody'), [])
  assert.deepEqual(sharedWith({ ...alone, bots: { ...alone.bots, remote1: { id: 'remote1', remote: {} } } }, 'remote1'), [])

  const friend = structuredClone(state)
  friend.rooms.room.participants.push({ kind: 'bot', remote: true, id: '@bob.home', handle: '@bob.home', displayName: 'Bob\u0007 Bot', role: 'member', joinedSeq: 1 })
  assert.deepEqual(sharedWith(friend, 'writer'), ['Bob  Bot'])
  // Someone who left no longer counts.
  friend.rooms.room.participants.at(-1).leftSeq = 5
  assert.deepEqual(sharedWith(friend, 'writer'), [])

  const person = structuredClone(state)
  person.rooms.room.participants.push({ kind: 'human', id: 'ann', role: 'member', displayName: 'Ann', joinedSeq: 1 })
  assert.deepEqual(sharedWith(person, 'writer'), ['Ann'])

  const otherOwner = structuredClone(state)
  otherOwner.bots.chief.ownerId = 'ann'
  otherOwner.bots.writer.ownerId = 'owner'
  assert.deepEqual(sharedWith(otherOwner, 'writer'), ['Chief'])

  const code = structuredClone(state)
  code.rooms.room.participants.find(p => p.id === 'writer').viaCode = true
  assert.deepEqual(sharedWith(code, 'writer'), ['a room joined by code'])

  // And the running guard sees it without a restart: a friend joins the room later.
  const { rt, guard, call, stop } = await setup()
  t.after(stop)
  const owner = rt.botOf('writer').ownerId
  rt.state.rooms.room.participants = [
    { kind: 'human', id: owner, role: 'admin', displayName: 'You', joinedSeq: 0 },
    { kind: 'bot', id: 'chief', role: 'member', joinedSeq: 0 },
    { kind: 'bot', id: 'writer', role: 'member', joinedSeq: 0 },
  ]
  assert.deepEqual(rt.sharedWith('writer'), [])
  assert.equal((await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })).ok, true)
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined)
  rt.state.rooms.room.participants.push({ kind: 'bot', remote: true, id: '@bob.home', handle: '@bob.home', displayName: 'Bob', role: 'member', joinedSeq: 1 })
  assert.match(guard(COMPOSIO[0], 'writer'), /not available to Writer while it is shared/)
  assert.equal((await call('bot-connectors', { botId: 'writer', connector: 'github', enabled: true })).ok, false)
})

test('a sub-agent of a Bot counts as that Bot, and one of the DSH Agent does not', async (t) => {
  const { agentFor, hiddenFrom, guard, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('writer-sub', { parent: 'writer' })
  await agentFor('writer-subsub', { parent: 'writer-sub' })
  await agentFor('plain')
  await agentFor('plain-sub', { parent: 'plain' })
  assert.deepEqual([...hiddenFrom('writer-sub')].sort(), [...COMPOSIO, ...GITHUB].sort())
  assert.match(guard(COMPOSIO[0], 'writer-subsub'), /not turned on for Writer/)
  assert.deepEqual([...hiddenFrom('plain-sub')], [])
  assert.equal(guard(COMPOSIO[0], 'plain-sub'), undefined)
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  assert.equal(guard(COMPOSIO[0], 'writer-sub'), undefined)
  assert.equal(guard(COMPOSIO[0], 'writer-subsub'), undefined)
  assert.deepEqual([...hiddenFrom('writer-sub')].sort(), [...GITHUB].sort())
})

test('the switch endpoint refuses an unknown Bot, connector or value, and a friend\'s Bot', async (t) => {
  const { rt, call, stop } = await setup()
  t.after(stop)
  rt.state.bots.friend = { id: 'friend', name: 'Friend', remote: { handle: '@bob.home' }, createdAt: 3 }
  for (const [payload, message] of [
    [{ botId: 'nobody', connector: 'composio', enabled: true }, /Unknown Bot/],
    [{ botId: 'friend', connector: 'composio', enabled: true }, /Unknown Bot/],
    [{ botId: 'writer', connector: 'slack', enabled: true }, /No such connector/],
    [{ botId: 'writer', connector: 'composio', enabled: 'yes' }, /turn it on or off/],
    [{ botId: 'writer', connector: 'composio' }, /turn it on or off/],
  ]) {
    const result = await call('bot-connectors', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.match(result.error.message, message)
  }
  assert.equal(rt.botOf('writer').connectors, undefined)
})

test('disconnecting a connector turns it off for every Bot, so a new connection starts from off', async (t) => {
  const { rt, agentFor, hiddenFrom, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  await call('bot-connectors', { botId: 'writer', connector: 'github', enabled: true })
  await call('bot-connectors', { botId: 'chief', connector: 'composio', enabled: true })
  assert.deepEqual([...hiddenFrom('writer')], [])
  await rt.forgetConnector('composio')
  assert.deepEqual(rt.botOf('writer').connectors, { github: true })
  assert.equal(rt.botOf('chief').connectors, undefined)
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...COMPOSIO].sort())
})

test('a new Bot and a copy start with every connector off', async (t) => {
  const { rt, call, stop } = await setup()
  t.after(stop)
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  const copy = await rt.duplicateBot('writer')
  assert.equal(copy.connectors, undefined)
  assert.equal(rt.botOf(copy.id).connectors, undefined)
})

test('an Agent whose Bot cannot be determined gets no connector tools, even when the Bot has them on', async (t) => {
  const { agentFor, hiddenFrom, guard, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('plain')
  assert.equal((await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })).ok, true)
  // A sub-agent whose parent Session is gone: the chain cannot be followed, so it may be a shared Bot's.
  await agentFor('orphan', { parent: 'vanished' })
  assert.deepEqual([...hiddenFrom('orphan')].sort(), [...COMPOSIO, ...GITHUB].sort())
  for (const name of [...COMPOSIO, ...GITHUB]) assert.match(guard(name, 'orphan'), /could not be determined/)
  assert.equal(guard('read', 'orphan'), undefined, 'only connector tools are refused')
  // A chain as deep as the cap resolves; one step deeper fails closed instead of reading as a plain Session.
  let parent = 'writer'
  for (let depth = 1; depth <= 8; depth += 1) {
    const id = `writer-d${depth}`
    await agentFor(id, { parent })
    parent = id
    if (depth === 7) {
      assert.equal(guard(COMPOSIO[0], id), undefined, 'seven levels still resolve to Writer, whose composio is on')
      assert.match(guard(GITHUB[0], id), /not turned on for Writer/)
    }
  }
  assert.match(guard(COMPOSIO[0], 'writer-d8'), /could not be determined/)
  assert.deepEqual([...hiddenFrom('writer-d8')].sort(), [...COMPOSIO, ...GITHUB].sort())
  // The same for a deep chain under a plain Session: unknown, not plain.
  let plainParent = 'plain'
  for (let depth = 1; depth <= 8; depth += 1) { await agentFor(`plain-d${depth}`, { parent: plainParent }); plainParent = `plain-d${depth}` }
  assert.equal(guard(COMPOSIO[0], 'plain-d3'), undefined, 'a short chain under a plain Session keeps the tools')
  assert.match(guard(COMPOSIO[0], 'plain-d8'), /could not be determined/)
  // Resolved Agents are unchanged.
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined)
  assert.equal(guard(COMPOSIO[0], 'plain'), undefined)
})

test('the tool list follows a person or friend joining and leaving a room, without a grant change', async (t) => {
  const { rt, agentFor, hiddenFrom, call, stop } = await setup()
  t.after(stop)
  const owner = rt.botOf('writer').ownerId
  rt.state.rooms.room.participants = [
    { kind: 'human', id: owner, role: 'admin', displayName: 'You', joinedSeq: 0 },
    { kind: 'bot', id: 'chief', role: 'member', joinedSeq: 0 },
    { kind: 'bot', id: 'writer', role: 'member', joinedSeq: 0 },
  ]
  await agentFor('writer')
  assert.equal((await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })).ok, true)
  await tick()
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...GITHUB].sort(), 'composio is on for Writer')
  // A friend's Bot joins the room: the tools leave the list at once, not at the next restart.
  rt.state.rooms.room.participants.push({ kind: 'bot', remote: true, id: '@bob.home', handle: '@bob.home', displayName: 'Bob', role: 'member', joinedSeq: 1 })
  await rt.save()
  await tick()
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...COMPOSIO, ...GITHUB].sort(), 'shared through the room: nothing listed')
  // The friend leaves: the owner's switch is still on, so the tools come back.
  rt.state.rooms.room.participants.at(-1).leftSeq = 5
  await rt.save()
  await tick()
  assert.deepEqual([...hiddenFrom('writer')].sort(), [...GITHUB].sort(), 'alone again: composio is listed again')
})

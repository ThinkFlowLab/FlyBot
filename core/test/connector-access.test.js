import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { CONNECTOR_IDS, connectorOfTool } from '../src/host/connector-access.js'
import { fakeContext } from './fake-ctx.js'

// #335, #369, #601: the connector tools are mounted once for the whole DSH profile. Every turn of the
// owner's own Bots has them by default, whatever started the turn (owner decision 2026-10-22); the
// owner can turn a connector off for one Bot, and a friend's Bot never has them.

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
  const sent = []
  const masks = new Map()
  const live = { served: [...OWN, ...COMPOSIO, ...GITHUB] }
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const hiddenFrom = id => new Set([...(masks.get(id) ?? [])].flatMap(mask => [...mask]).filter(name => connectorOfTool(name) !== undefined))
  const agentFor = async (id, { parent } = {}) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      sent,
      followup: message => sent.push(message),
      steer: message => sent.push(message),
      inbox: { nextStep: [], nextTurn: [] },
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
    sessions: { get: id => agents.get(id)?.session, flush: async () => {} },
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
  // What DSH tells the plugin about a Session's turn (turns.js reads whose request it answers from it).
  let turns = 0
  const event = (id, type, data = {}) => ctx.emitArgs('session/event', agents.get(id)?.session ?? { id }, { type, data, time: Date.now() })
  const begin = id => event(id, 'turn/start', { turn: ++turns })
  const take = (id, source, text = 'hello') => event(id, 'user/message', { source, content: [{ type: 'text', text }] })
  const end = id => event(id, 'turn/end', { reason: { kind: 'completed' } })
  // A whole turn that took in these messages first (before the turn began, like a queued message).
  const turn = async (id, ...sources) => {
    await agentFor(id)
    for (const source of sources) take(id, source)
    begin(id)
    return () => end(id)
  }
  return { ctx, rt, home, live, agentFor, hiddenFrom, guard, call, stop, sent, event, begin, take, end, turn }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

const ALL = [...COMPOSIO, ...GITHUB].sort()
const sorted = set => [...set].sort()
const TYPED = { kind: 'user' }
// A friend's Bot wrote to this Bot (Bot Social, through the FlyBot gate).
const FRIEND = { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'f1', senderName: 'Bob', hop: 0, remote: { handle: '@bob.home' }, origin: 'other' }
const REQUEST = (from, origin) => ({ kind: 'bot', form: 'relay', role: 'request', exchangeId: `r-${from}-${origin}`, senderName: from, senderSessionId: from.toLowerCase(), hop: 0, ...(origin ? { origin } : {}) })

test('connector tool names map to their connector, and nothing else does', () => {
  assert.deepEqual(CONNECTOR_IDS, ['github', 'composio'])
  assert.equal(connectorOfTool('mcp__composio__COMPOSIO_SEARCH_TOOLS'), 'composio')
  assert.equal(connectorOfTool('mcp__github__create_issue'), 'github')
  for (const name of ['read', 'ask_user', 'mcp__notes__search', 'mcp__composioish__x', undefined]) assert.equal(connectorOfTool(name), undefined)
})

test('default: a connected connector is on for every Bot, old or new, in its chat, its group Session and its parts; plain Sessions keep it too', async (t) => {
  const { agentFor, hiddenFrom, guard, turn, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) await agentFor(id)
  // Nothing is hidden from anyone, and the saved teams of #346 (no record at all) read as on.
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) assert.deepEqual([...hiddenFrom(id)], [], id)
  for (const id of ['chief', 'writer']) {
    const done = await turn(id, TYPED)
    for (const name of [...COMPOSIO, ...GITHUB]) assert.equal(guard(name, id), undefined, `${id} ${name}`)
    assert.equal(guard('read', id), undefined)
    done()
  }
  // The group Session answers the room's round (stamped as the host's own), in a room of the owner's own Bots.
  const done = await turn('room-writer', { kind: 'bot', form: 'relay', role: 'room', roomId: 'room', exchangeId: 'rr', senderName: 'You', hop: 0, origin: 'owner' })
  assert.equal(guard(COMPOSIO[0], 'room-writer'), undefined)
  done()
  assert.equal(guard(COMPOSIO[0], 'plain'), undefined)
  assert.equal(guard(COMPOSIO[0], 'elsewhere'), undefined)
  assert.equal(guard(COMPOSIO[0], undefined), undefined)
})

test('an older team saved by #346 starts on: no record is on, an explicit off stays off, an explicit on is on', async (t) => {
  const state = team()
  state.bots.chief.connectors = { composio: true }
  state.bots.writer.connectors = { github: false }
  const { agentFor, hiddenFrom, guard, turn, stop } = await setup({ state })
  t.after(stop)
  for (const id of ['chief', 'writer']) await agentFor(id)
  assert.deepEqual([...hiddenFrom('chief')], [])
  assert.deepEqual(sorted(hiddenFrom('writer')), sorted(GITHUB))
  const done = await turn('writer', TYPED)
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined)
  assert.match(guard(GITHUB[0], 'writer'), /github connector is turned off for Writer/)
  done()
})

// Owner decision 2026-10-22 (#601): 「放开，主要应该用连接器工具」. Where a turn came from no longer matters.
test('#601: every turn of the owner\'s own Bot uses the connectors, whoever started it, also outside a turn', async (t) => {
  const { rt, agentFor, hiddenFrom, guard, begin, take, end, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await rt.setGrants('writer', [{ grantee: '@bob.home', name: 'Bob' }])
  const me = rt.botOf('writer').ownerId
  const verdict = (sources) => {
    for (const source of sources) take('writer', source)
    begin('writer')
    const answers = [...COMPOSIO, ...GITHUB].map(name => guard(name, 'writer'))
    const hidden = [...hiddenFrom('writer')]
    end('writer')
    return { answers: answers.filter(answer => answer !== undefined), hidden }
  }
  const open = { answers: [], hidden: [] }
  assert.deepEqual(verdict([TYPED]), open, 'the owner typed it')
  assert.deepEqual(verdict([{ kind: 'user', authorId: me }]), open, 'the owner signed in')
  assert.deepEqual(verdict([{ kind: 'user', authorId: 'ann', authorKind: 'human' }]), open, 'another member typed it')
  assert.deepEqual(verdict([FRIEND]), open, 'a friend wrote to the shared Bot')
  assert.deepEqual(verdict([{ ...FRIEND, form: 'remote-chat', role: 'remote', origin: undefined }]), open, 'a friend\'s line in its chat')
  assert.deepEqual(verdict([REQUEST('Chief')]), open, 'a relay nobody vouched for')
  assert.deepEqual(verdict([REQUEST('Chief', 'other')]), open, 'a Bot that was itself asked by someone else')
  assert.deepEqual(verdict([{ kind: 'schedule' }]), open, 'a scheduled task of a shared Bot')
  assert.deepEqual(verdict([]), open, 'a turn with no recorded origin')
  assert.deepEqual(verdict([{ kind: 'plan-mode' }]), open, 'only notices')
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined, 'outside any turn')
})

test('#601: a group round of any origin keeps the tools, also with a friend in the room', async (t) => {
  const { rt, agentFor, hiddenFrom, guard, begin, take, end, stop } = await setup()
  t.after(stop)
  const owner = rt.botOf('writer').ownerId
  rt.state.rooms.room.participants = [
    { kind: 'human', id: owner, role: 'admin', displayName: 'You', joinedSeq: 0 },
    { kind: 'bot', id: 'chief', role: 'member', joinedSeq: 0 },
    { kind: 'bot', id: 'writer', role: 'member', joinedSeq: 0 },
    { kind: 'bot', remote: true, id: '@bob.home', handle: '@bob.home', displayName: 'Bob', role: 'member', joinedSeq: 1 },
  ]
  await rt.save()
  await agentFor('room-writer')
  for (const origin of ['owner', 'other', undefined]) {
    take('room-writer', { kind: 'bot', form: 'relay', role: 'room', roomId: 'room', exchangeId: `rr-${origin}`, senderName: 'You', hop: 0, ...(origin ? { origin } : {}) })
    begin('room-writer')
    await tick()
    for (const name of [...COMPOSIO, ...GITHUB]) assert.equal(guard(name, 'room-writer'), undefined, `${origin}: ${name}`)
    assert.deepEqual([...hiddenFrom('room-writer')], [], `${origin}: nothing hidden`)
    end('room-writer')
  }
})

test('the owner turns a connector off for one Bot; others follow, and turning it on again removes the record', async (t) => {
  const { agentFor, hiddenFrom, guard, call, rt, home, turn, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer']) await agentFor(id)

  const off = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.deepEqual(off.value, { botId: 'writer', connectors: { composio: false } })
  // The list and the guard follow at once, in the Bot's own chat and in its group Session.
  for (const id of ['writer', 'room-writer']) assert.deepEqual(sorted(hiddenFrom(id)), sorted(COMPOSIO), id)
  const done = await turn('writer', FRIEND)
  assert.match(guard(COMPOSIO[0], 'writer'), /composio connector is turned off for Writer\. Its owner can turn it on/)
  assert.equal(guard(GITHUB[0], 'writer'), undefined, 'the other connector is untouched')
  done()
  // Chief is another Bot of the same owner: still on.
  assert.deepEqual([...hiddenFrom('chief')], [])
  // Saved, and the state the client reads carries it.
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.writer.connectors, { composio: false })
  const view = (await call('state', {})).value.bots.find(bot => bot.id === 'writer')
  assert.deepEqual(view.connectors, { composio: false })

  const on = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: true })
  assert.equal(on.ok, true)
  assert.deepEqual(on.value, { botId: 'writer', connectors: {} })
  assert.equal(rt.botOf('writer').connectors, undefined)
  assert.deepEqual([...hiddenFrom('writer')], [])
})

test('#601: a sub-agent follows its parent Bot in any turn; one of the DSH Agent keeps the tools', async (t) => {
  const { agentFor, hiddenFrom, guard, begin, take, end, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('writer-sub', { parent: 'writer' })
  await agentFor('writer-subsub', { parent: 'writer-sub' })
  await agentFor('plain')
  await agentFor('plain-sub', { parent: 'plain' })
  take('writer', FRIEND)
  begin('writer')
  for (const id of ['writer-sub', 'writer-subsub']) {
    assert.equal(guard(COMPOSIO[0], id), undefined, id)
    assert.deepEqual([...hiddenFrom(id)], [], id)
  }
  end('writer')
  // Turned off for the Bot: the sub-agents lose that connector.
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false })
  assert.deepEqual(sorted(hiddenFrom('writer-subsub')), sorted(COMPOSIO))
  assert.match(guard(COMPOSIO[0], 'writer-sub'), /turned off for Writer/)
  assert.deepEqual([...hiddenFrom('plain-sub')], [])
  assert.equal(guard(COMPOSIO[0], 'plain-sub'), undefined)
})

test('a connector that mounts after the Bot\'s Agent was set up is listed or hidden by the same rule', async (t) => {
  const { ctx, agentFor, hiddenFrom, live, call, stop } = await setup()
  t.after(stop)
  live.served = [...OWN]
  await agentFor('writer')
  await call('bot-connectors', { botId: 'writer', connector: 'github', enabled: false })
  live.served = [...OWN, ...COMPOSIO, ...GITHUB]
  ctx.emit('tools/change')
  await tick()
  assert.deepEqual(sorted(hiddenFrom('writer')), sorted(GITHUB), 'only the connector turned off is hidden as it mounts')
})

test('an Agent whose Bot cannot be determined gets no connector tools, in any turn', async (t) => {
  const { agentFor, hiddenFrom, guard, begin, take, end, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('plain')
  take('writer', TYPED)
  begin('writer')
  // A sub-agent whose parent Session is gone: the chain cannot be followed, so it may be a shared Bot's.
  await agentFor('orphan', { parent: 'vanished' })
  assert.deepEqual(sorted(hiddenFrom('orphan')), ALL)
  for (const name of [...COMPOSIO, ...GITHUB]) assert.match(guard(name, 'orphan'), /could not be determined/)
  assert.equal(guard('read', 'orphan'), undefined, 'only connector tools are refused')
  // A chain as deep as the cap resolves; one step deeper fails closed instead of reading as a plain Session.
  let parent = 'writer'
  for (let depth = 1; depth <= 8; depth += 1) {
    const id = `writer-d${depth}`
    await agentFor(id, { parent })
    parent = id
    if (depth === 7) assert.equal(guard(COMPOSIO[0], id), undefined, 'seven levels still resolve to Writer, in the owner\'s turn')
  }
  assert.match(guard(COMPOSIO[0], 'writer-d8'), /could not be determined/)
  assert.deepEqual(sorted(hiddenFrom('writer-d8')), ALL)
  // The same for a deep chain under a plain Session: unknown, not plain.
  let plainParent = 'plain'
  for (let depth = 1; depth <= 8; depth += 1) { await agentFor(`plain-d${depth}`, { parent: plainParent }); plainParent = `plain-d${depth}` }
  assert.equal(guard(COMPOSIO[0], 'plain-d3'), undefined, 'a short chain under a plain Session keeps the tools')
  assert.match(guard(COMPOSIO[0], 'plain-d8'), /could not be determined/)
  assert.equal(guard(COMPOSIO[0], 'writer'), undefined)
  assert.equal(guard(COMPOSIO[0], 'plain'), undefined)
  end('writer')
})

test('a friend\'s Bot is never given connector tools, and the switch endpoint refuses an unknown Bot, connector or value', async (t) => {
  const { rt, call, agentFor, guard, begin, take, end, stop } = await setup()
  t.after(stop)
  rt.state.bots.friend = { id: 'friend', name: 'Friend', sessionId: 'friend', remote: { handle: '@bob.home' }, createdAt: 3 }
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
  // Even if a friend's Bot's chat somehow ran a turn with the owner typing, the tools are refused.
  rt.chatOwners.set('friend', 'friend')
  await agentFor('friend')
  take('friend', TYPED)
  begin('friend')
  assert.match(guard(COMPOSIO[0], 'friend'), /not available to a friend's Bot/)
  end('friend')
})

test('disconnecting a connector clears every Bot\'s choice for it, so a new connection starts from the default', async (t) => {
  const { rt, agentFor, hiddenFrom, call, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false })
  await call('bot-connectors', { botId: 'writer', connector: 'github', enabled: false })
  assert.deepEqual(sorted(hiddenFrom('writer')), ALL)
  await rt.forgetConnector('composio')
  assert.deepEqual(rt.botOf('writer').connectors, { github: false }, 'the other connector keeps its choice')
  assert.deepEqual(sorted(hiddenFrom('writer')), sorted(GITHUB), 'a new connection is on again')
})

// The "also when others use it" offers saved before #601 mean nothing now; they are dropped on the
// next switch or disconnect, and a client that still sends a scope is not refused.
test('#601: a retired shared-use offer is dropped, and a scope from an older client is ignored', async (t) => {
  const state = team()
  state.bots.writer.connectorsShared = { github: true }
  state.bots.chief.connectorsShared = { composio: true }
  const { rt, call, stop } = await setup({ state })
  t.after(stop)
  const old = await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false, scope: 'shared' })
  assert.equal(old.ok, true, JSON.stringify(old))
  assert.deepEqual(old.value, { botId: 'writer', connectors: { composio: false } })
  assert.equal(rt.botOf('writer').connectorsShared, undefined)
  await rt.forgetConnector('github')
  assert.equal(rt.botOf('chief').connectorsShared, undefined)
})

test('a new Bot and a copy start from the default: on', async (t) => {
  const { rt, call, stop } = await setup()
  t.after(stop)
  await call('bot-connectors', { botId: 'writer', connector: 'composio', enabled: false })
  const copy = await rt.duplicateBot('writer')
  assert.equal(copy.connectors, undefined)
  assert.equal(rt.botOf(copy.id).connectors, undefined)
})

test('relays carry whose request they are: the host\'s own and a same-owner Bot passing the owner on are the owner\'s; a friend, another owner\'s Bot or a Bot that cannot say are not', async (t) => {
  const { rt, agentFor, sent, begin, take, end, stop } = await setup()
  t.after(stop)
  rt.state.bots.other = { id: 'other', sessionId: 'other', name: 'Other', role: 'Else', instructions: '', createdAt: 5, ownerId: 'ann' }
  rt.chatOwners.set('other', 'other')
  await agentFor('chief')
  await agentFor('other')
  const originOf = message => message.source.origin
  // Distinct text per relay: an identical Bot-to-Bot line within a minute is one turn (#641).
  let said = 0
  const relay = async (args) => { sent.length = 0; await rt.deliver({ toId: 'writer', text: `hi ${++said}`, role: 'request', ...args }); return originOf(sent.at(-1)) }

  // The host's own (the user through the UI, a secret card, a group round): the owner's.
  assert.equal(await relay({ role: 'secret' }), 'owner')
  assert.equal(await relay({ role: 'room', roomId: 'room' }), 'owner')
  // A friend's Bot (with a grant, or the FlyBot gate refuses the delivery): someone else's, whatever else it says.
  await rt.setGrants('writer', [{ grantee: '@bob.home', name: 'Bob' }])
  assert.equal(await relay({ fromName: 'Bob', untrusted: true, remote: { handle: '@bob.home' } }), 'other')
  assert.equal(await relay({ fromName: 'Bob', untrusted: true, remote: { handle: '@bob.home' }, origin: 'owner' }), 'other')
  // A Bot of the same owner: what its own running turn answers.
  take('chief', TYPED)
  begin('chief')
  assert.equal(await relay({ fromId: 'chief' }), 'owner')
  assert.equal(rt.agentOrigin({ id: 'chief', session: { id: 'chief' } }), 'owner')
  end('chief')
  take('chief', FRIEND)
  begin('chief')
  assert.equal(await relay({ fromId: 'chief' }), 'other', 'it was asked by a friend itself')
  assert.equal(rt.agentOrigin({ id: 'chief', session: { id: 'chief' } }), 'other')
  assert.equal(await relay({ fromId: 'chief', origin: 'owner' }), 'owner', 'a caller that knows its own turn better says so (message_bot passes the calling Session\'s)')
  end('chief')
  // No running turn to read: fail closed.
  assert.equal(await relay({ fromId: 'chief' }), 'other')
  assert.equal(await relay({ fromId: 'ghost' }), 'other')
  // Another owner's Bot is someone else, even in a turn of its own owner's.
  // (Reach would refuse a Bot of another owner without a grant; the stamp does not rely on it.)
  rt.reach = () => ({ action: 'allow' })
  take('other', TYPED)
  begin('other')
  assert.equal(await relay({ fromId: 'other' }), 'other')
  end('other')
  // A reply or notice at the end of a friend-driven turn is stamped from that turn.
  assert.equal(rt.agentOrigin({ id: 'plain', session: { id: 'plain' } }), 'owner', 'the DSH Agent is the owner\'s')
  assert.equal(rt.agentOrigin({ id: 'nowhere', session: { id: 'nowhere', header: { parentSession: 'vanished' } } }), 'other')
})

test('the running turn notes whose request it answers, so a resumed turn keeps the tools only when it was the owner\'s', async (t) => {
  const { home, agentFor, begin, take, end, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('chief')
  const noted = async () => { await tick(); await tick(); await new Promise(resolve => setTimeout(resolve, 20)); return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')).turns }
  take('writer', TYPED)
  begin('writer')
  take('chief', FRIEND)
  begin('chief')
  const turns = await noted()
  assert.equal(turns.writer.origin, 'owner')
  assert.equal(turns.chief.origin, 'other')
  take('writer', FRIEND)
  assert.equal((await noted()).writer.origin, 'other', 'a friend\'s line later in the turn is noted too')
  end('writer')
  end('chief')
})

// A Main Bot that a friend drives posts into a room of the owner's own Bots. The room's member turns
// and the report that comes back are delivered by the host (no sender), so they used to read as the
// owner's: a friend could reach the owner's connector tools through a post (found in review of #370).
test('a Bot post carries whose request it is into the room\'s member turns and into the report', async (t) => {
  // A real-time wait: a slow runner needs more than a few event-loop turns for a round to start.
  const until = async (done, ms = 10_000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5)) }
  const run = async (source) => {
    const { ctx, rt, agentFor, sent, begin, take, end, stop } = await setup()
    t.after(stop)
    await agentFor('chief')
    await agentFor('room')
    const chief = { id: 'chief', session: { id: 'chief' } }
    take('chief', source)
    begin('chief')
    const posted = await ctx.registeredTools.get('post_to_group').execute({ group: 'room', message: 'please do it', report_back: true }, { agent: chief })
    assert.match(posted, /^Posted in/)
    end('chief')
    const post = sent.find(message => message.source?.role === 'post')
    assert.ok(post, 'the post reached the room Session')
    // The room Session takes the post in, like DSH tells the plugin; the round then relays it.
    take('room', post.source, post.content[0].text)
    const controller = new AbortController()
    const running = ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'room', session: { id: 'room' } }, callId: 'round', signal: controller.signal })
    await until(() => sent.some(message => message.source?.role === 'room'))
    const member = sent.find(message => message.source?.role === 'room')
    assert.ok(member, 'a member turn was delivered')
    controller.abort()
    await running.catch(() => {})
    await until(() => sent.some(message => message.source?.role === 'report'))
    const report = sent.find(message => message.source?.role === 'report')
    assert.ok(report, 'the report came back to the poster')
    return { post: post.source.origin, member: member.source.origin, report: report.source.origin, rt }
  }
  assert.deepEqual(await run(TYPED).then(({ post, member, report }) => ({ post, member, report })), { post: 'owner', member: 'owner', report: 'owner' })
  assert.deepEqual(await run(FRIEND).then(({ post, member, report }) => ({ post, member, report })), { post: 'other', member: 'other', report: 'other' }, 'a friend-driven poster makes the whole round someone else\'s')
})

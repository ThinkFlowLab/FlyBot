import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { stripWrittenCalls, writesToolCall } from '../src/host/turns.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// One DS Bot host on `home`; a second start on the same home is a restart.
// Hosts by home: a home is removed only after its hosts stopped and their writes landed.
const started = new Map()
// The durable Session log per home (what DSH keeps across a plugin reload or a restart).
const durable = new Map()

async function start(home) {
  const ctx = fakeContext()
  const log = durable.get(home) ?? []
  durable.set(home, log)
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      // What the durable log holds for a Session (newest page; the test keeps all of it).
      page: async ({ address } = {}) => ({ records: log.filter(entry => entry.id === address?.sessionId).map(entry => ({ event: entry.event })), hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  // The runtime itself, so a test can hold a write or a delivery open where the product has one.
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  let seq = 0
  const emit = (id, type, data) => {
    const event = { type, seq: ++seq, data }
    log.push({ id, event })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, event)
    }
  }
  // Durable only: an event DSH wrote while no FlyBot host was listening.
  const record = (id, type, data) => { log.push({ id, event: { type, seq: ++seq, data } }) }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const askApproval = sessionId => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox' }, () => 'from-dsh')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await tool('list_bots', {}, 'a')
  const host = { ctx, rt, agentOf, emit, record, tool, call, askApproval, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    durable.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
// Writes to `inflight.json` land on a later tick; after a mock-timer tick and after `stop()` the file
// can still hold the previous write. Wait for them rather than reading early (the note of a failed
// pickup is only proved kept once the clearing write has landed and been replaced).
const flushWrites = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)) }
const text = message => message.content.map(block => block.text ?? '').join('\n')
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
const inflight = home => notes(home).turns ?? {}
// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Starts a round in 'r1' and opens Writer's turn in 'gb'.
async function openRoomTurn(t, host) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  run(host, 'gb', 1, host.agentOf('gb').calls[0])
  return () => result
}

test('a group turn cut off by a restart is picked up once, and the group is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await openRoomTurn(t, first)
  void first.askApproval('gb')
  await settle(() => inflight(home).gb?.approval !== undefined)
  assert.deepEqual([inflight(home).gb.botId, inflight(home).gb.roomId, inflight(home).gb.trigger.role], ['b', 'r1', 'room'])
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('gb').calls.length === 1)
  const post = second.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.resumed, post.source.quiet, post.source.senderSessionId], ['post', true, true, 'b'])
  const resumed = second.agentOf('gb').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.resumed, resumed.source.roomId], ['room', true, 'r1'])
  assert.match(text(resumed), /^\[Group chat "Ops" · picking up after a restart\]/)
  assert.match(text(resumed), /approval to run pwsh \(escalate sandbox\)/)
  await settle(() => Object.keys(inflight(home)).length === 0)

  // The group shows the event, and the admin reads it on its next turn.
  second.emit('r1', 'user/message', { content: post.content, source: post.source })
  const relay = JSON.parse(await second.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  assert.deepEqual(relay.replies.map(reply => [reply.kind, reply.name]), [['resumed', 'Writer']])
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.r1.log.at(-1).kind, 'resumed')

  // Cut off again while picking it up: the group hears it, and the turn stays stopped.
  run(second, 'gb', 2, resumed)
  await settle(() => inflight(home).gb?.resumed === true)
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('r1').calls.length === 1)
  assert.equal(third.agentOf('r1').calls[0].source.again, true)
  assert.equal(third.agentOf('gb').calls.length, 0)
})

test('a request cut off by a restart goes on under the same exchange; own-chat work resumes in the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1 && second.agentOf('a').calls.length === 1)
  const request = second.agentOf('b').calls[0]
  assert.deepEqual([request.source.role, request.source.exchangeId, request.source.senderSessionId, request.source.resumed], ['request', 'x1', 'a', true])
  assert.match(text(request), /^\[Message from Chief · DeepSeek Harness restarted while you were working on it\]/)
  const own = second.agentOf('a').calls[0]
  assert.deepEqual([own.source.role, own.source.resumed], ['resume', true])
  assert.match(text(own), /^\[DeepSeek Harness restarted while you were working\]/)
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.exchanges.length, 0)
})

test('when only DS Bot restarts, a turn still running or finished meanwhile is not picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  // DSH went on: Writer is still at work, and Chief's turn ends before the pick-up.
  const second = await start(home)
  second.agentOf('b').status = 'running'
  second.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  // One read per check: two reads can see the old notes and the cleared ones.
  await settle(() => {
    const noted = inflight(home)
    return noted.b?.trigger?.exchangeId === 'x1' && noted.a === undefined
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])

  // Writer's turn stays noted, so a real restart still picks it up.
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 1)
  assert.deepEqual([third.agentOf('b').calls[0].source.exchangeId, third.agentOf('a').calls.length], ['x1', 0])
})

test('a turn that finished while the plugin was not listening is not picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  // The turn ends while no FlyBot host is listening (a plugin reload, or a crash after DSH
  // appended the end). Only the durable log knows; the note stays in inflight.json.
  first.record('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0, 'the finished turn is not repeated')
})

test('a turn the restart truly cut (interrupted in the durable log) is still picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  first.record('a', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.match(text(second.agentOf('a').calls[0]), /restarted while you were working/)
})

test('a pickup that fails keeps its note for the next start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  await first.stop()

  // The second start cannot hand its pickup over. Hold it inside its delivery: a pickup that
  // cleared its note first has an empty file at this moment, and a crash here loses the note.
  const second = await start(home)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = false
  second.rt.deliver = async () => {
    entered = true
    await gate
    throw new Error('the Session is not ready yet')
  }
  t.mock.timers.tick(3000)
  await settle(() => entered)
  await flushWrites()
  assert.ok(inflight(home).a, 'the note is on disk while the pickup is in flight')
  release()
  await settle(() => inflight(home).a !== undefined)
  await second.stop()
  // `stop()` waits for the note writes, so this reads what is on disk: a note kept only in memory
  // until the next change would be lost by a crash right after the failed pickup.
  assert.ok(inflight(home).a, 'the note is on disk, not only in memory')

  // The third start picks it up.
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('a').calls.length === 1)
  assert.match(text(third.agentOf('a').calls[0]), /restarted while you were working/)
})

test('a resumed turn that writes its own note keeps it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  await first.stop()

  // The resumed turn starts before the pickup is handed over, so it notes the turn it runs now.
  // Handing the pickup over must not clear that newer note.
  const second = await start(home)
  const deliver = second.rt.deliver
  let delivered = false
  second.rt.deliver = async args => {
    if (!delivered) {
      delivered = true
      second.emit('a', 'turn/start', { turn: 7 })
    }
    return deliver(args)
  }
  t.mock.timers.tick(3000)
  await settle(() => delivered)
  await settle(() => second.agentOf('a').calls.length === 1)
  await second.stop()
  assert.equal(inflight(home).a?.turn, 7, 'the note the resumed turn wrote is the one that stays')
})

test('stop waits for the note it just wrote', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  // No wait for the write: a stop that does not wait for it can leave a running turn unnoted, and
  // the next start would not pick it up.
  await host.stop()
  assert.ok(inflight(home).a, 'the note of the running turn is on disk after stop')
})

test('a finished turn leaves nothing to pick up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => Object.keys(inflight(home)).length === 0 && existsSync(join(home, 'inflight.json')))
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a turn DSH stops as it shuts down stays noted; one the user stops does not', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  run(host, 'b', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => inflight(home).a !== undefined && inflight(home).b === undefined)
})

test('a message a shutdown cancelled is sent again once; one still waiting, taken up or withdrawn is not', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const send = message => first.tool('message_bot', { to: 'Writer', message, when: 'queue' }, 'a')
  await send('Draft the plan')
  await send('Check the numbers')
  await send('Read the notes')
  await send('Never mind')
  const [plan, numbers, notesMessage, withdrawn] = first.agentOf('b').calls
  // Taken up by a turn, or withdrawn while DS Bot runs (the user stopped the Bot).
  first.emit('b', 'user/message', { content: notesMessage.content, source: notesMessage.source })
  for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ message: withdrawn })
  await settle(() => (notes(home).queued.b ?? []).length === 2)
  await first.stop()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  // A hard stop keeps the inbox: that message runs when the Session wakes.
  second.agentOf('b').inbox.nextTurn.push(numbers)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.deepEqual([again.source.exchangeId, again.source.role, text(again)], [plan.source.exchangeId, 'request', text(plan)])
  // The resend is the same exchange, not a new one.
  assert.equal((await second.call('exchange', { a: 'a', b: 'b' })).value.length, 4)
})

test('a message sent again is forgotten everywhere once a turn takes it up', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
  await settle(() => (notes(home).queued.b ?? []).length === 1)
  const [plan] = first.agentOf('b').calls
  const { exchangeId } = plan.source
  await first.stop()

  // The second start sends the noted message again, under the same exchange.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.equal(again.source.exchangeId, exchangeId)
  // The turn takes it up. Nothing of that exchange may stay noted: a second copy on disk made
  // every later start send the message once more.
  second.emit('b', 'user/message', { content: again.content, source: again.source })
  const notedExchange = () => Object.values(notes(home).queued ?? {}).flat().filter(item => item?.args?.exchangeId === exchangeId)
  await settle(() => notedExchange().length === 0)
  await second.stop()
  assert.equal(notedExchange().length, 0, 'the exchange a turn took up is still noted on disk')

  // The third start has nothing to send.
  const third = await start(home)
  t.mock.timers.tick(3000)
  await flushWrites()
  assert.equal(third.agentOf('b').calls.length, 0, 'the message was sent a third time')
})

test('a live interrupted end does not drop the note of a turn still owed a pickup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  assert.notEqual(inflight(home).a, undefined, 'the note survives an interrupted end')
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
})

test('a turn/start this process sees proves the noted turn ended, even when the log cannot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).a !== undefined)
  await first.stop()                                  // the crash wrote no turn/end
  const second = await start(home)
  second.emit('a', 'turn/start', { turn: 2 })
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0)
})

const WRITTEN = 'Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>'

test('a tool call written as text gets one more turn on the same round slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Written again: the text goes on without the call.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Checking now.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('in its own chat, a Bot that wrote a tool call as text is asked to make it', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'b', 1, { content: [{ type: 'text', text: 'move the docs' }], source: { kind: 'user' } })
  // A call made for real, with or without text around it, is no retry.
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const retry = host.agentOf('b').calls[0]
  assert.deepEqual([retry.source.role, retry.source.retried], ['retry', true])
  assert.match(text(retry), /^\[Your last reply wrote a tool call as text, so nothing ran\]/)
})

test('a written tool call is told apart from text about one', () => {
  assert.equal(writesToolCall(WRITTEN), true)
  assert.equal(writesToolCall('<function=read>\n<parameter=path>a.md</parameter></function>'), true)
  assert.equal(writesToolCall('Models such as Step write `<tool_call>` tags in their template.'), false)
  assert.equal(writesToolCall(undefined), false)
  assert.equal(stripWrittenCalls(WRITTEN), 'Checking now.')
})

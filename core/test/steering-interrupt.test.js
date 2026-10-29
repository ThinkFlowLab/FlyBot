import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import {
  INTERRUPT_AFTER_MS, install, shouldInterruptOnHumanSend,
} from '../src/host/steering-interrupt.js'

const T0 = 1_000_000

test('the line is 60s: 59s keeps the turn, past 60s interrupts it', () => {
  const at = (elapsed) => shouldInterruptOnHumanSend({
    sourceKind: 'user', turnRunning: true, ownChat: true, waitStartedAt: T0, now: T0 + elapsed,
  })
  assert.equal(INTERRUPT_AFTER_MS, 60_000)
  assert.equal(at(0), false)
  assert.equal(at(59_000), false)
  assert.equal(at(60_000), false)
  assert.equal(at(60_001), true)
  assert.equal(at(10 * 60_000), true)
})

test('only a human line in an own chat with a turn on an open wait may interrupt', () => {
  const base = { sourceKind: 'user', turnRunning: true, ownChat: true, waitStartedAt: T0, now: T0 + 61_000 }
  assert.equal(shouldInterruptOnHumanSend(base), true)
  assert.equal(shouldInterruptOnHumanSend({ ...base, sourceKind: 'bot' }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, sourceKind: 'schedule' }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, turnRunning: false }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, ownChat: false }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, waitStartedAt: undefined }), false)
})

function bench() {
  const listeners = new Map()
  const cancels = []
  const yields = []
  let clock = T0
  const rt = {
    live: new Map([['a', { turn: 1 }]]),
    chatOwners: new Map([['a', 'a']]),
    groupOwners: new Map(),
    roomWaiters: new Map(),
    rooms: {},
    now: () => clock,
    resolveAgent: async () => ({ cancel: (cause, options) => cancels.push({ id: 'a', cause, options }) }),
    stopRoomTurn: async (sessionId, exchangeId) => { yields.push([sessionId, exchangeId]) },
  }
  rt.roomOf = id => rt.rooms[id]
  rt.ctx = { on: (name, fn) => (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) }
  install(rt)
  const emit = (id, event) => { for (const fn of listeners.get('session/event') ?? []) fn({ id }, event) }
  return { emit, cancels, yields, advance: ms => { clock += ms }, rt }
}

const toolCall = (callId, at) => ({ type: 'tool/call', time: at, data: { callId, name: 'bash' } })
// The host writes a result as `{ message: ToolResultMessage }`, so the call id arrives on
// the message and never at the top level of `data` (DSH's `tool/result` event map).
const toolResult = (callId, at) => ({ type: 'tool/result', time: at, data: { message: { role: 'tool', toolCallId: callId, isError: false, content: [] } } })
const toolResultTopLevelId = (callId, at) => ({ type: 'tool/result', time: at, data: { callId } })
const human = (at) => ({ type: 'user/message', time: at, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] } })
const flush = () => new Promise(resolve => setImmediate(resolve))

// A member's group turn the room's round is waiting on (#1650): the member Session sits in
// `groupOwners`, the live entry is the room turn, and the round's waiter names its exchange.
function roomTurn(b, { roomId = 'r1', sessionId = 'a', exchangeId = 'x1' } = {}) {
  const rt = b.rt
  rt.chatOwners.delete(sessionId)
  rt.rooms[roomId] = { id: roomId, name: 'Ops', sessions: { writer: sessionId } }
  rt.groupOwners.set(sessionId, { botId: 'writer', roomId })
  rt.live.set(sessionId, { turn: 1, info: { role: 'room', exchangeId, roomId } })
  rt.roomWaiters.set(exchangeId, { sessionId, roomId, botId: 'writer', exchangeId })
}

test('a human line 59s into a foreground wait does not abort the turn', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.advance(59_000)
  b.emit('a', human(T0 + 59_000))
  await flush()
  assert.equal(b.cancels.length, 0)
})

test('a human line past 60s aborts exactly once, keeping the inbox, and the message is not lost', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  b.emit('a', human(T0 + 61_100))
  await flush()
  assert.equal(b.cancels.length, 1)
  assert.deepEqual(b.cancels[0].options, { keepInbox: true })
  assert.equal(b.cancels[0].cause.kind, 'hook')
})

test('a finished wait and an idle Session never interrupt', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 1_000))
  b.advance(120_000)
  b.emit('a', human(T0 + 120_000))
  await flush()
  assert.equal(b.cancels.length, 0)

  // No turn in flight: the line starts a fresh turn by itself.
  b.rt.live.delete('a')
  b.emit('a', toolCall('c3', T0 + 120_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 242_000))
  await flush()
  assert.equal(b.cancels.length, 0)
})

test('a group room yields through the room path, never the own-chat one (#1650)', async () => {
  const b = bench()
  roomTurn(b)
  b.emit('a', toolCall('c1', T0))
  b.advance(61_000)
  // The person typed in the room's own Session; the wait is the member's.
  b.emit('r1', human(T0 + 61_000))
  await flush()
  assert.deepEqual(b.yields, [['a', 'x1']])
  assert.equal(b.cancels.length, 0, 'no room id takes the own-chat reason')

  // A second line in the same wait is still one let-go.
  b.emit('r1', human(T0 + 61_100))
  await flush()
  assert.equal(b.yields.length, 1)
})

test('a room waits for the same 60s, and a closed wait or a short one is left alone', async () => {
  const b = bench()
  roomTurn(b)
  b.emit('a', toolCall('c1', T0))
  b.advance(60_000)
  b.emit('r1', human(T0 + 60_000))
  await flush()
  assert.deepEqual(b.yields, [])

  b.emit('a', toolResult('c1', T0 + 60_000))
  b.advance(61_000)
  b.emit('r1', human(T0 + 121_000))
  await flush()
  assert.deepEqual(b.yields, [], 'a finished wait is not a wait')

  // The member's turn is gone: no waiter holds the room any more.
  b.emit('a', toolCall('c2', T0 + 121_000))
  b.advance(61_000)
  b.rt.live.delete('a')
  b.emit('r1', human(T0 + 182_000))
  await flush()
  assert.deepEqual(b.yields, [])
})

test('a second member running in the same room is not let go', async () => {
  const b = bench()
  roomTurn(b)
  // Another member is in a turn of its own (its round moved on), with a wait just as open.
  b.rt.groupOwners.set('c', { botId: 'other', roomId: 'r1' })
  b.rt.live.set('c', { turn: 1, info: { role: 'room', exchangeId: 'x2', roomId: 'r1' } })
  b.emit('c', toolCall('c9', T0))
  b.emit('a', toolCall('c1', T0))
  b.advance(61_000)
  b.emit('r1', human(T0 + 61_000))
  await flush()
  assert.deepEqual(b.yields, [['a', 'x1']])
})

// ---- a real host: the room Session, its round and the member turn in one runtime ----

const seedRoom = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function roomHost(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steering-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedRoom()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (agents.has(sessionId)) return agents.get(sessionId)
    const calls = []
    const cancelled = []
    agents.set(sessionId, {
      session: { id: sessionId },
      calls,
      cancelled,
      inbox: {
        nextStep: [],
        nextTurn: [],
        remove(id) {
          for (const list of ['nextStep', 'nextTurn']) {
            const at = this[list].findIndex(message => message.id === id)
            if (at === -1) continue
            this[list] = this[list].toSpliced(at, 1)
            return true
          }
          return false
        },
      },
      followup(message) { calls.push(message); this.inbox.nextTurn.push(message) },
      steer(message) { this.inbox.nextStep.push(message) },
      cancel(cause, options) { cancelled.push({ cause, options }) },
    })
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined, resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }), archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // Session events reach every listener in DSH order; awaiting each keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const relay = (callId) => {
    const stop = new AbortController()
    t.after(() => stop.abort())
    return {
      stop,
      done: ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'r1', inbox: agentOf('r1').inbox }, callId, signal: stop.signal }),
    }
  }
  // The member's turn: DSH took the queued prompt into the turn it starts.
  const takeTurn = async (sessionId, turn, message) => {
    agentOf(sessionId).inbox.nextTurn.length = 0
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { content: message.content, source: message.source } })
  }
  return { rt, agentOf, emit, relay, takeTurn }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const textOf = message => message.content.map(block => block.text ?? '').join('\n')

test('a real room round lets the member\'s 60s wait go and answers the line next round (#1650)', async (t) => {
  const host = await roomHost(t)
  const line = 'What is the deploy status?'

  const round = host.relay('c1')
  await settle(() => host.agentOf('gb').calls.length === 1)
  await host.takeTurn('gb', 1, host.agentOf('gb').calls[0])

  // The member is stuck in a foreground wait that has been open for over a minute.
  await host.emit('gb', { type: 'tool/call', time: Date.now() - 61_000, data: { callId: 'k1', name: 'bash', arguments: '{"command":"npm test"}' } })
  // The person types into the room's own Session.
  await host.emit('r1', { type: 'user/message', data: { source: { kind: 'user', authorKind: 'human', authorName: 'You' }, content: [{ type: 'text', text: line }] } })
  await settle(() => host.agentOf('gb').cancelled.length === 1)
  assert.deepEqual(host.agentOf('gb').cancelled[0], { cause: { kind: 'hook', reason: 'ds-bot/stopped' }, options: undefined })
  // The line waits in the room's own queue, not in the member's inbox.
  assert.deepEqual(host.rt.roomInbox.get('r1')?.map(item => item.text), [line])

  // The member's turn ends the way a Stop ends it; nothing it began reaches the room.
  await host.emit('gb', { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } } })
  const first = JSON.parse(await round.done)
  assert.equal(first.replies.some(reply => reply.text), false)
  assert.equal(host.agentOf('r1').calls.length, 0)

  // The next round answers the line the person typed.
  const next = host.relay('c2')
  await settle(() => host.agentOf('gb').calls.length === 1 + 1)
  await host.takeTurn('gb', 2, host.agentOf('gb').calls[1])
  assert.match(textOf(host.agentOf('gb').calls[1]), new RegExp(line))
  await host.emit('gb', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Deployed at noon.' }] } } })
  await host.emit('gb', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const second = JSON.parse(await next.done)
  assert.ok(second.replies.some(reply => reply.text === 'Deployed at noon.'), 'the next round answered the line')
  // The room has the person's line in its log, and the member was asked with it in the prompt.
  assert.ok(host.rt.state.rooms.r1.log.some(entry => entry.text === line))
  assert.equal(host.rt.roomInbox.get('r1'), undefined)
})

test("a landed tool result closes its wait, so a long turn is not read as a long wait (#1644)", async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 5_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

test('a closed wait does not age a later call in the same turn (#1644)', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 5_000))
  b.emit('a', toolCall('c2', T0 + 100_000))
  b.advance(130_000)
  b.emit('a', human(T0 + 130_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
  // The same call is still a wait once it has run past the line.
  b.advance(31_000)
  b.emit('a', human(T0 + 161_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 1)
})

test('a result that names its call id at the top of data still closes the wait', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResultTopLevelId('c1', T0 + 5_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

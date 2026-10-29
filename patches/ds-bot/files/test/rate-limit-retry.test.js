import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #1308: a requests-per-window 429 (`Limit type: requests`, `Remaining: 0`) has no reset this
// side can read, so the host asks the same turn again after a backoff instead of spending it.
// Only the attempt that outlasts the backoffs ends the turn, and it leaves the one visible
// failure line #1044 already draws.

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// The provider's words, as the issue quotes them. The reset is truncated, so nothing parses it.
const requests429 = {
  code: 'PROVIDER_ERROR',
  status: 429,
  message: '429: Rate limit exceeded for api_key: 4a14c40e…fd02ad7. Limit type: requests. Current limit: 50, Remaining: 0.',
}
// A budget refusal is the other limit (#1308 says not to touch it): asking again changes nothing.
const budget429 = {
  code: 'PROVIDER_ERROR',
  status: 429,
  message: '429: {"message":"Budget has been exceeded! Key=00885737 Current cost: 300.0019044899996, Max budget: 300.0","type":"budget_exceeded"}',
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-rate-limit-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const warns = []
  ctx.logger = { warn: (...parts) => warns.push(parts.map(part => (part instanceof Error ? part.message : String(part))).join(' ')), info() {} }
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove() { return false } }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled: [], inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  // A backoff the test does not wait for. The value is the production shape, shortened.
  apply(ctx, { home, rateLimitBackoffMs: [1, 1, 1] })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const ended = async () => (await call('state', {})).value.work.ended ?? []
  const transient = () => warns.filter(line => /rate limited .*asking again/.test(line))
  const asksAgain = (id) => agentOf(id).calls
  const waitFor = async (ok, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (ok()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'a' } })
  const die = (id, turn, error = requests429, texts = 0) => {
    emit(id, 'turn/start', { turn })
    for (let n = 0; n < texts; n++) emit(id, 'assistant/message', { turn, message: { content: [{ type: 'text', text: `line ${n}` }] } })
    emit(id, 'turn/end', { turn, reason: { kind: 'error', error } })
  }
  return { emit, die, ended, transient, asksAgain, waitFor, stop }
}

test('#1308: three requests-429s and then a success finish the round, with three backoffs logged', async (t) => {
  const host = await start()
  t.after(host.stop)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    host.die('b', attempt)
    await host.waitFor(() => host.asksAgain('b').length === attempt, `retry ${attempt}`)
  }
  assert.deepEqual(host.asksAgain('b').map(call => call.source?.rateLimited), [true, true, true])
  assert.equal(host.transient().length, 3, 'one backoff line per rate-limited attempt')
  // The fourth turn answers: the round completes and leaves no failure line behind.
  host.emit('b', 'turn/start', { turn: 4 })
  host.emit('b', 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'the answer' }] } })
  host.emit('b', 'turn/end', { turn: 4, reason: { kind: 'completed' } })
  assert.deepEqual((await host.ended()).filter(entry => entry.silent === true), [], 'the round completed, so no failure line')
})

test('#1308: a rate limit that outlasts every attempt ends the turn once, visibly, not as an empty round', async (t) => {
  const host = await start()
  t.after(host.stop)
  const turns = 1 + 3
  for (let attempt = 1; attempt <= turns; attempt += 1) {
    host.die('b', attempt)
    if (attempt < turns) await host.waitFor(() => host.asksAgain('b').length === attempt, `retry ${attempt}`)
  }
  await host.waitFor(() => true, 'settled')
  const ended = await host.ended()
  assert.equal(ended.length, 1, 'four dead attempts are one visible failure line, not four')
  assert.equal(ended[0].rateLimited, turns)
  assert.equal(ended[0].silent, true)
  assert.match(ended[0].failed, /Limit type: requests/)
  assert.equal(host.transient().length, 3)
})

test('#1308: a budget refusal is not asked again', async (t) => {
  const host = await start()
  t.after(host.stop)
  host.die('b', 1, budget429)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(host.asksAgain('b').length, 0)
  assert.equal(host.transient().length, 0)
  const ended = await host.ended()
  assert.equal(ended.length, 1)
  assert.equal(ended[0].rateLimited, undefined)
})

// #1679: the person presses Stop while a 429 retry waits on its backoff timer. The timer must not
// ask the member again: that would be an invisible model call (and its tools) for an answer nobody
// sees. Below, the real `group_relay` tool runs a two-Bot room. The member's Session is `gb`, its
// turns are played back through `session/event`, and aborting the round's controller is the Stop.
const roomSeed = () => ({
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

async function startRoom({ backoff = [300, 300, 300] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-stop-backoff-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(roomSeed()))
  const ctx = fakeContext()
  const warns = []
  ctx.logger = { warn: (...parts) => warns.push(parts.map(part => (part instanceof Error ? part.message : String(part))).join(' ')), info() {} }
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      // A delivery waits in the Session's inbox until its turn starts, the way DSH holds it.
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) { const at = held.findIndex(message => message.id === id); if (at === -1) return false; held.splice(at, 1); return true },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled: [], inbox, followup: keep, steer: keep, cancel(cause) { this.cancelled.push(cause) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, rateLimitBackoffMs: backoff })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const calls = sessionId => agentOf(sessionId).calls
  const transient = () => warns.filter(line => /rate limited .*asking again/.test(line))
  const rounds = async (count = 200) => { for (let round = 0; round < count; round += 1) await new Promise(resolve => setImmediate(resolve)) }
  const settle = async (ok, label) => {
    const until = Date.now() + 4000
    while (!ok() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
    assert.ok(ok(), `not reached: ${label}`)
  }
  // The member takes its delivery: the turn starts on that delivery's own source.
  const begin = (sessionId, delivery, turn = 1) => {
    agentOf(sessionId).inbox.nextTurn.length = 0
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: delivery.content, source: delivery.source })
  }
  const end = (sessionId, turn, reason) => emit(sessionId, 'turn/end', { turn, reason })
  const rateLimited = (sessionId, delivery, turn = 1) => {
    begin(sessionId, delivery, turn)
    end(sessionId, turn, { kind: 'error', error: requests429 })
  }
  const relay = (roomId, callId) => {
    const round = { resolved: false }
    round.controller = new AbortController()
    round.done = tool('group_relay', {}, roomId, { callId, signal: round.controller.signal })
      .then(value => { round.resolved = true; return JSON.parse(value) })
    round.stop = () => round.controller.abort()
    return round
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { rt, emit, tool, agentOf, calls, transient, rounds, settle, begin, end, rateLimited, relay, stop }
}

test('#1679: a Stop inside the backoff window asks the member nothing', async (t) => {
  const host = await startRoom()
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  const round = host.relay('r1', 'c1')
  await host.settle(() => host.calls('gb').length === 1, 'the room turn delivered')
  const first = host.calls('gb')[0]
  assert.equal(first.source?.role, 'room')
  host.rateLimited('gb', first)
  await host.settle(() => host.transient().length === 1, 'the backoff was scheduled')
  const before = host.calls('gb').length
  round.stop()                                   // the person presses Stop inside the 300 ms window
  await new Promise(resolve => setTimeout(resolve, 900))
  assert.equal(host.calls('gb').length - before, 0, 'a stopped round asks the member nothing')
  assert.equal(host.agentOf('gb').cancelled.length, 0, 'the turn had already ended, so nothing was cancelled')
  await host.settle(() => round.resolved, 'the stopped round ended')
  assert.deepEqual((await round.done).replies, [])
})

test('#1679: a Stop before the 429 turn/end schedules no backoff at all', async (t) => {
  const host = await startRoom()
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  const round = host.relay('r1', 'c1')
  await host.settle(() => host.calls('gb').length === 1, 'the room turn delivered')
  const first = host.calls('gb')[0]
  host.begin('gb', first)
  const before = host.calls('gb').length
  round.stop()                                   // the Stop lands while that turn is still running
  await host.settle(() => host.rt.roomTurnStopped(first.source.exchangeId), 'the round noted its stop')
  host.end('gb', 1, { kind: 'error', error: requests429 })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(host.transient().length, 0, 'a stopped round schedules no backoff')
  assert.equal(host.calls('gb').length, before, 'and it asks the member nothing')
  await host.settle(() => round.resolved, 'the stopped round ended')
  assert.deepEqual((await round.done).replies, [])
})

test('#1679: the backoff discarded for a stopped round does not reach the next round', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await startRoom()
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  const round = host.relay('r1', 'c1')
  await host.settle(() => host.calls('gb').length === 1, 'the room turn delivered')
  const first = host.calls('gb')[0]
  host.rateLimited('gb', first)
  await host.settle(() => host.transient().length === 1, 'the backoff was scheduled')
  await host.rt.stopRoomTurn('gb', first.source.exchangeId)   // the host records the Stop
  t.mock.timers.tick(300)                                      // the 300 ms timer fires
  await host.rounds()
  assert.equal(host.calls('gb').length, 1, 'the stopped exchange is not asked again')
  round.stop()
  await host.settle(() => round.resolved, 'the stopped round ended')
  assert.deepEqual((await round.done).replies, [])
  // A round that was never stopped still retries: the discarded timer poisoned nothing.
  const next = host.relay('r1', 'c2')
  await host.settle(() => host.calls('gb').length === 2, 'the next round delivered')
  const second = host.calls('gb')[1]
  assert.equal(second.source?.rateLimited, undefined, 'a fresh round is not a retry')
  host.rateLimited('gb', second)
  await host.settle(() => host.transient().length === 2, 'the next backoff was scheduled')
  t.mock.timers.tick(300)
  await host.settle(() => host.calls('gb').length === 3, 'the next round was asked again')
  const retried = host.calls('gb')[2]
  assert.equal(retried.source?.role, 'room')
  assert.equal(retried.source?.rateLimited, true)
  // The retried turn answers, so the second round closes cleanly.
  host.begin('gb', retried, 2)
  host.emit('gb', 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'the answer' }] } })
  host.end('gb', 2, { kind: 'completed' })
  await host.settle(() => next.resolved, 'the next round ended')
  assert.deepEqual((await next.done).replies.map(reply => reply.text), ['the answer'])
})

// #1688 review: `rateLimitRetries` is keyed by Session and holds one timer, so the callback of a
// stopped round's wait must forget only that wait. It used to call `forgetRateLimit(id)`, which
// clears whichever timer the Session has registered by then: when a new round in that Session was
// rate-limited before the old wait came due, the old callback cleared the new one's timer and
// deleted `spent`, and the new round's retry vanished without a line anywhere.
test('#1679: a stopped round\'s stale wait does not drop the next round\'s retry in the same Session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await startRoom({ backoff: [300, 600, 900] })
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  const round = host.relay('r1', 'c1')
  await host.settle(() => host.calls('gb').length === 1, 'the round turn delivered')
  const first = host.calls('gb')[0]
  host.rateLimited('gb', first, 1)
  await host.settle(() => host.transient().length === 1, 'the first backoff was scheduled')
  await host.rt.stopRoomTurn('gb', first.source.exchangeId)   // Stop, 300 ms before that wait is due
  round.stop()
  await host.settle(() => round.resolved, 'the stopped round ended')
  assert.deepEqual((await round.done).replies, [])
  t.mock.timers.tick(150)                                      // the stopped round's wait still pending
  // A new round in the same room speaks to the same member Session, and is rate-limited too: that
  // turn now owns the Session's timer.
  const next = host.relay('r1', 'c2')
  await host.settle(() => host.calls('gb').length === 2, 'the next round delivered')
  const second = host.calls('gb')[1]
  assert.equal(second.source?.rateLimited, undefined, 'a fresh round is not a retry')
  host.rateLimited('gb', second, 2)
  await host.settle(() => host.transient().length === 2, 'the second backoff was scheduled')
  t.mock.timers.tick(200)                                      // only the stopped round's wait is due
  await host.rounds()
  assert.equal(host.calls('gb').length, 2, 'the stopped exchange is not asked again')
  t.mock.timers.tick(100)                                      // the new round's own wait is due
  await host.settle(() => host.calls('gb').length === 3, 'the next round was asked again')
  const retried = host.calls('gb')[2]
  assert.equal(retried.source?.role, 'room', 'the retry keeps the round it belongs to')
  assert.equal(retried.source?.rateLimited, true, 'and is a rate-limit retry, not a fresh delivery')
  // The stopped round's callback did not reset what this Session had spent: the retried turn's own
  // 429 waits the second backoff (600 ms), not the first (300 ms) a reset counter would pick.
  host.rateLimited('gb', retried, 3)
  await host.settle(() => host.transient().length === 3, 'the third backoff was scheduled')
  t.mock.timers.tick(400)
  await host.rounds()
  assert.equal(host.calls('gb').length, 3, '600 ms have not passed, so that retry did not go out early')
  t.mock.timers.tick(300)
  await host.settle(() => host.calls('gb').length === 4, 'the third attempt was asked again')
  next.stop()
  await host.settle(() => next.resolved, 'the second round ended')
  assert.deepEqual((await next.done).replies, [])
})

// #1688 review: `stopRoomTurn` forgets the exchange when it removes a queued delivery for it. A
// retry waiting on that Session's backoff timer is the same exchange's next delivery, so forgetting
// the stop there lets the timer ask the member again. The marker stays while a wait is pending, and
// the set is still bounded by STOPPED_KEPT.
test('#1679: removing a queued delivery does not forget a retry that is still waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await startRoom()
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  const round = host.relay('r1', 'c1')
  await host.settle(() => host.calls('gb').length === 1, 'the round turn delivered')
  const first = host.calls('gb')[0]
  host.rateLimited('gb', first, 1)
  await host.settle(() => host.transient().length === 1, 'the backoff was scheduled')
  // The member's queue still holds a delivery for that exchange when the person presses Stop.
  host.agentOf('gb').inbox.nextTurn.push({ id: 'dup', source: { exchangeId: first.source.exchangeId, role: 'room' }, content: [{ type: 'text', text: 'the same line' }] })
  await host.rt.stopRoomTurn('gb', first.source.exchangeId)
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 0, 'the Stop removed the queued delivery')
  t.mock.timers.tick(300)
  await host.rounds()
  assert.equal(host.calls('gb').length, 1, 'the waiting retry still counts as stopped')
  round.stop()
  await host.settle(() => round.resolved, 'the stopped round ended')
  assert.deepEqual((await round.done).replies, [])
})

test('#1679: an own-chat 429 with no Stop still retries (#1672 unchanged)', async (t) => {
  const host = await startRoom()
  t.after(host.stop)
  await host.tool('list_bots', {}, 'a')
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
  host.end('a', 1, { kind: 'error', error: requests429 })
  await host.settle(() => host.calls('a').length === 1, 'the retry was delivered')
  const [retry] = host.calls('a')
  assert.equal(retry.source?.role, 'retry')
  assert.equal(retry.source?.rateLimited, true)
  assert.match(retry.content?.[0]?.text ?? '', /rate limited the last call/)
})

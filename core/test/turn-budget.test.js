// Team turn budget (#645, the C half; owner decision 2026-11-07). A team's model turns are
// counted per team-local day; at or over the cap only a turn the user started themselves is
// dispatched. The gate answers before a step reaches a model, so "refused" means no request at
// all — that is what these tests pin, on the seam DSH reports as a blocked turn.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { format } from 'node:util'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import {
  TEAM_TURNS_PER_DAY, TEAM_TURN_ZONE, install, readTurnBudget, teamDayKey, turnBudgetOf, turnsUsed,
} from '../src/host/turn-budget.js'

// 2026-11-07 13:00 in Asia/Shanghai, so the team-local day is 2026-11-07 while UTC is still 11-07.
const NOW = Date.parse('2026-11-07T05:00:00Z')

// The module with no store behind it: every read and write is a plain object this test can
// inspect, which is what makes "next was never called" an assertion and not an inference.
function harness({ cap = TEAM_TURNS_PER_DAY, count, day = '2026-11-07', origin = 'scheduled', bot = true, config = {} } = {}) {
  const ctx = fakeContext()
  const warnings = []
  const saves = []
  const rt = {
    ctx,
    config,
    state: { prefs: { turnBudget: cap }, ...(count === undefined ? {} : { turns: { day, count } }) },
    live: new Map([['b', { turn: 4, origin }]]),
    load: async () => {},
    save: async () => {},
    mutate: async (change) => { const result = await change(); saves.push(JSON.parse(JSON.stringify(rt.state))); return result },
    isBotSession: id => bot && id === 'b',
    botOf: () => ({ name: 'Writer' }),
    selfOf: id => id,
    warn: (...args) => warnings.push(format(...args)),
  }
  install(rt)
  const gate = ctx.listeners.get('agent/pre-step')[0]
  const events = ctx.listeners.get('session/event')[0]
  return {
    rt, gate, events, warnings, saves,
    // The step-1 pre-step chain as DSH runs it: `next` settles into the step it would take.
    step: async ({ id = 'b', step = 1, next } = {}) => {
      let called = 0
      const decision = await gate({ agent: { id }, step, signal: new AbortController().signal }, async () => {
        called += 1
        return next ?? { kind: 'enter', messages: [{ id: 'm1' }] }
      })
      return { decision, called }
    },
    startStep: (id = 'b', step = 1) => events({ id }, { type: 'step/start', data: { turn: 1, step } }),
    turnStart: (id = 'b') => events({ id }, { type: 'turn/start', data: { turn: 4 } }),
    message: (id = 'b', source = { kind: 'user' }) => events({ id }, { type: 'user/message', data: { source, content: [{ type: 'text', text: 'hi' }] } }),
  }
}

test('the cap is a whole number of turns: 200 when unset, 0 is off, a malformed value keeps the default', () => {
  assert.equal(turnBudgetOf({}), TEAM_TURNS_PER_DAY)
  assert.equal(turnBudgetOf({ turnBudget: 0 }), 0)
  assert.equal(turnBudgetOf({ turnBudget: 37 }), 37)
  for (const value of [-1, 1.5, '40', null, Number.NaN]) assert.equal(turnBudgetOf({ turnBudget: value }), TEAM_TURNS_PER_DAY)
})

test('the settings write takes a whole number or 0, clears on null, and refuses the rest', () => {
  assert.equal(readTurnBudget(0), 0)
  assert.equal(readTurnBudget(200), 200)
  assert.equal(readTurnBudget(null), undefined)
  for (const value of [-1, 1.5, '200', Number.NaN, {}]) assert.throws(() => readTurnBudget(value), /whole number of turns/)
})

test('the team day is the team clock: Asia/Shanghai by default, the configured zone when set', () => {
  const at = Date.parse('2026-11-06T15:59:59.999Z')
  assert.equal(teamDayKey({}, at), '2026-11-06')
  assert.equal(teamDayKey({}, at + 1), '2026-11-07')
  const utcEnd = Date.parse('2026-11-06T23:59:59.999Z')
  assert.equal(teamDayKey({ config: { timeZone: 'UTC' } }, utcEnd), '2026-11-06')
  assert.equal(teamDayKey({ config: { timeZone: 'UTC' } }, utcEnd + 1), '2026-11-07')
  // A zone Intl cannot read counts in the team default instead of throwing.
  assert.equal(teamDayKey({ config: { timeZone: 'Not/AZone' } }, NOW), '2026-11-07')
  assert.equal(TEAM_TURN_ZONE, 'Asia/Shanghai')
})

test('a saved count from another day is not a count', () => {
  assert.equal(turnsUsed(undefined, '2026-11-07'), 0)
  assert.equal(turnsUsed({ day: '2026-11-06', count: 900 }, '2026-11-07'), 0)
  assert.equal(turnsUsed({ day: '2026-11-07', count: 900 }, '2026-11-07'), 900)
  assert.equal(turnsUsed({ day: '2026-11-07', count: -3 }, '2026-11-07'), 0)
})

test('over the cap a system-started turn is refused before a model call, with one log line', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 2, count: 2, origin: 'scheduled' })
  const { decision, called } = await h.step()
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(called, 0, 'no model step is taken for a refused turn')
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /turn budget: 2 of 2 turns used on 2026-11-07 \(Asia\/Shanghai\); a scheduled turn for Writer is not dispatched/)
})

test('a turn with no recorded origin is system-started too', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 1, count: 1 })
  h.rt.live.set('b', { turn: 4 })
  const { decision, called } = await h.step()
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(called, 0)
})

test('over the cap the user\'s own turn is still dispatched', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 2, count: 9, origin: 'owner' })
  const decision = { kind: 'enter', messages: [{ id: 'm1' }] }
  const out = await h.step({ next: decision })
  assert.equal(out.called, 1)
  assert.equal(out.decision, decision)
})

test('under the cap, at 0, and after the day boundary nothing is refused', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  for (const options of [
    { cap: 2, count: 1, origin: 'scheduled' }, // under the cap
    { cap: 0, count: 999, origin: 'scheduled' }, // 0 is off
    { cap: 2, count: 999, day: '2026-11-06', origin: 'scheduled' }, // yesterday resets
  ]) {
    const h = harness(options)
    const out = await h.step()
    assert.equal(out.called, 1, JSON.stringify(options))
  }
})

test('a turn already running is not cut off at its later steps', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 1, count: 9, origin: 'scheduled' })
  const out = await h.step({ step: 2 })
  assert.equal(out.called, 1)
  assert.notDeepEqual(out.decision, { kind: 'reject' })
})

test('an ordinary DSH Session, not a Bot Session, is never gated', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 1, count: 9, origin: 'scheduled', bot: false })
  assert.equal((await h.step()).called, 1)
})

test('a turn is spent once, on its first step, and only for a Bot Session', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 200, count: 3 })
  h.startStep('b', 1)
  await delay(0)
  assert.deepEqual(h.rt.state.turns, { day: '2026-11-07', count: 4 })
  h.startStep('b', 2)
  h.startStep('b', 3)
  h.startStep('other', 1)
  await delay(0)
  assert.deepEqual(h.rt.state.turns, { day: '2026-11-07', count: 4 })
  assert.equal(h.saves.length, 1)
})

test('a refused turn is never counted: it starts no step', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const h = harness({ cap: 1, count: 1, origin: 'scheduled' })
  const { decision } = await h.step()
  assert.deepEqual(decision, { kind: 'reject' })
  await delay(0)
  assert.equal(h.rt.state.turns.count, 1)
  assert.equal(h.saves.length, 0)
})

// The same rules through the real store: an existing team is seeded off, a fresh one at the
// default, and the turn `turns.js` judged the user's is the one that passes the real gate.
function runtime(t, seed) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-turn-budget-'))
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, inbox: { nextStep: [], nextTurn: [], remove() {} } } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, seq: ++seq, data })
  }
  const gate = ctx.listeners.get('agent/pre-step').at(-1)
  const step = async (id, next = { kind: 'enter', messages: [] }) => {
    let called = 0
    const decision = await gate({ agent: { id }, step: 1, signal: new AbortController().signal }, async () => { called += 1; return next })
    return { decision, called }
  }
  t.after(() => { try { ctx.dispose() } catch {} rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home, emit, gate, step }
}

const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 }, b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('the store seeds a fresh team at the default and an existing one off until the owner sets it', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const fresh = runtime(t, undefined)
  await fresh.rt.load()
  assert.equal(fresh.rt.state.prefs.turnBudget, TEAM_TURNS_PER_DAY)
  assert.equal(JSON.parse(readFileSync(join(fresh.home, 'state.json'), 'utf8')).prefs.turnBudget, TEAM_TURNS_PER_DAY)

  const saved = runtime(t, { ...TEAM, prefs: {} })
  await saved.rt.load()
  assert.equal(saved.rt.state.prefs.turnBudget, 0)
  assert.equal(JSON.parse(readFileSync(join(saved.home, 'state.json'), 'utf8')).prefs.turnBudget, 0)
})

test('through the real store, a due task is refused at the cap and the user\'s own line still runs', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const { rt, emit, step } = runtime(t, { ...TEAM, prefs: { turnBudget: 1 }, turns: { day: '2026-11-07', count: 1 } })
  await rt.load()
  // A due task: DSH appends the message as `schedule`, then the turn starts.
  emit('b', 'user/message', { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'Daily briefing' }] })
  emit('b', 'turn/start', { turn: 1 })
  assert.equal(rt.live.get('b').origin, 'scheduled')
  const refused = await step('b')
  assert.deepEqual(refused.decision, { kind: 'reject' })
  assert.equal(refused.called, 0)

  // The user's own line: DSH's prompt carries `kind: 'user'`, which turns.js records as the owner's.
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'blocked' } })
  emit('b', 'user/message', { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'how are you' }] })
  emit('b', 'turn/start', { turn: 2 })
  assert.equal(rt.live.get('b').origin, 'owner')
  const allowed = await step('b')
  assert.equal(allowed.called, 1)
})

test('through the real store, the first step of a turn is counted and the day rolls over', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  const { rt, emit } = runtime(t, { ...TEAM, prefs: { turnBudget: 200 }, turns: { day: '2026-11-06', count: 42 } })
  await rt.load()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'step/start', { turn: 1, step: 1 })
  await delay(50)
  await rt.savesSettled?.()
  assert.deepEqual(rt.state.turns, { day: '2026-11-07', count: 1 })
  assert.equal(JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8')).turns.count, 1)
})

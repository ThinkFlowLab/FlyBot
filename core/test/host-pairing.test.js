// `authorize` and the channel handler are installed as a pair (#3145). The ownership test
// inside `chats.search` is fail-open in shape (`if (rt.authzEnforced?.() && !rt.sessionOwnedBy?.(…))`),
// so mounting the handler without the authz module would silently index every Bot's chat.
// The handler now refuses a host whose `authorize` did not come with the pairing marker.
//
// Real module, a temporary home and the real /api/bot route, as core/test/chat-index-writers.test.js.
// The guard must fire on a missing pair only: a host where `authzEnforced()` answers false is a
// supported single-user install and must answer exactly as it did before.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { cleanHome } from './temp-home.js'

const T0 = 1_760_000_000_000

const line = (seq, text) => ({
  type: 'user/message',
  seq,
  time: T0 + seq * 1000,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const SECRET = 'owner-2 private SECRETNEEDLE words'
const HISTORY = { solo: [line(0, 'first line'), line(1, 'second line')] }

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', sessionId: 'solo', name: 'Solo', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 1 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 1,
})

// The host over a home is stopped before the directory is removed: the channel's index and log
// writers close inside `ctx.dispose()`, and a removal that runs first meets the open handle as
// EPERM on Windows (the same teardown as chat-index-writers.test.js).
const closers = new Map()
const scratch = (t, name = 'ds-bot-pairing-') => {
  const home = mkdtempSync(join(tmpdir(), name))
  const stops = []
  closers.set(home, stops)
  t.after(async () => {
    for (const stop of stops.splice(0)) await stop()
    closers.delete(home)
    cleanHome(home)
  })
  return home
}

// One host over `home`, with the real channel route as `start()` in chat-index-writers.test.js
// builds it. `unpaired` reaches the handler without the authz module's pairing: the marker is
// removed and a permissive `authorize` stands in its place — exactly the "mounted alone, or
// with a different, weaker authorize" host the issue describes.
async function start(t, home, { unpaired = false } = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()), { mode: 0o600 })
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.map(part => String(part)).join(' '))
  let route
  const registered = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return registered(options) }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    sessionController: {
      create: async () => ({ sessionId: 'fresh' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (HISTORY[sessionId]?.at(-1)?.seq ?? -1) + 1 }, followup() {} } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages } = {}) => {
        const all = (HISTORY[address?.sessionId] ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records: records.map(event => ({ event })), hasMore: records.length < all.length }
      },
    },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  if (unpaired) {
    delete rt.authorizePaired
    rt.authorize = () => ({ ok: true })
  }
  let stopped = false
  const host = { home, ctx, rt, route, warnings, stop: async () => {
    if (stopped) return
    stopped = true
    await ctx.dispose()
  } }
  const stops = closers.get(home)
  if (stops === undefined) t.after(() => host.stop())
  else stops.push(() => host.stop())
  return host
}

const ask = (host, endpoint, payload, token) => host.route.fetch(new Request('http://localhost/api/bot', {
  method: 'POST',
  headers: token === undefined ? {} : { 'x-flybot-member-session': token },
  body: JSON.stringify({ endpoint, payload }),
})).then(response => response.json())

test('a channel handler mounted without its authz pairing answers no data (#3145)', async (t) => {
  const home = scratch(t)
  const host = await start(t, home, { unpaired: true })
  assert.notEqual(host.route, undefined, 'the channel registered its /api/bot route')

  // No tree, no rows, and no successful answer: the loud refusal is the point, not its code.
  const state = await ask(host, 'state', {})
  assert.equal(state.ok, false, JSON.stringify(state))
  assert.equal(state.value, undefined, JSON.stringify(state))

  const search = await ask(host, 'chats.search', { query: 'first' })
  assert.equal(search.ok, false, JSON.stringify(search))
  assert.equal(search.value, undefined, JSON.stringify(search))

  // The leak the pairing protects against: the private line must not appear anywhere.
  assert.doesNotMatch(JSON.stringify(search), /SECRETNEEDLE/)
})

// A host that never got the authz module at all: `authorize` is absent rather than weak. The
// handler must still answer no data instead of falling through to its switch.
test('a channel handler with no authorize at all answers no data (#3145)', async (t) => {
  const home = scratch(t)
  const host = await start(t, home)
  delete host.rt.authorize
  delete host.rt.authorizePaired

  const state = await ask(host, 'state', {})
  assert.equal(state.ok, false, JSON.stringify(state))
  assert.equal(state.value, undefined, JSON.stringify(state))

  const search = await ask(host, 'chats.search', { query: 'first' })
  assert.equal(search.ok, false, JSON.stringify(search))
  assert.equal(search.value, undefined, JSON.stringify(search))
  assert.doesNotMatch(JSON.stringify(search), new RegExp(SECRET))
})

// The boundary: `authzEnforced() === false` is a supported single-user install, not a
// missing pair. It carries the pairing marker and answers `state`/`chats.search` as today.
test('a single-user host carries the pair and answers state and chats.search as today (#3145)', async (t) => {
  const home = scratch(t)
  const host = await start(t, home)
  assert.equal(host.rt.authzEnforced(), false, 'this case is the single-user install, or it proves nothing')
  assert.equal(host.rt.authorizePaired, true, 'the pairing marker is set whether or not authz is enforced')

  const state = await ask(host, 'state', {})
  assert.equal(state.ok, true, JSON.stringify(state))
  assert.deepEqual(state.value.bots.map(bot => bot.id), ['a'], JSON.stringify(state.value.bots))

  const search = await ask(host, 'chats.search', { query: 'first' })
  assert.equal(search.ok, true, JSON.stringify(search))
  assert.deepEqual(search.value.rows.map(row => row.chat), ['a'], JSON.stringify(search.value))
  assert.match(search.value.rows[0].text, /first line/)
})

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
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

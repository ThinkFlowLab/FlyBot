import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { failureLines } from '../src/shared/turn-failures.js'

// #1044: a turn that dies on a provider refusal without writing a word must leave one visible line in
// the chat, and three in a row must stay three lines with the streak on them. The host half is what the
// tests below read (the `work` snapshot the client draws); the client half is `failureLines`.

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

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-dead-turn-'))) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const held = []
      const inbox = { nextStep: [], nextTurn: held, remove() { return false } }
      const keep = (message) => { calls.push(message); held.push(message) }
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
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const ended = async () => (await call('state', {})).value.work.ended ?? []
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  await tool('list_bots', {}, 'a')
  return { emit, call, ended, stop }
}

const budget429 = {
  code: 'PROVIDER_ERROR',
  status: 429,
  message: '429: {"message":"Budget has been exceeded! Key=00885737 Current cost: 300.0019044899996, Max budget: 300.0","type":"budget_exceeded"}',
}

const die = (emit, id, turn, status = budget429, texts = 0) => {
  emit(id, 'turn/start', { turn })
  for (let n = 0; n < texts; n++) emit(id, 'assistant/message', { turn, message: { content: [{ type: 'text', text: `line ${n}` }] } })
  emit(id, 'turn/end', { turn, reason: { kind: 'error', error: status } })
}

test('#1044: a turn that dies with no text is marked silent, once, naming the provider error', async (t) => {
  const host = await start()
  t.after(host.stop)
  die(host.emit, 'b', 1)
  const [entry] = await host.ended()
  assert.equal(entry.silent, true)
  assert.equal(entry.streak, 1)
  assert.match(entry.failed, /Budget has been exceeded/)
  const lines = failureLines({ ended: await host.ended() }, 'b', (key, values) => (values?.error === undefined ? key : `${key.split('{error}')[0]}${values.error}`))
  assert.equal(lines.length, 1)
  assert.match(lines[0].text, /Budget has been exceeded/)
  assert.equal(lines[0].streak, undefined)
})

test('#1044: a turn that wrote text then failed adds no line', async (t) => {
  const host = await start()
  t.after(host.stop)
  die(host.emit, 'b', 1, budget429, 2)
  const [entry] = await host.ended()
  assert.equal(entry.silent, undefined)
  assert.equal(failureLines({ ended: await host.ended() }, 'b', key => key).length, 0)
})

test('#1044: three dead turns in a row are three lines and the streak is visible', async (t) => {
  const host = await start()
  t.after(host.stop)
  die(host.emit, 'b', 1)
  die(host.emit, 'b', 2)
  die(host.emit, 'b', 3)
  const ended = await host.ended()
  assert.deepEqual(ended.map(entry => entry.silent), [true, true, true])
  assert.deepEqual(ended.map(entry => entry.streak), [1, 2, 3])
  const lines = failureLines({ ended }, 'b', (key, values) => `${key}:${JSON.stringify(values ?? {})}`)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(line => line.streak), [undefined, 2, 3])
})

test('#1044: a successful turn after the dead ones resets the streak', async (t) => {
  const host = await start()
  t.after(host.stop)
  die(host.emit, 'b', 1)
  die(host.emit, 'b', 2)
  host.emit('b', 'turn/start', { turn: 3 })
  host.emit('b', 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'ok' }] } })
  host.emit('b', 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  die(host.emit, 'b', 4)
  const ended = await host.ended()
  assert.deepEqual(ended.map(entry => [entry.silent ?? null, entry.streak ?? null]), [[true, 1], [true, 2], [null, null], [true, 1]])
})

test('#1044: the line is not a message: the dead turn adds nothing to the chat', async (t) => {
  const host = await start()
  t.after(host.stop)
  die(host.emit, 'b', 1)
  const state = (await host.call('state', {})).value
  const lines = failureLines({ ended: state.work.ended }, 'b', key => key)
  assert.equal(lines.length, 1)
  // Nothing was delivered to anyone for it, and the entry the notifications read is unchanged.
  assert.deepEqual(state.work.bots, {})
})

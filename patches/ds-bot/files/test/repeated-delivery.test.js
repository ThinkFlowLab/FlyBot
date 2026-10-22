import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Three Bots and no group: Chief -> Coordinator -> Specialist. #641 is about the same conclusion
// arriving twice in one Session, not about routing, so every case below goes through message_bot.
function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Coordinator', role: 'Coord', sessionId: 'b', createdAt: 2 },
      c: { id: 'c', name: 'Specialist', role: 'Spec', sessionId: 'c', createdAt: 3 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-repeated-delivery-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  // The host's own warning log is where a dropped delivery is journalled.
  const warnings = []
  ctx.logger.warn = (template, line) => warnings.push(String(line ?? template))
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, agents, warnings, tool, call, home, stop }
}

const BASE = Date.parse('2026-10-22T05:00:00Z')

test('#641: the same conclusion sent twice within a minute makes one turn, and the drop is journalled', async (t) => {
  const { agents, warnings, tool, stop } = await start(team())
  t.after(stop)
  t.mock.timers.enable({ apis: ['Date'], now: BASE })

  await tool('message_bot', { to: 'Coordinator', message: 'PR #675 is green at a7f13140.' }, 'c')
  // Same conclusion again, differing only in whitespace: still the same line after normalisation.
  await tool('message_bot', { to: 'Coordinator', message: 'PR #675 is  green at a7f13140. ' }, 'c')

  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'], 'one turn, not two')
  assert.ok(warnings.some(line => /delivery: dedupe c -> b/.test(line)), 'a dropped delivery is journalled')
})

test('#641: the same text 61 s later makes its own turn', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)
  t.mock.timers.enable({ apis: ['Date'], now: BASE })

  await tool('message_bot', { to: 'Coordinator', message: 'still investigating' }, 'c')
  t.mock.timers.setTime(BASE + 61_000)
  await tool('message_bot', { to: 'Coordinator', message: 'still investigating' }, 'c')

  assert.equal(agents.get('b').calls.length, 2, 'the window has passed, so this is news again')
})

test('#641: two senders with identical text are both delivered', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)
  t.mock.timers.enable({ apis: ['Date'], now: BASE })

  await tool('message_bot', { to: 'Coordinator', message: 'ready' }, 'a')
  await tool('message_bot', { to: 'Coordinator', message: 'ready' }, 'c')

  assert.equal(agents.get('b').calls.length, 2, 'the key is sender + text, not text alone')
})

test('#641: the key includes the Session, so another recipient still gets the text', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)
  t.mock.timers.enable({ apis: ['Date'], now: BASE })

  // The same line to two Sessions is two deliveries; this is why a copy posted in a group chat is
  // never suppressed for a Bot that was not in that group.
  await tool('message_bot', { to: 'Coordinator', message: 'done' }, 'a')
  await tool('message_bot', { to: 'Specialist', message: 'done' }, 'a')

  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.deepEqual(agents.get('c').calls.map(([kind]) => kind), ['steer'])
})

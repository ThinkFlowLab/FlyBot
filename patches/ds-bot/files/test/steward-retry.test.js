import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A Main Bot and a Bot, both idle in their own chat.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
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
}

// The provider's stream, in the shape `BlockAssembler` reads: text deltas and a finish.
const answer = (text) => (async function* () {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

// A rate limit as the provider reports it: per-minute, recovered in seconds, and the
// `retryAfter` it asks for.
const throttled = (retryAfter = 0) => Object.assign(new Error('429: rate limit exceeded (requests)'), {
  status: 429,
  code: 'throttling_error',
  retryAfter,
})

// A provider error that is not a rate limit: asking again would change nothing.
const broken = () => Object.assign(new Error('500: the provider failed'), { status: 500, code: 'PROVIDER_ERROR' })

// A failure as a real provider route delivers it: the stream ends on a finish chunk whose
// reason carries the failure facts, and nothing is thrown (#1447).
const finishFailure = (failure) => (async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure } }
})()
const rateLimited = (extra = {}) => finishFailure({ message: '429: rate limit exceeded (requests)', code: 'RATE_LIMIT', ...extra })

// One model window, and a part whose size the test sets: `lines` for window 2000 with a
// 100-token reserve are hard 1805 / check 1520, so `between` sits past the check line and
// short of the hard one, and `over` is past both.
const WINDOW = { context: { contextWindow: 2_000 }, defaultMaxTokens: 100 }
const between = 'x'.repeat(4_800)
const over = 'x'.repeat(5_600)

// The team's data in a temporary home, a project folder beside it, a compaction engine
// that makes room when the steward says so, and a provider stream the test drives.
async function start({ text = between, stream } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-steward-retry-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const messages = [{ role: 'user', content: [{ type: 'text', text }] }]
  const condensed = []
  const compaction = {
    compactIfNeeded: async () => null,
    compactNow: async () => {
      condensed.push('compactNow')
      // What a summary leaves behind: the part is below the check line afterwards.
      messages.splice(0, messages.length, { role: 'user', content: [{ type: 'text', text: 'condensed' }] })
      return { summary: 'condensed' }
    },
    compactRegion: async () => {},
    summarize: async () => '',
  }

  const ctx = fakeContext({ services: { compaction } })
  const created = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId,
          header: { cwd: cwds.get(sessionId) ?? team },
          requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 100 } }),
          deriveMessages: () => messages,
          toolHistory: () => [],
        },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const archived = []
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  const calls = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => WINDOW,
      stream: (request) => {
        calls.push(request)
        return stream(calls.length, request)
      },
    },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async path => ({ id: 'w-new', path }),
      async archiveSession(sessionId) { archived.push(sessionId) },
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
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
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const stop = () => {
    ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  // The engine is adopted where DSH announces a new agent; the idle check reads it there.
  const b = agentOf('b')
  ctx.emit('agent/created', { agent: b })
  const idle = () => ctx.emit('agent/status', { agent: b, status: 'idle' })
  return { ctx, created, calls, condensed, archived, agentOf, call, idle, state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')), stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, ms = 5_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 5 s')
    await settle()
  }
}
const forMs = async (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) await settle()
}

test('#1447: a throttled steward is asked again instead of moving the part on', async (t) => {
  let stewardCalls = 0
  const h = await start({
    stream: (count) => {
      if (count === 1) throw throttled(0)
      stewardCalls += 1
      return answer('{"action":"compact","reason":"still working"}')
    },
  })
  t.after(() => h.stop())
  h.idle()
  await until(() => h.calls.length >= 2)
  await forMs(200)
  assert.equal(h.calls.length, 2, 'the steward was asked twice: once refused, once answered')
  assert.equal(stewardCalls, 1, 'the second answer is the one that counts')
  assert.deepEqual(h.condensed, ['compactNow'], 'the answer was acted on: the part was condensed in place')
  assert.equal(h.created.length, 0, 'no fresh part was started for one rate limit')
  assert.deepEqual(h.archived, [], 'nothing was archived')
})

test('#1447: a rate limit the harness reports as a finish chunk is asked again', async (t) => {
  let stewardCalls = 0
  const h = await start({
    stream: (count) => {
      if (count === 1) return rateLimited()
      stewardCalls += 1
      return answer('{"action":"compact","reason":"still working"}')
    },
  })
  t.after(() => h.stop())
  h.idle()
  await until(() => h.calls.length >= 2)
  await forMs(200)
  assert.equal(h.calls.length, 2, 'the steward was asked twice: once refused, once answered')
  assert.equal(stewardCalls, 1, 'the second answer is the one that counts')
  assert.deepEqual(h.condensed, ['compactNow'], 'the answer was acted on: the part was condensed in place')
  assert.equal(h.created.length, 0, 'no fresh part was started for one rate limit')
  assert.deepEqual(h.archived, [], 'nothing was archived')
})

test('#1447: a finish failure known only by its 429 status is asked again, after the delay it asked for', async (t) => {
  const asked = []
  const h = await start({
    stream: (count) => {
      asked.push(Date.now())
      // Not one of the codes this side knew: the status is the only transient fact, and
      // the 400 ms is the provider's own, in milliseconds.
      if (count === 1) return rateLimited({ code: 'PROVIDER_HTTP', status: 429, providerRetryAfterMs: 400 })
      return answer('{"action":"compact","reason":"still working"}')
    },
  })
  t.after(() => h.stop())
  h.idle()
  await until(() => h.calls.length >= 2)
  await forMs(200)
  assert.equal(h.calls.length, 2, 'the status alone made the failure worth asking again: one retry, then the answer')
  assert.deepEqual(h.condensed, ['compactNow'], 'the answer was acted on: the part was condensed in place')
  assert.equal(h.created.length, 0, 'no fresh part was started for one rate limit')
  const gap = asked[1] - asked[0]
  assert.ok(gap >= 300, `the provider's 400 ms was waited, not the 250 ms default (the gap was ${gap} ms)`)
  assert.ok(gap < 3_000, `the delay was read as milliseconds, not seconds (the gap was ${gap} ms)`)
})

test('#1447: below the hard line a steward that keeps being turned down costs the round, not the part', async (t) => {
  const h = await start({ stream: () => { throw throttled(0) } })
  t.after(() => h.stop())
  h.idle()
  await until(() => h.calls.length >= 3, 10_000)
  await forMs(200)
  assert.equal(h.calls.length, 3, 'the steward was asked the three attempts and no more')
  assert.equal(h.created.length, 0, 'the part stays: nothing was started for it')
  assert.deepEqual(h.archived, [], 'nothing was archived')
  // The next idle inside the cooldown does not ask again: the same key is still limited.
  h.idle()
  await forMs(300)
  assert.equal(h.calls.length, 3, 'the cooldown holds: the part waits without another request')
  assert.equal(h.created.length, 0, 'and it still stays')
})

test('#1447: a steward that cannot be asked over the hard line still moves the part on and says why', async (t) => {
  const h = await start({ text: over, stream: () => { throw broken() } })
  t.after(() => h.stop())
  h.idle()
  await until(() => h.created.length === 1, 15_000)
  assert.equal(h.created.length, 1, 'the part past the hard line moved on')
  // The switch starts the fresh part first and archives the finished one once the move is
  // done, so the archive lands a step after `created`: wait for it instead of reading it
  // the moment the new Session exists. The assertion itself stays as strict.
  await until(() => h.archived.length === 1, 15_000)
  assert.deepEqual(h.archived, ['b'], 'the finished part was archived')
  const packageText = (h.agentOf('s1').calls.find(([kind]) => kind === 'followup') ?? [])[1]
    ?.content?.map(block => block.text).join('')
  assert.match(packageText ?? '', /the context steward could not be asked/)
  assert.doesNotMatch(packageText ?? '', /the previous part grew long/)
  const stored = h.state().bots.b.segments?.at(-1)
  assert.match(String(stored?.steward ?? ''), /PROVIDER_ERROR/, 'the segment keeps the failure that forced the move')
})


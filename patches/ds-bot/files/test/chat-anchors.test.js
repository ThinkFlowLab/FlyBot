// The chat anchor is the tool's own citation: a Bot quotes it in an answer and later asks
// `read_own_chat around` with it to check what it said (#2710). An anchor printed while the
// chat had one part used to be a bare `#<seq>`, and after a part split that resolved into
// whichever part was current then, reported as an exact hit. So `anchorOf` now always names
// the part, a bare old anchor still resolves against the current part, and the answer says
// that part was guessed instead of claiming `exact`.
//
// Real module, a temporary home, real SQLite, and a fake Session log as the source.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const T0 = 1_760_000_000_000

const line = (seq, text, who = 'user') => (who === 'you'
  ? { type: 'assistant/message', seq, time: T0 + seq * 1000, data: { message: { content: [{ type: 'text', text }] } } }
  : { type: 'user/message', seq, time: T0 + seq * 1000, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

// `a` never went to a second part; `b` ended `p1` and is in `p2` now.
const HISTORY = {
  solo: [line(0, 'first line'), line(1, 'the url is https://example.test/xyz keep it')],
  p1: [line(0, 'first line'), line(1, 'second line'), line(2, 'the url is https://example.test/xyz keep it'), line(3, 'fourth line')],
  p2: [
    line(0, 'a different part begins'),
    line(1, 'reply one'),
    line(2, 'reply two, nothing to do with the url'),
    line(3, 'reply three'),
    line(4, 'reply four'),
    line(5, 'reply five'),
  ],
}

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', sessionId: 'solo', name: 'Solo', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b: {
      id: 'b',
      sessionId: 'p2',
      name: 'Split',
      role: 'Dev',
      model: 'deepseek/v4',
      instructions: '',
      createdAt: 2,
      segments: [{ sessionId: 'p1', endedAt: T0 + 6000 }],
    },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 1,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-anchor-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()), { mode: 0o600 })
  const ctx = fakeContext()
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  return { home, ctx, rt, tool, call: async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json() }
}

test('an anchor names its part while the chat still has one part (#2710)', async (t) => {
  const host = await start(t)
  const found = await host.rt.searchOwnChat('a', 'example.test', {})
  assert.equal(found.lines.length, 1)
  assert.match(found.lines[0], /^\[part 1 #1 · /, `printed ${found.lines[0]}`)
  assert.doesNotMatch(found.lines[0], /^\[#/, 'a bare anchor is what a later split makes wrong')

  // The same anchor in a chat that did split names the earlier part, not the current one.
  const split = await host.rt.latestOwnChat('b', {})
  const inFirstPart = split.lines.find(entry => entry.includes('example.test'))
  assert.match(inFirstPart, /^\[part 1 #2 · /, `printed ${inFirstPart}`)
})

test('an anchor printed before a split still reaches the part it came from (#2710)', async (t) => {
  const host = await start(t)
  const found = await host.rt.aroundOwnChat('b', 'part 1 #2')
  assert.equal(found.part.sessionId, 'p1')
  assert.equal(found.exact, true)
  assert.equal(found.guessedPart, false)
  assert.ok(found.lines.some(entry => entry.includes('example.test')), 'the real source is what comes back')
  assert.ok(found.lines.some(entry => entry.startsWith('[part 1 #2 · ')), 'and it still reads as part 1')
})

test('a bare old anchor still resolves, but says it guessed the part (#2710)', async (t) => {
  const host = await start(t)
  const found = await host.rt.aroundOwnChat('b', '#2')
  // The compatibility the old anchors keep: a bare form means the current part.
  assert.equal(found.part.sessionId, 'p2')
  assert.equal(found.guessedPart, true)
  assert.notEqual(found.exact, true, 'a guessed part is never an exact hit')
  assert.ok(!found.lines.some(entry => entry.includes('example.test')), 'this is the other part')

  // What the Bot reads says the part was a guess, and never claims there is no such message.
  const out = await host.tool('read_own_chat', { around: '#2' }, 'p2')
  assert.match(out, /so the part is a guess/)
  assert.doesNotMatch(out, /with no message at/)
  assert.doesNotMatch(out, /example\.test/)
})

test('a named part is exact only when that part holds the seq (#2710)', async (t) => {
  const host = await start(t)
  const hit = await host.rt.aroundOwnChat('b', 'part 2 #2')
  assert.deepEqual([hit.part.sessionId, hit.exact, hit.guessedPart], ['p2', true, false])
  assert.ok(hit.lines.some(entry => entry.includes('reply two')))

  const miss = await host.rt.aroundOwnChat('b', 'part 2 #99')
  assert.deepEqual([miss.part.sessionId, miss.exact, miss.guessedPart], ['p2', false, false])
  const out = await host.tool('read_own_chat', { around: 'part 2 #99' }, 'p2')
  assert.match(out, /with no message at part 2 #99; the nearest ones/)

  // With one part a bare anchor is unambiguous, so nothing was guessed and the hit is exact.
  const solo = await host.rt.aroundOwnChat('a', '#1')
  assert.deepEqual([solo.part.sessionId, solo.exact, solo.guessedPart], ['solo', true, false])
})

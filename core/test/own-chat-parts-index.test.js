// A Bot's own chat is one conversation across several parts, and `read_own_chat` has to say so: a read
// that ends inside the current part still leaves the closed parts outside what was shown, and the only
// pointer to them is the index sentence `Your own chat has N parts: part 1 (… – …), part 2 (… – now).`
// together with the `read_own_chat with part N` hint (#1906, #2774). Nothing pinned that sentence: a
// change that printed it only for three or more parts would leave a two-part chat reading as a whole
// one, and the Bot would never look for the handoff note that closed the part it can no longer see.
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
const HISTORY = {
  p1: [line(0, 'earlier one'), line(1, 'earlier two'), line(2, 'earlier three', 'you'), line(3, 'earlier four')],
  p2: Array.from({ length: 10 }, (_, i) => line(i, `current ${i + 1}`, i % 2 === 0 ? 'user' : 'you')),
}

const seed = (bot) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: { b: { id: 'b', name: 'Split', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 2, ...bot } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 1,
})

async function start(t, bot) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-own-parts-index-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(bot)), { mode: 0o600 })
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
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  return { home, ctx, rt, tool }
}

const TWO_PARTS = { sessionId: 'p2', segments: [{ sessionId: 'p1', endedAt: T0 + 6000 }] }

test('a read across two parts names both and points at the part read', async (t) => {
  const host = await start(t, TWO_PARTS)
  const out = await host.tool('read_own_chat', {}, 'p2')
  assert.match(out, /^Your own chat has 2 parts: part 1 \(.+ – .+\), part 2 \(.+ – now\)\. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts\.$/m, `the index names every part and the way back to the closed one: ${out.split('\n').slice(-1)[0]}`)
})

test('a one-part chat carries no part index', async (t) => {
  const host = await start(t, { sessionId: 'p2' })
  const out = await host.tool('read_own_chat', {}, 'p2')
  assert.match(out, /^Your own chat \(oldest first\):$/m, `the single part reads as before: ${out.split('\n')[0]}`)
  assert.doesNotMatch(out, /Your own chat has \d+ parts/, `nothing to index when there is one part: ${out}`)
})

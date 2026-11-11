// A Bot's own chat is read across every part of it, and so is the count the capped read reports: with
// 4 messages in the part that ended and 10 in the one that is current, a read of the newest 12 is
// `newest 12 of 14`. Counting only the current part would answer 10 messages and drop the heading, so
// the Bot would read a chat that has 14 messages as if it had 10. This pins the cross-part total.
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

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-own-parts-'))
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
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  return { home, ctx, rt, tool }
}

test('the capped own-chat read counts the messages of every part it spans', async (t) => {
  const host = await start(t)
  const out = await host.tool('read_own_chat', {}, 'p2')
  const shown = out.split('\n').filter(entry => entry.startsWith('[part '))
  assert.equal(shown.length, 12, `the read spans both parts and stops at the cap: ${out.split('\n')[0]}`)
  assert.match(out, /^Your own chat \(newest 12 of 14, oldest first\):$/m, `the count covers the 4 messages of the earlier part too: ${out.split('\n')[0]}`)
  assert.match(shown.at(-1), /current 10\b/, 'the newest message is the last one shown')
})

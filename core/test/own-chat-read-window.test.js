// `read_own_chat` with no words answers the newest messages of the Bot's chat with the user, capped at
// `OWN_CHAT_READ` (12) per read, and says how many it left out: `Your own chat (newest N of M, oldest
// first)` with `more` coming from the chat index's count over every part (#1906). Nothing pinned that
// heading, so a change that lost the count — or counted a part twice — would still leave the lines in
// place and read as a short chat. This pins the cap, the closing count and the newest line together.
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
const HISTORY = { s1: Array.from({ length: 20 }, (_, i) => line(i, `message ${i + 1}`, i % 2 === 0 ? 'user' : 'you')) }

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', sessionId: 's1', name: 'Solo', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 1 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 1,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-own-window-'))
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

test('a capped own-chat read says how many messages it left out', async (t) => {
  const host = await start(t)
  const out = await host.tool('read_own_chat', {}, 's1')
  const shown = out.split('\n').filter(entry => entry.startsWith('[part 1 #'))
  assert.equal(shown.length, 12, `the read shows the 12 the cap allows: ${out.split('\n')[0]}`)
  assert.match(out, /^Your own chat \(newest 12 of 20, oldest first\):$/m, `the heading carries the count the cap left out: ${out.split('\n')[0]}`)
  assert.match(shown[0], /message 9\b/, 'the window starts at the ninth message, not the first')
  assert.match(shown.at(-1), /message 20\b/, 'and ends on the newest one')
})

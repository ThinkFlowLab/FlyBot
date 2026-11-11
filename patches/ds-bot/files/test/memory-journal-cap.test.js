import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The memory journal is a side channel: it keeps the newest changes, not every change a home
// ever made. The caps below are the ones `src/host/memory.js` writes down (`JOURNAL_KEPT` and
// `JOURNAL_MAX_BYTES`); the test states them itself so a silent widening of either cap fails
// here, the way the state journal's own cap test does.
const KEPT = 500
const MAX_BYTES = 1_024 * 1_024

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved.' }] } } } },
]

// A real host (`apply()`), with only the services the memory tools ask for.
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-journal-')) } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      async* stream() {
        yield { type: 'text-delta', index: 0, text: '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: ownChat.at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async () => ({ records: ownChat, hasMore: false }),
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  apply(ctx, { home })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const journalPath = join(home, 'memory', 'journal.jsonl')
  const read = () => readFileSync(journalPath, 'utf8')
  const lines = () => read().split('\n').filter(Boolean)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { tool, journalPath, read, lines, stop }
}

test('the memory journal keeps its newest lines, like the state journal', async (t) => {
  const { tool, journalPath, read, lines, stop } = start()
  t.after(() => stop())

  // 300 turns of saving one fact and forgetting it again: the memory itself is back to its
  // empty skeleton at the end, while the journal would be 600 lines if nothing ever pruned it.
  for (let i = 0; i < 300; i++) {
    await tool('remember', { text: `Note number ${i}` }, 'b2')
    await tool('forget', { entry: `Note number ${i}` }, 'b2')
  }

  const size = statSync(journalPath).size
  const kept = lines()
  assert.ok(size <= MAX_BYTES, `the journal stays at or under ${MAX_BYTES} bytes (it is ${size})`)
  assert.ok(kept.length <= KEPT, `the journal keeps at most ${KEPT} lines (it keeps ${kept.length})`)
  assert.equal(read().includes('Note number 0'), false, 'the oldest changes are folded away, not kept')
  const first = JSON.parse(kept[0])
  assert.equal(first.op, 'truncated', 'the folded changes are named by one record at the top')
  // 600 changes, the newest 500 kept with one fold line among them: exactly 101 were replaced.
  assert.equal(first.dropped, 101, `the folded record counts exactly what it replaced (got ${first.dropped})`)
  assert.equal(first.dropped + kept.length - 1, 600, 'every change is either kept or counted')

  // Trimming keeps the newest side: a change made after the prune is on disk.
  await tool('remember', { text: 'Note number last' }, 'b2')
  const after = lines()
  assert.ok(after.length <= KEPT, `the journal still keeps at most ${KEPT} lines (it keeps ${after.length})`)
  assert.match(after.at(-1), /Note number last/, 'the newest change is still recorded after a prune')
})

test('a second fold keeps the tally without counting its own fold line', async (t) => {
  const { tool, lines, stop } = start()
  t.after(() => stop())

  // 800 changes: the journal folded twice. The second fold line replaces the first one, and a line
  // that is itself a fold is not a change of its own, so it is not counted as one again (#2816).
  // The newest 500 lines are kept with one fold line among them, so exactly 301 were replaced.
  for (let i = 0; i < 400; i++) {
    await tool('remember', { text: `Note number ${i}` }, 'b2')
    await tool('forget', { entry: `Note number ${i}` }, 'b2')
  }
  const kept = lines()
  assert.ok(kept.length <= KEPT, `the journal keeps at most ${KEPT} lines (it keeps ${kept.length})`)
  const first = JSON.parse(kept[0])
  assert.equal(first.op, 'truncated', 'the folded changes are still named by one record at the top')
  assert.equal(first.dropped, 301, `the second fold counts exactly what it replaced (got ${first.dropped})`)
  assert.equal(first.dropped + kept.length - 1, 800, 'every change is either kept or counted, across folds')
})

// Two indexers over one home used to read the same part mark before either committed, so
// both inserted the same events and every message came back twice; and a window another
// dsh keeps read-only still opened the index for writing (#2711).
//
// Real module, a temporary home, real SQLite, and a fake Session log as the source.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const T0 = 1_760_000_000_000
const INDEX = 'chat-index.sqlite'

const line = (seq, text) => ({
  type: 'user/message',
  seq,
  time: T0 + seq * 1000,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const SAID = ['first line', 'second line', 'third line']
const HISTORY = { solo: SAID.map((text, seq) => line(seq, text)) }

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

const scratch = (t, name = 'ds-bot-index-') => {
  const home = mkdtempSync(join(tmpdir(), name))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  return home
}

// Holds every page read until `parties` of them are waiting, so two indexers pass the mark
// read before either commits — the interleaving that produced the duplicate rows. Real
// hosts reach it by reading one part slowly.
//
// A party that never arrives must fail the test, not stall the whole suite until the CI
// job is cancelled: a wait gives up after BARRIER_TIMEOUT_MS and names how many turned up.
// The timer does not hold the process open once the test is done.
const BARRIER_TIMEOUT_MS = 30_000

function barrier(parties) {
  let waiting = []
  let open = false
  return async () => {
    if (open) return
    await new Promise((resolve, reject) => {
      const arrive = () => {
        waiting = waiting.filter(item => item !== party)
        reject(new Error(`barrier timeout: only ${waiting.length} of ${parties} parties arrived`))
      }
      const party = { resolve, timer: setTimeout(arrive, BARRIER_TIMEOUT_MS) }
      party.timer.unref()
      waiting.push(party)
      if (waiting.length >= parties) {
        open = true
        const release = waiting
        waiting = []
        for (const item of release) {
          clearTimeout(item.timer)
          item.resolve()
        }
      }
    })
  }
}

// One host over `home`: the whole core with a fake Session controller, as a second dsh
// would open the same home. `heldBy` puts a live other pid in `state.lock` first, so this
// host is the read-only window `home-lock` describes.
async function start(t, home, { heldBy, gate } = {}) {
  if (heldBy !== undefined) {
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: heldBy, host: hostname(), token: 'other', since: Date.now() }))
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()), { mode: 0o600 })
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.map(part => String(part)).join(' '))
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    sessionController: {
      create: async () => ({ sessionId: 'fresh' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (HISTORY[sessionId]?.at(-1)?.seq ?? -1) + 1 }, followup() {} } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages } = {}) => {
        if (gate !== undefined) await gate()
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
  // The runtime loads its own state asynchronously (`void rt.load()` on install), and
  // `partsOf` reads the loaded roster: a read that runs before that load finished sees no
  // parts, returns `{lines: []}` and never calls `sessionController.page()`, so the party
  // this test's gate waits for never arrives. Wait for the load the host relies on.
  await rt.load()
  const host = { home, ctx, rt, warnings, stop: () => ctx.dispose() }
  t.after(() => host.stop())
  return host
}

// The seq each read line cites, so a doubled row is visible as a repeated anchor.
const anchorsOf = read => read.lines.map(entry => /^\[part \d+ #(\d+) · /.exec(entry)?.[1] ?? entry)

// The index's own rows, read outside the host: a duplicate is in the file, not only in a
// repeat of the answer.
function rowsOf(home) {
  const db = new DatabaseSync(join(home, INDEX), { readOnly: true })
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM lines').get().n
  } finally {
    db.close()
  }
}

// The index a build before #2711 wrote: one FTS5 table with no uniqueness at all, holding
// both copies of every event, and a mark that says the part is caught up.
function writeDuplicatedIndex(home) {
  const db = new DatabaseSync(join(home, INDEX))
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, tokenize = 'trigram');
      CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);`)
    db.exec('PRAGMA user_version = 3')
    const insert = db.prepare('INSERT INTO lines (text, session, seq, time, who) VALUES (?, ?, ?, ?, ?)')
    for (let copy = 0; copy < 2; copy += 1) {
      for (const event of HISTORY.solo) insert.run(event.data.content[0].text, 'solo', event.seq, event.time, 'user')
    }
    db.prepare('INSERT INTO marks (session, through, keep, sealed, turn) VALUES (?, ?, ?, ?, ?)').run('solo', 2, 0, 0, -1)
  } finally {
    db.close()
  }
}

test('two indexers started together write each source line once (#2711)', async (t) => {
  const home = scratch(t)
  const gate = barrier(2)
  const first = await start(t, home, { gate })
  const second = await start(t, home, { gate })

  // Neither has committed when the other starts: both used to read the same `through = -1`.
  const [a, b] = await Promise.all([first.rt.latestOwnChat('a', {}), second.rt.latestOwnChat('a', {})])
  for (const read of [a, b]) {
    assert.deepEqual(anchorsOf(read), ['0', '1', '2'], `every source line once, got ${JSON.stringify(read.lines)}`)
    assert.equal(read.more, 0)
  }

  // The counts double too when the rows do, so a capped read says what it left out.
  const capped = await second.rt.latestOwnChat('a', { limit: 2 })
  assert.deepEqual(anchorsOf(capped), ['1', '2'])
  assert.equal(capped.more, 1, 'three source lines, two shown')

  const found = await first.rt.searchOwnChat('a', 'second line', {})
  assert.deepEqual(found.lines.length, 1, found.lines.join('\n'))

  // What was written, not only what was answered.
  assert.equal(rowsOf(home), 3)
})

test('the same two indexers run one after the other write three rows', async (t) => {
  const home = scratch(t)
  const first = await start(t, home)
  assert.deepEqual(anchorsOf(await first.rt.latestOwnChat('a', {})), ['0', '1', '2'])
  await first.stop()

  const second = await start(t, home)
  assert.deepEqual(anchorsOf(await second.rt.latestOwnChat('a', {})), ['0', '1', '2'])
  assert.equal(rowsOf(home), 3)
})

test('a read-only window reads the index and leaves it alone (#2711)', async (t) => {
  const home = scratch(t)
  const writer = await start(t, home)
  assert.deepEqual(anchorsOf(await writer.rt.latestOwnChat('a', {})), ['0', '1', '2'])
  await writer.stop()

  const indexPath = join(home, INDEX)
  const before = readFileSync(indexPath)
  const stamp = statSync(indexPath).mtimeMs

  // A message the writer never indexed: this window must not add it either.
  HISTORY.solo.push(line(3, 'a fourth line'))
  try {
    // Another dsh holds the home, so this window only reads.
    const reader = await start(t, home, { heldBy: process.ppid })
    await reader.rt.load()
    assert.notEqual(reader.rt.readOnly(), undefined, 'this window must be read-only for the case to mean anything')
    const read = await reader.rt.latestOwnChat('a', {})
    assert.deepEqual(anchorsOf(read), ['0', '1', '2'])
    assert.equal(read.more, 0)
    assert.deepEqual(readFileSync(indexPath), before, 'the read-only window wrote the index')
    assert.equal(statSync(indexPath).mtimeMs, stamp)
    assert.equal(rowsOf(home), 3)
  } finally {
    HISTORY.solo.pop()
  }
})

test('a read-only window reads the index while the writer still holds the home (#2711)', async (t) => {
  const home = scratch(t)
  const writer = await start(t, home)
  assert.deepEqual(anchorsOf(await writer.rt.latestOwnChat('a', {})), ['0', '1', '2'])

  // The writer is still open, as the other dsh would be, and has not seen this message.
  HISTORY.solo.push(line(3, 'a fourth line'))
  try {
    const reader = await start(t, home, { heldBy: process.ppid })
    await reader.rt.load()
    assert.notEqual(reader.rt.readOnly(), undefined)
    assert.deepEqual(anchorsOf(await reader.rt.latestOwnChat('a', {})), ['0', '1', '2'])
    assert.equal(rowsOf(home), 3, 'the reader added a message the writer had not indexed')
  } finally {
    HISTORY.solo.pop()
  }
})

test('a read-only window creates no index where there is none (#2711)', async (t) => {
  const home = scratch(t)
  const reader = await start(t, home, { heldBy: process.ppid })
  await reader.rt.load()
  assert.notEqual(reader.rt.readOnly(), undefined)

  // Without an index the logs answer (no anchors there), and that read is the whole of
  // what this window does.
  const read = await reader.rt.latestOwnChat('a', {})
  assert.equal(read.lines.length, 3)
  for (const entry of read.lines) assert.match(entry, /line$/)
  assert.equal(existsSync(join(home, INDEX)), false, 'a read-only window created the index')
})

test('an index two writers already duplicated is rebuilt once at startup (#2711)', async (t) => {
  const home = scratch(t)
  writeDuplicatedIndex(home)
  assert.equal(rowsOf(home), 6, 'the fixture must hold the defect, or the test proves nothing')

  const host = await start(t, home)
  const read = await host.rt.latestOwnChat('a', {})
  assert.deepEqual(anchorsOf(read), ['0', '1', '2'])
  assert.equal(read.more, 0)
  assert.equal(rowsOf(home), 3, 'the rebuilt index holds one row per source line')
  assert.match(host.warnings.join('\n'), /rebuilt the chat index/)
})

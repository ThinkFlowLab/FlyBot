// Two indexers over one home used to read the same part mark before either committed, so
// both inserted the same events and every message came back twice; and a window another
// dsh keeps read-only still opened the index for writing (#2711).
//
// Real module, a temporary home, real SQLite, and a fake Session log as the source.
//
// P-820: the palette's message search reads the turnOutline projection, whose prompt and
// response previews stop at 50/120 characters, so a hit past that budget found nothing. The
// index this file already exercises holds the whole text, and the palette reaches it through
// `searchHomeChat` and the channel's `chats.search` — answered with only the caller's chats.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { hashToken } from '../src/host/member-auth.js'

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

// Two members, each with their own Bot, one room both of them sit in, and both signed in: the
// shape `chats.search` has to scope. `r1` carries owner-2's Bot, so owner-1's view holds it —
// and `duo`, that Bot's own chat, is not room content. The seed stays otherwise identical to
// the single-Bot one.
const TOKEN_OWNER_1 = 'tok-owner-1'
const TOKEN_OWNER_2 = 'tok-owner-2'
const sharedSeed = () => ({
  version: 2,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2 },
  },
  bots: {
    a: { id: 'a', sessionId: 'solo', name: 'Solo', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    b: { id: 'b', sessionId: 'duo', name: 'Duo', role: 'Dev', model: 'deepseek/v4', instructions: '', createdAt: 2, ownerId: 'owner-2' },
  },
  authSessions: {
    s1: { id: 's1', tokenHash: hashToken(TOKEN_OWNER_1), memberId: 'owner-1', createdAt: 3, revokedAt: null },
    s2: { id: 's2', tokenHash: hashToken(TOKEN_OWNER_2), memberId: 'owner-2', createdAt: 3, revokedAt: null },
  },
  // A room with the two members' Bots, one seat each: only `rsess` is room content.
  rooms: {
    r1: {
      id: 'r1', name: 'Shared', members: ['a', 'b'], admin: 'a', sessions: { a: 'rsess' },
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', joinedSeq: 0 },
        { kind: 'human', id: 'owner-2', role: 'member', joinedSeq: 0 },
        { kind: 'bot', id: 'a', role: 'admin', joinedSeq: 0 },
        { kind: 'bot', id: 'b', role: 'member', joinedSeq: 0 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 1,
})

// The history the palette's defect lives in: a line whose match sits far past the 120
// characters the outline projection keeps, inside a turn that is not the first one.
const NEEDLE_LINE = 'x'.repeat(300) + ' NEEDLE'
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: T0 + seq * 1000, data: { turn } })

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
// host is the read-only window `home-lock` describes. `saved` swaps the state seed in, and
// the host's `route` is the /api/bot Fetch route the channel registered.
async function start(t, home, { heldBy, gate, saved } = {}) {
  if (heldBy !== undefined) {
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: heldBy, host: hostname(), token: 'other', since: Date.now() }))
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved ?? seed()), { mode: 0o600 })
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args.map(part => String(part)).join(' '))
  let route
  const registered = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return registered(options) }
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
  const host = { home, ctx, rt, route, warnings, stop: () => ctx.dispose() }
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

// P-820. The host's whole-text search across given sessions: the palette's outline search
// misses any hit past the 50/120-character preview, and this read is what fills that gap.
// The row names the turn the hit belongs to, which is how the palette jumps to it.
test('the whole-text search finds a line past the outline budget, with its turn (P-820)', async (t) => {
  const home = scratch(t)
  HISTORY.duo = [turnStart(0, 4), line(1, 'a plain line'), turnStart(2, 5), line(3, NEEDLE_LINE)]
  try {
    const host = await start(t, home)
    const read = await host.rt.searchHomeChat(['solo', 'duo'], 'needle', {})
    assert.equal(read.rows.length, 1, JSON.stringify(read))
    const [row] = read.rows
    assert.equal(row.session, 'duo')
    assert.equal(row.seq, 3)
    assert.equal(row.turn, 5, 'the row names the turn the hit belongs to')
    assert.match(row.text, /NEEDLE/)
    assert.equal(read.more, 0)

    // A chat the caller did not list is not searched, and the caller's list is what the
    // channel scopes per member: this read never widens it on its own.
    const own = await host.rt.searchHomeChat(['solo'], 'needle', {})
    assert.equal(own.rows.length, 0)
  } finally {
    delete HISTORY.duo
  }
})

// P-820. The channel action the palette calls: `chats.search` answers through /api/bot with
// the signed-in member's chats only — owner-2 signs in, and owner-1's Bot never shows up even
// though its own history is served by the same host.
test('chats.search answers through the channel with only the caller\'s chats (P-820)', async (t) => {
  const home = scratch(t, 'ds-bot-index-search-')
  HISTORY.duo = [turnStart(0, 4), line(1, 'a plain line'), turnStart(2, 5), line(3, NEEDLE_LINE)]
  try {
    const host = await start(t, home, { saved: sharedSeed() })
    assert.notEqual(host.route, undefined, 'the channel registered its /api/bot route')
    const response = await host.route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      headers: { 'x-flybot-member-session': TOKEN_OWNER_2 },
      body: JSON.stringify({ endpoint: 'chats.search', payload: { query: 'needle' } }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.rows.map(row => row.chat), ['b'], JSON.stringify(result.value))
    assert.equal(result.value.rows[0].turn, 5)
    assert.match(result.value.rows[0].text, /NEEDLE/)
  } finally {
    delete HISTORY.duo
  }
})

// #3114. A row already names the turn the hit belongs to; it now names the part too, so the
// client can open that part instead of only marking the hit as earlier. The part is the part's
// own Session id — the same `session` the index rows carry — and it is only for a Bot's own
// chat: a room's row is not a part the palette may open, so it carries none.
test('#3114: a chats.search row names the part the hit was said in', async (t) => {
  const home = scratch(t, 'ds-bot-index-part-')
  HISTORY.older = [turnStart(0, 4), line(1, 'a plain line'), turnStart(2, 5), line(3, NEEDLE_LINE)]
  try {
    const seeded = seed()
    seeded.bots.a.segments = [{ sessionId: 'older', endedAt: T0 + 9000 }]
    const host = await start(t, home, { saved: seeded })
    assert.notEqual(host.route, undefined, 'the channel registered its /api/bot route')
    const response = await host.route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'chats.search', payload: { query: 'needle' } }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.rows.map(row => [row.chat, row.part, row.turn]), [['a', 'older', 5]], JSON.stringify(result.value))
  } finally {
    delete HISTORY.older
  }
})

// The same view, the security case: a shared room renders because it keeps the other member's
// Bot in `bots`, and that Bot's own chat is not room content. owner-1 sits in `r1` with
// owner-2's Bot `b`; `duo` is b's own chat. Searching it as owner-1 must answer nothing, while
// the room's own Session stays readable — a room is shared by design, a Bot's chat is not.
const ROOM_LINE = 'hello from the room'
test('chats.search never reads another member\'s Bot own chat through a shared room (P-820)', async (t) => {
  const home = scratch(t, 'ds-bot-index-shared-')
  HISTORY.duo = [line(0, 'owner-2 private SECRETNEEDLE words')]
  HISTORY.rsess = [line(0, ROOM_LINE)]
  try {
    const host = await start(t, home, { saved: sharedSeed() })
    assert.notEqual(host.route, undefined, 'the channel registered its /api/bot route')
    const ask = async (token, query) => {
      const response = await host.route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST',
        headers: { 'x-flybot-member-session': token },
        body: JSON.stringify({ endpoint: 'chats.search', payload: { query } }),
      }))
      return response.json()
    }

    // The view carries owner-2's Bot (the room needs it) but never its own chat.
    const leaked = await ask(TOKEN_OWNER_1, 'secretneedle')
    assert.equal(leaked.ok, true, JSON.stringify(leaked))
    assert.deepEqual(leaked.value.rows, [], JSON.stringify(leaked.value))

    // The room's own Session is room content: still found, and mapped to the room.
    const shared = await ask(TOKEN_OWNER_1, 'hello')
    assert.equal(shared.ok, true, JSON.stringify(shared))
    assert.deepEqual(shared.value.rows.map(row => row.chat), ['r1'], JSON.stringify(shared.value))
    assert.match(shared.value.rows[0].text, /hello from the room/)
    assert.equal('part' in shared.value.rows[0], false, 'a room row names no part: the member part is not a chat to open')

    // What the fix restores: the refused read the state view already refused, at both layers.
    const refused = await host.route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      headers: { 'x-flybot-member-session': TOKEN_OWNER_1 },
      body: JSON.stringify({ endpoint: 'earlier', payload: { sessionId: 'duo' } }),
    }))
    const refusedBody = await refused.json()
    assert.equal(refusedBody.ok, false, JSON.stringify(refusedBody))
    assert.equal(refusedBody.error.code, 'bot/forbidden')
    const actor1 = await host.rt.authenticate(TOKEN_OWNER_1)
    assert.equal(host.rt.sessionOwnedBy(actor1, 'duo'), false, 'another member\'s Bot chat is not the actor\'s')
    assert.equal(host.rt.sessionOwnedBy(actor1, 'rsess'), true, 'the room Session is the actor\'s to read')
  } finally {
    delete HISTORY.duo
    delete HISTORY.rsess
  }
})

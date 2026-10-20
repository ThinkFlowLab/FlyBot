import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { JournalError, applyChange, diffState, openJournal, parseJournal, pruneEntries, replayTo, stateText } from '../src/host/journal.js'
import { fakeContext } from './fake-ctx.js'

const DAY = 24 * 60 * 60 * 1000
const posix = process.platform !== 'win32'
const lines = entries => entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-journal-'))

// A team with stand-in services: Bot answers are played back as Session events, so a
// group round runs with no model (the same stand-ins as rounds.test.js).
function start(config = {}) {
  const home = tempHome()
  const ctx = fakeContext()
  const warnings = []
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) inboxes.set(sessionId, { nextTurn: [], nextStep: [], remove: () => false })
    return inboxes.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    logger: { warn: (template, line) => warnings.push(String(line)), info() {} },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        inboxOf(request.sessionId).nextTurn.push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
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
  const rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const relay = roomId => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId: randomUUID(), signal: new AbortController().signal })
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const journalPath = join(home, 'journal', 'state.jsonl')
  return { call, emit, relay, answer, sent, stop, rt, home, journalPath, warnings }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

test('a recorded 3-Bot interaction replays to a byte-identical state.json at every step (#511)', async (t) => {
  const team = start({ stateJournal: true })
  t.after(team.stop)
  const { call, rt, home, journalPath } = team
  // After each step: the bytes of state.json and the journal's last entry.
  const steps = []
  const mark = async () => {
    await rt.save()
    const text = readFileSync(journalPath, 'utf8')
    steps.push({ bytes: readFileSync(join(home, 'state.json'), 'utf8'), seq: parseJournal(text).at(-1).seq })
  }

  const chief = (await call('state', {})).value.mainBotId
  await mark()
  const writer = (await call('create-bot', { name: 'Writer' })).value
  await mark()
  const reviewer = (await call('create-bot', { name: 'Reviewer' })).value
  await mark()
  const room = (await call('create-room', { name: 'Desk', members: [chief, writer.id, reviewer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  await mark()
  await call('update-bot', { id: writer.id, name: 'Editor' })
  await mark()

  // One group round: each Bot answers in turn, which adds exchanges and turn records.
  await team.emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Plan the launch' }] } })
  const running = team.relay(room.id)
  const answered = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const next = await waitFor(() => team.sent.find(entry => !answered.includes(entry) && entry.message.source.role === 'room'))
    if (next === undefined) break
    answered.push(next)
    await team.answer(next.sessionId, next.message.source.exchangeId, `Answer ${turn}`, turn)
  }
  await running
  assert.ok(answered.length >= 2, 'at least two Bots answered in the round')
  await mark()
  await call('delete-bot', { id: reviewer.id })
  await mark()

  const text = readFileSync(journalPath, 'utf8')
  const entries = parseJournal(text)
  assert.equal(entries[0].op, 'base')
  assert.ok(entries.some(entry => entry.op === 'append' && entry.key.join('.') === `rooms.${room.id}.log`), 'the group log is recorded as appends')
  assert.ok(entries.some(entry => entry.botId === writer.id && entry.op === 'set' && entry.key.at(-1) === 'name'), 'a Bot change names its Bot')
  assert.ok(entries.some(entry => entry.botId === reviewer.id && entry.op === 'delete'), 'a removed Bot is a delete')
  for (const { bytes, seq } of steps) assert.equal(stateText(replayTo(text, seq)), bytes, `replay to ${seq}`)
  if (posix) {
    assert.equal(statSync(journalPath).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, 'journal')).mode & 0o777, 0o700)
  }
})

test('without stateJournal nothing is recorded (#511)', async (t) => {
  const team = start()
  t.after(team.stop)
  await team.call('state', {})
  await team.call('create-bot', { name: 'Writer' })
  await team.rt.save()
  assert.equal(existsSync(join(team.home, 'state.json')), true)
  assert.equal(existsSync(join(team.home, 'journal')), false)
})

test('the writer stops recording and leaves the file when its journal does not replay (#511)', async () => {
  const home = tempHome()
  const path = join(home, 'journal', 'state.jsonl')
  mkdirSync(join(home, 'journal'))
  const broken = `${JSON.stringify({ seq: 1, t: 1, op: 'base', next: { version: 2 } })}\n{"seq":2,"t":`
  writeFileSync(path, broken)
  const warnings = []
  const journal = openJournal({ path, warn: (...args) => warnings.push(args.join(' ')) })
  await journal.record(stateText({ version: 2, revision: 1 }))
  assert.equal(readFileSync(path, 'utf8'), broken, 'the journal is left as it was')
  assert.match(warnings.join('\n'), /not recording/)
  rmSync(home, { recursive: true, force: true })
})

test('replay fails closed on a corrupt, unknown, out-of-order or inconsistent line (#511)', () => {
  const base = { seq: 1, t: 1, op: 'base', next: { version: 2, bots: {} } }
  const set = { seq: 2, t: 2, op: 'set', key: ['bots', 'a'], next: { id: 'a' }, botId: 'a', actor: 'host' }
  assert.deepEqual(replayTo(lines([base, set])), { version: 2, bots: { a: { id: 'a' } } })
  const refused = [
    `${lines([base])}not json\n`,
    lines([base, { ...set, op: 'merge' }]),
    lines([base, { ...set, seq: 3 }]),
    lines([set]),
    lines([base, set]).slice(0, -1),
    lines([base, set, { ...set, seq: 3 }]),
    lines([base, set, { seq: 3, t: 3, op: 'delete', key: ['bots', 'a'], prev: { id: 'b' } }]),
    lines([base, { seq: 2, t: 2, op: 'append', key: ['bots'], prevLength: 0, drop: 0, next: [1] }]),
  ]
  for (const text of refused) assert.throws(() => replayTo(text), JournalError)
  assert.throws(() => replayTo(lines([base, set]), 5), /outside this journal/)
})

test('changes record the smallest step that rebuilds the exact bytes (#511)', () => {
  const before = { version: 2, bots: { a: { id: 'a', name: 'A' } }, exchanges: [1, 2, 3], revision: 1 }
  const after = { version: 2, bots: { a: { id: 'a', name: 'B' }, b: { id: 'b' } }, exchanges: [2, 3, 4, 5], revision: 2 }
  const changes = diffState(before, after)
  assert.deepEqual(changes.map(change => [change.op, change.key.join('.')]), [['set', 'bots.a.name'], ['set', 'bots.b'], ['append', 'exchanges'], ['set', 'revision']])
  assert.deepEqual(changes[2], { op: 'append', key: ['exchanges'], prevLength: 3, drop: 1, next: [4, 5] })
  let state = JSON.parse(JSON.stringify(before))
  for (const change of changes) state = applyChange(state, change)
  assert.equal(stateText(state), stateText(after))
  // A key reorder alone has no per-key change, so it is one base line.
  const reordered = { version: 2, revision: 1, bots: before.bots, exchanges: before.exchanges }
  assert.deepEqual(diffState(before, reordered).map(change => change.op), ['base'])
  // A key named __proto__ stays plain data.
  const odd = JSON.parse('{"version":2,"prefs":{"__proto__":{"polluted":true}}}')
  const rebuilt = diffState({ version: 2, prefs: {} }, odd).reduce(applyChange, { version: 2, prefs: {} })
  assert.equal(stateText(rebuilt), stateText(odd))
  assert.equal({}.polluted, undefined)
})

test('retention drops the oldest lines past 7 days or 20 MB and the rest still replays (#511)', () => {
  const now = 30 * DAY
  const entries = [{ seq: 1, t: 0, op: 'base', next: { n: 0 } }]
  for (let n = 1; n <= 10; n += 1) entries.push({ seq: n + 1, t: now - (11 - n) * DAY, op: 'set', key: ['n'], prev: n - 1, next: n, actor: 'host' })
  const byAge = pruneEntries(entries, { now })
  assert.equal(byAge[0].op, 'base')
  assert.ok(byAge.slice(1).every(entry => now - entry.t <= 7 * DAY))
  assert.equal(stateText(replayTo(lines(byAge))), stateText({ n: 10 }))
  assert.equal(replayTo(lines(byAge), byAge[0].seq).n, byAge[1].prev)

  const fresh = entries.map(entry => ({ ...entry, t: now }))
  const bySize = pruneEntries(fresh, { now, maxBytes: lines(fresh).length - 1 })
  assert.ok(lines(bySize).length < lines(fresh).length - 1)
  assert.equal(stateText(replayTo(lines(bySize))), stateText({ n: 10 }))
  assert.equal(pruneEntries(fresh, { now }), fresh, 'within both caps nothing is dropped')
})

test('the writer prunes on disk and keeps the file private (#511)', async () => {
  const home = tempHome()
  const path = join(home, 'journal', 'state.jsonl')
  let clock = 0
  const journal = openJournal({ path, warn: () => {}, now: () => clock, maxAgeMs: 10 * DAY })
  for (let n = 0; n < 20; n += 1) {
    clock = n * DAY
    await journal.record(stateText({ version: 2, n }))
  }
  const entries = parseJournal(readFileSync(path, 'utf8'))
  assert.ok(entries.slice(1).every(entry => clock - entry.t <= 10 * DAY))
  assert.equal(entries[0].actor, 'retention')
  assert.equal(stateText(replayTo(readFileSync(path, 'utf8'))), stateText({ version: 2, n: 19 }))
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600)
  // A second host start continues the same journal.
  const again = openJournal({ path, warn: () => {}, now: () => clock })
  await again.record(stateText({ version: 2, n: 20 }))
  assert.equal(replayTo(readFileSync(path, 'utf8')).n, 20)
  rmSync(home, { recursive: true, force: true })
})

test('the dev replay script rebuilds a team to a seq, writes it 0600 and refuses a bad journal (#511)', () => {
  const home = tempHome()
  const journal = join(home, 'state.jsonl')
  const base = { seq: 1, t: 1, op: 'base', next: { version: 2, n: 0 } }
  const set = { seq: 2, t: 2, op: 'set', key: ['n'], prev: 0, next: 1, actor: 'host' }
  writeFileSync(journal, lines([base, set]))
  const script = join(import.meta.dirname, '..', 'scripts', 'replay.mjs')
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

  assert.equal(run(journal, '--to', '1').stdout, stateText({ version: 2, n: 0 }))
  const out = join(home, 'state.json')
  assert.equal(run(journal, '--out', out).status, 0)
  assert.equal(readFileSync(out, 'utf8'), stateText({ version: 2, n: 1 }))
  if (posix) assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(run(journal, '--out', out).status, 1, 'an existing file is never overwritten')

  writeFileSync(journal, `${lines([base])}{"seq":2}\n`)
  const bad = run(journal)
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /refused/)
  rmSync(home, { recursive: true, force: true })
})

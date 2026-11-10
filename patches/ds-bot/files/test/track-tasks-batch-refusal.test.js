// #2597: `track_tasks` created the first card of a batch while the later items were still
// being validated, and the batch `save()` only ran after the loop. An item two refusal — the
// `ask` + `column: 'done'` pair — unwound with the first card already in `state.tasks`, so the
// caller was told the batch failed while a card nobody asked for stayed on the board.
// The whole store is compared, not one field, so any other early write shows up too.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
  },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd1'], admin: 'a', mode: 'everyone', named: true, sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd1', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-batch-refusal-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'made-1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    try { await ctx.dispose() } catch {}
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const saves = []
  const save = rt.save
  rt.save = async () => { saves.push(1); return save() }
  return { rt, saves, home }
}

// A refused *store* write, not a refused validation: the temp name the store stages through is a
// link, so `tempWritable` refuses before one byte lands and every save rejects with `Not saved:`.
// The target outside the home is read back to prove the refusal wrote nothing.
function breakStoreWrites(t, home) {
  const outside = mkdtempSync(join(tmpdir(), 'ds-bot-batch-outside-'))
  const target = join(outside, 'outside.txt')
  writeFileSync(target, 'OUTSIDE\n')
  const temp = join(home, `state.json.${process.pid}.tmp`)
  symlinkSync(target, temp)
  const heal = () => { try { unlinkSync(temp) } catch { /* already gone */ } }
  t.after(() => { heal(); rmSync(outside, { recursive: true, force: true }) })
  return { heal, target, home }
}

const onDisk = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

// A card the board already holds, written straight into the state and saved, so the refusal tests
// start from a real stored board instead of a batch the refused save would also have created.
async function seed(rt, card) {
  rt.state.tasks[card.id] = card
  await rt.save()
  return card
}

const claimedCard = (over = {}) => ({
  id: 'task-held', status: 'claimed', createdAt: 10, updatedAt: 10,
  requesterId: 'owner-1', ownerBotId: 'd1', claimedBy: 'd1', title: 'Held card',
  source: 'conversation', origin: { roomId: 'war' },
  actors: [{ status: 'claimed', at: 10, by: 'claimed from the queue' }],
  ...over,
})

const snapshot = rt => JSON.stringify(rt.state.tasks)

test('a refused batch leaves state.tasks byte-identical (#2597)', async (t) => {
  const { rt, saves } = await start(t)
  const before = snapshot(rt)
  assert.equal(before, '{}')

  await assert.rejects(
    () => rt.trackBotTasks('d1', {
      tasks: [
        { title: 'First card' },
        { title: 'Second card', column: 'done', ask: 'Which one?' },
      ],
    }),
    error => error.code === 'bot/invalid' && /A task that needs an answer cannot be done/.test(error.message),
  )
  assert.equal(snapshot(rt), before, 'the refused batch left the store untouched')
  assert.equal(saves.length, 0, 'a refused batch is never saved')
})

test('a refused batch does not keep an earlier item\'s update to an existing card (#2597)', async (t) => {
  const { rt } = await start(t)
  const [card] = await rt.trackBotTasks('d1', { tasks: [{ title: 'Existing card' }] })
  const before = snapshot(rt)

  // Item one is accepted and would rename the card; item two is refused, so neither may land.
  await assert.rejects(
    () => rt.trackBotTasks('d1', {
      tasks: [
        { id: card.id, title: 'Renamed', note: 'A note' },
        { title: 'Second card', column: 'done', ask: 'Which one?' },
      ],
    }),
    error => error.code === 'bot/invalid' && /A task that needs an answer cannot be done/.test(error.message),
  )
  assert.equal(snapshot(rt), before, 'the refused batch left the existing card untouched')
  assert.equal(rt.state.tasks[card.id].title, 'Existing card')
})

test('an accepted batch creates every card once (#2597)', async (t) => {
  const { rt } = await start(t)
  const cards = await rt.trackBotTasks('d1', {
    tasks: [
      { title: 'First card' },
      { title: 'Second card', column: 'in-progress' },
    ],
  })
  assert.equal(cards.length, 2)
  assert.equal(cards[0].title, 'First card')
  assert.equal(cards[1].title, 'Second card')
  assert.equal(cards[1].status, 'working')
  assert.deepEqual(Object.keys(rt.state.tasks).sort(), [cards[0].id, cards[1].id].sort(), 'both cards landed once')
})

// #2761: the batch is committed into `state.tasks` before the store takes it, so a refused write
// left cards in memory the file never held, and the next unrelated save persisted them. Every
// write path snapshots the board and puts it back when the store refuses.
test('a refused save leaves a new batch out of state.tasks (#2761)', async (t) => {
  const { rt, saves, home } = await start(t)
  const before = snapshot(rt)
  const revision = rt.state.revision
  const store = breakStoreWrites(t, home)

  await assert.rejects(
    () => rt.trackBotTasks('d1', { tasks: [{ title: 'Ghost card' }, { title: 'Second ghost', column: 'in-progress' }] }),
    /Not saved/,
  )
  assert.equal(snapshot(rt), before, 'the refused save left the board byte-identical')
  assert.equal(saves.length, 1, 'the batch was saved once')
  assert.equal(rt.state.revision > revision, true, 'the rollback does not rewind revision')
  assert.equal(readFileSync(store.target, 'utf8'), 'OUTSIDE\n', 'the refusal wrote no byte outside the home')
  assert.deepEqual(Object.keys(rt.state.tasks), [], 'no ghost card stayed behind')
  assert.deepEqual(await rt.trackBotTasks('d1', {}), [], 'a read after the refusal finds no card')
})

test('a refused save leaves an updated card exactly as it was (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const [card] = await rt.trackBotTasks('d1', { tasks: [{ title: 'Existing card', group: 'War' }] })
  const before = snapshot(rt)
  breakStoreWrites(t, home)

  await assert.rejects(
    () => rt.trackBotTasks('d1', { tasks: [{ id: card.id, title: 'Renamed', column: 'in-progress', note: 'A note' }] }),
    /Not saved/,
  )
  assert.equal(snapshot(rt), before, 'the refused save restored the card, not only its key')
  assert.equal(rt.state.tasks[card.id].title, 'Existing card')
  assert.equal(rt.state.tasks[card.id].note, undefined)
})

test('a ghost card cannot ride an unrelated save onto the disk (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const store = breakStoreWrites(t, home)
  await assert.rejects(
    () => rt.trackBotTasks('d1', { tasks: [{ title: 'Ghost card' }] }),
    /Not saved/,
  )
  store.heal()
  const [real] = await rt.trackBotTasks('d1', { tasks: [{ title: 'Unrelated card' }] })
  const saved = onDisk(home)
  assert.deepEqual(Object.keys(saved.tasks ?? {}), [real.id], 'only the card that was saved reached the file')
  assert.equal(saved.tasks[real.id].title, 'Unrelated card')
})

test('a refused save posts no claim line, a taken one posts exactly one (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const lines = []
  rt.postClaimLine = task => { lines.push(task.id) }
  const batch = { tasks: [{ title: 'Room card', group: 'War', column: 'in-progress' }] }
  const store = breakStoreWrites(t, home)

  await assert.rejects(() => rt.trackBotTasks('d1', batch), /Not saved/)
  assert.equal(lines.length, 0, 'a card the store refused never reached the room')

  store.heal()
  const [card] = await rt.trackBotTasks('d1', batch)
  assert.deepEqual(lines, [card.id], 'the same card posts its claim line once it is saved')
})

test('a refused claim leaves the queued card open (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const card = await seed(rt, {
    id: 'task-queued', status: 'open', createdAt: 10, updatedAt: 10,
    requesterId: 'owner-1', ownerBotId: 'a', title: 'Queued card', source: 'conversation',
    origin: { roomId: 'war' }, queueRole: 'Dev', queueBy: 'a', queueCap: 8,
    actors: [{ status: 'open', at: 10, by: 'conversation' }],
  })
  const lines = []
  rt.postClaimLine = task => { lines.push(task.id) }
  const before = snapshot(rt)
  breakStoreWrites(t, home)

  await assert.rejects(() => rt.trackBotTasks('d1', { claim: true, id: card.id }, { roomId: 'war' }), /Not saved/)
  assert.equal(snapshot(rt), before, 'the refused claim restored the board')
  assert.equal(rt.state.tasks[card.id].status, 'open', 'the card is still in the queue')
  assert.equal(rt.state.tasks[card.id].claimedBy, undefined, 'nobody holds the card')
  assert.equal(lines.length, 0, 'a claim the store refused posts no room line')
})

test('a refused release leaves the card claimed (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const card = await seed(rt, claimedCard())
  const before = snapshot(rt)
  breakStoreWrites(t, home)

  await assert.rejects(
    () => rt.trackBotTasks('d1', { release: { task: card.id, reason: 'needs a person', retryInSec: 60 } }),
    /Not saved/,
  )
  assert.equal(snapshot(rt), before, 'the refused release restored the board')
  assert.equal(rt.state.tasks[card.id].status, 'claimed')
  assert.equal(rt.state.tasks[card.id].claimedBy, 'd1')
  assert.equal(rt.state.tasks[card.id].retryAt, undefined, 'no retry time was left behind')
})

test('a refused rework opens no child card (#2761)', async (t) => {
  const { rt, home } = await start(t)
  const card = await seed(rt, claimedCard({ handoff: { from: 'Reviewer', to: 'Dev', at: 10, reason: 'first pass' } }))
  const before = snapshot(rt)
  breakStoreWrites(t, home)

  await assert.rejects(
    () => rt.trackBotTasks('d1', { rework: { task: card.id, reason: 'the fix does not cover it' } }),
    /Not saved/,
  )
  assert.equal(snapshot(rt), before, 'the refused rework restored the board')
  assert.deepEqual(Object.values(rt.state.tasks).filter(task => task.reworkOf === card.id), [], 'no child card stayed behind')
  assert.equal(rt.state.tasks[card.id].handoff.reason, 'first pass', 'the original card kept its own handoff')
})

// P-673: `store.save()` has paths that write nothing and still resolve — a stopped host, a team
// another dsh holds, a team file this host cannot write (store.js:1037, 1046-1047, 1050) — and
// `tasks.commitTasks()` treated only a *thrown* save as a refusal (#2761). So a claim in a
// read-only window changed the board in memory, left the file's card queued, and `claimQueued`
// went on to post the room's claim line: a member told the room it had taken work no save ever
// recorded, and the card the file still holds is free for the next member to claim too.
// The fixture is the real store: the lock of another live dsh, and a disposed host.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const card = (over = {}) => ({
  id: 'task-queued', status: 'open', createdAt: 10, updatedAt: 10,
  requesterId: 'owner-1', ownerBotId: 'a', title: 'Queued card', source: 'conversation',
  origin: { roomId: 'war' }, queueRole: 'Dev', queueBy: 'a', queueCap: 8,
  actors: [{ status: 'open', at: 10, by: 'conversation' }],
  ...over,
})

const seed = (tasks) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd1'], admin: 'a', mode: 'everyone', named: true,
      sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd1', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, tasks,
})

// Another dsh on this host holds the team: its pid answers, so `store.js` keeps this window
// read-only. `takeover()` fails, `save()` returns without queueing a write, and nothing on disk
// changes for as long as the file is there.
const holdElsewhere = home => writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'the-other-window', since: Date.now() }))

async function start(t, { locked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-claim-silent-save-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed({ 'task-queued': card() })))
  if (locked) holdElsewhere(home)
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
    try { await ctx.dispose() } catch { /* the stopped-host row disposes it itself */ }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const lines = []
  rt.postClaimLine = task => { lines.push(task.id) }
  return { rt, ctx, home, lines }
}

const board = rt => JSON.stringify(rt.state.tasks)
const onDisk = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
const claim = (rt, id = 'task-queued') => rt.trackBotTasks('d1', { claim: true, id }, { roomId: 'war' })

test('P-673: a read-only window refuses a claim instead of reporting work the file does not hold', async (t) => {
  const { rt, home, lines } = await start(t, { locked: true })
  assert.match(String(rt.readOnly()), /open in another dsh/, 'the fixture is the read-only window')
  const before = board(rt)

  const outcome = await claim(rt).then(value => ({ value }), error => ({ error }))
  // Both halves of the defect are read before either is asserted, so the red names both: the call
  // reported the claim as done *and* the room was told about it, while the file still holds the card.
  assert.deepEqual(
    { reported: outcome.error === undefined, heard: lines },
    { reported: false, heard: [] },
    `the store wrote nothing: ${JSON.stringify(outcome.value ?? outcome.error.message)}`,
  )
  assert.equal(outcome.error.code, 'bot/read-only')
  // The refusal is the host's own sentence, so the member can say why nothing changed.
  assert.match(String(outcome.error.message), /open in another dsh/)
  assert.equal(board(rt), before, 'a claim the store never wrote stayed in state.tasks')
  assert.equal(rt.state.tasks['task-queued'].status, 'open', 'the card is back in the queue')
  assert.equal(rt.state.tasks['task-queued'].claimedBy, undefined, 'nobody holds the card')
  assert.equal(rt.state.tasks['task-queued'].lease, undefined, 'no lease was left behind')
  const saved = onDisk(home)
  assert.equal(saved.tasks['task-queued'].status, 'open', 'the file kept the card queued')
  assert.equal(saved.tasks['task-queued'].claimedBy, undefined)
  // The room never heard about a claim that was not made: the file still offers that card to the
  // next member, and a line saying otherwise is what lets two members work it.
  assert.deepEqual(lines, [], 'a claim the store refused posted the room line')
})

test('P-673: a stopped host refuses a claim instead of claiming a save it skipped', async (t) => {
  const { rt, ctx, lines } = await start(t)
  const before = board(rt)
  await ctx.dispose()

  const outcome = await claim(rt).then(value => ({ value }), error => ({ error }))
  assert.ok(outcome.error, `the stopped host reported the claim as done: ${JSON.stringify(outcome.value)}`)
  assert.equal(outcome.error.code, 'bot/read-only')
  assert.equal(board(rt), before, 'the stopped host kept the claim it never wrote')
  assert.deepEqual(lines, [], 'a stopped host announced a claim it did not save')
})

// The boundary: a window that may write still claims, posts its one line and holds the card on
// disk — the refusal above must not turn an ordinary claim into a read-only answer.
test('P-673: a writable window claims, posts one line and the file holds the claim', async (t) => {
  const { rt, home, lines } = await start(t)
  assert.equal(rt.readOnly(), undefined)

  const result = await claim(rt)
  assert.equal(result.item?.id, 'task-queued')
  assert.deepEqual(lines, ['task-queued'], 'the claim line is posted once the claim is saved')
  const saved = onDisk(home)
  assert.equal(saved.tasks['task-queued'].status, 'claimed')
  assert.equal(saved.tasks['task-queued'].claimedBy, 'd1')
  assert.equal(rt.state.tasks['task-queued'].status, 'claimed')
})

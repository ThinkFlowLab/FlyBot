// The typed Task/Handoff contract (#1720): five additive fields on the one task record —
// `taskClass`, `reworkOf`, `handoff`, `evidence`, `lease` — validated on write and read by the
// Project board from the same row. The rework child is a card linked by `reworkOf` (never
// `parentId`), a lease returns an abandoned queued card to the queue, and a record stored before
// the slice still reads back and renders.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install as installProjectBoard } from '../src/host/project-board.js'
import { formatRoomBoard } from '../src/host/room-context.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    d2: { id: 'd2', name: 'Dev2', role: 'dev', sessionId: 'd2', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
    r1: { id: 'r1', name: 'Rev1', role: 'Reviewer', sessionId: 'r1', createdAt: 4, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd1', 'd2', 'r1'], admin: 'a', mode: 'everyone', named: true,
      sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd1', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd2', role: 'member', displayName: 'Dev2', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'r1', role: 'member', displayName: 'Rev1', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function boot(home) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const inbox = {
        nextStep: [], nextTurn: [],
        remove(id) { const keep = message => message.id !== id; this.nextTurn = this.nextTurn.filter(keep); this.nextStep = this.nextStep.filter(keep); return true },
      }
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle', inbox,
        followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
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
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args ?? {}, { agent: { id: sessionId } })
  const idOf = (body, title) => {
    const line = body.split('\n').find(item => item.startsWith('- ') && item.includes(title))
    const id = line?.match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, body)
    return id
  }
  const create = async (spec = {}) => {
    const body = await track(spec.bot ?? 'd1', { tasks: [{ group: 'War', ...spec }] })
    return { body, id: idOf(body, spec.title) }
  }
  return { ctx, rt, track, idOf, create, home, agents }
}

async function start(t, seed = team()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-contract-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const app = await boot(home)
  app.stop = async () => rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  t.after(async () => {
    try { await app.ctx.dispose() } catch {}
    await app.stop()
  })
  return app
}

// A restart is the same home and a fresh runtime: the state on disk is what the new process reads.
async function restart(app) {
  await app.ctx.dispose()
  return boot(app.home)
}

const childrenOf = (app, originalId) => Object.values(app.rt.state.tasks).filter(task => task.reworkOf === originalId)
const byActor = (task, why) => (task.actors ?? []).filter(entry => entry.by === why)

test('a handoff records from/to/reason and an unknown role is refused by name (#1720)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Hand the diff on', handoff: { from: 'Lead', to: 'Dev', at: 1_700_000_000_000, reason: 'needs the test' } })
  const task = app.rt.state.tasks[id]
  assert.equal(task.taskClass, 'work', 'a card created without a class is a work card')
  assert.deepEqual({ ...task.handoff }, { from: 'Lead', to: 'Dev', at: 1_700_000_000_000, reason: 'needs the test' })

  const refused = await app.track('d1', { tasks: [{ group: 'War', title: 'Another card', handoff: { from: 'Lead', to: 'Nobody', reason: 'x' } }] })
  assert.match(refused, /unknown-role/)
  assert.match(refused, /Nobody/)
  assert.equal(Object.values(app.rt.state.tasks).some(task => task.title === 'Another card'), false, 'a refused write leaves no half-created card')

  // The field name is the refusal: a bad class is not silently dropped either (the HTTP
  // endpoint carries a value the tool schema would already refuse).
  await assert.rejects(
    () => app.rt.taskEndpoint('task-create', { botId: 'd1', title: 'Third card', taskClass: 'kind' }),
    /taskClass must be one of work, rework, release, triage, meeting/,
  )
})

test('a rejection creates exactly one rework child with reworkOf and no parentId (#1720)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Fix the flaky test' })
  assert.match(await app.track('d1', { tasks: [{ group: 'War', id, column: 'in-progress' }] }), /Fix the flaky test/)
  await app.rt.taskEndpoint('task-return', { id, summary: 'done, see the diff' })
  await app.rt.taskEndpoint('task-send-back', { id, note: 'the diff has no test' })

  const original = app.rt.state.tasks[id]
  assert.equal(original.status, 'working', 'the original goes back to working')
  assert.equal(original.handoff.from, 'requester')
  assert.equal(original.handoff.to, 'Dev')
  assert.equal(original.handoff.reason, 'the diff has no test')
  const children = childrenOf(app, id)
  assert.equal(children.length, 1)
  assert.equal(children[0].taskClass, 'rework')
  assert.equal(children[0].reworkOf, id)
  assert.equal(children[0].parentId, undefined, 'a rework card is not part of an overall card')
  assert.equal(children[0].ownerBotId, 'd1')

  // The rejection replayed on the same card: a returning result is a second rejection, and it
  // reuses the child it already opened instead of minting a second one.
  await app.rt.taskEndpoint('task-return', { id, summary: 'done again' })
  await app.rt.taskEndpoint('task-send-back', { id, note: 'still no test' })
  assert.equal(childrenOf(app, id).length, 1, 'one rework child per rejected card')
})

test('a rejection replayed after a restart adds no child and returns the original once (#1720)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Fix the flaky test' })
  await app.track('d1', { tasks: [{ group: 'War', id, column: 'in-progress' }] })
  await app.rt.taskEndpoint('task-return', { id, summary: 'done' })
  await app.rt.taskEndpoint('task-send-back', { id, note: 'the diff has no test' })
  const childId = childrenOf(app, id)[0].id
  await app.rt.taskEndpoint('task-return', { id, summary: 'reworked' })
  await app.rt.save()

  const again = await restart(app)
  const { rt } = again
  assert.equal(childrenOf(again, id).length, 1, 'the restart reads the same one child')
  // The same rejection lands again: the open child is reused, never duplicated.
  await rt.taskEndpoint('task-send-back', { id, note: 'the same rejection' })
  assert.equal(childrenOf(again, id).length, 1)
  assert.equal(childrenOf(again, id)[0].id, childId)

  // The child's acceptance is the single write that returns the original to result-ready.
  await rt.taskEndpoint('task-update', { id: childId, column: 'done' })
  assert.equal(rt.state.tasks[id].status, 'result-ready')
  assert.equal(byActor(rt.state.tasks[id], 'rework accepted').length, 1)
  // A replayed acceptance (the endpoint retried) is not a second transition.
  await assert.rejects(() => rt.taskEndpoint('task-accept-result', { id: childId }))
  assert.equal(rt.state.tasks[id].status, 'result-ready')
  assert.equal(byActor(rt.state.tasks[id], 'rework accepted').length, 1, 'the original moves once')
})

test('an expired lease requeues and a live lease refuses a second claim naming the holder (#1720)', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [{ group: 'War', queue: true, role: 'Dev', title: 'Ship the note' }] })
  const id = app.idOf(body, 'Ship the note')
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
  const held = app.rt.state.tasks[id]
  assert.equal(held.lease.holder, 'd1')
  assert.ok(held.lease.expiresAt > held.lease.takenAt)

  const refused = await app.track('d2', { claim: true, group: 'War', id })
  assert.match(refused, /lease-held/)
  assert.match(refused, /Dev1/, 'the refusal names the holder')
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd1', 'a live lease keeps the card claimed')

  // A restart with a live lease changes nothing.
  const again = await restart(app)
  assert.match(await again.track('d2', { claim: true, group: 'War', id }), /lease-held/)
  assert.equal(again.rt.state.tasks[id].claimedBy, 'd1')

  // Expiry is what returns the item: the second Dev takes it from the queue, not by force.
  again.rt.state.tasks[id].lease.expiresAt = Date.now() - 1000
  await again.rt.save()
  assert.match(await again.track('d2', { claim: true, group: 'War', id }), new RegExp(`^Claimed ${id} `))
  const taken = again.rt.state.tasks[id]
  assert.equal(taken.claimedBy, 'd2')
  assert.equal(taken.status, 'claimed')
  assert.equal(taken.lease.holder, 'd2')
  assert.equal(byActor(taken, 'returned to the queue').length >= 1, true, 'the requeue is recorded on the card')
})

test('a pre-slice record reads back and renders without the new fields (#1720)', async (t) => {
  const seed = team()
  seed.tasks = {
    'task-old': {
      id: 'task-old', status: 'working', ownerBotId: 'd1', requesterId: 'owner-1',
      title: 'An old card', note: 'stored before the slice', source: 'conversation',
      origin: { roomId: 'war' }, createdAt: 1, updatedAt: 2,
      actors: [{ status: 'working', at: 2 }],
    },
  }
  const app = await start(t, seed)
  const listed = await app.track('d1', {})
  assert.match(listed, /An old card/)
  const row = app.rt.state.tasks['task-old']
  assert.equal(row.taskClass, undefined, 'migration is a read, never a rewrite')
  assert.equal(row.reworkOf, undefined)
  assert.match(formatRoomBoard(app.rt.state.tasks, { roomId: 'war', now: 10, nameOf: () => 'Dev1' }), /An old card/)
})

test('the Project board reads the typed fields from the same row (#1720)', () => {
  const tasks = {
    'task-old': { id: 'task-old', status: 'working', ownerBotId: 'b1', title: 'Old', createdAt: 1, updatedAt: 2 },
    'task-new': {
      id: 'task-new', status: 'working', ownerBotId: 'b1', title: 'New', createdAt: 3, updatedAt: 4,
      taskClass: 'rework', reworkOf: 'task-old',
      handoff: { from: 'requester', to: 'Dev', at: 4, reason: 'no test' },
      evidence: [{ sha: 'a'.repeat(40), pr: 12, check: 'tests-ok', at: 4 }],
      lease: { holder: 'b1', takenAt: 4, expiresAt: 5 },
    },
  }
  const rt = { state: { tasks }, readProject: id => ({ id }), projectOfMember: () => ({ id: 'p' }), taskVisible: () => true }
  installProjectBoard(rt)
  const rows = rt.projectBoard('p')
  const old = rows.find(row => row.id === 'task-old')
  const fresh = rows.find(row => row.id === 'task-new')
  assert.equal(old.taskClass, undefined, 'a pre-slice row keeps its old shape')
  assert.equal(fresh.taskClass, 'rework')
  assert.equal(fresh.reworkOf, 'task-old')
  assert.equal(fresh.handoff.reason, 'no test')
  assert.equal(fresh.evidence[0].pr, 12)
  assert.equal(fresh.lease.holder, 'b1')
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'one row per task id')
})

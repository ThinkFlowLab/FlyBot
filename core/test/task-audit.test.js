// The audit projection and the rework delivery count (#1730). The audit text is read from the
// typed rows already on the card — handoff, evidence, reworkOf, lease — and rendered twice from
// the same rows identically. A pre-slice record answers the empty string, not a throw. A rework
// chain counts one accepted delivery across two records and a replay cannot double it.

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

test('the audit renders one identical text block from the same rows (#1730)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({
    title: 'Audit the rework',
    handoff: { from: 'Lead', to: 'Dev', at: 1_700_000_000_000, reason: 'needs the test' },
  })
  app.rt.state.tasks[id].evidence = [
    { sha: 'a'.repeat(40), pr: 1730, check: 'tests-ok', at: 1_700_000_100_000 },
  ]
  const child = app.rt.state.tasks[id]
  const audit = app.rt.taskAudit(id)
  assert.match(audit, /^handoff Lead -> Dev: needs the test @ 2023-11-14T22:13:20.000Z$/m)
  assert.match(audit, /^evidence a{40} pr #1730 tests-ok @ 2023-11-14T22:15:00.000Z$/m)
  assert.equal(audit, app.rt.taskAudit(id), 'the same rows render the same text')
  assert.equal(audit, app.rt.taskAudit(child.id), 'the store is read, not consumed')
})

test('the audit names the rework chain and the current lease window (#1730)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Chain me' })
  app.rt.state.tasks[id].lease = { holder: 'd1', takenAt: 1_700_000_000_000, expiresAt: 1_700_001_800_000 }
  const childId = 'task-rework1'
  app.rt.state.tasks[childId] = {
    id: childId, title: 'rework', status: 'accepted', taskClass: 'rework', reworkOf: id,
    ownerBotId: 'd1', createdAt: 2, updatedAt: 2,
  }
  const audit = app.rt.taskAudit(childId)
  assert.match(audit, new RegExp('^rework chain ' + id + ' -> ' + childId + '$', 'm'))
  assert.match(app.rt.taskAudit(id), /^lease Dev1 @ 2023-11-14T22:13:20.000Z -> 2023-11-14T22:43:20.000Z$/m)
})

test('a pre-slice record renders an empty audit, not a throw (#1730)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Old card' })
  delete app.rt.state.tasks[id].taskClass
  assert.equal(app.rt.taskAudit(id), '')
  assert.equal(app.rt.taskAudit('task-nope'), '')
})

test('a rework chain counts one accepted delivery and a replay doubles nothing (#1730)', async (t) => {
  const app = await start(t)
  const { id } = await app.create({ title: 'Ship once' })
  const childId = 'task-rework2'
  app.rt.state.tasks[id].status = 'accepted'
  app.rt.state.tasks[id].ownerBotId = 'd1'
  app.rt.state.tasks[childId] = {
    id: childId, title: 'rework', status: 'accepted', taskClass: 'rework', reworkOf: id,
    ownerBotId: 'd1', createdAt: 2, updatedAt: 2,
  }
  const first = app.rt.taskCounters()
  assert.equal(first.roles.Dev.accepted, 2, 'two records')
  assert.equal(first.roles.Dev.deliveries, 1, 'one accepted delivery for the chain')
  // A replay writes the same rows again; the count is a read, so it cannot double.
  app.rt.state.tasks[id].status = 'accepted'
  app.rt.state.tasks[childId].status = 'accepted'
  assert.equal(app.rt.taskCounters().roles.Dev.deliveries, 1)
  // A rework whose parent never landed is still a delivery of its own.
  delete app.rt.state.tasks[id]
  assert.equal(app.rt.taskCounters().roles.Dev.deliveries, 1)
})

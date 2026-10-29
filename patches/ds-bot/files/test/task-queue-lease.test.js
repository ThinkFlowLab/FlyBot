// Role queues, isolated workers and lease recovery (#1729). Stage 3.2 adds a stated per-role
// ceiling, one worker per claim that no other claim can read, and one owner for an expired lease
// that recovers a card exactly once and records the recovery on the card. This file pins those
// four behaviors through the host surface the workflow plugin reads.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The room's roles are the Bot labels (`roster.js`: free text, matched case-insensitively —
// `Dev2` below carries `role: 'dev'` so a case-sensitive match would leave it in the queue).
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

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-queue-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const inbox = {
        nextStep: [],
        nextTurn: [],
        remove(id) {
          const keep = message => message.id !== id
          const before = this.nextTurn.length + this.nextStep.length
          this.nextTurn = this.nextTurn.filter(keep)
          this.nextStep = this.nextStep.filter(keep)
          return this.nextTurn.length + this.nextStep.length !== before
        },
      }
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle', inbox,
        followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      })
    }
    return agents.get(sessionId)
  }
  let created = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `made-${++created}` }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args ?? {}, { agent: { id: sessionId } })
  const text = (sessionId) => (agents.get(sessionId)?.calls ?? []).map(message => message.content.map(block => block.text ?? '').join('\n')).join('\n')
  const calls = (sessionId) => agents.get(sessionId)?.calls ?? []
  const emit = (sessionId, type, data) => ctx.emitArgs('session/event', { id: sessionId }, { type, data, time: Date.now() })
  const idOf = (body, title) => {
    const line = body.split('\n').find(item => item.startsWith('- ') && item.includes(title))
    const id = line?.match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, body)
    return id
  }
  const enqueue = async (spec = {}) => {
    const body = await track('a', { tasks: [{ group: 'War', queue: true, ...spec }] })
    return { body, id: idOf(body, spec.title) }
  }
  // DSH claims the queued follow-up when the turn starts, so the fake inbox drops it too. The turn
  // that ends here is a member's own work: the next pass sees a member with a card and no wake.
  const finishWake = async (sessionId) => {
    const message = calls(sessionId).at(-1)
    assert.ok(message, `${sessionId} has a wake to consume`)
    agents.get(sessionId).inbox.remove(message.id)
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    emit(sessionId, 'turn/start', { turn: 1 })
    emit(sessionId, 'turn/end', { reason: { kind: 'completed' } })
    await ctx.taskDrive.settled()
  }
  return { ctx, rt, track, text, calls, emit, idOf, enqueue, finishWake, home }
}



test('a queue over the role cap is refused, naming the role and the cap (#1729)', async (t) => {
  const app = await start(t)
  const enqueueError = async (args) => {
    try { return String(await app.track('a', { tasks: [args] })) } catch (error) { return String(error?.message ?? error) }
  }
  for (let n = 0; n < 8; n += 1) await app.enqueue({ title: `Queue fill ${n}`, role: 'Dev' })
  const refused = await enqueueError({ group: 'War', queue: true, title: 'One too many', role: 'Dev' })
  assert.match(refused, /queue-full/)
  assert.match(refused, /Dev/)
  assert.match(refused, /cap is 8/)
  // A graph that knows how many workers it runs may state a smaller ceiling on the card.
  const small = await start(t)
  await small.enqueue({ title: 'A', role: 'Dev', cap: 2 })
  await small.enqueue({ title: 'B', role: 'Dev', cap: 2 })
  const over = String(await small.track('a', { tasks: [{ group: 'War', queue: true, title: 'C', role: 'Dev', cap: 2 }] }))
  assert.match(over, /queue-full/)
  assert.match(over, /cap is 2/)
})

test('re-offering a queued item keeps its id and is never its own refusal (#1729)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev', cap: 1 })
  const again = app.rt.state.tasks[id]
  const body = await app.track('a', { tasks: [{ id, group: 'War', queue: true, role: 'Dev', title: 'Fix the flaky test' }] })
  assert.match(body, new RegExp(id))
  assert.equal(app.rt.state.tasks[id].id, id)
  assert.equal(app.rt.state.tasks[id].queueCap, 1)
  assert.equal(again.claimedBy, undefined)
})

test('two concurrent claims run in workers that share no state (#1729)', async (t) => {
  const app = await start(t)
  const one = await app.enqueue({ title: 'First', role: 'Dev' })
  const two = await app.enqueue({ title: 'Second', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id: one.id })
  await app.track('d2', { claim: true, group: 'War', id: two.id })
  const w1 = app.rt.state.tasks[one.id].worker
  const w2 = app.rt.state.tasks[two.id].worker
  assert.ok(w1 && w2, 'each claim names a worker')
  assert.notEqual(w1, w2, 'two claims never share one worker')
  app.rt.taskWorkerState(w1).vars.set('scratch', 'first')
  app.rt.taskWorkerState(w1).files.set('tmp.txt', 'first')
  assert.equal(app.rt.taskWorkerState(w2).vars.get('scratch'), undefined)
  assert.equal(app.rt.taskWorkerState(w2).files.get('tmp.txt'), undefined)
})

test('two expired reads requeue the card once and record the recovery (#1729)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Lease me', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  const task = app.rt.state.tasks[id]
  task.lease = { ...task.lease, expiresAt: Date.now() - 1000 }
  assert.equal(await app.rt.taskExpireLeases(), 1)
  assert.equal(await app.rt.taskExpireLeases(), 0, 'the second read finds nothing to recover')
  assert.equal(app.rt.state.tasks[id].status, 'open')
  assert.equal(app.rt.state.tasks[id].lease, undefined)
  assert.equal(app.rt.state.tasks[id].worker, undefined, 'the dead worker is dropped')
  assert.equal(app.rt.taskWorkerState(task.worker), undefined)
  const evidence = app.rt.state.tasks[id].evidence ?? []
  assert.equal(evidence.length, 1)
  assert.match(evidence[0].check, /lease expired/)
  assert.match(evidence[0].check, /Dev1/, 'the recovery names the holder it recovered from')
})

test('a claim on a live lease is refused and names the holder (#1729)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Held', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  const refused = await app.track('d2', { claim: true, group: 'War', id })
  assert.match(refused, /lease-held/)
  assert.match(refused, /Dev1/)
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd1')
  // The host reads that same lease for the workflow plugin.
  assert.equal(app.rt.taskLease(id).live, true)
  assert.equal(app.rt.taskLease(id).heldBy, 'Dev1')
})

test('a restart with a live lease changes nothing (#1729)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Still running', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  const before = app.rt.state.tasks[id]
  assert.equal(await app.rt.taskExpireLeases(), 0)
  assert.equal(app.rt.state.tasks[id].status, 'claimed')
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd1')
  assert.equal(app.rt.state.tasks[id].lease.expiresAt, before.lease.expiresAt)
  assert.deepEqual(app.rt.state.tasks[id].evidence ?? [], [])
})

test('deliveries and held resources are counted from the rows, per role (#1729)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Count me', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  await app.track('d1', { tasks: [{ id, column: 'done', progress: 100 }] })
  const counts = app.rt.taskCounters()
  assert.equal(counts.roles.Dev.queued, 0)
  assert.equal(counts.roles.Dev.accepted, 1)
  assert.equal(counts.roles.Dev.deliveries, 1)
  assert.ok(counts.roles.Dev.workerSeconds >= 0)
  const onlyDev = app.rt.taskCounters({ role: 'Dev' })
  assert.deepEqual(Object.keys(onlyDev.roles), ['Dev'])
})

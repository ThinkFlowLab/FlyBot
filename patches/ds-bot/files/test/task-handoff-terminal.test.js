// #2667: a handoff recorded on a finished card must be refused, not applied. The card state
// machine is one way: accepted, cancelled and failed are terminal and `applyColumn` already
// refuses to move one, but `routeToPool` used to look only at `claimedBy`/status ∈
// claimed|working|blocked, so a finished card that still carried `claimedBy` (only `requeue`
// clears it) was written back to `open`, 0% and handed to the next role. The refusal is the
// same one `blockForInput` makes — `stale`, before anything lands — and `result-ready` still
// hands on, because that column is allowed to go back to `working`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { columnOf } from '../src/shared/task-board.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    d2: { id: 'd2', name: 'Dev2', role: 'Dev', sessionId: 'd2', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
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
  return { ctx, rt, track, idOf, home, statePath: join(home, 'state.json') }
}

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const app = await boot(home)
  t.after(async () => {
    try { await app.ctx.dispose() } catch {}
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return app
}

// The card the bug needs: enqueued by the lead, claimed from the queue, so `claimedBy` names the
// member and stays behind after the card is finished (only `requeue` clears it).
async function claimedCard(app, title, member = 'd1') {
  const queued = await app.track('a', { tasks: [{ group: 'War', title, queue: true, role: 'Dev' }] })
  const id = app.idOf(queued, title)
  const claimed = await app.track(member, { claim: true, group: 'War' })
  assert.match(claimed, new RegExp(`Claimed ${id}`), claimed)
  assert.equal(app.rt.state.tasks[id].claimedBy, member)
  return id
}

const handoff = (to = 'Reviewer') => ({ from: 'Dev', to, reason: 'the review is next' })

test('a finished card keeps its terminal state and refuses the handoff (#2667)', async (t) => {
  const app = await start(t)
  const id = await claimedCard(app, 'Ship the release note')

  assert.match(await app.track('d1', { tasks: [{ id, column: 'done' }] }), /done/)
  const finished = app.rt.state.tasks[id]
  assert.equal(finished.status, 'accepted', 'column done is the accepted state')
  assert.equal(columnOf(finished), 'done')
  assert.equal(finished.progress, 100)
  assert.equal(finished.claimedBy, 'd1', 'a finished card keeps the member that worked it')

  // The reported repro: the next write carries only the handoff, and the card used to come back
  // as open/0% under the next role.
  const before = readFileSync(app.statePath, 'utf8')
  const refused = await app.track('d1', { tasks: [{ id, handoff: handoff() }] })
  assert.match(refused, /A finished task cannot be handed on/, refused)
  assert.equal(finished.status, 'accepted')
  assert.equal(columnOf(finished), 'done')
  assert.equal(finished.progress, 100)
  assert.equal(finished.claimedBy, 'd1')
  assert.equal(finished.handoff, undefined, 'a refused handoff is not recorded either')
  assert.equal(finished.queueRole, 'Dev', 'the refused write does not route the card anywhere')
  assert.equal(readFileSync(app.statePath, 'utf8'), before, 'the refused write lands nothing on disk')

  // The same refusal on the HTTP entry (#1720's second path into writeContract).
  await assert.rejects(
    () => app.rt.taskEndpoint('task-update', { id, handoff: handoff() }),
    error => error.code === 'bot/stale' && /A finished task cannot be handed on/.test(error.message),
  )
  assert.equal(app.rt.state.tasks[id].status, 'accepted')
  assert.equal(app.rt.state.tasks[id].handoff, undefined)
})

test('a result-ready card still hands on to the next role (#2667)', async (t) => {
  const app = await start(t)
  const id = await claimedCard(app, 'Review the diff')
  await app.track('d1', { tasks: [{ id, column: 'in-progress' }] })
  await app.rt.taskEndpoint('task-return', { id, summary: 'the diff is ready' })
  assert.equal(app.rt.state.tasks[id].status, 'result-ready')

  const handed = await app.track('d1', { tasks: [{ id, handoff: handoff() }] })
  assert.match(handed, /Review the diff/, handed)
  const card = app.rt.state.tasks[id]
  assert.equal(card.handoff.to, 'Reviewer')
  assert.equal(card.queueRole, 'Reviewer')
  assert.equal(card.status, 'open', 'result-ready is not terminal: the card goes back to the queue')
  assert.equal(card.progress, 0)
  assert.equal(card.claimedBy, undefined)
})

test('failed and cancelled cards refuse a handoff too (#2667)', async (t) => {
  const app = await start(t)
  const cancelled = await claimedCard(app, 'Drop the stale note')
  await app.rt.taskEndpoint('task-cancel', { id: cancelled })
  assert.equal(app.rt.state.tasks[cancelled].status, 'cancelled')

  const failedId = await claimedCard(app, 'Publish the broken build', 'd2')
  app.rt.taskBotDeleted('d2')
  assert.equal(app.rt.state.tasks[failedId].status, 'failed')

  for (const [id, status, writer] of [[cancelled, 'cancelled', 'd1'], [failedId, 'failed', 'd2']]) {
    const refused = await app.track(writer, { tasks: [{ id, handoff: handoff() }] })
    assert.match(refused, /A finished task cannot be handed on/, `${status}: ${refused}`)
    assert.equal(app.rt.state.tasks[id].status, status)
    assert.equal(app.rt.state.tasks[id].handoff, undefined)
  }
})

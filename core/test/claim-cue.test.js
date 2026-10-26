// #1253: a claim in a room is public. The room notice requires one short line when a card is
// taken — `接了 #1234，第一步是 …` — and the board write (claim or assign) is the moment to post
// it. The line is logged in the room and drawn from the log, so it opens no group round and wakes
// nobody: the member's own work arrives as its own-chat wake (#1205), and these cases pin that
// the two never merge. Progress stays on the card, and a re-claim of the same card does not
// repeat the line.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { CLAIM_CUE_REPEAT_MS } from '../src/host/groups.js'
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
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd1', 'd2'], admin: 'a', mode: 'everyone', named: true,
      sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd1', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd2', role: 'member', displayName: 'Dev2', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-claim-cue-'))
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
  const calls = (sessionId) => agents.get(sessionId)?.calls ?? []
  const idOf = (body, title) => {
    const line = body.split('\n').find(item => item.startsWith('- ') && item.includes(title))
    const id = line?.match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, body)
    return id
  }
  const room = () => rt.state.rooms.war
  const lines = () => room().log.map(line => line.text)
  const enqueue = async (spec = {}) => {
    const body = await track('a', { tasks: [{ group: 'War', queue: true, ...spec }] })
    return { body, id: idOf(body, spec.title) }
  }
  return { ctx, rt, track, calls, idOf, room, lines, enqueue, home }
}

test('a claim in a room posts one line in the claimer\'s voice and opens no round (#1253)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: '#1253 the claim cue line', role: 'Dev', priority: 'high' })
  assert.equal(app.lines().length, 0, 'the queue itself is a board write, not a room line')
  const said = await app.track('d1', { claim: true, group: 'War' })
  assert.match(said, new RegExp(`^Claimed ${id} `))
  const posted = app.room().log.at(-1)
  assert.equal(app.room().log.length, 1, `one line, got:\n${app.lines().join('\n')}`)
  assert.equal(posted.botId, 'd1', 'in the claimer\'s voice')
  assert.equal(posted.who, 'Dev1')
  assert.match(posted.text, /^接了 #1253，第一步是 the claim cue line$/)
  // No group round: the room's own Session was never woken, and nothing is in progress.
  assert.equal(app.rt.roomProgress.size, 0)
  assert.equal(app.calls('war').length, 0, 'the line does not open a round')
  assert.equal(app.calls('d2').length, 0, 'the other members are not called')
  // The claimer's work still arrives as its own-chat wake (#1205), not into the room: the queue
  // offer it had before the claim, then the card's own continue cue.
  const wake = app.calls('d1').at(-1)
  assert.equal(wake.source.role, 'task')
  assert.match(wake.content[0].text, /\[Continue task\]/)
  assert.match(wake.content[0].text, new RegExp(`Continue ${id} \\[high\\] #1253 the claim cue line`))
})

test('the note is the first step, and it is the card\'s note, not invented (#1253)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: '#1253 the claim cue line', role: 'Dev', note: 'reading tasks.js, then the test' })
  await app.track('d1', { claim: true, group: 'War', id })
  assert.equal(app.room().log.at(-1).text, '接了 #1253，第一步是 reading tasks.js, then the test')
})

test('a card assigned in the room posts the line in the assignee\'s voice (#1253)', async (t) => {
  const app = await start(t)
  const plan = await app.track('a', { tasks: [{ group: 'War', overall: true, title: '#1253 the plan' }] })
  const planId = app.idOf(plan, 'the plan')
  const body = await app.track('a', { tasks: [{ group: 'War', title: '#1253 write the failing test', assignee: 'Dev1', parent: planId }] })
  const id = app.idOf(body, 'write the failing test')
  assert.equal(app.rt.state.tasks[id].status, 'claimed', 'assigning claims the card')
  const posted = app.room().log.at(-1)
  assert.equal(app.room().log.length, 1)
  assert.equal(posted.botId, 'd1', 'the assignee speaks, not the lead')
  assert.equal(posted.who, 'Dev1')
  assert.match(posted.text, /^接了 #1253，第一步是 write the failing test$/)
  assert.equal(app.rt.roomProgress.size, 0)
  assert.equal(app.calls('war').length, 0)
})

test('progress on a card the member already holds posts nothing (#1253)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: '#1253 the claim cue line', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  assert.equal(app.room().log.length, 1)
  await app.track('d1', { tasks: [{ id, column: 'in-progress', progress: 30, note: 'halfway' }] })
  await app.track('d1', { tasks: [{ id, progress: 70, note: 'almost there' }] })
  assert.equal(app.room().log.length, 1, `progress stays on the card, got:\n${app.lines().join('\n')}`)
})

test('a re-claim of the same card does not repeat the line (#1253)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: '#1253 the claim cue line', role: 'Dev' })
  await app.track('d1', { claim: true, group: 'War', id })
  assert.equal(app.room().log.length, 1)
  await app.track('d1', { release: { task: id, reason: 'needs a decision', retryInSec: 0 } })
  await app.track('d2', { claim: true, group: 'War' })
  assert.equal(app.room().log.length, 1, `an identical claim line is not repeated, got:\n${app.lines().join('\n')}`)
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd2', 'the re-claim itself still happened')
})

test('a claim outside a room posts no line (#1253)', async (t) => {
  const app = await start(t)
  const body = await app.track('d1', { tasks: [{ title: '#1253 a card in my own chat' }] })
  const id = app.idOf(body, 'a card in my own chat')
  await app.track('d1', { tasks: [{ id, column: 'in-progress', progress: 10 }] })
  assert.equal(app.lines().length, 0)
  assert.equal(app.rt.state.tasks[id].status, 'working')
})

test('the repeat window is a stated number of minutes, not forever (#1253)', () => {
  assert.equal(CLAIM_CUE_REPEAT_MS, 30 * 60 * 1000)
})

test('the claim cue stays in the record and no read of the card hands it out (#1253)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: '#1253 the cue stays on the board', role: 'Dev', note: 'read the board first' })
  await app.track('d1', { claim: true, group: 'War', id })
  const stored = app.rt.state.tasks[id]
  // The record keeps the cue — it is what makes the repeat window work — and every reader of a
  // card goes through `view()`, which leaves this field out. A read that skipped `view()` would
  // hand the room the seq and text of its own last line.
  assert.deepEqual(
    { text: stored.claimCue?.text, seq: typeof stored.claimCue?.seq, at: typeof stored.claimCue?.at },
    { text: '接了 #1253，第一步是 read the board first', seq: 'number', at: 'number' },
  )
  // The room board, the Bot's own list and a plain list are the reads the endpoints serve today.
  // The `{ archive: true }` option named for this guard does not exist on this tree (no task or
  // board read takes it), so it cannot be pinned here; whichever read replaces it must keep
  // going through `view()`, which is what this case holds.
  const reads = [
    ['room board', await app.rt.taskEndpoint('tasks', { roomId: 'war' })],
    ['bot list', await app.rt.taskEndpoint('tasks', { botId: 'd1' })],
    ['plain list', await app.rt.taskEndpoint('tasks', {})],
    ['a write answer', await app.rt.taskEndpoint('task-update', { id, note: 'still working' }, null)],
  ]
  for (const [name, rows] of reads) {
    const list = Array.isArray(rows) ? rows : [rows]
    assert.ok(list.length > 0, `${name}: no rows to check`)
    for (const row of list) {
      assert.equal('claimCue' in row, false, `${name}: the view hands out claimCue`)
      assert.equal(JSON.stringify(row).includes('claimCue'), false, `${name}: claimCue is in the row text`)
    }
  }
})

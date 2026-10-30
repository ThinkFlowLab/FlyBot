// A pull queue (#1247): the lead enqueues an item that names a role and no assignee, an idle
// member of that role claims it, and one item is handed to exactly one member. The queue is
// the same board — a claimed item is the card the room board and the delivery view already
// read — so this file covers only what the pull path adds: the single-winner claim, the named
// role refusals, WIP = 1, the wake list, the cheap wake, the blocked round-trip and the queue
// lines on the room board.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { ROOM_CONTEXT_BUDGET, formatRoomBoard } from '../src/host/room-context.js'
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
  const board = () => formatRoomBoard(rt.state.tasks, { roomId: 'war', nameOf: task => rt.botOf(task.ownerBotId)?.name })
  return { ctx, rt, track, text, calls, emit, idOf, enqueue, finishWake, board, home }
}

test('two claims for one queued item leave exactly one owner (#1247)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev', priority: 'high' })
  const [first, second] = await Promise.all([
    app.track('d1', { claim: true, group: 'War' }),
    app.track('d2', { claim: true, group: 'War' }),
  ])
  const claimed = [first, second].filter(text => text.startsWith('Claimed'))
  assert.equal(claimed.length, 1, `one winner, got:\n${first}\n---\n${second}`)
  assert.match(claimed[0], new RegExp(`Claimed ${id} \\[high\\] Fix the flaky test`))
  const loser = [first, second].find(text => !text.startsWith('Claimed'))
  assert.match(loser, /^No queued item for /, 'the loser is told there is nothing, not handed the board')
  const task = app.rt.state.tasks[id]
  const winner = task.ownerBotId
  assert.equal(task.status, 'claimed')
  assert.equal(task.claimedBy, winner)
  assert.equal(claimed[0].includes(app.rt.botOf(winner).name), false, 'the card names no owner in its wake text')
})

test('a member of another role is refused by name, not silently (#1247)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Review the diff', role: 'Reviewer' })
  const refused = await app.track('d1', { claim: true, group: 'War', id })
  assert.match(refused, /not-in-role/)
  assert.doesNotMatch(refused, /^No queued item/, 'a role mismatch is named, not a silent null')
  assert.equal(app.rt.state.tasks[id].claimedBy, undefined)
  // Picking blind is a silent null: nothing in the queue is for a Dev.
  assert.match(await app.track('d1', { claim: true, group: 'War' }), /^No queued item for Dev/)
  // And the item is still there for the role it was queued for.
  assert.match(await app.track('r1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
})

test('a member that already holds an in-progress card claims nothing (#1247)', async (t) => {
  const app = await start(t)
  const held = await app.track('d1', { tasks: [{ group: 'War', title: 'Held card', column: 'in-progress', progress: 30 }] })
  const heldId = app.idOf(held, 'Held card')
  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  const refused = await app.track('d1', { claim: true, group: 'War' })
  assert.match(refused, /^No queued item for Dev/)
  assert.match(refused, new RegExp(`in-progress card \\(${heldId}\\)`))
  assert.equal(app.rt.state.tasks[heldId].status, 'working')
  assert.equal(app.rt.state.tasks[heldId].progress, 30)
  assert.equal(app.rt.state.tasks[id].claimedBy, undefined)
  // WIP is per member, not a room-wide lock: the other Dev takes it.
  assert.match(await app.track('d2', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
})

// A delivered card waits on its requester, not on its member (#1744): handing the result over
// frees the slot at once, so the member can start the next queued item while the requester
// decides. Counting the delivery as work in progress stalls a one-member role after every
// delivery, and the queue cue below never reaches that member either.
test('a delivered card does not hold the member\'s WIP slot (#1744)', async (t) => {
  const app = await start(t)
  const delivered = await app.track('d1', { tasks: [{ group: 'War', title: 'Delivered card', column: 'in-progress' }] })
  const deliveredId = app.idOf(delivered, 'Delivered card')
  await app.rt.taskEndpoint('task-return', { id: deliveredId, summary: 'the diff is in the branch' })
  assert.equal(app.rt.state.tasks[deliveredId].status, 'result-ready')

  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  const claimed = await app.track('d1', { claim: true, group: 'War' })
  assert.match(claimed, new RegExp(`^Claimed ${id} `))
  assert.equal(app.rt.state.tasks[id].claimedBy, 'd1')
  assert.equal(app.rt.state.tasks[id].status, 'claimed', 'a claim lands at claimed, which the slot rule counts')
  assert.equal(app.rt.state.tasks[deliveredId].status, 'result-ready', 'a claim accepts or cancels nothing')
})

test('the wake pass offers the queue to a member whose card was delivered (#1744)', async (t) => {
  const app = await start(t)
  const delivered = await app.track('d1', { tasks: [{ group: 'War', title: 'Delivered card', column: 'in-progress' }] })
  const deliveredId = app.idOf(delivered, 'Delivered card')
  await app.rt.taskEndpoint('task-return', { id: deliveredId, summary: 'the diff is in the branch' })
  // The card's own wake was the member's turn: it ended, and the delivered card is all that is left.
  await app.finishWake('d1')
  assert.equal(app.calls('d1').length, 1)

  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  assert.equal(app.calls('d1').length, 2, 'the member whose card was delivered is offered the queue item')
  assert.match(app.text('d1'), new RegExp(`Take ${id} `))
  assert.equal(app.calls('d2').length, 0, 'the idle member of the role is not offered an item this member can take')
  assert.equal(app.rt.state.tasks[id].claimedBy, undefined, 'a wake is not a claim')
})

// A send-back returns the same card to the member as work, and the send-back itself is never
// refused (#1720). The cap is enforced at the claim, so two cards in progress are allowed right
// after a send-back and a third one is refused by name (#1744).
test('a send-back returns the card as work and the next claim is capped (#1744)', async (t) => {
  const app = await start(t)
  const delivered = await app.track('d1', { tasks: [{ group: 'War', title: 'Delivered card', column: 'in-progress' }] })
  const deliveredId = app.idOf(delivered, 'Delivered card')
  await app.rt.taskEndpoint('task-return', { id: deliveredId, summary: 'the diff is in the branch' })

  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
  assert.match(await app.track('d1', { tasks: [{ group: 'War', id, column: 'in-progress' }] }), new RegExp(id))
  assert.equal(app.rt.state.tasks[id].status, 'working')

  const sentBack = await app.rt.taskEndpoint('task-send-back', { id: deliveredId, note: 'add the test' })
  assert.equal(sentBack.status, 'working', 'the send-back is accepted and returns the card to work')
  assert.equal(app.rt.state.tasks[deliveredId].status, 'working')
  assert.equal(app.rt.state.tasks[id].status, 'working', 'the member now holds two cards in progress')

  const { id: third } = await app.enqueue({ title: 'Review the diff', role: 'Dev' })
  const refused = await app.track('d1', { claim: true, group: 'War' })
  assert.match(refused, /^No queued item for Dev/)
  assert.match(refused, /in-progress card \(task-[0-9a-f]+\)/, 'the refusal names a card the member holds')
  assert.equal(app.rt.state.tasks[third].claimedBy, undefined)
})

test('enqueuing wakes the idle member of the role and nobody else (#1247)', async (t) => {
  const app = await start(t)
  app.emit('d2', 'turn/start', { turn: 1 }) // Dev2 is mid-turn, so it is not idle
  await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  assert.equal(app.calls('d1').length, 1, 'the idle Dev is woken')
  assert.equal(app.calls('d2').length, 0, 'a Dev mid-turn is not woken')
  assert.equal(app.calls('r1').length, 0, 'another role is not woken')
  assert.equal(app.calls('a').length, 0, 'the enqueuer is not woken for its own item')
  assert.match(app.text('d1'), /queued for Dev/)
  await app.enqueue({ title: 'Review the diff', role: 'Reviewer' })
  assert.equal(app.calls('r1').length, 1, 'the second role gets its own wake')
  assert.equal(app.calls('d1').length, 1, 'one wake per item: the Dev is not woken for a Reviewer item')
})

// The member that already holds a card in progress is refused by `claimQueued` (WIP = 1), so a queue
// cue for it is a turn spent on that refusal while the item waits behind its card. The offer goes to
// the idle member of the role instead (#1247).
test('an idle member behind one holding a card is the one woken (#1247)', async (t) => {
  const app = await start(t)
  const held = await app.track('d1', { tasks: [{ group: 'War', title: 'Held card', column: 'in-progress', progress: 30 }] })
  const heldId = app.idOf(held, 'Held card')
  // That wake was the member's own turn: it ended, and the card is the only thing left on it.
  await app.finishWake('d1')
  assert.equal(app.calls('d1').length, 1)

  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  assert.equal(app.calls('d1').length, 1, 'the member holding a card is not offered the queue item')
  assert.doesNotMatch(app.text('d1'), /Take /, 'a queue cue for a member that cannot claim it')
  assert.equal(app.calls('d2').length, 1, 'the idle member of the role is woken')
  assert.match(app.text('d2'), new RegExp(`Take ${id} `))
  assert.equal(app.rt.state.tasks[id].claimedBy, undefined, 'a wake is not a claim')
  // WIP = 1 still refuses the claim itself, naming the card the member holds.
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`in-progress card \\(${heldId}\\)`))
})

// One pass, one Session, one task wake (#1247): the work pass wakes the member its card names, and the
// queue pass must not stack a second cue on the same Session — one turn would read two contradictions,
// and the queue item would stay behind the first cue's card.
test('one pass gives a Session at most one task wake (#1247)', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Dev1', group: 'War', priority: 'high' },
    { title: 'Fix the flaky test', group: 'War', queue: true, role: 'Dev' },
  ] })
  const written = app.idOf(body, 'Write the draft')
  const queued = app.idOf(body, 'Fix the flaky test')
  assert.equal(app.calls('d1').length, 1, 'the assigned card wakes its member once')
  assert.match(app.text('d1'), new RegExp(`Continue ${written} `))
  assert.doesNotMatch(app.text('d1'), /Take /, 'no second task wake on a Session that already has one')
  assert.equal(app.calls('d2').length, 1, 'the idle member of the role takes the queue item instead')
  assert.match(app.text('d2'), new RegExp(`Take ${queued} `))
  assert.equal(app.rt.state.tasks[queued].claimedBy, undefined, 'a wake is not a claim')
})

test('a queue wake names the title and id, not the item body (#1247)', async (t) => {
  const app = await start(t)
  const note = 'BODY_START the migration needs a backfill, a rollback plan and two reviewers before it moves BODY_END'
  const { id } = await app.enqueue({ title: 'Backfill the table', role: 'Dev', note })
  const wake = app.text('d1')
  assert.ok(wake.includes(id), wake)
  assert.match(wake, /Backfill the table/)
  assert.doesNotMatch(wake, /BODY_START/, 'the body is not carried into the wake')
  assert.ok(wake.length < 400, `a wake is a short turn, got ${wake.length} chars:\n${wake}`)
})

test('a blocked item comes back to the queue with a retryAt (#1247)', async (t) => {
  const app = await start(t)
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const { id } = await app.enqueue({ title: 'Fix the flaky test', role: 'Dev' })
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
  await app.track('d1', { tasks: [{ group: 'War', id, column: 'in-progress', progress: 10 }] })
  await app.track('d1', { tasks: [{ group: 'War', id, ask: 'Which key should it use?' }] })
  assert.equal(app.rt.state.tasks[id].status, 'blocked')
  const returned = await app.track('d1', { release: { task: id, reason: 'needs the owner key', retryInSec: 120 } })
  assert.match(returned, new RegExp(`Returned ${id} to the queue`))
  const task = app.rt.state.tasks[id]
  assert.equal(task.status, 'open')
  assert.equal(task.claimedBy, undefined)
  assert.equal(task.ownerBotId, 'a', 'an open item belongs to the room again, not to the member')
  assert.equal(task.waitingFor, undefined)
  assert.equal(task.retryAt, 1_700_000_120_000)
  assert.equal(task.queueReason, 'needs the owner key')
  assert.match(await app.track('d1', { claim: true, group: 'War' }), /^No queued item for Dev/, 'not offered again before retryAt')
  t.mock.timers.tick(121_000)
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `), 'offered again once retryAt passed')
})

test('an item whose role nobody in the room carries is refused at enqueue (#1247)', async (t) => {
  const app = await start(t)
  const body = await app.track('a', { tasks: [{ group: 'War', queue: true, role: 'Ops', title: 'Restart the box' }] })
  assert.match(body, /no-member-with-role/)
  assert.equal(app.rt.state.tasks['task-' + '0'.repeat(16)], undefined)
  assert.equal(Object.keys(app.rt.state.tasks ?? {}).length, 0, 'no item is left sitting for a role nobody has')
})

test('the room board carries one queue line per role, with depth and oldest wait (#1247)', () => {
  const now = 1_700_000_000_000
  const minutes = 60_000
  const tasks = {
    a1: { id: 'a1', status: 'open', queueRole: 'Dev', title: 'Old Dev item', ownerBotId: 'lead', origin: { roomId: 'room' }, createdAt: now - 180 * minutes, updatedAt: now - 180 * minutes },
    a2: { id: 'a2', status: 'open', queueRole: 'dev', title: 'New Dev item', ownerBotId: 'lead', origin: { roomId: 'room' }, createdAt: now - 10 * minutes, updatedAt: now - 10 * minutes },
    a3: { id: 'a3', status: 'open', queueRole: 'Reviewer', title: 'Review item', ownerBotId: 'lead', origin: { roomId: 'room' }, createdAt: now - 12 * minutes, updatedAt: now - 12 * minutes },
    a4: { id: 'a4', status: 'claimed', queueRole: 'Dev', claimedBy: 'd1', title: 'Taken Dev item', ownerBotId: 'd1', origin: { roomId: 'room' }, createdAt: now - 300 * minutes, updatedAt: now - 5 * minutes },
  }
  const board = formatRoomBoard(tasks, { roomId: 'room', now, nameOf: task => (task.ownerBotId === 'd1' ? 'Dev1' : 'Chief') })
  assert.match(board, /- Queue Dev: 2 waiting, oldest 3h/, board)
  assert.match(board, /- Queue Reviewer: 1 waiting, oldest 12m/, board)
  assert.doesNotMatch(board, /Queue Ops/, 'a role with nothing waiting is omitted')
  assert.match(board, /unassigned \[open 3h Dev\] Old Dev item/)
  assert.match(board, /Dev1 \[claimed\] Taken Dev item/, 'a claimed item names its member, not the queue')
})

test('eight cards and three role lines still fit the room budget (#1247)', () => {
  const now = 1_700_000_000_000
  const tasks = {}
  const roles = ['Dev', 'Reviewer', 'Docs']
  for (let index = 0; index < 24; index += 1) {
    const id = `q${index}`
    tasks[id] = {
      id, status: 'open', queueRole: roles[index % 3], ownerBotId: 'lead', origin: { roomId: 'room' },
      title: `A queued item with a long enough name to matter ${index} ${'detail '.repeat(6)}`,
      note: 'note '.repeat(12),
      createdAt: now - index * 60_000, updatedAt: now - index * 60_000,
    }
  }
  const board = formatRoomBoard(tasks, { roomId: 'room', now, nameOf: () => 'Chief' })
  assert.ok(board.length <= ROOM_CONTEXT_BUDGET, `board is ${board.length} chars, budget ${ROOM_CONTEXT_BUDGET}`)
  assert.match(board, /- Queue Dev: 8 waiting/)
  assert.match(board, /- Queue Reviewer: 8 waiting/)
  assert.match(board, /- Queue Docs: 8 waiting/)
})

test('a claimed item is the same card the room board already shows (#1247)', async (t) => {
  const app = await start(t)
  const { id } = await app.enqueue({ title: 'Ship the note', role: 'Dev' })
  assert.match(await app.track('d1', { claim: true, group: 'War' }), new RegExp(`^Claimed ${id} `))
  const board = app.board()
  const rows = board.split('\n').filter(line => line.includes('Ship the note'))
  assert.equal(rows.length, 1, `one row for one card, got:\n${board}`)
  assert.match(rows[0], /Dev1 \[claimed\] Ship the note/)
  assert.doesNotMatch(board, /- Queue Dev/, 'the claimed item is not still counted in the queue')
  assert.equal(Object.values(app.rt.state.tasks).filter(task => task.title === 'Ship the note').length, 1)
})

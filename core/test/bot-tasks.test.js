// Per-Bot task board (#1058): the existing task records gain a board column,
// progress and priority. A Bot records work from its own conversation with
// track_tasks. The owner sees that Bot's list; a tree parent can read a
// descendant's list; a group admin can read tasks tagged with the group.
// A non-admin cannot read another Bot's group tasks, and a read is not a write.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { columnOf, occupiesSlot } from '../src/shared/task-board.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
  },
  bots: {
    a: { id: 'a', name: 'ChiefA', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    s: { id: 's', name: 'Writer', role: 'Write', sessionId: 's', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 's'], admin: 'a', mode: 'everyone', named: true, sessions: { s: 's-war' }, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 's', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t, config = {}) {
  const home = config.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  if (config.state !== undefined || !existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(config.state ?? team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {},
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${++created}` }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  let created = 0
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path.endsWith('bot')) route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload, token) => {
    const headers = token ? { 'x-flybot-member-session': token } : undefined
    return (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const signIn = async (displayName, inviterToken) => {
    const invite = await call('auth-invite', {}, inviterToken)
    assert.equal(invite.ok, true, JSON.stringify(invite))
    const redeemed = await call('auth-redeem', { token: invite.value.token, displayName })
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed))
    return redeemed.value
  }
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args ?? {}, { agent: { id: sessionId } })
  return { ctx, call, stop, signIn, track, home, statePath: join(home, 'state.json') }
}

const list = async (call, token, payload) => {
  const result = await call('tasks', payload ?? {}, token)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}

test('a Bot records conversation tasks and the owner moves them across the board', async (t) => {
  const first = await start(t)
  let app = first
  t.after(() => app.stop())
  const alice = await first.signIn('Alice')
  const created = await first.track('s', { tasks: [{ title: 'Draft the note', column: 'not-started', priority: 'high', progress: 0 }] })
  assert.match(created, /task-/)
  const open = (await list(first.call, alice.sessionToken, { botId: 's' })).find(task => task.title === 'Draft the note')
  assert.ok(open, 'the owner sees the Bot\'s task')
  assert.equal(open.source, 'conversation')
  assert.equal(open.status, 'open')
  assert.equal(columnOf(open), 'not-started')
  assert.equal(open.priority, 'high')
  assert.equal(open.progress, 0)
  assert.equal(open.ownerBotId, 's')
  assert.equal(open.requesterId, alice.memberId)

  const again = await first.track('s', { tasks: [{ title: 'Draft the note', column: 'in-progress', progress: 40, note: 'Outline done' }] })
  assert.match(again, new RegExp(open.id))
  const working = (await list(first.call, alice.sessionToken, { botId: 's' })).filter(task => task.title === 'Draft the note')
  assert.equal(working.length, 1, 'the same title updates the open task')
  assert.equal(working[0].id, open.id)
  assert.equal(working[0].status, 'working')
  assert.equal(columnOf(working[0]), 'in-progress')
  assert.equal(working[0].progress, 40)
  assert.equal(working[0].note, 'Outline done')

  const started = await first.call('task-update', { id: open.id, column: 'not-started' }, alice.sessionToken)
  assert.equal(started.ok, false)
  assert.equal(started.error.code, 'bot/stale')
  assert.equal((await list(first.call, alice.sessionToken, { botId: 's' })).find(task => task.id === open.id).status, 'working')

  const done = await first.call('task-update', { id: open.id, column: 'done' }, alice.sessionToken)
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.value.status, 'accepted')
  assert.equal(columnOf(done.value), 'done')
  assert.equal(done.value.progress, 100)
  assert.equal(done.value.result.summary, 'Outline done')

  const late = await first.call('task-update', { id: open.id, column: 'in-progress' }, alice.sessionToken)
  assert.equal(late.ok, false)
  assert.equal(late.error.code, 'bot/stale')

  await first.stop({ keepHome: true })
  const restored = await start(t, { home: first.home })
  app = restored
  const saved = (await list(restored.call, alice.sessionToken, { botId: 's', archive: true })).find(task => task.id === open.id)
  assert.equal(saved.status, 'accepted')
  assert.equal(saved.progress, 100)
  assert.equal(saved.priority, 'high')
})

test('board moves walk the task states and a blocked task stays put', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const created = await app.call('task-create', { botId: 's', title: 'Check the figures', priority: 'low', progress: 0 }, alice.sessionToken)
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.value.id
  assert.equal(created.value.priority, 'low')
  assert.equal(created.value.progress, 0)
  const started = await app.call('task-update', { id, column: 'in-progress', progress: 25 }, alice.sessionToken)
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.equal(started.value.status, 'working')
  assert.equal(started.value.progress, 25)
  assert.ok(started.value.actors.some(entry => entry.status === 'claimed'))
  const waiting = await app.call('task-wait-input', { id, question: 'Which quarter?' }, alice.sessionToken)
  assert.equal(waiting.ok, true, JSON.stringify(waiting))
  const refused = await app.call('task-update', { id, column: 'done' }, alice.sessionToken)
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/stale')
  assert.equal((await list(app.call, alice.sessionToken)).find(task => task.id === id).status, 'blocked')
  const bad = await app.call('task-update', { id, priority: 'top' }, alice.sessionToken)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bot/invalid')
})

test('a tree parent can read a child, and only a group admin can read other Bots\' group tasks', async (t) => {
  const first = await start(t)
  let app = first
  t.after(() => app.stop())
  const alice = await first.signIn('Alice')
  assert.equal(alice.memberId, 'owner-1')
  const bob = await first.signIn('Bob', alice.sessionToken)
  const carol = await first.signIn('Carol', alice.sessionToken)
  await first.stop({ keepHome: true })
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8'))
  saved.bots.b = { id: 'b', name: 'BobBot', role: 'Help', sessionId: 'b', createdAt: 4, ownerId: bob.memberId, createdBy: null }
  saved.bots.c = { id: 'c', name: 'Child', role: 'Help', sessionId: 'c', createdAt: 5, ownerId: bob.memberId, createdBy: 'a' }
  const room = saved.rooms.war
  room.members = ['a', 's', 'b', 'c']
  room.admin = 'a'
  room.sessions = { s: 's-war', b: 'b-war', c: 'c-own' }
  room.participants = [
    { kind: 'human', id: alice.memberId, role: 'member', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
    { kind: 'human', id: bob.memberId, role: 'member', displayName: 'Bob', joinedSeq: 0, joinedAt: 1 },
    { kind: 'human', id: carol.memberId, role: 'admin', displayName: 'Carol', joinedSeq: 0, joinedAt: 1 },
    { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
    { kind: 'bot', id: 's', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
    { kind: 'bot', id: 'b', role: 'member', displayName: 'BobBot', joinedSeq: 0, joinedAt: 1 },
    { kind: 'bot', id: 'c', role: 'member', displayName: 'Child', joinedSeq: 0, joinedAt: 1 },
  ]
  writeFileSync(first.statePath, JSON.stringify(saved))
  const next = await start(t, { home: first.home })
  app = next

  const groupLine = await next.track('s-war', { tasks: [{ title: 'Answer in the group', column: 'in-progress', progress: 10, priority: 'urgent' }] })
  assert.match(groupLine, /in-progress/)
  const writer = (await list(next.call, alice.sessionToken, { botId: 's' })).find(task => task.title === 'Answer in the group')
  assert.equal(writer.origin.roomId, 'war')
  assert.equal(writer.origin.sessionId, 's-war')

  await next.track('b', { tasks: [{ title: 'Private draft', column: 'not-started' }] })
  await next.track('b-war', { tasks: [{ title: 'Bob\'s group item', column: 'not-started', priority: 'normal' }] })
  await next.track('c', { tasks: [{ title: 'Child follow-up', column: 'in-progress', progress: 15 }] })

  const child = await list(next.call, alice.sessionToken, { botId: 'c' })
  assert.equal(child.length, 1)
  assert.equal(child[0].title, 'Child follow-up')
  assert.equal(child[0].ownerBotName, 'Child')
  const carolChild = await next.call('tasks', { botId: 'c' }, carol.sessionToken)
  assert.equal(carolChild.ok, false)
  assert.equal(carolChild.error.code, 'bot/forbidden')
  const aliceAll = await list(next.call, alice.sessionToken)
  assert.ok(aliceAll.some(task => task.id === child[0].id), 'a parent\'s owner sees the descendant without a group query')
  assert.equal(aliceAll.some(task => task.title === 'Private draft' || task.title === 'Bob\'s group item'), false)

  const roomTasks = await list(next.call, alice.sessionToken, { roomId: 'war' })
  assert.deepEqual(roomTasks.map(task => task.title).sort(), ['Answer in the group', 'Bob\'s group item'])
  const carolRoom = await list(next.call, carol.sessionToken, { roomId: 'war' })
  assert.deepEqual(carolRoom.map(task => task.title).sort(), ['Answer in the group', 'Bob\'s group item'])
  const bobRoom = await next.call('tasks', { roomId: 'war' }, bob.sessionToken)
  assert.equal(bobRoom.ok, false)
  assert.equal(bobRoom.error.code, 'bot/forbidden')
  const bobOwn = await list(next.call, bob.sessionToken, { botId: 'b' })
  assert.deepEqual(bobOwn.map(task => task.title).sort(), ['Bob\'s group item', 'Private draft'])
  const bobAll = await list(next.call, bob.sessionToken)
  assert.equal(bobAll.some(task => task.ownerBotId === 's'), false, 'a non-admin does not see another Bot\'s group task')

  const edited = await next.call('task-update', { id: roomTasks.find(task => task.title === 'Bob\'s group item').id, column: 'done' }, alice.sessionToken)
  assert.equal(edited.ok, false)
  assert.equal(edited.error.code, 'bot/forbidden')
  const carolEdit = await next.call('task-update', { id: writer.id, progress: 90 }, carol.sessionToken)
  assert.equal(carolEdit.ok, false)
  assert.equal(carolEdit.error.code, 'bot/forbidden')
  assert.equal((await list(next.call, alice.sessionToken, { botId: 's' })).find(task => task.id === writer.id).progress, 10)

  const stolen = await next.track('s', { tasks: [{ id: bobOwn.find(task => task.title === 'Private draft').id, column: 'done' }] })
  assert.match(stolen, /not yours/)
  assert.equal((await list(next.call, bob.sessionToken, { botId: 'b' })).find(task => task.title === 'Private draft').status, 'open')
})

test('a group keeps one overall task and a subtask per Bot, and unfinished work follows priority', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const planned = await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War', priority: 'high' },
    { title: 'Write the draft', parent: 'Ship the note', assignee: 'Writer', group: 'War', priority: 'urgent' },
    { title: 'Review the draft', parent: 'Ship the note', assignee: 'ChiefA', group: 'War', priority: 'low' },
  ] })
  assert.match(planned, /overall/)
  const roomTasks = await list(app.call, alice.sessionToken, { roomId: 'war' })
  const overall = roomTasks.find(task => task.kind === 'group')
  assert.ok(overall, 'the group has an overall task')
  assert.equal(overall.title, 'Ship the note')
  assert.equal(overall.ownerBotId, 'a')
  const draft = roomTasks.find(task => task.title === 'Write the draft')
  const review = roomTasks.find(task => task.title === 'Review the draft')
  assert.equal(draft.ownerBotId, 's')
  assert.equal(draft.priority, 'urgent')
  assert.equal(draft.parentId, overall.id)
  assert.equal(draft.parentTitle, 'Ship the note')
  assert.equal(review.ownerBotId, 'a')
  assert.equal(review.parentId, overall.id)

  const renamed = await app.track('a', { tasks: [{ title: 'Ship the notes', overall: true, group: 'War' }] })
  assert.match(renamed, new RegExp(overall.id))
  const again = await list(app.call, alice.sessionToken, { roomId: 'war' })
  assert.equal(again.filter(task => task.kind === 'group').length, 1, 'a second overall updates the open one')
  assert.equal(again.find(task => task.kind === 'group').title, 'Ship the notes')
  assert.equal(again.find(task => task.title === 'Write the draft').parentId, overall.id)

  const member = await app.track('s', { tasks: [{ title: 'Ship something else', overall: true, group: 'War' }] })
  assert.match(member, /Only the group admin/)
  const assigned = await app.track('s', { tasks: [{ title: 'Extra', parent: 'Ship the notes', assignee: 'ChiefA', group: 'War' }] })
  assert.match(assigned, /Only the group admin/)

  await app.track('s-war', { tasks: [
    { title: 'Write the draft', column: 'in-progress', progress: 20 },
    { title: 'File the draft', parent: 'Ship the notes', column: 'in-progress', priority: 'low', progress: 5 },
  ] })
  const read = await app.track('s-war', {})
  assert.match(read, new RegExp(`Next: ${draft.id} \\[in-progress urgent\\] Write the draft`))

  await app.track('a', { tasks: [
    { title: 'Fresh high', priority: 'high', column: 'not-started' },
    { title: 'Going high', priority: 'high', column: 'in-progress', progress: 15 },
  ] })
  const chief = await app.track('a', {})
  assert.match(chief, /Next: \S+ \[in-progress high\] Going high/)

  const asked = await app.track('s-war', { tasks: [{ id: draft.id, ask: 'Which tone?' }] })
  assert.match(asked, /Post one short question in the group only when a person there has to decide: Which tone\?/)
  const waiting = (await list(app.call, alice.sessionToken, { botId: 's' })).find(task => task.id === draft.id)
  assert.equal(waiting.status, 'blocked')
  assert.equal(waiting.waitingFor, 'input')
  assert.equal(waiting.inputRequest.question, 'Which tone?')
  const early = await app.track('s-war', { tasks: [{ id: draft.id, column: 'done' }] })
  assert.match(early, /waiting on an answer/)
  assert.equal((await list(app.call, alice.sessionToken, { botId: 's' })).find(task => task.id === draft.id).status, 'blocked')
  const resumed = await app.track('s-war', { tasks: [{ id: draft.id, answer: 'Warm', progress: 55 }] })
  assert.match(resumed, /in-progress/)
  const back = (await list(app.call, alice.sessionToken, { botId: 's' })).find(task => task.id === draft.id)
  assert.equal(back.status, 'working')
  assert.equal(back.progress, 55)
  assert.equal(back.inputRequest.answer, 'Warm')

  const solo = await app.track('s', { tasks: [{ title: 'Solo note', ask: 'Which file?' }] })
  assert.match(solo, /call ask_user to ask the user: Which file\?/)
  assert.match(app.ctx.sections.get('bot-identity').text({ agent: { id: 'a' } }), /overall: true/)
})

test('a classic group without participants still lists the overall task and another owner\'s subtask', async (t) => {
  const first = await start(t)
  let app = first
  t.after(() => app.stop())
  const alice = await first.signIn('Alice')
  const bob = await first.signIn('Bob', alice.sessionToken)
  await first.stop({ keepHome: true })
  const saved = JSON.parse(readFileSync(first.statePath, 'utf8'))
  saved.bots.b = { id: 'b', name: 'BobBot', role: 'Help', sessionId: 'b', createdAt: 4, ownerId: bob.memberId }
  saved.rooms.old = {
    id: 'old', name: 'Old', members: ['a', 'b'], admin: 'a', mode: 'everyone', named: true,
    sessions: { a: 'a-old', b: 'b-old' }, log: [], seq: 0, seen: {},
  }
  writeFileSync(first.statePath, JSON.stringify(saved))
  const next = await start(t, { home: first.home })
  app = next

  await next.track('a-old', { tasks: [
    { title: 'Ship the note', overall: true, priority: 'high' },
    { title: 'Bob writes', parent: 'Ship the note', assignee: 'BobBot', priority: 'high' },
  ] })
  const roomTasks = await list(next.call, alice.sessionToken, { roomId: 'old' })
  assert.deepEqual(roomTasks.map(task => task.title).sort(), ['Bob writes', 'Ship the note'])
  const overall = roomTasks.find(task => task.kind === 'group')
  const child = roomTasks.find(task => task.title === 'Bob writes')
  assert.equal(child.ownerBotId, 'b')
  assert.equal(child.requesterId, bob.memberId)
  assert.equal(child.parentId, overall.id)
  assert.equal(child.parentTitle, 'Ship the note')

  const edited = await next.call('task-update', { id: child.id, column: 'done' }, alice.sessionToken)
  assert.equal(edited.ok, false)
  assert.equal(edited.error.code, 'bot/forbidden')
  const updated = await next.track('b-old', { tasks: [{ title: 'Bob writes', column: 'in-progress', progress: 40 }] })
  assert.match(updated, /in-progress/)
  assert.equal((await list(next.call, bob.sessionToken, { botId: 'b' })).find(task => task.id === child.id).progress, 40)
  const denied = await next.track('b-old', { tasks: [{ title: 'Another job', overall: true }] })
  assert.match(denied, /Only the group admin/)
  assert.match(next.ctx.sections.get('bot-room').text({ agent: { id: 'a-old' } }), /overall task/)
  assert.equal((await list(next.call, bob.sessionToken)).some(task => task.kind === 'group'), false)
})

// #1154: a decision on a task that names an issue or PR is a comment the owning Bot has to post —
// it holds the connector, the host holds no token. The board shows that work, and the Bot reports
// once how it went; a task that names nowhere asks for nothing.
test('the board asks the owning Bot for the comment a decision needs, and takes one report (#1154)', async (t) => {
  const at = Date.now()
  const state = team()
  state.tasks = {
    'task-write-back': {
      id: 'task-write-back', status: 'accepted', createdAt: at - 60_000, updatedAt: at - 1000,
      requesterId: 'owner-1', ownerBotId: 's', title: 'Ship the fix', source: 'conversation', origin: {},
      target: { owner: 'ThinkFlowLab', repo: 'FlyBot', number: 1154, href: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154' },
      writeBack: {
        target: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154', at: at - 1000, state: 'pending',
        body: 'Accepted: Ship the fix\n\nDraft is ready\n\nDecided in FlyBot by Alice.\n\nWritten-by: Alice',
      },
      actors: [{ status: 'accepted', at: at - 1000, memberId: 'owner-1' }],
    },
    'task-fails': {
      id: 'task-fails', status: 'accepted', createdAt: at - 60_000, updatedAt: at - 3000,
      requesterId: 'owner-1', ownerBotId: 's', title: 'Cannot write this one', source: 'conversation', origin: {},
      target: { owner: 'ThinkFlowLab', repo: 'FlyBot', number: 1154, href: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154' },
      writeBack: { target: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154', at: at - 3000, state: 'pending', body: 'Accepted: Cannot write this one' },
      actors: [{ status: 'accepted', at: at - 3000, memberId: 'owner-1' }],
    },
    'task-expired': {
      id: 'task-expired', status: 'accepted', createdAt: at - 200_000, updatedAt: at - 90_000_000,
      requesterId: 'owner-1', ownerBotId: 's', title: 'Posted a day late', source: 'conversation', origin: {},
      target: { owner: 'ThinkFlowLab', repo: 'FlyBot', number: 1154, href: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154' },
      writeBack: { target: 'https://github.com/ThinkFlowLab/FlyBot/issues/1154', at: at - 90_000_000, state: 'unconfirmed', wakes: 2, body: 'Accepted: Posted a day late' },
      actors: [{ status: 'accepted', at: at - 90_000_000, memberId: 'owner-1' }],
    },
    'task-plain': {
      id: 'task-plain', status: 'accepted', createdAt: at - 60_000, updatedAt: at - 2000,
      requesterId: 'owner-1', ownerBotId: 's', title: 'Nothing to write back', source: 'conversation', origin: {},
      actors: [{ status: 'accepted', at: at - 2000, memberId: 'owner-1' }],
    },
  }
  const app = await start(t, { state })
  t.after(() => app.stop())

  const listed = await app.track('s')
  assert.match(listed, /Post task-write-back: comment on https:\/\/github\.com\/ThinkFlowLab\/FlyBot\/issues\/1154/)
  assert.match(listed, /Written-by: Alice/)
  assert.equal(listed.includes('Post task-plain:'), false, 'a task with no target asks for nothing')

  // One report settles it, and the work leaves the board.
  const posted = await app.track('s', { postResult: { task: 'task-write-back', ok: true } })
  assert.equal(posted.includes('Post task-write-back:'), false)
  const settled = JSON.parse(readFileSync(app.statePath, 'utf8')).tasks['task-write-back']
  assert.equal(settled.writeBack.state, 'posted')
  assert.equal(settled.status, 'accepted', 'reporting does not move the decision')

  // A failure is one report too: it needs its reason, it lands on the task, the decision stays.
  assert.match(await app.track("s", { postResult: { task: "task-fails", ok: false } }), /needs its reason/)
  assert.match(await app.track("s"), /Post task-fails:/, "a refused report leaves the work waiting")
  const failedReport = await app.track("s", { postResult: { task: "task-fails", ok: false, error: "HTTP 403 from the connector" } })
  assert.equal(failedReport.includes("Post task-fails:"), false, "one report ends it, no retry loop")
  const failed = JSON.parse(readFileSync(app.statePath, "utf8")).tasks["task-fails"]
  assert.equal(failed.writeBack.state, "failed")
  assert.equal(failed.writeBack.error, "HTTP 403 from the connector")
  assert.equal(failed.status, "accepted", "reporting does not move the decision")

  // Only the owning Bot, only once.
  assert.match(await app.track("a", { postResult: { task: "task-plain", ok: true } }), /Only the Bot that owns this task/)
  const again = await app.track("s", { postResult: { task: "task-write-back", ok: true } })
  assert.match(again, /no comment waiting/)
  assert.equal(again.includes("Post task-write-back:"), false)

  // #1172: a record the drive gave up on is no longer offered, but a comment posted on a later turn
  // still clears the card — the record must not keep saying it could not be confirmed.
  assert.equal(listed.includes('Post task-expired:'), false, 'an unconfirmed comment is not work any more')
  await app.track("s", { postResult: { task: "task-expired", ok: true } })
  const late = JSON.parse(readFileSync(app.statePath, "utf8")).tasks["task-expired"]
  assert.equal(late.writeBack.state, "posted")
  assert.equal(late.writeBack.wakes, 2, "the count stays with the record")
  assert.equal(late.status, "accepted")
})

// #1252: a finished card leaves the active list, or a long-lived group's board grows without
// bound; the archive is the same read with a flag, not a second endpoint.
test('#1252: a room board lists active work only, and the archive is explicit', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  await app.track('a', { tasks: [
    { title: 'Keep this moving', group: 'War', column: 'in-progress', progress: 30 },
    { title: 'This one is done', group: 'War', column: 'in-progress', progress: 10 },
  ] })
  const before = await list(app.call, alice.sessionToken, { roomId: 'war' })
  const finished = before.find(task => task.title === 'This one is done')
  const done = await app.call('task-update', { id: finished.id, column: 'done' }, alice.sessionToken)
  assert.equal(done.ok, true, JSON.stringify(done))

  const active = await list(app.call, alice.sessionToken, { roomId: 'war' })
  assert.equal(active.some(task => task.id === finished.id), false, 'a done card leaves the room board by default')
  assert.equal(active.some(task => task.title === 'Keep this moving'), true, 'unfinished work stays')

  const all = await list(app.call, alice.sessionToken, { roomId: 'war', archive: true })
  assert.equal(all.some(task => task.id === finished.id), true, 'the archive still carries the finished card')
  assert.equal(all.length, active.length + 1)
})

// #1252: an overall card with no open child left has to be able to complete, or a group keeps a
// card working that nobody can close.
test('#1252: the last child completing completes the overall card instead of leaving it working', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write it', parent: 'Ship the note', assignee: 'Writer', group: 'War' },
    { title: 'Review it', parent: 'Ship the note', assignee: 'ChiefA', group: 'War' },
  ] })
  const room = await list(app.call, alice.sessionToken, { roomId: 'war' })
  const overall = room.find(task => task.kind === 'group')
  const write = room.find(task => task.title === 'Write it')
  const review = room.find(task => task.title === 'Review it')

  const firstMove = await app.call('task-update', { id: write.id, column: 'done' }, alice.sessionToken)
  assert.equal(firstMove.ok, true, JSON.stringify(firstMove))
  const afterOne = (await list(app.call, alice.sessionToken, { roomId: 'war' })).find(task => task.id === overall.id)
  assert.equal(afterOne.status, 'open', 'one child still open keeps the overall card where it was')

  const lastMove = await app.call('task-update', { id: review.id, column: 'done' }, alice.sessionToken)
  assert.equal(lastMove.ok, true, JSON.stringify(lastMove))
  const parent = (await list(app.call, alice.sessionToken, { roomId: 'war', archive: true })).find(task => task.id === overall.id)
  assert.equal(parent.status, 'accepted', 'the overall card completes with its last child')
  assert.equal(columnOf(parent), 'done')
  assert.equal(parent.progress, 100)
})

// #1252: a failed part is not hidden behind an accepted overall card. The card completes `accepted`
// only when every child ended accepted or cancelled, and `failed` when any child ended failed.
test('#1252: an overall card fails when one of its children failed', async (t) => {
  const at = Date.now()
  const state = team()
  state.tasks = {
    'task-overall': {
      id: 'task-overall', status: 'working', kind: 'group', createdAt: at - 60_000, updatedAt: at - 5000,
      requesterId: 'owner-1', ownerBotId: 'a', title: 'Ship the note', source: 'conversation',
      origin: { roomId: 'war' }, actors: [{ status: 'working', at: at - 5000, memberId: 'owner-1' }],
    },
    'task-child-ok': {
      id: 'task-child-ok', status: 'working', createdAt: at - 50_000, updatedAt: at - 4000,
      requesterId: 'owner-1', ownerBotId: 's', title: 'Write it', parentId: 'task-overall',
      source: 'conversation', origin: { roomId: 'war' }, actors: [{ status: 'working', at: at - 4000, memberId: 'owner-1' }],
    },
    'task-child-failed': {
      id: 'task-child-failed', status: 'failed', createdAt: at - 40_000, updatedAt: at - 3000,
      requesterId: 'owner-1', ownerBotId: 'a', title: 'Review it', parentId: 'task-overall',
      source: 'conversation', origin: { roomId: 'war' }, actors: [{ status: 'failed', at: at - 3000, memberId: 'owner-1' }],
    },
  }
  const app = await start(t, { state })
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const moved = await app.call('task-update', { id: 'task-child-ok', column: 'done' }, alice.sessionToken)
  assert.equal(moved.ok, true, JSON.stringify(moved))
  const parent = (await list(app.call, alice.sessionToken, { roomId: 'war', archive: true })).find(task => task.id === 'task-overall')
  assert.equal(parent.status, 'failed', 'a failed child makes the overall card fail, not pass')
})

// #1252: the wire must not carry the whole archive. A requested `limit` bounds the finished rows,
// while a read without one still returns every row, so lookups by id keep working.
test('#1252: an archive read can ask for the newest rows, and an unbounded read still sees them all', async (t) => {
  const at = Date.now()
  const state = team()
  state.tasks = {}
  for (let i = 0; i < 200; i++) {
    state.tasks[`task-settled-${i}`] = {
      id: `task-settled-${i}`, status: 'accepted', createdAt: at - 200_000 + i, updatedAt: at - 100_000 + i,
      requesterId: 'owner-1', ownerBotId: 'a', title: `Settled ${i}`, source: 'conversation',
      origin: { roomId: 'war' }, actors: [{ status: 'accepted', at: at - 100_000 + i, memberId: 'owner-1' }],
    }
  }
  const app = await start(t, { state })
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')

  const bounded = await list(app.call, alice.sessionToken, { roomId: 'war', archive: true, limit: 20 })
  assert.equal(bounded.length, 20, 'the requested limit bounds the payload')
  assert.equal(bounded.some(task => task.id === 'task-settled-199'), true, 'the newest finished card is in the slice')
  assert.equal(bounded.some(task => task.id === 'task-settled-0'), false, 'the oldest finished card is not')

  const unbounded = await list(app.call, alice.sessionToken, { roomId: 'war', archive: true })
  assert.equal(unbounded.length, 200, 'a read with no limit still returns every settled row')
  assert.equal(unbounded.some(task => task.id === 'task-settled-0'), true, 'including the oldest, so an id lookup still finds it')
})

// #1252: a bounded archive read is finished rows only. With the budget spent on every row, a busy
// room returns twenty working cards and an empty Done column — the exact row the client asked for.
test('#1252: a bounded archive read carries the newest finished rows and no active ones', async (t) => {
  const at = Date.now()
  const state = team()
  state.tasks = {}
  const row = (id, status, updatedAt) => ({
    id, status, createdAt: at - 500_000, updatedAt,
    requesterId: 'owner-1', ownerBotId: 'a', title: id, source: 'conversation',
    origin: { roomId: 'war' }, actors: [{ status, at: updatedAt, memberId: 'owner-1' }],
  })
  for (let i = 0; i < 25; i++) state.tasks[`task-active-${i}`] = row(`task-active-${i}`, 'working', at - i)
  for (let i = 0; i < 5; i++) state.tasks[`task-settled-${i}`] = row(`task-settled-${i}`, 'accepted', at - 100 - i)

  const app = await start(t, { state })
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')

  const bounded = await list(app.call, alice.sessionToken, { roomId: 'war', archive: true, limit: 20 })
  assert.equal(bounded.every(task => ['accepted', 'cancelled', 'failed'].includes(task.status)), true, 'the bounded archive carries finished rows only')
  assert.equal(bounded.some(task => task.id === 'task-settled-0'), true, 'the newest finished card is present')
  assert.equal(bounded.some(task => task.id.startsWith('task-active-')), false, 'no active row is in the bounded payload')
  assert.equal(bounded.length, 5, 'all five finished cards, since five is under the limit')

  // `limit` is a number or nothing: a coerced `true` or "20" is a wrong request, not a page.
  for (const limit of [true, '20', 0, -3, 1.5, 'abc', {}]) {
    const refused = await app.call('tasks', { roomId: 'war', archive: true, limit }, alice.sessionToken)
    assert.equal(refused.ok, false, `limit ${JSON.stringify(limit)} is refused`)
    assert.equal(refused.error.code, 'bot/invalid', `limit ${JSON.stringify(limit)} is bot/invalid`)
  }
})

// #1252: a child does not only end through a column move. Deleting its Bot fails it, and an owner
// rejecting the send it waits on cancels it; both leave the overall card working unless the same
// settle runs on those doors too. Read the parent back through the archive — that is the card a
// person sees, not the write's return value.
test('#1252: deleting a child\'s Bot fails the overall card, read back from the archive', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write it', parent: 'Ship the note', assignee: 'Writer', group: 'War' },
  ] })
  const room = await list(app.call, alice.sessionToken, { roomId: 'war' })
  const overall = room.find(task => task.kind === 'group')
  const child = room.find(task => task.title === 'Write it')
  const started = await app.call('task-update', { id: child.id, column: 'in-progress' }, alice.sessionToken)
  assert.equal(started.ok, true, JSON.stringify(started))
  const removed = await app.call('delete-bot', { id: 's' }, alice.sessionToken)
  assert.equal(removed.ok, true, JSON.stringify(removed))

  const after = await list(app.call, alice.sessionToken, { archive: true })
  const failedChild = after.find(task => task.id === child.id)
  assert.equal(failedChild?.status, 'failed', 'the deleted Bot\'s child fails')
  const parent = after.find(task => task.id === overall.id)
  assert.equal(parent?.status, 'failed', 'a failed child closes the overall card as failed')
  assert.equal(columnOf(parent), 'done')
})

test('#1252: a rejected approval cancels the child and completes the overall card, read back', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  await app.track('a', { tasks: [
    { title: 'Ship the note', overall: true, group: 'War' },
    { title: 'Write it', parent: 'Ship the note', assignee: 'Writer', group: 'War' },
  ] })
  const room = await list(app.call, alice.sessionToken, { roomId: 'war' })
  const overall = room.find(task => task.kind === 'group')
  const child = room.find(task => task.title === 'Write it')
  const started = await app.call('task-update', { id: child.id, column: 'in-progress' }, alice.sessionToken)
  assert.equal(started.ok, true, JSON.stringify(started))

  app.ctx.flybot.bot.send.use({ name: 'gate', handle: msg => msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined })
  const held = await app.ctx.flybot.bot.send({ from: 's', to: 'a', text: 'send this out', meta: { hold: true } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  const blocked = (await list(app.call, alice.sessionToken, { roomId: 'war' })).find(task => task.id === child.id)
  assert.equal(blocked.status, 'blocked', 'the held send blocks the child')

  const rejected = await app.call('flybot/decide', { id: held.approvalId, decision: 'reject' }, alice.sessionToken)
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  const after = await list(app.call, alice.sessionToken, { roomId: 'war', archive: true })
  const cancelled = after.find(task => task.id === child.id)
  assert.equal(cancelled.status, 'cancelled', 'the rejected send cancels the child')
  const parent = after.find(task => task.id === overall.id)
  assert.equal(parent.status, 'accepted', 'a cancelled child completes the overall card as accepted')
  assert.equal(parent.progress, 100)
  assert.equal(columnOf(parent), 'done')
})

// #1252: the Bot filter runs before the bounded page is cut. Twenty newer cards on another Bot
// must not push this Bot's only finished card off the page — that is the read a Bot board makes.
test('#1252: a Bot-scoped archive page is cut after the Bot filter', async (t) => {
  const at = Date.now()
  const state = team()
  state.tasks = {}
  const row = (id, ownerBotId, updatedAt) => ({
    id, status: 'accepted', createdAt: updatedAt, updatedAt,
    requesterId: 'owner-1', ownerBotId, title: id, source: 'conversation',
    origin: { roomId: 'war' }, actors: [{ status: 'accepted', at: updatedAt, memberId: 'owner-1' }],
  })
  for (let i = 0; i < 20; i++) state.tasks[`task-writer-${i}`] = row(`task-writer-${i}`, 's', at - i)
  state.tasks['task-chief-old'] = row('task-chief-old', 'a', at - 10_000)
  const app = await start(t, { state })
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')

  const mine = await list(app.call, alice.sessionToken, { botId: 'a', archive: true, limit: 20 })
  assert.equal(mine.length, 1, 'the page is cut after the Bot filter, so the older card survives')
  assert.equal(mine[0].id, 'task-chief-old')

  const writers = await list(app.call, alice.sessionToken, { botId: 's', archive: true, limit: 20 })
  assert.equal(writers.length, 20)
  assert.equal(writers.every(task => task.ownerBotId === 's'), true)

  // The unfiltered page is the defect's precondition: its whole budget goes to the newer Bot.
  const scope = await list(app.call, alice.sessionToken, { archive: true, limit: 20 })
  assert.equal(scope.length, 20)
  assert.equal(scope.some(task => task.id === 'task-chief-old'), false, 'the unfiltered page spends the budget on the newer Bot')
})

// The slot predicate beside the column mapping (#1744): only work the member is still doing fills
// its one WIP slot. A blocked card waits on a person and a delivered card waits on its requester,
// so neither counts — while the board still reads all three as in progress, because that is where
// a person finds them.
test('only a claimed or working card occupies the member\'s WIP slot (#1744)', () => {
  for (const status of ['claimed', 'working']) assert.equal(occupiesSlot({ status }), true, status)
  for (const status of ['open', 'blocked', 'result-ready', 'accepted', 'cancelled', 'failed']) {
    assert.equal(occupiesSlot({ status }), false, status)
  }
  assert.equal(occupiesSlot(undefined), false)
  assert.equal(occupiesSlot({}), false)
  assert.equal(columnOf({ status: 'result-ready' }), 'in-progress', 'the board reading is unchanged')
})

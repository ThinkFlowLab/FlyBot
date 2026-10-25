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
import { columnOf } from '../src/shared/task-board.js'
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
  const saved = (await list(restored.call, alice.sessionToken, { botId: 's' })).find(task => task.id === open.id)
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

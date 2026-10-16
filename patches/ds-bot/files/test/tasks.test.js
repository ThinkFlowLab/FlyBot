// Task lifecycle (#54): a request becomes a tracked task with stable ids and a
// state machine — open → claimed → working → (blocked ⇄ working) → result-ready →
// accepted, with cancelled/failed terminal. Only the requester accepts or cancels;
// accepted is reachable only from result-ready, so a failed or cancelled task can
// never display as accepted. Authority is server-derived (#52 rule); team mode
// stays disabled — Alice and Bob are two signed-in members on the #48 foundation.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: 'd' },
  },
  bots: {
    a: { id: 'a', name: 'ChiefA', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d: { id: 'd', name: 'ChiefB', role: 'Boss', sessionId: 'd', createdAt: 2, ownerId: 'owner-2' },
    s: { id: 's', name: 'Writer', role: 'Write', sessionId: 's', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 's'], admin: 'a', mode: 'everyone', named: true, sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 's', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t, config = {}) {
  const home = config.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  if (config.state !== undefined || !existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(config.state ?? team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls, status: 'idle',
        followup(m) { calls.push(m) }, steer(m) { calls.push(m) },
        inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
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
  const createTask = async (token, spec = {}) => call('task-create', { botId: 'a', title: 'Prepare the launch note', criteria: 'note drafts exist', ...spec }, token)
  return { ctx, fb: ctx.flybot, call, stop, signIn, createTask, agentOf, home, statePath: join(home, 'state.json') }
}

const statusOf = async (call, token, id) => {
  const list = await call('tasks', {}, token)
  assert.equal(list.ok, true, JSON.stringify(list))
  return list.value.find(task => task.id === id)
}

test('a task walks the happy path: created, claimed, worked, returned, accepted by the requester', async (t) => {
  const { call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken)
  assert.equal(created.ok, true, JSON.stringify(created))
  const task = created.value
  assert.match(task.id, /^task-[0-9a-f]{16}$/)
  assert.equal(task.status, 'open')
  assert.equal(task.requesterId, alice.memberId)

  const claimed = await call('task-accept', { id: task.id }, alice.sessionToken)
  assert.equal(claimed.ok, true, JSON.stringify(claimed))
  assert.equal(claimed.value.status, 'claimed')

  // Work starts when the room the task points at runs a round.
  const worked = await call('task-start', { id: task.id }, alice.sessionToken)
  assert.equal(worked.ok, true, JSON.stringify(worked))
  assert.equal(worked.value.status, 'working')

  const returned = await call('task-return', { id: task.id, summary: 'Draft is in the room' }, alice.sessionToken)
  assert.equal(returned.ok, true, JSON.stringify(returned))
  assert.equal(returned.value.status, 'result-ready')
  assert.equal(returned.value.result.summary, 'Draft is in the room')

  const accepted = await call('task-accept-result', { id: task.id }, alice.sessionToken)
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.value.status, 'accepted')
  // Terminal: accepting again, or any further move, is stale.
  const again = await call('task-accept-result', { id: task.id }, alice.sessionToken)
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'bot/stale')
})

test('only the requester accepts the result or cancels; another member is forbidden', async (t) => {
  const { call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const bob = await signIn('Bob', alice.sessionToken)
  const created = await createTask(alice.sessionToken)
  const task = created.value
  for (const [endpoint, status] of [['task-accept-result', 'result-ready'], ['task-cancel', 'open']]) {
    if (status !== 'open') await call('task-accept', { id: task.id }, alice.sessionToken)
    void status
    const foreign = await call(endpoint, { id: task.id }, bob.sessionToken)
    assert.equal(foreign.ok, false, JSON.stringify(foreign))
    assert.equal(foreign.error.code, 'bot/forbidden', `${endpoint}: ${JSON.stringify(foreign)}`)
  }
  // Bob cannot claim Alice's task either: the requester's Chief takes it.
  const foreignClaim = await call('task-accept', { id: task.id }, bob.sessionToken)
  assert.equal(foreignClaim.ok, false)
  assert.equal(foreignClaim.error.code, 'bot/forbidden')
  const own = await call('task-cancel', { id: task.id }, alice.sessionToken)
  assert.equal(own.ok, true, JSON.stringify(own))
  assert.equal(own.value.status, 'cancelled')
})

test('invalid transitions are refused: accept-result before a result, cancel after terminal', async (t) => {
  const { call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken)
  const task = created.value
  // No result yet: accepting is stale, not forbidden.
  const early = await call('task-accept-result', { id: task.id }, alice.sessionToken)
  assert.equal(early.ok, false)
  assert.equal(early.error.code, 'bot/stale', JSON.stringify(early))
  await call('task-cancel', { id: task.id }, alice.sessionToken)
  const afterTerminal = await call('task-accept', { id: task.id }, alice.sessionToken)
  assert.equal(afterTerminal.ok, false)
  assert.equal(afterTerminal.error.code, 'bot/stale', JSON.stringify(afterTerminal))
  const recancel = await call('task-cancel', { id: task.id }, alice.sessionToken)
  assert.equal(recancel.ok, false)
  assert.equal(recancel.error.code, 'bot/stale')
})

test('a held send blocks the task, the owner decision resumes or cancels it', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken, { botId: 'a' })
  const task = created.value
  await call('task-accept', { id: task.id }, alice.sessionToken)
  await call('task-start', { id: task.id }, alice.sessionToken)
  // A consequential send from the responsible Bot is held: the task blocks.
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'send this out', meta: { hold: true } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  const blocked = await statusOf(call, alice.sessionToken, task.id)
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked))
  assert.equal(blocked.approvalId, held.approvalId)
  // The owner approves in the existing card: the task resumes.
  const decided = await call('flybot/decide', { id: held.approvalId, decision: 'approve' }, alice.sessionToken)
  assert.equal(decided.ok, true, JSON.stringify(decided))
  const resumed = await statusOf(call, alice.sessionToken, task.id)
  assert.equal(resumed.status, 'working', JSON.stringify(resumed))
})

test('deleting the responsible Bot fails its open tasks', async (t) => {
  const { call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken, { botId: 's' })
  const task = created.value
  await call('task-accept', { id: task.id }, alice.sessionToken)
  const removed = await call('delete-bot', { id: 's' }, alice.sessionToken)
  assert.equal(removed.ok, true, JSON.stringify(removed))
  const after = await statusOf(call, alice.sessionToken, task.id)
  assert.equal(after.status, 'failed', JSON.stringify(after))
})

test('tasks survive a restart with their state and authority', async (t) => {
  const { call, signIn, createTask, stop, home } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken)
  const task = created.value
  await call('task-accept', { id: task.id }, alice.sessionToken)
  await stop({ keepHome: true })
  const again = await start(t, { home })
  t.after(() => again.stop())
  const list = await again.call('tasks', {}, alice.sessionToken)
  assert.equal(list.ok, true, JSON.stringify(list))
  const restored = list.value.find(entry => entry.id === task.id)
  assert.equal(restored.status, 'claimed', JSON.stringify(restored))
  assert.equal(restored.requesterId, task.requesterId)
  const restartedWork = await again.call('task-start', { id: task.id }, alice.sessionToken)
  assert.equal(restartedWork.ok, true, JSON.stringify(restartedWork))
  const returned = await again.call('task-return', { id: task.id, summary: 'back' }, alice.sessionToken)
  assert.equal(returned.ok, true, JSON.stringify(returned))
  assert.equal(returned.value.status, 'result-ready')
})

test('a corrupt tasks map resets instead of poisoning the team', async (t) => {
  const { signIn, createTask, stop, home } = await start(t)
  const alice = await signIn('Alice')
  await createTask(alice.sessionToken)
  await stop({ keepHome: true })
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  saved.tasks = 'garbage'
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const again = await start(t, { home })
  t.after(() => again.stop())
  const list = await again.call('tasks', {}, alice.sessionToken)
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.deepEqual(list.value, [])
  const fresh = await again.createTask(alice.sessionToken)
  assert.equal(fresh.ok, true, JSON.stringify(fresh))
})

test('rejecting the blocked approval cancels the task', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken, { botId: 'a' })
  const task = created.value
  await call('task-accept', { id: task.id }, alice.sessionToken)
  await call('task-start', { id: task.id }, alice.sessionToken)
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'send this out', meta: { hold: true } })
  assert.equal(held.action, 'hold')
  const rejected = await call('flybot/decide', { id: held.approvalId, decision: 'reject' }, alice.sessionToken)
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  const after = await statusOf(call, alice.sessionToken, task.id)
  assert.equal(after.status, 'cancelled', JSON.stringify(after))
  // Terminal: no further moves.
  const resume = await call('task-start', { id: task.id }, alice.sessionToken)
  assert.equal(resume.ok, false)
  assert.equal(resume.error.code, 'bot/stale')
})

test('a held send blocks only the named working task, not every working task of that Bot', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const first = await createTask(alice.sessionToken, { botId: 'a', title: 'Note one' })
  const second = await createTask(alice.sessionToken, { botId: 'a', title: 'Note two' })
  for (const id of [first.value.id, second.value.id]) {
    await call('task-accept', { id }, alice.sessionToken)
    await call('task-start', { id }, alice.sessionToken)
  }
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'send this out', meta: { hold: true, taskId: first.value.id } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'blocked')
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'working')
  const rejected = await call('flybot/decide', { id: held.approvalId, decision: 'reject' }, alice.sessionToken)
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'cancelled')
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'working')
})

test('an untagged hold stamps the latest working task so two tasks do not share one card', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const first = await createTask(alice.sessionToken, { botId: 'a', title: 'Note one' })
  const second = await createTask(alice.sessionToken, { botId: 'a', title: 'Note two' })
  for (const id of [first.value.id, second.value.id]) {
    await call('task-accept', { id }, alice.sessionToken)
    await call('task-start', { id }, alice.sessionToken)
  }
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'untagged send', meta: { hold: true } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'working')
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'blocked')
  const rejected = await call('flybot/decide', { id: held.approvalId, decision: 'reject' }, alice.sessionToken)
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'working')
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'cancelled')
})

test('a send without taskId matches the working task whose origin is this session', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const first = await createTask(alice.sessionToken, { botId: 'a', title: 'Chat one', sessionId: 'a' })
  const second = await createTask(alice.sessionToken, { botId: 'a', title: 'Room two', roomId: 'war' })
  for (const id of [first.value.id, second.value.id]) {
    await call('task-accept', { id }, alice.sessionToken)
    await call('task-start', { id }, alice.sessionToken)
  }
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'from the room', meta: { hold: true, roomId: 'war' } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'working')
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'blocked')
})

test('a result-ready task is not pruned while it waits for acceptance', async (t) => {
  const { call, signIn, createTask, stop, home } = await start(t)
  const alice = await signIn('Alice')
  const created = await createTask(alice.sessionToken)
  const task = created.value
  await call('task-accept', { id: task.id }, alice.sessionToken)
  await call('task-start', { id: task.id }, alice.sessionToken)
  await call('task-return', { id: task.id, summary: 'waiting' }, alice.sessionToken)
  await stop({ keepHome: true })
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  for (let i = 0; i < 200; i++) {
    const id = `task-old${i.toString(16).padStart(8, '0')}deadbeef`
    saved.tasks[id] = {
      id, status: 'cancelled', createdAt: 1, updatedAt: i + 2,
      requesterId: alice.memberId, ownerBotId: 'a', title: 'old', origin: {}, actors: [],
    }
  }
  saved.tasks[task.id].updatedAt = 1
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const again = await start(t, { home })
  t.after(() => again.stop())
  const extra = await again.createTask(alice.sessionToken, { title: 'new' })
  assert.equal(extra.ok, true, JSON.stringify(extra))
  const waiting = await statusOf(again.call, alice.sessionToken, task.id)
  assert.ok(waiting, 'the result-ready task is still listed')
  assert.equal(waiting.status, 'result-ready', JSON.stringify(waiting))
})

test('a grantee may create a task on a granted child, not on an ungranted sibling', async (t) => {
  const { fb, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  const bob = await signIn('Bob', alice.sessionToken)
  await fb.grants.set('s', [{ grantee: bob.memberId }])
  const onGranted = await createTask(bob.sessionToken, { botId: 's', title: 'Draft Bob\'s note' })
  assert.equal(onGranted.ok, true, JSON.stringify(onGranted))
  assert.equal(onGranted.value.requesterId, bob.memberId)
  assert.equal(onGranted.value.ownerBotId, 's')
  const onUngranted = await createTask(bob.sessionToken, { botId: 'a', title: 'Use the Chief' })
  assert.equal(onUngranted.ok, false, JSON.stringify(onUngranted))
  assert.equal(onUngranted.error.code, 'bot/forbidden')
})

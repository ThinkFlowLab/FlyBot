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

async function returnTask(call, createTask, token) {
  const created = await createTask(token)
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.value.id
  for (const endpoint of ['task-accept', 'task-start']) {
    const moved = await call(endpoint, { id }, token)
    assert.equal(moved.ok, true, JSON.stringify(moved))
  }
  const returned = await call('task-return', { id, summary: 'Returned evidence awaiting a decision' }, token)
  assert.equal(returned.ok, true, JSON.stringify(returned))
  return returned.value
}

test('the requester can cancel a returned result after restart without losing its evidence', async (t) => {
  const first = await start(t)
  let app = first
  t.after(() => app.stop())
  const alice = await first.signIn('Alice')
  const returned = await returnTask(first.call, first.createTask, alice.sessionToken)
  await first.stop({ keepHome: true })
  const restored = await start(t, { home: first.home })
  app = restored
  const cancelled = await restored.call('task-cancel', { id: returned.id }, alice.sessionToken)
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal(cancelled.value.status, 'cancelled')
  assert.deepEqual(cancelled.value.result, returned.result)
  assert.deepEqual(cancelled.value.actors.slice(0, -1), returned.actors)
  assert.equal(cancelled.value.actors.at(-1).status, 'cancelled')
  assert.equal(cancelled.value.actors.at(-1).memberId, alice.memberId)
  await restored.stop({ keepHome: true })
  const again = await start(t, { home: first.home })
  app = again
  const saved = await statusOf(again.call, alice.sessionToken, returned.id)
  assert.equal(saved.status, 'cancelled')
  assert.deepEqual(saved.result, returned.result)
  for (const endpoint of ['task-accept-result', 'task-accept', 'task-start', 'task-return', 'task-cancel']) {
    const late = await again.call(endpoint, { id: returned.id, summary: 'late result' }, alice.sessionToken)
    assert.equal(late.ok, false, `${endpoint}: ${JSON.stringify(late)}`)
    assert.equal(late.error.code, 'bot/stale')
  }
})

test('returned-result cancellation keeps requester authority despite forged body claims', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const bob = await app.signIn('Bob', alice.sessionToken)
  const returned = await returnTask(app.call, app.createTask, alice.sessionToken)
  for (const token of [bob.sessionToken, undefined]) {
    const refused = await app.call('task-cancel', { id: returned.id, actorId: alice.memberId, requesterId: alice.memberId }, token)
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, token ? 'bot/forbidden' : 'bot/unauthorized')
    assert.equal((await statusOf(app.call, alice.sessionToken, returned.id)).status, 'result-ready')
  }
  const accepted = await app.call('task-accept-result', { id: returned.id }, alice.sessionToken)
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  const afterAcceptance = await app.call('task-cancel', { id: returned.id }, alice.sessionToken)
  assert.equal(afterAcceptance.ok, false)
  assert.equal(afterAcceptance.error.code, 'bot/stale')
})

test('the requester, rather than the assigned Bot owner, decides whether to cancel a returned result', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const bob = await app.signIn('Bob', alice.sessionToken)
  await app.fb.grants.set('s', [{ grantee: bob.memberId }])
  const returned = await returnTask(app.call, token => app.createTask(token, { botId: 's' }), bob.sessionToken)
  assert.equal(returned.requesterId, bob.memberId)
  const foreign = await app.call('task-cancel', { id: returned.id }, alice.sessionToken)
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error.code, 'bot/forbidden')
  const cancelled = await app.call('task-cancel', { id: returned.id }, bob.sessionToken)
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal(cancelled.value.status, 'cancelled')
  assert.equal(cancelled.value.actors.at(-1).memberId, bob.memberId)
})

test('a revoked requester session cannot cancel its returned result', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const returned = await returnTask(app.call, app.createTask, alice.sessionToken)
  const revoked = await app.call('auth-revoke', {}, alice.sessionToken)
  assert.equal(revoked.ok, true, JSON.stringify(revoked))
  const refused = await app.call('task-cancel', { id: returned.id, actorId: alice.memberId }, alice.sessionToken)
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/unauthorized')
  const saved = JSON.parse(readFileSync(app.statePath, 'utf8')).tasks[returned.id]
  assert.equal(saved.status, 'result-ready')
  assert.deepEqual(saved.result, returned.result)
})

test('acceptance racing returned-result cancellation commits only one terminal outcome', async (t) => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const returned = await returnTask(app.call, app.createTask, alice.sessionToken)
  const outcomes = await Promise.all(['task-accept-result', 'task-cancel'].map(endpoint => app.call(endpoint, { id: returned.id }, alice.sessionToken)))
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1)
  assert.equal(outcomes.find(outcome => !outcome.ok).error.code, 'bot/stale')
  const task = await statusOf(app.call, alice.sessionToken, returned.id)
  assert.ok(['accepted', 'cancelled'].includes(task.status))
  assert.equal(task.actors.length, returned.actors.length + 1)
  assert.deepEqual(task.result, returned.result)
})

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

test('two tasks started in the same millisecond still order by their start (#549)', async (t) => {
  const { fb, call, signIn, createTask } = await start(t)
  const alice = await signIn('Alice')
  // Freeze the clock at the value the session was signed in at, so both starts share one
  // millisecond: the tie that made the other test fail 1 run in 6 must not reorder them.
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  let first, second
  try {
    first = await createTask(alice.sessionToken, { botId: 'a', title: 'Tie one' })
    second = await createTask(alice.sessionToken, { botId: 'a', title: 'Tie two' })
    for (const id of [first.value.id, second.value.id]) {
      await call('task-accept', { id }, alice.sessionToken)
      await call('task-start', { id }, alice.sessionToken)
    }
  } finally { Date.now = realNow }
  fb.bot.send.use({ name: 'gate', handle: async msg => (msg.meta?.hold ? { action: 'hold', reason: 'held by test' } : undefined) })
  const held = await fb.bot.send({ from: 'a', to: 's', text: 'untagged send', meta: { hold: true } })
  assert.equal(held.action, 'hold', JSON.stringify(held))
  assert.equal((await statusOf(call, alice.sessionToken, second.value.id)).status, 'blocked', 'the later start owns the untagged hold')
  assert.equal((await statusOf(call, alice.sessionToken, first.value.id)).status, 'working')
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

test('restored input holds keep Bot-owner approval distinct from the task requester answer', async t => {
  let app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const bob = await app.signIn('Bob', alice.sessionToken)
  await app.fb.grants.set('s', [{ grantee: bob.memberId }])
  const id = await workingInputTask(app, bob.sessionToken, 's')
  const waiting = await app.call('task-wait-input', { id, question: 'Question for requester' }, bob.sessionToken)
  assert.equal(waiting.ok, true, JSON.stringify(waiting))
  const questionId = waiting.value.inputRequest.id
  const gate = () => app.fb.bot.send.use({ name: 'input-gate', handle: msg => msg.meta?.hold ? { action: 'hold', reason: 'test approval' } : undefined })
  gate()
  const held = await app.fb.bot.send({ from: 's', to: 'a', text: 'held', meta: { hold: true, taskId: id } })
  assert.equal(held.action, 'hold')
  const home = app.home
  await app.stop({ keepHome: true })
  app = await start(t, { home })
  gate()
  assert.deepEqual((await statusOf(app.call, bob.sessionToken, id)).inputApprovalIds, [held.approvalId])
  const wrongDecision = await app.call('flybot/decide', { id: held.approvalId, decision: 'approve' }, bob.sessionToken)
  assert.equal(wrongDecision.ok, false)
  assert.equal(wrongDecision.error.code, 'bot/forbidden')
  const early = await app.call('task-answer-input', { id, questionId, answer: 'Early answer' }, bob.sessionToken)
  assert.equal(early.ok, false)
  assert.equal(early.error.code, 'bot/stale')
  assert.equal((await app.call('flybot/decide', { id: held.approvalId, decision: 'approve' }, alice.sessionToken)).ok, true)
  const wrongAnswer = await app.call('task-answer-input', { id, questionId, answer: 'Bot owner answer', actorId: bob.memberId }, alice.sessionToken)
  assert.equal(wrongAnswer.ok, false)
  assert.equal(wrongAnswer.error.code, 'bot/forbidden')
  const answer = await app.call('task-answer-input', { id, questionId, answer: 'Requester answer' }, bob.sessionToken)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(answer.value.status, 'working')
})

test('racing input requests and duplicate answers record one question and one answer', async t => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const id = await workingInputTask(app, alice.sessionToken)
  const before = await statusOf(app.call, alice.sessionToken, id)
  const requests = await Promise.all(['First question', 'Second question'].map(question => app.call('task-wait-input', { id, question }, alice.sessionToken)))
  assert.equal(requests.filter(r => r.ok).length, 1)
  assert.equal(requests.find(r => !r.ok).error.code, 'bot/stale')
  const questionId = requests.find(r => r.ok).value.inputRequest.id
  const answers = await Promise.all(['First answer', 'Second answer'].map(answer => app.call('task-answer-input', { id, questionId, answer }, alice.sessionToken)))
  assert.equal(answers.filter(r => r.ok).length, 1)
  assert.equal(answers.find(r => !r.ok).error.code, 'bot/stale')
  const after = await statusOf(app.call, alice.sessionToken, id)
  assert.equal(after.actors.length, before.actors.length + 2)
  assert.equal(after.status, 'working')
})

async function workingInputTask(app, token, botId = 'a') {
  const made = await app.createTask(token, { botId })
  assert.equal(made.ok, true, JSON.stringify(made))
  for (const endpoint of ['task-accept', 'task-start']) {
    assert.equal((await app.call(endpoint, { id: made.value.id }, token)).ok, true)
  }
  return made.value.id
}

test('task input waits survive restart, accept only the current question, and dispatch no prompt', async t => {
  let app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const id = await workingInputTask(app, alice.sessionToken)
  const waiting = await app.call('task-wait-input', { id, question: 'Must retries stop after cancellation?' }, alice.sessionToken)
  assert.equal(waiting.ok, true, JSON.stringify(waiting))
  assert.equal(waiting.value.status, 'blocked')
  assert.equal(waiting.value.waitingFor, 'input')
  const bypass = await app.call('task-start', { id }, alice.sessionToken)
  assert.equal(bypass.ok, false)
  assert.equal(bypass.error.code, 'bot/stale')
  const questionId = waiting.value.inputRequest.id
  assert.match(questionId, /^input-[0-9a-f]{16}$/)
  const home = app.home
  await app.stop({ keepHome: true })
  app = await start(t, { home })
  assert.deepEqual((await statusOf(app.call, alice.sessionToken, id)).inputRequest, waiting.value.inputRequest)
  const calls = app.agentOf('a').calls.length
  const answer = await app.call('task-answer-input', { id, questionId, answer: 'Yes, before each retry.' }, alice.sessionToken)
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(answer.value.status, 'working')
  assert.equal(answer.value.waitingFor, undefined)
  assert.equal(answer.value.inputRequest.answer, 'Yes, before each retry.')
  assert.equal(answer.value.actors.at(-1).questionId, questionId)
  assert.equal(app.agentOf('a').calls.length, calls)
  await app.stop({ keepHome: true })
  app = await start(t, { home })
  assert.deepEqual((await statusOf(app.call, alice.sessionToken, id)).inputRequest, answer.value.inputRequest)
  const next = await app.call('task-wait-input', { id, question: 'How many attempts?' }, alice.sessionToken)
  assert.equal(next.ok, true)
  assert.notEqual(next.value.inputRequest.id, questionId)
  assert.equal(next.value.inputRequest.answer, undefined)
  const stale = await app.call('task-answer-input', { id, questionId, answer: 'Old answer' }, alice.sessionToken)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'bot/stale')
  const cancelled = await app.call('task-cancel', { id }, alice.sessionToken)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.value.waitingFor, undefined)
  assert.equal(cancelled.value.inputRequest.question, 'How many attempts?')
  const late = await app.call('task-answer-input', { id, questionId: next.value.inputRequest.id, answer: 'Late' }, alice.sessionToken)
  assert.equal(late.ok, false)
  assert.equal(late.error.code, 'bot/stale')
})

test('input actions reject forged/wrong/revoked actors and invalid selected text', async t => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const bob = await app.signIn('Bob', alice.sessionToken)
  const id = await workingInputTask(app, alice.sessionToken)
  for (const token of [bob.sessionToken, undefined]) {
    const denied = await app.call('task-wait-input', { id, question: 'Question', actorId: alice.memberId }, token)
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, token ? 'bot/forbidden' : 'bot/unauthorized')
  }
  for (const question of ['', '   ', null, 123, 'x'.repeat(2001)]) {
    const invalid = await app.call('task-wait-input', { id, question }, alice.sessionToken)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error.code, 'bot/invalid')
    assert.equal((await statusOf(app.call, alice.sessionToken, id)).status, 'working')
  }
  const waiting = await app.call('task-wait-input', { id, question: 'Question' }, alice.sessionToken)
  const questionId = waiting.value.inputRequest.id
  const foreign = await app.call('task-answer-input', { id, questionId, answer: 'Forged', requesterId: alice.memberId, actorId: alice.memberId }, bob.sessionToken)
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error.code, 'bot/forbidden')
  for (const answer of ['', '  ', null, 123, 'x'.repeat(2001)]) {
    const invalid = await app.call('task-answer-input', { id, questionId, answer }, alice.sessionToken)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error.code, 'bot/invalid')
  }
  await app.call('auth-revoke', {}, alice.sessionToken)
  const revoked = await app.call('task-answer-input', { id, questionId, answer: 'Revoked' }, alice.sessionToken)
  assert.equal(revoked.ok, false)
  assert.equal(revoked.error.code, 'bot/unauthorized')
})

test('input actions cannot replace or clear an approval-only task wait', async t => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const id = await workingInputTask(app, alice.sessionToken)
  app.fb.bot.send.use({ name: 'input-gate', handle: msg => msg.meta?.hold ? { action: 'hold', reason: 'test approval' } : undefined })
  const held = await app.fb.bot.send({ from: 'a', to: 's', text: 'held', meta: { hold: true, taskId: id } })
  assert.equal(held.action, 'hold')
  for (const [endpoint, body] of [['task-start', {}], ['task-wait-input', { question: 'Question' }], ['task-answer-input', { questionId: 'invented', answer: 'Answer' }]]) {
    const denied = await app.call(endpoint, { id, ...body }, alice.sessionToken)
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'bot/stale')
  }
  assert.equal(app.fb.approvals.get(held.approvalId).status, 'pending')
  assert.equal((await statusOf(app.call, alice.sessionToken, id)).approvalId, held.approvalId)
})

test('all holds during an input wait stay on that task; approval does not answer its question', async t => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const id = await workingInputTask(app, alice.sessionToken)
  const sibling = await workingInputTask(app, alice.sessionToken)
  const waiting = await app.call('task-wait-input', { id, question: 'Which retry limit?' }, alice.sessionToken)
  assert.equal(waiting.ok, true, JSON.stringify(waiting))
  const questionId = waiting.value.inputRequest.id
  app.fb.bot.send.use({ name: 'input-gate', handle: msg => msg.meta?.hold ? { action: 'hold', reason: 'test approval' } : undefined })
  const holds = []
  for (const text of ['first held send', 'second held send']) {
    const held = await app.fb.bot.send({ from: 'a', to: 's', text, meta: { hold: true, taskId: id } })
    assert.equal(held.action, 'hold')
    holds.push(held.approvalId)
  }
  assert.deepEqual((await statusOf(app.call, alice.sessionToken, id)).inputApprovalIds, holds)
  assert.equal((await statusOf(app.call, alice.sessionToken, sibling)).status, 'working')
  for (const approvalId of holds) {
    const denied = await app.call('task-answer-input', { id, questionId, answer: 'Three' }, alice.sessionToken)
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'bot/stale')
    const approved = await app.call('flybot/decide', { id: approvalId, decision: 'approve' }, alice.sessionToken)
    assert.equal(approved.ok, true, JSON.stringify(approved))
    assert.equal((await statusOf(app.call, alice.sessionToken, id)).status, 'blocked')
  }
  const resumed = await app.call('task-answer-input', { id, questionId, answer: 'Three' }, alice.sessionToken)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.value.status, 'working')
  assert.equal(resumed.value.approvalId, undefined)
  assert.equal(resumed.value.inputApprovalIds, undefined)
})

test('approval rejection and Bot deletion end input waits; late answers cannot revive them', async t => {
  const app = await start(t)
  t.after(() => app.stop())
  const alice = await app.signIn('Alice')
  const id = await workingInputTask(app, alice.sessionToken)
  const waiting = await app.call('task-wait-input', { id, question: 'Question' }, alice.sessionToken)
  assert.equal(waiting.ok, true, JSON.stringify(waiting))
  app.fb.bot.send.use({ name: 'input-gate', handle: msg => msg.meta?.hold ? { action: 'hold', reason: 'test approval' } : undefined })
  const held = await app.fb.bot.send({ from: 'a', to: 's', text: 'held', meta: { hold: true, taskId: id } })
  assert.equal((await app.call('flybot/decide', { id: held.approvalId, decision: 'reject' }, alice.sessionToken)).ok, true)
  const cancelled = await statusOf(app.call, alice.sessionToken, id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.waitingFor, undefined)
  const other = await workingInputTask(app, alice.sessionToken, 's')
  const question = await app.call('task-wait-input', { id: other, question: 'Another question' }, alice.sessionToken)
  assert.equal(question.ok, true)
  assert.equal((await app.call('delete-bot', { id: 's' }, alice.sessionToken)).ok, true)
  assert.equal((await statusOf(app.call, alice.sessionToken, other)).status, 'failed')
  for (const [taskId, q] of [[id, waiting.value.inputRequest.id], [other, question.value.inputRequest.id]]) {
    const late = await app.call('task-answer-input', { id: taskId, questionId: q, answer: 'Late' }, alice.sessionToken)
    assert.equal(late.ok, false)
    assert.equal(late.error.code, 'bot/stale')
  }
})

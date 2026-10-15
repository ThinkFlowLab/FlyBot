import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installAuthz } from '../src/host/authz.js'

// Owner-scoped access (#49): default-deny for the /api/bot channel once a member
// session exists. Shared deployment resources are blocked while more than one
// member is signed in. Before any session the legacy single-human path is free.

function runtime(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-authz-'))
  const statePath = join(dir, 'state.json')
  if (saved !== undefined) writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  installStore(rt)
  installMemberAuth(rt)
  installAuthz(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, statePath }
}

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['m1'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'm1' } },
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function redeemOwner(rt) {
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  assert.equal(typeof invite.token, 'string')
  return rt.redeemInvitation(invite.token)
}

test('unenforced allows everything', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  assert.equal(rt.authzEnforced(), false)
  assert.equal(rt.authorize(null, 'update-bot', { id: 'm1' }).ok, true)
})

test('owner cannot touch another owner Bot or room', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  assert.equal(sessionA.ok, true)
  const sessionB = await redeemOwner(rt)
  assert.equal(sessionB.ok, true)
  assert.equal(sessionB.memberId, 'owner-2')

  rt.state.bots.a1 = { id: 'a1', sessionId: 'a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' }
  rt.state.bots.b1 = { id: 'b1', sessionId: 'b1', name: 'B', instructions: '', createdAt: 3, ownerId: 'owner-2' }
  rt.state.rooms.ra = { id: 'ra', name: 'RA', members: ['a1'], admin: null }
  rt.state.rooms.rb = { id: 'rb', name: 'RB', members: ['b1'], admin: null }

  const actorA = await rt.authenticate(sessionA.sessionToken)
  assert.ok(actorA)
  assert.equal(actorA.memberId, 'owner-1')
  assert.equal(rt.authorize(actorA, 'update-bot', { id: 'a1' }).ok, true)

  for (const ep of ['update-bot', 'delete-bot', 'memory-view', 'memory-forget', 'set-flags']) {
    const gate = rt.authorize(actorA, ep, { id: 'b1' })
    assert.equal(gate.ok, false, ep)
    assert.equal(gate.code, 'bot/forbidden', ep)
  }

  const sendGate = rt.authorize(actorA, 'send', { sessionId: 'b1' })
  assert.equal(sendGate.ok, false)
  assert.equal(sendGate.code, 'bot/forbidden')

  for (const ep of ['delete-room', 'update-room']) {
    const gate = rt.authorize(actorA, ep, { id: 'rb' })
    assert.equal(gate.ok, false, ep)
    assert.equal(gate.code, 'bot/forbidden', ep)
  }

  const mixed = rt.authorize(actorA, 'create-room', { members: ['a1', 'b1'] })
  assert.equal(mixed.ok, false)
  assert.equal(mixed.code, 'bot/forbidden')

  assert.equal(rt.authorize(actorA, 'create-room', { members: ['a1'] }).ok, true)
})

test('no actor when enforced', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  await redeemOwner(rt)
  await redeemOwner(rt)
  assert.equal(rt.authzEnforced(), true)

  const gate = rt.authorize(null, 'update-bot', { id: 'a1' })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'bot/unauthorized')
  assert.equal(rt.authorize(null, 'auth-redeem', {}).ok, true)
  assert.equal(rt.authorize(null, 'auth-whoami', {}).ok, true)
})

test('forged actorId ignored', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  await redeemOwner(rt)
  rt.state.bots.a1 = { id: 'a1', sessionId: 'a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' }
  rt.state.bots.b1 = { id: 'b1', sessionId: 'b1', name: 'B', instructions: '', createdAt: 3, ownerId: 'owner-2' }
  const actorA = await rt.authenticate(sessionA.sessionToken)
  const gate = rt.authorize(actorA, 'update-bot', { id: 'b1', actorId: 'owner-2' })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'bot/forbidden')
})

test('shared resources blocked with two members', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  await redeemOwner(rt)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  for (const ep of ['secret-set', 'connector-connect', 'folders', 'set-prefs', 'diagnostics-log']) {
    const gate = rt.authorize(actorA, ep, {})
    assert.equal(gate.ok, false, ep)
    assert.equal(gate.code, 'bot/blocked-shared', ep)
  }
})

test('shared resources allowed with a single member', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  assert.equal(rt.authzEnforced(), true)
  assert.equal(Object.keys(rt.state.members).length, 1)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  assert.equal(rt.authorize(actorA, 'secret-set', {}).ok, true)
  assert.equal(rt.authorize(actorA, 'folders', {}).ok, true)
})

test('unknown endpoint denied when enforced', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  const gate = rt.authorize(actorA, 'not-a-real-endpoint', {})
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'bot/not-found')
})

// A session may be the Bot's id, its current chat Session, a group Session or an
// earlier part: each resolves to its Bot or room, and the owner reaches it.
test('a member reaches their own Bots sessions, groups and schedules', async (t) => {
  const { rt } = runtime(t, {
    ...TEAM,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1' },
      a1: { id: 'a1', sessionId: 'chat-a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' },
    },
    rooms: { ra: { id: 'ra', name: 'RA', members: ['a1'], admin: null, sessions: { a1: 'gs-a1' } } },
  })
  await rt.load()
  const session = await redeemOwner(rt)
  const actor = await rt.authenticate(session.sessionToken)
  assert.equal(rt.authzEnforced(), true)
  assert.equal(Object.keys(rt.state.members).length, 1)

  assert.equal(rt.authorize(actor, 'send', { sessionId: 'a1' }).ok, true)
  assert.equal(rt.authorize(actor, 'send', { sessionId: 'chat-a1' }).ok, true)
  assert.equal(rt.authorize(actor, 'earlier', { sessionId: 'chat-a1' }).ok, true)
  assert.equal(rt.authorize(actor, 'answer-question', { sessionId: 'chat-a1' }).ok, true)
  assert.equal(rt.authorize(actor, 'schedules', { sessionId: 'chat-a1' }).ok, true)
  // A group Session follows its room's rule; so does a schedule on it.
  assert.equal(rt.authorize(actor, 'send', { sessionId: 'gs-a1' }).ok, true)
  assert.equal(rt.authorize(actor, 'schedule-create', { sessionId: 'gs-a1' }).ok, true)
})

test('approval-answer resolves the approval, not caller-chosen fields', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  await redeemOwner(rt)
  rt.state.bots.a1 = { id: 'a1', sessionId: 'a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' }
  rt.state.bots.b1 = { id: 'b1', sessionId: 'b1', name: 'B', instructions: '', createdAt: 3, ownerId: 'owner-2' }
  rt.approvalsView = () => [
    { id: 'ap-own', sessionId: 'a1', botId: 'a1' },
    { id: 'ap-other', sessionId: 'b1', botId: 'b1' },
  ]
  const actorA = await rt.authenticate(sessionA.sessionToken)
  // The client answers by approval id alone.
  assert.equal(rt.authorize(actorA, 'approval-answer', { id: 'ap-own', choice: 'approve' }).ok, true)
  assert.equal(rt.authorize(actorA, 'approval-answer', { id: 'ap-other', choice: 'approve' }).ok, false)
  assert.equal(rt.authorize(actorA, 'approval-answer', { id: 'nope', choice: 'approve' }).ok, false)
  // Pairing own fields with someone else's approval id must not pass either.
  assert.equal(rt.authorize(actorA, 'approval-answer', { id: 'ap-other', sessionId: 'a1', choice: 'approve' }).ok, false)
})

test('flybot plugin endpoints follow the read/shared rules', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  rt.flybotIsRead = name => name === 'changes'
  const sessionA = await redeemOwner(rt)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  // Reads reach the plugin layer for the signed-in actor.
  assert.equal(rt.authorize(actorA, 'flybot/changes', {}).ok, true)
  // Alone on the deployment, writes do too. Deciding a held send stays reachable with
  // two members: hooks.js binds it to the sender Bot's owner (#52); other plugin
  // writes are blocked like the other shared resources.
  assert.equal(rt.authorize(actorA, 'flybot/decide', { id: 'x' }).ok, true)
  await redeemOwner(rt)
  assert.equal(rt.authorize(actorA, 'flybot/changes', {}).ok, true)
  assert.equal(rt.authorize(actorA, 'flybot/decide', { id: 'x' }).ok, true)
  assert.equal(rt.authorize(actorA, 'flybot/social/decide-approval', {}).code, 'bot/blocked-shared')
  assert.equal(rt.authorize(null, 'flybot/changes', {}).code, 'bot/unauthorized')
  assert.equal(rt.authorize(null, 'flybot/decide', { id: 'x' }).code, 'bot/unauthorized')
})

test('add-agent is a shared deployment resource', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  assert.equal(rt.authorize(actorA, 'add-agent', {}).ok, true)
  await redeemOwner(rt)
  assert.equal(rt.authorize(actorA, 'add-agent', {}).code, 'bot/blocked-shared')
})

test('create-room needs at least one member Bot', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const sessionA = await redeemOwner(rt)
  const actorA = await rt.authenticate(sessionA.sessionToken)
  rt.state.bots.a1 = { id: 'a1', sessionId: 'a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' }
  assert.equal(rt.authorize(actorA, 'create-room', { members: [] }).ok, false)
  assert.equal(rt.authorize(actorA, 'create-room', { members: ['a1'] }).ok, true)
})

test('views keep the sole owner whole and narrow per owner with two members', async (t) => {
  const { rt } = runtime(t, {
    ...TEAM,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1' },
      a1: { id: 'a1', sessionId: 'chat-a1', name: 'A', instructions: '', createdAt: 2, ownerId: 'owner-1' },
    },
  })
  await rt.load()
  const fullView = {
    bots: Object.values(rt.state.bots),
    rooms: [],
    questions: { 'chat-a1': { q: 1 } },
    exchangeTurns: { 'chat-a1': [1] },
    agents: [{ id: 'ag1' }],
    secrets: [{ name: 'k' }],
    secretRequests: { r: {} },
  }
  const fullLive = {
    activity: { a1: 'busy', b1: 'idle' },
    work: { bots: { a1: {}, b1: {} }, rooms: {}, approvals: [{ botId: 'a1' }, { botId: 'b1' }] },
    memoryNews: { a1: 1, b1: 2 },
    memoryReviews: 3,
    connectors: [{ id: 'c' }],
    capabilityStatuses: { a1: {} },
  }
  const solo = await rt.authenticate((await redeemOwner(rt)).sessionToken)
  const view1 = rt.ownedView(fullView, solo)
  assert.deepEqual(view1.questions, fullView.questions)
  assert.deepEqual(view1.agents, fullView.agents)
  assert.deepEqual(view1.secrets, fullView.secrets)
  const live1 = rt.ownedLive(fullLive, solo)
  assert.deepEqual(live1.connectors, fullLive.connectors)
  assert.equal(live1.memoryReviews, 3)

  // The second owner arrives the way the product does it: a member record, then their Bot.
  rt.state.members['owner-2'] = { id: 'owner-2', createdAt: 2, designatedChiefId: null }
  rt.state.bots.b1 = { id: 'b1', sessionId: 'chat-b1', name: 'B', instructions: '', createdAt: 3, ownerId: 'owner-2' }
  rt.state.questions['chat-b1'] = { q: 2 }
  await rt.save()
  const view2 = rt.ownedView(fullView, solo)
  assert.deepEqual(view2.bots.map(bot => bot.id), ['m1', 'a1'])
  assert.deepEqual(Object.keys(view2.questions), ['chat-a1'])
  assert.deepEqual(Object.keys(view2.exchangeTurns), ['chat-a1'])
  assert.deepEqual(view2.agents, [])
  assert.deepEqual(view2.secrets, [])
  const live2 = rt.ownedLive(fullLive, solo)
  assert.deepEqual(Object.keys(live2.activity), ['a1'])
  assert.deepEqual(live2.work.approvals.map(entry => entry.botId), ['a1'])
  assert.deepEqual(live2.connectors, [])
  assert.equal(live2.memoryReviews, 0)
})

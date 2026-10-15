import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installAuthz } from '../src/host/authz.js'
import { install as installReach } from '../src/host/reach.js'
import { install as installRooms, currentParticipants, isCrossOwnerRoom, linesVisibleTo, roomVisibleTo } from '../src/host/room-membership.js'
// Room membership (#50): humans and Chiefs share a room with distinct authorship.
// Team mode stays disabled — these tests cover the membership surface only.

function host(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-rooms-'))
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
    dropGroupSession: () => {},
    warn: (...args) => warnings.push(args),
  }
  installStore(rt)
  installMemberAuth(rt)
  installAuthz(rt)
  installRooms(rt)
  installReach(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, statePath }
}

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['chief-a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-a' },
  },
  bots: {
    'chief-a': { id: 'chief-a', sessionId: 'chief-a', name: 'Chief A', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    'chief-b': { id: 'chief-b', sessionId: 'chief-b', name: 'Chief B', instructions: '', createdAt: 2, ownerId: 'owner-1' },
    'spec-a': { id: 'spec-a', sessionId: 'spec-a', name: 'Writer A', instructions: '', createdAt: 3, ownerId: 'owner-1' },
    'spec-b': { id: 'spec-b', sessionId: 'spec-b', name: 'Writer B', instructions: '', createdAt: 4, ownerId: 'owner-1' },
  },
  rooms: {
    shared: {
      id: 'shared',
      name: 'War room',
      members: ['chief-a', 'chief-b'],
      admin: 'chief-a',
      named: true,
      log: [],
      seq: 0,
      seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'human', id: 'owner-2', role: 'member', displayName: 'Bob', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief-a', role: 'admin', displayName: 'Chief A', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief-b', role: 'member', displayName: 'Chief B', joinedSeq: 0, joinedAt: 1 },
      ],
    },
    private: {
      id: 'private',
      name: 'Alice and Writer',
      members: ['chief-a', 'spec-a'],
      admin: 'chief-a',
      named: true,
      log: [{ who: 'User', text: 'private hello', seq: 1 }],
      seq: 1,
      seen: {},
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function signIn(rt, name) {
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  return rt.redeemInvitation(invite.token, { displayName: name })
}

async function signAliceAndBob(rt) {
  const alice = await signIn(rt, 'Alice')
  const bob = await signIn(rt, 'Bob')
  const memberId = bob.memberId
  rt.state.members[memberId].designatedChiefId = 'chief-b'
  rt.state.bots['chief-b'].ownerId = memberId
  rt.state.bots['spec-b'].ownerId = memberId
  return { alice, bob }
}

test('Alice, Bob and both Chiefs keep distinct authorship', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  assert.equal(actorA.memberId, 'owner-1')
  assert.equal(actorB.memberId, bob.memberId)

  const a1 = await rt.postRoomMessage('shared', { text: 'from Alice' }, actorA)
  const b1 = await rt.postRoomMessage('shared', { text: 'from Bob' }, actorB)
  const c1 = await rt.postRoomMessage('shared', { text: 'from Chief A', authorId: 'chief-a', authorKind: 'bot' })
  const c2 = await rt.postRoomMessage('shared', { text: 'from Chief B', authorId: 'chief-b', authorKind: 'bot' })

  assert.deepEqual([a1.authorId, a1.authorKind, a1.who], ['owner-1', 'human', 'Alice'])
  assert.deepEqual([b1.authorId, b1.authorKind, b1.who], ['owner-2', 'human', 'Bob'])
  assert.deepEqual([c1.authorId, c1.authorKind, c1.who], ['chief-a', 'bot', 'Chief A'])
  assert.deepEqual([c2.authorId, c2.authorKind, c2.who], ['chief-b', 'bot', 'Chief B'])
  const ids = new Set([a1.authorId, b1.authorId, c1.authorId, c2.authorId])
  assert.equal(ids.size, 4)
  const names = currentParticipants(rt.state.rooms.shared).map(p => p.displayName).sort()
  assert.deepEqual(names, ['Alice', 'Bob', 'Chief A', 'Chief B'])
})

test('concurrent posts keep order and identity', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  const [first, second] = await Promise.all([
    rt.postRoomMessage('shared', { text: 'A-concurrent' }, actorA),
    rt.postRoomMessage('shared', { text: 'B-concurrent' }, actorB),
  ])
  assert.notEqual(first.seq, second.seq)
  assert.notEqual(first.authorId, second.authorId)
  assert.equal(new Set([first.authorId, second.authorId]).size, 2)
  const log = rt.state.rooms.shared.log.filter(line => line.text?.includes('concurrent'))
  assert.equal(log.length, 2)
  assert.ok(log[0].seq < log[1].seq)
  assert.notEqual(log[0].authorId, log[1].authorId)
})

test('unauthorized history reads fail', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  assert.throws(() => rt.roomHistory('private', actorB), /not a member/)
  assert.equal(roomVisibleTo(rt.state, actorB, 'private'), false)
  const privateLines = rt.roomHistory('private', actorA)
  assert.equal(privateLines.some(line => line.text === 'private hello'), true)
  const outsider = { memberId: 'owner-9', displayName: 'Eve' }
  assert.throws(() => rt.roomHistory('shared', outsider), /not a member/)
})

test('join and leave follow the membership-window history rule', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)

  // Chiefs are already in; Bob the human joins after the first line.
  rt.state.rooms.later = {
    id: 'later',
    name: 'Later',
    members: ['chief-a', 'chief-b'],
    admin: 'chief-a',
    named: true,
    log: [],
    seq: 0,
    seen: {},
    participants: [
      { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
      { kind: 'bot', id: 'chief-a', role: 'admin', displayName: 'Chief A', joinedSeq: 0, joinedAt: 1 },
      { kind: 'bot', id: 'chief-b', role: 'member', displayName: 'Chief B', joinedSeq: 0, joinedAt: 1 },
    ],
  }
  const early = await rt.postRoomMessage('later', { text: 'before Bob' }, actorA)
  assert.equal(early.seq >= 1, true)
  await rt.setGrants('chief-a', [{ grantee: bob.memberId }])
  await rt.setGrants('chief-b', [{ grantee: 'owner-1' }])
  await rt.addRoomParticipant('later', { kind: 'human', id: 'owner-2', displayName: 'Bob' }, actorA)
  const after = await rt.postRoomMessage('later', { text: 'after Bob joined' }, actorA)

  const bobLines = rt.roomHistory('later', actorB)
  assert.equal(bobLines.some(line => line.text === 'before Bob'), false)
  assert.equal(bobLines.some(line => line.text === 'after Bob joined'), true)
  const bobJoin = currentParticipants(rt.state.rooms.later).find(p => p.id === 'owner-2')
  assert.ok(bobJoin.joinedSeq > early.seq)
  assert.ok(after.seq >= bobJoin.joinedSeq)

  await rt.removeRoomParticipant('later', { kind: 'human', id: 'owner-2' }, actorA)
  // Bob's Chief is still in the room: he remains the invited owner and keeps the Chief's window.
  assert.equal(rt.roomHistory('later', actorB).some(line => line.text === 'before Bob'), true)
  await rt.removeRoomParticipant('later', { kind: 'bot', id: 'chief-b' }, actorB)
  assert.throws(() => rt.roomHistory('later', actorB), /not a member/)
  await rt.addRoomParticipant('later', { kind: 'human', id: 'owner-2', displayName: 'Bob' }, actorA)
  const again = rt.roomHistory('later', actorB)
  assert.equal(again.some(line => line.text === 'before Bob'), false)
  assert.equal(again.some(line => line.text === 'after Bob joined'), false)
})

test('non-members cannot inject messages; forged authorId is ignored', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  const eve = { memberId: 'owner-9', displayName: 'Eve' }
  await assert.rejects(() => rt.postRoomMessage('shared', { text: 'pwned' }, eve), /not a member/)
  await assert.rejects(() => rt.postRoomMessage('private', { text: 'pwned' }, actorB), /not a member/)
  const line = await rt.postRoomMessage('shared', { text: 'honest', authorId: 'owner-2', authorKind: 'human', displayName: 'Bob' }, actorA)
  assert.equal(line.authorId, 'owner-1')
  assert.equal(line.who, 'Alice')
})

test('a specialist cannot join a cross-owner room', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await assert.rejects(
    () => rt.addRoomParticipant('shared', { kind: 'bot', id: 'spec-a' }, actorA),
    /Specialists stay/,
  )
  await assert.rejects(
    () => rt.addRoomParticipant('shared', { kind: 'bot', id: 'spec-b' }, actorA),
    /Specialists stay/,
  )
  assert.equal(isCrossOwnerRoom(rt.state.rooms.shared, rt.state), true)
})

test('#90: a granted specialist may join a cross-owner room, and revoking takes it out at once', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const create = { members: ['chief-a', 'spec-b'], participants: [{ kind: 'human', id: 'owner-1' }, { kind: 'human', id: 'owner-2' }, { kind: 'bot', id: 'chief-a' }, { kind: 'bot', id: 'spec-b' }] }
  assert.equal(rt.authorize(actorA, 'create-room', create).ok, false)
  await rt.setGrants('spec-b', [{ grantee: 'owner-1' }])
  await rt.setGrants('chief-a', [{ grantee: 'owner-2' }])
  await rt.setGrants('chief-b', [{ grantee: 'owner-1' }])
  assert.equal(rt.authorize(actorA, 'create-room', create).ok, true)
  await rt.addRoomParticipant('shared', { kind: 'bot', id: 'spec-b' }, actorA)
  assert.equal(rt.state.rooms.shared.members.includes('spec-b'), true)
  // One ungranted member in the room also keeps another specialist out.
  await assert.rejects(() => rt.addRoomParticipant('shared', { kind: 'bot', id: 'spec-a' }, actorA), /Specialists stay|granted/)
  await rt.setGrants('spec-b', [])
  assert.equal(rt.state.rooms.shared.members.includes('spec-b'), false)
  assert.ok(rt.state.rooms.shared.log.some(line => line.kind === 'left' && line.authorId === 'spec-b'))
  // A Chief whose grant is revoked leaves too; the room itself stays.
  await rt.setGrants('chief-b', [])
  assert.equal(rt.state.rooms.shared.members.includes('chief-b'), false)
  assert.ok(rt.state.rooms.shared.participants.some(p => p.kind === 'human' && p.id === 'owner-2' && p.leftSeq === undefined))
})

test('existing single-owner groups still display and accept posts', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const room = rt.state.rooms.private
  assert.equal(room.participants, undefined)
  assert.deepEqual(room.members, ['chief-a', 'spec-a'])
  const line = await rt.postRoomMessage('private', { text: 'still works' }, actorA)
  assert.equal(line.authorId, 'owner-1')
  assert.equal(line.text, 'still works')
  const history = rt.roomHistory('private', actorA)
  assert.ok(history.some(item => item.text === 'private hello'))
  assert.ok(history.some(item => item.text === 'still works'))
  assert.equal(rt.authorize(actorA, 'update-room', { id: 'private', name: 'Still mine' }).ok, true)
  assert.equal(rt.roomOwnedBy(actorA, 'private'), true)
})

test('authz allows a shared room of Chiefs and denies a mixed specialist create', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await rt.setGrants('chief-a', [{ grantee: 'owner-2' }])
  await rt.setGrants('chief-b', [{ grantee: 'owner-1' }])
  const shared = rt.authorize(actorA, 'create-room', {
    members: ['chief-a', 'chief-b'],
    participants: [
      { kind: 'human', id: 'owner-1' },
      { kind: 'human', id: 'owner-2' },
      { kind: 'bot', id: 'chief-a' },
      { kind: 'bot', id: 'chief-b' },
    ],
  })
  assert.equal(shared.ok, true)
  const mixed = rt.authorize(actorA, 'create-room', { members: ['chief-a', 'spec-b'] })
  assert.equal(mixed.ok, false)
  assert.equal(mixed.code, 'bot/forbidden')
  assert.equal(rt.authorize(actorA, 'room-history', { roomId: 'shared' }).ok, true)
  const actorB = await rt.authenticate(bob.sessionToken)
  assert.equal(rt.authorize(actorB, 'room-history', { roomId: 'private' }).ok, false)
  assert.equal(rt.authorize(actorB, 'send', { sessionId: 'shared' }).ok, true)
  assert.equal(rt.authorize(actorB, 'send', { sessionId: 'spec-a' }).ok, false)
})

test('membership-window helper hides lines before joinedSeq', () => {
  const room = {
    id: 'r',
    participants: [{ kind: 'human', id: 'owner-2', role: 'member', displayName: 'Bob', joinedSeq: 4 }],
    log: [
      { seq: 1, text: 'old', who: 'Alice', authorId: 'owner-1', authorKind: 'human' },
      { seq: 4, text: 'join', kind: 'joined', who: 'Bob', authorId: 'owner-2', authorKind: 'human' },
      { seq: 5, text: 'new', who: 'Alice', authorId: 'owner-1', authorKind: 'human' },
    ],
  }
  const actor = { memberId: 'owner-2' }
  const visible = linesVisibleTo(room, actor)
  assert.deepEqual(visible.map(line => line.text), ['join', 'new'])
})

function startChannel(t, team) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-rooms-ch-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const workspaces = new Map()
  let sessions = 0
  const sent = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (req) => { sent.push({ prompt: req }) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload, token) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers['x-flybot-member-session'] = token
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      headers,
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { call, sent, home, rt }
}

test('channel: view lists a shared room for both humans and hides a private room from Bob', async (t) => {
  const { call, rt } = startChannel(t, TEAM)
  const inviteA = (await call('auth-invite', {})).value
  const alice = (await call('auth-redeem', { token: inviteA.token, displayName: 'Alice' })).value
  const inviteB = (await call('auth-invite', {}, alice.sessionToken)).value
  const bob = (await call('auth-redeem', { token: inviteB.token, displayName: 'Bob' })).value
  rt.state.members[bob.memberId].designatedChiefId = 'chief-b'
  rt.state.bots['chief-b'].ownerId = bob.memberId
  rt.state.bots['spec-b'].ownerId = bob.memberId

  const viewA = (await call('state', {}, alice.sessionToken)).value
  const viewB = (await call('state', {}, bob.sessionToken)).value
  assert.equal(viewA.self.memberId, 'owner-1')
  assert.ok(viewA.rooms.some(room => room.id === 'shared'))
  assert.ok(viewA.rooms.some(room => room.id === 'private'))
  assert.ok(viewB.rooms.some(room => room.id === 'shared'))
  assert.equal(viewB.rooms.some(room => room.id === 'private'), false)
  assert.ok(viewA.bots.some(bot => bot.id === 'chief-b'))
  assert.equal(viewA.bots.some(bot => bot.id === 'spec-b'), false)
  assert.equal(viewB.bots.some(bot => bot.id === 'spec-a'), false)

  const histB = await call('room-history', { roomId: 'private' }, bob.sessionToken)
  assert.equal(histB.ok, false)
  assert.equal(histB.error.code, 'bot/forbidden')
  const posted = await call('room-post', { roomId: 'shared', text: 'hello from Alice' }, alice.sessionToken)
  assert.equal(posted.ok, true)
  assert.equal(posted.value.authorId, 'owner-1')
  assert.equal(posted.value.who, 'Alice')
  const inject = await call('room-post', { roomId: 'private', text: 'nope' }, bob.sessionToken)
  assert.equal(inject.ok, false)
})

test('channel: a legacy single-owner create-room still works', async (t) => {
  const { call } = startChannel(t, TEAM)
  const invite = (await call('auth-invite', {})).value
  const alice = (await call('auth-redeem', { token: invite.token, displayName: 'Alice' })).value
  const created = await call('create-room', { members: ['chief-a', 'spec-a'], name: 'Solo' }, alice.sessionToken)
  assert.equal(created.ok, true)
  assert.deepEqual(created.value.members, ['chief-a', 'spec-a'])
  assert.equal(created.value.participants, undefined)
  const view = (await call('state', {}, alice.sessionToken)).value
  assert.ok(view.rooms.some(room => room.name === 'Solo'))
})

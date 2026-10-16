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
import {
  install as installRooms,
  isFaceRoom,
  linesVisibleTo,
  ownsInvitedBot,
  presentRoom,
  publishedRemoteOf,
  roomVisibleTo,
  viewerRole,
} from '../src/host/room-membership.js'
import { install as installReach, reach } from '../src/host/reach.js'
import { remoteBotTitle, sharedRoomTitle } from '../src/shared/remote-label.js'
import { encodeRoomShare, parseRoomShare } from '../src/shared/room-share.js'
import { mentionRows } from '../src/client/at-menu.js'
import { indexRoster } from '../src/client/sources.js'

function host(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-remote-room-'))
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
  const sent = []
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    dropGroupSession: () => {},
    warn: (...args) => warnings.push(args),
    flybotSend: async (msg) => { sent.push(msg); return { action: 'hold' } },
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
  return { rt, sent }
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
    war: {
      id: 'war',
      name: 'War room',
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
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const CODER = {
  handle: '@coder.bob.home',
  name: 'Coder',
  home: '@bob.home',
  homeName: 'Bob',
  owner: 'Bob',
  plugin: 'social',
  remote: true,
}

async function signAliceAndBob(rt) {
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const alice = await rt.redeemInvitation(invite.token, { displayName: 'Alice' })
  const inviteB = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const bob = await rt.redeemInvitation(inviteB.token, { displayName: 'Bob' })
  rt.state.members[bob.memberId].designatedChiefId = 'chief-b'
  rt.state.bots['chief-b'].ownerId = bob.memberId
  rt.state.bots['spec-b'].ownerId = bob.memberId
  return { alice, bob }
}

function publish(rt, list = [CODER]) {
  rt.state.flybot ??= {}
  rt.state.flybot.remote = { social: list }
}

async function grantToFriend(rt, botId, grantee = '@bob.home') {
  const current = rt.grantsOf?.(botId) ?? []
  if (current.some(g => g.grantee === grantee)) return
  await rt.setGrants(botId, [...current, { grantee }])
}

test('remote-label: owner badge and shared-room title', () => {
  assert.equal(remoteBotTitle({ displayName: 'Coder', ownerName: 'Bob', handle: '@coder.bob.home' }), "Coder · Bob's Bot")
  assert.equal(remoteBotTitle({ displayName: 'Chief', ownerName: 'Bob', isChief: true }), "Bob's Chief")
  assert.equal(sharedRoomTitle('Alice'), 'Shared room from Alice')
})

test('unpublished Bot is rejected; published remote joins with owner fields', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await assert.rejects(
    () => rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@ghost.eve.home' }, actorA),
    /granted to you/,
  )
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  assert.equal(publishedRemoteOf(rt.state, '@coder.bob.home').name, 'Coder')
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
  const remote = rt.state.rooms.war.participants.find(p => p.remote)
  assert.equal(remote.handle, '@coder.bob.home')
  assert.equal(remote.ownerName, 'Bob')
  assert.equal(remote.invitedBy, 'owner-1')
  assert.equal(rt.state.rooms.war.members.includes('@coder.bob.home'), false)
  assert.ok(rt.state.rooms.war.log.some(line => line.kind === 'invited'))
})

test('inviter view: remotes are labeled with the owner; other humans see the same', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  await rt.addRoomParticipant('war', { kind: 'human', id: bob.memberId, displayName: 'Bob' }, actorA)
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
  const forAlice = presentRoom(rt.state.rooms.war, actorA, rt.state)
  const forBob = presentRoom(rt.state.rooms.war, actorB, rt.state)
  assert.equal(forAlice.viewerRole, 'member')
  assert.equal(forBob.viewerRole, 'member')
  const coder = forAlice.presentedParticipants.find(p => p.remote)
  assert.equal(coder.label, "Coder · Bob's Bot")
  assert.equal(forBob.presentedParticipants.find(p => p.remote).label, "Coder · Bob's Bot")
})

test('remote owner view: Shared room from inviter; membership window; leave withdraws', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice, bob } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  const actorB = await rt.authenticate(bob.sessionToken)
  // Bob is not a human member — his Chief is invited.
  rt.state.rooms.war.participants = rt.state.rooms.war.participants.filter(p => p.id !== 'chief-b')
  await rt.postRoomMessage('war', { text: 'before invite' }, actorA)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'chief-b' }, actorA)
  assert.equal(ownsInvitedBot(rt.state.rooms.war, actorB, rt.state), true)
  assert.equal(viewerRole(rt.state.rooms.war, actorB, rt.state), 'invited-owner')
  const shown = presentRoom(rt.state.rooms.war, actorB, rt.state)
  assert.equal(shown.displayName, 'Shared room from Alice')
  assert.equal(shown.sharedFrom.inviterName, 'Alice')
  assert.equal(shown.inviteNotice, true)
  const history = rt.roomHistory('war', actorB)
  assert.equal(history.some(line => line.text === 'before invite'), false)
  assert.ok(history.some(line => line.kind === 'joined' || line.authorId === 'chief-b'))
  await rt.removeRoomParticipant('war', { kind: 'bot', id: 'chief-b' }, actorB)
  assert.equal(roomVisibleTo(rt.state, actorB, 'war'), false)
  assert.throws(() => rt.roomHistory('war', actorB), /not a member/)
  await assert.rejects(() => rt.postRoomMessage('war', { text: 'nope' }, actorB), /not a member/)
})

test('removed remote cannot read or post; forged identity is ignored', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
  await rt.postRoomMessage('war', { text: 'hi coder', authorId: '@ghost.eve.home', authorKind: 'bot', displayName: 'Eve' }, actorA)
  const last = rt.state.rooms.war.log.at(-1)
  assert.equal(last.authorId, 'owner-1')
  assert.equal(last.who, 'Alice')
  await rt.removeRoomParticipant('war', { kind: 'bot', id: '@coder.bob.home' }, actorA)
  await assert.rejects(
    () => rt.postRoomMessage('war', { text: 'back', authorId: '@coder.bob.home', authorKind: 'bot' }),
    /not a member/,
  )
})

test('inbound shared room is the remote-owner projection', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { bob } = await signAliceAndBob(rt)
  const actorB = await rt.authenticate(bob.sessionToken)
  const room = await rt.recordInboundSharedRoom({
    id: 'from-alice',
    name: 'War room',
    inviterName: 'Alice',
    inviterHome: '@alice.home',
    invitedHandle: '@coder.bob.home',
    localBotId: 'spec-b',
    joinedSeq: 3,
    log: [
      { seq: 1, text: 'secret', authorId: 'alice', authorKind: 'human' },
      { seq: 3, text: 'welcome', kind: 'joined', authorId: 'spec-b', authorKind: 'bot' },
      { seq: 4, text: 'hello', authorId: 'alice', authorKind: 'human' },
    ],
  }, actorB)
  assert.equal(room.origin, 'inbound-share')
  assert.equal(viewerRole(room, actorB, rt.state), 'invited-owner')
  const shown = presentRoom(rt.state.rooms['from-alice'], actorB, rt.state)
  assert.equal(shown.displayName, 'Shared room from Alice')
  const visible = linesVisibleTo(rt.state.rooms['from-alice'], actorB, rt.state)
  assert.deepEqual(visible.map(line => line.text), ['welcome', 'hello'])
  assert.equal(rt.roomHistory('from-alice', actorB).some(line => line.text === 'secret'), false)
})

test('face-to-face room hosts room-only remotes and skips friend fanout', async (t) => {
  const { rt, sent } = host(t, TEAM)
  await rt.load()
  const room = await rt.upsertFaceRoom({
    roomId: 'frm_1',
    localId: 'face-1',
    status: 'candidate',
    expiresAt: '2026-10-15T10:10:00.000Z',
    members: [
      { handle: '@writer.alice.home', displayName: 'Writer', ownerName: 'Alice', published: false },
      { handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob', published: false, color: 'green', avatar: { image: 'https://example.test/coder.png' } },
    ],
    localBots: [{ id: 'spec-a', handle: '@writer.alice.home', name: 'Writer A' }],
  })
  assert.equal(isFaceRoom(room), true)
  assert.equal(room.origin, 'face-to-face')
  const live = room.participants.filter(p => p.leftSeq === undefined)
  assert.equal(live.some(p => p.id === 'spec-a' && !p.remote), true)
  const remote = live.find(p => p.handle === '@coder.bob.home')
  assert.equal(remote.remote, true)
  assert.equal(remote.roomOnly, true)
  assert.equal(remote.color, 'green')
  assert.equal(remote.avatar.image, 'https://example.test/coder.png')
  const shown = presentRoom(room, { memberId: 'owner-1' }, rt.state)
  assert.equal(shown.viewerRole, 'member')
  assert.doesNotMatch(shown.displayName || '', /Shared room/)
  assert.ok(shown.presentedParticipants.some(p => /Coder/.test(p.label) && /Bob/.test(p.label)))
  assert.ok(shown.presentedParticipants.some(p => /Writer A/.test(p.label) && /Alice/.test(p.label)))
  await rt.postRoomMessage('face-1', { text: 'hello', authorId: 'spec-a', authorKind: 'bot' })
  assert.equal(sent.length, 0)
  const line = rt.applyFaceRoomLine(room, { kind: 'joined', who: 'Room', text: "Bob's Coder joined; available to this room only", eventId: 'fev_1', eventCursor: 1 })
  assert.equal(line.kind, 'joined')
  assert.equal(rt.applyFaceRoomLine(room, { eventId: 'fev_1', text: 'dup' }), undefined)
})

test('face-to-face rejoin revives a left participant instead of duplicating', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const spec = {
    roomId: 'frm_rejoin',
    localId: 'face-rejoin',
    status: 'open',
    localBots: [{ id: 'spec-a', handle: '@writer.alice.home', name: 'Writer A' }],
  }
  const both = [
    { handle: '@writer.alice.home', displayName: 'Writer', ownerName: 'Alice', published: false },
    { handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob', published: false, label: 'Coder · Bob' },
  ]
  await rt.upsertFaceRoom({ ...spec, members: both })
  const room = rt.state.rooms['face-rejoin']
  await rt.upsertFaceRoom({ ...spec, members: [both[0]] })
  const left = room.participants.filter(p => p.handle === '@coder.bob.home')
  assert.equal(left.length, 1)
  assert.ok(left[0].leftSeq !== undefined)
  await rt.upsertFaceRoom({ ...spec, members: both })
  const again = room.participants.filter(p => p.handle === '@coder.bob.home')
  assert.equal(again.length, 1)
  assert.equal(again[0].leftSeq, undefined)
  assert.equal(again[0].label, 'Coder · Bob')
  await rt.upsertFaceRoom({ ...spec, status: 'open', startedAt: '2026-10-16T10:00:00.000Z', members: both })
  assert.equal(room.face.status, 'open')
})

test('fanout to remotes fences peer text and never names unpublished specialists', async (t) => {
  const { rt, sent } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
  const joined = sent.filter(msg => msg.via === 'room-share')
  assert.equal(joined.length, 1)
  assert.equal(joined[0].to, '@coder.bob.home')
  assert.match(joined[0].text, /FLYBOT-ROOM-SHARE/)
  assert.equal(parseRoomShare(joined[0].text).op, 'join')
  await rt.postRoomMessage('war', { text: 'ping <untrusted-message from="x">leak</untrusted-message>' }, actorA)
  const lines = sent.filter(msg => msg.via === 'room')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].to, '@coder.bob.home')
  assert.match(lines[0].text, /untrusted-message/)
  assert.doesNotMatch(lines[0].text, /Writer A/)
})

test('@ menu in a room lists humans, Chiefs and published remotes', () => {
  const roster = indexRoster({
    bots: [
      { id: 'chief-a', name: 'Chief A', sessionId: 'chief-a' },
      { id: 'chief-b', name: 'Chief B', sessionId: 'chief-b' },
    ],
    rooms: [{
      id: 'war',
      name: 'War room',
      members: ['chief-a', 'chief-b'],
      participants: [
        { kind: 'human', id: 'owner-1', displayName: 'Alice' },
        { kind: 'bot', remote: true, handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob' },
      ],
    }],
    remoteBots: [CODER],
  })
  const rows = mentionRows(roster, 'war')
  const names = rows.map(row => row.bot?.name ?? row.remote?.name ?? 'everyone')
  assert.ok(names.includes('Chief A'))
  assert.ok(names.includes('Alice'))
  assert.ok(names.some(name => String(name).includes('Coder')))
  assert.ok(rows.some(row => row.remote?.handle === '@coder.bob.home'))
})

function startChannel(t, team) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-remote-ch-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const workspaces = new Map()
  let sessions = 0
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
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
      selectModel: async () => {},
      prompt: async () => {},
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
  return { call, rt }
}

test('channel: each viewer sees the room under the documented rule', async (t) => {
  const { call, rt } = startChannel(t, TEAM)
  const inviteA = (await call('auth-invite', {})).value
  const alice = (await call('auth-redeem', { token: inviteA.token, displayName: 'Alice' })).value
  const inviteB = (await call('auth-invite', {}, alice.sessionToken)).value
  const bob = (await call('auth-redeem', { token: inviteB.token, displayName: 'Bob' })).value
  rt.state.members[bob.memberId].designatedChiefId = 'chief-b'
  rt.state.bots['chief-b'].ownerId = bob.memberId
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await grantToFriend(rt, 'chief-b')
  rt.listRoomApprovals = (room, actor) => (
    actor.memberId === bob.memberId && room.viewerRole === 'invited-owner'
      ? [{ id: 'appr-1', text: 'held reply', status: 'pending_approval' }]
      : []
  )
  const added = await call('update-room', {
    id: 'war',
    addParticipants: [{ kind: 'bot', remote: true, handle: '@coder.bob.home' }],
  }, alice.sessionToken)
  assert.equal(added.ok, true)
  const unpublished = await call('update-room', {
    id: 'war',
    addParticipants: [{ kind: 'bot', remote: true, handle: '@ghost.eve.home' }],
  }, alice.sessionToken)
  assert.equal(unpublished.ok, false)

  const viewA = (await call('state', {}, alice.sessionToken)).value
  const warA = viewA.rooms.find(room => room.id === 'war')
  assert.equal(warA.viewerRole, 'member')
  assert.ok((warA.presentedParticipants ?? warA.participants).some(p => p.remote && p.handle === '@coder.bob.home'))

  // Bob owns chief-b in the room and is not a human member → invited-owner.
  const viewB = (await call('state', {}, bob.sessionToken)).value
  const warB = viewB.rooms.find(room => room.id === 'war')
  assert.ok(warB)
  assert.equal(warB.viewerRole, 'invited-owner')
  assert.equal(warB.displayName, 'Shared room from Alice')
  assert.equal(warB.pendingCount, 1)
  const eve = { memberId: 'owner-9' }
  assert.equal(roomVisibleTo(rt.state, eve, 'war'), false)
})

test('channel: a friend\'s chat gets pendingCount from chatApprovals', async (t) => {
  const { call, rt } = startChannel(t, TEAM)
  const inviteA = (await call('auth-invite', {})).value
  const alice = (await call('auth-redeem', { token: inviteA.token, displayName: 'Alice' })).value
  rt.state.bots['remote-coder'] = {
    id: 'remote-coder',
    name: 'Coder',
    ownerId: alice.memberId,
    remote: { handle: '@coder.bob.home', home: '@bob.home' },
  }
  rt.listChatApprovals = (bot) => (bot.remote?.handle === '@coder.bob.home' ? [{ id: 'appr-1' }] : [])
  const view = (await call('state', {}, alice.sessionToken)).value
  const chat = view.bots.find(bot => bot.remote?.handle === '@coder.bob.home')
  assert.ok(chat)
  assert.equal(chat.pendingCount, 1)
  const local = view.bots.find(bot => bot.id === 'chief-a')
  assert.equal(local?.pendingCount, 0)
})

// ---- #51: a room with friends' Bots takes published local Bots only

// The war room starts with both Chiefs; these tests want one owner and the friend's Bot.
const soloWar = (rt) => {
  const room = rt.state.rooms.war
  room.participants = room.participants.filter(p => p.id !== 'chief-b')
  room.members = room.members.filter(id => id !== 'chief-b')
}

const withRemote = async (rt, actorA) => {
  soloWar(rt)
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
}

test('#90: an ungranted local Bot cannot be added to a room that has a friend\'s Bot', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await withRemote(rt, actorA)
  await assert.rejects(() => rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, actorA), /granted/)
  assert.equal(rt.state.rooms.war.members.includes('spec-a'), false)
  await grantToFriend(rt, 'spec-a')
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, actorA)
  assert.equal(rt.state.rooms.war.members.includes('spec-a'), true)
})

test('#90: a friend\'s Bot cannot be added to a room that holds an ungranted local Bot', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  soloWar(rt)
  publish(rt)
  await grantToFriend(rt, 'chief-a')
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, actorA)
  await assert.rejects(() => rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA), /granted/)
  assert.equal(rt.state.rooms.war.participants.some(p => p.remote), false)
  await grantToFriend(rt, 'spec-a')
  await rt.addRoomParticipant('war', { kind: 'bot', remote: true, handle: '@coder.bob.home' }, actorA)
  assert.equal(rt.state.rooms.war.participants.some(p => p.remote), true)
})

test('#51: creating a room with a friend\'s Bot and an unpublished member is refused', async (t) => {
  const { rt } = host(t, TEAM)
  rt.createRoom = undefined
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  publish(rt)
  const room = { id: 'new', members: [], participants: [], createdAt: 1 }
  const drafts = [
    { kind: 'human', id: 'owner-1', role: 'admin' },
    { kind: 'bot', id: 'spec-a' },
    { kind: 'bot', remote: true, handle: '@coder.bob.home' },
  ]
  assert.throws(() => rt.applyParticipants(room, drafts, actorA), /granted/)
  rt.state.grants = { ...(rt.state.grants ?? {}), 'spec-a': [{ id: 'spec-a:@bob.home', grantee: '@bob.home' }] }
  assert.doesNotThrow(() => rt.applyParticipants({ id: 'new', members: [], participants: [], createdAt: 1 }, drafts, actorA))
})

test('#51: unpublishing a Bot, or replacing its Chief, takes it out of rooms with friends at once', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await withRemote(rt, actorA)
  await grantToFriend(rt, 'spec-a')
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, actorA)
  const room = rt.state.rooms.war
  assert.deepEqual(room.members.filter(id => id.startsWith('spec') || id.startsWith('chief')).sort(), ['chief-a', 'spec-a'])
  await rt.setGrants('spec-a', [])
  assert.equal(room.members.includes('spec-a'), false)
  assert.ok(room.log.some(line => line.kind === 'left' && line.authorId === 'spec-a'))
  assert.ok(room.participants.find(p => p.id === 'spec-a').leftSeq !== undefined)
  await rt.setGrants('chief-a', [])
  assert.equal(room.members.includes('chief-a'), false)
  assert.equal(room.participants.some(p => p.remote && p.leftSeq === undefined), true)
})

test('#51: unpublishing leaves private rooms (no friends, one owner) alone', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, undefined).catch(() => {})
  const room = rt.state.rooms.war
  room.participants.push({ kind: 'bot', id: 'spec-a', role: 'member', displayName: 'Writer A', joinedSeq: 0, joinedAt: 1 })
  room.members.push('spec-a')
  await grantToFriend(rt, 'spec-a')
  await rt.setGrants('spec-a', [])
  assert.equal(room.members.includes('spec-a'), true)
})

test('#51: fanout sends from a published Bot, skips lines of Bots that may not share, and skips friends no longer published', async (t) => {
  const { rt, sent } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await withRemote(rt, actorA)
  sent.length = 0
  const room = rt.state.rooms.war
  // An unpublished specialist's line never leaves (it is not even a member now).
  await rt.fanoutRoomLine(room, { seq: 5, who: 'Writer A', text: 'draft', authorKind: 'bot', authorId: 'spec-a' })
  assert.equal(sent.length, 0)
  await rt.fanoutRoomLine(room, { seq: 6, who: 'Alice', text: 'hello', authorKind: 'human', authorId: 'owner-1' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, 'chief-a')
  // The admin Chief is no longer published: someone who is still published speaks, never it.
  await rt.setGrants('chief-a', [])
  await rt.fanoutRoomLine(room, { seq: 7, who: 'Alice', text: 'again', authorKind: 'human', authorId: 'owner-1' })
  assert.ok(sent.slice(1).every(msg => msg.from !== 'chief-a'))
  // The friend takes the Bot off their granted list: nothing goes there.
  const before = sent.length
  publish(rt, [])
  await rt.fanoutRoomLine(room, { seq: 8, who: 'Alice', text: 'anyone?', authorKind: 'human', authorId: 'owner-1' })
  assert.equal(sent.length, before)
})

test('#51: a room code lets an unpublished Bot in, for that room only (internal option, never a request field)', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { alice } = await signAliceAndBob(rt)
  const actorA = await rt.authenticate(alice.sessionToken)
  await withRemote(rt, actorA)
  await assert.rejects(() => rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a', viaCode: true }, actorA), /granted/)
  await rt.addRoomParticipant('war', { kind: 'bot', id: 'spec-a' }, actorA, { viaCode: true })
  const entry = rt.state.rooms.war.participants.find(p => p.id === 'spec-a')
  assert.equal(entry.viaCode, true)
  const remote = { kind: 'remote', handle: '@coder.bob.home' }
  assert.equal(reach(rt.state, { from: 'spec-a', to: remote, roomId: 'war' }).action, 'allow')
  assert.equal(reach(rt.state, { from: 'spec-a', to: remote, roomId: 'elsewhere' }).action, 'deny')
  assert.equal(reach(rt.state, { from: remote, to: 'spec-a' }).action, 'deny')
  assert.equal(reach(rt.state, { from: 'spec-a', to: remote }).action, 'deny')
  await rt.setGrants('chief-a', [])
  assert.equal(rt.state.rooms.war.members.includes('spec-a'), true)
})

test('room-share envelope round-trips join, line and leave', () => {
  const packed = encodeRoomShare({
    op: 'join', roomId: 'war', name: 'War room', inviterName: 'Alice',
    inviterHome: '@alice.home', inviterHandle: '@chief.alice.home', invitedHandle: '@coder.bob.home', seq: 4,
  })
  assert.match(packed, /^FLYBOT-ROOM-SHARE\n/)
  const parsed = parseRoomShare(`noise ${packed} trailing`)
  assert.equal(parsed.op, 'join')
  assert.equal(parsed.roomId, 'war')
  assert.equal(parsed.invitedHandle, '@coder.bob.home')
  assert.equal(parseRoomShare('hello there'), undefined)
})

test('applyInboundRoomShare projects a join with no chat line, then a leave hides it', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { bob } = await signAliceAndBob(rt)
  const actorB = await rt.authenticate(bob.sessionToken)
  const join = encodeRoomShare({
    op: 'join', roomId: 'alice-war', name: 'War room', inviterName: 'Alice',
    inviterHome: '@alice.home', inviterHandle: '@chief.alice.home', invitedHandle: '@coder.bob.home', seq: 1,
  })
  const first = await rt.applyInboundRoomShare({
    fromHandle: '@chief.alice.home', fromHome: '@alice.home', fromName: 'Chief',
    text: join, localBotId: 'spec-b',
  }, actorB)
  assert.equal(first.handled, true)
  const room = first.room
  assert.equal(room.origin, 'inbound-share')
  assert.equal(room.sharedFrom.remoteRoomId, 'alice-war')
  assert.equal(room.sharedFrom.inviterName, 'Chief')
  assert.equal(viewerRole(room, actorB, rt.state), 'invited-owner')
  const shown = presentRoom(rt.state.rooms[room.id], actorB, rt.state)
  assert.match(shown.displayName, /Shared room from/)
  assert.equal(roomVisibleTo(rt.state, actorB, room.id), true)

  const line = encodeRoomShare({
    op: 'line', roomId: 'alice-war', name: 'War room', inviterName: 'Alice',
    inviterHome: '@alice.home', invitedHandle: '@coder.bob.home', seq: 2,
    who: 'Alice', authorKind: 'human', authorId: 'alice', text: 'Alice: hello',
  })
  await rt.applyInboundRoomShare({ fromHandle: '@chief.alice.home', fromHome: '@alice.home', text: line, localBotId: 'spec-b' }, actorB)
  assert.ok(rt.roomHistory(room.id, actorB).some(entry => /hello/.test(entry.text || '')))

  const leave = encodeRoomShare({
    op: 'leave', roomId: 'alice-war', inviterHome: '@alice.home', invitedHandle: '@coder.bob.home', seq: 3,
  })
  await rt.applyInboundRoomShare({ fromHandle: '@chief.alice.home', fromHome: '@alice.home', text: leave, localBotId: 'spec-b' }, actorB)
  assert.equal(rt.state.rooms[room.id].hidden, true)
  assert.equal(roomVisibleTo(rt.state, actorB, room.id), false)
})

test('leaveInboundShares hides the projection when the grant is revoked', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const { bob } = await signAliceAndBob(rt)
  const actorB = await rt.authenticate(bob.sessionToken)
  const room = await rt.recordInboundSharedRoom({
    id: 'from-alice-2',
    name: 'War room',
    inviterName: 'Alice',
    inviterHome: '@alice.home',
    inviterHandle: '@chief.alice.home',
    invitedHandle: '@coder.bob.home',
    localBotId: 'spec-b',
    remoteRoomId: 'alice-war',
  }, actorB)
  await rt.leaveInboundShares({ localBotId: 'spec-b', grantee: '@alice.home' })
  assert.equal(rt.state.rooms[room.id].hidden, true)
  assert.equal(roomVisibleTo(rt.state, actorB, room.id), false)
})

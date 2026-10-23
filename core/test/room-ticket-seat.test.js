// #884, #878: a stranger's home joins a room that lives in another FlyBot through a link Bot Social
// recorded. Two homes in one process, a stand-in for Bot Social's ticket record and its reach rule,
// and a transport that delivers a room share only where that rule lets it through.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installAuthz } from '../src/host/authz.js'
import { install as installRooms, publishedRemoteOf } from '../src/host/room-membership.js'
import { install as installReach, mayShareRoom } from '../src/host/reach.js'
import { parseRoomShare } from '../src/shared/room-share.js'

const ALICE = {
  version: 2,
  revision: 1,
  mainBotIds: ['chief-a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-a' } },
  bots: {
    'chief-a': { id: 'chief-a', sessionId: 'chief-a', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1', fields: { social: { member: { home: '@alice.home', handle: '@chief.alice.home', ownerName: 'Alice' } } } },
    'writer-a': { id: 'writer-a', sessionId: 'writer-a', name: 'Writer', instructions: '', createdAt: 2, ownerId: 'owner-1', fields: { social: { member: { home: '@alice.home', handle: '@writer.alice.home', ownerName: 'Alice' } } } },
  },
  rooms: {
    war: {
      id: 'war',
      name: 'Launch plan',
      members: ['chief-a', 'writer-a'],
      admin: 'chief-a',
      named: true,
      log: [],
      seq: 0,
      seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief-a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'writer-a', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const BOB = {
  version: 2,
  revision: 1,
  mainBotIds: ['chief-b'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-b' } },
  bots: {
    'chief-b': { id: 'chief-b', sessionId: 'chief-b', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1', fields: { social: { member: { home: '@bob.home', handle: '@chief.bob.home', ownerName: 'Bob' } } } },
    'helper-b': { id: 'helper-b', sessionId: 'helper-b', name: 'Helper', instructions: '', createdAt: 2, ownerId: 'owner-1', fields: { social: { member: { home: '@bob.home', handle: '@helper.bob.home', ownerName: 'Bob' } } } },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const handleOf = (rt, id) => rt.state.bots[id]?.fields?.social?.member?.handle

function makeHome(t, saved, label) {
  const dir = mkdtempSync(join(tmpdir(), `ds-bot-ticket-${label}-`))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  let rooms = 0
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    dropGroupSession: () => {},
    createSession: async () => `${label}-room-${++rooms}`,
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
  return { rt, warnings }
}

// Bot Social's side, as #60 has it: a ticket record per link, one claim per ticket, and room reach
// between the inviter's Bot and each claimed Bot, under that room id only.
function fakeServer() {
  const tickets = new Map()
  let n = 0
  const fail = code => Object.assign(new Error(code), { code })
  const reach = (from, to, roomId) => [...tickets.values()].some(t => !t.revoked && !t.released && t.claimer && t.roomId === roomId
    && ((t.handle === from && t.claimer.bots.includes(to)) || (t.handle === to && t.claimer.bots.includes(from))))
  const as = home => ({
    mint: async ({ roomId, name, handle }) => {
      n += 1
      const ticket = `Tkt${String(n).padStart(4, '0')}AbCdEfGhIjKlMnO`
      const expiresAt = Date.now() + 10 * 60 * 1000
      tickets.set(ticket, { ticket, roomId, name, handle, minter: home, expiresAt })
      return { ticket, expiresAt }
    },
    preview: async ticket => {
      const t = tickets.get(ticket)
      if (!t) throw fail('invite_not_found')
      if (t.revoked) throw fail('revoked')
      return { roomId: t.roomId, name: t.name, lead: { handle: t.handle, name: 'Chief', ownerName: 'Alice' }, expiresAt: t.expiresAt, claimed: Boolean(t.claimer) }
    },
    claim: async (ticket, bots) => {
      const t = tickets.get(ticket)
      if (!t) throw fail('invite_not_found')
      if (t.revoked) throw fail('revoked')
      if (t.minter === home) throw fail('own_invite')
      if (t.claimer || t.released) {
        if (t.claimer?.home === home && [...t.claimer.bots].sort().join() === [...bots].sort().join() && !t.released) return { roomId: t.roomId, inviterHandle: t.handle, bots }
        throw fail('already_claimed')
      }
      t.claimer = { home, bots: [...bots] }
      return { roomId: t.roomId, inviterHandle: t.handle, bots }
    },
    verify: async ticket => {
      const t = tickets.get(ticket)
      if (!t || t.minter !== home) throw fail('invite_not_found')
      if (t.revoked) throw fail('revoked')
      return {
        roomId: t.roomId,
        claimer: t.claimer && !t.released
          ? { home: t.claimer.home, bots: t.claimer.bots, members: t.claimer.bots.map(handle => ({ handle, display_name: handle.split('.')[0].slice(1).replace(/^./, c => c.toUpperCase()), owner_name: 'Bob' })) }
          : null,
      }
    },
    revoke: async ticket => {
      const t = tickets.get(ticket)
      if (!t) return
      if (t.minter === home) t.revoked = true
      else if (t.claimer?.home === home) t.released = true
    },
  })
  return { tickets, reach, as }
}

// The two homes, and a transport that lets a room share through only where Bot Social would: a
// friend's roster here is empty, so only the room reach a claim wrote carries anything.
async function twoHomes(t) {
  const server = fakeServer()
  const a = makeHome(t, ALICE, 'a')
  const b = makeHome(t, BOB, 'b')
  await a.rt.load()
  await b.rt.load()
  a.rt.roomInviteServer = server.as('@alice.home')
  b.rt.roomInviteServer = server.as('@bob.home')
  const log = []
  const pending = []
  const wire = (from, to, home) => {
    from.rt.flybotSend = async (msg) => {
      const fromHandle = handleOf(from.rt, msg.from)
      const scope = msg.meta?.scope
      const ok = scope !== undefined && server.reach(fromHandle, msg.to, scope)
      log.push({ ...msg, fromHandle, delivered: ok })
      if (!ok) return { action: 'deny' }
      const localBotId = Object.keys(to.rt.state.bots).find(id => handleOf(to.rt, id) === msg.to)
      pending.push(to.rt.applyInboundRoomShare({ text: msg.text, fromHandle, fromHome: home, fromName: 'Bot', localBotId }))
      return { action: 'sent' }
    }
  }
  wire(a, b, '@alice.home')
  wire(b, a, '@bob.home')
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
      while (pending.length) await pending.shift()
    }
  }
  return { server, a, b, log, settle }
}

const guestRoomOf = rt => Object.values(rt.state.rooms).find(room => room.origin === 'inbound-share')

test('#884: a stranger claims a room link with two of its Bots, both are seated, and lines go both ways', async (t) => {
  const { server, a, b, log, settle } = await twoHomes(t)
  // Writer has no grant to anyone: the link is the owner's consent to show the room as it is.
  assert.equal(mayShareRoom(a.rt.state, a.rt.state.rooms.war, 'writer-a'), false, 'before a link, Writer is private')
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  assert.equal(invite.server, true, 'Bot Social recorded the ticket')
  assert.equal(invite.handle, '@chief.alice.home', 'the link knocks on the room lead')
  assert.equal(server.tickets.get(invite.ticket).roomId, 'war')
  assert.equal(mayShareRoom(a.rt.state, a.rt.state.rooms.war, 'writer-a'), true, 'an open link of this owner opens the room')

  const preview = await b.rt.previewLocalInvite(invite.url)
  assert.equal(preview.server, true)
  assert.equal(preview.name, 'Launch plan')
  assert.equal(preview.claimed, false)

  const joined = await b.rt.askLocalInvite(invite.url, { accept: true, bots: ['chief-b', 'helper-b'] }, { memberId: 'owner-1' })
  assert.equal(joined.claimed, true)
  assert.deepEqual(joined.bots, ['@chief.bob.home', '@helper.bob.home'])
  const knock = log.find(m => parseRoomShare(m.text)?.op === 'ask')
  assert.equal(knock.from, 'chief-b', 'the first Bot the claim brought knocks')
  assert.equal(knock.meta.scope, 'war', "the knock goes under the claimed room's scope")
  assert.equal(knock.delivered, true, 'the claim opened the one way to the inviter')
  const asked = parseRoomShare(knock.text)
  assert.equal(asked.roomId, 'war')
  assert.deepEqual(asked.bots, ['@chief.bob.home', '@helper.bob.home'])
  // The claim is the guest's reach before the room exists there: to the inviter's Bot, in that room only.
  assert.equal(b.rt.reach({ from: 'chief-b', to: { kind: 'remote', handle: '@chief.alice.home' }, meta: { scope: 'war' } }).action, 'allow')
  assert.equal(b.rt.reach({ from: 'chief-b', to: { kind: 'remote', handle: '@writer.alice.home' }, meta: { scope: 'war' } }).action, 'deny', 'not any Bot of that home')
  assert.equal(b.rt.reach({ from: 'chief-b', to: { kind: 'remote', handle: '@chief.alice.home' } }).action, 'deny', 'not outside the room')
  assert.equal(b.rt.reach({ from: 'chief-b', to: { kind: 'remote', handle: '@chief.alice.home' }, meta: { scope: 'other' } }).action, 'deny', 'not under another room')
  await settle()

  const room = a.rt.state.rooms.war
  const seats = room.participants.filter(p => p.remote === true && p.leftSeq === undefined)
  assert.deepEqual(seats.map(p => p.handle).sort(), ['@chief.bob.home', '@helper.bob.home'], 'all the claim brought, in one step')
  assert.ok(seats.every(p => p.admittedBy === 'ticket' && p.ticket === invite.ticket && p.hostBotId === 'chief-a'))
  assert.equal(seats.find(p => p.handle === '@helper.bob.home').displayName, 'Helper', "the seat's name comes from the server's claim")
  assert.equal(publishedRemoteOf(a.rt.state, '@chief.bob.home'), undefined, 'a seat is not a friend: nothing is published')
  assert.equal(a.rt.localInviteOf('war'), undefined, 'the spent link is not offered again')

  // The guest home has one room that mirrors it, with both of its Bots.
  const mirror = guestRoomOf(b.rt)
  assert.ok(mirror, 'the joins projected the room on the guest side')
  assert.equal(Object.values(b.rt.state.rooms).filter(r => r.origin === 'inbound-share').length, 1, 'one room for both seats')
  assert.deepEqual(mirror.participants.filter(p => p.leftSeq === undefined).map(p => p.id).sort(), ['chief-b', 'helper-b'])
  assert.equal(mirror.sharedFrom.remoteRoomId, 'war')
  assert.equal(mirror.sharedFrom.ticket, invite.ticket)
  const joins = log.filter(m => parseRoomShare(m.text)?.op === 'join')
  assert.ok(joins.every(m => m.from === 'chief-a' && m.meta.scope === 'war' && m.delivered), 'joins go from the linked Bot, under the room scope')

  // Host → guest: Alice's line reaches the mirror.
  const line = await a.rt.postRoomMessage('war', { text: 'Ship on Friday?', authorId: 'owner-1', authorKind: 'human', displayName: 'Alice' })
  await a.rt.fanoutRoomLine(room, line)
  await settle()
  assert.ok(mirror.log.some(entry => String(entry.text).includes('Ship on Friday?')), 'the host line arrived')

  // Guest → host: a line Bob's Bot writes in the mirror lands in the host's own room, not a new one.
  const roomsBefore = Object.keys(a.rt.state.rooms).length
  const reply = { who: 'Helper', botId: 'helper-b', authorId: 'helper-b', authorKind: 'bot', text: 'Friday works.', seq: (mirror.seq ?? 0) + 1 }
  await b.rt.fanoutRoomLine(mirror, reply)
  await settle()
  const sentBack = log.findLast(m => parseRoomShare(m.text)?.op === 'line' && m.fromHandle === '@helper.bob.home')
  assert.equal(sentBack.meta.scope, 'war', "the guest's line goes under the host's room id")
  assert.equal(sentBack.delivered, true)
  assert.equal(Object.keys(a.rt.state.rooms).length, roomsBefore, 'no phantom room on the host')
  const landed = room.log.find(entry => String(entry.text).includes('Friday works.'))
  assert.ok(landed, 'the guest line is in the host room')
  assert.equal(landed.remote, true)
  assert.equal(landed.authorId, '@helper.bob.home')
  // And it is not echoed back to the home it came from.
  const echoes = log.filter(m => m.from === 'chief-a' && parseRoomShare(m.text)?.op === 'line' && String(parseRoomShare(m.text).text).includes('Friday works.'))
  assert.deepEqual(echoes.map(m => m.to).sort(), ['@chief.bob.home'], 'the other seat hears it; the author does not')
})

test('#884: the accept is read back from Bot Social, and each way it fails has its own reason', async (t) => {
  const { server, a, b, log } = await twoHomes(t)
  const knockFrom = (ticket, fromHandle = '@chief.bob.home', fromHome = '@bob.home', extra = {}) => a.rt.applyInboundRoomShare({
    text: `FLYBOT-ROOM-SHARE\n${JSON.stringify({ v: 1, op: 'ask', ticket, accept: true, roomId: 'war', ...extra })}`,
    fromHandle,
    fromHome,
    fromName: 'Chief',
  })
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  const seats = () => a.rt.state.rooms.war.participants.filter(p => p.remote === true && p.leftSeq === undefined)
  // The guest's own knock is held back here, so each crafted one below is judged alone.
  b.rt.flybotSend = async (msg) => { log.push(msg); return { action: 'sent' } }

  assert.equal((await knockFrom(invite.ticket)).refused, 'unclaimed', 'a knock without a claim seats nobody')
  await b.rt.askLocalInvite(invite.url, { accept: true, bots: ['chief-b'] }, { memberId: 'owner-1' })
  assert.equal((await knockFrom(invite.ticket, '@helper.bob.home')).refused, 'claimed-elsewhere', 'a Bot the claim did not bring')
  assert.equal((await knockFrom(invite.ticket, '@chief.bob.home', '@eve.home')).refused, 'claimed-elsewhere', 'the right handle from another home')
  server.tickets.get(invite.ticket).roomId = 'other'
  assert.equal((await knockFrom(invite.ticket)).refused, 'wrong-room')
  server.tickets.get(invite.ticket).roomId = 'war'
  const verify = a.rt.roomInviteServer.verify
  a.rt.roomInviteServer.verify = async () => { throw new Error('connect ECONNREFUSED') }
  assert.equal((await knockFrom(invite.ticket)).refused, 'lookup-failed', 'no answer from the server seats nobody')
  a.rt.roomInviteServer.verify = verify
  assert.equal(seats().length, 0, 'no refusal seated anyone')

  // A second home's claim on a spent link is refused at the server; the dialog names it.
  const late = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  server.tickets.get(late.ticket).claimer = { home: '@eve.home', bots: ['@eve.eve.home'] }
  const refused = await b.rt.askLocalInvite(late.url, { accept: true, bots: ['chief-b'] }, { memberId: 'owner-1' })
  assert.equal(refused.refused, 'claimed-elsewhere')
  await assert.rejects(() => b.rt.askLocalInvite(late.url, { accept: true, bots: ['chief-a-not-mine'] }, { memberId: 'owner-1' }), /Bots of your own/)

  assert.equal((await knockFrom(invite.ticket)).accepted, true)
  assert.deepEqual(seats().map(p => p.handle), ['@chief.bob.home'])
  assert.equal((await knockFrom(invite.ticket)).accepted, true, 'the retry succeeds without a second seat')
  assert.equal(seats().length, 1)
  await a.rt.revokeRoomInvite('war', invite.ticket)
  assert.equal((await knockFrom(invite.ticket)).refused, 'unknown', 'a withdrawn link answers nothing')
  assert.ok(log.length > 0)
})

test('#884: withdrawing the link ends the seat at both homes and at the server', async (t) => {
  const { server, a, b, log, settle } = await twoHomes(t)
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  await b.rt.askLocalInvite(invite.url, { accept: true, bots: ['chief-b'] }, { memberId: 'owner-1' })
  const knock = log.find(m => parseRoomShare(m.text)?.op === 'ask')
  await a.rt.applyInboundRoomShare({ text: knock.text, fromHandle: '@chief.bob.home', fromHome: '@bob.home' })
  await settle()
  const mirror = guestRoomOf(b.rt)
  assert.ok(mirror && !mirror.hidden)

  assert.deepEqual(await a.rt.revokeRoomInvite('war', invite.ticket), { revoked: true })
  await settle()
  assert.equal(a.rt.state.rooms.war.participants.filter(p => p.remote === true && p.leftSeq === undefined).length, 0, 'the seat left with its ticket')
  assert.equal(server.tickets.get(invite.ticket).revoked, true, 'and the reach ended at the server')
  assert.equal(mirror.hidden, true, 'the guest heard the leave')
  assert.equal(mayShareRoom(a.rt.state, a.rt.state.rooms.war, 'writer-a'), false, 'with no link left, Writer is private again')

  // A line the guest sends now has no reach, and a line for the host's room from a non-seat is dropped.
  await b.rt.fanoutRoomLine(mirror, { who: 'Chief', botId: 'chief-b', authorId: 'chief-b', authorKind: 'bot', text: 'still there?', seq: 99 })
  assert.equal(log.at(-1).delivered, false)
  const before = Object.keys(a.rt.state.rooms).length
  const stray = await a.rt.applyInboundRoomShare({ text: `FLYBOT-ROOM-SHARE\n${JSON.stringify({ v: 1, op: 'line', roomId: 'war', text: 'hi', seq: 1 })}`, fromHandle: '@chief.bob.home', fromHome: '@bob.home' })
  assert.equal(stray.refused, 'not-seated')
  assert.equal(Object.keys(a.rt.state.rooms).length, before, 'and it opened no copy of the room')
})

test('#884: the guest leaving gives the claim back; deleting the room withdraws its links', async (t) => {
  const { server, a, b, log, settle } = await twoHomes(t)
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  await b.rt.askLocalInvite(invite.url, { accept: true, bots: ['chief-b'] }, { memberId: 'owner-1' })
  await a.rt.applyInboundRoomShare({ text: log.find(m => parseRoomShare(m.text)?.op === 'ask').text, fromHandle: '@chief.bob.home', fromHome: '@bob.home' })
  await settle()
  const mirror = guestRoomOf(b.rt)
  await b.rt.removeRoomParticipant(mirror.id, { kind: 'bot', id: 'chief-b' }, { memberId: 'owner-1' })
  await settle()
  assert.equal(server.tickets.get(invite.ticket).released, true, 'the claim was given back')
  assert.equal(b.rt.state.roomClaims?.[invite.ticket], undefined, 'and its way out is gone')
  assert.equal(b.rt.reach({ from: 'chief-b', to: { kind: 'remote', handle: '@chief.alice.home' }, meta: { scope: 'war' } }).action, 'deny')
  assert.equal(a.rt.state.rooms.war.participants.filter(p => p.remote === true && p.leftSeq === undefined).length, 0, 'the host room lost the seat')
  assert.equal(a.rt.localInvitesOf('war').length, 0)

  const open = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  await a.rt.dropRoomInvites(a.rt.state.rooms.war)
  assert.equal(server.tickets.get(open.ticket).revoked, true, 'a deleted room takes its links with it at the server')
})

test('#884: a server without local room invites keeps the friend-only link', async (t) => {
  const { a } = await twoHomes(t)
  a.rt.roomInviteServer = { ...a.rt.roomInviteServer, mint: async () => undefined }
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  assert.equal(invite.server, undefined)
  assert.equal(mayShareRoom(a.rt.state, a.rt.state.rooms.war, 'writer-a'), false, 'a local-only link opens nothing to strangers')
  a.rt.roomInviteServer = { mint: async () => { throw new Error('502 Bad Gateway') } }
  await assert.rejects(() => a.rt.mintRoomInvite('war', { memberId: 'owner-1' }), /could not make a link/, 'a server that fails is not silently replaced')
})

test('#884: a home with no Bot Social identity yet gets one for the link it makes and the link it joins', async (t) => {
  const { a, b } = await twoHomes(t)
  const asked = []
  const giveIdentity = (rt, home) => async (ids) => {
    asked.push(...ids)
    for (const id of ids) rt.state.bots[id].fields = { social: { member: { home, handle: `@${id}.${home.slice(1)}` } } }
  }
  for (const id of Object.keys(a.rt.state.bots)) delete a.rt.state.bots[id].fields
  for (const id of Object.keys(b.rt.state.bots)) delete b.rt.state.bots[id].fields
  a.rt.roomInviteServer.identify = giveIdentity(a.rt, '@alice.home')
  b.rt.roomInviteServer.identify = giveIdentity(b.rt, '@bob.home')
  const invite = await a.rt.mintRoomInvite('war', { memberId: 'owner-1' })
  assert.deepEqual(asked, ['chief-a'], 'only the Bot the link knocks on')
  assert.equal(invite.handle, '@chief-a.alice.home')
  const joined = await b.rt.askLocalInvite(invite.url, { accept: true, bots: ['helper-b'] }, { memberId: 'owner-1' })
  assert.deepEqual(asked, ['chief-a', 'helper-b'], 'and only the Bot the guest brings')
  assert.deepEqual(joined.bots, ['@helper-b.bob.home'])
  b.rt.roomInviteServer.identify = async () => { throw new Error('503') }
  delete b.rt.state.bots['chief-b'].fields
  await assert.rejects(() => b.rt.askLocalInvite(invite.url, { accept: true, bots: ['chief-b'] }, { memberId: 'owner-1' }), /could not give this Bot an identity/)
})

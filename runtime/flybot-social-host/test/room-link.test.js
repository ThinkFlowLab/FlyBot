import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFlybotFacade } from '../src/facade.js'

const host = (t, { clock } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-room-link-'))
  const state = {
    bots: { a: { id: 'a', name: 'Chief', isMain: true } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'] } },
    prefs: {},
  }
  const rt = { home, state, botOf: id => state.bots[id], roomOf: id => state.rooms[id], warn() {} }
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, flybot: createFlybotFacade(rt, { clock }) }
}

const fakeInvites = ({ ticket = 'ticket-1', roomId = 'r1', claimers = [], previews = 0, fail } = {}) => {
  const store = { ticket, roomId, claimers: [...claimers], previews }
  return {
    store,
    mint: async (spec) => ({ ticket, roomId: spec.roomId ?? roomId }),
    preview: async (ticketId) => {
      store.previews += 1
      if (typeof fail === 'function') fail(store)
      return { ticket: ticketId ?? ticket, roomId, claimers: [...store.claimers] }
    },
    get verify() { return this.preview },
    claim: async (ticketId, handles) => ({ ticket: ticketId, roomId, handles }),
    revoke: async (ticketId) => ({ ticket: ticketId, revoked: true }),
    identify: async (ids) => { store.identified = [...(store.identified ?? []), ...ids] },
  }
}

test('minted link seats a claimer and lists ticket peers under the room scope', async (t) => {
  const { flybot } = host(t)
  const server = fakeInvites({
    claimers: [{ home: '@guest.home', handle: '@guest.bot', handles: ['@guest.bot'], name: 'Guest' }],
  })
  flybot.rooms.serveInvites(server)
  const minted = await flybot.rooms.mintInvite({ roomId: 'r1', bots: ['a'] })
  assert.equal(minted.ticket, 'ticket-1')
  const seated = await flybot.rooms.seatOpenClaims()
  assert.equal(seated.length, 1)
  const room = flybot.rooms.list().find(item => item.id === 'r1')
  const guest = room.participants.find(item => item.handle === '@guest.bot')
  assert.equal(guest.admittedBy, 'ticket')
  assert.equal(guest.ownerHome, '@guest.home')
  assert.deepEqual(flybot.rooms.ticketPeers(), [{ from: 'a', to: '@guest.bot', scope: 'r1' }])
  assert.deepEqual(server.store.identified, ['a'])
  // A second poll before a minute has passed does not re-preview or duplicate peers.
  await flybot.rooms.seatOpenClaims()
  assert.equal(server.store.previews, 1)
  assert.equal(flybot.rooms.ticketPeers().length, 1)
})

test('seatOpenClaims previews one open link per minute and backs off rate limits', async (t) => {
  let now = 1_000
  const { flybot } = host(t, { clock: () => now })
  const server = fakeInvites()
  flybot.rooms.serveInvites(server)
  await flybot.rooms.mintInvite({ roomId: 'r1', bots: ['a'] })
  await flybot.rooms.seatOpenClaims()
  assert.equal(server.store.previews, 1)
  now += 30_000
  await flybot.rooms.seatOpenClaims()
  assert.equal(server.store.previews, 1)
  now += 30_000
  await flybot.rooms.seatOpenClaims()
  assert.equal(server.store.previews, 2)
})

test('a rate-limited preview waits out the named retry, up to ten minutes', async (t) => {
  let now = 1_000
  const { flybot } = host(t, { clock: () => now })
  const limited = fakeInvites()
  let blows = 0
  const limitedPreview = async () => {
    blows += 1
    const error = new Error('Too many attempts')
    error.code = 'rate_limited'
    error.retryAfter = 120
    throw error
  }
  limited.preview = limitedPreview
  Object.defineProperty(limited, 'verify', { value: limitedPreview, configurable: true })
  flybot.rooms.serveInvites(limited)
  await flybot.rooms.mintInvite({ roomId: 'r1', bots: ['a'] })
  await flybot.rooms.seatOpenClaims()
  assert.equal(blows, 1)
  now += 60_000
  await flybot.rooms.seatOpenClaims()
  assert.equal(blows, 1, 'should wait out the named retry, not poll every minute')
  now += 60_000
  await flybot.rooms.seatOpenClaims()
  assert.equal(blows, 2)
})

test('a guest claim creates an inbound-share room and peers to the inviter', async (t) => {
  const { flybot } = host(t)
  const server = fakeInvites({ roomId: 'host-room' })
  server.preview = async () => ({ ticket: 'ticket-1', roomId: 'host-room', name: 'Ops', inviter: '@host.home' })
  flybot.rooms.serveInvites(server)
  const room = await flybot.rooms.claimInvite('ticket-1', ['a'])
  assert.equal(room.origin, 'inbound-share')
  assert.equal(room.sharedFrom.ticket, 'ticket-1')
  assert.equal(room.sharedFrom.remoteRoomId, 'host-room')
  assert.equal(room.participants.some(item => item.handle === '@host.home' && item.admittedBy === 'ticket'), true)
  assert.deepEqual(flybot.rooms.ticketPeers(), [{ from: 'a', to: '@host.home', scope: 'host-room' }])
})

test('revoke drops ticket peers; mint that returns nothing keeps the friend-only path', async (t) => {
  const { flybot } = host(t)
  const server = fakeInvites({
    claimers: [{ home: '@guest.home', handle: '@guest.bot', handles: ['@guest.bot'] }],
  })
  flybot.rooms.serveInvites(server)
  await flybot.rooms.mintInvite({ roomId: 'r1', bots: ['a'] })
  await flybot.rooms.seatOpenClaims()
  assert.equal(flybot.rooms.ticketPeers().length, 1)
  await flybot.rooms.revokeInvite('ticket-1')
  assert.deepEqual(flybot.rooms.ticketPeers(), [])
  flybot.rooms.serveInvites({ mint: async () => undefined })
  assert.equal(await flybot.rooms.mintInvite({ roomId: 'r1' }), undefined)
})

test('read-only façade does not mint or seat claims', async (t) => {
  const { rt } = host(t)
  rt.readOnly = () => 'another window holds this team'
  const flybot = createFlybotFacade(rt)
  flybot.rooms.serveInvites(fakeInvites({
    claimers: [{ home: '@guest.home', handle: '@guest.bot', handles: ['@guest.bot'] }],
  }))
  assert.equal(await flybot.rooms.mintInvite({ roomId: 'r1', bots: ['a'] }), undefined)
  assert.equal(await flybot.rooms.seatOpenClaims(), undefined)
  assert.deepEqual(flybot.rooms.ticketPeers(), [])
})

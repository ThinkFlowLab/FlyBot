// A face-to-face room's "Hide from sidebar" switch has to survive the room's own
// poll: every snapshot the social plugin applies re-upserts the room (`upsertFace`),
// and that write used to delete `hidden` on any open room, so the switch sprang back
// the moment the next poll landed. The rule now belongs to the person who hid the
// room, while a `hidden` an older state left behind (never chosen here) is still
// cleared by an open snapshot, which is what #1605 asked for.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install as installStore } from '../src/host/store.js'
import { install as installRooms } from '../src/host/room-membership.js'
import { install as installRoster } from '../src/host/roster.js'

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['chief-a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-a' },
  },
  bots: {
    'chief-a': { id: 'chief-a', sessionId: 'chief-a', name: 'Chief A', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    'spec-a': { id: 'spec-a', sessionId: 'spec-a', name: 'Writer A', instructions: '', createdAt: 3, ownerId: 'owner-1' },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function host(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-face-hidden-'))
  const statePath = join(dir, 'state.json')
  if (saved !== undefined) writeFileSync(statePath, JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = fakeContext()
  ctx.logger = { warn: (...args) => warnings.push(args), info() {} }
  ctx.effect = (execute) => {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    dropGroupSession: () => {},
    warn: (...args) => warnings.push(args),
    flybotSend: async () => ({ action: 'hold' }),
  }
  installStore(rt)
  installRooms(rt)
  installRoster(rt)
  t.after(async () => {
    await Promise.allSettled(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, warnings }
}

// The snapshot the poll applies: the room is open and this home's own Bot is seated.
const openSnapshot = () => ({
  roomId: 'frm_hide',
  localId: 'face-hide',
  status: 'open',
  startedAt: '2026-11-05T01:00:00.000Z',
  localBots: [{ id: 'spec-a', handle: '@writer.alice.home', name: 'Writer A' }],
  members: [
    { handle: '@writer.alice.home', displayName: 'Writer', ownerName: 'Alice', published: false },
    { handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob', published: false },
  ],
})

test('the hide a person chose outlives the next face-room poll', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const room = await rt.upsertFaceRoom(openSnapshot())
  assert.equal(room.face.status, 'open')
  assert.equal(room.hidden, undefined, 'an open room starts visible in the sidebar')

  await rt.setFlags(room.id, { hidden: true })
  assert.equal(room.hidden, true, 'the switch hides the row')

  await rt.upsertFaceRoom(openSnapshot())
  assert.equal(room.hidden, true, 'the poll that re-upserts the open room keeps the hide')

  // A second poll, the way the plugin keeps going every couple of seconds.
  await rt.upsertFaceRoom(openSnapshot())
  assert.equal(room.hidden, true, 'and so does the one after it')
})

test('turning the switch back off survives the polls too', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const room = await rt.upsertFaceRoom(openSnapshot())
  await rt.setFlags(room.id, { hidden: true })
  await rt.upsertFaceRoom(openSnapshot())
  assert.equal(room.hidden, true)

  await rt.setFlags(room.id, { hidden: false })
  assert.equal(room.hidden, false)
  await rt.upsertFaceRoom(openSnapshot())
  assert.notEqual(room.hidden, true, 'the row stays in the sidebar after the switch is turned off')
})

test('a hidden an earlier state left behind is still cleared, as #1605 asked', async (t) => {
  const { rt } = host(t, TEAM)
  await rt.load()
  const room = await rt.upsertFaceRoom(openSnapshot())
  // No switch ever chose this one: it is the stale shape the earlier rule exists for.
  room.hidden = true
  await rt.upsertFaceRoom(openSnapshot())
  assert.equal(room.hidden, undefined, 'an open face room a home is a member of is never left hidden by a stale flag')
  assert.equal(room.face.status, 'open')
})

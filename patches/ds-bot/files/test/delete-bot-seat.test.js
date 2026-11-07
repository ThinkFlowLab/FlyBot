import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// #2607: deleting a Bot ends its seats in every room, the way leaving does. Before this the deletion
// only filtered the legacy `room.members` array, the room's `participants` entry stayed current, and
// the next membership write rebuilt `room.members` from that entry — the deleted id came back and the
// following save wrote it to disk. Two rooms keep the older shape without `participants`: that path
// must still drop the id from `members` and stay without a participant list.

const live = room => (room.participants ?? []).filter(p => p.leftSeq === undefined).map(p => `${p.kind}:${p.id}`)

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['chief'],
  members: { owner: { id: 'owner', createdAt: 1, designatedChiefId: 'chief' } },
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1, ownerId: 'owner' },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2, ownerId: 'owner' },
    coder: { id: 'coder', sessionId: 'coder', name: 'Coder', role: 'Code', instructions: '', createdAt: 3, ownerId: 'owner' },
  },
  rooms: {
    // The Bot being deleted is a plain member here.
    desk: {
      id: 'desk',
      name: 'Desk',
      members: ['chief', 'writer'],
      admin: 'chief',
      named: true,
      log: [],
      seq: 0,
      seen: {},
      participants: [
        { kind: 'human', id: 'owner', role: 'admin', displayName: 'Owner', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'chief', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'writer', role: 'member', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
      ],
    },
    // The deleted Bot is the room's only admin and its only Bot — `members` is empty afterwards.
    solo: {
      id: 'solo',
      name: 'Solo',
      members: ['writer'],
      admin: 'writer',
      named: true,
      log: [],
      seq: 0,
      seen: {},
      participants: [
        { kind: 'human', id: 'owner', role: 'admin', displayName: 'Owner', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'writer', role: 'admin', displayName: 'Writer', joinedSeq: 0, joinedAt: 1 },
      ],
    },
    // No `participants` array: the shipped single-owner shape.
    legacy: { id: 'legacy', name: 'Legacy', members: ['chief', 'writer'], admin: 'chief', mode: 'everyone' },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

function context() {
  const ctx = fakeContext()
  Object.assign(ctx, {
    sessions: { get: () => undefined, flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new1' }), resolveAgent: async id => ({ agent: { id, session: { id, header: {} } } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    llm: { listProviders: () => [] },
  })
  return ctx
}

async function open(home) {
  const ctx = context()
  const rt = createRuntime(ctx, { home, github: false, composio: false, diagnosticsFile: false })
  await rt.load()
  return { ctx, rt }
}

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-delete-seat-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const first = await open(home)
  t.after(async () => {
    await first.ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, rt: first.rt, ctx: first.ctx }
}

test('deleting a Bot closes its participant seat and the next membership write does not write it back (#2607)', async (t) => {
  const { home, rt, ctx } = await setup(t)
  await rt.deleteBot('writer')
  assert.equal(rt.botOf('writer'), undefined, 'the Bot record is gone')
  const desk = rt.state.rooms.desk
  const seat = desk.participants.find(p => p.kind === 'bot' && p.id === 'writer')
  assert.ok(seat.leftSeq !== undefined, 'the deleted Bot no longer holds a current seat')
  assert.equal(typeof seat.leftAt, 'number', 'the seat records when it ended')
  assert.deepEqual(live(desk), ['human:owner', 'bot:chief'], 'the participant list no longer answers the deleted Bot')
  assert.deepEqual(rt.participantsOf(desk).map(p => `${p.kind}:${p.id}`), ['human:owner', 'bot:chief'], 'the drawer reads the same list')
  assert.deepEqual(desk.members, ['chief'], 'members is derived from the seats, not filtered beside them')

  // One ordinary membership write is what used to resurrect the id through `syncMembers`.
  await rt.addRoomParticipant('desk', { kind: 'bot', id: 'coder' })
  assert.deepEqual(desk.members, ['chief', 'coder'], 'the deleted id does not come back')
  assert.deepEqual(live(desk), ['human:owner', 'bot:chief', 'bot:coder'])

  // The deletion and the write were saved, so a host that reads the same state.json must agree.
  await ctx.dispose()
  const second = await open(home)
  t.after(async () => { await second.ctx.dispose() })
  const reread = second.rt.state.rooms.desk
  assert.equal(second.rt.botOf('writer'), undefined)
  assert.equal(live(reread).includes('bot:writer'), false, 'the saved seat stays closed')
  assert.deepEqual(reread.members, ['chief', 'coder'], 'the saved members list does not carry the deleted id')
})

test('a deleted Bot that was the only admin, and a room left with no Bots, take the next membership write (#2607)', async (t) => {
  const { rt } = await setup(t)
  await rt.deleteBot('writer')
  const solo = rt.state.rooms.solo
  assert.deepEqual(solo.members, [], 'the room is left with no Bots')
  assert.equal(solo.admin, null, 'the deleted Bot is not still the admin')
  assert.deepEqual(live(solo), ['human:owner'])
  await rt.addRoomParticipant('solo', { kind: 'bot', id: 'coder' })
  assert.deepEqual(solo.members, ['coder'])
  assert.deepEqual(live(solo), ['human:owner', 'bot:coder'])
  // The room without a participants array keeps the shipped shape.
  const legacy = rt.state.rooms.legacy
  assert.equal(legacy.participants, undefined, 'no participant list is invented for a legacy room')
  assert.deepEqual(legacy.members, ['chief'])
})

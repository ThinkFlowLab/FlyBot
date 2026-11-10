// A room saved before `seq` existed finds its clamp target with a reduce over the whole log, and
// `linesFrom` (`core/src/host/room-membership.js`) used to call `floorOf` once per line — so reading
// an n-line legacy room reduced n times over n lines and the read was quadratic. This counts the
// reduces instead of timing them.
//
//   node --test core/test/room-floor-once.test.js
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installAuthz } from '../src/host/authz.js'
import { install as installRooms } from '../src/host/room-membership.js'
import { install as installReach } from '../src/host/reach.js'

function host(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-floor-once-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const rt = {
    ctx: {
      logger: { warn: (...args) => warnings.push(args) },
      effect: execute => { const d = execute(); if (typeof d === 'function') disposers.push(d) },
    },
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
    await Promise.all(disposers.splice(0).map(dispose => dispose()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, warnings }
}

const N = 20000
const BOB = { memberId: 'owner-2', displayName: 'Bob' }
const ALICE = { memberId: 'owner-1', displayName: 'Alice' }

class CountingLog extends Array {
  reduce(...args) {
    CountingLog.reduces += 1
    return super.reduce(...args)
  }
}
CountingLog.reduces = 0

function fixture(withSeq = true) {
  const log = CountingLog.from({ length: N }, (_, i) => ({
    who: 'Alice', text: `line ${i + 1}`, seq: i + 1, authorId: 'owner-1', authorKind: 'human',
  }))
  return {
    version: 2, revision: 1, mainBotIds: ['chief-a'],
    members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'chief-a' } },
    bots: {
      'chief-a': {
        id: 'chief-a', sessionId: 'chief-a', name: 'Chief A', createdAt: 1, ownerId: 'owner-1',
      },
    },
    rooms: {
      legacy: {
        id: 'legacy', name: 'Legacy', members: ['chief-a'], admin: 'chief-a', named: true, log, seen: {},
        // A room saved before the counter existed has no `seq` of its own; `withSeq: false` keeps it
        // that way (a room with a counter is the control case).
        ...(withSeq ? { seq: N } : {}),
        participants: [
          { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
          { kind: 'human', id: 'owner-2', role: 'member', displayName: 'Bob', joinedSeq: 0, joinedAt: 1 },
        ],
      },
    },
    grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
  }
}

// Load, then hand the room a counting log and (for the legacy case) drop the counter the load gives
// it — the shape this bench is about is the one that was saved before `seq` existed.
async function loadedLegacy(t, withSeq) {
  const { rt, warnings } = await host(t, fixture(withSeq))
  await rt.load()
  const room = rt.state.rooms.legacy
  room.log = CountingLog.from(room.log)
  if (!withSeq) delete room.seq
  CountingLog.reduces = 0
  return { rt, room, warnings }
}

test('a legacy room read computes its clamp target once, not once per line', async (t) => {
  const { rt, room, warnings } = await loadedLegacy(t, false)
  const started = Date.now()
  const seen = rt.linesVisibleTo(room, BOB)
  const ms = Date.now() - started
  console.log(`legacy linesVisibleTo n=${N}: ${ms}ms, reduce calls=${CountingLog.reduces}`)
  assert.equal(seen.length, N, 'every line is readable')
  assert.equal(CountingLog.reduces, 1, `the clamp target is computed once per read, saw ${CountingLog.reduces}`)
  assert.deepEqual(warnings, [], 'a room whose stored floor is healthy says nothing')
})

test('a legacy room history read computes its clamp target once too', async (t) => {
  const { rt } = await loadedLegacy(t, false)
  const started = Date.now()
  const seen = rt.roomHistory('legacy', ALICE)
  const ms = Date.now() - started
  console.log(`legacy roomHistory n=${N}: ${ms}ms, reduce calls=${CountingLog.reduces}`)
  assert.equal(seen.length, N)
  assert.equal(CountingLog.reduces, 1, `the clamp target is computed once per read, saw ${CountingLog.reduces}`)
})

test('a room with a counter reads the same window without a per-line reduce', async (t) => {
  const { rt, room, warnings } = await loadedLegacy(t, true)
  const started = Date.now()
  const seen = rt.linesVisibleTo(room, BOB)
  const ms = Date.now() - started
  console.log(`modern linesVisibleTo n=${N}: ${ms}ms, reduce calls=${CountingLog.reduces}`)
  assert.equal(seen.length, N)
  assert.equal(CountingLog.reduces, 0, 'a room with a counter never walks the log to find one')
  assert.deepEqual(warnings, [])
})

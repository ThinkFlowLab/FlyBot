// P-707: `read_group_chat` discounts `room.reserved` — the numbers a co-seat mention took without
// writing a line here (#1126, #2855, #2863) — before it names a cut. The discount is room-wide while
// the window starts at the reader's floor, so a booking that sits *below* that floor is subtracted
// from lines the reader can see: a room that reached 510 with 10 bookings below a floor of 300 and its
// newest 60 lines kept read `newest 30 of 201`, where lines 300..510 are 211 of them. The numbers the
// bookings took are recorded (`room.reservedSeqs`), so the read discounts only the ones at or above
// the floor — the ones below it were already outside the window.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const T0 = 1_760_000_000_000
const line = (seq, who, text) => ({ seq, who, text, time: T0 + seq * 1000 })
const lines = (count, from = 1) => Array.from({ length: count }, (_, i) => line(from + i, (from + i) % 2 === 0 ? 'Chief' : 'Writer', `message ${from + i}: the merge queue slipped again`))
const shownLines = out => out.split('\n').filter(l => /^(Chief|Writer): /.test(l))
const seat = (id, joinedSeq) => ({ kind: 'bot', id, role: id === 'a' ? 'admin' : 'member', displayName: id === 'a' ? 'Chief' : 'Writer', joinedSeq, joinedAt: T0 })

const seedOf = (log, room) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log, seq: (log.at(-1)?.seq ?? 0), seen: {}, ...room } },
  agents: {},
  exchanges: {},
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function boot(home) {
  const ctx = fakeContext()
  const agentOf = id => ({ session: { id, seq: 0, deriveMessages: () => [] }, calls: [], inbox: { nextStep: [], nextTurn: [], remove: () => false }, followup: () => {}, steer: () => {}, cancel() {} })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return { rt, tool, home, ctx }
}

async function start(t, log, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-below-floor-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedOf(log, room)))
  const host = await boot(home)
  t.after(async () => {
    await host.ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return host
}

// RED today: b's window is 300..510, 211 numbers that are all lines, because the ten bookings the
// room took sit below 300. The read subtracts all ten and answers 201.
test("P-707: a booking below the reader's floor is not a line the window left out", async (t) => {
  const host = await start(t, lines(60, 451), {
    seq: 510,
    reserved: 10,
    reservedSeqs: [31, 62, 93, 124, 155, 186, 217, 248, 279, 290],
    participants: [seat('a', 0), seat('b', 300)],
  })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30, 'the read shows the newest 30 lines of the window')
  assert.match(out, /^Latest in "Ops" \(newest 30 of 211, oldest first\):$/m, `b's window is 300..510: 211 numbers and every one is a line, because all ten bookings sit below 300: ${out.split('\n')[0]}`)
  assert.match(out, /^(Chief|Writer): message 510: /m, 'the newest line is still shown')
})

// GREEN today, must stay: a booking at or above the floor is a number of the window that carries no
// line, so it is discounted exactly once — 300..510 is 211 numbers, ten of them bookings: 201 lines.
test("P-707 guard: a booking above the reader's floor is still discounted once", async (t) => {
  const host = await start(t, lines(50, 451), {
    seq: 510,
    reserved: 10,
    reservedSeqs: [501, 502, 503, 504, 505, 506, 507, 508, 509, 510],
    participants: [seat('a', 0), seat('b', 300)],
  })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30, 'the read shows the newest 30 lines of the window')
  assert.match(out, /^Latest in "Ops" \(newest 30 of 201, oldest first\):$/m, `300..510 is 211 numbers and ten of them are bookings, so 201 lines: ${out.split('\n')[0]}`)
})

// GREEN today, must stay: a room saved before the numbers were recorded counts its bookings the old
// way — one room-wide discount — rather than pretending each one sat above the floor.
test('P-707 guard: a room with no recorded booking numbers reads as it did before', async (t) => {
  const host = await start(t, lines(60, 451), {
    seq: 510,
    reserved: 10,
    participants: [seat('a', 0), seat('b', 300)],
  })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30, 'the read shows the newest 30 lines of the window')
  assert.match(out, /^Latest in "Ops" \(newest 30 of 201, oldest first\):$/m, `no recorded numbers means the old room-wide discount: ${out.split('\n')[0]}`)
})

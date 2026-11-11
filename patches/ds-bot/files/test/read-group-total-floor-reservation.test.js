// `read_group_chat` counts what the log cap dropped from `room.seq`, and discounts the numbers
// `takeLineSeq` issued that wrote no line (a co-seat mention, #1126/#2863). The count is room-wide but
// the window starts at the reader's floor, so both halves have to agree: a reservation *above* the
// floor is a number of the reader's window that carries no line and is discounted once, while the
// numbers below the floor are already outside the window.
//
// This test pins the boundary where a trimmed log, a floor and a reservation above that floor meet:
// b joined at 301, the room reached 500 and kept 59 lines (441..500, without 480), and 480 is the
// mention's reservation. Lines 301..500 are 199 of the room's lines, and the read answers 199 today.
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-floor-reservation-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedOf(log, room)))
  const host = await boot(home)
  t.after(async () => {
    await host.ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return host
}

test('a reservation above the reader\'s floor is discounted once, at the window it belongs to', async (t) => {
  const kept = lines(60, 441).filter(l => l.seq !== 480)
  const host = await start(t, kept, {
    seq: 500,
    reserved: 1,
    lastReserved: 480,
    participants: [seat('a', 0), seat('b', 301)],
  })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30, 'the read shows the newest 30 lines of the window')
  assert.match(out, /^Latest in "Ops" \(newest 30 of 199, oldest first\):$/m, `b's window is 301..500: 200 numbers, one of them the mention's reservation, so 199 lines: ${out.split('\n')[0]}`)
})

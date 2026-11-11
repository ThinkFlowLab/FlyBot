// P-684: a busy room's read counts what the disk still holds, not what the room said. `room.log` is
// capped at ROOM_LOG_MAX (60; 200 from room-membership.js) while `room.seq` keeps counting every line
// ever appended, so `kept.length` is a window — yet the header printed it as the total, telling a Bot
// `newest 30 of 60` for a room that had said 500 lines.
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

async function start(t, log, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-p684-'))
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log, seq: (log.at(-1)?.seq ?? 0), seen: {}, ...room } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
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
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return { rt, tool }
}

// RED today: 500 lines were said, the cap kept the newest 60, and the read calls the kept 60 the total.
test('P-684: a trimmed room read reports the lines the room said, not the lines it kept', async (t) => {
  const host = await start(t, lines(60, 441), { seq: 500 })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30)
  assert.match(out, /^Latest in "Ops" \(newest 30 of 500, oldest first\):$/m, `the total counts what the log still holds, not what the room said: ${out.split('\n')[0]}`)
  assert.match(out, /^(Chief|Writer): message 500: /m, 'the newest line is still shown')
})

// RED today: the hidden lines between the reader's floor and the oldest retained line are part of the
// total, but the lines the reader joined after are not.
test('P-684: the total is counted from the reader\'s floor, not from the start of the room', async (t) => {
  const host = await start(t, lines(60, 441), { seq: 500, participants: [seat('a', 0), seat('b', 300)] })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30)
  assert.match(out, /^Latest in "Ops" \(newest 30 of 201, oldest first\):$/m, `the total ignores the reader's floor: ${out.split('\n')[0]}`)
})

// GREEN today, must stay: a reader whose floor is above every dropped line sees all of its window, so
// there is nothing to report as left out.
test('P-684 guard: a late joiner in a trimmed room is not told about lines it joined after', async (t) => {
  const host = await start(t, lines(60, 441), { seq: 500, participants: [seat('a', 0), seat('b', 480)] })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 21)
  assert.doesNotMatch(out, /newest \d+ of \d+/)
})

// GREEN today, must stay: a log that reached the cap without dropping a line still counts its own 60.
test('P-684 guard: a room at exactly the cap is unchanged', async (t) => {
  const host = await start(t, lines(60))
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.match(out, /^Latest in "Ops" \(newest 30 of 60, oldest first\):$/m)
})

// GREEN today, must stay: a room under the cap reads exactly as the uncut room it is.
test('P-684 guard: a room under the cap is byte-identical', async (t) => {
  const said = lines(20)
  const host = await start(t, said)
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, `Latest in "Ops" (oldest first):\n${said.map(l => `${l.who}: ${l.text}`).join('\n')}`)
})

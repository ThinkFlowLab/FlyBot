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

const seedOf = (log, room) => ({
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
})

// One home, opened. A restart test opens the same folder twice, so the removal is registered here and
// only after the last runtime that used it has gone.
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
const retire = (t, host) => {
  t.after(async () => {
    await host.ctx.dispose()
    rmSync(host.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
}
async function start(t, log, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-p684-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seedOf(log, room)))
  const host = await boot(home)
  retire(t, host)
  return host
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

// #2855: `takeLineSeq` reserves a line number for a co-seat mention and writes no line, so a gap the
// counter opened used to be read as a line the cap dropped. The reservation still takes its number
// from `room.seq` — the receiver keys its one-bubble rule on it — so the read discounts the numbers
// issued instead (#2863).
test('#2855: a reservation is not a line', async (t) => {
  const said = lines(5)
  const host = await start(t, said)
  const before = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(before, `Latest in "Ops" (oldest first):\n${said.map(l => `${l.who}: ${l.text}`).join('\n')}`)
  const reserved = host.rt.flybot.rooms.takeLineSeq('r1')
  assert.equal(reserved, 6, 'the reservation continues the room counter')
  const after = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(after, before, 'a reservation writes no line, so nothing was left out')
  // A second reservation stays above everything issued and still writes nothing.
  assert.equal(host.rt.flybot.rooms.takeLineSeq('r1'), 7)
  assert.equal(await host.tool('read_group_chat', { group: 'Ops' }, 'gb'), before)
})

// #2863: the line written next takes 7, not the 6 the mention just went out with. Two counters stamped
// it 6, and a receiving home reads the second line at 6 as a redelivery of the mention.
test('#2863: the line written after a reservation takes the number after it', async (t) => {
  const host = await start(t, lines(5))
  assert.equal(host.rt.flybot.rooms.takeLineSeq('r1'), 6)
  const written = await host.rt.externalRoomLine(host.rt.roomOf('r1'), { who: 'Chief', text: 'message 6: the queue moved' })
  assert.equal(written.seq, 7, 'the written line takes the number after the reservation')
  assert.equal(host.rt.roomOf('r1').seq, 7)
})

// #2855: a line written after a reservation is the sixth line, not the seventh — the reservation
// behind it is still a number that wrote nothing.
test('#2855: a line written after a reservation still reads as six lines', async (t) => {
  const host = await start(t, lines(5))
  assert.equal(host.rt.flybot.rooms.takeLineSeq('r1'), 6)
  await host.rt.externalRoomLine(host.rt.roomOf('r1'), { who: 'Chief', text: 'message 6: the queue moved' })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 6)
  assert.doesNotMatch(out, /newest \d+ of \d+/, 'the reservation is not a line the cap dropped')
})

// #2855: the numbers issued and the count of them are room state, so a restart must not hand out a
// number twice or bring a reservation back as a line.
test('#2855: a reservation and the count it opened survive a restart', async (t) => {
  const said = lines(5)
  const before = `Latest in "Ops" (oldest first):\n${said.map(l => `${l.who}: ${l.text}`).join('\n')}`
  const first = await start(t, said)
  assert.equal(first.rt.flybot.rooms.takeLineSeq('r1'), 6)
  await first.rt.save()
  await first.ctx.dispose()
  const restarted = await boot(first.home)
  retire(t, restarted)
  assert.equal(restarted.rt.roomOf('r1').seq, 6, 'the room counter survived the save')
  assert.equal(await restarted.tool('read_group_chat', { group: 'Ops' }, 'gb'), before, 'the reservation did not come back as a line')
  assert.equal(restarted.rt.flybot.rooms.takeLineSeq('r1'), 7, 'the next reservation is above the one already sent')
})

// #2863: the mention and the line written after it carry different numbers, so a home that seats the
// sender draws both. With two counters both went out as 6 and the real line was taken for a redelivery.
test('#2863: the reserved number and the next line are two bubbles at the receiving home', async (t) => {
  const sender = await start(t, lines(5))
  const reserved = sender.rt.flybot.rooms.takeLineSeq('r1')
  const written = await sender.rt.externalRoomLine(sender.rt.roomOf('r1'), { who: 'Chief', text: 'message 6: the queue moved' })
  assert.equal(reserved, 6)
  assert.equal(written.seq, 7)

  const guest = await start(t, lines(2), {
    participants: [{ kind: 'bot', remote: true, id: '@chief.alice.home', handle: '@chief.alice.home', ownerHome: '@alice.home', displayName: 'Chief', role: 'member', joinedSeq: 0, joinedAt: T0 }],
  })
  const shown = []
  guest.rt.showSharedLine = async (room, spec) => { shown.push({ who: spec.who, text: spec.text, remoteSeq: spec.remoteSeq }) }
  const envelope = (seq, text) => `FLYBOT-ROOM-SHARE\n${JSON.stringify({
    v: 1, op: 'line', roomId: 'r1', name: 'Ops', invitedHandle: '@chief.alice.home', seq, who: 'Chief', kind: 'message', authorKind: 'human', text, calls: [],
  })}`
  const arrival = text => guest.rt.applyInboundRoomShare({ fromHandle: '@chief.alice.home', fromHome: '@alice.home', fromName: 'Chief', text }, { memberId: 'a' })
  await arrival(envelope(reserved, 'the mention'))
  await arrival(envelope(written.seq, 'the line after it'))
  assert.deepEqual(shown.map(item => item.remoteSeq), [6, 7], `both bubbles: ${JSON.stringify(shown)}`)
  assert.deepEqual(guest.rt.state.rooms.r1.shownShare, ['@chief.alice.home:6', '@chief.alice.home:7'])
})

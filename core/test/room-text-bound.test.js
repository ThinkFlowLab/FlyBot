import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { ROOM_NAME_MAX, ROOM_NOTICE_MAX } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// #1908/#1912/#1916 moved every other bound onto `cut` so a limit never lands between the halves
// of a surrogate pair; a group's own notice (2000) and name (60) still went through `slice`, so a
// body cut right there reached the encoder as U+FFFD and what the room stored was not well formed.
// The bound is a cap, not a target: a pair straddling it is dropped whole, never split.

const bot = (id, name, createdAt) => ({ id, sessionId: id, name, role: `${name} role`, model: 'deepseek/v4', instructions: '', createdAt })

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: bot('m1', 'Chief', 1),
    b2: bot('b2', 'Writer', 2),
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-room-text-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  let groupSessions = 0
  const agent = sessionId => ({
    id: sessionId,
    session: { id: sessionId, seq: 1, requestHeader: () => undefined },
    status: 'idle',
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    async whenIdle() {},
    async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
    inbox: { nextStep: [], nextTurn: [], remove() {} },
  })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      // A group's own Session id keys the room, so each creation needs its own.
      create: async () => ({ sessionId: `gs${++groupSessions}` }),
      resolveAgent: async sessionId => ({ agent: agent(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
  })
  apply(ctx, { home })
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, tool, saved, stop }
}

// What a reader downstream may do with the value: encode it as UTF-8. A lone half becomes U+FFFD,
// so the round trip is the trip the stored text has to survive.
const roundTrips = text => Buffer.from(text, 'utf8').toString('utf8') === text

test('a group notice that arrives ill formed is stored bounded and well formed (P-299)', async (t) => {
  const { tool, saved, stop } = start()
  t.after(stop)
  // 1999 units, then a whole emoji whose pair straddles the 2000-unit bound, then a tail.
  const notice = `${'a'.repeat(ROOM_NOTICE_MAX - 1)}\u{1F600}TAIL`
  assert.equal(notice.isWellFormed(), true, 'the input the user typed is well formed')

  assert.match(await tool('create_group', { members: ['Writer'], name: 'War', notice }, 'm1'), /^Created group "War"/)
  const room = Object.values(saved().rooms).find(entry => entry.name === 'War')
  assert.ok(room, 'the group is stored')

  assert.equal(room.notice.length <= ROOM_NOTICE_MAX, true, `the stored notice is ${room.notice.length} units, over ${ROOM_NOTICE_MAX}`)
  assert.equal(room.notice.isWellFormed(), true, `the stored notice is not well formed: ${JSON.stringify(room.notice)}`)
  assert.equal(roundTrips(room.notice), true, 'the stored notice survives a UTF-8 round trip')
  assert.equal(notice.startsWith(room.notice), true, 'the bound only drops a tail, so the stored notice is a prefix of what was typed')
  // The pair straddles the bound, so it is dropped whole instead of being cut in half: 1999 units.
  assert.equal(room.notice, 'a'.repeat(ROOM_NOTICE_MAX - 1))
})

test('a group name that arrives ill formed is stored bounded and well formed (P-299)', async (t) => {
  const { tool, saved, stop } = start()
  t.after(stop)
  // 59 units plus a whole emoji: the pair sits across the 60-unit bound.
  const name = `${'r'.repeat(ROOM_NAME_MAX - 1)}\u{1F600}`
  assert.equal(name.isWellFormed(), true)

  assert.match(await tool('create_group', { members: ['Writer'], name }, 'm1'), /^Created group "r/)
  const room = Object.values(saved().rooms).find(entry => entry.name.startsWith('r'))
  assert.ok(room, 'the group is stored')

  assert.equal(room.name.length <= ROOM_NAME_MAX, true, `the stored name is ${room.name.length} units, over ${ROOM_NAME_MAX}`)
  assert.equal(room.name.isWellFormed(), true, `the stored name is not well formed: ${JSON.stringify(room.name)}`)
  assert.equal(roundTrips(room.name), true, 'the stored name survives a UTF-8 round trip')
  assert.equal(name.startsWith(room.name), true, 'the bound only drops a tail, so the stored name is a prefix of what was typed')
  assert.equal(room.name, 'r'.repeat(ROOM_NAME_MAX - 1))
})

test('update_group stores the same bounded, well-formed notice and name (P-299)', async (t) => {
  const { tool, saved, stop } = start()
  t.after(stop)
  await tool('create_group', { members: ['Writer'], name: 'War', notice: 'Be nice.' }, 'm1')
  const notice = `${'b'.repeat(ROOM_NOTICE_MAX - 1)}\u{1F600}TAIL`
  const name = `${'s'.repeat(ROOM_NAME_MAX - 1)}\u{1F600}`

  assert.match(await tool('update_group', { group: 'War', notice }, 'm1'), /^Updated "War"/)
  assert.match(await tool('update_group', { group: 'War', name }, 'm1'), /^Updated "s/)
  const state = saved()
  const room = Object.values(state.rooms).find(entry => entry.name.startsWith('s'))
  assert.ok(room, 'the group is stored under its new name')
  assert.equal(room.notice, 'b'.repeat(ROOM_NOTICE_MAX - 1))
  assert.equal(room.notice.isWellFormed(), true, `the updated notice is not well formed: ${JSON.stringify(room.notice)}`)
  assert.equal(room.name, 's'.repeat(ROOM_NAME_MAX - 1))
  assert.equal(room.name.isWellFormed(), true, `the updated name is not well formed: ${JSON.stringify(room.name)}`)
  // Clearing the notice is not a cut: it still stores the empty string the user asked for.
  assert.match(await tool('update_group', { group: room.name, notice: '' }, 'm1'), /^Updated/)
  assert.equal(Object.values(saved().rooms).find(entry => entry.name === room.name).notice, '')
})

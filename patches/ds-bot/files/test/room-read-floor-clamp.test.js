// P-676: read_group_chat resolves its own floor from the Bot's participant record and filters on it
// directly, so the #2754 clamp — which the room reads of a human actor already use — never runs for a
// Bot's read. A stored join floor above room.seq then hides every line from that Bot alone: the same
// room answers "has no messages yet" here while the pane and every other reader still show lines.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const T0 = 1_760_000_000_000
const line = (seq, who, text) => ({ seq, who, text, time: T0 + seq * 1000 })
const lines = count => Array.from({ length: count }, (_, i) => line(i + 1, i % 2 === 0 ? 'Chief' : 'Writer', `message ${i + 1}: the merge queue slipped again`))
const seat = (id, joinedSeq, joinedAt = T0) => ({ kind: 'bot', id, role: id === 'a' ? 'admin' : 'member', displayName: id === 'a' ? 'Chief' : 'Writer', joinedSeq, joinedAt })

async function start(t, log, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-p676-'))
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
  const warnings = []
  ctx.logger = { ...(ctx.logger ?? {}), warn: (...args) => warnings.push(args) }
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
  return { rt, tool, warnings }
}

const transcript = kept => kept.map(l => `${l.who}: ${l.text}`).join('\n')

// RED today: the Bot's seat says it joined at 9 in a room whose counter is 5, and this read answers
// "has no messages yet" although the room holds five lines.
test('P-676: a Bot reads a room whose stored join floor is above room.seq', async (t) => {
  const five = lines(5)
  const host = await start(t, five, { participants: [seat('a', 0), seat('b', 9)] })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.doesNotMatch(out, /has no messages yet/, `a room with lines reads as empty: ${out}`)
  // Same window #2754 opens for a human actor: from room.seq, the line the seat would have joined at.
  assert.equal(out, `Latest in "Ops" (oldest first):\n${transcript(five.slice(-1))}`)
})

// The window heals on read, exactly like the human path: the clamped floor is memoised at the seq of
// the first read, so the line it opened on stays shown once the room's counter moves past it.
test('P-676: the clamped window opens onto lines that arrive afterwards', async (t) => {
  const five = lines(5)
  const host = await start(t, five, { participants: [seat('a', 0), seat('b', 9)] })
  const first = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(first, `Latest in "Ops" (oldest first):\n${transcript(five.slice(-1))}`)
  const room = host.rt.state.rooms.r1
  const next = line(6, 'Writer', 'message 6: the queue moved again')
  room.log = [...room.log, next]
  room.seq = 6
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, `Latest in "Ops" (oldest first):\n${transcript([...five.slice(-1), next])}`, 'the window opens at the seq of the first read')
})

// Healthy floors keep their rows: no clamp, no warning, and the read stays windowed on its seat.
test('P-676 guard: a healthy floor is not clamped', async (t) => {
  const five = lines(5)
  const host = await start(t, five, { participants: [seat('a', 0), seat('b', 3)] })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, `Latest in "Ops" (oldest first):\n${transcript(five.slice(2))}`)
  const founder = await host.tool('read_group_chat', { group: 'Ops' }, 'ga')
  assert.equal(founder, `Latest in "Ops" (oldest first):\n${transcript(five)}`)
  assert.equal(host.warnings.filter(w => String(w[0]).includes('join floor above')).length, 0)
})

// An empty room keeps its sentence.
test('P-676 guard: an empty room is unchanged', async (t) => {
  const empty = await start(t, [])
  assert.equal(await empty.tool('read_group_chat', { group: 'Ops' }, 'gb'), '"Ops" has no messages yet.')
})

// A room saved before `seq` existed has no counter to clamp to: its stored log's last seq is the
// number `ensureLog` would write next, never 0 (0 would hand the Bot lines from before it joined).
test('P-676: a room without seq clamps to its stored log', async (t) => {
  const five = lines(5)
  const legacy = await start(t, five, { participants: [seat('a', 0), seat('b', 9)] })
  delete legacy.rt.state.rooms.r1.seq
  const out = await legacy.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, `Latest in "Ops" (oldest first):\n${transcript(five.slice(-1))}`, 'a room without seq clamps to its stored log')
})

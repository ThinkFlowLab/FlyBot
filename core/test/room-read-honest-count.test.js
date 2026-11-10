// #2780: read_group_chat shows the newest 30 room lines and says nothing about the rest, so a
// cut log reads as the whole log.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const T0 = 1_760_000_000_000
const line = (seq, who, text) => ({ seq, who, text, time: T0 + seq * 1000 })
const lines = (count, from = 0) => Array.from({ length: count }, (_, i) => line(from + i, from + i === 0 || (from + i) % 2 === 0 ? 'Chief' : 'Writer', `message ${from + i}: the merge queue slipped again`))
const shownLines = out => out.split('\n').filter(l => /^(Chief|Writer): /.test(l))

async function start(t, log, room = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-p658-'))
  const seed = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log, seq: (log.at(-1)?.seq ?? -1), seen: {}, ...room } },
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
  return { tool }
}

// RED today: 45 stored lines, the newest 30 shown, and nothing says 15 were left out.
test('#2780: a room read that cuts the log says how much it left out', async (t) => {
  const host = await start(t, lines(45))
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 30)
  assert.match(out, /newest 30 of 45/, `no count of what was left out: ${out.split('\n')[0]}`)
  assert.match(out, /^Latest in "Ops" \(newest 30 of 45, oldest first\):$/m)
})

// GREEN today, must stay byte-for-byte: a log shorter than the cap reads exactly as now.
test('#2780 guard: a room log under the cap is unchanged', async (t) => {
  const host = await start(t, lines(20))
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, `Latest in "Ops" (oldest first):\n${lines(20).map(l => `${l.who}: ${l.text}`).join('\n')}`)
})

// GREEN today, must stay: lines before the member joined are not "left out" by the cap.
test('#2780 guard: a member that joined late is not told about lines before it joined', async (t) => {
  const host = await start(t, lines(45), { participants: [{ kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: T0 }, { kind: 'bot', id: 'b', role: 'member', displayName: 'Writer', joinedSeq: 20, joinedAt: T0 }] })
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(shownLines(out).length, 25)
  assert.doesNotMatch(out, /newest \d+ of/)
})

// GREEN today, must stay: an empty room keeps its sentence.
test('#2780 guard: an empty room is unchanged', async (t) => {
  const host = await start(t, [])
  const out = await host.tool('read_group_chat', { group: 'Ops' }, 'gb')
  assert.equal(out, '"Ops" has no messages yet.')
})

// #2597: `track_tasks` created the first card of a batch while the later items were still
// being validated, and the batch `save()` only ran after the loop. An item two refusal — the
// `ask` + `column: 'done'` pair — unwound with the first card already in `state.tasks`, so the
// caller was told the batch failed while a card nobody asked for stayed on the board.
// The whole store is compared, not one field, so any other early write shows up too.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
  },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd1'], admin: 'a', mode: 'everyone', named: true, sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'Chief', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd1', role: 'member', displayName: 'Dev1', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-batch-refusal-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'made-1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    try { await ctx.dispose() } catch {}
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const saves = []
  const save = rt.save
  rt.save = async () => { saves.push(1); return save() }
  return { rt, saves }
}

const snapshot = rt => JSON.stringify(rt.state.tasks)

test('a refused batch leaves state.tasks byte-identical (#2597)', async (t) => {
  const { rt, saves } = await start(t)
  const before = snapshot(rt)
  assert.equal(before, '{}')

  await assert.rejects(
    () => rt.trackBotTasks('d1', {
      tasks: [
        { title: 'First card' },
        { title: 'Second card', column: 'done', ask: 'Which one?' },
      ],
    }),
    error => error.code === 'bot/invalid' && /A task that needs an answer cannot be done/.test(error.message),
  )
  assert.equal(snapshot(rt), before, 'the refused batch left the store untouched')
  assert.equal(saves.length, 0, 'a refused batch is never saved')
})

test('a refused batch does not keep an earlier item\'s update to an existing card (#2597)', async (t) => {
  const { rt } = await start(t)
  const [card] = await rt.trackBotTasks('d1', { tasks: [{ title: 'Existing card' }] })
  const before = snapshot(rt)

  // Item one is accepted and would rename the card; item two is refused, so neither may land.
  await assert.rejects(
    () => rt.trackBotTasks('d1', {
      tasks: [
        { id: card.id, title: 'Renamed', note: 'A note' },
        { title: 'Second card', column: 'done', ask: 'Which one?' },
      ],
    }),
    error => error.code === 'bot/invalid' && /A task that needs an answer cannot be done/.test(error.message),
  )
  assert.equal(snapshot(rt), before, 'the refused batch left the existing card untouched')
  assert.equal(rt.state.tasks[card.id].title, 'Existing card')
})

test('an accepted batch creates every card once (#2597)', async (t) => {
  const { rt } = await start(t)
  const cards = await rt.trackBotTasks('d1', {
    tasks: [
      { title: 'First card' },
      { title: 'Second card', column: 'in-progress' },
    ],
  })
  assert.equal(cards.length, 2)
  assert.equal(cards[0].title, 'First card')
  assert.equal(cards[1].title, 'Second card')
  assert.equal(cards[1].status, 'working')
  assert.deepEqual(Object.keys(rt.state.tasks).sort(), [cards[0].id, cards[1].id].sort(), 'both cards landed once')
})

// `rt.taskCounters` adds a card's own `updatedAt` into `workerSeconds`. A card may be stored by
// an older version or edited by hand, so the field can be missing or non-numeric while the lease
// is valid. The arithmetic must guard that operand too: `NaN` would become `null` through JSON
// for every reader of the counter. The numeric case still measures the lease window.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TAKEN_AT = 1_700_000_000_000

const acceptedCard = (updatedAt) => ({
  id: 'task-1',
  title: 'Count the delivery',
  status: 'accepted',
  taskClass: 'work',
  ownerBotId: 'd1',
  createdAt: TAKEN_AT,
  ...(updatedAt === undefined ? {} : { updatedAt }),
  lease: { holder: 'd1', takenAt: TAKEN_AT, expiresAt: TAKEN_AT + 1_800_000 },
})

const seed = (task) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {},
  grants: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  tasks: { [task.id]: task },
})

async function boot(t, task) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-counters-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(task)))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const inbox = { nextStep: [], nextTurn: [], remove() { return true } }
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle', inbox,
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {},
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
  return rt
}

test('a non-numeric or missing updatedAt keeps workerSeconds finite (#2588)', async (t) => {
  for (const updatedAt of ['not-a-number', undefined, null]) {
    const rt = await boot(t, acceptedCard(updatedAt))
    const counts = rt.taskCounters()
    const workerSeconds = counts.roles.Dev.workerSeconds
    assert.equal(Number.isFinite(workerSeconds), true, `updatedAt=${String(updatedAt)} gave workerSeconds=${workerSeconds}`)
    const throughJson = JSON.parse(JSON.stringify(counts)).roles.Dev.workerSeconds
    assert.notEqual(throughJson, null, `updatedAt=${String(updatedAt)} serialised to null`)
  }
})

test('a numeric updatedAt still measures the lease window (#2588)', async (t) => {
  const rt = await boot(t, acceptedCard(TAKEN_AT + 90_000))
  assert.equal(rt.taskCounters().roles.Dev.workerSeconds, 90)
})

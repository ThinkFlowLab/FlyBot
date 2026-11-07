// #2596: a request that ends in a refusal must not leave a partial write behind. `applyFields`
// assigned `task.title` before it read `priority` and `progress`, and `task-update` applied the
// fields before it read `column`, so a body refused with `bot/invalid` had already renamed the
// stored card. The whole store is compared, not one field, so any other early write shows up too.
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-partial-write-'))
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
  return { rt, home }
}

const snapshot = rt => JSON.stringify(rt.state.tasks)

test('a refused update leaves state.tasks byte-identical (#2596)', async (t) => {
  const app = await start(t)
  const card = await app.rt.taskEndpoint('task-create', { botId: 'd1', title: 'Original', criteria: 'stays put' }, null)
  const id = card.id
  const before = snapshot(app.rt)
  assert.equal(app.rt.state.tasks[id].title, 'Original')

  // A refused priority: `title` is ahead of it in the body, so the rename must not land either.
  await assert.rejects(
    () => app.rt.taskEndpoint('task-update', { id, title: 'Renamed', priority: 'bogus' }, null),
    error => error.code === 'bot/invalid' && /Priority must be urgent, high, normal or low/.test(error.message),
  )
  assert.equal(snapshot(app.rt), before, 'a refused priority leaves state.tasks byte-identical')
  assert.equal(app.rt.state.tasks[id].title, 'Original')

  // A refused progress: the accepted title and priority ahead of it must not land.
  await assert.rejects(
    () => app.rt.taskEndpoint('task-update', { id, title: 'Renamed', priority: 'high', progress: 101 }, null),
    error => error.code === 'bot/invalid' && /Progress must be a whole number from 0 to 100/.test(error.message),
  )
  assert.equal(snapshot(app.rt), before, 'a refused progress leaves state.tasks byte-identical')
  assert.equal(app.rt.state.tasks[id].title, 'Original')
  assert.equal(app.rt.state.tasks[id].priority, undefined)

  // A refused column: the fields applied before `column` was read must not land.
  await assert.rejects(
    () => app.rt.taskEndpoint('task-update', { id, title: 'Renamed', column: 'sideways' }, null),
    error => error.code === 'bot/invalid' && /Column must be not-started, in-progress or done/.test(error.message),
  )
  assert.equal(snapshot(app.rt), before, 'a refused column leaves state.tasks byte-identical')
  assert.equal(app.rt.state.tasks[id].title, 'Original')

  // Control: the same fields all accepted still write, and they write together.
  const updated = await app.rt.taskEndpoint('task-update', { id, title: 'Renamed', priority: 'high', progress: 40 }, null)
  assert.equal(updated.title, 'Renamed')
  assert.equal(app.rt.state.tasks[id].title, 'Renamed')
  assert.equal(app.rt.state.tasks[id].priority, 'high')
  assert.equal(app.rt.state.tasks[id].progress, 40)
})

// #2988: a card reaches its finished state by more than one door, and two of them disagreed about
// the number it draws. A board move to Done sets `progress` to 100 when the request names none
// (`tasks.js` `task-update` / `task-create` / `track_tasks`), and the overall card is set to 100 by
// `settleOverall`, but accepting a result in the Inbox only transitioned the status: the same
// `result-ready` card stored at 60 read 60% after Accept and 100% after a board drag, and an
// accepted card cannot be corrected afterwards. These cases pin the number each door leaves.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { progressOf } from '../src/shared/task-board.js'
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-accept-progress-'))
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
  return { rt }
}

// A card stored at a partial number, ready for the requester to accept the Bot's result.
async function resultReady(rt, progress = 60) {
  const card = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'Ship the fix', criteria: 'the number matches' }, null)
  await rt.taskEndpoint('task-update', { id: card.id, progress }, null)
  await rt.taskEndpoint('task-accept', { id: card.id }, null)
  await rt.taskEndpoint('task-start', { id: card.id }, null)
  await rt.taskEndpoint('task-return', { id: card.id, summary: 'done' }, null)
  assert.equal(rt.state.tasks[card.id].status, 'result-ready')
  assert.equal(rt.state.tasks[card.id].progress, progress)
  return card.id
}

test('the same finished card draws 100% from the board and 60% from the Inbox (#2988)', async (t) => {
  const { rt } = await start(t)
  const board = await resultReady(rt)
  const inbox = await resultReady(rt)
  await rt.taskEndpoint('task-update', { id: board, column: 'done' }, null)
  await rt.taskEndpoint('task-accept-result', { id: inbox }, null)
  assert.equal(rt.state.tasks[board].status, 'accepted')
  assert.equal(rt.state.tasks[inbox].status, 'accepted')
  assert.deepEqual(
    { board: rt.state.tasks[board].progress, inbox: rt.state.tasks[inbox].progress },
    { board: 100, inbox: 100 },
    'the same finished card draws 100% from the board and 60% from the Inbox',
  )
  assert.equal(progressOf(rt.state.tasks[inbox]), 100)
})

test('a board move to done on an accepted card keeps reading 100 (#2988)', async (t) => {
  const { rt } = await start(t)
  const id = await resultReady(rt)
  await rt.taskEndpoint('task-accept-result', { id }, null)
  await rt.taskEndpoint('task-update', { id, column: 'done' }, null)
  assert.equal(rt.state.tasks[id].status, 'accepted')
  assert.equal(rt.state.tasks[id].progress, 100)
  assert.equal(progressOf(rt.state.tasks[id]), 100)
})

test('a cancelled card keeps the number it last stored (#2988)', async (t) => {
  const { rt } = await start(t)
  const id = await resultReady(rt, 60)
  await rt.taskEndpoint('task-cancel', { id }, null)
  assert.equal(rt.state.tasks[id].status, 'cancelled')
  assert.equal(rt.state.tasks[id].progress, 60)
  // Cancelled is not finished: the drawn number stays the stored one, never the done⇒100 default.
  assert.equal(progressOf(rt.state.tasks[id]), 60)
})

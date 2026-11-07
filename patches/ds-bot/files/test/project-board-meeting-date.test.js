// #2587: a `meetings` record whose `decidedAt` / `createdAt` is a non-date string is state an
// older version or a hand edit can leave behind. `text()` only proves the value is a non-empty
// string, so the date line fed `new Date(value).toISOString()` and threw
// `RangeError: Invalid time value` for the whole board read. The meeting now lists with an empty
// date, like the other unreadable fields, and the rest of the board still renders.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p1' } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  projects: {
    'project-p1': { id: 'project-p1', name: 'P1', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' },
  },
  projectRuns: {},
  tasks: {
    'task-group': { id: 'task-group', kind: 'group', status: 'working', ownerBotId: 'a', origin: { roomId: 'r1' }, assignee: 'Writer', title: 'Ship it', createdAt: 5, updatedAt: 10 },
  },
  meetings: {
    // The decided meeting carries the unparseable timestamp the old record may hold.
    m1: { id: 'm1', project: 'project-p1', status: 'decided', question: 'Adopt the record?', decidedAt: 'not-a-date', updatedAt: 10 },
    // The pending list reads `createdAt` on its own line; it must guard the same way.
    m2: { id: 'm2', project: 'project-p1', status: 'open', question: 'Still open?', createdAt: 'not-a-time', updatedAt: 11 },
    // A readable timestamp still formats, so the guard does not blank every date.
    m3: { id: 'm3', project: 'project-p1', status: 'decided', question: 'Keep the date?', decidedAt: '2026-11-01T09:00:00.000Z', updatedAt: 12 },
  },
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  let route
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, rt, stop }
}

test('#2587: a meetings record with a non-date decidedAt does not break the board read', async () => {
  const { rt, call, stop } = await start()
  try {
    const board = await rt.projectBoard('project-p1')
    const decided = board.meetings.decided.find(meeting => meeting.id === 'm1')
    assert.ok(decided, 'the decided meeting is still listed')
    assert.equal(decided.date, '', 'an unreadable decidedAt reads as no date')
    const pending = board.meetings.pending.find(meeting => meeting.id === 'm2')
    assert.ok(pending, 'the pending meeting is still listed')
    assert.equal(pending.date, '', 'an unreadable createdAt reads as no date')
    const dated = board.meetings.decided.find(meeting => meeting.id === 'm3')
    assert.equal(dated.date, '2026-11-01', 'a readable timestamp still formats')
    assert.deepEqual(board.rows.map(row => row.id), ['task-group'], 'the rest of the board still renders')
    // The endpoint the page uses answers the same board, not an error.
    const served = await call('project-board', { id: 'project-p1' })
    assert.equal(served.ok, true, JSON.stringify(served))
    assert.deepEqual(served.value.tasks.map(row => row.id), ['task-group'])
    assert.equal(served.value.meetings.decided.find(meeting => meeting.id === 'm1').date, '')
  } finally {
    await stop()
  }
})

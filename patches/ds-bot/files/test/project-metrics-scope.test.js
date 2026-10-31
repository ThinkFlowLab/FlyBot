// #1848: the board's running table is the board's own cards, not the deployment's. Every branch of
// the metrics read carries the same list the rows were built from, and a card the same actor is
// refused on a row never appears in `running` — the host must not send the titles at all.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-10-30T12:00:00Z')

// Two Projects with two owners, and a card in flight on each one. The second Project's card is the
// leak: it is `claimed`, carries a title and a holder, and the first owner is refused on it.
const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: 'foreign' },
  },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    foreign: { id: 'foreign', name: 'Foreigner Bot', role: 'Bot', sessionId: 'foreign', createdAt: 2, ownerId: 'owner-2' },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p1' },
    r2: { id: 'r2', name: 'Garden', members: ['foreign'], mode: 'admin', admin: 'foreign', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p2' },
  },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  projects: {
    'project-p1': { id: 'project-p1', name: 'P1', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' },
    'project-p2': { id: 'project-p2', name: 'P2', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-2', createdAt: 1, updatedAt: 1, status: 'active' },
  },
  projectRuns: {},
  tasks: {
    // This board: one card in flight, one finished an hour after it started.
    'task-group': { id: 'task-group', kind: 'group', status: 'claimed', claimedBy: 'Writer', claimedAt: NOW - 2 * HOUR, origin: { roomId: 'r1' }, ownerBotId: 'a', assignee: 'Writer', title: 'Ship it', createdAt: 5, updatedAt: NOW - HOUR },
    'task-done-a': { id: 'task-done-a', kind: 'group', status: 'done', origin: { roomId: 'r1' }, ownerBotId: 'a', title: 'Closed on p1', createdAt: NOW - 2 * HOUR, completedAt: NOW - HOUR, updatedAt: NOW - HOUR },
    // The other Project: same shapes, and nine hours from start to done.
    'task-foreign': { id: 'task-foreign', kind: 'group', status: 'claimed', claimedBy: 'Foreigner', claimedAt: NOW - 2 * HOUR, origin: { roomId: 'r2' }, ownerBotId: 'foreign', title: 'Secret salary review', createdAt: 5, updatedAt: NOW - HOUR },
    'task-foreign-done': { id: 'task-foreign-done', kind: 'group', status: 'done', origin: { roomId: 'r2' }, ownerBotId: 'foreign', title: 'Foreign closed', createdAt: NOW - 10 * HOUR, completedAt: NOW - HOUR, updatedAt: NOW - HOUR },
  },
})

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-scope-')), team = seed()) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
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
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  // Somebody has signed in: the row guard of #1723 is on, and the running table must obey it too.
  rt.state.authSessions = { 's-1': { memberId: 'owner-1', tokenHash: 'h1' }, 's-2': { memberId: 'owner-2', tokenHash: 'h2' } }
  rt.now = () => NOW
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, stop }
}

test('#1848: another Project\'s claimed card appears in neither the rows nor the running table', async () => {
  const { rt, stop } = await start()
  const realFetch = globalThis.fetch
  const realSecret = rt.secretValue
  rt.githubRepo = 'test/scope-1'
  // A source that answers, so both boards get to their success branch.
  rt.secretValue = name => (name === 'GITHUB_TOKEN' ? 'tok' : undefined)
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  try {
    // Reading the other Project's board as a member who cannot see its cards.
    const foreign = await rt.projectBoard('project-p2', { memberId: 'owner-1' })
    assert.deepEqual(foreign.rows, [], 'a card of the other Project is not a row here')
    assert.deepEqual(foreign.metrics.running, [], 'and it is not a running row here either')
    // This Project's own board: the one card in flight is one row, and the other Project's card is
    // not beside it.
    const board = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    const rows = board.rows.map(row => row.id)
    assert.equal(rows.includes('task-group'), true)
    assert.equal(rows.some(id => id.startsWith('task-foreign')), false, 'no card of the other Project is a row here')
    assert.deepEqual(board.metrics.running.map(row => row.id), ['task-group'])
    assert.equal(board.metrics.running[0].title, 'Ship it')
  } finally {
    globalThis.fetch = realFetch
    rt.secretValue = realSecret
    await stop()
  }
})

test('#1848: the board\'s own card stays in the running table when the GitHub source is unavailable', async () => {
  const { rt, stop } = await start()
  const realFetch = globalThis.fetch
  const realSecret = rt.secretValue
  rt.githubRepo = 'test/scope-2'
  try {
    // No credential: the four numbers answer `ok: false`, but the running table is local data and
    // must keep the card it can see.
    rt.secretValue = () => undefined
    const noToken = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    assert.equal(noToken.metrics.ok, false)
    assert.equal(noToken.metrics.reason, 'no-credentials')
    assert.deepEqual(noToken.metrics.running.map(row => row.id), ['task-group'])
    // A source that fails answers the same way for the same reason.
    rt.secretValue = name => (name === 'GITHUB_TOKEN' ? 'tok' : undefined)
    globalThis.fetch = async () => { throw new Error('socket hang up') }
    const failed = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    assert.equal(failed.metrics.ok, false)
    assert.match(failed.metrics.reason, /^read-failed:/)
    assert.deepEqual(failed.metrics.running.map(row => row.id), ['task-group'])
  } finally {
    globalThis.fetch = realFetch
    rt.secretValue = realSecret
    await stop()
  }
})

test('#1848: a cache hit and a cache miss carry the same running rows, byte for byte', async () => {
  const { rt, stop } = await start()
  const realFetch = globalThis.fetch
  const realSecret = rt.secretValue
  rt.githubRepo = 'test/scope-3'
  rt.secretValue = name => (name === 'GITHUB_TOKEN' ? 'tok' : undefined)
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  try {
    const miss = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    assert.equal(miss.metrics.cache, 'miss')
    // Same instant, so the second read is the cache hit and its numbers come from the cache.
    const hit = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    assert.equal(hit.metrics.cache, 'hit')
    assert.deepEqual(hit.metrics.running, miss.metrics.running)
    assert.deepEqual(miss.metrics.running.map(row => row.id), ['task-group'])
    assert.equal(JSON.stringify(hit.metrics.running), JSON.stringify(miss.metrics.running))
  } finally {
    globalThis.fetch = realFetch
    rt.secretValue = realSecret
    await stop()
  }
})

test('#1848: the done-task median is this board\'s cards, not the deployment\'s', async () => {
  const { rt, stop } = await start()
  const realFetch = globalThis.fetch
  const realSecret = rt.secretValue
  rt.githubRepo = 'test/scope-4'
  rt.secretValue = name => (name === 'GITHUB_TOKEN' ? 'tok' : undefined)
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  try {
    const board = await rt.projectBoard('project-p1', { memberId: 'owner-1' })
    // One card finished an hour after it started here; the other Project's nine-hour card is not
    // this board's work.
    assert.equal(board.metrics.metrics.taskDoneMedianMs, HOUR)
  } finally {
    globalThis.fetch = realFetch
    rt.secretValue = realSecret
    await stop()
  }
})

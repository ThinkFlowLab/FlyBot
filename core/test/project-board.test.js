// One Project, one board (#1696): a core task record is the identity, and a workflow run names
// that same id through `run.task.id`. The aggregate reads both views as one row, never twice,
// and writes nothing back.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    runner: { id: 'runner', name: 'Runner', role: 'Run', sessionId: 'runner', createdAt: 2, ownerId: 'owner-1' },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p1' } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  projects: {
    'project-p1': { id: 'project-p1', name: 'P1', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' },
    'project-empty': { id: 'project-empty', name: 'Empty', repository: null, defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 2, updatedAt: 2, status: 'active' },
  },
  projectRuns: { 'run-1': 'project-p1' },
  tasks: {
    // A group card a run consumed: its board carries the Project.
    'task-group': { id: 'task-group', kind: 'group', status: 'working', ownerBotId: 'a', origin: { roomId: 'r1' }, assignee: 'Writer', title: 'Ship it', createdAt: 5, updatedAt: 10 },
    // A card the run created: no board Project, the run's binding carries it.
    'task-run': { id: 'task-run', status: 'working', ownerBotId: 'runner', title: 'Run card', createdAt: 7, updatedAt: 20 },
  },
})

// #1713: a second Project whose run holds the first Project's card. Nothing here belongs in
// `seed()`: the leak needs a run binding of the far Project on a card that has a board of its own.
const splitSeed = () => {
  const team = seed()
  team.rooms.r2 = { id: 'r2', name: 'Garden', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p2' }
  team.projects['project-p2'] = { id: 'project-p2', name: 'P2', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' }
  team.projectRuns = { 'run-1': 'project-p1', 'run-2': 'project-p2' }
  return team
}

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-board-')), team = seed()) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
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
  // The same route with the member session cookie the browser sends, for the authz-on case.
  const callAs = async (endpoint, payload, token) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-flybot-member-session': token },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, callAs, stop, rt }
}

const value = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.value
}

// The group board's card and the run's card are two tasks, and each one is one row.
test('a Project board reads a group card and a run-created card without repeating a task', async () => {
  const { rt, stop } = await start()
  const off = rt.onProjectProvider(({ hasTask }) => [
    // A run consumed the group card: same id, so it joins that row instead of adding one.
    { taskId: 'task-group', runId: 'run-2', nodeId: 'planner' },
    // The run created this card and its own Project binding carries it.
    { taskId: 'task-run', runId: 'run-1', nodeId: 'writer' },
    // A run whose card is gone is not a row.
    { taskId: 'task-missing', runId: 'run-3' },
  ].filter(row => hasTask(row.taskId)))
  try {
    const rows = rt.projectBoard('project-p1')
    assert.equal(rows.length, 2)
    const group = rows.find(row => row.id === 'task-group')
    assert.deepEqual(group, { id: 'task-group', source: 'group', column: 'in-progress', assignee: 'Writer', updatedAt: 10, runId: 'run-2', nodeId: 'planner' })
    const run = rows.find(row => row.id === 'task-run')
    assert.deepEqual(run, { id: 'task-run', source: 'workflow', column: 'in-progress', assignee: null, updatedAt: 20, runId: 'run-1', nodeId: 'writer' })
    // Never the same task twice.
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  } finally {
    off()
    await stop()
  }
})

test('an empty Project answers [] and a missing one is not an error', async () => {
  const { rt, stop } = await start()
  try {
    // Without a provider the group board still reads on its own; the run-created card has no
    // board of its own and no run binding to give, so it is not a row.
    assert.deepEqual(rt.projectBoard('project-p1').map(row => [row.id, row.source]), [['task-group', 'group']])
    assert.deepEqual(rt.projectBoard('project-empty'), [])
    assert.deepEqual(rt.projectBoard('project-nothing'), [])
    assert.deepEqual(rt.projectBoard(''), [])
  } finally { await stop() }
})

test('reading the board leaves state.tasks and the run refs byte-identical', async () => {
  const { rt, stop } = await start()
  const refs = () => [{ taskId: 'task-group', runId: 'run-2' }, { taskId: 'task-run', runId: 'run-1' }]
  const off = rt.onProjectProvider(() => refs())
  try {
    const before = JSON.stringify({ tasks: rt.state.tasks, projects: rt.state.projects, projectRuns: rt.state.projectRuns })
    const refsBefore = JSON.stringify(rt.projectRunRefs())
    rt.projectBoard('project-p1')
    assert.equal(JSON.stringify({ tasks: rt.state.tasks, projects: rt.state.projects, projectRuns: rt.state.projectRuns }), before)
    assert.equal(JSON.stringify(rt.projectRunRefs()), refsBefore)
  } finally {
    off()
    await stop()
  }
})

test('the project-board endpoint serves the same rows', async () => {
  const { rt, call, stop } = await start()
  const off = rt.onProjectProvider(() => [{ taskId: 'task-group', runId: 'run-2' }])
  try {
    const rows = value(await call('project-board', { id: 'project-p1' })).tasks
    assert.deepEqual(rows.map(row => row.id), ['task-group'])
    assert.equal(rows[0].runId, 'run-2')
    assert.deepEqual(value(await call('project-board', { id: 'project-nothing' })).tasks, [])
  } finally {
    off()
    await stop()
  }
})

// #1713 A: the endpoint is wired, the store is wired, only the allowlist line was missing, so a
// signed-in deployment answered `bot/not-found: Unknown endpoint project-board` while every
// sibling Project read answered ALLOW under the same actor.
test('#1713: a signed-in actor may read the Project board, like the Project record', async () => {
  const { rt, callAs, stop } = await start()
  try {
    // Enforced means someone has signed in on this host; before that every endpoint answers.
    rt.authenticate = async (token) => (token === 'tok-a' ? { memberId: 'owner-1' } : null)
    rt.state.authSessions = { 's-a': { memberId: 'owner-1', tokenHash: 'a' } }
    const actor = { memberId: 'owner-1' }
    for (const endpoint of ['projects', 'project-read', 'project-of', 'project-bind']) {
      assert.equal(rt.authorize(actor, endpoint, { id: 'project-p1' }).ok, true, `${endpoint} answers ALLOW`)
    }
    const gate = rt.authorize(actor, 'project-board', { id: 'project-p1' })
    assert.equal(gate.ok, true, `project-board is refused as ${gate.code}: ${gate.message}`)
    // The same answer through the channel with the member cookie, not just the allowlist table.
    const served = await callAs('project-board', { id: 'project-p1' }, 'tok-a')
    assert.equal(served.ok, true, JSON.stringify(served))
    assert.deepEqual(served.value.tasks.map(row => row.id), ['task-group'])
  } finally { await stop() }
})

// #1713 B: a run of the far Project holds this Project's card; the card belongs to the Project of
// its own board, and the far board must not inherit it (nor lend its run id to this one).
test('#1713: a run binding never carries another Project’s card onto a board', async () => {
  const { rt, stop } = await start(undefined, splitSeed())
  const off = rt.onProjectProvider(() => [{ taskId: 'task-group', runId: 'run-2' }, { taskId: 'task-run', runId: 'run-1' }])
  try {
    const p1 = rt.projectBoard('project-p1')
    // Rows come newest first, so the identity of a row is its id and source, not its position.
    assert.deepEqual(p1.map(row => `${row.id}:${row.source}`).sort(), ['task-group:group', 'task-run:workflow'])
    const group = p1.find(row => row.id === 'task-group')
    assert.equal(group.runId, undefined, 'a row of this Project never carries another Project’s run id')
    // Project 2 does not inherit a card whose own board already names Project 1.
    assert.deepEqual(rt.projectBoard('project-p2'), [], 'the far Project lists no card of this one')
  } finally {
    off()
    await stop()
  }
})

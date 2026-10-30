// One Project, one board (#1696): a core task record is the identity, and a workflow run names
// that same id through `run.task.id`. The aggregate reads both views as one row, never twice,
// and writes nothing back.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    const rows = (await rt.projectBoard('project-p1')).rows
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

test('the board takes its token from the host secret store and its zone from the call', async () => {
  const { rt, stop } = await start()
  const realSecret = rt.secretValue
  const realFetch = globalThis.fetch
  const asked = []
  const calls = []
  rt.secretValue = name => { asked.push(name); return name === 'GITHUB_TOKEN' ? 'tok' : undefined }
  globalThis.fetch = async (url, init) => { calls.push([String(url), init.headers.Authorization]); return { ok: true, json: async () => [] } }
  try {
    const board = await rt.projectBoard('project-p1', null, { timeZone: 'Asia/Shanghai' })
    // #1829: the numbers can only render when the token comes from the same store connectors.js
    // reads, and the natural day is the reader's zone, which the request carries.
    assert.equal(asked.includes('GITHUB_TOKEN'), true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0][1], 'Bearer tok')
    assert.equal(board.metrics.ok, true)
    assert.equal(board.metrics.timeZone, 'Asia/Shanghai')
    // No zone in the call falls back to UTC instead of the host's own idea of a day.
    calls.length = 0
    const plain = await rt.projectBoard('project-p1')
    assert.equal(plain.metrics.timeZone, 'UTC')
  } finally {
    globalThis.fetch = realFetch
    rt.secretValue = realSecret
    await stop()
  }
})

test('an empty Project answers [] and a missing one is not an error', async () => {
  const { rt, stop } = await start()
  try {
    // Without a provider the group board still reads on its own; the run-created card has no
    // board of its own and no run binding to give, so it is not a row.
    assert.deepEqual((await rt.projectBoard('project-p1')).rows.map(row => [row.id, row.source]), [['task-group', 'group']])
    assert.deepEqual((await rt.projectBoard('project-empty')).rows, [])
    assert.deepEqual((await rt.projectBoard('project-nothing')).rows, [])
    assert.deepEqual((await rt.projectBoard('')).rows, [])
  } finally { await stop() }
})

test('reading the board leaves state.tasks and the run refs byte-identical', async () => {
  const { rt, stop } = await start()
  const refs = () => [{ taskId: 'task-group', runId: 'run-2' }, { taskId: 'task-run', runId: 'run-1' }]
  const off = rt.onProjectProvider(() => refs())
  try {
    const before = JSON.stringify({ tasks: rt.state.tasks, projects: rt.state.projects, projectRuns: rt.state.projectRuns })
    const refsBefore = JSON.stringify(rt.projectRunRefs())
    await rt.projectBoard('project-p1')
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
    const p1 = (await rt.projectBoard('project-p1')).rows
    // Rows come newest first, so the identity of a row is its id and source, not its position.
    assert.deepEqual(p1.map(row => `${row.id}:${row.source}`).sort(), ['task-group:group', 'task-run:workflow'])
    const group = p1.find(row => row.id === 'task-group')
    assert.equal(group.runId, undefined, 'a row of this Project never carries another Project’s run id')
    // Project 2 does not inherit a card whose own board already names Project 1.
    assert.deepEqual((await rt.projectBoard('project-p2')).rows, [], 'the far Project lists no card of this one')
  } finally {
    off()
    await stop()
  }
})

// #1723: the board is the one Project read that never carried the caller, so it painted a card
// that `tasks` refuses to the same member. A second owner with its own Bot, room and Project is
// what the leak needs; nothing here belongs in `seed()`.
const crossSeed = () => {
  const team = seed()
  team.members['owner-2'] = { id: 'owner-2', createdAt: 2, designatedChiefId: null }
  team.bots.b = { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 3, ownerId: 'owner-2' }
  team.rooms.r2 = { id: 'r2', name: 'Garden', members: ['b'], mode: 'admin', admin: 'b', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p2' }
  team.projects['project-p2'] = { id: 'project-p2', name: 'P2', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-2', createdAt: 1, updatedAt: 1, status: 'active' }
  team.tasks['task-b1'] = { id: 'task-b1', kind: 'group', status: 'working', ownerBotId: 'b', origin: { roomId: 'r2' }, assignee: 'Writer', title: 'Write it', createdAt: 6, updatedAt: 10 }
  return team
}

test('#1723: a Project board paints only the cards `tasks` would let the member open', async () => {
  const { rt, callAs, stop } = await start(undefined, crossSeed())
  try {
    rt.authenticate = async token => (token === 'tok-1' ? { memberId: 'owner-1' } : token === 'tok-2' ? { memberId: 'owner-2' } : null)
    rt.state.authSessions = { 's-1': { memberId: 'owner-1', tokenHash: 'a' }, 's-2': { memberId: 'owner-2', tokenHash: 'b' } }
    // The card `tasks` refuses to member A is the one the board must not paint for it.
    const refused = await callAs('tasks', { botId: 'b' }, 'tok-1')
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'bot/forbidden', JSON.stringify(refused))
    const theirs = await callAs('project-board', { id: 'project-p2' }, 'tok-1')
    assert.equal(theirs.ok, true, JSON.stringify(theirs))
    assert.deepEqual(theirs.value.tasks ?? [], [], 'member A reads nothing of member B’s board')
    // Member B reads the same board and still gets its card.
    const own = await callAs('project-board', { id: 'project-p2' }, 'tok-2')
    assert.equal(own.ok, true, JSON.stringify(own))
    assert.deepEqual(own.value.tasks.map(row => row.id), ['task-b1'])
    // #1716's same-owner ALLOW and #1715's empty board stay as they were.
    const p1 = await callAs('project-board', { id: 'project-p1' }, 'tok-1')
    assert.deepEqual(p1.value.tasks.map(row => row.id), ['task-group'])
    const empty = await callAs('project-board', { id: 'project-empty' }, 'tok-1')
    assert.equal(empty.ok, true, JSON.stringify(empty))
    assert.deepEqual(empty.value.tasks, [])
  } finally { await stop() }
})

// #1767: the record beside the cards. The Project's working folder holds two decision files and
// one meeting reached `decided`; the board lists exactly those, with the hash it computed, and a
// meeting still deliberating is never listed as a decision.
const recordSeed = () => {
  const team = seed()
  team.projects['project-p1'].workDir = '__WORKDIR__'
  team.meetings = {
    'meeting-decided': {
      id: 'meeting-decided', status: 'decided', question: 'Which board carries the record?',
      owner: 'Chief', project: 'project-p1', decisionFile: 'decisions/2026-10-30-adopt.md',
      createdAt: 1, updatedAt: 5, decidedAt: 6,
    },
    'meeting-open': {
      id: 'meeting-open', status: 'deliberating', question: 'Should the board page?',
      project: 'P1', createdAt: 2, updatedAt: 3,
    },
    'meeting-blocked': {
      id: 'meeting-blocked', status: 'blocked', question: 'Who owns the archive?',
      project: 'project-p1', blockingQuestion: 'The maintainer has not named an owner.',
      createdAt: 2, updatedAt: 4,
    },
    'meeting-other': {
      id: 'meeting-other', status: 'decided', question: 'Another Project’s question',
      owner: 'Chief', project: 'project-p2', decisionFile: 'decisions/2026-10-30-elsewhere.md',
      createdAt: 1, updatedAt: 2, decidedAt: 3,
    },
  }
  return team
}

// The State reader answers for a repository, so the fixture is one; the decisions folder only
// exists once this test makes it, which is the read the board performs.
const folderWithDecisions = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-decisions-'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, 'decisions'))
  writeFileSync(join(dir, 'decisions', '2026-10-30-adopt.md'), '# Adopt the board record\n\nThe board lists this file.\n')
  writeFileSync(join(dir, 'decisions', '2026-10-30-second.md'), '# Keep decisions small\n')
  return dir
}

async function startWithRecord() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  const dir = folderWithDecisions()
  const team = recordSeed()
  team.projects['project-p1'].workDir = dir
  const started = await start(home, team)
  return { ...started, home, dir }
}

test('#1767: the board lists two decisions with their hash and one decided meeting', async () => {
  const { rt, call, home, dir, stop } = await startWithRecord()
  try {
    const board = await rt.projectBoard('project-p1')
    assert.equal(board.decisions.dir, dir)
    assert.deepEqual(board.decisions.files.map(file => file.path), ['decisions/2026-10-30-adopt.md', 'decisions/2026-10-30-second.md'])
    assert.deepEqual(board.decisions.files.map(file => file.date), ['2026-10-30', '2026-10-30'])
    assert.deepEqual(board.decisions.files.map(file => file.title), ['Adopt the board record', 'Keep decisions small'])
    for (const file of board.decisions.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, 'every decision carries the hash the reader computed')
      assert.equal(file.bytes, statSync(join(dir, file.path)).size)
      assert.equal(file.mtime, new Date(statSync(join(dir, file.path)).mtimeMs).toISOString())
    }
    // One decided meeting, linked to its file; the deliberating and blocked ones are apart, and a
    // meeting of another Project is not here at all.
    assert.deepEqual(board.meetings.decided.map(meeting => meeting.id), ['meeting-decided'])
    assert.equal(board.meetings.decided[0].path, 'decisions/2026-10-30-adopt.md')
    assert.equal(board.meetings.decided[0].owner, 'Chief')
    assert.equal(board.meetings.decided[0].question, 'Which board carries the record?')
    assert.deepEqual(board.meetings.pending.map(meeting => meeting.status).sort(), ['blocked', 'deliberating'])
    assert.equal(board.meetings.pending.some(meeting => meeting.id === 'meeting-decided'), false, 'a decided meeting is never pending')
    assert.equal(board.meetings.decided.some(meeting => meeting.id === 'meeting-open'), false, 'a deliberating meeting is never a decision')
    // The same read through the endpoint the page uses: `tasks` unchanged, two new keys.
    const served = value(await call('project-board', { id: 'project-p1' }))
    assert.deepEqual(served.tasks.map(row => row.id), ['task-group'])
    assert.equal(served.decisions.files.length, 2)
    assert.deepEqual(served.meetings.decided.map(meeting => meeting.id), ['meeting-decided'])
    // Nothing wrote: the team file is the bytes it was when the read began.
    const before = readFileSync(join(home, 'state.json'))
    const reread = value(await call('project-board', { id: 'project-p1' }))
    assert.equal(reread.decisions.files.length, 2)
    assert.deepEqual(readFileSync(join(home, 'state.json')), before, 'reading the board writes nothing')
  } finally {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1767: a deleted decision file leaves the next read, and a decided meeting still reads decided', async () => {
  const { rt, dir, stop } = await startWithRecord()
  try {
    rmSync(join(dir, 'decisions', '2026-10-30-second.md'))
    const afterDelete = await rt.projectBoard('project-p1')
    assert.deepEqual(afterDelete.decisions.files.map(file => file.path), ['decisions/2026-10-30-adopt.md'])
    // The archived file the decided meeting names is removed too: the meeting is the record and
    // stays listed, with no path — the file is gone, not the decision.
    rmSync(join(dir, 'decisions', '2026-10-30-adopt.md'))
    const gone = await rt.projectBoard('project-p1')
    assert.equal(gone.decisions.files.length, 0)
    assert.match(gone.decisions.reason, /no decision file in .*decisions/)
    assert.deepEqual(gone.meetings.decided.map(meeting => [meeting.id, meeting.path]), [['meeting-decided', '']])
  } finally {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1767: a Project without a decisions folder answers an empty list with the reason, never a throw', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-nodecisions-'))
  mkdirSync(join(dir, '.git'))
  const team = recordSeed()
  team.projects['project-p1'].workDir = dir
  const { rt, call, stop } = await start(home, team)
  try {
    const board = await rt.projectBoard('project-p1')
    assert.deepEqual(board.decisions.files, [])
    assert.match(board.decisions.reason, /no decision file in .*decisions/, 'the empty state names the folder it read')
    assert.deepEqual(board.meetings.decided.map(meeting => [meeting.id, meeting.path]), [['meeting-decided', '']])
    // A Project naming no folder is an answer too.
    const noFolder = await rt.projectBoard('project-empty')
    assert.deepEqual(noFolder.decisions.files, [])
    assert.match(noFolder.decisions.reason, /no working folder/)
    const served = value(await call('project-board', { id: 'project-p1' }))
    assert.deepEqual(served.decisions.files, [])
    assert.match(served.decisions.reason, /no decision file/)
  } finally {
    await stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// #1768: the queue, the leases and the blocked cards beside the columns. The seed adds one card of
// each shape on Project 1 and one on Project 2, so every group can be asked what it must not show.
const queueSeed = () => {
  const team = seed()
  team.rooms.r2 = { id: 'r2', name: 'Garden', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p2' }
  team.projects['project-p2'] = { id: 'project-p2', name: 'P2', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' }
  team.tasks['task-w1'] = { id: 'task-w1', kind: 'group', status: 'open', queueRole: 'Dev', queueBy: 'a', origin: { roomId: 'r1' }, title: 'First queued', createdAt: 10, updatedAt: 10 }
  team.tasks['task-w2'] = { id: 'task-w2', kind: 'group', status: 'open', queueRole: 'Dev', queueBy: 'a', origin: { roomId: 'r1' }, title: 'Second queued', createdAt: 20, updatedAt: 20 }
  team.tasks['task-hold'] = { id: 'task-hold', kind: 'group', status: 'claimed', queueRole: 'Dev', claimedBy: 'Dev1', origin: { roomId: 'r1' }, title: 'Claimed', lease: { holder: 'Dev1', takenAt: Date.now() - 1000, expiresAt: Date.now() + 600000 }, createdAt: 30, updatedAt: 30 }
  team.tasks['task-blocked'] = { id: 'task-blocked', kind: 'group', status: 'blocked', waitingFor: 'input', origin: { roomId: 'r1' }, title: 'Blocked card', inputRequest: { id: 'q1', question: 'Which branch should this ship on?' }, createdAt: 40, updatedAt: 40 }
  team.tasks['task-far'] = { id: 'task-far', kind: 'group', status: 'open', queueRole: 'Dev', queueBy: 'a', origin: { roomId: 'r2' }, title: 'Other Project', createdAt: 50, updatedAt: 50 }
  return team
}

test('#1768: two queued cards and one claimed read as 2 waiting / 1 in flight, holder named', async () => {
  const { rt, stop } = await start(undefined, queueSeed())
  try {
    const queues = await rt.projectBoardQueues('project-p1')
    assert.equal(queues.counts.waiting, 2)
    assert.equal(queues.counts.inflight, 1)
    // Oldest wait first, with the role it is queued for.
    assert.deepEqual(queues.waiting.map(item => item.id), ['task-w1', 'task-w2'])
    assert.deepEqual(queues.waiting.map(item => item.role), ['Dev', 'Dev'])
    assert.ok(Number.isFinite(queues.waiting[0].waitedMs) && queues.waiting[0].waitedMs >= queues.waiting[1].waitedMs)
    // The holder is the member that claimed it, and a live lease reads running.
    assert.deepEqual(queues.inflight.map(item => [item.id, item.holder, item.lease, item.stalled]), [['task-hold', 'Dev1', 'live', false]])
  } finally { await stop() }
})

test('#1768: an expired lease reads stalled and the card record does not move', async () => {
  const { rt, stop } = await start(undefined, queueSeed())
  try {
    const before = JSON.stringify(rt.state.tasks['task-hold'])
    rt.state.tasks['task-hold'].lease.expiresAt = Date.now() - 1000
    const moved = JSON.stringify(rt.state.tasks['task-hold'])
    assert.notEqual(moved, before, 'the test moved the lease itself')
    const queues = await rt.projectBoardQueues('project-p1')
    assert.deepEqual(queues.inflight.map(item => [item.id, item.stalled, item.lease]), [['task-hold', true, 'expired']])
    assert.equal(JSON.stringify(rt.state.tasks['task-hold']), moved, 'reading the board wrote nothing')
  } finally { await stop() }
})

test('#1768: a blocked card carries its own reason and another Project is in none of the groups', async () => {
  const { rt, stop } = await start(undefined, queueSeed())
  try {
    const queues = await rt.projectBoardQueues('project-p1')
    assert.deepEqual(queues.blocked.map(item => [item.id, item.reason]), [['task-blocked', 'Which branch should this ship on?']])
    // task-far is queued for the same role but lives on Project 2, and the counts are this Project's.
    const ids = [...queues.waiting, ...queues.inflight, ...queues.blocked].map(item => item.id)
    assert.ok(!ids.includes('task-far'), JSON.stringify(ids))
    assert.deepEqual([queues.counts.waiting, queues.counts.inflight, queues.counts.blocked], [2, 1, 1])
  } finally { await stop() }
})

test('#1768: an unreadable queue answers unknown, never zero', async () => {
  const { rt, stop } = await start(undefined, queueSeed())
  try {
    rt.state.tasks = null
    const queues = await rt.projectBoardQueues('project-p1')
    assert.deepEqual(queues.counts, { waiting: null, inflight: null, blocked: null, done: null })
    assert.deepEqual([queues.waiting, queues.inflight, queues.blocked], [[], [], []])
  } finally { await stop() }
})

// #1809: `meeting decide` archives its file in the Session's working folder, while the board read
// only the Project's own folder — so a default install showed an empty Decisions section and the
// decided meeting as `decision file gone` while the file sat on disk. These cases drive the real
// `meeting` tool (open → three positions → decide) and then read the board.
const meetingTeam = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Chief', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1' },
    r1: { id: 'r1', name: 'Reviewer', role: 'Reviewer', sessionId: 'r1', createdAt: 3, ownerId: 'owner-1' },
  },
  rooms: {
    'room-1': { id: 'room-1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p1' },
    'room-2': { id: 'room-2', name: 'Garden', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {}, projectId: 'project-p2' },
  },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  projects: {
    'project-p1': { id: 'project-p1', name: 'P1', repository: null, defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' },
    'project-p2': { id: 'project-p2', name: 'P2', repository: null, defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 2, updatedAt: 2, status: 'active' },
  },
  projectRuns: {}, tasks: {}, meetings: {},
})

async function startWithMeetings({ project, room, session, team = meetingTeam() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  const teamDir = mkdtempSync(join(tmpdir(), 'ds-bot-team-'))
  if (project !== undefined) team.projects['project-p1'].workDir = project
  if (room !== undefined) team.rooms['room-1'].workDir = room
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    // The team folder a default install resolves to: the workspace the Session works in.
    workspaceRegistry: { get: () => ({ id: 'w1', path: teamDir }), resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const exec = { agent: { id: 'a', session: { header: { cwd: session ?? teamDir } } } }
  const meeting = args => ctx.registeredTools.get('meeting').execute(args, exec)
  const decide = async (projectId, question) => {
    const id = (await meeting({ action: 'open', question, participants: ['Chief', 'Dev', 'Reviewer'], project: projectId })).split(' ')[0]
    for (const name of ['Chief', 'Dev', 'Reviewer']) await meeting({ action: 'position', meeting: id, as: name, stance: 'agree', text: `${name} agrees` })
    await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Archive where the Session works.' })
    return id
  }
  const stop = async () => {
    await ctx.dispose()
    for (const dir of [home, teamDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, teamDir, exec, meeting, decide, stop }
}

test('#1809: a decision archived in the Session folder is listed by the board of a Project that names another folder', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ds-p1809-project-'))
  const sessionDir = mkdtempSync(join(tmpdir(), 'ds-p1809-session-'))
  const { ctx, rt, exec, decide, stop } = await startWithMeetings({ project: projectDir, room: sessionDir, session: sessionDir })
  try {
    const id = await decide('project-p1', 'Which folder carries the decision of a Project that names its own?')
    const meeting = rt.state.meetings[id]
    assert.match(meeting.decisionDir ?? '', new RegExp(`^${sessionDir}$`), 'the record names the folder it archived in')
    const named = meeting.decisionFile
    assert.equal(existsSync(join(sessionDir, named)), true, 'the file stays in the Session folder')
    assert.equal(existsSync(join(projectDir, 'decisions')), false, 'nothing was written into the Project folder')
    const board = await rt.projectBoard('project-p1')
    assert.equal(board.decisions.dir, projectDir, 'the Project folder is still the folder the board reports')
    assert.deepEqual(board.decisions.files.map(file => file.path), [named], 'the archived file is listed')
    const listed = board.decisions.files[0]
    assert.equal(listed.bytes, statSync(join(sessionDir, named)).size, 'bytes come from the folder the file is in')
    assert.equal(listed.sha256, meeting.decisionSha256, 'the hash is the bytes `decide` archived')
    assert.equal(listed.title, 'Which folder carries the decision of a Project that names its own?')
    assert.deepEqual(board.meetings.decided.map(entry => [entry.id, entry.path]), [[id, named]], 'the meeting links to the file, no `decision file gone`')
    assert.equal(board.decisions.reason, '')
    // Acceptance 6: the `project_state` tool keeps its repository gate on a plain folder; only the
    // board's own read is ungated, and that is why the case above can list the file at all.
    const state = await ctx.registeredTools.get('project_state').execute({}, exec)
    assert.match(state, /not a repository:/, 'project_state still refuses a plain folder')
  } finally {
    await stop()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(sessionDir, { recursive: true, force: true })
  }
})

test('#1809: a default install lists the team-folder decision, and a real delete still reads gone', async () => {
  const { rt, teamDir, decide, stop } = await startWithMeetings()
  try {
    const id = await decide('project-p1', 'Which folder holds the record of a default install?')
    const named = rt.state.meetings[id].decisionFile
    assert.equal(existsSync(join(teamDir, named)), true, 'the decision is archived in the team folder')
    const board = await rt.projectBoard('project-p1')
    assert.equal(board.decisions.dir, null, 'a Project that names no folder still reports no folder')
    assert.deepEqual(board.decisions.files.map(file => file.path), [named], 'the team-folder decision is listed')
    assert.equal(board.decisions.files[0].sha256, rt.state.meetings[id].decisionSha256)
    assert.deepEqual(board.meetings.decided.map(entry => [entry.id, entry.path]), [[id, named]])
    assert.equal(board.decisions.reason, '')
    // Acceptance 4: a file that really was deleted still reads `decision file gone`, not a listing.
    rmSync(join(teamDir, named))
    const gone = await rt.projectBoard('project-p1')
    assert.deepEqual(gone.decisions.files, [])
    assert.deepEqual(gone.meetings.decided.map(entry => [entry.id, entry.path]), [[id, '']], 'a missing file keeps the meeting, with no path')
  } finally { await stop() }
})

test('#1809: two folder-less Projects sharing the team folder list only their own decisions', async () => {
  const { rt, teamDir, decide, stop } = await startWithMeetings()
  try {
    const first = await decide('project-p1', 'Where do the decisions of the first Project live?')
    const second = await decide('project-p2', 'Where do the decisions of the second Project live?')
    const one = rt.state.meetings[first].decisionFile
    const two = rt.state.meetings[second].decisionFile
    assert.equal(existsSync(join(teamDir, one)), true)
    assert.equal(existsSync(join(teamDir, two)), true)
    const p1 = await rt.projectBoard('project-p1')
    assert.deepEqual(p1.decisions.files.map(file => file.path), [one], 'the other Project’s decision is never listed here')
    assert.deepEqual(p1.meetings.decided.map(entry => [entry.id, entry.path]), [[first, one]])
    const p2 = await rt.projectBoard('project-p2')
    assert.deepEqual(p2.decisions.files.map(file => file.path), [two])
    assert.deepEqual(p2.meetings.decided.map(entry => [entry.id, entry.path]), [[second, two]])
  } finally { await stop() }
})

// P-466 and P-468: a second window on the same team only reads (another dsh holds the team), and
// `channel.js` refuses everything outside its own `READS` name whitelist before `authorize()` runs.
// That whitelist was missing every read the window's own screens ask for besides `state`: the
// Projects list and panel (`projects`, `project-read`, `project-board`, `project-team`, `project-of`,
// `project-decision`, `project-memory`), the task boards (`tasks`), the folder rows and browser
// (`folders`, `folder-list`) and the connector row's app sign-in state (`connector-app-status`).
// The window drew those screens empty with no way to fill them, while the same names answer on a
// writable window. The fix adds exactly those reads; the writes stay refused.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  tasks: {
    'task-1': { id: 'task-1', title: 'Read the board', ownerBotId: 'a', column: 'waiting', createdAt: 1, updatedAt: 1, origin: { kind: 'bot' } },
  },
  projects: {
    'project-p1': {
      id: 'project-p1',
      name: 'P1',
      repository: 'ThinkFlowLab/FlyBot',
      defaultBranch: 'main',
      ownerUserId: 'owner-1',
      createdAt: 1,
      updatedAt: 1,
      status: 'active',
      roles: { maintainers: [], members: [] },
    },
  },
})

// The reads a read-only window draws: the Projects list and panel, the task boards, the folder
// rows and browser, and the connector row's app state. Each is a read in its handler.
const READS = [
  ['tasks', {}],
  ['projects', {}],
  ['project-read', { id: 'project-p1' }],
  ['project-of', { kind: 'bot', id: 'a' }],
  ['project-board', { id: 'project-p1' }],
  ['project-team', { id: 'project-p1' }],
  ['project-decision', { id: 'project-p1', path: 'decisions/2026-01-01-x.md' }],
  ['project-memory', { id: 'project-p1' }],
  ['folders', {}],
  ['folder-list', {}],
  ['connector-app-status', { id: 'composio' }],
]

// Writes the same screens offer; a read-only window must still be refused every one of them.
const WRITES = [
  ['task-create', { botId: 'a', title: 'x' }],
  ['project-create', { name: 'x' }],
  ['project-bind', { kind: 'bot', id: 'a', projectId: 'project-p1' }],
  ['project-memory-write', { id: 'project-p1', kind: 'note', text: 'x' }],
  ['connector-connect', { id: 'composio', token: 'x' }],
  ['set-prefs', { theme: 'deepseek' }],
  ['create-bot', { name: 'Writer' }],
  ['workflow-save', { id: 'x', doc: {} }],
]

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-readonly-reads-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, list: () => [], resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => ({ agent: { session: { id: 's1' }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, call, home, stop }
}

// Another dsh on this host holds the team: its pid answers, so `store.js` keeps this window
// read-only until the file is gone. `state.json` is left as this process wrote it, so adopting the
// other host's copy changes nothing the test reads.
const holdElsewhere = home => writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'the-other-window', since: Date.now() }))

test('P-466/P-468: a read-only window answers the reads its own screens ask for', async () => {
  const { call, home, stop } = await start()
  try {
    holdElsewhere(home)
    // The setup itself: the state answer names the other window, so the gate below is the
    // read-only one and not an anonymous-actor refusal.
    const state = await call('state')
    assert.equal(state.ok, true, JSON.stringify(state))
    assert.match(String(state.value.readOnly), /open in another dsh/)
    const refused = []
    for (const [endpoint, payload] of READS) {
      const answer = await call(endpoint, payload)
      if (answer.error?.code === 'bot/read-only') refused.push(endpoint)
    }
    assert.deepEqual(refused, [], `a read-only window still answers these reads: ${refused.join(', ')}`)
    // And they answer with the team's own data, not only past the gate.
    const tasks = await call('tasks')
    assert.equal(tasks.value.some(task => task.id === 'task-1'), true, JSON.stringify(tasks.value))
    const projects = await call('projects')
    assert.equal(projects.value.projects.some(project => project.id === 'project-p1'), true, JSON.stringify(projects.value))
    const read = await call('project-read', { id: 'project-p1' })
    assert.equal(read.value.project.id, 'project-p1')
  } finally { await stop() }
})

test('P-466/P-468: the same window still has every write refused', async () => {
  const { call, home, stop } = await start()
  try {
    holdElsewhere(home)
    await call('state')
    const allowed = []
    for (const [endpoint, payload] of WRITES) {
      const answer = await call(endpoint, payload)
      if (answer.error?.code !== 'bot/read-only') allowed.push(endpoint)
    }
    assert.deepEqual(allowed, [], `writes stay refused: ${allowed.join(', ')}`)
  } finally { await stop() }
})

test('P-466/P-468: the reads and the writes are unchanged once this window may write again', async () => {
  const { call, home, stop } = await start()
  try {
    holdElsewhere(home)
    await call('state')
    // The other window closes; the next request takes the lock over.
    unlinkSync(join(home, 'state.lock'))
    const refused = []
    for (const [endpoint, payload] of READS) {
      const answer = await call(endpoint, payload)
      if (answer.error?.code === 'bot/read-only') refused.push(endpoint)
    }
    assert.deepEqual(refused, [], `a writable window answers them as before: ${refused.join(', ')}`)
    const created = await call('create-bot', { name: 'Writer' })
    assert.equal(created.ok, true, JSON.stringify(created))
  } finally { await stop() }
})

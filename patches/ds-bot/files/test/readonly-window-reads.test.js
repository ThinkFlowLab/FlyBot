// P-466 and P-468: a second window on the same team only reads (another dsh holds the team), and
// `channel.js` refuses everything outside its own `READS` name whitelist before `authorize()` runs.
// That whitelist was missing every read the window's own screens ask for besides `state`: the
// Projects list and panel (`projects`, `project-read`, `project-board`, `project-team`, `project-of`,
// `project-decision`, `project-memory`), the task boards (`tasks`), the folder rows and browser
// (`folders`, `folder-list`) and the connector row's app sign-in state (`connector-app-status`).
// The window drew those screens empty with no way to fill them, while the same names answer on a
// writable window. The fix adds exactly those reads; the writes stay refused.
// Each row goes on to check the data its screen draws, not the shape of the answer: a folder browser
// this host cannot list, a connector signed in nowhere, a decision name the board never listed, a
// dossier of null rows, an empty memory record, or a board whose counts and metrics went missing are
// all red here instead of passing for "not refused".
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { installProjectDomain } from './project-domain.js'

// The Project's own working folder is where its `decisions/*.md` rows come from; a read-only window
// has to be able to read the folder rows and the file the board listed, so the seed names one.
const seed = work => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1', projectId: 'project-p1', workDir: work } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  // A signed-in Composio session: without one the row answers `Connect Composio first` long before
  // the read-only gate is asked, which is the other sentence a green here must not accept.
  connectors: { composio: { userId: 'flybot-owner-1', session: { id: 'sess-1' }, apps: ['gmail'] } },
  tasks: {
    // `status: 'open'` with a `queueRole` is what the board counts as a waiting card (#1768): the
    // row is not enough, the queue count has to be its own.
    'task-1': { id: 'task-1', title: 'Read the board', ownerBotId: 'a', column: 'waiting', status: 'open', queueRole: 'Dev', createdAt: 1, updatedAt: 1, origin: { kind: 'bot' } },
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
      workDir: work,
      // The dossier's first slot is the Project's own Chief (#1859, #1864); without one the row is
      // `null` and a read that answered `{ rows: [null, null] }` would still look shaped right.
      chief: { botId: 'a' },
      roles: { maintainers: [], members: [] },
    },
  },
  // The assistant's per-Project memory (#1712): a row here is what the panel draws, and the empty
  // record the reader answers without it is [] on both lists and a null digest.
  projectMemory: {
    'project-p1': { decisions: [{ text: 'A decision', at: 1 }], questions: [], digest: null, owners: {} },
  },
})

// The reads a read-only window draws: the Projects list and panel, the task boards, the folder
// rows and browser, and the connector row's app state. Each row checks the values its screen reads
// — the row itself, the count beside it, the entry text, the chooser kind — so an answer that is past
// the gate but empty, refused for another reason or shaped differently is red here: "not
// `bot/read-only`" alone was the false green the first version had.
// A row's payload may be a function of the answers above it, because opening a decision reads a
// name the board itself listed (#2041), not one this file made up.
const READS = [
  ['tasks', {}, a => a.ok === true && a.value.some(task => task.id === 'task-1')],
  ['projects', {}, a => a.ok === true && a.value.projects.some(project => project.id === 'project-p1')],
  ['project-read', { id: 'project-p1' }, a => a.ok === true && a.value.project?.id === 'project-p1'],
  ['project-of', { kind: 'bot', id: 'a' }, a => a.ok === true && a.value.project?.id === 'project-p1'],
  // The header's own numbers ride on the same read as the rows (#1829): a board that answered the
  // cards but zeroed `counts` or dropped `metrics` draws a header that disagrees with the list.
  ['project-board', { id: 'project-p1' }, a => a.ok === true
    && a.value.tasks.some(task => task.id === 'task-1')
    && a.value.counts?.waiting === 1 && a.value.counts.inflight === 0 && a.value.counts.blocked === 0
    // A host with no GitHub credential says so and reads `null`, never 0 (#1829).
    && a.value.metrics?.ok === false && a.value.metrics.reason === 'no-credentials'
    && Object.values(a.value.metrics.metrics).every(value => value === null)],
  // The dossier's rows are the Project's people (#1864): the Chief slot first. `{ rows: [] }` and
  // `{ rows: [null, null] }` both passed a shape-only check while the panel drew nobody.
  ['project-team', { id: 'project-p1' }, a => a.ok === true && a.value.rows.some(row => row?.botId === 'a' && row.name === 'Chief')],
  ['project-decision', answers => ({ id: 'project-p1', path: listedDecision(answers) }), a => a.ok === true && a.value.ok === true && String(a.value.text).includes('A decision')],
  // The assistant's memory row: an empty record is [] on both lists, so the check is the entry.
  ['project-memory', { id: 'project-p1' }, a => a.ok === true && a.value.memory.decisions.some(entry => entry.text === 'A decision')],
  // `picker` is what draws the Browse entry: the rows alone still paint a chooser that cannot open.
  ['folders', {}, a => a.ok === true && a.value.picker === 'browse' && a.value.folders.some(folder => folder.path.includes('ds-bot-readonly-work-'))],
  ['folder-list', {}, a => a.ok === true && a.value.entries.some(entry => entry.name === 'decisions')],
  ['connector-app-status', { id: 'composio' }, a => a.ok === true && a.value.gmail === 'ready'],
]

// The board's own listing is the accepted set (#2041): a name this file made up answers `not
// listed`, so the row opens the first name the board produced and says so when there is none.
const listedDecision = (answers) => {
  const path = answers['project-board']?.value?.decisions?.files?.[0]?.path
  if (typeof path !== 'string') throw new Error('the board listed no decision file to open')
  return path
}

// Reads every row once and names the ones that did not answer with their own data: a refusal as
// `bot/read-only` (the whitelist lost the name) and a dry answer (the fixture never made the data)
// are two different defects, so they are two lists.
async function readAll(call) {
  const answers = {}
  const refused = []
  const dry = []
  for (const [endpoint, payload, expect] of READS) {
    try {
      const answer = await call(endpoint, typeof payload === 'function' ? payload(answers) : payload)
      answers[endpoint] = answer
      if (answer.error?.code === 'bot/read-only') refused.push(endpoint)
      else if (expect(answer) !== true) dry.push(`${endpoint}: ${JSON.stringify(answer).slice(0, 300)}`)
    } catch (error) {
      dry.push(`${endpoint}: ${error.message}`)
    }
  }
  return { refused, dry }
}

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
  // #2302: `diagnostics-clear` rewrites `<home>/logs/diagnostics.jsonl` to zero bytes, and it sat
  // in the reading channel's `READS` list, so a read-only window truncated the log a bug report is
  // supposed to carry.
  ['diagnostics-clear', {}],
]

// The Composio host, stubbed: the status read asks it for the apps of the saved session, and the
// test box has no key. Only that host is answered; every other request goes to the real fetch.
const COMPOSIO_HOST = 'https://backend.composio.dev/'

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-readonly-reads-'))
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-readonly-work-'))
  mkdirSync(join(work, 'decisions'), { recursive: true })
  writeFileSync(join(work, 'decisions', '2026-01-01-x.md'), '# A decision\n\nbody\n')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(work)))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets: [
    { name: 'COMPOSIO_API_KEY', value: 'composio-test-key', scope: 'all', createdAt: 1, updatedAt: 1 },
  ] }))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url?.url ?? ''
    if (!href.startsWith(COMPOSIO_HOST)) return realFetch(url, init)
    return new Response(JSON.stringify({ items: [{ slug: 'gmail', is_no_auth: true }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // A folder chooser of the `browse` kind: `folder-list` is the read that draws its rows.
  const ctx = fakeContext({ services: { directoryPicker: { capability: () => ({
    kind: 'browse',
    list: async path => ({ path: path ?? work, home: work, crumbs: [], entries: [{ name: 'decisions', kind: 'dir' }], truncated: false }),
  }) } } })
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
  installProjectDomain(rt)
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
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
    const { refused, dry } = await readAll(call)
    assert.deepEqual(refused, [], `a read-only window still answers these reads: ${refused.join(', ')}`)
    // And they answer with the team's own data, not only past the gate.
    assert.deepEqual(dry, [], `a read-only window answers these reads with the data their screens draw:\n${dry.join('\n')}`)
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
    const { refused, dry } = await readAll(call)
    assert.deepEqual(refused, [], `a writable window answers them as before: ${refused.join(', ')}`)
    assert.deepEqual(dry, [], `a writable window answers them with the same data:\n${dry.join('\n')}`)
    const created = await call('create-bot', { name: 'Writer' })
    assert.equal(created.ok, true, JSON.stringify(created))
  } finally { await stop() }
})

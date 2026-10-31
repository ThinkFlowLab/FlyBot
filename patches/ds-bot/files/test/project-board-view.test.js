// The Project board view (#1710): one view over the read model Stage 2.2 shipped. It groups the
// rows by where the work lives, carries the run/node a workflow row came from, and keeps the row
// id equal to the underlying task id, so opening a row opens that task and no row is a copy.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/project-board.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
// A hook runtime: the overlay is a plain function, so a slot array that survives a re-render is
// enough to mount it, let its one read land, and read the tree it draws.
let slots = []
let index = 0
let effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useEffect: (fn) => { const at = index++; if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} }
// #1814: the board polls, so the test owns the clock it polls on. `tick()` runs every scheduled
// interval callback once and lets the read land; no real 5 s timer is ever armed here.
const doc = { visibilityState: 'visible' }
const clock = { timers: [], cleared: [], id: 0 }
const every = (fn, ms) => { clock.id += 1; clock.timers.push({ id: clock.id, fn, ms }); return clock.id }
const clearEvery = (id) => { clock.cleared.push(id); clock.timers = clock.timers.filter(timer => timer.id !== id) }
const resetClock = () => { clock.timers = []; clock.cleared = []; clock.id = 0; doc.visibilityState = 'visible' }
const tick = async (times = 1) => {
  for (let at = 0; at < times; at += 1) {
    for (const timer of Array.from(clock.timers)) timer.fn()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval: every, clearInterval: clearEvery,
  Date, Promise, console, window: win, document: doc,
  require: (name) => {
    if (name === 'react') return react
    throw new Error(`no platform module ${name}`)
  },
})
const { ProjectBoardOverlay, ProjectBoardPane, projectBoardView, metricsView, waitedLabel, METRIC_CARDS, METRIC_DASH, RUNNING_OVERDUE_MS } = module.exports
const render = (component, props) => { index = 0; return component(props) }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  await new Promise(resolve => setTimeout(resolve, 0))
}
// A mount the way the shell does it: the first render registers the effects, each runs once, and
// the second render draws the state the read landed on. The cleanups come back so a test can
// close the board (what the overlay's cleanup does) and watch what stops.
const mount = async (props) => {
  slots = []
  effects = []
  index = 0
  ProjectBoardOverlay(props)
  const cleanups = []
  for (const fn of effects) {
    const off = await fn()
    if (typeof off === 'function') cleanups.push(off)
  }
  effects = []
  // The first read is in flight after the effect returns: let it land before drawing.
  await new Promise(resolve => setTimeout(resolve, 0))
  index = 0
  const tree = ProjectBoardOverlay(props)
  return { tree, cleanups, redraw: () => { index = 0; return ProjectBoardOverlay(props) } }
}
const textIn = tree => all(tree).map(textOf).join(' | ')

const rows = [
  { id: 'task-b1', source: 'bot', column: 'in-progress', assignee: 'Dev4', updatedAt: 3 },
  { id: 'task-g1', source: 'group', column: 'done', assignee: 'Chief', updatedAt: 2 },
  { id: 'task-w1', source: 'workflow', column: 'not-started', assignee: null, runId: 'run-7', nodeId: 'build', updatedAt: 1 },
]

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  // The fake createElement does not render components; the test asks them for their tree.
  if (typeof node.type === 'function') return all(node.type(node.props), out)
  out.push(node)
  all(node.children, out)
  return out
}
// Arrays minted inside the vm have another realm's prototype, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value))
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children ?? []).map(textOf).join('') : '')

test('the board groups rows by their source and keeps each task id', () => {
  // #1855: `task-g1` is finished, so it reads inside the archive and not as a source-group row.
  const view = plain(projectBoardView({ project: { id: 'project-1', name: 'FlyBot' }, rows, canManage: true }))
  assert.equal(view.projectId, 'project-1')
  assert.equal(view.title, 'FlyBot')
  assert.equal(view.canManage, true)
  assert.equal(view.empty, false)
  assert.equal(view.count, 2)
  assert.deepEqual(view.groups.map(group => group.source), ['bot', 'workflow'])
  assert.deepEqual(view.groups.map(group => group.rows.length), [1, 1])
  const ids = view.groups.flatMap(group => group.rows.map(row => row.id))
  assert.deepEqual(ids, ['task-b1', 'task-w1'], 'the row id is the task id')
  assert.deepEqual(view.groups.flatMap(group => group.rows.map(row => row.key)), ['task:task-b1', 'task:task-w1'])
  assert.deepEqual(view.done.rows.map(row => row.id), ['task-g1'], 'the finished row is the archive')
})

test('a workflow row carries its run and node; other rows carry none', () => {
  const view = plain(projectBoardView({ project: { id: 'p', name: 'P' }, rows, canManage: false }))
  const [botRow] = view.groups[0].rows
  const workflowRow = view.groups.find(group => group.source === 'workflow').rows[0]
  assert.equal(botRow.runId, null)
  assert.equal(botRow.nodeId, null)
  assert.equal(workflowRow.runId, 'run-7')
  assert.equal(workflowRow.nodeId, 'build')
  assert.equal(workflowRow.assignee, null)
  assert.equal(botRow.column, 'in-progress')
})

test('a Project with nothing under it is an empty state, not an error', () => {
  const view = plain(projectBoardView({ project: { id: 'p', name: 'P' }, rows: [], canManage: false }))
  assert.equal(view.empty, true)
  assert.deepEqual(view.groups, [])
  assert.equal(view.count, 0)
  const missing = plain(projectBoardView({}))
  assert.equal(missing.empty, true)
  assert.equal(missing.projectId, null)
  assert.equal(missing.canManage, false, 'no canManage answer is read as read-only')
})

test('the pane draws the grouped rows and both management buttons, owner or not (#1749)', () => {
  const owner = all(ProjectBoardPane({ project: { id: 'p', name: 'FlyBot' }, rows, canManage: true }))
  const member = all(ProjectBoardPane({ project: { id: 'p', name: 'FlyBot' }, rows, canManage: false }))
  assert.match(textOf(owner[0]), /FlyBot/)
  const ownerRows = owner.filter(node => node.props?.['data-task-id'] !== undefined)
  // #1855: the finished row rides last, inside the archive group.
  assert.deepEqual(ownerRows.map(node => node.props['data-task-id']), ['task-b1', 'task-w1', 'task-g1'])
  const workflow = ownerRows.find(node => node.props['data-task-id'] === 'task-w1')
  assert.match(textOf(workflow), /run-7 · build/)
  assert.equal(owner.some(node => textOf(node) === 'Project settings'), true)
  const memberRows = member.filter(node => node.props?.['data-task-id'] !== undefined)
  assert.deepEqual(memberRows.map(node => node.props['data-task-id']), ['task-b1', 'task-w1', 'task-g1'], 'a member still reads the board')
  // #1749: a non-owner sees the same two buttons; the host refuses the write and the panel says so.
  assert.equal(member.some(node => textOf(node) === 'Project settings'), true)
})

test('an empty Project renders the empty text and no row', () => {
  const nodes = all(ProjectBoardPane({ project: { id: 'p', name: 'P' }, rows: [], canManage: false }))
  assert.equal(nodes.filter(node => node.props?.['data-task-id'] !== undefined).length, 0)
  assert.match(nodes.map(textOf).join(' '), /No cards yet/)
})

test('a Project-less entry offers the page that creates one (#1766)', async () => {
  slots = []
  effects = []
  win.location.hash = '#project'
  const opened = []
  const call = async () => ({ projects: [] })
  let tree = render(ProjectBoardOverlay, { actions: { openSettings: key => opened.push(key) }, call })
  await flush()
  tree = render(ProjectBoardOverlay, { actions: { openSettings: key => opened.push(key) }, call })
  const nodes = all(tree)
  assert.match(nodes.map(textOf).join(' '), /No Project yet — create one/)
  const button = nodes.find(node => node.type === 'button' && /Open Projects in Settings/.test(textOf(node)))
  assert.ok(button, 'the empty state names the way out')
  button.props.onClick()
  assert.deepEqual(opened, ['projects'])
})

// #1767: the record beside the cards. The view passes through what the host read — a decision
// with its hash, the meetings that reached one, and the ones still open listed apart — and an
// empty section says which folder was read instead of drawing an empty box.
const decisions = {
  dir: '/team/flybot',
  files: [
    { path: 'decisions/2026-10-30-adopt.md', name: '2026-10-30-adopt.md', date: '2026-10-30', title: 'Adopt the board record', sha256: 'a'.repeat(64), mtime: '2026-10-30T01:00:00.000Z' },
    { path: 'decisions/2026-10-31-second.md', name: '2026-10-31-second.md', date: '2026-10-31', title: 'Keep decisions small', sha256: 'b'.repeat(64), mtime: '2026-10-31T01:00:00.000Z' },
  ],
  reason: '',
}
const meetings = {
  decided: [{ id: 'meeting-d', date: '2026-10-30', question: 'Which board carries the record?', owner: 'Chief', path: 'decisions/2026-10-30-adopt.md' }],
  pending: [{ id: 'meeting-o', date: '2026-10-30', question: 'Should the board page?', status: 'deliberating' }],
  reason: '',
}

test('#1767: the view carries the decisions with their hash and the meetings apart', () => {
  const view = plain(projectBoardView({ project: { id: 'project-1', name: 'FlyBot' }, rows, decisions, meetings, canManage: false }))
  assert.equal(view.record.decisions.count, 2)
  assert.equal(view.record.decisions.empty, false)
  assert.equal(view.record.decisions.files[0].shortHash, 'a'.repeat(12))
  assert.equal(view.record.decisions.files[0].title, 'Adopt the board record')
  assert.equal(view.record.meetings.decided.length, 1)
  assert.equal(view.record.meetings.decided[0].path, 'decisions/2026-10-30-adopt.md')
  assert.equal(view.record.meetings.pending.length, 1)
  assert.equal(view.record.meetings.pending[0].status, 'deliberating')
})

test('#1767: the pane draws the record under the cards, and a deliberating meeting is never a decision', () => {
  const tree = all(ProjectBoardPane({ project: { id: 'project-1', name: 'FlyBot' }, rows, decisions, meetings, canManage: false }))
  const text = tree.map(textOf).join(' | ')
  assert.match(text, /Adopt the board record/)
  assert.match(text, /aaaaaaaaaaaa/, 'the hash the reader can compare is on screen')
  assert.match(text, /Which board carries the record\?/)
  assert.match(text, /Should the board page\?/)
  const sections = tree.filter(node => node.props?.className === 'bt-project-record')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].props['data-decisions'], '2')
  assert.equal(sections[0].props['data-meetings'], '2')
  const statuses = tree.filter(node => node.props?.['data-status'] !== undefined).map(node => node.props['data-status'])
  assert.deepEqual(statuses.sort(), ['decided', 'deliberating'])
})

test('#1767: an empty record names the folder it read and the missing decision file', () => {
  const view = plain(projectBoardView({
    project: { id: 'project-1', name: 'FlyBot' }, rows: [], canManage: false,
    decisions: { dir: '/team/flybot', files: [], reason: 'no decision file in /team/flybot/decisions' },
    meetings: { decided: [], pending: [], reason: 'no meeting of this Project is recorded' },
  }))
  assert.equal(view.record.decisions.empty, true)
  assert.equal(view.record.decisions.emptyText, 'no decision file in /team/flybot/decisions')
  assert.equal(view.record.meetings.empty, true)
  assert.equal(view.record.meetings.emptyText, 'no meeting of this Project is recorded')
  // The view before this slice still answers: a caller passing no sections reads an empty record,
  // not a thrown one.
  const bare = plain(projectBoardView({ project: { id: 'p', name: 'P' }, rows: [] }))
  assert.equal(bare.record.decisions.count, 0)
  assert.match(bare.record.decisions.emptyText, /no working folder/)
})

// #1768: the three groups beside the columns and the header counts. The host's read is passed in
// as it came — including a `null` count, which must survive as "unknown" and never become 0.
const queues = {
  waiting: [
    { id: 'task-w1', role: 'Dev', since: 100, waitedMs: 3 * 3600 * 1000 },
    { id: 'task-w2', role: 'Dev', since: 200, waitedMs: 5 * 60 * 1000 },
  ],
  inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'expired', stalled: true }],
  blocked: [{ id: 'task-g1', reason: 'Which branch should this ship on?' }],
  counts: { waiting: 2, inflight: 1, blocked: 1, done: 1 },
}

test('#1768: the view carries the three groups and the header counts', () => {
  const view = plain(projectBoardView({ project: { id: 'project-1', name: 'FlyBot' }, rows, tasks: [], queues }))
  assert.deepEqual(view.counts, { waiting: 2, inflight: 1, blocked: 1, done: 1 })
  assert.deepEqual(view.queues.map(entry => entry.group), ['waiting', 'inflight', 'blocked'])
  assert.deepEqual(view.queues[0].items.map(item => [item.id, item.role]), [['task-w1', 'Dev'], ['task-w2', 'Dev']])
  assert.deepEqual(view.queues[1].items.map(item => [item.id, item.holder, item.state]), [['task-b1', 'Dev4', 'stalled']])
  assert.deepEqual(view.queues[2].items.map(item => [item.id, item.reason]), [['task-g1', 'Which branch should this ship on?']])
  assert.equal(waitedLabel(3 * 3600 * 1000), '3h')
  assert.equal(waitedLabel(5 * 60 * 1000), '5m')
})

// #1896: a span under a minute read `0m`, on the card's wait line and on all three duration metrics,
// so a 40-second wait and a 35-second median merge both claimed "no wait". The label carries seconds
// under a minute, the way `elapsedLabel` next door never says `0m`; zero still reads zero and an
// unknown span still says nothing.
test('#1896: a sub-minute wait and a sub-minute median read in seconds, never 0', () => {
  assert.equal(waitedLabel(40 * 1000), '40s')
  assert.equal(waitedLabel(59 * 1000 + 999), '59s')
  assert.equal(waitedLabel(0), '0s')
  assert.equal(waitedLabel(1), '1s', 'a span over zero never floors to 0')
  // The units at and above a minute are unchanged.
  assert.equal(waitedLabel(60 * 1000), '1m')
  assert.equal(waitedLabel(3 * 3600 * 1000), '3h')
  assert.equal(waitedLabel(50 * 24 * 3600 * 1000), '50d')
  // Unknown stays unknown: nothing renders, rather than 0.
  assert.equal(waitedLabel(null), null)
  assert.equal(waitedLabel(Number.NaN), null)
  assert.equal(waitedLabel(-1), null)
  // The three duration metrics go through the same label, so they read seconds too.
  const view = plain(metricsView({ ok: true, metrics: { prMergeMedianMs: 40 * 1000, issueCloseMedianMs: 59 * 1000 + 999, taskDoneMedianMs: 0 } }))
  assert.equal(view.cards.find(card => card.key === 'prMergeMedianMs').value, '40s')
  assert.equal(view.cards.find(card => card.key === 'issueCloseMedianMs').value, '59s')
  assert.equal(view.cards.find(card => card.key === 'taskDoneMedianMs').value, '0s')
  const unknown = plain(metricsView({ ok: true, metrics: { prMergeMedianMs: null, issueCloseMedianMs: -1 } }))
  assert.equal(unknown.cards.find(card => card.key === 'prMergeMedianMs').value, METRIC_DASH)
  assert.equal(unknown.cards.find(card => card.key === 'issueCloseMedianMs').value, METRIC_DASH)
  // And the card's own wait line draws that same label.
  const subMinute = { ...queues, waiting: [{ id: 'task-w3', role: 'Dev', since: 300, waitedMs: 40 * 1000 }] }
  const nodes = all(ProjectBoardPane({ project: { id: 'project-1', name: 'FlyBot' }, rows, canManage: false, tasks: [], queues: subMinute }))
  const text = nodes.map(textOf).join(' | ')
  assert.ok(text.includes('· 40s'), text)
  assert.ok(!text.includes('0m'), text)
})

test('#1768: an unreadable count stays unknown and is never rendered as 0', () => {
  const view = plain(projectBoardView({
    project: { id: 'project-1', name: 'FlyBot' }, rows: [], tasks: [],
    queues: { waiting: [], inflight: [], blocked: [], counts: { waiting: null, inflight: null, blocked: null, done: null } },
  }))
  assert.deepEqual(view.counts, { waiting: null, inflight: null, blocked: null, done: null })
  const nodes = all(ProjectBoardPane({ project: view.projectId === null ? {} : { id: 'project-1', name: 'FlyBot' }, rows: [], canManage: false, tasks: [], queues: { waiting: [], inflight: [], blocked: [], counts: { waiting: null, inflight: null, blocked: null, done: null } } }))
  const text = nodes.map(textOf).join(' | ')
  assert.ok(/unknown/.test(text), text)
  assert.ok(!/Waiting: 0/.test(text), text)
  // A board with nothing readable is its own state, not a silent zero.
  assert.equal(view.empty, true)
})

test('#1768: the pane draws each group and a blocked card shows its reason', () => {
  const nodes = all(ProjectBoardPane({ project: { id: 'project-1', name: 'FlyBot' }, rows, canManage: false, tasks: [], queues }))
  const sections = nodes.filter(node => node && node.props && node.props['data-queue'])
  assert.deepEqual(sections.map(node => node.props['data-queue']), ['waiting', 'inflight', 'blocked'])
  const text = nodes.map(textOf).join(' | ')
  assert.ok(text.includes('Dev4 · stalled'), text)
  assert.ok(text.includes('Which branch should this ship on?'), text)
  assert.ok(text.includes('3h'), text)
  // The rows keep their task id, so the click-through to `#task=<id>` is unchanged.
  const ids = nodes.filter(node => node && node.props && node.props['data-task-id']).map(node => node.props['data-task-id'])
  assert.ok(ids.includes('task-w1') && ids.includes('task-b1') && ids.includes('task-g1'), JSON.stringify(ids))
})
// #1814: the wait a card shows and whether its lease is live are computed at read time on the host
// (`waitedMs`, `buildQueues`), so a board that reads once freezes: a lease that expires while the
// page is open never turns `stalled` and `3h` stays `3h`. The board polls, and the count below is
// taken at the channel call itself — the tree is not the evidence, the read is.
const boardAnswers = (count, { board = null, projectBoard = null } = {}) => async (name) => {
  count.calls += 1
  if (name === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
  if (name === 'project-read') return { project: { id: 'project-1', name: 'FlyBot' }, canManage: false }
  if (name === 'project-board') {
    if (projectBoard !== null) return projectBoard()
    return board ?? {
      tasks: rows,
      waiting: [],
      inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'expired', stalled: true }],
      blocked: [],
      counts: { waiting: 0, inflight: 1, blocked: 0, done: 1 },
    }
  }
  if (name === 'tasks') return [{ id: 'task-b1', title: 'Ship the poll' }, { id: 'task-g1', title: 'Group card' }, { id: 'task-w1', title: 'Workflow card' }]
  return {}
}

test('#1814: an open board reads on every tick, stops once a row opens its own board or the tab hides, and resumes', async () => {
  resetClock()
  win.location.hash = '#project'
  const count = { calls: 0 }
  const { tree, cleanups } = await mount({ actions: {}, call: boardAnswers(count) })
  assert.equal(count.calls, 5, 'the first read is the five calls the board makes: Project, record, board, task texts, team dossier')
  assert.match(textIn(tree), /Dev4 · stalled/, 'the board draws what the first read answered')
  const afterFirst = count.calls
  await tick()
  assert.equal(count.calls, afterFirst + 5, 'an open board reads again on the next tick')
  // A row opens its own board: the hash names the task and this board stops drawing, so a tick that
  // lands before the cleanup must not read. This segment pins the unmount, not the predicate.
  const afterTick = count.calls
  win.location.hash = '#task=bot:task-b1'
  await tick(2)
  assert.equal(count.calls, afterTick, 'no read after a row opened its own board: the board leaves the screen, so the tick that lands before its cleanup reads nothing')
  // Closing that board puts this one back in front: the next tick reads again.
  win.location.hash = '#project'
  await tick()
  assert.equal(count.calls, afterTick + 5, 'closing the row’s board resumes the poll')
  // A hidden tab reads nothing either — this is the segment the named predicate is pinned by.
  const afterResume = count.calls
  doc.visibilityState = 'hidden'
  await tick(2)
  assert.equal(count.calls, afterResume, 'no read in a hidden tab')
  doc.visibilityState = 'visible'
  await tick()
  assert.equal(count.calls, afterResume + 5, 'a visible tab reads again on the next tick')
  // Close the board: the timer goes with it, so a tick afterwards reads nothing at all.
  const afterVisible = count.calls
  for (const off of cleanups) off()
  assert.equal(clock.timers.length, 0, 'the poll is cleared when the board closes')
  await tick(2)
  assert.equal(count.calls, afterVisible, 'nothing reads after the board closed')
})

test('#1814: a failing poll keeps the board the last good read drew', async () => {
  resetClock()
  win.location.hash = '#project'
  const count = { calls: 0 }
  let fail = false
  const healthy = { tasks: rows, waiting: [], inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'expired', stalled: true }], blocked: [], counts: { waiting: 0, inflight: 1, blocked: 0, done: 1 } }
  const call = async (name) => {
    count.calls += 1
    if (name === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
    if (name === 'project-read') return { project: { id: 'project-1', name: 'FlyBot' }, canManage: false }
    if (name === 'project-board') { if (fail) throw new Error('the board read failed'); return healthy }
    if (name === 'tasks') return [{ id: 'task-b1', title: 'Ship the poll' }]
    return {}
  }
  const { tree, redraw } = await mount({ actions: {}, call })
  assert.match(textIn(tree), /Ship the poll/)
  fail = true
  await tick()
  const after = redraw()
  assert.match(textIn(after), /Ship the poll/, 'the last good board stays on screen')
  assert.ok(!/No Project yet/.test(textIn(after)), 'a failed poll is not the empty state')
})

test('#1814: a read that lands after the board closed is dropped', async () => {
  resetClock()
  win.location.hash = '#project'
  const count = { calls: 0 }
  let late = null
  const healthy = { tasks: rows, waiting: [], inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'expired', stalled: true }], blocked: [], counts: { waiting: 0, inflight: 1, blocked: 0, done: 1 } }
  const call = async (name) => {
    count.calls += 1
    if (name === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
    if (name === 'project-read') return { project: { id: 'project-1', name: 'FlyBot' }, canManage: false }
    if (name === 'project-board') return late === null ? healthy : late.promise
    if (name === 'tasks') return [{ id: 'task-b1', title: 'Ship the poll' }]
    return {}
  }
  const { tree, cleanups, redraw } = await mount({ actions: {}, call })
  assert.match(textIn(tree), /Ship the poll/)
  late = {}
  late.promise = new Promise((resolve) => { late.resolve = resolve })
  await tick()
  for (const off of cleanups) off()
  late.resolve({ tasks: [], waiting: [], inflight: [], blocked: [], counts: { waiting: 0, inflight: 0, blocked: 0, done: 0 } })
  await new Promise(resolve => setTimeout(resolve, 0))
  const after = redraw()
  assert.match(textIn(after), /Ship the poll/, 'the late read never reaches a closed board')
  assert.ok(!/No cards yet/.test(textIn(after)), 'the board did not move under the reader')
})

test('#1814: a second read moves one card to stalled and a waiting card in flight in the same render', async () => {
  resetClock()
  win.location.hash = '#project'
  let boardReads = 0
  const call = async (name) => {
    if (name === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
    if (name === 'project-read') return { project: { id: 'project-1', name: 'FlyBot' }, canManage: false }
    if (name === 'tasks') return [{ id: 'task-b1', title: 'Ship the poll' }, { id: 'task-w1', title: 'Waited card' }]
    if (name === 'project-board') {
      boardReads += 1
      const tasks = rows.filter(row => row.id === 'task-b1' || row.id === 'task-w1')
      // The host computes both facts at read time: the first answer says the lease is live and the
      // card is still waiting, the second says the lease expired while the page was open.
      if (boardReads === 1) {
        return {
          tasks,
          waiting: [{ id: 'task-w1', role: 'Reviewer', waitedMs: 3 * 60 * 60 * 1000 }],
          inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'live', stalled: false }],
          blocked: [],
          counts: { waiting: 1, inflight: 1, blocked: 0, done: 0 },
        }
      }
      return {
        tasks,
        waiting: [],
        inflight: [{ id: 'task-b1', holder: 'Dev4', lease: 'expired', stalled: true }, { id: 'task-w1', holder: 'Dev2', lease: 'live', stalled: false }],
        blocked: [],
        counts: { waiting: 0, inflight: 2, blocked: 0, done: 0 },
      }
    }
    return {}
  }
  const { redraw } = await mount({ actions: {}, call })
  const first = textIn(redraw())
  assert.match(first, /Dev4 · running/, 'the first read draws the live lease')
  assert.match(first, /Waiting: 1/, 'the first read draws the waiting count')
  await tick()
  const tree = redraw()
  const second = textIn(tree)
  assert.match(second, /Dev4 · stalled/, 'the same render shows the expiry that happened while the page stayed open')
  assert.match(second, /Dev2 · running/, 'the waiting card is drawn in flight')
  assert.match(second, /Waiting: 0/, 'the waiting count followed the same read')
  assert.match(second, /In flight: 2/, 'the in-flight count followed the same read')
  const stalled = all(tree).filter(node => node && node.props && node.props['data-state'] === 'stalled')
  assert.deepEqual(stalled.map(node => node.props['data-task-id']), ['task-b1'], 'only the expired card carries the stalled edge')
})

// #1829: the seven metric cards and the running table. A missing read paints the dash on every
// card, never a zero; a running row past the overdue mark says so and still opens its own board.
test('the metric cards are the seven the issue fixed, each with a caption', () => {
  const view = metricsView({ ok: true, metrics: { prsOpenedToday: 3, prsMergedToday: 1, issuesOpenedToday: 2, issuesClosedToday: 0, prMergeMedianMs: 7200000, issueCloseMedianMs: null, taskDoneMedianMs: null } })
  assert.equal(view.cards.length, 7)
  assert.equal(METRIC_CARDS.length, 7)
  for (const card of view.cards) assert.ok(card.caption.length > 0, card.key + ' carries a caption')
  assert.equal(view.cards.find(card => card.key === 'prsOpenedToday').value, '3')
  assert.equal(view.cards.find(card => card.key === 'prMergeMedianMs').value, '2h')
  // An empty window is a dash, never a zero, and a real zero still reads 0.
  assert.equal(view.cards.find(card => card.key === 'issueCloseMedianMs').value, METRIC_DASH)
  assert.equal(view.cards.find(card => card.key === 'issuesClosedToday').value, '0')
})

test('an unavailable read says why and draws no number', () => {
  const view = metricsView({ ok: false, reason: 'no-credentials', metrics: {}, running: [] })
  assert.equal(view.available, false)
  assert.equal(view.reason, 'no-credentials')
  assert.equal(view.cards.every(card => card.value === METRIC_DASH), true)
  assert.equal(view.running.length, 0)
  assert.equal(metricsView(null).empty, true)
})

test('a running row carries who, claim age, source and activity, and opens its board', () => {
  const now = Date.now()
  const view = metricsView({ ok: true, metrics: {}, running: [{ id: 'task-1', title: 'Ship it', status: 'claimed', who: 'Dev', sinceMs: 3 * 60 * 60 * 1000, source: 'group', lastActivityAt: now - 60000 }] })
  const row = view.running[0]
  assert.equal(row.who, 'Dev')
  assert.equal(row.source, 'group')
  assert.equal(row.overdue, true)
  assert.ok(row.sinceMs > RUNNING_OVERDUE_MS)
  assert.equal(row.lastActivityAt, now - 60000)
  assert.equal(row.title, 'Ship it')
})

// #1855: a Project with months of history opened on a wall of finished rows. The three source groups
// hold only the work in flight, every finished card lives in one archive group that starts collapsed,
// and the header keeps counting them (`Done: <count>`).
const doneRows = Array.from({ length: 191 }, (_, at) => ({ id: `task-d${at}`, source: 'group', column: 'done', assignee: null, updatedAt: at }))
const openRows = Array.from({ length: 9 }, (_, at) => ({ id: `task-o${at}`, source: 'group', column: 'in-progress', assignee: 'Dev4', updatedAt: 100 + at }))
const historyQueues = { waiting: [], inflight: [], blocked: [], counts: { waiting: 0, inflight: 0, blocked: 0, done: 191 } }

test('#1855: the view keeps finished cards out of the three groups and in one archive', () => {
  const view = plain(projectBoardView({ project: { id: 'project-1', name: 'FlyBot' }, rows: openRows, done: doneRows, queues: historyQueues }))
  assert.equal(view.count, 9, 'the rows are the work in flight')
  assert.deepEqual(view.groups.map(group => group.rows.length), [9], 'one source, nine rows')
  assert.equal(view.done.rows.length, 191, 'every finished card is carried, in the same row shape')
  assert.equal(view.done.rows[0].column, 'done')
  assert.equal(view.done.rows[0].key, 'task:task-d0')
  assert.equal(view.done.collapsed, true, 'the archive starts collapsed')
  assert.equal(view.counts.done, 191, 'the header still counts every finished card')
  // A page talking to a host that still sends every card in `rows` paints no finished row in a
  // source group: the terminal row is folded into the archive instead of dropped or repeated.
  const legacy = plain(projectBoardView({ project: { id: 'p', name: 'P' }, rows: [...openRows, ...doneRows], queues: historyQueues }))
  assert.deepEqual(legacy.groups.map(group => group.rows.length), [9])
  assert.equal(legacy.done.rows.length, 191)
})

test('#1855: the archive is a collapsed group on first paint and the header keeps the count', () => {
  const props = { project: { id: 'project-1', name: 'FlyBot' }, rows: openRows, done: doneRows, canManage: false, tasks: [], queues: historyQueues }
  const nodes = all(ProjectBoardPane(props))
  const archive = nodes.find(node => node.props?.['data-group'] === 'done')
  assert.ok(archive, 'the archive group is drawn')
  assert.equal(archive.type, 'details', 'a details element is collapsed by the browser until the reader opens it')
  assert.equal(archive.props.open, undefined, 'no open attribute on first paint')
  const archived = all(archive.children).filter(node => node.props?.['data-task-id'] !== undefined)
  assert.equal(archived.length, 191, 'every finished card is inside the archive')
  assert.equal(archived.every(node => node.props['data-column'] === 'done'), true)
  // Nothing outside the archive paints a finished card, and the nine open rows keep their ids.
  const everyRow = nodes.filter(node => node.props?.['data-task-id'] !== undefined)
  const outside = everyRow.filter(node => !archived.includes(node))
  assert.equal(outside.length, 9, 'nine rows beside the archive')
  assert.equal(outside.some(node => node.props['data-column'] === 'done'), false, 'no finished row among the open rows')
  const text = nodes.map(textOf).join(' | ')
  assert.match(text, /Done: 191/)
  assert.match(text, /Done cards/, 'the archive names what it holds')
})

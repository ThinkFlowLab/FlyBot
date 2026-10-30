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
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, console,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useCallback: fn => fn,
        useEffect: () => {},
        useState: initial => [initial, () => {}],
      },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { ProjectBoardPane, projectBoardView } = module.exports

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

test('the board groups rows from all three sources and keeps each task id', () => {
  const view = plain(projectBoardView({ project: { id: 'project-1', name: 'FlyBot' }, rows, canManage: true }))
  assert.equal(view.projectId, 'project-1')
  assert.equal(view.title, 'FlyBot')
  assert.equal(view.canManage, true)
  assert.equal(view.empty, false)
  assert.equal(view.count, 3)
  assert.deepEqual(view.groups.map(group => group.source), ['bot', 'group', 'workflow'])
  assert.deepEqual(view.groups.map(group => group.rows.length), [1, 1, 1])
  const ids = view.groups.flatMap(group => group.rows.map(row => row.id))
  assert.deepEqual(ids, ['task-b1', 'task-g1', 'task-w1'], 'the row id is the task id')
  assert.deepEqual(view.groups.flatMap(group => group.rows.map(row => row.key)), ['task:task-b1', 'task:task-g1', 'task:task-w1'])
})

test('a workflow row carries its run and node; other rows carry none', () => {
  const view = plain(projectBoardView({ project: { id: 'p', name: 'P' }, rows, canManage: false }))
  const [botRow] = view.groups[0].rows
  const workflowRow = view.groups[2].rows[0]
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

test('the pane draws the grouped rows and only the owner sees the management controls', () => {
  const owner = all(ProjectBoardPane({ project: { id: 'p', name: 'FlyBot' }, rows, canManage: true }))
  const member = all(ProjectBoardPane({ project: { id: 'p', name: 'FlyBot' }, rows, canManage: false }))
  assert.match(textOf(owner[0]), /FlyBot/)
  const ownerRows = owner.filter(node => node.props?.['data-task-id'] !== undefined)
  assert.deepEqual(ownerRows.map(node => node.props['data-task-id']), ['task-b1', 'task-g1', 'task-w1'])
  const workflow = ownerRows[2]
  assert.match(textOf(workflow), /run-7 · build/)
  assert.equal(owner.some(node => textOf(node) === 'Project settings'), true)
  const memberRows = member.filter(node => node.props?.['data-task-id'] !== undefined)
  assert.deepEqual(memberRows.map(node => node.props['data-task-id']), ['task-b1', 'task-g1', 'task-w1'], 'a member still reads the board')
  assert.equal(member.some(node => textOf(node) === 'Project settings'), false)
})

test('an empty Project renders the empty text and no row', () => {
  const nodes = all(ProjectBoardPane({ project: { id: 'p', name: 'P' }, rows: [], canManage: false }))
  assert.equal(nodes.filter(node => node.props?.['data-task-id'] !== undefined).length, 0)
  assert.match(nodes.map(textOf).join(' '), /Nothing under this Project yet/)
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

// Project board, the reachable slice (#1701): #1715 shipped the board itself, but nothing writes
// `#project=<id>`, a row only repeats `@assignee`, and clicking one sets a hash no view reads.
// These tests pin the three surfaces a reader needs — an entry that opens the board, a row that
// says which task it is, and a row that opens the board the task lives on — plus the three column
// labels the board already asks `t()` for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const states = []
const effects = []
const setters = []

const load = async (entry) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom'],
  })
  const module = { exports: {} }
  const sandbox = {
    module, exports: module.exports, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {}, Date, Promise, console,
    window: { location: { hash: '' }, addEventListener: () => {}, removeEventListener: () => {} },
    require: (name) => {
      const platform = {
        react: {
          createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: (initial) => {
            const value = states.length > 0 ? states.shift() : (typeof initial === 'function' ? initial() : initial)
            return [value, (next) => { setters.push(typeof next === 'function' ? next(value) : next) }]
          },
          useEffect: fn => { effects.push(fn) },
          useLayoutEffect: fn => { effects.push(fn) },
          useCallback: fn => fn,
          useMemo: fn => fn(),
          useRef: current => ({ current }),
        },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  }
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  return { ...module.exports, window: sandbox.window }
}

const expand = (node) => {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.children, out) }
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')
// Arrays and objects minted inside the vm have another realm's prototype, so compare copies.
const plain = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

const roster = () => {
  const view = {
    self: { memberId: 'm1' },
    bots: [
      { id: 'a', name: 'Chief', ownerId: 'm1', createdAt: 1, projectId: 'project-rocket' },
      { id: 'b', name: 'Loose', ownerId: 'm1', createdAt: 2 },
    ],
    rooms: [
      { id: 'r1', name: 'Ops', admin: 'a', projectId: 'project-rocket', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
      { id: 'r2', name: 'Garden', admin: 'a', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
    ],
  }
  view.byId = Object.fromEntries(view.bots.map(bot => [bot.id, bot]))
  view.roomsById = Object.fromEntries(view.rooms.map(room => [room.id, room]))
  return view
}

// The rows #1715's host read model returns: an id, a source, a column and who holds it — no text.
const rows = [
  { id: 'task-b1', source: 'bot', column: 'in-progress', assignee: 'Dev4', updatedAt: 3 },
  { id: 'task-g1', source: 'group', column: 'done', assignee: 'Chief', updatedAt: 2 },
  { id: 'task-w1', source: 'workflow', column: 'not-started', assignee: null, runId: 'run-7', nodeId: 'build', updatedAt: 1 },
]
// The task records the board joins by id, so the card can say what the row is about.
const taskRecords = [
  { id: 'task-b1', title: 'Ship the board', priority: 'high', ownerBotId: 'a' },
  { id: 'task-g1', note: 'write the doc first', ownerBotId: 'a', origin: { roomId: 'r1' } },
  { id: 'task-w1', title: 'Build it', title_: '', priority: 'low' },
]
const project = { id: 'project-rocket', name: 'Rocket' }

// The board row is the one surface that must stay a button: `role` alone opens nothing.
test('#1701: a board row shows the task title, its priority and the board that owns it', async () => {
  const { projectBoardView } = await load('project-board.js')
  const view = projectBoardView({ project, rows, canManage: false, tasks: taskRecords })
  const listed = view.groups.flatMap(group => group.rows)
  const bot = listed.find(row => row.id === 'task-b1')
  const group = listed.find(row => row.id === 'task-g1')
  assert.equal(bot.title, 'Ship the board', 'the row says what the task is')
  assert.equal(bot.priority, 'high', 'the row carries the priority')
  assert.deepEqual(plain(bot.board), { kind: 'bot', id: 'a' }, 'the row knows the board the task lives on')
  assert.equal(group.title, 'write the doc first', 'a task with no title falls back to its note')
  assert.deepEqual(plain(group.board), { kind: 'group', id: 'r1' })
})

test('#1701: a board row draws the title and opens the board that owns the task', async () => {
  const { ProjectBoardPane } = await load('project-board.js')
  const opened = []
  const nodes = all(expand(ProjectBoardPane({ project, rows, canManage: false, tasks: taskRecords, onOpen: target => opened.push(target) })))
  const row = nodes.find(node => node.props?.['data-task-id'] === 'task-b1')
  assert.ok(row, 'the row is drawn')
  assert.match(textOf(row), /Ship the board/, `the row repeats the assignee instead of the title: ${textOf(row)}`)
  assert.equal(row.props['data-priority'], 'high')
  row.props.onClick()
  assert.deepEqual(plain(opened), [{ kind: 'bot', id: 'a' }], 'clicking opens the board that owns the task')
})

test('#1854: the Tasks dialog has no second entry to the Project board', async () => {
  const { KanbanDialog } = await load('kanban.js')
  states.length = 0
  states.push(
    { kind: 'bot', botId: 'a' }, null, '', '',
    [{ id: 'task-1', status: 'working', ownerBotId: 'a', title: 'One' }], [], [],
  )
  const tree = expand(KanbanDialog({ roster: roster(), actions: { closeBoard: () => {}, tasks: async () => [], openBoard: () => {} } }))
  // #1854: Projects are entered from the left sidebar only. The board's own `Project board` button
  // was the second door, so a Bot bound to a Project no longer draws one here.
  const entry = all(tree).filter(node => typeof node.props?.['data-open-project'] === 'string')
  assert.equal(entry.length, 0, 'the Tasks dialog no longer offers a Project board entry')
})

test('#1701: the three board columns have their own labels', async () => {
  const { installLocale, t, DICTIONARY } = await load('i18n.js')
  // `t()` reads a bound locale service; the fake answers from the shipped dictionary.
  installLocale({ register: () => () => {}, bind: () => (key) => DICTIONARY.zh[key] ?? key })
  for (const [key, want] of [['not-started', '未开始'], ['in-progress', '进行中'], ['done', '已完成']]) {
    assert.equal(t(key), want, `${key} renders as its own Chinese label, not the raw key`)
  }
})

// The hash a row writes is consumed by the Tasks board: it lands on the board the task lives on.
test('#1701: the Tasks board reads the task hash and lands on that board', async () => {
  const { KanbanDialog, window: fake } = await load('kanban.js')
  fake.location.hash = '#task=group:r1'
  states.length = 0
  effects.length = 0
  setters.length = 0
  expand(KanbanDialog({ roster: roster(), actions: { closeBoard: () => {}, tasks: async () => [], openBoard: () => {} } }))
  for (const effect of effects) effect()
  assert.deepEqual(plain(setters.slice(0, 1)), [{ kind: 'group', roomId: 'r1' }], 'the board moves to the group the task lives on')
  assert.equal(fake.location.hash, '', 'the hash is consumed, so a reload does not reopen the same board')
})

// The task board (#1058): three columns, a Bot rail that nests children, and a
// group rail limited to groups the viewer administers. Moving a card is the
// owner's action; another Bot's card in a group view is visible and not movable.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/kanban.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useCallback: fn => fn,
      },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { BoardView, boardColumns, boardRail, canMoveTask, shortId } = module.exports

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
const byClass = (tree, name) => all(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))

const roster = {
  self: { memberId: 'm1' },
  bots: [
    { id: 'a', name: 'Chief', ownerId: 'm1', createdAt: 1 },
    { id: 's', name: 'Writer', ownerId: 'm1', createdBy: 'a', createdAt: 2 },
    { id: 'b', name: 'Other', ownerId: 'm2', createdAt: 3 },
  ],
  rooms: [
    { id: 'war', name: 'War', admin: 'a', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
    { id: 'ops', name: 'Ops', admin: 'b', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
    { id: 'face', name: 'Face', origin: 'face-to-face', admin: 'a', participants: [{ kind: 'human', id: 'm1', role: 'admin' }] },
  ],
}
roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
roster.roomsById = Object.fromEntries(roster.rooms.map(room => [room.id, room]))

const task = (id, status, extra) => ({ id, status, title: `Task ${id}`, ownerBotId: 's', priority: 'normal', progress: 0, updatedAt: 1, ...extra })
const tasks = [
  task('task-abcdef123456', 'open', { title: 'Draft the note', priority: 'high', progress: 0, updatedAt: 2 }),
  task('task-ffffff999999', 'working', { title: 'Ship the note', priority: 'urgent', progress: 40, note: 'Halfway', updatedAt: 3 }),
  task('task-000000aaaaaa', 'accepted', { title: 'Old note', ownerBotId: 'a', priority: 'low', progress: 100, updatedAt: 1 }),
  task('task-bbbbbbcccccc', 'open', { title: 'Theirs', ownerBotId: 'b', ownerBotName: 'Other', updatedAt: 4 }),
]

test('columns follow the task state and a card carries id, priority and progress', () => {
  const columns = boardColumns(tasks.filter(item => item.ownerBotId === 's' || item.ownerBotId === 'a'))
  assert.equal(columns['not-started'].map(item => item.title).join('|'), 'Draft the note')
  assert.equal(columns['in-progress'].map(item => item.title).join('|'), 'Ship the note')
  assert.equal(columns.done.map(item => item.title).join('|'), 'Old note')
  assert.equal(shortId('task-abcdef123456'), '#123456')
  const rail = boardRail(roster)
  // Names come back from the bundled module's realm; join avoids deepEqual's cross-realm miss.
  assert.equal(rail.bots.map(row => `${row.name}:${row.depth}`).join('|'), 'Chief:0|Writer:1')
  assert.equal(rail.groups.map(row => row.name).join('|'), 'War')
  assert.equal(canMoveTask(roster, tasks[0]), true)
  assert.equal(canMoveTask(roster, tasks[3]), false)
})

test('the board draws the three columns, nests the child, and moves only the owner\'s card', () => {
  const moved = []
  const tree = expand({
    type: BoardView,
    props: {
      roster,
      tasks: tasks.filter(item => item.ownerBotId === 's'),
      rail: boardRail(roster),
      scope: { kind: 'bot', botId: 's' },
      counts: { s: { done: 0, total: 1 }, a: { done: 1, total: 1 } },
      dragging: 'task-abcdef123456',
      onMove: (id, column) => moved.push([id, column]),
      onCreate: () => {},
      onSelect: () => {},
    },
    children: [],
  })
  const columns = byClass(tree, 'bt-board-column').map(node => node.props['data-column'])
  assert.deepEqual(columns, ['not-started', 'in-progress', 'done'])
  assert.match(textOf(tree), /Draft the note/)
  assert.match(textOf(tree), /#123456/)
  assert.match(textOf(tree), /High/)
  assert.match(textOf(tree), /40%/)
  assert.match(textOf(tree), /Halfway/)
  assert.match(textOf(tree), /Start task/)
  assert.match(textOf(tree), /Complete task/)
  const writer = all(tree).find(node => node.props?.['data-id'] === 's')
  assert.equal(writer.props.style.paddingLeft, '24px')
  assert.equal(all(tree).some(node => node.props?.['data-id'] === 'ops'), false)
  const start = all(tree).find(node => node.type === 'button' && textOf(node) === 'Start')
  start.props.onClick()
  assert.deepEqual(moved, [['task-abcdef123456', 'in-progress']])
  const progress = byClass(tree, 'bt-board-column').find(node => node.props['data-column'] === 'in-progress')
  progress.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => 'task-abcdef123456' } })
  assert.deepEqual(moved[1], ['task-abcdef123456', 'in-progress'])
  const group = expand({
    type: BoardView,
    props: {
      roster,
      tasks: [tasks[3]],
      rail: boardRail(roster),
      scope: { kind: 'group', roomId: 'war' },
      onMove: () => moved.push('group'),
    },
    children: [],
  })
  assert.match(textOf(group), /Theirs/)
  assert.match(textOf(group), /Other/)
  assert.equal(all(group).some(node => node.type === 'button' && (textOf(node) === 'Start' || textOf(node) === 'Complete')), false)
  assert.equal(byClass(group, 'bt-board-card')[0].props.draggable, undefined)
})

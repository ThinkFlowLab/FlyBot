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
// Preset state for the next useState calls; KanbanDialog's first hook is the view.
const states = []
// A hook's effects are collected, never run: a test that drives a load calls the one it needs.
const effects = []
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Date, Promise,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [states.length > 0 ? states.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
        useEffect: fn => { effects.push(fn) }, useCallback: fn => fn, useRef: current => ({ current }),
      },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { ARCHIVE_SHOWN, BoardView, KanbanDialog, boardColumns, boardTasksFor, boardRail, canMoveTask, columnTree, shortId, useBoardTasks } = module.exports

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
  // A task card names its source and its identity on the one card model (#1265 step 1).
  const card = all(tree).find(node => node.props?.['data-task'] === 'task-abcdef123456')
  assert.equal(card.props['data-source'], 'task')
  assert.equal(card.props['data-key'], 'task:task-abcdef123456')
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
  assert.match(textOf(group), /Assign, claim, and progress live on this board/)
  assert.doesNotMatch(textOf(tree), /Assign, claim, and progress live on this board/)
  assert.equal(all(group).some(node => node.type === 'button' && (textOf(node) === 'Start' || textOf(node) === 'Complete')), false)
  assert.equal(byClass(group, 'bt-board-card')[0].props.draggable, undefined)
})

test('a group column nests subtasks under the overall task', () => {
  const overall = task('task-aaaaaa111111', 'open', { title: 'Ship it', kind: 'group', ownerBotId: 'a', priority: 'high', updatedAt: 5 })
  const child = task('task-bbbbbb222222', 'open', { title: 'Write it', ownerBotId: 's', parentId: overall.id, parentTitle: 'Ship it', priority: 'urgent', updatedAt: 6 })
  const later = task('task-cccccc333333', 'working', { title: 'Check it', ownerBotId: 'b', ownerBotName: 'Other', parentId: overall.id, parentTitle: 'Ship it', progress: 10, updatedAt: 7 })
  const open = columnTree([overall, child, tasks[3]])
  assert.equal(open.nests.length, 1)
  assert.equal(open.nests[0].task.id, overall.id)
  // Ids come back from the bundled module's realm; join avoids deepEqual's cross-realm miss.
  assert.equal(open.nests[0].children.map(item => item.id).join('|'), child.id)
  assert.equal(open.loose.map(item => item.id).join('|'), tasks[3].id)
  const tree = expand({
    type: BoardView,
    props: {
      roster,
      tasks: [overall, child, later, tasks[3]],
      rail: boardRail(roster),
      scope: { kind: 'group', roomId: 'war' },
      onMove: () => {},
    },
    children: [],
  })
  const notStarted = byClass(tree, 'bt-board-column').find(node => node.props['data-column'] === 'not-started')
  const progress = byClass(tree, 'bt-board-column').find(node => node.props['data-column'] === 'in-progress')
  assert.match(textOf(notStarted), /Group task/)
  assert.match(textOf(notStarted), /Ship it/)
  assert.match(textOf(notStarted), /Write it/)
  assert.equal(all(notStarted).some(node => node.props?.['data-parent'] === overall.id), true)
  assert.match(textOf(progress), /Part of Ship it/)
  assert.match(textOf(progress), /Check it/)
  assert.match(textOf(notStarted), /Theirs/)
})

test('the task dialog has no delivery metrics panel (#1363)', () => {
  const actions = { closeBoard: () => {}, boardClose: () => {} }
  states.length = 0
  const boardView = expand(KanbanDialog({ roster, actions }))
  assert.equal(all(boardView).filter(node => node.props?.role === 'tab').length, 0)
  assert.equal(all(boardView).find(node => node.props?.role === 'tablist'), undefined)
  const heading = all(boardView).find(node => node.props?.id === 'bt-board-heading')
  assert.match(textOf(heading), /Board/)
  assert.equal(byClass(boardView, 'bt-board-rail').length, 1)
  assert.equal(byClass(boardView, 'bt-board-column').map(node => node.props['data-column']).join('|'), 'not-started|in-progress|done')
  assert.equal(all(boardView).some(node => String(node.props?.className ?? '').includes('bt-del')), false)
  assert.doesNotMatch(textOf(boardView), /from the package|Diagnose|New issues|CI red share/)
})

test('the task dialog shows task cards without a GitHub read (#1363)', () => {
  const actions = { closeBoard: () => {}, boardClose: () => {} }
  const mine = task('task-abcdef123456', 'open', { title: 'Draft the note', ownerBotId: 's', priority: 'high' })
  // scope, dragging, error, draft, then the list the board would have read from the host.
  states.length = 0
  states.push({ kind: 'bot', botId: 's' }, null, '', '', [mine])
  const boardView = expand(KanbanDialog({ roster, actions }))
  assert.match(textOf(boardView), /Draft the note/)
  assert.equal(byClass(boardView, 'bt-board-card').length, 1)
  assert.equal(all(boardView).filter(node => node.props?.role === 'tab').length, 0)
})

test('the dialog nests a group subtask under its overall task (#1358)', () => {
  const overall = task('task-aaaaaa111111', 'open', { title: 'Ship it', kind: 'group', ownerBotId: 'a', priority: 'high', updatedAt: 5 })
  const child = task('task-bbbbbb222222', 'open', { title: 'Write it', ownerBotId: 's', parentId: overall.id, parentTitle: 'Ship it', priority: 'urgent', updatedAt: 6 })
  const actions = { closeBoard: () => {}, boardClose: () => {} }
  // scope, dragging, error, draft, own, groupTasks, archive
  states.length = 0
  states.push({ kind: 'group', roomId: 'war' }, null, '', '', [], [overall, child], [])
  const boardView = expand(KanbanDialog({ roster, actions }))
  const notStarted = byClass(boardView, 'bt-board-column').find(node => node.props['data-column'] === 'not-started')
  assert.match(textOf(notStarted), /Ship it/)
  assert.match(textOf(notStarted), /Write it/)
  assert.equal(all(notStarted).some(node => node.props?.['data-parent'] === overall.id), true)
})

test('Start and Complete fire from the task board', () => {
  const moved = []
  const openTask = task('task-open123', 'open', { title: 'Start me', ownerBotId: 's' })
  const workingTask = task('task-working456', 'working', { title: 'Complete me', ownerBotId: 's' })
  const actions = {
    closeBoard: () => {},
    boardClose: () => {},
    taskUpdate: async ({ id, column }) => { moved.push([id, column]); return { ok: true } },
  }
  states.length = 0
  // KanbanDialog states: scope, dragging, error, draft
  // useBoardTasks states: own, groupTasks, archive
  states.push({ kind: 'bot', botId: 's' }, null, '', '', [openTask, workingTask], [], [])
  const boardView = expand(KanbanDialog({ roster, actions }))
  
  // Find Start button on open task and click it
  const cards = all(boardView).filter(node => node.props?.['data-task'])
  const openCard = cards.find(card => card.props['data-task'] === 'task-open123')
  assert.ok(openCard, 'open task card found')
  const startButton = all(openCard).find(node => node.type === 'button' && textOf(node) === 'Start')
  assert.ok(startButton, 'Start button found on open task')
  startButton.props.onClick()
  assert.deepEqual(moved[0], ['task-open123', 'in-progress'], 'Start moved task to in-progress')
  
  // Find Complete button on working task and click it
  const workingCard = cards.find(card => card.props['data-task'] === 'task-working456')
  assert.ok(workingCard, 'working task card found')
  const completeButton = all(workingCard).find(node => node.type === 'button' && textOf(node) === 'Complete')
  assert.ok(completeButton, 'Complete button found on working task')
  completeButton.props.onClick()
  assert.deepEqual(moved[1], ['task-working456', 'done'], 'Complete moved task to done')
})

// #1252: the Done column is archive, not the board, and the slice has to be the *newest* finished
// cards — a card a member just finished has an old `createdAt`, so ordering by it would hide exactly
// the card they are looking for.
test('#1252: a group board renders the newest finished cards, not the oldest', () => {
  const active = [{ id: 'task-live', ownerBotId: 'a', title: 'Live', status: 'working', updatedAt: 1000 }]
  const archive = Array.from({ length: 37 }, (_, i) => ({
    id: `task-done-${i}`, ownerBotId: 'a', title: `Done ${i}`, status: 'accepted', progress: 100, createdAt: i, updatedAt: i,
  }))
  const merged = boardTasksFor(active, archive)
  assert.equal(merged.length, 1 + ARCHIVE_SHOWN)
  const columns = boardColumns(merged)
  assert.equal(columns['in-progress'].length, 1)
  assert.equal(columns.done.length, 20, 'the column is a literal twenty cards')
  assert.equal(columns.done.length, ARCHIVE_SHOWN)
  assert.equal(columns.done[0].id, 'task-done-36', 'the column starts at the newest finished card')
  assert.equal(columns.done.some(card => card.id === 'task-done-0'), false, 'the oldest finished card is outside the slice')

  // The card just finished: old `createdAt`, fresh `updatedAt`. It must be first, not cut off.
  const justFinished = { id: 'task-just-finished', ownerBotId: 'a', title: 'Just finished', status: 'accepted', progress: 100, createdAt: 1, updatedAt: 99 }
  const withFresh = boardColumns(boardTasksFor(active, [...archive, justFinished]))
  assert.equal(withFresh.done[0].id, 'task-just-finished', 'the card finished just now leads the column')
  assert.equal(withFresh.done.length, ARCHIVE_SHOWN)

  // The host's bounded page now carries finished rows only; the client still draws them.
  const settledPage = Array.from({ length: 5 }, (_, i) => ({
    id: `task-settled-${i}`, ownerBotId: 'a', title: `Settled ${i}`, status: 'accepted', progress: 100, createdAt: i, updatedAt: 100 + i,
  }))
  const fromBoundedPage = boardColumns(boardTasksFor(active, settledPage))
  assert.equal(fromBoundedPage.done.length, 5, 'a finished-only page still fills the Done column')
})

// #1252: the Bot-scoped archive read has to name the Bot. The host cuts the newest finished rows
// before the board filters by Bot, so a request that only carries `{ archive, limit }` spends the
// whole page on other Bots' cards and this Bot's Done column empties.
test('#1252: a Bot board asks the host for that Bot\'s archive, not the whole scope', async () => {
  const calls = []
  const otherBotCard = { id: 'task-a-old', ownerBotId: 'a', title: 'Mine', status: 'accepted', progress: 100, createdAt: 1, updatedAt: 2 }
  const actions = { tasks: (...args) => { calls.push(args); return Promise.resolve([]) } }
  effects.length = 0
  states.length = 0
  useBoardTasks(actions, { kind: 'bot', botId: 'a' })
  assert.equal(effects.length, 1, 'the board loads through one effect')
  effects.pop()()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(calls[0].length, 0, 'the default read stays the unfiltered active list')
  const archiveCall = calls.find(args => args[0]?.archive === true)
  assert.deepStrictEqual({ ...archiveCall?.[0] }, { botId: 'a', archive: true, limit: ARCHIVE_SHOWN }, 'the archive read names the Bot')

  // A group board has no Bot to name; its read stays scoped to the room.
  calls.length = 0
  effects.length = 0
  states.length = 0
  useBoardTasks(actions, { kind: 'group', roomId: 'war' })
  effects.pop()()
  await new Promise(resolve => setImmediate(resolve))
  const groupArchive = calls.find(args => args[0]?.archive === true)
  assert.deepStrictEqual({ ...groupArchive?.[0] }, { roomId: 'war', archive: true, limit: ARCHIVE_SHOWN }, 'the group archive read stays room-scoped')

  // The page the host returns for that query still fills the Done column after the Bot filter.
  const done = boardColumns(boardTasksFor([], [otherBotCard].filter(task => task.ownerBotId === 'a'))).done
  assert.equal(done.length, 1, 'the Bot\'s own finished card fills the Done column')
})

// #2045: the Done column is one archive page (`ARCHIVE_SHOWN` cards), and the page is a cut, not a
// count. The heading prints `tasks.length`, so a Bot with 45 finished tasks reads `Done · 20`, and
// the rail adds the page to the active list, so it reads `20/22`. Neither number is what the owner
// has; when the page is full the board must not pretend it is the total. It may still say how much
// it drew — `20 newest` — and that there are more where those came from — `20+ done`. A page that
// is not full is the whole history, so those two numbers stay exactly as they are today.
const settledTasks = (count, extra = {}) => Array.from({ length: count }, (_, index) => task(`task-done-${index}`, 'accepted', {
  title: `Finished ${index}`, progress: 100, createdAt: index, updatedAt: 100 + index, ...extra,
}))
const boardWith = (scope, own, archive, groupActive = []) => {
  states.length = 0
  // A room board's active list lives in the second of the three board-task slots (P-364); a Bot
  // board's lives in the first. Both are preset here rather than loaded, like the archive page.
  states.push(scope, null, '', '', own, groupActive, archive)
  const view = expand(KanbanDialog({ roster, actions: { closeBoard: () => {}, boardClose: () => {} } }))
  const column = name => byClass(view, 'bt-board-column').find(node => node.props['data-column'] === name)
  const railMeta = id => {
    const row = all(view).find(node => node.props?.['data-id'] === id)
    const meta = byClass(row, 'bt-board-rail-meta')[0]
    return meta ? textOf(meta) : ''
  }
  return { view, column, railMeta }
}

test('#2045: a full archive page says how many rows were drawn and that there are more, on a Bot board and a group board', () => {
  const active = [
    task('task-open-1', 'open', { title: 'Still to do', ownerBotId: 's' }),
    task('task-work-1', 'working', { title: 'Being done', ownerBotId: 's' }),
  ]
  const botBoard = boardWith({ kind: 'bot', botId: 's' }, active, settledTasks(45))
  const done = botBoard.column('done')
  assert.equal(byClass(done, 'bt-board-card').length, ARCHIVE_SHOWN, 'the column still draws one archive page')
  assert.equal(textOf(done).includes('20 newest'), true, 'the heading says these are the newest twenty, not the total')
  // The other two columns are the active list, not a page, so their counts stay plain numbers.
  assert.equal(textOf(botBoard.column('not-started')).includes('newest'), false, 'the open column keeps a plain count')
  assert.equal(textOf(botBoard.column('in-progress')).includes('newest'), false, 'the working column keeps a plain count')
  assert.equal(botBoard.railMeta('s'), '20+ done', 'the rail says at least twenty are done, and stops claiming a total')

  // The group board reads the same archive page and must say the same thing.
  const groupBoard = boardWith({ kind: 'group', roomId: 'war' }, [], settledTasks(45, { ownerBotId: 'a' }))
  const groupDone = groupBoard.column('done')
  assert.equal(byClass(groupDone, 'bt-board-card').length, ARCHIVE_SHOWN)
  assert.equal(textOf(groupDone).includes('20 newest'), true, 'a full group page is marked the same way')
})

test('#2045: a page that is not full still reads as the whole history, unchanged', () => {
  const active = [
    task('task-open-1', 'open', { title: 'Still to do', ownerBotId: 's' }),
    task('task-work-1', 'working', { title: 'Being done', ownerBotId: 's' }),
  ]
  const short = boardWith({ kind: 'bot', botId: 's' }, active, settledTasks(3))
  assert.equal(byClass(short.column('done'), 'bt-board-card').length, 3)
  assert.equal(textOf(short.column('done')).includes('newest'), false, 'three rows are three rows, with no hedge')
  assert.equal(short.railMeta('s'), '3/5', 'the rail keeps {done}/{total} when nothing was cut')

  // Exactly one page full is the boundary: the board cannot know whether a 21st card exists, so the
  // full-page wording has to start at the page size itself, never a row later.
  const exact = boardWith({ kind: 'bot', botId: 's' }, active, settledTasks(ARCHIVE_SHOWN))
  assert.equal(exact.railMeta('s'), '20+ done', 'a page at the limit is treated as cut')
  const under = boardWith({ kind: 'bot', botId: 's' }, active, settledTasks(ARCHIVE_SHOWN - 1))
  assert.equal(under.railMeta('s'), '19/21', 'one row under the limit is the whole history')
})

// #2045: on a group board the archive page is cut across the whole room, so one Bot's share of it
// is a slice of that Bot's history, not its total. A Bot with 18 of the 20 newest finished cards
// must not read `18/18`, which claims the room has nothing older of its, and the hedge may not be
// keyed on a Bot that happens to fill the page: any Bot whose finished rows are drawn from a cut
// page is a lower bound.
test('#2045: a Bot whose share of a full group page is drawn reads as a lower bound, not a total', () => {
  const page = (owner, count, offset) => Array.from({ length: count }, (_, index) => task(`task-done-${owner}-${offset + index}`, 'accepted', {
    title: `Finished ${offset + index}`, ownerBotId: owner, progress: 100, createdAt: offset + index, updatedAt: 100 + offset + index,
  }))
  const archive = [...page('a', 18, 0), ...page('s', 2, 18)]
  const group = boardWith({ kind: 'group', roomId: 'war' }, [], archive)
  assert.equal(byClass(group.column('done'), 'bt-board-card').length, ARCHIVE_SHOWN, 'the column still draws one page')
  assert.equal(textOf(group.column('done')).includes('20 newest'), true, 'the heading still names the page as a cut')
  assert.equal(group.railMeta('a'), '18+ done', 'eighteen of a cut page is at least eighteen, never a total')
  assert.equal(group.railMeta('s'), '2+ done', 'a smaller share of the same cut page is a lower bound too')
  // One row under the page is the whole room history, so the same rail reads its exact counts.
  // P-364 rewrote this pair: the room's active cards used to fall out of the rail altogether (the
  // `own` list is only ever filled on a Bot board), so `1/1` and `2/2` counted the archive page
  // alone — the defect this test now pins. Two active cards are part of the same totals.
  const shortRoom = boardWith({ kind: 'group', roomId: 'war' }, [], [...page('a', 1, 0), ...page('s', 2, 1)], [
    task('task-open-a', 'open', { title: 'Open for a', ownerBotId: 'a' }),
    task('task-work-s', 'working', { title: 'Work for s', ownerBotId: 's' }),
  ])
  assert.equal(shortRoom.railMeta('a'), '1/2', 'a short group page is a total, and the active card is in it')
  assert.equal(shortRoom.railMeta('s'), '2/3', 'and every Bot on it reads the same way')
})

// #2045: the hedge belongs to the Bot's own drawn finished rows, not to whatever its width adds up
// to. A second Bot with a page-worth of active cards and none finished is not a Bot with 20 done.
test('#2045: the rail hedge follows the Bot\'s drawn done rows, not its total', () => {
  const active = Array.from({ length: ARCHIVE_SHOWN }, (_, index) => task(`task-open-${index}`, 'open', {
    title: `Open ${index}`, ownerBotId: 'a', progress: 0, createdAt: index, updatedAt: index,
  }))
  const board = boardWith({ kind: 'bot', botId: 's' }, active, settledTasks(ARCHIVE_SHOWN))
  assert.equal(board.railMeta('s'), '20+ done', 'the Bot whose own page is full reads as a cut')
  assert.equal(board.railMeta('a'), '0/20', 'twenty active cards are not twenty finished ones')
})

// P-364: the rail counts what the board draws (#2045), but the room scope only ever fills the
// board's active list, and the rail was adding up `own` — a list that stays empty on a room board.
// So a room rail counted the archive page alone: a Bot with four drawn cards under one finished one
// read `1/1`, and a Bot whose cards are all still active read nothing at all.
test('P-364: a room board rail counts the room\'s active cards, not only its archive page', () => {
  const room = boardWith({ kind: 'group', roomId: 'war' }, [], [task('task-done-s', 'accepted', {
    title: 'Finished for s', ownerBotId: 's', progress: 100, createdAt: 1, updatedAt: 2,
  })], [
    task('task-open-s', 'open', { title: 'Open for s', ownerBotId: 's', createdAt: 3, updatedAt: 4 }),
    task('task-working-s', 'working', { title: 'Working for s', ownerBotId: 's', createdAt: 5, updatedAt: 6 }),
    task('task-open-s-2', 'open', { title: 'Another for s', ownerBotId: 's', createdAt: 7, updatedAt: 8 }),
    task('task-open-a', 'open', { title: 'Open for a', ownerBotId: 'a', createdAt: 9, updatedAt: 10 }),
  ])
  assert.equal(byClass(room.column('in-progress'), 'bt-board-card').length, 1, 'the working card is drawn')
  assert.equal(room.railMeta('s'), '1/4', 'four drawn cards, one of them finished: {done}/{total}, not {done}/{done}')
  assert.equal(room.railMeta('a'), '0/1', 'a Bot with an active card and none finished is 0 of 1, not a blank rail')
})

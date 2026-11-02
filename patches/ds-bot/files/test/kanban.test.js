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
  // #2069: a room is only ever reached from a Bot board — the dialog opens on `rail.bots[0]` — so
  // `own` is never empty when a room is drawn; presetting it to `[]` here made the rail's double
  // count invisible. Seed it from the Bot board's read of the same room cards.
  const botRead = scope?.kind === 'group' ? groupActive : own
  states.push(scope, null, '', '', botRead, groupActive, archive)
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

// P-364 follow-up: `boardWith` seeds both board lists with the same cards when the scope is a room,
// so no case could tell which list the rail's counts read. These arms seed them apart: a room board
// whose `own` still holds the Bot board's read, and a Bot board reached after a room left its list
// behind. Either mutation of `counts` (always `own`, always `groupTasks`) has to show here.
const boardWithLists = (scope, own, groupActive, archive = []) => {
  states.length = 0
  states.push(scope, null, '', '', own, groupActive, archive)
  const view = expand(KanbanDialog({ roster, actions: { closeBoard: () => {}, boardClose: () => {} } }))
  const railMeta = id => {
    const row = all(view).find(node => node.props?.['data-id'] === id)
    const meta = byClass(row, 'bt-board-rail-meta')[0]
    return meta ? textOf(meta) : ''
  }
  return { view, railMeta }
}

test('P-364: the rail counts the list the board draws, never the one the other scope left behind', () => {
  // A room board: `own` still holds the Bot board's read (one open card for Writer), the room's
  // list holds Writer's three active cards and Chief's one. The rail counts the room's list.
  const staleOwn = [task('task-open-stale', 'open', { title: 'Stale for s', ownerBotId: 's', createdAt: 1, updatedAt: 2 })]
  const roomList = [
    task('task-open-s', 'open', { title: 'Open for s', ownerBotId: 's', createdAt: 3, updatedAt: 4 }),
    task('task-working-s', 'working', { title: 'Working for s', ownerBotId: 's', createdAt: 5, updatedAt: 6 }),
    task('task-open-s-2', 'open', { title: 'Another for s', ownerBotId: 's', createdAt: 7, updatedAt: 8 }),
    task('task-open-a', 'open', { title: 'Open for a', ownerBotId: 'a', createdAt: 9, updatedAt: 10 }),
  ]
  const room = boardWithLists({ kind: 'group', roomId: 'war' }, staleOwn, roomList)
  assert.equal(room.railMeta('s'), '0/3', 'the room board counts the room\'s three, not the stale single card')
  assert.equal(room.railMeta('a'), '0/1', 'a Bot that only appears in the room\'s list is counted from it')
  assert.notEqual(room.railMeta('s'), '0/1', 'the stale Bot board read is not what the rail counts')

  // A Bot board: `own` holds Writer's two active cards, the room's list still holds four. The rail
  // counts the Bot's two, so one direction's mutation cannot hide behind the other's.
  const ownList = [
    task('task-open-s', 'open', { title: 'Open for s', ownerBotId: 's', createdAt: 1, updatedAt: 2 }),
    task('task-working-s', 'working', { title: 'Working for s', ownerBotId: 's', createdAt: 3, updatedAt: 4 }),
  ]
  const leftRoom = [
    task('task-open-s', 'open', { title: 'Open for s', ownerBotId: 's', createdAt: 5, updatedAt: 6 }),
    task('task-working-s', 'working', { title: 'Working for s', ownerBotId: 's', createdAt: 7, updatedAt: 8 }),
    task('task-open-s-2', 'open', { title: 'Another for s', ownerBotId: 's', createdAt: 9, updatedAt: 10 }),
    task('task-open-s-3', 'open', { title: 'Yet another for s', ownerBotId: 's', createdAt: 11, updatedAt: 12 }),
  ]
  const bot = boardWithLists({ kind: 'bot', botId: 's' }, ownList, leftRoom)
  assert.equal(bot.railMeta('s'), '0/2', 'the Bot board counts its own two, not the room list still in state')
  assert.notEqual(bot.railMeta('s'), '0/4', 'the room list is not what a Bot board counts')
})

// P-360: the rail switch from one Bot to another. The fake React at the top of this file hands an
// effect back to the test and never re-runs one, so a switch case written against it passes whatever
// the hook does (#1810). This is a second, stateful context: hook slots per component, an effect
// re-run only when its deps change, a setter that re-renders, and the board's poll on a fake clock.
function mountBoard(actions) {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const runtime = { instances: new Map(), key: 'root', index: 0, dirty: false, timer: 0, timers: new Map() }
  const instance = (key) => {
    let found = runtime.instances.get(key)
    if (!found) {
      found = { slots: [], refs: [], pending: [], deps: new Map(), cleanups: new Map() }
      runtime.instances.set(key, found)
    }
    return found
  }
  const scoped = (key, run) => {
    const previousKey = runtime.key
    const previousIndex = runtime.index
    runtime.key = key
    runtime.index = 0
    try { return run() } finally { runtime.key = previousKey; runtime.index = previousIndex }
  }
  const react = {
    createElement: h, Fragment: Symbol('fragment'),
    useState: (initial) => {
      const slot = instance(runtime.key)
      const index = runtime.index++
      if (!(index in slot.slots)) slot.slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.slots[index]) : next
        if (Object.is(value, slot.slots[index])) return
        slot.slots[index] = value
        runtime.dirty = true
      }
      return [slot.slots[index], set]
    },
    useEffect: (run, deps) => { instance(runtime.key).pending.push({ index: runtime.index++, run, deps }) },
    useLayoutEffect: (run, deps) => { instance(runtime.key).pending.push({ index: runtime.index++, run, deps }) },
    useMemo: fn => fn(), useCallback: fn => fn(),
    useRef: (current) => {
      const slot = instance(runtime.key)
      const index = runtime.index++
      if (!(index in slot.refs)) slot.refs[index] = { current }
      return slot.refs[index]
    },
  }
  const commit = () => {
    for (const slot of runtime.instances.values()) {
      const pending = slot.pending
      slot.pending = []
      for (const { index, run, deps } of pending) {
        const previous = slot.deps.get(index)
        const changed = !deps || !previous || deps.length !== previous.length || deps.some((dep, at) => !Object.is(dep, previous[at]))
        if (!changed) continue
        const cleanup = slot.cleanups.get(index)
        if (typeof cleanup === 'function') cleanup()
        slot.cleanups.delete(index)
        slot.deps.set(index, deps ? [...deps] : null)
        const next = run()
        if (typeof next === 'function') slot.cleanups.set(index, next)
      }
    }
  }
  const expandLive = (node, path = 'r') => {
    if (node === null || node === undefined) return null
    if (Array.isArray(node)) return node.map((child, at) => expandLive(child, `${path}.${at}`))
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return scoped(path, () => expandLive(node.type({ ...node.props, children: node.children }), path))
    return { ...node, children: (node.children ?? []).map((child, at) => expandLive(child, `${path}.${at}`)) }
  }
  const env = {
    module: { exports: {} },
    setTimeout, clearTimeout,
    // The dialog's escape layer and its `#task=` deep link touch the page; neither is what this
    // case reads, so they get the smallest window that lets the board mount.
    window: { location: { hash: '' }, addEventListener() {}, removeEventListener() {} },
    setInterval: (fn, ms) => {
      const id = ++runtime.timer
      runtime.timers.set(id, { every: Math.max(1, Number(ms) || 1), fn })
      return id
    },
    clearInterval: (id) => runtime.timers.delete(id),
  }
  env.require = (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`no platform module ${name}`)
  }
  runInNewContext(bundle.outputFiles[0].text, env)
  const live = env.module.exports
  let tree = null
  const draw = () => {
    runtime.dirty = false
    for (const slot of runtime.instances.values()) slot.pending = []
    tree = expandLive(h(live.KanbanDialog, { roster, actions }))
    commit()
    return tree
  }
  const settle = async () => {
    for (let guard = 0; guard < 50; guard += 1) {
      await new Promise(resolve => setImmediate(resolve))
      if (!runtime.dirty) return tree
      draw()
    }
    throw new Error('the board never settled')
  }
  const rail = (botId) => {
    const button = all(tree).find(node => node.type === 'button' && node.props?.['data-kind'] === 'bot' && node.props?.['data-id'] === botId)
    assert.ok(button, `the rail names Bot ${botId}`)
    button.props.onClick()
  }
  // #2069: a room board is reached by clicking a room in the same rail, so the harness drives both
  // kinds of row, not only the Bot rows P-360 needed.
  const room = (roomId) => {
    const button = all(tree).find(node => node.type === 'button' && node.props?.['data-kind'] === 'group' && node.props?.['data-id'] === roomId)
    assert.ok(button, `the rail names room ${roomId}`)
    button.props.onClick()
  }
  const railMeta = (id) => {
    const row = all(tree).find(node => node.type === 'button' && node.props?.['data-id'] === id)
    const meta = byClass(row, 'bt-board-rail-meta')[0]
    return meta ? textOf(meta) : ''
  }
  const column = (name) => byClass(tree, 'bt-board-column').find(node => node.props['data-column'] === name)
  return { draw, settle, rail, room, railMeta, column, get tree() { return tree } }
}

// A Bot board's Done column is that Bot's own archive page. Switching the rail therefore has to
// send a fresh `{ botId, archive: true, limit: 20 }` read: the loaded page is scoped to the Bot it
// was asked for, and the column filters it by the newly selected Bot, so a page kept from the
// previous Bot is filtered down to nothing and the Done column reads empty.
test('P-360: switching the rail re-reads the archive, and the new Bot draws its own Done page', async () => {
  const calls = []
  const finished = (botId, count) => Array.from({ length: count }, (_, index) => ({
    id: `task-${botId}-done-${index}`, ownerBotId: botId, title: `${botId.toUpperCase()} finished ${index}`,
    status: 'accepted', progress: 100, createdAt: index, updatedAt: 100 + index,
  }))
  const pages = { a: finished('a', ARCHIVE_SHOWN), s: finished('s', ARCHIVE_SHOWN) }
  const actions = {
    closeBoard: () => {},
    boardClose: () => {},
    tasks: (query) => {
      calls.push({ ...query })
      return Promise.resolve(query?.archive ? pages[query.botId] ?? [] : [])
    },
  }
  const board = mountBoard(actions)
  const archiveReads = () => calls.filter(query => query?.archive).map(query => query.botId)

  board.draw()
  await board.settle()
  // The board opens on the first Bot of the rail (Chief `a`).
  assert.deepEqual(archiveReads(), ['a'], 'the board opens on the first Bot and reads its archive')
  assert.equal(byClass(board.column('done'), 'bt-board-card').length, ARCHIVE_SHOWN, 'Chief draws its own finished cards')
  assert.match(textOf(board.column('done')), /A finished 19/)

  board.rail('s')
  await board.settle()
  // The switch has to ask for Writer's page, not keep Chief's: the loaded rows are Chief's, and the
  // column filters them by Writer, so a kept page is an empty column.
  assert.deepEqual(archiveReads(), ['a', 's'], 'switching to Writer asks for Writer\'s archive page')
  assert.deepEqual(calls.filter(query => query?.archive).at(-1), { botId: 's', archive: true, limit: ARCHIVE_SHOWN }, 'the new read names the new Bot')
  assert.equal(byClass(board.column('done'), 'bt-board-card').length, ARCHIVE_SHOWN, 'Writer draws its own finished cards, not an empty column')
  assert.match(textOf(board.column('done')), /S finished 19/)
  assert.doesNotMatch(textOf(board.column('done')), /A finished/)

  // And back again: every switch re-reads, not only the first one.
  board.rail('a')
  await board.settle()
  assert.deepEqual(archiveReads(), ['a', 's', 'a'], 'switching back to Chief reads Chief\'s page again')
  assert.equal(byClass(board.column('done'), 'bt-board-card').length, ARCHIVE_SHOWN, 'Chief draws its own finished cards again')
  assert.match(textOf(board.column('done')), /A finished 19/)
})

// #2069: a room board reached from a Bot board counted the room's active cards twice. The dialog
// always opens on the first Bot of the rail, and that Bot's default read is the unfiltered active
// list — a card in a room the Bot may act on lands in `own` as well as in the room's own read — so
// the rail added the same card from both lists. The card the room board draws once was counted
// twice; the room's drawn columns never showed the second copy, only the rail did.
test('#2069: a room board reached from a Bot board counts each active card once in the rail', async () => {
  const calls = []
  const roomCard = { id: 'task-open-s', ownerBotId: 's', title: 'Open for s', status: 'open', progress: 0, createdAt: 3, updatedAt: 4 }
  const finishedCard = { id: 'task-done-s', ownerBotId: 's', title: 'Finished for s', status: 'accepted', progress: 100, createdAt: 1, updatedAt: 2 }
  const actions = {
    closeBoard: () => {},
    boardClose: () => {},
    tasks: (query) => {
      calls.push({ ...query })
      if (query?.archive) return Promise.resolve([finishedCard])
      if (query?.roomId) return Promise.resolve([roomCard])
      // The host's default read carries every card the Bot may act on, room cards included.
      return Promise.resolve([roomCard])
    },
  }
  const board = mountBoard(actions)
  board.draw()
  await board.settle()
  assert.deepEqual(calls[0], {}, 'the board opens on the default active read')
  // The Bot board's read really did fill `own`: the rail already counts the room card there.
  assert.equal(board.railMeta('s'), '0/1', 'the Bot board rail counted the room card its read returned')

  board.room('war')
  await board.settle()
  assert.deepEqual(calls.filter(query => query?.roomId && !query.archive).at(-1), { roomId: 'war' }, 'the room board reads the room\'s active cards')
  // The room board draws the card once, so the rail counts it once: one finished card in the archive
  // page plus the one active card is `1/2`, not the `1/3` the doubled list produced.
  assert.equal(byClass(board.column('not-started'), 'bt-board-card').length, 1, 'the room\'s active card is drawn once')
  assert.equal(byClass(board.column('done'), 'bt-board-card').length, 1, 'the room\'s finished card is drawn once')
  assert.equal(board.railMeta('s'), '1/2', 'the rail counts the drawn active card once, plus the archive page')
})

// The Done column says when a card finished; the other columns leave the footer alone.
const HOUR = 3_600_000
const MINUTE = 60_000
const cardIn = (column, id) => all(column).find(node => node.props?.['data-task'] === id)
const whenOf = (column, id) => {
  const node = byClass(cardIn(column, id), 'bt-board-when')[0]
  return node === undefined ? undefined : textOf(node)
}
// A card finished 2 h 5 min ago and edited a minute ago: `updatedAt` and the last actor entry both
// say `1 min`; only the first terminal entry knows when the card really finished.
const editedAfterFinish = (id, extra = {}, status = 'accepted') => task(id, status, {
  title: 'Finished and edited', progress: 100,
  updatedAt: Date.now() - MINUTE,
  actors: [
    { status: 'working', at: Date.now() - 10 * MINUTE },
    { status, at: Date.now() - 125 * MINUTE },
    { status, at: Date.now() - MINUTE, by: 'updated' },
  ],
  ...extra,
})

// A: the stamp is the first terminal actor entry, not the last one and not `updatedAt`.
test('a Done card says when it finished, from the first terminal actor entry', () => {
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [editedAfterFinish('task-done111111')])
  assert.equal(whenOf(board.column('done'), 'task-done111111'), '2 h')
})

// B: an unfinished card keeps the footer it had.
test('an In progress card carries no finish time', () => {
  const working = task('task-work222222', 'working', {
    title: 'Still working', ownerBotId: 's', progress: 40, updatedAt: Date.now() - MINUTE,
    actors: [{ status: 'working', at: Date.now() - 10 * MINUTE }],
  })
  const board = boardWith({ kind: 'bot', botId: 's' }, [working], [])
  const column = board.column('in-progress')
  assert.equal(byClass(cardIn(column, 'task-work222222'), 'bt-board-when').length, 0)
  assert.match(textOf(cardIn(column, 'task-work222222')), /40%/)
})

// C: a row written before the actor history existed falls back to `updatedAt`.
test('a Done card with no actor entry falls back to updatedAt', () => {
  const old = task('task-done333333', 'accepted', {
    title: 'Finished before the history', ownerBotId: 's', progress: 100, updatedAt: Date.now() - 3 * HOUR,
  })
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [old])
  assert.equal(whenOf(board.column('done'), 'task-done333333'), '3 h')
})

// D: no stamp at all draws nothing — `relativeShort(undefined)` is `Invalid Date`, and 0 is 1970.
test('a Done card without a usable timestamp draws no time and no Invalid Date', () => {
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [
    task('task-done444444', 'accepted', { title: 'No stamp', ownerBotId: 's', progress: 100, updatedAt: undefined }),
    task('task-done555555', 'accepted', { title: 'Zero stamp', ownerBotId: 's', progress: 100, updatedAt: 0 }),
  ])
  for (const id of ['task-done444444', 'task-done555555']) {
    assert.equal(byClass(cardIn(board.column('done'), id), 'bt-board-when').length, 0)
    assert.doesNotMatch(textOf(cardIn(board.column('done'), id)), /Invalid Date/)
  }
})

// E: a room board draws the same node on its Done cards.
test('a room board Done card says when it finished too', () => {
  const board = boardWith({ kind: 'group', roomId: 'war' }, [], [editedAfterFinish('task-done666666', { ownerBotId: 'a' })])
  assert.equal(whenOf(board.column('done'), 'task-done666666'), '2 h')
})

// F: `cancelled` and `failed` are terminal too. #2077 wrote the set (`TERMINAL_STATUSES` in
// `kanban.js`) and `COLUMN_OF` (`src/shared/task-board.js`) maps all three terminal statuses to
// Done, but nothing asserted either, so removing `cancelled`/`failed` from the set left this file
// green. A card that ended either way sits in Done and its stamp is the entry that ended it, never
// the plain edit `updatedAt` names.
test('a cancelled card is terminal: it sits in Done and says when it was cancelled', () => {
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [editedAfterFinish('task-cancel777777', {}, 'cancelled')])
  const done = board.column('done')
  assert.notEqual(cardIn(done, 'task-cancel777777'), undefined, 'a cancelled card is drawn in Done')
  assert.equal(whenOf(done, 'task-cancel777777'), '2 h')
})

test('a failed card is terminal: it sits in Done and says when it failed', () => {
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [editedAfterFinish('task-failed888888', {}, 'failed')])
  const done = board.column('done')
  assert.notEqual(cardIn(done, 'task-failed888888'), undefined, 'a failed card is drawn in Done')
  assert.equal(whenOf(done, 'task-failed888888'), '2 h')
})

// G: the other statuses are not terminal. `blocked` waits on a person and `result-ready` on its
// requester (`task-board.js`), so both stay In progress and neither ends the card's history.
test('a blocked or result-ready card is not terminal and stays In progress', () => {
  const waiting = task('task-block999999', 'blocked', { title: 'Waiting on a person', ownerBotId: 's', progress: 20, updatedAt: 2 })
  const ready = task('task-readyaaaaaa', 'result-ready', { title: 'Waiting on the result', ownerBotId: 's', progress: 80, updatedAt: 3 })
  const board = boardWith({ kind: 'bot', botId: 's' }, [waiting, ready], [])
  const idsIn = column => byClass(board.column(column), 'bt-board-card').map(node => node.props['data-task'])
  assert.deepEqual(idsIn('in-progress'), ['task-readyaaaaaa', 'task-block999999'])
  assert.deepEqual(idsIn('done'), [])
  assert.deepEqual(idsIn('not-started'), [])
})

// H: a non-terminal actor entry ahead of the terminal one does not win the stamp, even when it is
// the first entry. Adding `open`, `claimed`, `working`, `blocked` or `result-ready` to
// `TERMINAL_STATUSES` would stamp the card with the moment it entered that state instead.
test('a non-terminal actor entry does not end a Done card, even when it comes first', () => {
  const actors = [
    { status: 'open', at: Date.now() - 330 * MINUTE },
    { status: 'claimed', at: Date.now() - 300 * MINUTE },
    { status: 'working', at: Date.now() - 270 * MINUTE },
    { status: 'blocked', at: Date.now() - 240 * MINUTE },
    { status: 'result-ready', at: Date.now() - 180 * MINUTE },
    { status: 'accepted', at: Date.now() - 125 * MINUTE },
    { status: 'accepted', at: Date.now() - MINUTE, by: 'updated' },
  ]
  const board = boardWith({ kind: 'bot', botId: 's' }, [], [
    task('task-done999999', 'accepted', { title: 'Finished after a block', ownerBotId: 's', progress: 100, updatedAt: Date.now() - MINUTE, actors }),
  ])
  assert.equal(whenOf(board.column('done'), 'task-done999999'), '2 h')
})

// Project board, slice 1 (#1701): one read-only Project view over the task records.
// The project identity is the durable Project record (#1695): a Bot or a group names a
// project on its own record, the roster already carries `projectId`, and this file's
// board only narrows the one task read by that binding — no second store, no endpoint.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const kanbanPath = fileURLToPath(new URL('../src/client/kanban.js', import.meta.url))
const source = readFileSync(kanbanPath, 'utf8')

const bundle = await build({
  entryPoints: [kanbanPath],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
const states = []
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
const { KanbanDialog, boardRail, projectColumns, projectScope } = module.exports

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

// Two projects, each with one Bot and one group; two Bots and one group stay unbound.
const HOURS = 3_600_000
const rosterWithProjects = () => {
  const roster = {
    self: { memberId: 'm1' },
    bots: [
      { id: 'a', name: 'Chief', ownerId: 'm1', createdAt: 1, projectId: 'project-rocket' },
      { id: 's', name: 'Writer', ownerId: 'm1', createdBy: 'a', createdAt: 2, projectId: 'project-rocket' },
      { id: 'b', name: 'Other', ownerId: 'm1', createdBy: 'a', createdAt: 3, projectId: 'project-garden' },
      { id: 'c', name: 'Loose', ownerId: 'm1', createdAt: 4 },
    ],
    rooms: [
      { id: 'war', name: 'War', admin: 'a', projectId: 'project-rocket', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
      { id: 'garden', name: 'Garden', admin: 'a', projectId: 'project-garden', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
    ],
  }
  roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
  roster.roomsById = Object.fromEntries(roster.rooms.map(room => [room.id, room]))
  return roster
}
const unboundRoster = () => {
  const roster = {
    self: { memberId: 'm1' },
    bots: [
      { id: 'a', name: 'Chief', ownerId: 'm1', createdAt: 1 },
      { id: 's', name: 'Writer', ownerId: 'm1', createdBy: 'a', createdAt: 2 },
    ],
    rooms: [
      { id: 'war', name: 'War', admin: 'a', participants: [{ kind: 'human', id: 'm1', role: 'member' }] },
    ],
  }
  roster.byId = Object.fromEntries(roster.bots.map(bot => [bot.id, bot]))
  roster.roomsById = Object.fromEntries(roster.rooms.map(room => [room.id, room]))
  return roster
}
const projects = [
  { id: 'project-rocket', name: 'Rocket', status: 'active' },
  { id: 'project-garden', name: 'Garden', status: 'active' },
  { id: 'project-archive', name: 'Old', status: 'archived' },
]

const task = (id, status, extra) => ({ id, status, title: `Task ${id}`, ownerBotId: 'a', priority: 'normal', progress: 0, updatedAt: 1, ...extra })

// KanbanDialog's preset states: scope, dragging, error, draft, then useBoardTasks'
// own, groupTasks, archive, projects.
function dialog(roster, { scope, own = [], archive = [], projectList = projects, actions = {} } = {}) {
  states.length = 0
  states.push(scope, null, '', '', own, [], archive, projectList)
  return expand(KanbanDialog({ roster, actions: { closeBoard: () => {}, ...actions } }))
}
const cardsOf = tree => all(tree).filter(node => typeof node.props?.['data-task'] === 'string')
const projectRows = tree => all(tree).filter(node => node.props?.['data-kind'] === 'project')

test('#1701: the project board splits in flight, waiting and delivered without counting a task twice', () => {
  const now = 1_000 * HOURS
  const list = [
    task('task-open', 'open'),
    task('task-claimed', 'claimed'),
    task('task-working', 'working'),
    task('task-waiting', 'blocked', { waitingFor: 'input', inputRequest: { id: 'q1', question: 'Which one?' } }),
    task('task-result', 'result-ready'),
    task('task-shipped', 'accepted', { progress: 100, updatedAt: now - 23 * HOURS }),
    task('task-old', 'accepted', { progress: 100, updatedAt: now - 25 * HOURS }),
  ]
  const columns = projectColumns(list, now)
  // Join, not deepEqual: the module builds its arrays in the test's own vm realm.
  const ids = column => columns[column].map(card => card.id).join('|')
  assert.equal(ids('inFlight'), 'task-open|task-claimed|task-working')
  assert.equal(ids('waiting'), 'task-waiting|task-result')
  assert.equal(ids('delivered'), 'task-shipped')
  const seen = [...columns.inFlight, ...columns.waiting, ...columns.delivered].map(card => card.id)
  assert.equal(new Set(seen).size, seen.length, 'no task is counted twice')
  assert.equal(seen.length, 6, 'the only card outside the three columns is the one older than 24h')
})

test('#1701: delivered today reads status and a 24h window on updatedAt', () => {
  const now = 1_000 * HOURS
  const columns = projectColumns([
    task('task-fresh', 'accepted', { progress: 100, updatedAt: now - 1 * HOURS }),
    task('task-stale', 'accepted', { progress: 100, updatedAt: now - 30 * HOURS }),
    task('task-cancelled', 'cancelled', { updatedAt: now - 1 * HOURS }),
    task('task-failed', 'failed', { updatedAt: now - 1 * HOURS }),
    task('task-working', 'working', { updatedAt: now - 1 * HOURS }),
  ], now)
  assert.equal(columns.delivered.map(card => card.id).join('|'), 'task-fresh')
  assert.equal(columns.inFlight.some(card => card.id === 'task-working'), true, 'a fresh working card is in flight, not delivered')
  assert.equal(columns.waiting.some(card => card.id === 'task-failed'), false, 'a failed card is not waiting on the owner')
  const everywhere = [...columns.inFlight, ...columns.waiting, ...columns.delivered].map(card => card.id)
  for (const gone of ['task-stale', 'task-cancelled', 'task-failed']) assert.equal(everywhere.includes(gone), false, gone)
})

test('#1701: projectScope is the one place that turns a project into its members', () => {
  const declarations = source.match(/export function projectScope\s*\(/g) ?? []
  assert.equal(declarations.length, 1, 'exactly one declaration of projectScope')
  const start = source.indexOf('export function useBoardTasks')
  assert.notEqual(start, -1, 'useBoardTasks is a top-level declaration')
  const rest = source.slice(start + 'export function useBoardTasks'.length)
  const next = Math.min(...['\nexport function ', '\nfunction ', '\nexport const '].map(marker => {
    const at = rest.indexOf(marker)
    return at === -1 ? Number.POSITIVE_INFINITY : at
  }))
  const end = start + 'export function useBoardTasks'.length + next
  const declaration = source.indexOf('export function projectScope(') + 'export function '.length
  const calls = [...source.matchAll(/projectScope\(/g)].map(match => match.index)
  assert.ok(calls.length >= 2, 'the declaration and at least one call exist')
  for (const at of calls) {
    if (at === declaration) continue
    assert.ok(at > start && at < end, `projectScope() is called inside useBoardTasks, not at offset ${at}`)
  }
  assert.equal((source.match(/TEMPORARY/g) ?? []).length, 0, 'the temporary boundary marker is gone')
})

test('#1701: a Bot bound to another project never shows on this board', () => {
  const roster = rosterWithProjects()
  const own = [
    task('task-rocket', 'working', { ownerBotId: 'a' }),
    task('task-garden', 'working', { ownerBotId: 'b' }),
    task('task-loose', 'working', { ownerBotId: 'c' }),
    task('task-room', 'working', { ownerBotId: 'c', origin: { roomId: 'garden' } }),
  ]
  const scope = projectScope('project-rocket', roster)
  assert.equal([...scope.botIds].sort().join('|'), 'a|s')
  assert.equal([...scope.roomIds].join('|'), 'war')

  const rocket = dialog(roster, { scope: { kind: 'project', projectId: 'project-rocket' }, own })
  assert.equal(cardsOf(rocket).map(node => node.props['data-task']).join('|'), 'task-rocket')

  const garden = dialog(roster, { scope: { kind: 'project', projectId: 'project-garden' }, own })
  assert.equal(cardsOf(garden).map(node => node.props['data-task']).join('|'), 'task-garden|task-room')
})

test('#1701: the rail lists one row per active project and keeps the Bot rows as they were', () => {
  const roster = rosterWithProjects()
  const before = boardRail(roster)
  const tree = dialog(roster, { scope: { kind: 'project', projectId: 'project-rocket' } })
  assert.equal(projectRows(tree).map(node => node.props['data-id']).join('|'), 'project-rocket|project-garden', 'archived projects and empty ones are not rail rows')
  assert.match(textOf(tree), /Rocket/)
  assert.deepEqual(boardRail(roster), before, 'boardRail itself is untouched')
  const bots = all(tree).filter(node => node.props?.['data-kind'] === 'bot').map(node => node.props['data-id'])
  assert.equal(bots.join('|'), before.bots.map(row => row.id).join('|'), 'every Bot row is still there')
  assert.equal(all(tree).filter(node => node.props?.['data-kind'] === 'group').map(node => node.props['data-id']).join('|'), before.groups.map(row => row.id).join('|'))
})

test('#1701: with no bound Project the rail shows no Project row and the per-Bot board still opens', () => {
  const roster = unboundRoster()
  const tree = dialog(roster, { scope: { kind: 'bot', botId: 'a' }, own: [task('task-open', 'open')], projectList: [] })
  assert.equal(projectRows(tree).length, 0, 'no Project row without a binding')
  assert.equal(byClass(tree, 'bt-board-rail').length, 1)
  assert.equal(cardsOf(tree).map(node => node.props['data-task']).join('|'), 'task-open', 'the per-Bot board still renders its cards')
  assert.equal(byClass(tree, 'bt-board-column').map(node => node.props['data-column']).join('|'), 'not-started|in-progress|done')

  // A project whose members were all unbound is not offered either, and nothing throws.
  const empty = dialog(unboundRoster(), { scope: { kind: 'bot', botId: 'a' }, projectList: [{ id: 'project-rocket', name: 'Rocket', status: 'active' }] })
  assert.equal(projectRows(empty).length, 0, 'a project with no member is not a rail row')
})

test('#1701: the project board is read-only', () => {
  const moved = []
  const roster = rosterWithProjects()
  const own = [task('task-open', 'open', { ownerBotId: 'a' }), task('task-working', 'working', { ownerBotId: 'a' })]
  const tree = dialog(roster, {
    scope: { kind: 'project', projectId: 'project-rocket' },
    own,
    actions: { taskUpdate: async payload => { moved.push(payload); return payload } },
  })
  const cards = cardsOf(tree)
  assert.equal(cards.length, 2)
  for (const card of cards) {
    assert.ok(card.props['data-column'], 'the column is still drawn')
    assert.notEqual(card.props.draggable, true, 'a project card is not draggable')
    assert.equal(all(card).some(node => node.type === 'button' && ['Start', 'Complete'].includes(textOf(node))), false, 'no move buttons on a project card')
  }
  const columns = byClass(tree, 'bt-board-column')
  assert.equal(columns.length, 3)
  for (const column of columns) {
    assert.equal(typeof column.props.onDrop, 'undefined', 'no drop target on the project board')
    assert.equal(typeof column.props.onDragOver, 'undefined', 'no drag-over on the project board')
  }
})

test('#1701: the project board reads the same task call and filters it itself', () => {
  const calls = []
  const roster = rosterWithProjects()
  const actions = { tasks: (...args) => { calls.push(args); return Promise.resolve([]) }, projects: () => Promise.resolve({ projects }) }
  const { useBoardTasks } = module.exports
  effects.length = 0
  states.length = 0
  useBoardTasks(actions, { kind: 'project', projectId: 'project-rocket' }, roster)
  assert.equal(effects.length, 1, 'the board loads through one effect')
  effects.pop()()
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    assert.equal(calls.filter(args => args[0]?.botId).length, 0, 'a project board never asks Bot by Bot')
    assert.equal(calls.length <= 2, true, 'at most the active read and one archive read')
    assert.equal(Object.keys(calls[0]?.[0] ?? {}).length, 0, 'the active read stays the unfiltered list')
  })
})

// Two behaviour reds, no new export needed: on the base the board has no project scope at all, so a
// project render falls into the default branch and draws every Bot's card, and the rail has no
// Project row. Both fail for what the board does, not because a function is missing.
test('#1701: a Project board renders no card of a Bot or a group from another Project', () => {
  const roster = rosterWithProjects()
  const own = [
    task('task-rocket', 'working', { ownerBotId: 'a' }),
    task('task-garden', 'working', { ownerBotId: 'b' }),
    task('task-room', 'working', { ownerBotId: 'c', origin: { roomId: 'garden' } }),
  ]
  const tree = dialog(roster, { scope: { kind: 'project', projectId: 'project-rocket' }, own })
  const shown = cardsOf(tree).map(node => node.props['data-task'])
  assert.equal(shown.includes('task-garden'), false, `the other Project's Bot card is on this board: ${shown.join('|')}`)
  assert.equal(shown.includes('task-room'), false, `the other Project's group card is on this board: ${shown.join('|')}`)
  assert.equal(shown.join('|'), 'task-rocket')
})

test('#1701: the rail carries the active Project as one project row', () => {
  const roster = rosterWithProjects()
  const tree = dialog(roster, {
    scope: { kind: 'bot', botId: 'a' },
    projectList: [{ id: 'project-rocket', name: 'Rocket', status: 'active' }],
  })
  const rows = projectRows(tree)
  assert.equal(rows.length, 1, `expected one project row, saw ${rows.length}`)
  assert.equal(rows[0]?.props['data-id'], 'project-rocket')
})

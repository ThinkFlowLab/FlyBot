// #2306: the Project board drew its settings write half in a window that holds the team read-only.
// `ProjectBoardOverlay` was registered with the roster injection but never read it, so the settings
// panel drew Bind, Unbind, the assistant Save and the memory Save in a window whose host refuses
// every one of them (`project-bind`, `project-assistant-owner`, `project-memory-write`). The two
// cases here are the pair the issue asks for: a read-only window draws none of the four, and a
// writable one still draws exactly what it drew before.
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
// The same hook runtime `project-board-view.test.js` drives the overlay with: the overlay is a
// plain function, so a slot array that survives a re-render is enough to mount it, let its one read
// land, open the settings panel and read the tree it draws.
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
const doc = { visibilityState: 'visible' }
const clock = { timers: [], id: 0 }
const every = (fn, ms) => { clock.id += 1; clock.timers.push({ id: clock.id, fn, ms }); return clock.id }
const clearEvery = (id) => { clock.timers = clock.timers.filter(timer => timer.id !== id) }
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval: every, clearInterval: clearEvery,
  Date, Promise, console, window: win, document: doc,
  require: (name) => {
    if (name === 'react') return react
    throw new Error(`no platform module ${name}`)
  },
})
const { ProjectBoardOverlay } = module.exports

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  // The fake createElement does not render components; the test asks them for their tree.
  if (typeof node.type === 'function') return all(node.type(node.props), out)
  out.push(node)
  all(node.children, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children ?? []).map(textOf).join('') : '')
const WRITES = ['project-bind', 'project-unbind', 'project-assistant-save', 'project-memory-save']
const writeControls = nodes => nodes
  .filter(node => node.type === 'button' || node.type === 'input' || node.type === 'select' || node.type === 'textarea')
  .filter(node => WRITES.includes(node.props?.['data-action']))
  .map(node => node.props['data-action'])

// One board read, answered the way the host answers it, so the overlay reaches its render with a
// Project in hand instead of the empty state.
const boardCall = async (name) => {
  if (name === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
  if (name === 'project-read') return { project: { id: 'project-1', name: 'FlyBot' }, canManage: true }
  if (name === 'project-board') {
    return {
      tasks: [],
      waiting: [], inflight: [], blocked: [], counts: { waiting: 0, inflight: 0, blocked: 0, done: 0 },
      decisions: { dir: '/team/flybot', reason: '', total: 0, files: [] },
      meetings: { decided: [], pending: [], reason: '' },
    }
  }
  if (name === 'tasks') return []
  if (name === 'project-team') return { rows: [] }
  return {}
}

// A mount the way the shell does it: the first render registers the effects, each runs once, and
// the second render draws the state the read landed on.
const mount = async (props) => {
  slots = []
  effects = []
  index = 0
  ProjectBoardOverlay(props)
  for (const fn of effects) await fn()
  effects = []
  await new Promise(resolve => setTimeout(resolve, 0))
  const redraw = () => { index = 0; return ProjectBoardOverlay(props) }
  return { tree: redraw(), redraw }
}

// The panel is a panel of the board, so opening it is a click on the board's own control, not a
// direct call to the panel: a lock the overlay never hands down would not reach it here either.
const openSettings = async (props) => {
  win.location.hash = '#project'
  const { tree, redraw } = await mount(props)
  const button = all(tree).find(node => node.type === 'button' && node.props?.['data-action'] === 'project-settings')
  assert.ok(button, 'the board draws its Project settings control')
  assert.equal(typeof button.props.onClick, 'function', 'the control is activatable')
  button.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  return all(redraw())
}

test('a read-only window draws no write on the Project board', async () => {
  const roster = { readOnly: 'This window is read-only: the team is shared with you.' }
  const nodes = await openSettings({ actions: {}, call: boardCall, useRoster: select => select(roster) })
  assert.deepEqual(writeControls(nodes), [], 'a read-only window offers no Project board write')
  assert.match(nodes.map(textOf).join(' '), /Project board/, 'the board is still drawn')
})

test('a writable window still draws the same four writes', async () => {
  const nodes = await openSettings({ actions: {}, call: boardCall })
  assert.deepEqual(writeControls(nodes), WRITES, 'a writable window keeps every write it had')
})

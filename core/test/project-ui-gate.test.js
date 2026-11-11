// #2877: the Project domain is a plugin, but its browser surfaces are drawn by the core client,
// so the owner's switch — and a package that is not installed at all — left all five of them on
// screen. `plugins/list` now answers `loaded` beside `enabled` (did this start really attach the
// package?), and one selector, `projectPresent()`, is what every Project surface asks:
//
//   1. the sidebar row (`ProjectsNav`),
//   2. the Settings page (`projects` in the nav, and a page asked for by name),
//   3. the board overlay entry,
//   4. the `#project=<id>` hash route,
//   5. the Bot header's agent seat (`ProjectAgentEntry`).
//
// Off and "on but not attached" must draw none of them; with the plugin present every one draws
// exactly what it drew before this issue.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ProjectsNav } from './src/client/projects-nav.js'",
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { ProjectBoardOverlay, ProjectAgentEntry } from './src/client/project-board.js'",
      "export { projectPresent, registry, setDisabledPlugins, setPluginAnswer, setProjectPresence } from './src/client/flybot-registry.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// The fake createElement keeps children in `props`, the way `h(type, props, ...children)` wrote them.
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// One slot array per top-level draw: these are plain function components, so a re-render is a call
// with `index` reset, and hook state carried over is exactly what React keeps for one instance.
let slots = []
let index = 0
let effects = []
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = index++; if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useLayoutEffect: () => { index++ },
  useId: () => { index++; return 'id' },
  useSyncExternalStore: (_subscribe, get) => { index++; return get() },
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const doc = { hidden: false, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: doc,
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ProjectsNav, SettingsDialog, ProjectBoardOverlay, ProjectAgentEntry, projectPresent, registry, setDisabledPlugins, setPluginAnswer, setProjectPresence } = module.exports

// A first draw of one component: a clean hook state, the way a fresh mount starts.
const draw = (component, props) => { slots = []; effects = []; index = 0; return component(props) }
// The same instance drawing again, the way a state change does.
const redraw = (component, props) => { index = 0; return component(props) }
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  // The fake createElement does not render components; the test asks them for their tree, each
  // with its own hook state so one widget's slots cannot land on another's.
  if (typeof node.type === 'function') {
    const saved = [slots, effects, index]
    slots = []; effects = []; index = 0
    all(node.type(node.props), out)
    ;[slots, effects, index] = saved
    return out
  }
  out.push(node)
  all(node.props?.children, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? (node.props?.children ?? []).map(textOf).join('') : '')
const textIn = tree => all(tree).map(textOf).join(' | ')
const classes = node => (typeof node?.props?.className === 'string' ? node.props.className.split(/\s+/) : [])
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const chief = { id: 'chief', name: 'Chief', role: 'Researcher', model: 'mock/m1', workDir: '/work/chief', instructions: 'Run the team.', projectId: 'project-1', ownerId: 'owner-1' }
const roster = {
  bots: [chief], byId: { chief }, rooms: [], roomsById: {},
  mainBotIds: ['chief'], mainBotId: 'chief',
  prefs: { theme: 'deepseek' }, models: [], connectors: [], capabilities: [], secrets: [], humans: [], remoteBots: [],
  self: { memberId: 'owner-1' },
}
const actions = { openSettings() {}, closeSettings() {}, setPrefs() {}, setSurface() {}, openSession() {}, openBoard() {} }
// One recorded host read is enough to see whether a gated surface still asks; a hidden one asks
// nothing at all.
const hostCalls = []
const call = async (endpoint, payload) => {
  hostCalls.push({ endpoint, payload })
  if (endpoint === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot' }] }
  if (endpoint === 'project-board') return { tasks: [], done: [] }
  return {}
}

// The answer the host gives about the Project plugin: `enabled` is the owner's switch in
// state.json, `loaded` is whether this start really attached the package.
const answerFor = ({ enabled = true, loaded = true } = {}) => [{ id: 'social', enabled: true }, { id: 'project', enabled, loaded }]

const mountOverlay = async () => {
  slots = []
  effects = []
  index = 0
  ProjectBoardOverlay({ actions, call, useRoster: () => roster })
  await flush()
  const tree = redraw(ProjectBoardOverlay, { actions, call, useRoster: () => roster })
  return tree
}
const settingsTree = (page) => draw(SettingsDialog, { page, id: null, roster, actions, useUpdate: () => ({}) })
const settingsNav = (tree) => all(tree).filter(node => classes(node).includes('bt-settings-item'))

test('#2877 the switch off draws none of the five Project surfaces', async () => {
  setPluginAnswer({ plugins: answerFor({ enabled: false, loaded: true }) })
  assert.equal(projectPresent(), false, 'off means absent, whatever the package did')
  // 1. no sidebar row — not even the folder mark that opens it.
  assert.equal(draw(ProjectsNav, { wide: true }), null)
  assert.equal(draw(ProjectsNav, { wide: false }), null)
  // 2. no Projects page, and a page asked for by name lands on General.
  const tree = settingsTree('projects')
  const nav = settingsNav(tree)
  assert.ok(nav.length > 0, 'the Settings nav still draws its other pages')
  assert.equal(nav.some(node => textOf(node) === 'Projects'), false, 'no Projects entry in the nav')
  assert.equal(textOf(nav.find(node => node.props?.['aria-current'] === 'page')), 'General', 'a page asked for by name falls back to General')
  assert.equal(textIn(tree).includes('New Project'), false, 'no empty Projects page either')
  // 3./4. the overlay is not installed and `#project=<id>` is not a route.
  win.location.hash = '#project=project-1'
  hostCalls.length = 0
  assert.equal(await mountOverlay(), null, 'the hash opens no board')
  assert.deepEqual(hostCalls, [], 'a gated overlay reads nothing from the host')
  // 5. no project-agent seat in a Bot header.
  assert.equal(draw(ProjectAgentEntry, { projectId: 'project-1', read: call }), null)
})

test('#2877 a package that never attached draws none of them either', async () => {
  setPluginAnswer({ plugins: answerFor({ enabled: true, loaded: false }) })
  assert.equal(projectPresent(), false, 'on but not installed is not present')
  assert.equal(draw(ProjectsNav, { wide: true }), null)
  const tree = settingsTree('projects')
  assert.equal(settingsNav(tree).some(node => textOf(node) === 'Projects'), false)
  assert.equal(textIn(tree).includes('New Project'), false)
  win.location.hash = '#project=project-1'
  hostCalls.length = 0
  assert.equal(await mountOverlay(), null)
  assert.deepEqual(hostCalls, [])
  assert.equal(draw(ProjectAgentEntry, { projectId: 'project-1', read: call }), null)
})

test('#2877 with the plugin present every surface is what it was', async () => {
  setPluginAnswer({ plugins: answerFor({ enabled: true, loaded: true }) })
  assert.equal(projectPresent(), true)
  // 1. the sidebar row, with its label and the folder that opens it.
  const row = draw(ProjectsNav, { wide: true })
  assert.ok(row !== null)
  assert.deepEqual(classes(row), ['bt-projects'])
  assert.equal(textIn(row).includes('Projects'), true)
  // 2. the Projects page is in the nav and opens when asked for.
  const tree = settingsTree('projects')
  assert.equal(settingsNav(tree).some(node => textOf(node) === 'Projects'), true, 'the Projects entry is back in the nav')
  assert.equal(textIn(tree).includes('New Project'), true, 'the Projects page draws its create form')
  // 3./4. the hash route mounts the board and reads the record.
  win.location.hash = '#project=project-1'
  hostCalls.length = 0
  const board = await mountOverlay()
  assert.ok(board !== null, '`#project=<id>` opens the board')
  assert.equal(hostCalls[0].endpoint, 'projects')
  assert.equal(textIn(board).includes('Project board'), true)
  // 5. the Bot header's agent seat.
  const seat = draw(ProjectAgentEntry, { projectId: 'project-1', read: call })
  assert.ok(seat !== null)
  assert.deepEqual(classes(seat), ['bt-project-agent-entry'])
})

test('#2877 flipping the switch hides the surfaces without a reload', () => {
  setPluginAnswer({ plugins: answerFor({ enabled: true, loaded: true }) })
  assert.ok(draw(ProjectsNav, { wide: true }) !== null)
  // Settings → Plugins answers with `plugins/set`'s own shape, which carries `enabled` only.
  setPluginAnswer({ plugins: [{ id: 'social', enabled: true }, { id: 'project', enabled: false }] })
  assert.equal(projectPresent(), false)
  assert.equal(draw(ProjectsNav, { wide: true }), null, 'the row goes on the answer, not on a reload')
  // …and turning it back on brings the row back: the package is still attached here.
  setPluginAnswer({ plugins: [{ id: 'social', enabled: true }, { id: 'project', enabled: true }] })
  assert.equal(projectPresent(), true)
  assert.ok(draw(ProjectsNav, { wide: true }) !== null)
  // An answer with no Project row at all (an older host) leaves every surface as it was.
  setProjectPresence({ enabled: true, loaded: true })
  assert.equal(projectPresent(), true)
})

test('#2878 a flipped switch does not re-filter the slots mid-session', () => {
  // The slot filter is the start's one read: the entries a switched-off plugin registered were
  // dropped before anything drew them, and a flip only reaches the host at the next start. The
  // `plugins/set` reply carries `enabled` only, so it must move the Project half alone.
  const dispose = registry().register('flybot.sidebar.section', { id: 'social-section', label: 'Social' })
  try {
    setPluginAnswer({ plugins: [{ id: 'social', enabled: false, loaded: false }, { id: 'project', enabled: true, loaded: true }] })
    assert.deepEqual(Array.from(registry().entries('flybot.sidebar.section'), entry => entry.id), [], 'the start read drops the switched-off plugin entry')
    // Settings → Plugins flips social on: the entry must stay hidden until the next start.
    setPluginAnswer({ plugins: [{ id: 'social', enabled: true }, { id: 'project', enabled: true }] })
    assert.deepEqual(Array.from(registry().entries('flybot.sidebar.section'), entry => entry.id), [], 'a flip does not bring the slot back before the restart')

    // The Project half does follow the same reply: the core draws these surfaces itself.
    assert.equal(projectPresent(), true, 'still on and still loaded from the last plugins/list')
    setPluginAnswer({ plugins: [{ id: 'social', enabled: true }, { id: 'project', enabled: false }] })
    assert.equal(projectPresent(), false, 'off is immediate')
    setPluginAnswer({ plugins: [{ id: 'social', enabled: true }, { id: 'project', enabled: true }] })
    assert.equal(projectPresent(), true, 'on again reads the loaded the last plugins/list gave')
  } finally {
    dispose()
    setDisabledPlugins([])
  }
})

// A read-only window still opens a Bot's Settings page from the details drawer. The drawer mounted
// `BotSettingsForm` with the roster that carries the host's own read-only sentence but the form
// never read it, so every write control was drawn and every press could only be refused. When the
// roster holds that sentence the drawer now draws the sentence in place of the form, and a
// writable window keeps today's form unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DetailsDrawer } from './src/client/details-drawer.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render, the same one the Settings dialog is drawn with: the
// read-only sentence has to come out of the drawer's own tree, not from a re-implementation of it.
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
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
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
const { DetailsDrawer } = module.exports

const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const base = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false, exchangeTurns: {}, questions: {} }
const rosterWith = (readOnly) => (readOnly === undefined ? { ...base } : { ...base, readOnly })
const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
}
// The drawer reads its stores through the hooks the shell hands it; these stand in for one render.
const render = (roster, tab = 'settings', acts = actions) => {
  index = 0
  effects = []
  const map = () => new Map()
  return DetailsDrawer({
    sessionId: 'a', startTab: tab, hasStrip: false, roster, actions: acts,
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
// The drawer returns elements; a function component is drawn by React, so the tree is expanded
// here the same way: every function component runs with the hook slots above, in tree order.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const tree = (roster) => all(expand(render(roster)))
const ownText = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const bodyOf = (nodes) => nodes.find(node => node.props?.className === 'bt-drawer-body bt-set-body')
// A write entry is anything in the Bot settings body a person can change something with: a text
// field or a button. The drawer's own Back/Close buttons live in the head, outside this body.
const writes = (nodes) => nodes.filter(node => ['input', 'textarea', 'select', 'button'].includes(node.type))

test('a read-only window draws no Bot-settings write entry and says why in the host\'s words', () => {
  const nodes = tree(rosterWith(SENTENCE))
  const body = bodyOf(nodes)
  assert.ok(body, 'the drawer draws its settings body')
  const inside = all(body)
  assert.equal(writes(inside).length, 0, 'no write entry is drawn in a read-only window')
  const note = inside.filter(node => node.props?.role === 'status' && ownText(node).trim() === SENTENCE)
  assert.equal(note.length, 1, "the host's sentence is drawn once")
  assert.equal(note[0].props?.role, 'status', 'the sentence is a status line')
  assert.ok(String(note[0].props?.className ?? '').includes('bt-read-only'), 'the sentence is the read-only hint')
})

test('a writable window still draws the Bot settings form', () => {
  for (const roster of [rosterWith(undefined), rosterWith(''), rosterWith('   ')]) {
    const nodes = tree(roster)
    const body = bodyOf(nodes)
    assert.ok(body, 'the drawer draws its settings body')
    const inside = all(body)
    assert.ok(writes(inside).length > 0, 'a writable window keeps its write entries')
    assert.equal(inside.some(node => typeof node === 'object' && ownText(node).trim() === SENTENCE), false, 'no read-only sentence is drawn')
  }
  // The writable form is the same component, mounted with the same roster: the counts are not zero
  // on both sides, which is what makes the read-only zero above mean something.
  const inside = all(bodyOf(tree(rosterWith(undefined))))
  assert.ok(inside.some(node => node.type === 'input'), 'the writable form draws a text field')
})

// P-457/#2232 has a second entry point: the details overview mounts `ScheduleSummary`, and that
// line decides on `roster.readOnly` whether its "No scheduled tasks yet. Add one" is drawn — the
// entry opens the create form a locked settings page cannot draw. `schedules-client.test.js` calls
// `ScheduleSummary` directly and hands it a roster, so a drawer that forgets to pass one keeps that
// suite green; this goes in through the overview's own tree instead.
const readView = { available: true, tasks: [] }
const overviewActions = { ...actions, schedules: () => Promise.resolve(readView) }
// The overview reads its tasks in an effect (one read, then a poll), so it is drawn twice: once to
// queue that read, then again once the view has been published into the hook slots.
const overview = async (roster) => {
  // Fresh slots: the two tests above drew the settings page, and these hook slots are positional.
  slots = []
  expand(render(roster, 'details', overviewActions))
  const stops = []
  for (const effect of effects) {
    try {
      const stop = effect()
      if (typeof stop === 'function') stops.push(stop)
    } catch { /* other cards' own first reads are not this test's subject */ }
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  const drawn = all(expand(render(roster, 'details', overviewActions)))
  // The line polls every 30 s; leaving that timer behind holds the whole file open.
  for (const stop of stops) stop()
  return drawn
}
const addOneEntries = (nodes) => nodes.filter(node => node.type === 'button' && ownText(node).includes('Add one'))

test('a read-only details overview draws no Add one for scheduled tasks', async () => {
  const locked = await overview(rosterWith(SENTENCE))
  assert.deepEqual(addOneEntries(locked).map(ownText), [], 'no create entry is drawn in a read-only window')
  // The same overview in a writable window still offers it, so the empty list above is the lock and
  // not a task view that never reached the line.
  const writable = await overview(rosterWith(undefined))
  assert.deepEqual(addOneEntries(writable).map(ownText), ['No scheduled tasks yet. Add one'], 'a writable window keeps the Add one entry')
})

// A window that holds the team read-only can still open Settings, and every page there offers
// its normal write controls. The one place that says why nothing happens — the host's own
// sentence in `roster.readOnly` — is printed by the sidebar and the Workflows page, never by the
// Settings header, so the dialog looks writable until a control is pressed and refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { SettingsDialog } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render, so one refused write can answer and the dialog can
// be drawn again with the refusal it stored next to the standing read-only sentence.
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
const { SettingsDialog } = module.exports

const render = (props) => { index = 0; return SettingsDialog(props) }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  await new Promise(resolve => setTimeout(resolve, 0))
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const ownText = (node) => {
  const kids = node?.props?.children
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(kids)
}
const scrollingBox = (nodes) => nodes.find(node => typeof node.props?.className === 'string' && node.props.className.includes('bt-settings-scroll'))
// Everything the dialog draws above the page's scrolling box: the dialog navigation and the
// Settings header. A read-only sentence has to live here, or it scrolls away like #2194's copy.
const fixedTop = (nodes) => {
  const at = nodes.indexOf(scrollingBox(nodes))
  return at < 0 ? nodes : nodes.slice(0, at)
}
const shape = (nodes) => nodes.map(node => ({
  type: typeof node.type === 'string' ? node.type : node.type?.name ?? 'fn',
  className: node.props?.className ?? null,
  role: node.props?.role ?? null,
  text: ownText(node),
}))

const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const rosterBase = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false }
const rosterWith = (readOnly) => (readOnly === undefined ? { ...rosterBase } : { ...rosterBase, readOnly })
const actions = { openSettings() {}, closeSettings() {}, setFlags: () => Promise.resolve() }
const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const PAGES = [
  { page: 'general' },
  { page: 'bots' },
  { page: 'bots', id: 'a' },
  { page: 'groups' },
  { page: 'connectors' },
  { page: 'schedules' },
  { page: 'projects' },
]

test('a read-only window says so in the Settings header, in the host\'s own words (#2199)', () => {
  for (const where of PAGES) {
    const tree = render({ ...where, roster: rosterWith(SENTENCE), actions, useUpdate: () => ({}) })
    const nodes = all(tree)
    const line = nodes.filter(node => typeof node === 'object' && ownText(node).trim() === SENTENCE)
    assert.equal(line.length, 1, `${where.page}: the host's sentence is drawn once`)
    assert.equal(ownText(line[0]).trim(), SENTENCE, `${where.page}: the sentence is verbatim, not rewritten`)
    assert.equal(line[0].props?.role, 'status', `${where.page}: it is a status line`)
    const scroll = scrollingBox(nodes)
    assert.ok(scroll, `${where.page}: the page has its scrolling box`)
    assert.equal(nodes.indexOf(line[0]) < nodes.indexOf(scroll), true, `${where.page}: the sentence sits above the scrolling page, so scrolling cannot hide it`)
    assert.equal(all(scroll).includes(line[0]), false, `${where.page}: the sentence is not inside the scrolling page`)
  }
})

test('a writable window, a blank sentence and a missing one draw no read-only line at all (#2199)', () => {
  for (const where of PAGES) {
    const baseline = shape(fixedTop(all(render({ ...where, roster: rosterWith(undefined), actions, useUpdate: () => ({}) }))))
    const missing = shape(fixedTop(all(render({ ...where, roster: rosterBase, actions, useUpdate: () => ({}) }))))
    assert.deepEqual(missing, baseline, `${where.page}: a roster without the field is the reference shape`)
    for (const blank of ['', '   ', '\n\t ']) {
      const tree = render({ ...where, roster: rosterWith(blank), actions, useUpdate: () => ({}) })
      const nodes = all(tree)
      assert.deepEqual(shape(fixedTop(nodes)), baseline, `${where.page}: readOnly ${JSON.stringify(blank)} draws nothing above the page`)
      const scroll = scrollingBox(nodes)
      assert.equal(all(scroll).some(node => typeof node.props?.className === 'string' && node.props.className.includes('bt-read-only')), false, `${where.page}: readOnly ${JSON.stringify(blank)} draws no read-only node in the page either`)
    }
  }
})

test('the standing read-only line stays above the refusal one pressed control adds (#2199)', async () => {
  // A pressed control on the Bot page answers through the dialog's own `run`, which stores the
  // host's sentence and re-renders. Both lines are then in one tree, and their order is what a
  // reader sees: the standing state first, the answer to the press nearest the press.
  const roster = rosterWith(SENTENCE)
  const props = { page: 'bots', id: 'a', roster, actions, useUpdate: () => ({}) }
  let tree = render(props)
  const form = all(tree).find(node => node?.props?.roster === roster && node?.props?.bot === bot && typeof node.props.run === 'function')
  assert.ok(form, 'the page is the Bot form, which reports through the dialog')
  const REFUSAL = 'This window shows the team but cannot change it.'
  await form.props.run(Promise.reject(new Error(REFUSAL)))
  await flush()
  tree = render(props)
  const nodes = all(tree)
  const status = nodes.find(node => ownText(node).trim() === SENTENCE)
  const alert = nodes.find(node => node.props?.role === 'alert' && ownText(node).trim() === REFUSAL)
  assert.ok(status, 'the read-only sentence is still on screen after the refused write')
  assert.equal(status.props?.role, 'status', 'it is still the standing status line')
  assert.ok(alert, 'the refusal is on screen too')
  assert.equal(nodes.indexOf(status) < nodes.indexOf(alert), true, 'the standing sentence sits above the refusal a single press produced')
  const scroll = scrollingBox(nodes)
  assert.ok(scroll, 'the page is the scrolling box under the two lines')
  assert.equal(nodes.indexOf(alert) < nodes.indexOf(scroll), true, 'the refusal stays above the scrolling page')
  assert.equal(all(scroll).includes(status), false, 'the standing sentence is not inside the scrolling page')
})

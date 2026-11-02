// A refused write in Settings: the sentence the host sends back is the only thing that
// tells a person why the switch did not move, and it was drawn as the first child of the page's
// scrolling area. After scrolling to the card that was pressed the refusal lands above the
// viewport, so the window looks like it ignored the click. It belongs outside that scroll box.
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
// A hook runtime that survives a re-render, so a pressed control can answer and the dialog can
// be drawn again with the refusal it stored.
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

const render = (component, props) => { index = 0; return component(props) }
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
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}
const inside = (target, root) => all(root).some(node => node === target)

const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const roster = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false }
const REFUSAL = 'This window shows the team but cannot change it.'
const actions = { openSettings() {}, closeSettings() {}, setFlags: () => Promise.reject(new Error(REFUSAL)) }

test('a refused write in Settings stays in view instead of scrolling away with the page (#2194)', async () => {
  const props = { page: 'bots', id: 'a', roster, actions, useUpdate: () => ({}) }
  let tree = render(SettingsDialog, props)
  // The form the dialog draws for this Bot is what hands a failed write back through the dialog's
  // own `run`, so a rejection here is the same path a pressed switch takes.
  const form = all(tree).find(node => node?.props?.roster === roster && node?.props?.bot === bot && typeof node.props.run === 'function')
  assert.ok(form, 'the page is the Bot form, which reports through the dialog')
  form.props.run(Promise.reject(new Error(REFUSAL)))
  await flush()
  tree = render(SettingsDialog, props)
  const nodes = all(tree)
  const alert = nodes.find(node => node.props?.role === 'alert')
  assert.ok(alert, 'the refusal is on screen')
  assert.equal(text(alert), REFUSAL)
  const scrolling = nodes.find(node => typeof node.props?.className === 'string' && node.props.className.includes('bt-settings-scroll'))
  assert.ok(scrolling, 'the page is the scrolling box under the dialog heading')
  assert.equal(inside(alert, scrolling), false, 'the refusal must sit outside the scrolling page, not above it')
})

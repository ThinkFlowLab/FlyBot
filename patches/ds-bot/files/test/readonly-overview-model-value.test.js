// #2901: a read-only window draws the Bot overview's Model card as a value instead of a menu
// (P-547), and that one value has three states (`details-drawer.js:70-74`): the catalog has not
// loaded yet, so the provider stands alone; the catalog carries the Bot's ref, so the served name
// is drawn; the catalog has loaded and does not carry the ref, so the value says "not available" —
// the one sentence that tells a reader in a locked window why the model may not answer.
//
// The neighbouring drawer test feeds a catalog that already contains the Bot's ref
// (`details-overview-readonly.test.js:212-216`), so only the middle state was ever drawn here, and
// `bt-model-provider` appears in no other test. This file pins all three from the drawer's own tree,
// so dropping either half of the expression — the "catalog is still loading" guard or the
// "catalog cannot serve this ref" sentence — cannot stay green.
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
    if (name === 'react') return { ...react, default: react }
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { DetailsDrawer } = module.exports

const SENTENCE = 'The Bot team is open in another dsh. Close the other one and reload.'
const REF = 'deepseek/deepseek-v4.1-flash'
const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: REF, instructions: '', workDir: '' }
const permissions = { defaultPreset: 'workspace-write', options: [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace' }] }
const base = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false, exchangeTurns: {}, questions: {}, permissions }
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
  updateBot: () => Promise.resolve(), updateRoom: () => Promise.resolve(),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
}
const render = (models) => {
  index = 0
  effects = []
  const map = () => new Map()
  return DetailsDrawer({
    sessionId: 'a', startTab: 'details', hasStrip: false, actions,
    roster: { ...base, models, readOnly: SENTENCE },
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const flatten = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  flatten(node.props?.children, out)
  return out
}
const within = (node) => flatten(node).slice(1)
const ownText = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
// The Model card is the first read-only value line; the Permissions and Working folder cards follow
// it, and only the Model card carries a provider note, so each helper reads inside that one node.
const modelValue = (models) => flatten(expand(render(models))).find(node => hasClass(node, 'bt-readonly-value'))
const partOf = (node, name) => {
  const found = within(node).find(child => hasClass(child, name))
  return found === undefined ? null : ownText(found).trim()
}
const providerLines = (models) => [partOf(modelValue(models), 'bt-model-provider')]
const modelNames = (models) => [partOf(modelValue(models), 'bt-model-name')]

test('#2901: a read-only overview tells an unloaded catalog from one that cannot serve the model', () => {
  // Before the catalog arrives (`models` empty) the value names the ref's own provider: "not
  // known yet" is not "not available", and a locked window cannot go and load the list itself.
  assert.deepEqual(providerLines([]), ['deepseek'], 'an unloaded catalog must not call the model unavailable')
  assert.deepEqual(modelNames([]), ['deepseek-v4.1-flash'], 'the value still names the model the Bot would run on')

  // The catalog arrives and carries the ref: the served name, with no warning beside it.
  const served = [{ ref: REF, name: 'DeepSeek V4.1 Flash', providerName: 'DeepSeek' }]
  assert.deepEqual(providerLines(served), ['DeepSeek'], 'a served model is named by its own provider, not as unavailable')
  assert.deepEqual(modelNames(served), ['DeepSeek V4.1 Flash'], 'the served name replaces the ref tail')

  // The catalog arrives and does not carry the ref: the one sentence that says so.
  const elsewhere = [{ ref: 'openai/gpt-x', name: 'GPT X', providerName: 'OpenAI' }]
  assert.deepEqual(providerLines(elsewhere), ['deepseek · not available'], 'a model the catalog cannot serve is named as unavailable')
  assert.deepEqual(modelNames(elsewhere), ['deepseek-v4.1-flash'], 'and its own name is still drawn, not dropped')
})

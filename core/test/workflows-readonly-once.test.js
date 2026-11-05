// The standing read-only sentence belongs to the dialog header, once per page
// (settings-readonly-pages.test.js). That page list never opened a workflow, so it could not
// see the second copy: in a window that holds the team read-only, Settings → Workflows drew
// the host's sentence in the header and again in the graph's edit bar, a second live region
// read out twice. The edit bar now draws Back only — the header's Reload is the whole
// screen's way out — and a writable window keeps Edit where it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { WorkflowsView } from './src/client/workflows.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })

// One render pass: the dialog and the graph canvas both call hooks, and nothing here
// re-renders, so each component is drawn with a fresh set of slots.
let slots = []
let index = 0
const hook = () => { const at = index++; return at }
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = hook(); if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = hook()
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = hook(); if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = hook(); if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = hook(); if (!(at in slots)) slots[at] = fn },
  useLayoutEffect: () => { hook() },
  useId: () => { hook(); return 'id' },
  useSyncExternalStore: (_subscribe, get) => { hook(); return get() },
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
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
const { SettingsDialog, WorkflowsView } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'

const chief = { id: 'chief', name: 'Chief', role: 'Researcher', model: 'mock/m1', workDir: '/work/chief', instructions: 'Run the team.', pinned: true }
const baseRoster = {
  bots: [chief], byId: { chief }, rooms: [], roomsById: {}, mainBotIds: ['chief'], mainBotId: 'chief',
  prefs: { theme: 'deepseek', motion: 'quiet', notifications: true },
  models: [], connectors: [], capabilities: [], secrets: [], humans: [], remoteBots: [], memory: true,
  questions: {}, exchangeTurns: {},
}
const lockedRoster = { ...baseRoster, readOnly: SENTENCE }

const lane = {
  id: 'w1',
  name: 'Hotfix lane',
  description: 'A short lane.',
  chain: 'Planner → Coder',
  nodes: [
    { id: 'planner', name: 'Planner', role: 'Planner', x: 0, y: 0 },
    { id: 'coder', name: 'Coder', role: 'Coder', x: 0, y: 108 },
  ],
  edges: [{ from: 'planner', to: 'coder' }],
  layers: [['planner'], ['coder']],
}
const pack = { ok: true, templates: [], workflows: [lane] }

// Every action a locked page could reach; a press that lands in one is a write.
const actions = () => new Proxy({ openSettings() {}, closeSettings() {}, openSession() {}, notify() {}, showDetails() {} }, {
  get: (target, name) => (name in target ? target[name] : () => {}),
})

const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}

// Draw the tree the way the screen would: a function component is called, a host element is
// kept. One pass is enough — the test asks what the first screen carries.
const draw = (node, out = [], depth = 0) => {
  if (Array.isArray(node)) { for (const item of node) draw(item, out, depth); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 10) {
    const saved = slots
    const savedIndex = index
    slots = []
    index = 0
    let rendered
    try { rendered = node.type({ ...node.props }) } catch { out.push(node); return out } finally { slots = saved; index = savedIndex }
    return draw(rendered, out, depth + 1)
  }
  out.push(node)
  draw(node.props?.children, out, depth)
  return out
}

// The sentence as a reader meets it: one text block per drawn copy, whatever element and
// class carry it. A wrapper and the node inside it are one copy, not two.
const sentences = (tree) => draw(tree).filter(node => text(node) === SENTENCE
  && !draw(node.props?.children).some(child => text(child) === SENTENCE))

const view = (over = {}) => h(WorkflowsView, { phase: 'ready', pack, opened: { source: 'own', id: 'w1' }, error: '', roster: lockedRoster, ...over })
const dialog = (roster) => SettingsDialog({ page: 'workflows', id: null, roster, actions: actions(), useUpdate: () => ({}) })
const buttons = (tree) => draw(tree).filter(node => node.type === 'button')

test('a read-only window draws the host sentence once, not twice, with a workflow graph open', () => {
  const header = sentences(dialog(lockedRoster))
  assert.equal(header.length, 1, 'the dialog header keeps the standing sentence')
  assert.equal(header[0].props.role, 'status', 'the header sentence stays the live region')
  assert.equal(text(header[0]), SENTENCE, "the header keeps the host's own wording")

  const graph = sentences(view())
  assert.equal(graph.length, 0, 'the open graph does not repeat the sentence the header already carries')
  assert.equal(header.length + graph.length, 1, 'the screen carries the host sentence once')
  assert.equal(draw(view()).some(node => node.props?.role === 'status' && text(node) === SENTENCE), false,
    'the edit bar adds no second live region')
})

test('the read-only graph keeps Back and adds no second Reload, Edit or Use this', () => {
  const labels = buttons(view()).map(text)
  assert.deepEqual(labels, ['Back'], 'Back is the only control the edit bar draws')
  assert.equal(labels.includes('Reload'), false, "the header's Reload is the screen's one Reload")
  assert.equal(labels.includes('Edit') || labels.includes('Finish editing'), false, 'the graph offers no editing control')
  assert.equal(labels.includes('Use this'), false, 'the graph offers no copy of a preset')
})

test('a writable window keeps the graph editor and draws no read-only sentence', () => {
  assert.equal(sentences(dialog(baseRoster)).length, 0, 'a writable header draws no sentence')
  const tree = view({ roster: baseRoster })
  assert.equal(sentences(tree).length, 0, 'a writable graph draws no sentence')
  const labels = buttons(tree).map(text)
  assert.ok(labels.includes('Edit'), 'Edit stays in a writable window')
  assert.equal(labels.includes('Reload'), false, 'a writable window draws no Reload')
  assert.ok(draw(tree).some(node => node.props?.['data-node'] === 'coder'), 'the opened graph still renders')
})

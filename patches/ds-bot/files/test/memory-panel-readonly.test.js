// A window that holds the team read-only can open a Bot's memory dialog, and the panel draws
// two writes — a Remove on every entry and the "Ask or update" form — that the host refuses in
// that window, while nothing inside the panel says why (P-475). The message is the host's own
// sentence, already drawn by the sidebar and the Settings header; this panel is the surface
// that was missing it. A writable window must keep both writes exactly as they are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { MemoryDialog } from './src/client/memory-panel.js'\nexport { hostText } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render: the memory view arrives from an async effect, so the
// dialog is drawn once as its skeleton and again with the view, and the test clicks the ⋯ menu
// between those draws. Intervals are stubbed out (the clock never matters here) so the suite does
// not wait on the panel's 30-second "updated ago" beat.
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
  module, exports: module.exports, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
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
const { MemoryDialog, hostText } = module.exports

// The dialog's own tree holds component elements (an entry row is a function, not a node), so the
// draw pass renders every function component the way the renderer would, with one hook index
// continuing through the tree.
const draw = (node) => {
  if (Array.isArray(node)) return node.map(draw)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return draw(node.type(node.props))
  if (node.props?.children === undefined) return node
  return { ...node, props: { ...node.props, children: draw(node.props.children) } }
}
const render = (props) => { index = 0; return draw(MemoryDialog(props)) }
const reset = () => { slots = []; effects = []; index = 0 }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  // Two microtask turns: the loader's promise resolves, then its continuation draws the view.
  await Promise.resolve()
  await Promise.resolve()
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const textOf = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const byClass = (node, name) => all(node).filter(item => typeof item.props?.className === 'string' && item.props.className.split(' ').includes(name))

const view = () => ({
  entries: [
    { text: 'A saved fact', scope: 'own', source: 'memory panel', added: 'today' },
    { text: 'A second fact', scope: 'own', source: 'memory panel', added: 'today' },
  ],
  sizes: { own: 14, team: 0 },
  limits: { main: 4000 },
  blocked: [],
  summary: { at: Date.now() - 60_000, text: 'One saved fact' },
  fresh: true,
  summarizing: false,
})
const actions = () => ({
  memoryView: async () => view(),
  memoryForget: async () => { throw new Error('the host should have refused this write') },
  memoryAsk: async () => { throw new Error('the host should have refused this write') },
  closeMemory() {},
})

// The dialog opens on the summary; the Remove buttons live on the entries page, so every case
// walks the same path a reader does: wait for the view, open ⋯, choose All entries. Removing the
// view wait is what would fake the locked result — the skeleton draws no write either.
async function drawEntries(roster) {
  reset()
  const props = { bot: { id: 'bot1', name: 'Scout' }, actions: actions(), roster }
  let tree = render(props)
  await flush()
  tree = render(props)
  // The view resolved: the summary text is drawn and the loading skeleton is gone. Without this,
  // the skeleton's 0 writes would make the locked case pass for the wrong reason.
  assert.match(textOf(tree), /One saved fact/, 'the view resolved')
  assert.equal(byClass(tree, 'bt-mem-skel-block').length, 0)
  const menu = all(tree).find(node => node.props?.['aria-label'] === 'Memory options')
  assert.ok(menu, 'the ⋯ menu is there')
  menu.props.onClick()
  tree = render(props)
  const entriesItem = all(tree).find(node => node.props?.role === 'menuitem' && textOf(node).includes('All entries'))
  assert.ok(entriesItem, 'the menu offers All entries')
  const regenerateItem = all(tree).find(node => node.props?.role === 'menuitem' && textOf(node).includes('Regenerate summary'))
  entriesItem.props.onClick()
  tree = render(props)
  await flush()
  return { tree, regenerateItem }
}

test('P-475: a writable memory panel keeps both writes and draws no read-only line', async () => {
  const { tree } = await drawEntries({})
  // Two entries in the fixture, so two Remove buttons: the count is real, not "one at least".
  assert.equal(byClass(tree, 'bt-mem-remove').length, 2)
  assert.equal(byClass(tree, 'bt-mem-ask').length, 1)
  assert.equal(byClass(tree, 'bt-read-only').length, 0)
  assert.match(textOf(tree), /A saved fact/)
  assert.match(textOf(tree), /A second fact/)
})

test('P-475: a read-only memory panel draws no write and says in place why', async () => {
  const sentence = 'This window is read-only.'
  const { tree, regenerateItem } = await drawEntries({ readOnly: sentence })
  // One read of the whole shape: two writes and no sentence (the defect), or no write and one
  // sentence (the fix). A skeleton would read 0/0/0 and prove nothing, which is why the entry
  // path above waits for the view instead of mounting.
  assert.deepEqual([byClass(tree, 'bt-mem-remove').length, byClass(tree, 'bt-mem-ask').length, byClass(tree, 'bt-read-only').length], [0, 0, 1])
  const hints = byClass(tree, 'bt-read-only')
  assert.equal(hints.length, 1)
  assert.equal(hints[0].props.role, 'status')
  assert.equal(textOf(hints[0]), hostText(sentence))
  // The panel is still readable, and the summary actions that read rather than write stay.
  assert.match(textOf(tree), /A saved fact/)
  assert.match(textOf(tree), /A second fact/)
  // Regenerate reads the view and writes no entry, so the lock must not take it away.
  assert.ok(regenerateItem, 'Regenerate summary is still offered')
  assert.equal(regenerateItem.props.disabled, false)
})

test('P-475: the dialog is handed the roster, or the panel cannot know the window', () => {
  const overlays = readFileSync(new URL('../src/client/overlays.js', import.meta.url), 'utf8')
  assert.match(overlays, /h\(MemoryDialog, \{ key: memory, bot: roster\.byId\[memory\], roster, actions, leaving: memoryLeaving \}\)/)
})

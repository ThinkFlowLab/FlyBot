// The memory row in a Bot's details pane counts the entries it reads through `memory-view`. When
// that read is refused the row kept saying "Loading…" for as long as the window stayed open: the
// hook dropped the rejection and the row had no second state (#2395). The row now says what went
// wrong, while an empty memory still reads as empty and a count that arrived is still a count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { MemoryRow } from './src/client/memory-panel.js'\nexport { hostText } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render: the count arrives from an async effect, so the row is
// drawn once as "Loading…" and again with the view. Intervals and animation frames are stubbed
// out, because this row polls nothing and the clock never matters here.
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
const { MemoryRow, hostText } = module.exports

// The row's own tree holds component elements around the hook, so a draw pass renders every
// function component the way the renderer would, with one hook index continuing through the tree.
const draw = (node) => {
  if (Array.isArray(node)) return node.map(draw)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return draw(node.type(node.props))
  if (node.props?.children === undefined) return node
  return { ...node, props: { ...node.props, children: draw(node.props.children) } }
}
const render = (props) => { index = 0; return draw(MemoryRow(props)) }
const reset = () => { slots = []; effects = []; index = 0 }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  // The read resolves (or rejects) through `.then`/`.catch`, then the row draws its second state.
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
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
const byClass = (node, name) => all(node).find(item => typeof item.props?.className === 'string' && item.props.className.split(' ').includes(name))

// One bot per case: the module keeps a count per Bot id, so sharing an id would let one case's
// answer leak into the next one.
async function rowOf(botId, memoryView) {
  reset()
  const props = { bot: { id: botId, name: 'Scout' }, actions: { memoryView, openMemory() {} } }
  render(props)
  await flush()
  const tree = render(props)
  const copy = byClass(tree, 'bt-mem-row-copy')
  assert.ok(copy, 'the row draws its count line')
  return { tree, label: textOf(copy) }
}

test('#2395: a refused memory read says why instead of "Loading…"', async () => {
  const failure = 'The host did not answer.'
  const { label } = await rowOf('bot-refused', async () => { throw new Error(failure) })
  assert.equal(label, `The memory could not be read: ${hostText(failure)}`)
  assert.doesNotMatch(label, /Loading/, 'the row does not wait forever on a read that already failed')
})

test('#2395: the row keeps the reason the host gave', async () => {
  const { label } = await rowOf('bot-reason', async () => { throw new Error('Unknown Bot') })
  assert.match(label, /Unknown Bot$/, 'the host sentence is drawn, not replaced by a generic one')
})

test('#2395: an empty memory reads as empty, not as a failure', async () => {
  const { tree, label } = await rowOf('bot-empty', async () => ({ entries: [] }))
  assert.equal(label, 'Nothing saved yet')
  assert.doesNotMatch(textOf(tree), /could not be read/, 'zero entries is a read that worked')
})

test('#2395: a count that arrived is still a count', async () => {
  const { tree, label } = await rowOf('bot-counted', async () => ({ entries: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }))
  assert.equal(label, '3 entries')
  assert.doesNotMatch(textOf(tree), /could not be read/)
})

test('#2395: a client without memoryView asks nothing and throws nothing', async () => {
  reset()
  const props = { bot: { id: 'bot-no-action', name: 'Scout' }, actions: { openMemory() {} } }
  // The effect used to reach `.then` on whatever the optional call returned; a client with no
  // action must render quietly instead of throwing the effect out.
  render(props)
  await flush()
  const tree = render(props)
  const copy = byClass(tree, 'bt-mem-row-copy')
  assert.ok(copy, 'the row still draws')
  assert.equal(textOf(copy), 'Loading…', 'no read was started, so there is nothing to report')
})

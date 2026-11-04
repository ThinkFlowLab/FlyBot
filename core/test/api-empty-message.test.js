// A host refusal whose `message` is an empty string was thrown as `new Error('')`: `??` keeps an
// empty string, and `hostText('')` returns it unchanged. Every consumer that prints
// `error.message` then draws nothing, and the memory row states its count through
// `if (failure)`, so an empty failure is falsy and the row settles on "Loading…" for a read that
// already failed (#2411). A refusal with no sentence of its own must still read as a refusal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { call } from './src/client/api.js'",
      "export { MemoryRow } from './src/client/memory-panel.js'",
      "export { hostText } from './src/client/i18n.js'",
      "export { clientErrors, clearClientErrors } from './src/client/diagnostics.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// The row counts through an async effect, so it is drawn once as "Loading…" and again with the
// view. The hook runtime keeps its slots across a re-render, like the renderer's own.
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
// One fetch stub per call: the api wrapper posts every request through the browser's own fetch.
let answer = null
const fetchStub = async () => answer
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: fetchStub,
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { call, MemoryRow, hostText, clientErrors, clearClientErrors } = module.exports

// The row's tree holds component elements around the hook, so a draw pass renders every function
// component the way the renderer would, with one hook index continuing through the tree.
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

// The host's own reply shape: an HTTP 200 whose body is `{ ok: false, error: { code, message, details } }`.
const refusal = (code, message, details) => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code, message, details } }) })

async function rejection(promise) {
  try { await promise } catch (error) { return error }
  throw new Error('the call resolved, but the host refused it')
}

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

test('#2411: a refusal with an empty message is thrown as a readable error', async () => {
  answer = refusal('bot/refused', '')
  const error = await rejection(call('memory/view', { botId: 'bot-a' }))
  assert.equal(typeof error.message, 'string')
  assert.notEqual(error.message, '', 'an empty host message must not become an empty error')
  assert.equal(error.message, 'Request failed', 'the refusal keeps a sentence of its own')
  assert.equal(error.code, 'bot/refused', 'the code still passes through')
})

test('#2411: the memory row says the read failed instead of "Loading…"', async () => {
  answer = refusal('bot/refused', '')
  const { label } = await rowOf('bot-empty-refusal', () => call('memory/view', { botId: 'bot-empty-refusal' }))
  assert.doesNotMatch(label, /Loading/, 'a settled failure never draws the pending text')
  assert.equal(label, `The memory could not be read: ${hostText('Request failed')}`)
})

test('#2411: the fallback also covers a code that is not a refusal', async () => {
  clearClientErrors()
  answer = refusal('bot/error', '', { ticket: 'x-1' })
  const error = await rejection(call('memory/view', {}))
  assert.equal(error.message, 'Request failed', 'the noted copy is not empty either')
  assert.deepEqual(error.details, { ticket: 'x-1' }, 'details still pass through')
  const noted = clientErrors()
  assert.ok(noted.length > 0, 'a non-refusal is still noted for the diagnostics')
  const last = noted.at(-1)
  assert.match(last.text, /Request failed$/, 'the diagnostics line names the failure, not an empty string')
  assert.notEqual(last.text, 'memory/view: ', 'no dangling separator for an empty sentence')
})

test('#2411: an internal failure no longer leaves a leading space', async () => {
  answer = refusal('bot/internal', '')
  const error = await rejection(call('memory/view', {}))
  assert.doesNotMatch(error.message, /^ /, 'the sentence starts with a word, not a space')
  assert.match(error.message, /^Request failed /, 'the fallback sentence leads the note')
})

test('#2411: a non-empty host message is drawn byte-for-byte', async () => {
  answer = refusal('bot/refused', 'Unknown Bot')
  const error = await rejection(call('memory/view', {}))
  assert.equal(error.message, 'Unknown Bot', 'the fix does not rewrite a sentence the host sent')
  const { label } = await rowOf('bot-host-sentence', () => call('memory/view', {}))
  assert.equal(label, 'The memory could not be read: Unknown Bot')
})

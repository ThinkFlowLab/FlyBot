import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #2027: since #2022 a connector row in the `error` state can carry up to 2,000 characters of the
// host's own failure text, and the row offered only `Try again`/`Disconnect`, so handing that
// sentence to someone meant selecting it by hand. `Copy error` puts the exact stored text on the
// clipboard through copiedToClipboard(), which answers true/false and never reports a quiet
// success (#1347); a refused copy says so on the button instead.
const { outputFiles } = await build({
  stdin: {
    contents: "export { ConnectorsPage } from './src/client/connectors.js'; export { DICTIONARY } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children } })
// One component instance's hook slots, reused by every redraw; a setter redraws it at once, the
// way React would after a click, so a button's new label is visible to the test.
const slots = []
let cursor = 0
let rerender = null
const react = {
  createElement: h,
  Fragment: Symbol('F'),
  useEffect() { cursor += 1 },
  useLayoutEffect() { cursor += 1 },
  useState(initial) {
    const slot = cursor++
    if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
    return [slots[slot], next => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; rerender?.() }]
  },
  useMemo(factory) { cursor += 1; return factory() },
  useCallback(fn) { cursor += 1; return fn },
  useRef(current) { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current }; return slots[slot] },
  useSyncExternalStore(_subscribe, get) { cursor += 1; return get() },
}

const writes = []
const workingClipboard = { writeText: async text => { writes.push(text) } }
const sandbox = {
  module: { exports: {} },
  exports: {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en', clipboard: workingClipboard },
  localStorage: { getItem: () => null, setItem() {} },
  window: { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) },
  setTimeout,
  clearTimeout,
  requestAnimationFrame: run => { run(); return 0 },
  cancelAnimationFrame() {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
}
sandbox.module.exports = sandbox.exports
runInNewContext(outputFiles[0].text, sandbox)
const { ConnectorsPage, DICTIONARY } = sandbox.module.exports

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const buttonsOf = node => all(node).filter(element => element.type === 'button')
const texts = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (node && typeof node === 'object') texts(node.props?.children, out)
  return out
}
const labelOf = button => texts(button.props?.children).join('')

const roster = { bots: [], connectors: [], self: { memberId: 'me' } }
const actions = { connectorRetry: () => Promise.resolve(), connectorDisconnect: () => Promise.resolve() }

// The row under test, drawn from the page so a row that is not exported is still reachable.
const mount = connector => {
  slots.length = 0
  let node = null
  const page = ConnectorsPage({ roster: { ...roster, connectors: [connector] }, actions })
  const row = all(page).find(element => typeof element.type === 'function')
  const draw = () => { cursor = 0; node = row.type(row.props) }
  rerender = draw
  draw()
  return { node: () => node }
}
const labels = node => buttonsOf(node).map(labelOf)
const buttonNamed = (node, label) => buttonsOf(node).find(button => labelOf(button) === label)
// copiedToClipboard answers on a promise; let it land before reading the row again.
const settle = () => new Promise(resolve => setImmediate(resolve))

const stored = `The gateway refused the request: ${'E'.repeat(1967)}`
const failed = { id: 'github', name: 'GitHub', state: 'error', error: stored }

test('#2027: Copy error hands the full stored text to the clipboard, then reads Copied', async () => {
  assert.equal(stored.length, 2000)
  writes.length = 0
  const view = mount(failed)
  const copy = buttonNamed(view.node(), 'Copy error')
  assert.ok(copy, 'a failed row offers Copy error')
  copy.props.onClick()
  await settle()
  assert.deepEqual(writes, [stored], 'the exact stored text lands on the clipboard')
  assert.equal(labels(view.node()).includes('Copied'), true, 'the button reports the copy')
  assert.equal(labels(view.node()).includes('Could not copy the error'), false)
  assert.deepEqual(labels(view.node()).filter(label => label === 'Copy error'), [], 'the hint is the label now')
  // The other two actions of a failed row are untouched.
  assert.ok(buttonNamed(view.node(), 'Try again'))
  assert.ok(buttonNamed(view.node(), 'Disconnect'))
})

test('#2027: no clipboard and a refused write both read Could not copy the error, never Copied', async () => {
  writes.length = 0
  try {
    sandbox.navigator.clipboard = undefined
    const broken = mount(failed)
    const copy = buttonNamed(broken.node(), 'Copy error')
    assert.ok(copy, 'a failed row offers Copy error with no clipboard too')
    copy.props.onClick()
    await settle()
    assert.equal(labels(broken.node()).includes('Could not copy the error'), true, 'a page with no clipboard says so')
    assert.equal(labels(broken.node()).includes('Copied'), false, 'a copy that did not happen never says Copied')
    assert.deepEqual(writes, [], 'nothing reached a clipboard that is not there')

    sandbox.navigator.clipboard = { writeText: async () => { throw new Error('NotAllowedError') } }
    const refused = mount(failed)
    buttonNamed(refused.node(), 'Copy error').props.onClick()
    await settle()
    assert.equal(labels(refused.node()).includes('Could not copy the error'), true, 'a refused write says so')
    assert.equal(labels(refused.node()).includes('Copied'), false, 'a refused write never says Copied')
  } finally {
    sandbox.navigator.clipboard = workingClipboard
  }
})

test('#2027: only an error row offers Copy error; ready and off keep their own actions', () => {
  const ready = mount({ id: 'github', name: 'GitHub', state: 'ready', account: 'octo' })
  assert.equal(labels(ready.node()).includes('Copy error'), false, 'a ready connector has nothing to copy')
  assert.ok(buttonNamed(ready.node(), 'Disconnect'))

  const off = mount({ id: 'github', name: 'GitHub', state: 'off' })
  assert.equal(labels(off.node()).includes('Copy error'), false, 'an off connector has nothing to copy')
  assert.ok(buttonNamed(off.node(), 'Connect'))

  const broken = mount(failed)
  assert.equal(labels(broken.node()).includes('Copy error'), true, 'only the failed row offers it')
  assert.ok(buttonNamed(broken.node(), 'Try again'), 'Try again is unchanged')
  assert.ok(buttonNamed(broken.node(), 'Disconnect'), 'Disconnect is unchanged')
})

test('#2027: both new labels speak Chinese too', () => {
  const zh = DICTIONARY.zh
  for (const key of ['Copy error', 'Could not copy the error']) {
    assert.equal(typeof zh[key], 'string', `${key} has a Chinese entry`)
    assert.match(zh[key], /[\u4e00-\u9fff]/, `${key} is Chinese, not a copied English line`)
  }
})

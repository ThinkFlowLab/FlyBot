// #2307: a read-only window still drew the whole Create-Bot form behind New… → New Bot, and only
// pressing Create got the host's `bot/read-only` refusal back. When the roster carries the host's
// own read-only sentence the form now draws that sentence in place of Create and `create()` never
// reaches the host; a writable window keeps today's form, Create included.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { CreateBot } from './src/client/create-bot.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// The form only needs a hook runtime that survives one call: the element tree it returns is read
// directly, so no re-render is involved.
const react = {
  createElement: h, Fragment: Symbol('F'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }),
  useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, body: {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  requestAnimationFrame: run => run(),
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { CreateBot } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const bot = { id: 'chief', name: 'Chief', model: '' }
const base = { bots: [bot], byId: { chief: bot }, models: [], mainBotId: 'chief' }
const rosterWith = readOnly => (readOnly === undefined ? { ...base } : { ...base, readOnly })

// The form returns elements; a function component's children are elements too, so the whole tree
// is walked without running any child component.
const walk = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) walk(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) }
  return out
}
const withClass = (nodes, name) => nodes.filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name))
const strings = (nodes) => nodes.flatMap(node => (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children])).filter(text => typeof text === 'string')
const render = (roster) => {
  const calls = []
  const actions = {
    createBot: async (payload) => { calls.push(['create-bot', payload]); return { id: 'new', name: 'New Bot' } },
    closeOverlay() {}, openSession() {}, notify() {}, showDetails() {},
  }
  const tree = CreateBot({ roster, actions, start: undefined, onBack() {}, canGoBack: false, onCreated: async () => {} })
  return { nodes: walk(tree), calls }
}

test('a read-only window draws no Create and says why, in the host\'s own sentence (#2307)', () => {
  const locked = render(rosterWith(SENTENCE))
  assert.equal(withClass(locked.nodes, 'bt-create-go').length, 0, 'no Create control')
  const hint = withClass(locked.nodes, 'bt-read-only')
  assert.equal(hint.length, 1, 'the form says the window is read-only')
  assert.ok(strings(walk(hint[0])).includes(SENTENCE), 'the host sentence is shown')
  assert.equal(hint[0].props.role, 'status')
})

test('a writable window draws Create exactly as before', async () => {
  const open = render(rosterWith(undefined))
  const go = withClass(open.nodes, 'bt-create-go')
  assert.equal(go.length, 1)
  assert.equal(go[0].props.disabled, false, 'Create is enabled')
  assert.equal(withClass(open.nodes, 'bt-read-only').length, 0, 'no read-only hint')
  assert.deepEqual(strings(walk(go[0])), ['Create'])
  go[0].props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(open.calls.length, 1, 'Create reaches the host')
  assert.equal(open.calls[0][0], 'create-bot')
})

test('a lock that arrives while the form is open keeps the form from calling the host (#2307)', async () => {
  const locked = render(rosterWith(SENTENCE))
  const input = locked.nodes.find(node => node.props?.['aria-label'] === 'Name')
  assert.ok(input, 'the preview keeps the name field')
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(locked.calls, [], 'Enter never reaches create-bot')
})

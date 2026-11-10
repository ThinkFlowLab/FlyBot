// #2799: in Feishu's app mode the App Secret is a masked credential. The masked input is the Secrets
// page's bare `.bt-secret-input` — no border, no background — because it only reads as a field
// inside a `.bt-q-field` wrapper. The connector form drew it without one, so the App Secret appeared
// as a grey placeholder line under the App ID box and the form looked like "App ID only".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { FEISHU_MODES } from '../src/host/connectors.js'

// The client bundle is built once, as the Settings page loads it, and run with a small React stand-in
// whose hook state is fed per render (the same shape core/test/feishu.test.js uses).
const { outputFiles } = await build({
  stdin: {
    contents: "export { ConnectorsPage } from './src/client/connectors.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
let states = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {},
  useState: v => [states.length > 0 ? states.shift() : (typeof v === 'function' ? v() : v), () => {}],
  useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get(),
}
const browser = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: browser, exports: browser.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  window: { matchMedia: () => ({ matches: false }) }, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ConnectorsPage } = browser.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => { if (node && typeof node === 'object') { if (Array.isArray(node)) node.forEach(child => all(child, out)); else { out.push(node); all(node.props?.children, out) } } return out }
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
const holds = (node, target) => node === target || (node && typeof node === 'object' && (Array.isArray(node) ? node.some(child => holds(child, target)) : holds(node.props?.children, target)))
const classes = node => String(node?.props?.className ?? '').split(/\s+/).filter(Boolean)

const actions = { connectorConnect: async () => {}, connectorDisconnect: async () => {}, connectorRetry: async () => {}, connectorSend: async () => {} }
const FEISHU_OFF = { id: 'feishu', name: 'Feishu', state: 'off', kind: 'channel', account: null, mode: null, modes: FEISHU_MODES, allowed: [] }

// ConnectorRow's hook order: form, bots, token, apps, picking, busy, error, message, copyState, mode,
// values. Everything after `mode` is left to its initializer.
const renderForm = (mode, values = {}) => {
  states = [true, false, '', [], false, false, null, '', 'idle', mode, values]
  const tree = expand(h(ConnectorsPage, { roster: { connectors: [{ ...FEISHU_OFF, mode }], bots: [], self: { memberId: 'me' } }, actions }))
  states = []
  return tree
}

const fieldWrapperOf = (tree, input) => all(tree).find(node => classes(node).includes('bt-q-field') && holds(node, input))
const connectButton = tree => all(tree).find(node => node.type === 'button' && text(node) === 'Connect')

test('#2799: app mode draws the masked App Secret inside the same bordered field wrapper as the App ID', () => {
  const tree = renderForm('app')
  const inputs = all(tree).filter(node => node.type === 'input')
  assert.deepEqual(inputs.map(node => node.props['aria-label']), ['App ID', 'App Secret'], 'app mode asks for both credentials')

  const appId = inputs[0]
  const secret = inputs[1]
  const idWrapper = fieldWrapperOf(tree, appId)
  const secretWrapper = fieldWrapperOf(tree, secret)
  assert.ok(idWrapper, 'the App ID sits in a bordered .bt-q-field, as it always has')
  assert.ok(secretWrapper, 'the App Secret field has no bordered wrapper: it renders as a bare .bt-secret-input, so the form reads as App ID only')
  assert.deepEqual(classes(secretWrapper), ['bt-q-field', 'bt-secret-field'], 'the App Secret uses the same wrapper the Secrets page puts around MaskedInput')
  assert.equal(secret.props.placeholder, 'Paste or type the key')
  assert.equal(text(secretWrapper), '', 'the label stays the aria-label the field already carries, not a second visible row')
})

test('#2799: the webhook mode is unchanged — one masked field, still wrapped', () => {
  const tree = renderForm('webhook')
  const inputs = all(tree).filter(node => node.type === 'input')
  assert.deepEqual(inputs.map(node => node.props['aria-label']), ['Webhook URL'], 'webhook mode still asks for one credential')
  assert.ok(fieldWrapperOf(tree, inputs[0]), 'and that field keeps its bordered wrapper')
})

test('#2799: Connect stays disabled until both app fields have text', () => {
  assert.equal(connectButton(renderForm('app', { app_id: 'cli_aa78608ba6f9dbb4' })).props.disabled, true, 'the App ID alone is not enough')
  assert.equal(connectButton(renderForm('app', { app_secret: 'app-secret-value' })).props.disabled, true, 'nor is the App Secret alone')
  assert.equal(connectButton(renderForm('app', { app_id: 'cli_aa78608ba6f9dbb4', app_secret: 'app-secret-value' })).props.disabled, false, 'both fields filled enable Connect')
})

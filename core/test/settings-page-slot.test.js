import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #337: a plugin adds a page to Settings (flybot.settings.page), after Connectors.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SettingsDialog } from './src/client/settings.js'; export { registry } from './src/client/flybot-registry.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Component: class {}, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [typeof v === 'function' ? v() : v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
  console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
})
const { SettingsDialog, registry } = module.exports
const all = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); for (const c of [node.props?.children].flat(Infinity)) all(c, out) } return out }
const text = node => (typeof node === 'string' ? node : [node?.props?.children].flat(Infinity).map(text).join(''))
const roster = { bots: [], rooms: [], byId: {}, roomsById: {}, prefs: {}, mainBotIds: [], connectors: [] }
const actions = { openSettings() {}, closeSettings() {} }

test('a flybot.settings.page entry is listed after Connectors and drawn with the host t, Section, Row and call', () => {
  const off = registry().register('flybot.settings.page', { id: 'social', order: 100, label: 'Bot Social', component: () => null })
  try {
    const tree = SettingsDialog({ page: 'plugin:social', id: null, roster, actions, useUpdate: () => ({}) })
    const nodes = all(tree)
    const items = nodes.filter(node => node.type === 'button' && node.props.className === 'bt-settings-item').map(text)
    assert.deepEqual(items.slice(3, 6), ['Connectors', 'Bot Social', 'Capabilities'])
    assert.equal(text(nodes.find(node => node.type === 'h2')), 'Bot Social')
    const slot = nodes.find(node => node.props?.entry?.id === 'social')
    assert.ok(slot)
    assert.deepEqual(Object.keys(slot.props.props).sort(), ['Row', 'Section', 'actions', 'call', 'roster', 'run', 't'].sort())
    assert.equal(slot.props.props.t('Bot Social'), 'Bot Social')
    assert.equal(typeof slot.props.props.call, 'function')
  } finally {
    off()
  }
})

test('a page whose plugin is gone falls back to General, and without plugins the list is unchanged', () => {
  const tree = SettingsDialog({ page: 'plugin:social', id: null, roster, actions, useUpdate: () => ({}) })
  const nodes = all(tree)
  assert.equal(text(nodes.find(node => node.type === 'h2')), 'General')
  const items = nodes.filter(node => node.type === 'button' && node.props.className === 'bt-settings-item').map(text)
  assert.deepEqual(items.slice(0, 6), ['General', 'Bots', 'Group chats', 'Connectors', 'Capabilities', 'Scheduled tasks'])
  assert.equal(nodes.some(node => node.props?.entry !== undefined), false)
})

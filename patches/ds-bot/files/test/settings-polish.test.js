import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #230: settings and Create Bot say each thing once.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SwitchRow } from './src/client/bot-settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { SwitchRow } = module.exports
const all = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); for (const c of [node.props?.children].flat()) all(c, out) } return out }
const src = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

test('a switch row under a card of the same name shows only its hint; the switch keeps its label', () => {
  const row = SwitchRow({ label: 'Main Bot', hint: 'Can create and change Bots.', on: false, showLabel: false, onChange() {} })
  const nodes = all(row)
  assert.equal(nodes.some(node => node.props?.className === 'bt-bs-label'), false)
  assert.ok(nodes.some(node => node.props?.className === 'bt-set-hint'))
  assert.equal(nodes.find(node => typeof node.type === 'function' && 'on' in (node.props ?? {})).props.label, 'Main Bot')
  const plain = all(SwitchRow({ label: 'Pin', on: false, onChange() {} }))
  assert.ok(plain.some(node => node.props?.className === 'bt-bs-label'))
})

test('the Model and Main Bot cards do not repeat their title as a row label', () => {
  const text = src('bot-settings.js')
  assert.doesNotMatch(text, /className: 'bt-bs-label' \}, t\('Model'\)\)/)
  assert.doesNotMatch(text, /className: 'bt-bs-label' \}, t\('Main Bot'\)\)/)
})

test('Create Bot has one back control: the dialog header, or the inline form\'s footer', () => {
  assert.match(src('create-bot.js'), /inline \? h\('button', \{ type: 'button', className: 'bt-soft', onClick: onBack \}/)
})

test('the account menu fits its longest item instead of cutting it', () => {
  assert.match(src('styles.js'), /\.bt-account-menu\{min-width:224px;width:max-content;/)
})

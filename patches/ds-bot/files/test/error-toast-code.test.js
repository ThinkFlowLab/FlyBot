// P-502: a refused action away from any form ("The Bot team is open in another dsh.") landed in
// the toast as its sentence alone. `reportError` built the payload as `{ text, token }`, so the
// host's code — `bot/read-only` — was dropped on the way, and the reader had no way to tell a
// second-holder refusal from any other failure. The sentence also told them to reload while the
// only Reload sat in the sidebar, behind the scrim that the refusal itself raises.
//
// The toast now carries the code, draws it, and for `bot/read-only` offers the client's own
// full-state read (`actions.reloadTeam`) in place. The window becomes writable without a page
// reload that would drop what is in the composer.
//
// The toast is rendered with real hooks; a `useEffect() {}` stub would never install its timers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { ErrorToast } from './src/client/feedback.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) all(child, out); return out }
  if (node && typeof node === 'object') {
    out.push(node)
    for (const child of [node.props?.children].flat(Infinity)) all(child, out)
  }
  return out
}
const text = node => [node?.props?.children].flat(Infinity)
  .filter(child => typeof child === 'string' || typeof child === 'number')
  .join('')
const byClass = (tree, name) => all(tree).filter(node => {
  const value = node?.props?.className
  return typeof value === 'string' && value.split(' ').includes(name)
})

// Just enough of the hooks runtime for a component with state and an effect.
function hooks() {
  const states = []
  const effects = []
  let cursor = 0
  return {
    react: {
      createElement: h,
      Fragment: Symbol('Fragment'),
      Component: class {},
      useState: (initial) => {
        const slot = cursor++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
        return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
      },
      useEffect: (fn) => { const slot = cursor++; if (!effects.includes(slot)) { effects.push(slot); fn() } },
      useLayoutEffect: (fn) => { const slot = cursor++; if (!effects.includes(slot)) { effects.push(slot); fn() } },
      useMemo: make => make(),
      useCallback: fn => fn,
      useRef: value => ({ current: value }),
    },
  }
}

const context = () => ({
  module: { exports: {} },
  exports: {},
  document: { addEventListener() {}, removeEventListener() {}, activeElement: null, querySelector: () => null },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  console, Date, JSON, Promise, Symbol,
  // The toast's own timers only decide when it fades; the test drives every press itself.
  setTimeout: () => 0,
  clearTimeout: () => {},
  __flybot__: { slots: { entries: () => [], subscribe: () => () => {}, version: () => 0 }, call: () => {} },
  require: (name) => {
    if (name === 'react') return hooks().react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})

const load = () => {
  const sandbox = context()
  const runtime = hooks()
  sandbox.require = (name) => {
    if (name === 'react') return runtime.react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  }
  sandbox.module.exports = sandbox.exports
  runInNewContext(outputFiles[0].text, sandbox)
  return sandbox.module.exports
}

const { ErrorToast } = load()

function mount(toast, { reloadTeam, reportError } = {}) {
  const dismissed = []
  const actions = {
    dismissToast: token => dismissed.push(token),
    openSettings() {},
    reloadTeam,
    reportError,
  }
  const tree = ErrorToast({ useUi: select => select({ toast }), actions })
  return { tree, dismissed, byClass: name => byClass(tree, name), text }
}

const READ_ONLY = 'The Bot team is open in another dsh.'

test('P-502: the toast names the code the host sent', () => {
  const view = mount({ text: READ_ONLY, token: 7, code: 'bot/read-only' })
  const tags = view.byClass('bt-toast-code')
  assert.equal(tags.length, 1, 'the refusal code is drawn once')
  assert.equal(view.text(tags[0]), 'bot/read-only', 'the reader sees the host\'s own code')
  assert.ok(view.text(view.byClass('bt-toast-text')[0]).includes('open in another dsh'), 'the sentence is still the toast\'s copy')
})

test('P-502: a read-only toast offers a Reload that reads the team again in place', async () => {
  let calls = 0
  const view = mount({ text: READ_ONLY, token: 7, code: 'bot/read-only' }, { reloadTeam: () => { calls += 1; return Promise.resolve() } })
  const buttons = view.byClass('bt-toast-reload')
  assert.equal(buttons.length, 1, 'the toast carries the way out of the refusal')
  const [button] = buttons
  assert.equal(button.type, 'button', 'it is a button')
  assert.equal(button.props.type, 'button', 'it does not submit anything')
  assert.equal(view.text(button), 'Reload', 'its label comes from the shared copy')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1, 'one press reads the team once')
  assert.deepEqual(view.dismissed, [7], 'the refusal leaves once the read has started')
})

test('P-502: another failure keeps its code and offers no Reload', () => {
  const view = mount({ text: 'The Bot refused that.', token: 8, code: 'bot/refused' })
  const tags = view.byClass('bt-toast-code')
  assert.equal(tags.length, 1)
  assert.equal(view.text(tags[0]), 'bot/refused', 'any code the host sent is drawn')
  assert.equal(view.byClass('bt-toast-reload').length, 0, 'only the read-only refusal can be answered by a reload')
})

test('P-502: a toast with no code draws no tag and keeps its Details link', () => {
  const view = mount({ text: 'Choose a Bot first.', token: 9 })
  assert.equal(view.byClass('bt-toast-code').length, 0, 'no code, no tag')
  assert.equal(view.byClass('bt-toast-reload').length, 0)
  const links = view.byClass('bt-toast-link')
  assert.equal(links.length, 1, 'the Details entry is unchanged')
  assert.equal(view.text(links[0]), 'Details')
})

test('P-502: a reload that fails says so through the error channel, not an unhandled rejection', async () => {
  const failure = new Error('network error: Failed to fetch')
  const seen = []
  const view = mount({ text: READ_ONLY, token: 11, code: 'bot/read-only' }, {
    reloadTeam: () => Promise.reject(failure),
    reportError: (error, where) => seen.push([error, where]),
  })
  view.byClass('bt-toast-reload')[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, [[failure, 'reload']], 'the failure goes to the same channel the sidebar reload uses')
})

test('P-502: reportError keeps the host code in the toast payload it sets', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const at = source.indexOf('reportError: (error, where')
  assert.notEqual(at, -1, 'the client still registers reportError')
  const body = source.slice(at, source.indexOf('\n    notify:', at))
  assert.match(body, /toast:\s*\{[^}]*\bcode\b/, 'the payload carries the code, or no toast can ever name bot/read-only')
})

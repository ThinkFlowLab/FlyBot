import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #2251: an `aria-modal` Settings dialog never took focus, so Tab walked the page
// behind the scrim and Escape could be caught by the composer. The dialog takes focus
// when it opens and gives it back to the opener when it closes (#274's shape).
// This test runs the real hooks: a small runtime below commits refs and runs effects.
const { outputFiles } = await build({
  stdin: {
    contents: "export { SettingsDialog } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const all = (node, out = []) => {
  if (node && typeof node === 'object') {
    out.push(node)
    for (const child of [node.props?.children].flat(Infinity)) all(child, out)
  }
  return out
}

// One effect per hook call, run by `mount` after refs are committed, the way React
// runs layout effects and effects on mount. `useEffect() {}` stubs would hide the bug.
let effects = []
const react = {
  createElement: h,
  Component: class {},
  Fragment: Symbol('F'),
  useEffect: (fn) => { effects.push(fn) },
  useLayoutEffect: (fn) => { effects.push(fn) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, get) => get(),
}

// A browser moves `document.activeElement` when a node takes focus. A fake that only
// records the call cannot tell "the dialog still has focus" from "the user moved it on".
let activeDocument = null

const fakeNode = (kind) => ({
  kind, focusCalls: [], style: {}, dataset: {}, isConnected: true,
  focus(options) { this.focusCalls.push(options ?? {}); if (activeDocument) activeDocument.activeElement = this },
  contains: node => node === this,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0,
})

// Point every `ref` in the returned tree at a node, as the renderer would on commit.
const commit = (node, seen = new Set()) => {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  const ref = node.props?.ref
  if (ref && typeof ref === 'object' && ref.current === null) ref.current = fakeNode('element')
  for (const child of [node.props?.children].flat(Infinity)) commit(child, seen)
}

const roster = { bots: [], rooms: [], byId: {}, roomsById: {}, prefs: {}, mainBotIds: [], connectors: [] }
const actions = { openSettings() {}, closeSettings() {} }

function mount(overrides = {}) {
  effects = []
  const opener = fakeNode('opener')
  const context = {
    module: { exports: {} }, exports: {},
    document: {
      activeElement: opener, hidden: false, addEventListener() {}, removeEventListener() {},
      querySelector: () => null,
    },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {} },
    window: {
      addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
    console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  }
  context.module.exports = context.exports
  activeDocument = context.document
  runInNewContext(outputFiles[0].text, context)
  const { SettingsDialog } = context.module.exports
  const tree = SettingsDialog({ page: 'general', id: null, roster, actions, useUpdate: () => ({}), ...overrides })
  commit(tree)
  const dialogNode = all(tree).find(node => node.props?.className === 'bt-settings')
  const cleanups = []
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return {
    tree, dialogNode, opener, document: context.document,
    unmount() { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

test('the Settings dialog is a focus target: tabIndex -1 on the dialog container', () => {
  const { dialogNode } = mount()
  assert.ok(dialogNode, 'the dialog container is drawn')
  assert.equal(dialogNode.props.tabIndex, -1)
})

test('opening moves focus into the dialog and closing gives it back to the still-connected opener', () => {
  const { dialogNode, opener, unmount } = mount()
  const dialogRef = dialogNode.props.ref
  assert.ok(dialogRef, 'the dialog container carries a ref so it can take focus')
  const dialog = dialogRef.current
  assert.equal(dialog.focusCalls.length, 1, 'the dialog takes focus once on mount')
  assert.equal(dialog.focusCalls[0]?.preventScroll, true)
  assert.equal(opener.focusCalls.length, 0, 'the opener is not touched while the dialog is open')
  unmount()
  assert.equal(opener.focusCalls.length, 1, 'the opener gets focus back when the dialog unmounts')
  assert.equal(opener.focusCalls[0]?.preventScroll, true)
})

// #2270: the Settings dialog is drawn for DIALOG_EXIT_MS (160 ms) after it closes, with
// `pointer-events: none` on that leaving layer, so a click there lands on the page behind
// it. The unmount must not drag focus back to the opener once the user has moved it.
test('a click that moves focus during the exit animation is not pulled back to the opener', () => {
  const { document, opener, unmount } = mount()
  const composer = fakeNode('composer')
  composer.focus({ preventScroll: true })
  assert.equal(document.activeElement, composer, 'the user\'s click took focus')
  unmount()
  assert.equal(document.activeElement, composer, 'focus stays where the user put it')
  assert.equal(composer.focusCalls.length, 1, 'the late cleanup does not refocus the page')
  assert.equal(opener.focusCalls.length, 0, 'the opener is not focused after the user moved on')
})

test('the dialog keeps its role, aria-modal, aria-label and data-wide contract', () => {
  const narrow = mount().dialogNode.props
  assert.equal(narrow.role, 'dialog')
  assert.equal(narrow['aria-modal'], true)
  assert.equal(narrow['aria-label'], 'FlyBot settings')
  assert.equal(narrow['data-wide'], undefined)
  assert.equal(mount({ page: 'usage' }).dialogNode.props['data-wide'], '')
})

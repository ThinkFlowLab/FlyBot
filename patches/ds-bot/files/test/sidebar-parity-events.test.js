// First-batch shell: the icon rail and header entries actually fire navigation, typing
// focuses search, and the collapsed rail keeps its existing shape.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { MOBILE_CSS } from '../src/client/mobile.js'
import { PARITY_SHELL_CSS } from '../src/client/parity-shell.js'

const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
class Component {
  constructor(props) { this.props = props }
  setState() {}
}
const react = {
  createElement: h,
  Fragment: Symbol('Fragment'),
  Component,
  PureComponent: Component,
  createRef: () => ({ current: null }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useLayoutEffect() {},
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useMemo: fn => fn(),
}
const slots = { entries: () => [], subscribe: () => () => {}, version: () => 0 }
const module = { exports: {} }
class Element {}
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, Date, JSON, Promise, Symbol, Element,
  __flybot__: { slots, call: () => {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { TeamSidebar } = module.exports

const walk = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  walk(node.props?.children, out)
  return out
}
const all = tree => walk(tree)
const byClass = (tree, name) => all(tree).filter(node => {
  const value = node.props?.className
  return typeof value === 'string' && value.split(' ').includes(name)
})
const buttonsNamed = (tree, label) => all(tree).filter(node => node.type === 'button' && node.props?.['aria-label'] === label)

function renderSidebar({ wide, actions }) {
  const roster = { ready: true, bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, mainBotId: undefined }
  const defaults = {
    openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {},
    landOnMainBot() {}, clearUnread() {}, isAgentSession: () => false,
  }
  return TeamSidebar({
    wide,
    useRoster: select => select(roster),
    useUi: select => select({}),
    useSessions: select => select({ ids: [], byId: {} }),
    useRegistry: () => {},
    useUpdate: select => select({}),
    useWork: select => select({}),
    useSessionStatus: select => select({}),
    useSessionRetainInfo: select => select({}),
    useActivity: select => select({}),
    actions: { ...defaults, ...actions },
  })
}

test('wide sidebar Search and New in the rail and the header open the same actions', () => {
  const palette = []
  const created = []
  const tree = renderSidebar({
    wide: true,
    actions: {
      openPalette: (query) => palette.push(query ?? 'open'),
      openNewChat: (kind) => created.push(kind),
    },
  })
  assert.equal(byClass(tree, 'bt-side-split').length, 1)
  assert.equal(byClass(tree, 'bt-rail').length, 0)
  const rail = byClass(tree, 'bt-icon-rail')
  assert.equal(rail.length, 1)
  assert.equal(rail[0].type, 'nav')
  assert.equal(rail[0].props['aria-label'], 'FlyBot')

  const search = buttonsNamed(tree, 'Search')
  const createdBtns = buttonsNamed(tree, 'New…')
  assert.equal(search.length, 2, 'Search stays in the header and is also on the rail')
  assert.equal(createdBtns.length, 2, 'New stays in the header and is also on the rail')
  for (const button of [...search, ...createdBtns]) {
    assert.equal(button.props.type, 'button')
    assert.equal(typeof button.props.onClick, 'function')
    assert.ok(button.props.title)
  }

  search[0].props.onClick()
  search[1].props.onClick()
  assert.deepEqual(palette, ['open', 'open'])
  createdBtns[0].props.onClick()
  createdBtns[1].props.onClick()
  assert.deepEqual(created, ['new', 'new'])
})

test('typing a character in the wide sidebar opens search with that character', () => {
  const palette = []
  const tree = renderSidebar({ wide: true, actions: { openPalette: (query) => palette.push(query) } })
  const event = {
    key: 'c',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    target: {},
    preventDefault() { this.defaultPrevented = true },
  }
  tree.props.onKeyDown(event)
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(palette, ['c'])
})

test('modifier keys and Space do not steal focus for search', () => {
  const palette = []
  const tree = renderSidebar({ wide: true, actions: { openPalette: (query) => palette.push(query) } })
  const fire = (extra) => {
    const event = {
      key: 'c', defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false,
      nativeEvent: { isComposing: false }, target: {}, preventDefault() { this.defaultPrevented = true },
      ...extra,
    }
    tree.props.onKeyDown(event)
    return event
  }
  fire({ metaKey: true })
  fire({ ctrlKey: true })
  fire({ altKey: true })
  fire({ key: ' ' })
  fire({ key: 'Enter' })
  fire({ key: 'c', nativeEvent: { isComposing: true } })
  assert.deepEqual(palette, [])
})

test('the collapsed rail keeps New, and does not draw the wide icon rail', () => {
  const created = []
  const tree = renderSidebar({ wide: false, actions: { openNewChat: (kind) => created.push(kind) } })
  assert.equal(byClass(tree, 'bt-rail').length, 1)
  assert.equal(byClass(tree, 'bt-icon-rail').length, 0)
  assert.equal(byClass(tree, 'bt-side-split').length, 0)
  const createdBtns = buttonsNamed(tree, 'New…')
  assert.equal(createdBtns.length, 1)
  createdBtns[0].props.onClick()
  assert.deepEqual(created, ['new'])
})

test('desktop composer and header restyles stay above the phone breakpoint, and phone approval offsets stay put', () => {
  assert.match(PARITY_SHELL_CSS, /@media \(min-width:641px\)/)
  const desktop = PARITY_SHELL_CSS.split('@media (min-width:641px)')[1]
  assert.match(desktop, /min-height:86px/)
  assert.match(desktop, /border-radius:20px/)
  assert.doesNotMatch(PARITY_SHELL_CSS.split('@media (min-width:641px)')[0], /min-height:86px/)
  assert.match(MOBILE_CSS, /@media \(max-width:640px\)/)
  assert.match(MOBILE_CSS, /\.bt-flybot-approvals\{left:64px/)
  assert.match(MOBILE_CSS, /\.bt-flybot-pointers\{[^}]*max-width:calc\(100vw - 72px\)/)
})

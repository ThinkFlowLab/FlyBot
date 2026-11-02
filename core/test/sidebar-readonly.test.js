// #2188: the host's read-only sentence in the sidebar. It is drawn in the wide sidebar under the
// top buttons; the narrow rail drew nothing, so a window that is open elsewhere looked
// editable. The rail is too narrow for the sentence, so it is clipped to one line and the
// whole text stays readable through `title` and `aria-label`.
//
// The wide branch is the shipped behaviour and its output must not change: same class,
// same role, no extra attribute. The one deliberate change on this diff's side is a host
// sentence of only whitespace, which now draws nothing in either shape (see the last test).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar, SIDEBAR_CSS } from './src/client/sidebar.js'",
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
// Renders the sidebar's own output only: a child component stays an element, so a hook a row
// needs never runs. The host sentence is drawn by TeamSidebar itself.
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

const load = () => {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    console,
    Date,
    JSON,
    Promise,
    Symbol,
    __flybot__: { slots, call: () => {} },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  return module.exports
}

const { TeamSidebar, SIDEBAR_CSS } = load()

const HOST_TEXT = 'The Bot team is open in another dsh.'

function renderSidebar({ wide, readOnly = HOST_TEXT, readOnlyKey = true }) {
  const roster = { ready: true, bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, mainBotId: undefined, ...readOnlyKey ? { readOnly } : {} }
  const actions = {
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
    actions,
  })
}

// The element tree down to the child components, which stay opaque.
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
const textOf = node => (node.props?.children ?? [])
  .filter(child => typeof child === 'string' || typeof child === 'number')
  .join('')

test('a read-only host keeps the wide sidebar sentence exactly as it was', () => {
  const tree = renderSidebar({ wide: true })
  assert.equal(byClass(tree, 'bt-rail').length, 0)
  const hints = byClass(tree, 'bt-read-only')
  assert.equal(hints.length, 1)
  assert.equal(hints[0].type, 'div')
  assert.equal(hints[0].props.className, 'bt-hint bt-read-only')
  assert.equal(hints[0].props.role, 'status')
  assert.equal(textOf(hints[0]), HOST_TEXT)
  // The wide branch gained no tooltip: the sentence is drawn in full there.
  assert.equal(hints[0].props.title, undefined)
  assert.equal(hints[0].props['aria-label'], undefined)
})

test('a read-only host says so in the sidebar rail, with the whole sentence as its tooltip', () => {
  const tree = renderSidebar({ wide: false })
  assert.equal(byClass(tree, 'bt-rail').length, 1)
  const hints = byClass(tree, 'bt-read-only')
  assert.equal(hints.length, 1)
  assert.equal(hints[0].type, 'div')
  assert.equal(hints[0].props.role, 'status')
  // The clipped line still carries the sentence itself, and the full text for a hover,
  // a screen reader and a reader of the accessibility tree.
  assert.equal(textOf(hints[0]), HOST_TEXT)
  assert.equal(hints[0].props.title, HOST_TEXT)
  assert.equal(hints[0].props['aria-label'], HOST_TEXT)
})

test('the rail clips the sentence to one line and the wide rule is untouched', () => {
  assert.match(SIDEBAR_CSS, /\.bt-side \.bt-read-only\{margin:4px 8px 6px;padding:8px 10px;border-radius:10px;background:var\(--bt-hover\);font-size:12px;line-height:1\.45;text-align:left\}/)
  const rail = SIDEBAR_CSS.match(/\.bt-rail \.bt-read-only\{([^}]*)\}/)
  assert.ok(rail, 'the rail rule is missing')
  assert.match(rail[1], /white-space:nowrap/)
  assert.match(rail[1], /overflow:hidden/)
  assert.match(rail[1], /text-overflow:ellipsis/)
  assert.match(rail[1], /text-align:center/)
  // Both rules match inside the rail (it carries `bt-side` too), so the rail rule must win.
  assert.ok(SIDEBAR_CSS.indexOf('.bt-rail .bt-read-only') > SIDEBAR_CSS.indexOf('.bt-side .bt-read-only'))
})

test('a writable window, or a host sentence of only whitespace, draws no read-only sentence in either shape', () => {
  for (const wide of [true, false]) {
    const shape = wide ? 'wide' : 'rail'
    for (const readOnly of [null, '', '   ', '\n\t ']) {
      const tree = renderSidebar({ wide, readOnly })
      assert.equal(byClass(tree, 'bt-read-only').length, 0, `${shape}, ${JSON.stringify(readOnly)}`)
    }
    // The host said nothing at all: the field is absent, not empty.
    assert.equal(byClass(renderSidebar({ wide, readOnlyKey: false }), 'bt-read-only').length, 0, `${shape}, no field`)
  }
})

// #2247: the host's read-only sentence tells the person to "close the other one and reload",
// but the window offered no reload entry at all. The banner now carries one Reload button in
// both sidebar shapes. It sits beside the status line, not inside it: a `role="status"` region
// must stay text, or a screen reader reads the button as part of every announcement. The button
// runs `actions.reloadTeam`, the client's full-state read, so the window becomes writable once
// the other holder let go — without a page reload that would drop what is in the composer.
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

function renderSidebar({ wide, readOnly = HOST_TEXT, readOnlyKey = true, reloadTeam, reportError } = {}) {
  const roster = { ready: true, bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, mainBotId: undefined, ...readOnlyKey ? { readOnly } : {} }
  const actions = {
    openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {},
    landOnMainBot() {}, clearUnread() {}, isAgentSession: () => false,
    reloadTeam, reportError,
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

test('both sidebar shapes offer one Reload button beside the read-only sentence', () => {
  for (const wide of [true, false]) {
    const shape = wide ? 'wide' : 'rail'
    const tree = renderSidebar({ wide })
    const hints = byClass(tree, 'bt-read-only')
    assert.equal(hints.length, 1, `${shape}: the host's sentence is still drawn once`)
    const buttons = byClass(tree, 'bt-read-only-reload')
    assert.equal(buttons.length, 1, `${shape}: the banner offers one Reload entry`)
    const button = buttons[0]
    assert.equal(button.type, 'button', `${shape}: it is a button`)
    assert.equal(button.props.type, 'button', `${shape}: it does not submit a form`)
    assert.equal(textOf(button), 'Reload', `${shape}: its label comes from the shared copy`)
    // The sentence keeps its status line; the control lives outside it, in reading order after it.
    assert.equal(all(hints[0]).includes(button), false, `${shape}: the live region stays text-only`)
    assert.ok(all(tree).indexOf(hints[0]) < all(tree).indexOf(button), `${shape}: the sentence is read first`)
  }
})

test('the Reload button starts the client\'s full-state read', async () => {
  let calls = 0
  const tree = renderSidebar({ wide: true, reloadTeam: () => { calls += 1; return Promise.resolve() } })
  const [button] = byClass(tree, 'bt-read-only-reload')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1, 'one press reads the team once')
})

test('a failed reload says so through the sidebar error channel, not an unhandled rejection', async () => {
  const failure = new Error('network error: Failed to fetch')
  const seen = []
  const tree = renderSidebar({ wide: false, reloadTeam: () => Promise.reject(failure), reportError: (error, where) => seen.push([error, where]) })
  const [button] = byClass(tree, 'bt-read-only-reload')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, [[failure, 'reload']])
})

test('a writable window, or a host sentence of only whitespace, offers no Reload entry', () => {
  for (const wide of [true, false]) {
    const shape = wide ? 'wide' : 'rail'
    for (const readOnly of [null, '', '   ', '\n\t ']) {
      const tree = renderSidebar({ wide, readOnly })
      assert.equal(byClass(tree, 'bt-read-only-reload').length, 0, `${shape}, ${JSON.stringify(readOnly)}`)
    }
    assert.equal(byClass(renderSidebar({ wide, readOnlyKey: false }), 'bt-read-only-reload').length, 0, `${shape}, no field`)
  }
})

test('both shapes carry a style for the Reload button, and the rail rule wins over the generic one', () => {
  assert.match(SIDEBAR_CSS, /\.bt-read-only-reload\{[^}]*cursor:pointer/)
  const rail = SIDEBAR_CSS.match(/\.bt-rail \.bt-read-only-reload\{([^}]*)\}/)
  assert.ok(rail, 'the rail needs its own compact rule')
  assert.match(rail[1], /text-align:center/)
  assert.ok(SIDEBAR_CSS.indexOf('.bt-rail .bt-read-only-reload') > SIDEBAR_CSS.indexOf('.bt-read-only-reload{'))
})

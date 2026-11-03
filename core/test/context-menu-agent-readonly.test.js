// A window that holds the team read-only draws none of the DSH Agent menu's writes.
// The host refuses each of them with `bot/read-only` (`core/src/host/channel.js`: none of
// set-flags, remove-agent, agent-rename, agent-archive is in READS), so an offered control
// can only produce a refusal toast. The menu reads `roster.readOnly` exactly as the Bot menu
// does: a string that trims to nothing is a writable window (#2253).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { indexRoster } from '../src/client/sources.js'

const STUB = `
export const call = async () => ({})
`
const stubApi = {
  name: 'stub-api',
  setup(context) {
    context.onResolve({ filter: /(^|\/)api\.js$/ }, () => ({ path: 'flybot-api-stub', namespace: 'stub' }))
    context.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
  },
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/context-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
  plugins: [stubApi],
})

// One render pass over the hook shim: the menu reads its inputs and draws, so hooks only have
// to answer what the component reads during that one call.
let pass = null
const sandbox = {
  module: { exports: {} }, exports: null, Date, Promise, console,
  window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1400, innerHeight: 900 },
  document: { body: {} },
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: (initial) => {
          const index = pass === null ? 0 : pass.index++
          if (pass === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
          if (!(index in pass.values)) pass.values[index] = typeof initial === 'function' ? initial() : initial
          return [pass.values[index], (next) => { pass.values[index] = typeof next === 'function' ? next(pass.values[index]) : next }]
        },
        useEffect: () => {}, useLayoutEffect: () => {},
        useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
        Component: class { constructor(props) { this.props = props } setState() {} render() { return null } },
      },
      'react-dom': { createPortal: element => element },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
}
sandbox.exports = sandbox.module.exports
runInNewContext(bundle.outputFiles[0].text, sandbox)
const { ContextMenu } = sandbox.module.exports

const renderNode = (node) => {
  if (Array.isArray(node)) return node.map(renderNode)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(renderNode) }
}
const draw = (element) => {
  pass = { index: 0, values: [] }
  const tree = renderNode(element())
  pass = null
  return tree
}

const textOf = node => (node?.children ?? []).flat(Infinity).filter(child => typeof child === 'string').join('')
// Every row the menu draws, by its visible label.
const menuItems = (node, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (node.props?.role === 'menuitem') found.push(textOf(node))
  for (const child of node.children ?? []) menuItems(child, found)
  return found
}

const agents = [
  { id: 'dsh1', name: 'Desk', pinned: false },
  { id: 'dsh2', name: 'Bench', pinned: true },
]
const rosterOf = (extra = {}) => indexRoster({ bots: [], rooms: [], agents, ...extra })

// Every label whose click writes through the host, by the menu that draws it.
const AGENT_WRITES = ['Pin', 'Unpin', 'Remove DSH Agent']
const SESSION_WRITES = ['Rename', 'Archive']

const actions = () => ({
  closeMenu: () => {}, markUnread: () => {}, openSettings: () => {}, setFlags: () => {}, renameBot: () => {},
  duplicateBot: async () => ({ id: 'copy' }), openSession: () => {}, setMain: () => {}, deleteBot: () => {},
  deleteRoom: () => {}, reportError: () => {}, removeAgent: () => {}, beginAgentRename: () => {},
  archiveAgentSession: () => {},
})
const drawMenu = (roster, menu) => draw(() => ContextMenu({ menu, roster, actions: actions(), leaving: false }))
const menusOf = roster => ({
  agent: drawMenu(roster, { kind: 'agent', id: 'dsh1', x: 10, y: 10 }),
  pinned: drawMenu(roster, { kind: 'agent', id: 'dsh2', x: 10, y: 10 }),
  session: drawMenu(roster, { kind: 'agent-session', id: 's1', agentId: 'dsh1', x: 10, y: 10 }),
})
const labelsOf = menus => Object.fromEntries(Object.entries(menus).map(([name, tree]) => [name, menuItems(tree)]))

test('a read-only window offers no write in the DSH Agent menus', () => {
  const labels = labelsOf(menusOf(rosterOf({ readOnly: 'This window holds the team read-only.' })))
  assert.deepEqual(labels.agent.filter(label => AGENT_WRITES.includes(label)), [], 'the agent menu still offers a write')
  assert.deepEqual(labels.pinned.filter(label => AGENT_WRITES.includes(label)), [], 'the pinned agent menu still offers a write')
  assert.deepEqual(labels.session.filter(label => SESSION_WRITES.includes(label)), [], 'the session menu still offers a write')
})

test('a read-only window draws no empty menu box', () => {
  const menus = menusOf(rosterOf({ readOnly: 'read only' }))
  for (const [menu, tree] of Object.entries(menus)) assert.equal(tree, null, `the read-only ${menu} menu drew a box`)
})

test('a writable window keeps every Agent write exactly as it is', () => {
  const labels = labelsOf(menusOf(rosterOf()))
  assert.deepEqual(labels.agent, ['Pin', 'Remove DSH Agent'])
  assert.deepEqual(labels.pinned, ['Unpin', 'Remove DSH Agent'])
  assert.deepEqual(labels.session, ['Rename', 'Archive'])
})

test('a host sentence that trims to nothing is a writable window', () => {
  for (const readOnly of [undefined, '', '   ']) {
    const labels = labelsOf(menusOf(rosterOf({ readOnly })))
    assert.deepEqual(labels.agent, ['Pin', 'Remove DSH Agent'], `readOnly ${JSON.stringify(readOnly)} hid the agent writes`)
    assert.deepEqual(labels.session, ['Rename', 'Archive'], `readOnly ${JSON.stringify(readOnly)} hid the session writes`)
  }
})

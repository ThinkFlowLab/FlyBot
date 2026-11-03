// A window that holds the team read-only draws none of the core right-click menu's writes.
// The host refuses each of them with `bot/read-only` (`core/src/host/channel.js`: none of
// set-flags, duplicate-bot, set-main, delete-bot, delete-room is in READS), so an offered
// control can only produce a refusal toast. The menu reads `roster.readOnly` the way the
// sidebar header and the scheduled-tasks page read it: a string that trims to nothing is a
// writable window (#2176, #2199, #2232, #2238).
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

// A render pass over the hook shim: one pass is enough here, because the menu reads its inputs
// and draws; hooks only have to answer what the component reads during that one call.
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

const bots = [
  { id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] },
  { id: 'chief2', name: 'Chief Two', sessionId: 'chief2', parts: ['chief2'], pinned: true },
  { id: 'writer', name: 'Writer', sessionId: 'writer', parts: ['writer'] },
]
const rooms = [{ id: 'room', name: 'Launch', members: ['chief', 'writer'] }]
const rosterOf = (extra = {}) => indexRoster({ bots, rooms, mainBotId: 'chief', mainBotIds: ['chief', 'chief2'], ...extra })

// Every label whose click writes through the host, wherever the menu puts it.
const WRITES = ['Pin', 'Unpin', 'Duplicate', 'Make Main Bot', 'Remove Main Bot role', 'Hide from sidebar', 'Delete', 'Rename group', 'Delete group']
const KEEPS = ['Mark as Unread', 'Copy conversation ID']

const actions = () => ({
  closeMenu: () => {}, markUnread: () => {}, openSettings: () => {}, setFlags: () => {}, renameBot: () => {},
  duplicateBot: async () => ({ id: 'copy' }), openSession: () => {}, setMain: () => {}, deleteBot: () => {},
  deleteRoom: () => {}, reportError: () => {},
})
const drawMenu = (roster, menu) => draw(() => ContextMenu({ menu, roster, actions: actions(), leaving: false }))
const menusOf = roster => ({
  bot: drawMenu(roster, { kind: 'bot', id: 'writer', x: 10, y: 10 }),
  main: drawMenu(roster, { kind: 'bot', id: 'chief2', x: 10, y: 10 }),
  room: drawMenu(roster, { kind: 'room', id: 'room', x: 10, y: 10 }),
})
const labelsOf = menus => Object.fromEntries(Object.entries(menus).map(([name, tree]) => [name, menuItems(tree)]))

test('a read-only window offers no write in any core menu', () => {
  const labels = labelsOf(menusOf(rosterOf({ readOnly: 'This window holds the team read-only.' })))
  for (const [menu, items] of Object.entries(labels)) {
    assert.deepEqual(items.filter(label => WRITES.includes(label)), [], `the ${menu} menu still offers a write`)
  }
})

test('a writable window keeps every write exactly as it is', () => {
  const labels = labelsOf(menusOf(rosterOf()))
  assert.deepEqual(labels.bot, ['Pin', 'Mark as Unread', 'Edit Bot', 'Duplicate', 'Make Main Bot', 'Copy conversation ID', 'Hide from sidebar', 'Delete'])
  assert.deepEqual(labels.main, ['Unpin', 'Mark as Unread', 'Edit Bot', 'Duplicate', 'Remove Main Bot role', 'Copy conversation ID'])
  assert.deepEqual(labels.room, ['Pin', 'Mark as Unread', 'Group settings', 'Rename group', 'Copy conversation ID', 'Hide from sidebar', 'Delete group'])
})

test('the rows that do not write stay in both windows', () => {
  const readOnly = labelsOf(menusOf(rosterOf({ readOnly: 'read only' })))
  const writable = labelsOf(menusOf(rosterOf()))
  for (const labels of [readOnly, writable]) {
    assert.deepEqual([...labels.bot, ...labels.room].filter(label => KEEPS.includes(label)).sort(), ['Copy conversation ID', 'Copy conversation ID', 'Mark as Unread', 'Mark as Unread'])
    assert.ok(labels.bot.includes('Edit Bot'))
    assert.ok(labels.room.includes('Group settings'))
  }
  assert.deepEqual(readOnly.bot, ['Mark as Unread', 'Edit Bot', 'Copy conversation ID'])
  assert.deepEqual(readOnly.main, ['Mark as Unread', 'Edit Bot', 'Copy conversation ID'])
  assert.deepEqual(readOnly.room, ['Mark as Unread', 'Group settings', 'Copy conversation ID'])
})

test('a host sentence that trims to nothing is a writable window', () => {
  for (const readOnly of [undefined, '', '   ']) {
    const labels = labelsOf(menusOf(rosterOf({ readOnly })))
    assert.ok(labels.bot.includes('Delete'), `readOnly ${JSON.stringify(readOnly)} hid the writes`)
    assert.ok(labels.room.includes('Delete group'), `readOnly ${JSON.stringify(readOnly)} hid the room writes`)
  }
})

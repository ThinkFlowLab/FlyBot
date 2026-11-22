// The manual unread mark is a client-only key in `ui.unread` (#3110 L102, #3114): a chat
// that is already marked unread must offer to clear that mark from its row menu and from
// the conversation header, without opening the chat. Clearing it never touches the host's
// completion or pending-interaction flags — opening the chat is what acknowledges those.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { indexRoster } from '../src/client/sources.js'

// One bundle for both surfaces; the header namespace keeps a missing export an assertion, not a build error.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ContextMenu } from './src/client/context-menu.js'",
      "import * as header from './src/client/header.js'",
      'export { header }',
    ].join('\n'),
    // `pathname` of a file URL keeps the leading slash before a Windows drive (`/D:/...`),
    // which esbuild cannot resolve; `fileURLToPath` gives the path the platform understands.
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// One render pass over the hook shim is enough: these components read their inputs and draw.
let pass = null
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
const sandbox = {
  module: { exports: {} }, exports: null, Date, Promise, console, JSON, Map, Set,
  window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1400, innerHeight: 900 },
  document: { body: {}, addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null },
  navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: (initial) => {
          const index = pass === null ? 0 : pass.index++
          if (!pass) return [initial, () => {}]
          if (!(index in pass.values)) pass.values[index] = typeof initial === 'function' ? initial() : initial
          return [pass.values[index], (next) => { pass.values[index] = typeof next === 'function' ? next(pass.values[index]) : next }]
        },
        useEffect: () => {}, useLayoutEffect: () => {},
        useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), useSyncExternalStore: (_subscribe, get) => get(),
        Fragment: 'fragment',
        Component: class { constructor(props) { this.props = props } setState() {} render() { return null } },
      },
      'react-dom': { createPortal: element => element },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
}
sandbox.exports = sandbox.module.exports
runInNewContext(outputFiles[0].text, sandbox)
const { ContextMenu, header } = sandbox.module.exports
const { SessionUnreadToggle, unreadEntryId } = header

const renderNode = (node) => {
  if (Array.isArray(node)) return node.map(renderNode)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(renderNode) }
}
const draw = (element) => {
  pass = { index: 0, values: [] }
  try { return renderNode(element()) } finally { pass = null }
}

const textOf = node => (node?.children ?? []).flat(Infinity).filter(child => typeof child === 'string').join('')
const menuItems = (node, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (node.props?.role === 'menuitem') found.push({ label: textOf(node), onClick: node.props.onClick })
  for (const child of node.children ?? []) menuItems(child, found)
  return found
}

const bots = [
  { id: 'chief', name: 'Chief', sessionId: 'chief', parts: ['chief'] },
  { id: 'writer', name: 'Writer', sessionId: 'writer', parts: ['writer'] },
  { id: 'friend', name: 'Friend', sessionId: 'friend', parts: ['friend'], remote: true },
]
const rooms = [{ id: 'room', name: 'Launch', members: ['chief', 'writer'] }]
const agents = [{ id: 'agent1', name: 'DSH Agent', sessions: ['agent-session'] }]
const rosterOf = (extra = {}) => indexRoster({ bots, rooms, agents, mainBotId: 'chief', mainBotIds: ['chief'], ...extra })
const WRITER = { kind: 'bot', id: 'writer', x: 10, y: 10 }

// Only the two local unread actions may be called, so any other entry in `calls` fails the check.
const localCalls = () => {
  const calls = []
  const actions = {
    closeMenu: () => {}, reportError: () => {}, openSession: id => calls.push({ action: 'openSession', id }),
    markUnread: id => calls.push({ action: 'markUnread', id }),
    clearUnread: id => calls.push({ action: 'clearUnread', id }),
    openSettings: () => calls.push({ action: 'openSettings' }), setFlags: () => calls.push({ action: 'setFlags' }),
    renameBot: () => calls.push({ action: 'renameBot' }), duplicateBot: async () => { calls.push({ action: 'duplicateBot' }); return { id: 'copy' } },
    setMain: () => calls.push({ action: 'setMain' }), deleteBot: () => calls.push({ action: 'deleteBot' }),
    deleteRoom: () => calls.push({ action: 'deleteRoom' }),
  }
  return { calls, actions }
}

// The pin toggle is left out of the message so the line names the entries this cut reads.
const written = labels => labels.filter(label => label !== 'Pin' && label !== 'Unpin')

test('#3114: a marked chat offers Clear unread mark in its row menu, and that clears only the local mark', () => {
  const { calls, actions } = localCalls()
  const marked = menuItems(draw(() => ContextMenu({ menu: WRITER, roster: rosterOf(), actions, unread: { writer: true } })))
  assert.ok(
    marked.some(item => item.label === 'Clear unread mark'),
    `a marked bot (writer) offers no Clear unread mark: ${written(marked.map(item => item.label)).join(', ')}`,
  )
  assert.ok(!marked.some(item => item.label === 'Mark as Unread'), 'a marked bot still offers Mark as Unread')
  marked.find(item => item.label === 'Clear unread mark').onClick()
  assert.deepEqual(calls, [{ action: 'clearUnread', id: 'writer' }], 'clearing the row mark wrote something else')
  assert.ok(!calls.some(call => call.action === 'openSession'), 'clearing the row mark opened the chat')

  const plainCalls = localCalls()
  const plain = menuItems(draw(() => ContextMenu({ menu: WRITER, roster: rosterOf(), actions: plainCalls.actions, unread: {} })))
  assert.ok(plain.some(item => item.label === 'Mark as Unread'), 'an unmarked bot lost Mark as Unread')
  plain.find(item => item.label === 'Mark as Unread').onClick()
  assert.deepEqual(plainCalls.calls, [{ action: 'markUnread', id: 'writer' }], 'marking the row wrote something else')
})

test('#3114: the chat header marks and clears the chat without opening it', () => {
  assert.equal(typeof SessionUnreadToggle, 'function', 'the conversation header draws no unread control')
  const roster = rosterOf()
  // The header holds the Session id; the mark lives under the sidebar's row id.
  assert.equal(unreadEntryId(roster, 'writer'), 'writer', 'a Bot Session maps to its Bot id')
  assert.equal(unreadEntryId(roster, 'room'), 'room', 'a group Session maps to its room id')
  assert.equal(unreadEntryId(roster, 'agent-session'), 'agent1', 'an Agent Session maps to its Agent id')
  assert.equal(unreadEntryId(roster, 'elsewhere'), 'elsewhere', 'an unknown id is left alone')

  const state = localCalls()
  const buttonOf = (sessionId, unread) => {
    const find = (node) => {
      if (node === null || typeof node !== 'object') return null
      if (node.type === 'button') return node
      for (const child of node.children ?? []) { const hit = find(child); if (hit) return hit }
      return null
    }
    return find(draw(() => h(SessionUnreadToggle, { sessionId, roster, unread, actions: state.actions })))
  }

  const unmarked = buttonOf('writer', {})
  assert.equal(unmarked.props['aria-label'], 'Mark as Unread', 'an unmarked chat offers no way to mark it')
  assert.equal(unmarked.props['aria-pressed'], false, 'an unmarked chat claims to be marked')
  unmarked.props.onClick()
  assert.deepEqual(state.calls, [{ action: 'markUnread', id: 'writer' }], 'the header marked something else')

  state.calls.length = 0
  const marked = buttonOf('writer', { writer: true })
  assert.equal(marked.props['aria-label'], 'Clear unread mark', 'a marked chat offers no way to clear the mark')
  assert.equal(marked.props['aria-pressed'], true, 'a marked chat does not say it is marked')
  marked.props.onClick()
  assert.deepEqual(state.calls, [{ action: 'clearUnread', id: 'writer' }], 'the header cleared something else')

  state.calls.length = 0
  buttonOf('room', { room: true }).props.onClick()
  buttonOf('agent-session', { agent1: true }).props.onClick()
  assert.deepEqual(state.calls, [{ action: 'clearUnread', id: 'room' }, { action: 'clearUnread', id: 'agent1' }], 'the header cleared the wrong row')
  assert.ok(!state.calls.some(call => call.action === 'openSession'), 'the header opened the chat it marked')
})

test('#3114: the unread entry stays a local control in a read-only window and never writes through the host', () => {
  const locked = rosterOf({ readOnly: 'This window holds the team read-only.' })
  const { calls, actions } = localCalls()
  const items = menuItems(draw(() => ContextMenu({ menu: WRITER, roster: locked, actions, unread: {} })))
  assert.ok(items.some(item => item.label === 'Mark as Unread'), 'a read-only window dropped the local unread control')
  items.find(item => item.label === 'Mark as Unread').onClick()
  assert.deepEqual(calls, [{ action: 'markUnread', id: 'writer' }], 'a read-only window did not mark locally')
  assert.ok(!calls.some(call => call.action !== 'markUnread'), 'a read-only window wrote through the host')
})

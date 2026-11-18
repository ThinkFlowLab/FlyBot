// The sidebar session filter only offers kinds the list already has: all, group
// chats, direct chats, and unread (from the same marks the rows already draw).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'\nexport { DICTIONARY, installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let slots = []
let index = 0
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => fn,
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect() {},
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, innerHeight: 800, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setImmediate, queueMicrotask,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  Date, JSON, Promise, Symbol, Map, Set,
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, body: {}, querySelector: () => null },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  __flybot__: { slots: { entries: () => [], subscribe: () => () => {}, version: () => 0 }, call: () => {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { TeamSidebar, DICTIONARY, installLocale } = module.exports

const chief = { id: 'chief', name: 'Chief' }
const writer = { id: 'writer', name: 'Writer' }
const room = { id: 'room-1', name: 'Review room', origin: 'group' }
const statuses = new Map([
  ['writer', { completionUnread: true }],
])
const roster = {
  ready: true, bots: [chief, writer], rooms: [room], agents: [],
  byId: { chief, writer }, roomsById: { 'room-1': room }, mainBotId: 'chief',
}
const OPAQUE = new Set(['BotRow', 'RoomRow', 'AgentRow', 'InboxRow', 'KanbanRow', 'ProjectsNav', 'FlyBotSections', 'TreeNode', 'UpdateButton', 'BrandMark', 'BrandName'])
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function' && !OPAQUE.has(node.type.name)) return expand(node.type(node.props ?? {}))
  const props = node.props ?? {}
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const all = (node, out = []) => {
  if (node == null) return out
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  all(node.props?.children, out)
  return out
}
const ownText = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const hasClass = (node, name) => String(node.props?.className ?? '').split(/\s+/).includes(name)

const mount = () => {
  slots = []
  const draw = () => {
    index = 0
    return all(expand(TeamSidebar({
      wide: true,
      useRoster: select => select(roster),
      useUi: select => select({ unread: {} }),
      useSessions: select => select({ ids: ['chief', 'writer', 'room-1'], byId: { chief: { updatedAt: 3 }, writer: { updatedAt: 2 }, 'room-1': { updatedAt: 1 } } }),
      useRegistry: () => {},
      useUpdate: select => select({}),
      useWork: select => select({}),
      useSessionStatus: select => select(statuses),
      useSessionRetainInfo: select => select({}),
      useActivity: select => select({}),
      actions: {
        openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {},
        landOnMainBot() {}, clearUnread() {}, isAgentSession: () => false,
      },
    })))
  }
  return draw
}

test('the wide sidebar offers All, Group chats, Direct chats, and Unread, and no Read chip', () => {
  const nodes = mount()()
  const bar = nodes.find(node => hasClass(node, 'bt-session-filter'))
  assert.ok(bar, 'the session filter is drawn above the list')
  const chips = nodes.filter(node => hasClass(node, 'bt-session-filter-btn'))
  assert.deepEqual(chips.map(ownText), ['All', 'Group chats', 'Direct chats', 'Unread'])
  assert.equal(chips.find(node => ownText(node) === 'All').props['aria-checked'], true)
  assert.equal(nodes.some(node => ownText(node) === 'Read' && hasClass(node, 'bt-session-filter-btn')), false)
  const kinds = nodes.filter(node => typeof node.type === 'function').map(node => node.type.name)
  assert.ok(kinds.includes('BotRow'))
  assert.ok(kinds.includes('RoomRow'))
})

test('Group chats keeps rooms, Direct chats keeps Bots, Unread keeps only marked rows', () => {
  const draw = mount()
  let nodes = draw()
  const press = label => {
    const chip = nodes.find(node => hasClass(node, 'bt-session-filter-btn') && ownText(node) === label)
    assert.ok(chip, label)
    chip.props.onClick()
    nodes = draw()
  }
  const names = (kind) => nodes.filter(node => node.type?.name === kind).map(node => (node.props.bot ?? node.props.room)?.name)
  press('Group chats')
  assert.deepEqual(names('RoomRow'), ['Review room'])
  assert.deepEqual(names('BotRow'), [])
  press('Direct chats')
  assert.deepEqual(names('RoomRow'), [])
  assert.ok(names('BotRow').includes('Chief'))
  assert.ok(names('BotRow').includes('Writer'))
  press('Unread')
  assert.deepEqual(names('BotRow'), ['Writer'])
  assert.deepEqual(names('RoomRow'), [])
  press('All')
  assert.ok(names('BotRow').includes('Chief'))
  assert.ok(names('RoomRow').includes('Review room'))
})

test('the narrow rail does not draw session filter chips', () => {
  slots = []
  index = 0
  const tree = TeamSidebar({
    wide: false,
    useRoster: select => select(roster),
    useUi: select => select({ unread: {} }),
    useSessions: select => select({ ids: [], byId: {} }),
    useRegistry: () => {},
    useUpdate: select => select({}),
    useWork: select => select({}),
    useSessionStatus: select => select(statuses),
    useSessionRetainInfo: select => select({}),
    useActivity: select => select({}),
    actions: {
      openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {},
      landOnMainBot() {}, clearUnread() {}, isAgentSession: () => false,
    },
  })
  const nodes = all(expand(tree))
  assert.equal(nodes.some(node => hasClass(node, 'bt-session-filter')), false)
})

// A filter can hide every row. The list then says why it is empty rather than reading as a blank
// panel, and the sentence follows the interface language (#3114).
test('a filter that hides every row says why the list is empty', () => {
  // Rooms and nothing unread: Unread leaves no row at all.
  const quiet = {
    ready: true, bots: [chief], rooms: [room], agents: [],
    byId: { chief }, roomsById: { 'room-1': room }, mainBotId: 'chief',
  }
  const off = installLocale({
    register: () => () => {},
    bind: () => key => DICTIONARY.zh[key] ?? key,
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    slots = []
    const draw = () => {
      index = 0
      return all(expand(TeamSidebar({
        wide: true,
        useRoster: select => select(quiet),
        useUi: select => select({ unread: {} }),
        useSessions: select => select({ ids: ['chief', 'room-1'], byId: { chief: { updatedAt: 2 }, 'room-1': { updatedAt: 1 } } }),
        useRegistry: () => {},
        useUpdate: select => select({}),
        useWork: select => select({}),
        useSessionStatus: select => select(new Map()),
        useSessionRetainInfo: select => select({}),
        useActivity: select => select({}),
        actions: {
          openInbox() {}, openBoard() {}, openPalette() {}, openNewChat() {},
          landOnMainBot() {}, clearUnread() {}, isAgentSession: () => false,
        },
      })))
    }
    const rows = nodes => nodes.filter(node => ['BotRow', 'RoomRow'].includes(node.type?.name)).map(node => node.type.name)
    let nodes = draw()
    assert.deepEqual(rows(nodes), ['BotRow', 'RoomRow'], 'All draws the Main Bot and the room')
    assert.equal(nodes.some(node => hasClass(node, 'bt-session-filter-empty')), false)
    const unread = nodes.find(node => hasClass(node, 'bt-session-filter-btn') && node.props['data-filter'] === 'unread')
    assert.ok(unread, 'the Unread chip is drawn')
    assert.equal(ownText(unread), '未读')
    unread.props.onClick()
    nodes = draw()
    assert.deepEqual(rows(nodes), [], 'Unread hides every row there is')
    const empty = nodes.find(node => hasClass(node, 'bt-session-filter-empty'))
    assert.ok(empty, 'the empty list says why it is empty')
    assert.equal(ownText(empty), '没有未读会话')
  } finally {
    off()
  }
})

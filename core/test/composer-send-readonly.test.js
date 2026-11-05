// P-571: a read-only window's composer still wrote. `sendMessage` sent `send` for one pick and
// `create-room` + `send` for several, and `openBot` sent the typed line when a picker row was
// pressed — every shape reached a host that can only answer `bot/read-only` after the fact. A
// locked window now draws the host's own sentence beside the composer instead of a live Send, no
// press writes, and a writable window sends exactly as before. The New… menu is the same shape one
// step earlier (P-571b): `Add coding agent` asked a host that answers `bot/read-only`, so a locked
// menu does not draw it and a writable one keeps it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { NewChat } from './src/client/new-chat.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render: what the composer draws and what a press sends have to
// come out of the component's own tree, not a re-implementation of it.
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
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn },
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, innerHeight: 800, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, setImmediate, queueMicrotask,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, body: {}, querySelector: () => null },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { NewChat } = module.exports

const chief = { id: 'chief', name: 'Chief', remote: false }
const scout = { id: 'scout', name: 'Scout', remote: false }
const third = { id: 'third', name: 'Third', remote: false }
const base = {
  bots: [chief, scout, third], byId: { chief, scout, third }, rooms: [], roomsById: {}, agents: [],
  prefs: {}, mainBotIds: ['chief'], connectors: [], memory: false, exchangeTurns: {}, questions: {},
}
const SENTENCE = 'Another FlyBot window has this Bot team open, so this window is read-only.'
const rosterWith = readOnly => (readOnly === undefined ? { ...base } : { ...base, readOnly })
const actionsOf = () => {
  const calls = []
  return {
    calls,
    actions: {
      createRoom: async (members, options) => { calls.push(['create-room', members, options]); return { id: 'r-new', name: 'New group' } },
      send: async (id, text) => { calls.push(['send', id, text]) },
      openSession: id => { calls.push(['open-session', id]) }, closeOverlay() {}, notify() {},
      setFlags: async (id, flags) => { calls.push(['set-flags', id, flags]) },
      newChatActionRows() {}, addAgent: async () => { calls.push(['add-agent']) }, createBot: async () => ({ id: 'new' }),
      openSettings() {}, openPalette() {},
    },
  }
}
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
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
const flush = () => new Promise(resolve => setImmediate(resolve))

// Each mount starts from empty slots so a pane never reads another mount's state.
const mount = (props) => {
  slots = []
  const draw = () => {
    index = 0
    return all(expand(NewChat(props)))
  }
  return { draw }
}
const press = (nodes, predicate) => {
  const node = nodes.find(predicate)
  assert.ok(node, 'the control under test is drawn')
  node.props.onClick?.()
  return node
}
const optionRow = name => node => node.props?.role === 'option' && ownText(node).includes(name)
const textarea = nodes => nodes.find(node => node.type === 'textarea')
const typeLine = (nodes, text) => {
  const field = textarea(nodes)
  assert.ok(field, 'the composer is drawn')
  field.props.onChange({ target: { value: text } })
}
const sendButton = nodes => nodes.find(node => hasClass(node, 'bt-nc-send'))
const readOnlyLine = nodes => nodes.filter(node => hasClass(node, 'bt-read-only'))
const enterInComposer = (nodes) => {
  const field = textarea(nodes)
  assert.ok(field, 'the composer is drawn')
  field.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} })
}
// New… → New group chat picks its admin first, then the other Bots; the admin token's own × puts
// the admin back to none, which is the shape whose Send reaches `sendMessage`: one pick sends to
// that Bot, several make the room without an admin.
const groupCompose = (roster) => {
  const { calls, actions } = actionsOf()
  const pane = mount({ mode: 'group', roster, actions })
  const pick = async (name) => {
    const nodes = pane.draw()
    press(nodes, optionRow(name))
    await flush()
  }
  const dropAdmin = async () => {
    const nodes = pane.draw()
    const token = nodes.find(node => node.props?.['aria-label'] === 'Remove Chief')
    assert.ok(token, 'the admin token is drawn with its own remove control')
    token.props.onClick()
    await flush()
  }
  const send = async ({ enter = false } = {}) => {
    const nodes = pane.draw()
    typeLine(nodes, 'hello there')
    await flush()
    const drawn = pane.draw()
    if (enter) enterInComposer(drawn)
    else {
      const button = sendButton(drawn)
      if (button && !button.props.disabled) button.props.onClick()
    }
    await flush()
    return { nodes: pane.draw(), send: sendButton(pane.draw()) }
  }
  return { calls, pane, pick, dropAdmin, send }
}
const groupSend = async (roster, picks, { enter = false } = {}) => {
  const view = groupCompose(roster)
  await view.pick('Chief')
  for (const name of picks) await view.pick(name)
  await view.dropAdmin()
  const sent = await view.send({ enter })
  return { calls: view.calls, ...sent }
}
// The New… menu itself: a short action list, no To: row and no composer.
const menuPane = (roster) => {
  const { calls, actions } = actionsOf()
  const pane = mount({ mode: 'new', roster, actions })
  return { calls, nodes: () => pane.draw() }
}
// A picker row pressed with a line typed is the other send path (`openBot`, a search pane).
const searchThenOpen = async (roster, name) => {
  const { calls, actions } = actionsOf()
  const pane = mount({ mode: 'search', roster, actions })
  let nodes = pane.draw()
  typeLine(nodes, 'hello there')
  await flush()
  nodes = pane.draw()
  press(nodes, optionRow(name))
  await flush()
  return { calls, nodes }
}

test('a read-only window sends nothing when one Bot is picked and Send is pressed', async () => {
  const locked = await groupSend(rosterWith(SENTENCE), ['Scout'])
  assert.deepEqual(locked.calls, [], 'no write action reaches the host')
  assert.equal(locked.send, undefined, 'no live Send control is drawn')
  const line = readOnlyLine(locked.nodes)
  assert.equal(line.length, 1, 'the composer says why it cannot send')
  assert.equal(ownText(line[0]).trim(), SENTENCE, "the host's own sentence is shown")
  assert.equal(line[0].props.role, 'status')
})

test('a read-only window creates no room when several Bots are picked and Enter is pressed', async () => {
  const locked = await groupSend(rosterWith(SENTENCE), ['Scout', 'Third'], { enter: true })
  assert.deepEqual(locked.calls, [], 'no create-room and no send')
  assert.equal(readOnlyLine(locked.nodes).length, 1, 'the read-only sentence is shown once')
})

test('a read-only window sends nothing when a picker row is pressed with a line typed', async () => {
  const locked = await searchThenOpen(rosterWith(SENTENCE), 'Chief')
  const writes = locked.calls.filter(call => call[0] !== 'open-session')
  assert.deepEqual(writes, [], 'the picker row writes nothing')
  assert.ok(locked.calls.some(call => call[0] === 'open-session' && call[1] === 'chief'), 'opening the session may stay')
})

// A read-only group chat whose admin is still chosen keeps its Create slot as the host's sentence
// on the To: line; the composer below must not draw a second live Send for it.
test('a read-only window draws no Send for a group that still has its admin chosen', async () => {
  const view = groupCompose(rosterWith(SENTENCE))
  await view.pick('Chief')
  await view.pick('Scout')
  let nodes = view.pane.draw()
  typeLine(nodes, 'hello there')
  await flush()
  nodes = view.pane.draw()
  assert.equal(sendButton(nodes), undefined, 'the composer draws no live Send control')
  enterInComposer(nodes)
  await flush()
  nodes = view.pane.draw()
  assert.deepEqual(view.calls, [], 'Enter writes nothing')
  const line = readOnlyLine(nodes)
  assert.equal(line.length, 1, "the host's own sentence is shown exactly once")
  assert.equal(ownText(line[0]).trim(), SENTENCE)
})

test('a writable window still sends once from the composer', async () => {
  for (const roster of [rosterWith(undefined), rosterWith(''), rosterWith('   ')]) {
    const open = await groupSend(roster, ['Scout'])
    assert.equal(open.send?.props?.disabled, false, 'Send is drawn and enabled')
    assert.deepEqual(open.calls, [['send', 'scout', 'hello there'], ['open-session', 'scout']], 'one Send reaches the host')
    assert.equal(readOnlyLine(open.nodes).length, 0, 'no read-only line in a writable window')

    const many = await groupSend(roster, ['Scout', 'Third'], { enter: true })
    assert.equal(many.calls[0][0], 'create-room', 'several picks make the room')
    assert.deepEqual(many.calls[1], ['send', 'r-new', 'hello there'], 'then send the line')
    assert.deepEqual(many.calls[2], ['open-session', 'r-new'], 'then open the new room')
  }
})

// P-571b: the Add coding agent row is an ask the host answers `bot/read-only`, so a locked window
// must not offer it at all; a writable one keeps the row and it still posts.
test('a read-only New… menu draws no Add coding agent row', async () => {
  const menu = menuPane(rosterWith(SENTENCE))
  const nodes = menu.nodes()
  assert.ok(nodes.some(optionRow('New group chat')), 'the menu itself is drawn')
  assert.equal(nodes.some(optionRow('Add coding agent')), false, 'no Add coding agent row in a read-only window')
  assert.deepEqual(menu.calls, [], 'drawing the menu writes nothing')
})

test('a writable New… menu keeps Add coding agent and asks once when it is pressed', async () => {
  const menu = menuPane(rosterWith(undefined))
  const nodes = menu.nodes()
  press(nodes, optionRow('Add coding agent'))
  await flush()
  assert.deepEqual(menu.calls, [['add-agent']], 'one press asks add-agent exactly once')
})

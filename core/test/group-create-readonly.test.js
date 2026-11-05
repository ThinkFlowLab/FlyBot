// P-570: a read-only window still offered group creation. Settings → Group chats drew its
// `Create group chat` entry (settings.js GroupsPage), which opens NewGroupForm; New… → New group
// chat opened NewChat in group mode. Both forms drew a live `Create group chat` control whose
// press sent `create-room` to a host that can only answer `bot/read-only`: the control was drawn,
// clickable, and answered an error. A locked window now draws the host's own sentence in place of
// the control and no press reaches the host; a writable window keeps today's control and write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { NewGroupForm } from './src/client/group-settings.js'\nexport { NewChat } from './src/client/new-chat.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A hook runtime that survives a re-render: the lock line and the missing control have to come out
// of the component's own tree, not a re-implementation of it.
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
const { NewGroupForm, NewChat } = module.exports

const chief = { id: 'chief', name: 'Chief', remote: false }
const scout = { id: 'scout', name: 'Scout', remote: false }
const base = {
  bots: [chief, scout], byId: { chief, scout }, rooms: [], roomsById: {}, agents: [],
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
      openSession() {}, closeOverlay() {}, notify() {}, setFlags: async () => {},
      newChatActionRows() {}, addAgent: async () => {}, createBot: async () => ({ id: 'new' }),
      openSettings() {}, openPalette() {},
    },
  }
}
const run = promise => Promise.resolve(promise).then(() => true).catch(() => false)
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

// The component functions are called straight, so a press re-draws the same tree with the slots
// the setters changed (the same runtime the details-drawer read-only tests use). Each mount starts
// from empty slots: a NewChat drawn over NewGroupForm's slots would read the other component's state.
const mount = (component, props) => {
  slots = []
  const draw = () => {
    index = 0
    return all(expand(component(props)))
  }
  return { draw, props }
}
const press = (nodes, predicate) => {
  const node = nodes.find(predicate)
  assert.ok(node, 'the control under test is drawn')
  node.props.onClick?.()
  return node
}
const chips = nodes => nodes.filter(node => hasClass(node, 'bt-ng-chip'))
const groupCreate = nodes => nodes.filter(node => hasClass(node, 'bt-send') && ownText(node).trim() === 'Create group chat')
const readOnlyLine = nodes => nodes.filter(node => hasClass(node, 'bt-read-only'))

// Settings → Group chats → Create group chat → NewGroupForm: pick an admin and one member, then
// press Create. A locked window must not send create-room.
const settingsGroup = async (roster) => {
  const { calls, actions } = actionsOf()
  const form = mount(NewGroupForm, { roster, actions, run, onCreated() {}, onCancel() {} })
  let nodes = form.draw()
  const adminChip = chips(nodes).find(node => node.props.role === 'radio' && ownText(node).includes('Chief'))
  press(nodes, node => node === adminChip)
  await flush()
  nodes = form.draw()
  const memberChip = chips(nodes).find(node => node.props.role === 'checkbox' && ownText(node).includes('Scout'))
  press(nodes, node => node === memberChip)
  await flush()
  nodes = form.draw()
  const create = groupCreate(nodes)[0]
  if (create && !create.props.disabled) create.props.onClick()
  await flush()
  return { calls, nodes, create }
}

// New… → New group chat → NewChat in group mode: choose the admin, then one more Bot, then press
// Create group chat. A locked window must not send create-room.
const newChatGroup = async (roster) => {
  const { calls, actions } = actionsOf()
  const pane = mount(NewChat, { mode: 'group', roster, actions })
  let nodes = pane.draw()
  press(nodes, node => node.props?.role === 'option' && ownText(node).includes('Chief'))
  await flush()
  nodes = pane.draw()
  press(nodes, node => node.props?.role === 'option' && ownText(node).includes('Scout'))
  await flush()
  nodes = pane.draw()
  const create = groupCreate(nodes)[0]
  if (create && !create.props.disabled) create.props.onClick()
  await flush()
  return { calls, nodes, create }
}

test('a read-only window draws no group-create control on the Settings form and sends nothing', async () => {
  const locked = await settingsGroup(rosterWith(SENTENCE))
  assert.equal(locked.calls.length, 0, 'no write action reaches the host')
  assert.equal(locked.create, undefined, 'no Create group chat control is drawn')
  const line = readOnlyLine(locked.nodes)
  assert.equal(line.length, 1, 'the form says why it cannot create')
  assert.equal(ownText(line[0]).trim(), SENTENCE, "the host's own sentence is shown")
  assert.equal(line[0].props.role, 'status')
})

test('a read-only window draws no group-create control on the New… form and sends nothing', async () => {
  const locked = await newChatGroup(rosterWith(SENTENCE))
  assert.equal(locked.calls.length, 0, 'no write action reaches the host')
  assert.equal(locked.create, undefined, 'no Create group chat control is drawn')
  const line = readOnlyLine(locked.nodes)
  assert.equal(line.length, 1, 'the New… pane says why it cannot create')
  assert.equal(ownText(line[0]).trim(), SENTENCE, "the host's own sentence is shown")
})

test('a writable window keeps both group-create controls and still writes', async () => {
  for (const roster of [rosterWith(undefined), rosterWith(''), rosterWith('   ')]) {
    const settings = await settingsGroup(roster)
    assert.equal(settings.create?.props?.disabled, false, 'Settings Create group chat is drawn and enabled')
    await flush()
    assert.equal(settings.calls.length, 1, 'Settings Create group chat reaches the host')
    assert.equal(settings.calls[0][0], 'create-room')
    assert.equal(readOnlyLine(settings.nodes).length, 0, 'no read-only line in a writable window')

    const pane = await newChatGroup(roster)
    assert.equal(pane.create?.props?.disabled, false, 'New… Create group chat is drawn and enabled')
    await flush()
    assert.equal(pane.calls.length, 1, 'New… Create group chat reaches the host')
    assert.equal(pane.calls[0][0], 'create-room')
    assert.equal(readOnlyLine(pane.nodes).length, 0, 'no read-only line in a writable window')
  }
})

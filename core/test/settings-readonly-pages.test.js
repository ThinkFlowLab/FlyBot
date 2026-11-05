// #2474: in a window that holds the team read-only the host refuses every write with
// `bot/read-only`, but seven Settings pages still drew their controls: General's theme
// select and switches, the Bots page's Main Bot and animation controls, and the live forms
// of a Bot, a group chat, Connectors, Capabilities and Secrets. Each page now reads the
// roster's own read-only sentence through `lockedWindow` and draws a plain-text view
// instead: no control anywhere, and the facts of the page kept as text. A writable window
// is untouched, and the standing sentence stays in the dialog header — once per page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { InlineText, SwitchRow } from './src/client/bot-settings.js'",
      "export { Segmented } from './src/client/motion.js'",
      "export { ModelMenu } from './src/client/model-menu.js'",
      "export { FolderMenu } from './src/client/folder-menu.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let slots = []
let index = 0
let effects = []
// React counts a component's hooks on every render and refuses a count that changed under the
// same instance: one more hook throws during that render, one fewer after it. Keep both rules
// and React's own messages, so a roster that flips under a mounted page fails here the way
// React 18.3.1 fails it (#2474).
let previousHookCount = null
const hook = () => {
  const at = index++
  if (previousHookCount !== null && at >= previousHookCount) throw new Error('Rendered more hooks than during the previous render.')
  return at
}
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = hook(); if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = hook()
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = hook(); if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = hook(); if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = hook(); if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useLayoutEffect: () => { hook() },
  useId: () => { hook(); return 'id' },
  useSyncExternalStore: (_subscribe, get) => { hook(); return get() },
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
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
const { SettingsDialog, InlineText, SwitchRow, Segmented, ModelMenu, FolderMenu } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'

const chief = { id: 'chief', name: 'Chief', role: 'Researcher', model: 'mock/m1', workDir: '/work/chief', instructions: 'Run the team.', pinned: true }
const writer = { id: 'writer', name: 'Writer', role: 'Editor', model: 'mock/m1', workDir: null, instructions: 'Write the copy.' }
const editor = { id: 'editor', name: 'Editor', role: '', model: 'mock/m1', workDir: null, instructions: '' }
const room = { id: 'r1', name: 'Ops', admin: 'chief', members: ['chief', 'writer'], mode: 'admin', notice: 'Read this first.', named: true, workDir: '/work/ops', participants: [{ kind: 'human', id: 'owner-1', displayName: 'Alice', role: 'admin' }] }
const github = { id: 'github', name: 'GitHub', kind: 'tool', state: 'ready', account: 'xuke' }
const browser = { name: 'browser', kind: 'mcp', transport: 'stdio', description: 'Open pages' }
const token = { name: 'GITHUB_TOKEN', purpose: 'Push branches', scope: 'all', createdAt: 0 }
const baseRoster = {
  bots: [chief, writer, editor],
  byId: { chief, writer, editor },
  rooms: [room],
  roomsById: { r1: room },
  mainBotIds: ['chief', 'writer'],
  mainBotId: 'chief',
  prefs: { theme: 'deepseek', motion: 'quiet', notifications: true },
  models: [{ id: 'm1', name: 'Mock One', served: true }],
  connectors: [github],
  capabilities: [browser],
  secrets: [token],
  humans: [],
  remoteBots: [],
  memory: true,
}
const lockedRoster = { ...baseRoster, readOnly: SENTENCE }

// #2492: the same two windows, but a face-to-face room. Two people, one Bot each: my own Chief
// (Ann) and a friend's Writer (Bob). The page's own header already counts both Bots, so the
// members card has to name them too, and the room's two facts are the writable page's.
const faceRoom = {
  id: 'face', name: 'Face-to-face · Ann, Bob · 482913', origin: 'face-to-face', named: false,
  members: [], mode: 'everyone', workDir: '/work/face', notice: '',
  participants: [
    { kind: 'bot', id: 'chief', handle: '@chief.ann.home', ownerName: 'Ann', ownerHome: 'ann.home' },
    { kind: 'bot', id: 'writer-bob', remote: true, handle: '@writer.bob.home', ownerName: 'Bob', ownerHome: 'bob.home', displayName: 'Writer' },
  ],
}
const faceRoster = { ...baseRoster, rooms: [faceRoom], roomsById: { face: faceRoom } }
const faceLocked = { ...faceRoster, readOnly: SENTENCE }

// Every action that asks the host to change something. A locked page may draw an entry that
// navigates (New Bot, a Bot's row, Open board); it may not draw one that lands here.
const MUTATING = ['updateBot', 'deleteBot', 'createBot', 'duplicateBot', 'setMain', 'setPrefs', 'setFlags', 'openMemory', 'refreshModels',
  'updateRoom', 'deleteRoom', 'createRoom', 'saveCapability', 'deleteCapability', 'approveCapability', 'setBotCapability',
  'connectorConnect', 'connectorDisconnect', 'connectorRetry', 'connectorSend', 'connectorAllow', 'connectorBlock', 'connectorApps',
  'secretSet', 'secretUpdate', 'secretDelete', 'secretCancel', 'secretAllow', 'scheduleCreate', 'scheduleUpdate', 'scheduleDelete']
const makeActions = (calls) => new Proxy({ openSettings() {}, closeSettings() {}, openSession() {}, notify() {}, showDetails() {} }, {
  get: (target, name) => (MUTATING.includes(name)
    ? () => { calls.push(String(name)) }
    : target[name]),
})

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}

// The widgets that render a control inside themselves: drawn is enough, they never run here.
const WIDGETS = new Set([InlineText, SwitchRow, Segmented, ModelMenu, FolderMenu])
const nameOf = (node) => (typeof node.type === 'string' ? node.type : node.type?.name)
const WRITE_WIDGET_NAMES = new Set(['ConnectorRow', 'SecretRow', 'CapabilityRow', 'CapabilityForm', 'ScopeEditor', 'ValueEditor',
  'AddSecret', 'StandingApprovalsCard', 'BotCapabilitiesCard', 'BotConnectorsCard', 'BotSchedules', 'FlyBotDetails',
  'FlyBotRoomMembers', 'NewGroupForm', 'AllowedSenders'])

const isWidget = (node) => WIDGETS.has(node.type) || WRITE_WIDGET_NAMES.has(nameOf(node))

// A page is drawn by the dialog one level down, so mounting it means calling it with the
// props the dialog handed it; child components are called too, one at a time, because the
// controls a locked window must not draw sit inside them.
const expand = (node, out = [], depth = 0, deep = false) => {
  if (Array.isArray(node)) { for (const item of node) expand(item, out, depth, deep); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 8) {
    if (isWidget(node) && !deep) { out.push(node); expand(node.props?.children, out, depth + 1, deep); return out }
    const saved = slots
    const savedIndex = index
    const savedCount = previousHookCount
    slots = []
    index = 0
    previousHookCount = null
    let rendered
    try { rendered = node.type({ ...node.props }) } catch { out.push(node); return out } finally { slots = saved; index = savedIndex; previousHookCount = savedCount }
    return expand(rendered, out, depth + 1, deep)
  }
  out.push(node)
  expand(node.props?.children, out, depth, deep)
  return out
}

const mount = (roster, key, id, name, calls = []) => {
  const actions = makeActions(calls)
  slots = []
  effects = []
  index = 0
  previousHookCount = null
  const tree = SettingsDialog({ page: key, id, roster, actions, useUpdate: () => ({}) })
  const node = all(tree).find(entry => typeof entry.type === 'function' && entry.type.name === name)
  assert.ok(node, `the dialog draws ${name}`)
  slots = []
  effects = []
  index = 0
  previousHookCount = null
  const nodes = expand(node.type(node.props))
  return { tree, nodes, actions, calls }
}

// A control is a field, a switch, or a widget that draws one.
const isControl = (node) => ['select', 'input', 'textarea'].includes(nameOf(node))
  || node.props?.role === 'switch'
  || isWidget(node)

// A face-room Bot name is a `button` only when its row got an `onOpenBot`; a locked page must
// draw none of those, and nothing else a reader could press either — a link, a field, or a
// span carrying a handler (#2492).
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea'])
const isInteractive = (node) => INTERACTIVE.has(nameOf(node)) || typeof node.props?.onClick === 'function'

const PAGES = [
  { key: 'general', id: null, name: 'GeneralPage', facts: ['DeepSeek', 'On'] },
  { key: 'bots', id: null, name: 'BotsPage', facts: ['Main Bot', 'Chief', 'Writer', 'Bot animation', 'Quiet'] },
  { key: 'bots', id: 'chief', name: 'BotSettingsForm', facts: ['Chief', 'Researcher', 'Run the team.'] },
  { key: 'groups', id: 'r1', name: 'GroupSettingsForm', facts: ['Ops', 'Chief', 'Writer', 'Alice', 'Read this first.'] },
  { key: 'connectors', id: null, name: 'ConnectorsPage', facts: ['GitHub', 'xuke'] },
  { key: 'capabilities', id: null, name: 'CapabilitiesPage', facts: ['browser', 'Open pages'] },
  { key: 'secrets', id: null, name: 'SecretsPage', facts: ['GITHUB_TOKEN', 'Push branches'] },
]

// Pressing what a locked page draws may navigate; it may not write.
const pressure = (nodes) => nodes.filter(node => nameOf(node) === 'button')

test('a read-only window draws no write control on any of the seven Settings pages (#2474)', () => {
  const controls = []
  const writes = []
  const missing = []
  for (const page of PAGES) {
    const { nodes, calls } = mount(lockedRoster, page.key, page.id, page.name)
    for (const control of nodes.filter(isControl)) controls.push(`${page.name}: ${nameOf(control)}`)
    for (const button of pressure(nodes)) { try { button.props.onClick?.() } catch { /* the press is the point, not its answer */ } }
    for (const call of calls) writes.push(`${page.name}: ${call}`)
    const facts = text(nodes)
    for (const fact of page.facts) if (!facts.includes(fact)) missing.push(`${page.name}: "${fact}"`)
  }
  assert.deepEqual(controls, [], 'a read-only window draws no control')
  assert.deepEqual(writes, [], 'no control a read-only window draws reaches a write')
  assert.deepEqual(missing, [], 'each page keeps its facts as text')
})

test('a read-only Bots page draws no Main Bot or animation control, and sends neither write (#2474)', () => {
  // Product's probe on P-571 saw both defects from outside its own copy: both windows drew
  // the same controls, and a press in the locked one still sent set-main and set-prefs.
  const { nodes, calls } = mount(lockedRoster, 'bots', null, 'BotsPage')
  assert.equal(nodes.filter(node => node.type === 'select').length, 0, 'no Main Bot picker')
  assert.equal(nodes.filter(node => node.type === Segmented).length, 0, 'no animation picker')
  for (const button of pressure(nodes)) { try { button.props.onClick?.() } catch { /* the press is the point */ } }
  assert.deepEqual(calls, [], 'the page sends no set-main and no set-prefs')
  assert.ok(nodes.some(node => nameOf(node) === 'button' && /New Bot/.test(text(node))), 'the New Bot entry stays; its form is locked since #2465')
  assert.ok(text(nodes).includes('Chief'), 'the Main Bot in use is still named')
})

test('the standing sentence stays in the dialog header, once per page (#2474)', () => {
  for (const page of PAGES) {
    const tree = SettingsDialog({ page: page.key, id: page.id, roster: lockedRoster, actions: makeActions([]), useUpdate: () => ({}) })
    const hints = all(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-read-only'))
    assert.equal(hints.length, 1, `one standing sentence on ${page.name}`)
    assert.ok(text(hints[0]).includes(SENTENCE), 'the header keeps the host\'s own sentence')
  }
})

test('a writable window keeps every page as it is today (#2474)', () => {
  const counts = (nodes) => nodes.filter(isControl).length
  const general = mount(baseRoster, 'general', null, 'GeneralPage').nodes
  assert.equal(general.filter(node => node.type === 'select').length, 1, 'General keeps its theme select')
  assert.equal(general.filter(node => node.type === 'input').length, 1, 'General keeps its colour field')
  assert.equal(counts(general), 6, 'General keeps its four switches beside them')

  const bots = mount(baseRoster, 'bots', null, 'BotsPage').nodes
  assert.equal(bots.filter(node => node.type === 'select').length, 2, 'Bots keeps both of its Main Bot selects')
  assert.equal(bots.filter(node => node.type === Segmented).length, 1, 'Bots keeps its animation picker')

  assert.ok(counts(mount(baseRoster, 'bots', 'chief', 'BotSettingsForm').nodes) >= 3, 'a Bot keeps its live form')
  assert.ok(counts(mount(baseRoster, 'groups', 'r1', 'GroupSettingsForm').nodes) >= 3, 'a group keeps its live form')
  assert.ok(mount(baseRoster, 'connectors', null, 'ConnectorsPage').nodes.some(node => nameOf(node) === 'ConnectorRow'), 'Connectors keeps its live rows')
  assert.ok(mount(baseRoster, 'capabilities', null, 'CapabilitiesPage').nodes.some(node => nameOf(node) === 'CapabilityRow'), 'Capabilities keeps its rows')
  assert.ok(mount(baseRoster, 'secrets', null, 'SecretsPage').nodes.some(node => nameOf(node) === 'SecretRow'), 'Secrets keeps its rows')
})

// The window can be unlocked under a page that is already on screen: the other window holding
// the team closes, the host's read-only sentence goes away, and settings.js keeps the same
// dialog instance (its key is the page and the id, not the lock). A page whose locked view
// returns before one of its hooks then changes its hook count, and React unmounts the whole
// Settings surface with "Rendered more hooks than during the previous render." (#2474).
test('every Settings page re-renders when the window unlocks under it (#2474)', () => {
  for (const page of PAGES) {
    previousHookCount = null
    const tree = SettingsDialog({ page: page.key, id: page.id, roster: lockedRoster, actions: makeActions([]), useUpdate: () => ({}) })
    const node = all(tree).find(entry => typeof entry.type === 'function' && entry.type.name === page.name)
    assert.ok(node, `the dialog draws ${page.name}`)
    slots = []
    effects = []
    index = 0
    node.type(node.props)                                   // the locked render, already on screen
    previousHookCount = index
    index = 0
    const rendered = node.type({ ...node.props, roster: baseRoster })   // the same instance, writable now
    if (index < previousHookCount) throw new Error('Rendered fewer hooks than expected. This may be caused by an accidental early return statement.')
    const nodes = expand(rendered)
    const html = text(expand(rendered, [], 0, true))
    assert.ok(html.length > 0, `${page.name} still draws its page after the flip`)
    assert.ok(nodes.filter(isControl).length > 0, `${page.name} still draws its live controls after the flip`)
  }
})

// #2492: a read-only face-to-face room drew every person with the hint `Human` while its own
// header counted `2 Bots`, and the names the writable page draws were thrown away with each
// person's seats. The next change to that branch must not silently lose them again.
test('a read-only face-to-face room names each person\'s Bot (#2492)', () => {
  const { nodes, calls } = mount(faceLocked, 'groups', 'face', 'GroupSettingsForm')
  const facts = text(nodes)
  assert.match(facts, /Ann \(you\)Chief/, 'my Bot is named under me')
  assert.match(facts, /BobWriter/, "the friend's Bot is named under them")
  assert.ok(!facts.includes('Human'), 'a face-to-face room does not call a person Human')
  for (const button of pressure(nodes)) { try { button.props.onClick?.() } catch { /* the press is the point, not its answer */ } }
  assert.deepEqual(calls, [], 'the members card offers no write')
  assert.deepEqual(nodes.filter(isControl).map(nameOf), [], 'the members card draws text rows only')
  assert.deepEqual(nodes.filter(isInteractive).map(nameOf), [], 'no button, link, field or span with a handler, counted deep')
  // A zero is only worth reading if the counter can see the buttons when they are there: the
  // writable page draws these same rows with `onOpenBot`, so it must find `bt-face-bot` buttons.
  const writable = mount(faceRoster, 'groups', 'face', 'GroupSettingsForm').nodes
  assert.ok(writable.some(node => nameOf(node) === 'button' && node.props?.className === 'bt-face-bot'),
    'the same counter finds the writable page\'s Bot opener')
})

test('a read-only face-to-face room states who answers and its working folder (#2492)', () => {
  const { nodes } = mount(faceLocked, 'groups', 'face', 'GroupSettingsForm')
  const facts = text(nodes)
  assert.ok(facts.includes('Who answers'), 'the page says who answers')
  assert.ok(facts.includes('Everyone'), 'with the mode the writable page shows')
  assert.ok(facts.includes('Working folder'), 'the page names the working folder')
  assert.ok(facts.includes('/work/face'), 'with the folder the room works in')
  assert.deepEqual(nodes.filter(isControl).map(nameOf), [], 'both facts are text, not controls')
})

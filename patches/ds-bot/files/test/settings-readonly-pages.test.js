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
      "export { installSendShortcut, shouldBreakOnKey, shouldSendOnKey } from './src/client/composer.js'",
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
// The send-key setting is this window's own (the host stores no send-key field), so the
// page and the composer read and write this store. It starts empty in every mount.
const stores = new Map()
const storage = {
  getItem: key => (stores.has(key) ? stores.get(key) : null),
  setItem: (key, value) => { stores.set(key, String(value)) },
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
  navigator: { language: 'en' },
  localStorage: storage,
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { SettingsDialog, InlineText, SwitchRow, Segmented, ModelMenu, FolderMenu, installSendShortcut, shouldBreakOnKey, shouldSendOnKey } = module.exports

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

const mount = (roster, key, id, name, calls = [], override = undefined) => {
  const actions = override ?? makeActions(calls)
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
  assert.equal(counts(general), 8, 'General keeps its four switches beside the send-key and folding pickers')
  assert.equal(general.filter(node => node.type === Segmented && node.props?.label === 'Send shortcut').length, 1, 'General draws the send-key picker')

  const bots = mount(baseRoster, 'bots', null, 'BotsPage').nodes
  assert.equal(bots.filter(node => node.type === 'select').length, 2, 'Bots keeps both of its Main Bot selects')
  assert.equal(bots.filter(node => node.type === Segmented).length, 1, 'Bots keeps its animation picker')

  assert.ok(counts(mount(baseRoster, 'bots', 'chief', 'BotSettingsForm').nodes) >= 3, 'a Bot keeps its live form')
  assert.ok(counts(mount(baseRoster, 'groups', 'r1', 'GroupSettingsForm').nodes) >= 3, 'a group keeps its live form')
  assert.ok(mount(baseRoster, 'connectors', null, 'ConnectorsPage').nodes.some(node => nameOf(node) === 'ConnectorRow'), 'Connectors keeps its live rows')
  assert.ok(mount(baseRoster, 'capabilities', null, 'CapabilitiesPage').nodes.some(node => nameOf(node) === 'CapabilityRow'), 'Capabilities keeps its rows')
  assert.ok(mount(baseRoster, 'secrets', null, 'SecretsPage').nodes.some(node => nameOf(node) === 'SecretRow'), 'Secrets keeps its rows')
})

// General → Message folding (#3114): the picker writes the mode through `set-prefs`, so the
// host stores one team-wide choice and every window folds by it. The locked page keeps the
// mode in use as text, like every other page here.
test('Settings → General picks the message folding mode and writes it through set-prefs (#3114)', () => {
  const roster = { ...baseRoster, prefs: { ...baseRoster.prefs, folding: { mode: 'compact' } } }
  const written = []
  const { nodes } = mount(roster, 'general', null, 'GeneralPage', [], { setPrefs: payload => { written.push(payload); return Promise.resolve(payload) } })
  const pickers = nodes.filter(node => node.type === Segmented && node.props?.label === 'Message folding')
  assert.equal(pickers.length, 1, 'General draws the folding picker')
  const buttons = all(pickers[0]).filter(node => nameOf(node) === 'button')
  assert.deepEqual(buttons.map(text), ['Compact', 'Standard', 'No folding'])
  assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [true, false, false], 'the stored mode is the one in use')
  buttons[1].props.onClick()
  // The page runs inside a vm realm, so its own object is compared by value, not by prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(written)), [{ folding: { mode: 'standard' } }], 'Standard asks the host to store standard')
  const locked = mount({ ...roster, readOnly: SENTENCE }, 'general', null, 'GeneralPage').nodes
  assert.equal(locked.filter(node => node.type === Segmented && node.props?.label === 'Message folding').length, 0, 'a locked page draws no folding picker')
  assert.ok(text(locked).includes('Compact'), 'and keeps the mode in use as text')
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

// The face-room case above is the same two facts on the other origin: a plain group's read-only
// page drew neither, while its writable page draws both as a control. They are reads (`room.mode`
// through `shownMode`, and `room.workDir`), so the locked page keeps them as text too.
test('a read-only plain group states who answers and its working folder', () => {
  const { nodes, calls } = mount(lockedRoster, 'groups', 'r1', 'GroupSettingsForm')
  const facts = text(nodes)
  assert.ok(facts.includes('Who answers'), 'the page says who answers')
  assert.ok(facts.includes('Admin leads'), 'with the mode the writable page shows')
  assert.ok(facts.includes('Working folder'), 'the page names the working folder')
  assert.ok(facts.includes('/work/ops'), 'with the folder the group works in')
  assert.deepEqual(nodes.filter(isControl).map(nameOf), [], 'both facts are text, not controls')
  for (const button of pressure(nodes)) { try { button.props.onClick?.() } catch { /* the press is the point, not its answer */ } }
  assert.deepEqual(calls, [], 'and neither fact writes anything when drawn')
  // A zero only counts if the same reader sees the controls on the writable page next door.
  const writable = mount(baseRoster, 'groups', 'r1', 'GroupSettingsForm').nodes
  assert.ok(writable.some(node => node.type === Segmented), 'the writable page draws the mode picker')
  assert.ok(writable.some(node => node.type === FolderMenu), 'and the folder menu')
})

// Which key sends (General → Shortcuts). The shell sends on Enter and keeps Shift+Enter for
// a new line; the setting flips that pair for this window. The choice is local: the host has
// no send-key field, so the page writes localStorage instead of asking set-prefs.
test('General offers Enter or Shift+Enter to send, and stores the choice for this window (#3114)', () => {
  stores.clear()
  const { nodes, calls } = mount(baseRoster, 'general', null, 'GeneralPage')
  const facts = text(nodes)
  assert.match(facts, /Shortcuts/, 'the choice has its own section')
  assert.match(facts, /Send shortcut/, 'and its own row')
  const picker = nodes.find(node => node.type === Segmented && node.props?.label === 'Send shortcut')
  assert.ok(picker, 'the row draws a picker')
  const buttons = all(picker).filter(node => nameOf(node) === 'button')
  assert.deepEqual(buttons.map(text), ['Enter to send', 'Shift+Enter to send'])
  assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [true, false], 'Enter is the default')
  buttons[1].props.onClick()
  assert.equal(stores.get('flybot-send-key'), 'shift-enter', 'the choice is stored for this window')
  assert.deepEqual(calls, [], 'and no host write is asked for')
  const after = mount(baseRoster, 'general', null, 'GeneralPage').nodes
    .find(node => node.type === Segmented && node.props?.label === 'Send shortcut')
  assert.equal(after.props.value, 'shift-enter', 'a reload draws the stored choice')
})

test('a read-only window names the send shortcut instead of drawing a picker (#3114)', () => {
  stores.clear()
  const { nodes, calls } = mount(lockedRoster, 'general', null, 'GeneralPage')
  const facts = text(nodes)
  assert.match(facts, /Send shortcut/, 'the page still names the setting')
  assert.match(facts, /Enter to send/, 'with the choice in use')
  assert.equal(nodes.filter(node => node.type === Segmented && node.props?.label === 'Send shortcut').length, 0, 'and no picker')
  assert.deepEqual(calls, [], 'a locked page asks for no write')
})

// The composer side: with Shift+Enter to send, Enter starts a new line and Shift+Enter
// presses the shell's own Send button (found by its label, since the component carries no
// marker); with the default Enter to send, the composer is untouched.
const composerFixture = ({ label = 'Send', disabled = false, command = 'insertLineBreak' } = {}) => {
  const calls = []
  const button = { disabled, textContent: label, getAttribute: () => label, click: () => calls.push('send') }
  const card = { querySelector: () => null, querySelectorAll: () => [button] }
  const execCommand = (name) => { calls.push(`exec:${name}`); return name === command }
  const field = {
    isContentEditable: true,
    getAttribute: name => (name === 'contenteditable' ? 'true' : null),
    ownerDocument: { execCommand },
    closest: selector => (selector === '[data-composer-card]' ? card : field),
  }
  return { calls, card, button, field }
}
const keydown = (field, { shiftKey = false, prevented = false } = {}) => {
  const calls = []
  const event = {
    key: 'Enter', shiftKey, target: field, defaultPrevented: prevented,
    preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop'),
  }
  return { event, calls }
}
const listen = (doc) => {
  const listeners = []
  doc.defaultView.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture })
  doc.defaultView.removeEventListener = () => {}
  const stop = installSendShortcut({ doc })
  return { key: event => listeners.find(listener => listener.type === 'keydown').fn(event), stop }
}

test('Shift+Enter to send presses the composer\'s Send button and Enter starts a new line (#3114)', () => {
  stores.clear()
  stores.set('flybot-send-key', 'shift-enter')
  const fixture = composerFixture()
  const doc = { defaultView: { localStorage: storage } }
  const shortcut = listen(doc)
  const send = keydown(fixture.field, { shiftKey: true })
  shortcut.key(send.event)
  assert.deepEqual(send.calls, ['prevent', 'stop'], 'the press is taken from the shell')
  assert.deepEqual(fixture.calls, ['send'], 'and lands on the shell\'s own Send button')
  const breakLine = keydown(fixture.field)
  shortcut.key(breakLine.event)
  assert.deepEqual(breakLine.calls, ['prevent', 'stop'])
  assert.deepEqual(fixture.calls, ['send', 'exec:insertLineBreak'], 'Enter inserts one line break')
  shortcut.stop()
})

test('Enter to send leaves the composer to the shell (#3114)', () => {
  stores.clear()
  const fixture = composerFixture()
  const doc = { defaultView: { localStorage: storage } }
  const shortcut = listen(doc)
  const plain = keydown(fixture.field)
  shortcut.key(plain.event)
  assert.deepEqual(plain.calls, [], 'nothing is intercepted')
  assert.deepEqual(fixture.calls, [], 'and nothing is pressed')
  const enter = { key: 'Enter', shiftKey: false }
  const shift = { key: 'Enter', shiftKey: true }
  assert.equal(shouldSendOnKey(enter, 'enter'), true)
  assert.equal(shouldBreakOnKey(shift, 'enter'), true)
  assert.equal(shouldSendOnKey(shift, 'shift-enter'), true)
  assert.equal(shouldBreakOnKey(enter, 'shift-enter'), true)
  shortcut.stop()
})

test('a window with no Send to press keeps the shell\'s handling, and a locked field is left alone (#3114)', () => {
  stores.clear()
  stores.set('flybot-send-key', 'shift-enter')
  const disabled = composerFixture({ disabled: true })
  const doc = { defaultView: { localStorage: storage } }
  const shortcut = listen(doc)
  const press = keydown(disabled.field, { shiftKey: true })
  shortcut.key(press.event)
  assert.deepEqual(press.calls, [], 'a disabled Send button means the key falls through')
  const outside = keydown({ closest: () => null })
  shortcut.key(outside.event)
  assert.deepEqual(outside.calls, [], 'a key outside the composer is not ours')
  const readonly = composerFixture()
  readonly.field.getAttribute = name => (name === 'aria-readonly' ? 'true' : name === 'contenteditable' ? 'true' : null)
  const typed = keydown(readonly.field)
  shortcut.key(typed.event)
  assert.deepEqual(typed.calls, [], 'a read-only composer receives the key as it is')
  shortcut.stop()
})

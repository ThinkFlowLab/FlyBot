// #2391 (P-542; #2385 fixed only the drawer's Settings view): the same `errorLine` in the drawer's overview
// view is still the first child of `div.bt-drawer-body`, which `styles.js:389` makes `overflow-y:auto`.
// A refused rename — the overview's own write — is therefore written at the top of the box the person
// already scrolled past, and the card looks unchanged. The Settings dialog (#2194) and the Settings
// view (#2385) both keep that sentence outside the scroll box; the overview now does too.
//
// The same overview in a read-only window still drew the rename button, the model menu, the permission
// presets and the working-folder menu — every one of them a write the host answers with `bot/read-only`
// — and not one sentence saying the window is locked (P-487). It now says so in the host's own words
// and draws the name as plain text instead of a control.
//
// The drawing harness is the one `details-bot-settings-readonly.test.js` uses: the real bundle, React
// and the host replaced by stubs, hook slots that survive a re-render, and no jsdom. So "press rename,
// the host refuses, the card says why" is measurable from the drawer's own tree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { DetailsDrawer } from './src/client/details-drawer.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
let slots = []
let index = 0
let effects = []
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
  useEffect: (fn) => { const at = index++; if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
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
const { DetailsDrawer } = module.exports

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const REFUSAL = 'This Bot team is open in another window, so the change was not sent.'
const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
// The permission presets DeepSeek Harness offers; without a catalog `PermissionRow` draws nothing.
const permissions = { defaultPreset: 'workspace-write', options: [{ value: 'read-only', name: 'Read only' }, { value: 'workspace-write', name: 'Workspace' }, { value: 'danger-full-access', name: 'Full access' }] }
const base = { bots: [bot], rooms: [], byId: { a: bot }, roomsById: {}, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false, exchangeTurns: {}, questions: {}, permissions }
const rosterWith = (readOnly) => (readOnly === undefined ? { ...base } : { ...base, readOnly })
// The group overview #2391 left alone and P-544 now owns; it is drawn here so the Bot overview's
// own shape can be told apart from the group's.
const room = {
  id: 'r1', name: 'Team room', origin: 'group', named: true, members: ['a'], admin: 'a',
  participants: [], presentedParticipants: [], pinned: false, hidden: false, notice: '',
  workDir: '', mode: 'everyone', viewerRole: 'owner',
}
const roomRosterWith = (readOnly) => ({
  ...base, rooms: [room], roomsById: { r1: room }, self: { memberId: 'm1' },
  ...(readOnly === undefined ? {} : { readOnly }),
})
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
  updateBot: () => Promise.resolve(), updateRoom: () => Promise.resolve(),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
}
const render = (roster, acts = actions, sessionId = 'a') => {
  index = 0
  effects = []
  const map = () => new Map()
  return DetailsDrawer({
    sessionId, startTab: 'details', hasStrip: false, roster, actions: acts,
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
// Real React draws a function component when it meets one; this expands the same way, with the hook
// slots above assigned in tree order, so a re-render after a press sees the state it just set.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
// Every node with its ancestors, so "inside the scrolling box" is answerable rather than guessed.
const flatten = (node, ancestors = [], out = []) => {
  if (Array.isArray(node)) { for (const child of node) flatten(child, ancestors, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push({ node, ancestors })
  flatten(node.props?.children, [...ancestors, node], out)
  return out
}
const tree = (roster, acts = actions, sessionId = 'a') => flatten(expand(render(roster, acts, sessionId)))
const nodes = (entries) => entries.map(entry => entry.node)
const ownText = (node) => {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk).join('')
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (value && typeof value === 'object') return walk(value.props?.children)
    return ''
  }
  return walk(node?.props?.children)
}
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const bodyOf = (entries) => entries.find(({ node }) => hasClass(node, 'bt-drawer-body'))
const statusLine = (entries) => entries.filter(({ node }) => node.props?.role === 'status' && ownText(node).trim() === SENTENCE)
const renameButton = (entries) => entries.find(({ node }) => node.type === 'button' && hasClass(node, 'bt-drawer-name'))
const nameInput = (entries) => entries.find(({ node }) => node.type === 'input' && hasClass(node, 'bt-drawer-name-input'))
const modelTriggers = (entries) => entries.filter(({ node }) => String(node.props?.['aria-label'] ?? '').startsWith('Model: '))
const folderTriggers = (entries) => entries.filter(({ node }) => String(node.props?.['aria-label'] ?? '').startsWith('Working folder: '))
const permissionRows = (entries) => entries.filter(({ node }) => hasClass(node, 'bt-drawer-permission'))

test('#2391: a refused rename in the overview says so in one alert line outside the scrolling box', async () => {
  slots = []
  const acts = { ...actions, updateBot: () => Promise.reject(new Error(REFUSAL)) }
  const roster = rosterWith(undefined)
  const pressed = renameButton(tree(roster, acts))
  assert.ok(pressed, 'a writable overview offers the rename control')
  pressed.node.props.onClick()
  const input = nameInput(tree(roster, acts))
  assert.ok(input, 'pressing rename opens the name field')
  input.node.props.onChange({ target: { value: 'Renamed' } })
  // The field's handlers close over the render that drew them, so the new value has to reach a fresh
  // render before Enter is what saves it.
  const typed = nameInput(tree(roster, acts))
  typed.node.props.onKeyDown({ key: 'Enter' })
  await new Promise(resolve => setTimeout(resolve, 0))

  const entries = tree(roster, acts)
  const lines = entries.filter(({ node }) => node.props?.role === 'alert')
  assert.equal(lines.length, 1, 'the refusal is written once')
  assert.equal(ownText(lines[0].node).trim(), REFUSAL, 'the line is the host sentence, not a swallowed failure')
  assert.equal(lines[0].ancestors.some(node => hasClass(node, 'bt-drawer-body')), false,
    'the refusal line is not inside the scrolling box that hides it')
  const box = bodyOf(entries)
  assert.ok(box, 'the overview still draws its scrolling body')
  assert.ok(entries.indexOf(lines[0]) < entries.indexOf(box), 'the refusal line is drawn above the scrolling box')
})

test('#2391: a read-only window\'s overview says so and draws no write control', () => {
  slots = []
  const entries = tree(rosterWith(SENTENCE))
  const lines = statusLine(entries)
  assert.equal(lines.length, 1, "the host's sentence is drawn once")
  assert.ok(hasClass(lines[0].node, 'bt-read-only'), 'the sentence is the read-only hint')
  assert.deepEqual(renameButton(entries), undefined, 'the name is not a rename control in a locked window')
  const plain = nodes(entries).find(node => node.type === 'div' && hasClass(node, 'bt-drawer-name') && ownText(node).trim() === 'Chief')
  assert.ok(plain, 'the name is still drawn, as plain text')
  assert.deepEqual(modelTriggers(entries), [], 'no model menu the host would refuse')
  assert.deepEqual(folderTriggers(entries), [], 'no working-folder menu the host would refuse')
  assert.deepEqual(permissionRows(entries), [], 'no permission preset the host would refuse')
})

test('#2391: a writable window keeps the overview\'s write controls and draws no read-only line', () => {
  slots = []
  for (const roster of [rosterWith(undefined), rosterWith(''), rosterWith('   ')]) {
    const entries = tree(roster)
    assert.ok(renameButton(entries), 'a writable window keeps the rename control')
    assert.equal(modelTriggers(entries).length, 1, 'a writable window keeps the model menu')
    assert.equal(folderTriggers(entries).length, 1, 'a writable window keeps the working-folder menu')
    assert.equal(permissionRows(entries).length, 1, 'a writable window keeps the permission presets')
    assert.deepEqual(statusLine(entries), [], 'no read-only sentence is drawn')
  }
})

// P-544: the group overview took the same shape as the Bot overview — one sentence in the host's
// words, the name as plain text, no rename control.
test('P-544: a read-only group overview says why once and draws the name as plain text', () => {
  slots = []
  const entries = tree(roomRosterWith(SENTENCE), actions, 'r1')
  assert.equal(statusLine(entries).length, 1, "the host's sentence is drawn once")
  assert.deepEqual(renameButton(entries), undefined, 'the name is not a rename control in a locked window')
  const plain = nodes(entries).find(node => node.type === 'div' && hasClass(node, 'bt-drawer-name') && ownText(node).trim() === 'Team room')
  assert.ok(plain, 'the name is still drawn, as plain text')
  assert.equal(plain.props.title, 'Team room', 'the plain name keeps the full text as its title')
  assert.deepEqual(modelTriggers(entries), [], 'a group never had a model menu')
  assert.deepEqual(permissionRows(entries), [], 'a group never had permission presets')
})

// P-547: the same locked window dropped the overview's Model, Permissions and Working folder
// cards whole, so their values went with the controls even though the name above is already
// "value kept, control removed" (`details-drawer.js`'.bt-drawer-name' as plain text). Product's
// probe on a locked window read `model name drawn = false`, `permission label = false`,
// `workDir = false`; in a writable window all three were true. A locked window refuses the
// writes, not the reading, so the three values stay on the page as text and none of the three
// controls is drawn.
const withModel = { ...bot, model: 'deepseek/deepseek-v4.1-flash', workDir: '/home/xuke/flybot' }
const modelsCatalog = [{ ref: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', providerName: 'DeepSeek' }]
const rosterModelWith = (readOnly) => ({
  ...base, bots: [withModel], byId: { a: withModel }, models: modelsCatalog,
  ...(readOnly === undefined ? {} : { readOnly }),
})
const readOnlyValues = (entries) => entries.filter(({ node }) => hasClass(node, 'bt-readonly-value'))
// The value line itself, without the note under it (the provider, the full path).
const readOnlyNames = (entries) => entries.filter(({ node }) => hasClass(node, 'bt-model-name')).map(({ node }) => ownText(node).trim())
const sectionTitles = (entries) => nodes(entries).filter(node => hasClass(node, 'bt-section-title')).map(node => ownText(node).trim())

test('P-547: a locked overview keeps the model, permission and folder values and draws no control', () => {
  slots = []
  const entries = tree(rosterModelWith(SENTENCE))
  assert.equal(statusLine(entries).length, 1, "the host's sentence is still drawn once")
  assert.equal(readOnlyValues(entries).length, 3, 'the three values are drawn, not dropped with their controls')
  const names = readOnlyNames(entries)
  assert.equal(names[0], 'DeepSeek V4.1 Flash', 'the model name is on the page')
  assert.equal(names[1], 'Workspace', 'the permission preset is on the page, by its label')
  assert.equal(names[2], 'flybot', 'the working folder is on the page by its last segment')
  const titles = sectionTitles(entries)
  for (const title of ['Model', 'Permissions', 'Working folder']) assert.ok(titles.includes(title), `${title} keeps its section`)
  const folder = readOnlyValues(entries)[2].node
  assert.equal(folder.props.title, '/home/xuke/flybot', 'the full folder path is kept as the value title')
  assert.deepEqual(modelTriggers(entries), [], 'no model menu the host would refuse')
  assert.deepEqual(permissionRows(entries), [], 'no permission preset the host would refuse')
  assert.deepEqual(folderTriggers(entries), [], 'no working-folder menu the host would refuse')
  assert.deepEqual(nodes(entries).filter(node => node.props?.['aria-haspopup'] === 'menu'), [],
    'no anchored menu of any kind is drawn in a locked overview')
})

test('P-547: a writable overview keeps its controls and draws no read-only value', () => {
  slots = []
  const entries = tree(rosterModelWith(undefined))
  assert.deepEqual(readOnlyValues(entries), [], 'the read-only values are a locked window only')
  assert.equal(modelTriggers(entries).length, 1, 'the model menu is still the writable control')
  assert.equal(permissionRows(entries).length, 1, 'the permission presets are still the writable control')
  assert.equal(folderTriggers(entries).length, 1, 'the working-folder menu is still the writable control')
  assert.equal(ownText(modelTriggers(entries)[0].node).includes('DeepSeek V4.1 Flash'), true,
    'the writable trigger still shows the same model name')
})

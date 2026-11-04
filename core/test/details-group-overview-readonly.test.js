// P-544: a read-only window's *group* overview still drew the rename control, left the name a
// button, and (for an invited share) offered `Remove my Bot` — every one of them a write the host
// answers with `bot/read-only`. It also said nothing about why. #2391 fixed the Bot overview and
// deliberately left this one alone; this is the group half.
//
// The drawing harness is the one `details-overview-readonly.test.js` uses: the real bundle, React
// and the host replaced by stubs, hook slots that survive a re-render, and no jsdom.
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
const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const room = {
  id: 'r1', name: 'Team room', origin: 'group', named: true, members: ['a'], admin: 'a',
  participants: [], presentedParticipants: [], pinned: false, hidden: false, notice: '',
  workDir: '', mode: 'everyone', viewerRole: 'owner',
}
const invited = { ...room, viewerRole: 'invited-owner', pendingCount: 0, sharedFrom: { inviterName: 'Chris', invitedAt: 0 } }
const pending = { ...invited, pendingCount: 1, pendingApprovals: [{ id: 'a1', text: 'Which file?' }] }
const base = {
  bots: [bot], byId: { a: bot }, prefs: {}, mainBotIds: ['a'], connectors: [], memory: false,
  exchangeTurns: {}, questions: {}, self: { memberId: 'm1' },
}
const rosterFor = (target, readOnly) => ({
  ...base, rooms: [target], roomsById: { [target.id]: target },
  ...(readOnly === undefined ? {} : { readOnly }),
})
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
  updateBot: () => Promise.resolve(), updateRoom: () => Promise.resolve(),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
}
const render = (roster, acts = actions) => {
  slots = []
  index = 0
  effects = []
  const map = () => new Map()
  return DetailsDrawer({
    sessionId: 'r1', startTab: 'details', hasStrip: false, roster, actions: acts,
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
// Real React draws a function component when it meets one; this expands the same way, with the hook
// slots above assigned in tree order.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function') return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const flatten = (node, ancestors = [], out = []) => {
  if (Array.isArray(node)) { for (const child of node) flatten(child, ancestors, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push({ node, ancestors })
  flatten(node.props?.children, [...ancestors, node], out)
  return out
}
const tree = (roster) => flatten(expand(render(roster)))
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
const bodyOf = entries => entries.find(({ node }) => node.props?.className === 'bt-drawer-body')
const renameButton = entries => entries.find(({ node }) => node.type === 'button' && hasClass(node, 'bt-drawer-name'))
const plainName = entries => entries.find(({ node }) => node.type === 'div' && hasClass(node, 'bt-drawer-name') && ownText(node).trim() === 'Team room')
const removeButton = entries => entries.find(({ node }) => node.type === 'button' && ownText(node).trim() === 'Remove my Bot')
const hintEntries = entries => entries.filter(({ node }) => hasClass(node, 'bt-read-only'))
const statusLine = entries => entries.filter(({ node }) => node.props?.role === 'status' && ownText(node).trim() === SENTENCE)
const buttonLabels = entries => entries.filter(({ node }) => node.type === 'button').map(({ node }) => ownText(node).trim())
const inBody = entries => {
  const box = bodyOf(entries)
  return box ? entries.filter(entry => entry.ancestors.includes(box.node)) : []
}

test('P-544: a read-only group overview says why once and draws no rename control', () => {
  const locked = tree(rosterFor(room, SENTENCE))
  const lines = statusLine(locked)
  assert.equal(lines.length, 1, "the host's sentence is drawn once")
  assert.ok(hasClass(lines[0].node, 'bt-read-only'), 'the sentence is the read-only hint')
  const name = plainName(locked)?.node
  assert.ok(name, 'the name is still drawn, as plain text')
  assert.equal(name.props.title, 'Team room', 'the plain name keeps the full text as its title')
  assert.deepEqual(renameButton(locked), undefined, 'pressing the name can no longer open the rename field')
  const labels = buttonLabels(inBody(locked))
  for (const write of ['Pin', 'Hide from sidebar', 'Remove my Bot']) {
    assert.equal(labels.includes(write), false, `${write} is not drawn in a read-only group overview`)
  }
})

test('P-544: a read-only invited group draws no Remove my Bot and keeps the invitation text', () => {
  const locked = tree(rosterFor(invited, SENTENCE))
  assert.deepEqual(removeButton(locked), undefined, 'Remove my Bot is a write the host would refuse')
  assert.match(ownText(bodyOf(locked).node), /invited to this room by Chris/, 'the invitation itself is a read and stays')
  assert.equal(statusLine(locked).length, 1, "the host's sentence is drawn once")
})

test('P-544: a writable group keeps the rename control, Remove my Bot and draws no sentence', () => {
  const open = tree(rosterFor(invited, undefined))
  assert.ok(renameButton(open), 'a writable group keeps the rename control')
  assert.ok(removeButton(open), 'a writable invited group keeps Remove my Bot')
  assert.deepEqual(statusLine(open), [], 'no read-only sentence is drawn')
  for (const roster of [rosterFor(invited, ''), rosterFor(invited, '   ')]) {
    const blank = tree(roster)
    assert.ok(renameButton(blank), 'a blank read-only string is writable, as before')
    assert.ok(removeButton(blank), 'a blank read-only string keeps Remove my Bot')
    assert.deepEqual(statusLine(blank), [], 'a blank read-only string draws no sentence')
  }
})

test('P-544: a read-only group with a pending approval still says the host sentence exactly once', () => {
  const locked = tree(rosterFor(pending, SENTENCE))
  const lines = hintEntries(locked)
  assert.equal(lines.length, 1, 'one read-only line on the page, not one per card')
  assert.equal(ownText(lines[0].node).trim(), SENTENCE, "the line is the host's own sentence")
  assert.equal(lines[0].ancestors.some(node => hasClass(node, 'bt-shared-wait')), false,
    'the page sentence is drawn above the approval card, not repeated inside it')
  assert.match(ownText(bodyOf(locked).node), /Which file\?/, 'the approval is still readable')
  const decisions = buttonLabels(locked).filter(label => label === 'Approve' || label === 'Reject')
  assert.deepEqual(decisions, [], 'a read-only window still offers neither decision')
})

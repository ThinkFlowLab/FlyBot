// A read-only window still opens a group's Settings page from the details drawer. The drawer's
// read-only branch was written for a Bot only (`bot && lockedWindow(roster)`), so a group kept the
// whole live form — name, notice, who answers, working folder, members, Pin, Hide, Delete group —
// while every write it offered could only be refused with `bot/read-only`. The host's own sentence
// belongs in place of that form, exactly as it already is for a Bot.
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
// A hook runtime that survives a re-render, the same one the Bot settings page is drawn with: the
// read-only line has to come out of the drawer's own tree, not from a re-implementation of it.
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

const bot = { id: 'a', name: 'Chief', pinned: false, hidden: false, model: '', instructions: '', workDir: '' }
const room = {
  id: 'r1', name: 'Team room', origin: 'group', viewerRole: 'invited-owner', pendingCount: 0,
  members: [], participants: [], notice: '', named: true, mode: 'everyone', workDir: '', pinned: false, hidden: false,
}
const base = {
  bots: [bot], rooms: [room], byId: { a: bot }, roomsById: { r1: room },
  prefs: {}, mainBotIds: ['a'], connectors: [], memory: false, exchangeTurns: {}, questions: {},
}
const rosterWith = (readOnly) => (readOnly === undefined ? { ...base } : { ...base, readOnly })
const SENTENCE = 'Another FlyBot window has this Bot team open, so this window is read-only.'
const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  updateRoom: () => Promise.resolve(), deleteRoom: () => Promise.resolve(),
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
}
// The drawer reads its stores through the hooks the shell hands it; these stand in for one render.
const render = (roster, acts = actions) => {
  index = 0
  effects = []
  const map = () => new Map()
  return DetailsDrawer({
    sessionId: 'r1', startTab: 'settings', hasStrip: false, roster, actions: acts,
    useSessions: selector => selector({ byId: {}, projectionsBySession: {} }), useSessionStatus: selector => selector(map()),
    useActivity: selector => selector(map()), useWork: selector => selector(map()),
    useBrowserTabs: selector => selector(map()), useBrowserPages: selector => selector(map()),
  })
}
// The drawer returns elements; a function component is drawn by React, so the tree is expanded
// here the same way: every function component runs with the hook slots above, in tree order.
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
const tree = (roster) => all(expand(render(roster)))
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
const bodyOf = (nodes) => nodes.find(node => node.props?.className === 'bt-drawer-body bt-set-body')
const readOnlyLines = (nodes) => nodes.filter(node => hasClass(node, 'bt-read-only'))
const groupForms = (nodes) => nodes.filter(node => hasClass(node, 'bt-bs'))
const switches = (nodes) => nodes.filter(node => node.props?.role === 'switch')

test('a read-only window draws the host\'s sentence in place of the group settings form', () => {
  const nodes = tree(rosterWith(SENTENCE))
  const body = bodyOf(nodes)
  assert.ok(body, 'the drawer draws its settings body')
  const inside = all(body)
  // 3 = the host's sentence once, no form, no switch: today the form is mounted and the line is absent.
  assert.equal(inside.filter(node => node.props?.role === 'status' && ownText(node).trim() === SENTENCE).length, 1, "the host's sentence is drawn once")
  const line = readOnlyLines(inside)
  assert.equal(line.length, 1, 'the sentence is the read-only hint')
  assert.equal(line[0].props.role, 'status', 'the sentence is a status line')
  assert.equal(ownText(line[0]).trim(), SENTENCE, 'the hint carries the host\'s own sentence, not a rewrite')
  assert.equal(groupForms(inside).length, 0, 'no group settings form is drawn in a read-only window')
  assert.equal(groupForms(nodes).length, 0, 'the form is not drawn anywhere in the drawer either')
  assert.equal(switches(inside).length, 0, 'no Pin/Hide switch is drawn in a read-only window')
})

test('a writable window still draws the group settings form', () => {
  for (const roster of [rosterWith(undefined), rosterWith(''), rosterWith('   ')]) {
    const nodes = tree(roster)
    const body = bodyOf(nodes)
    assert.ok(body, 'the drawer draws its settings body')
    const inside = all(body)
    // 2 = the form once, no read-only line: today this passes, and it is what keeps the lock above honest.
    assert.equal(groupForms(inside).length, 1, 'exactly one group settings form is drawn')
    assert.equal(readOnlyLines(inside).length, 0, 'no read-only sentence is drawn in a writable window')
    assert.equal(inside.some(node => typeof node === 'object' && ownText(node).trim() === SENTENCE), false, 'the host sentence is absent')
  }
})

test('a writable window keeps the group form\'s switches and write entries', () => {
  const inside = all(bodyOf(tree(rosterWith(undefined))))
  // 2 = Pin and Hide are switches, and a form that draws none is not the form this issue protects.
  assert.ok(switches(inside).length >= 2, 'a writable group form draws its Pin and Hide switches')
  assert.ok(inside.some(node => node.type === 'button'), 'a writable group form draws its buttons')
})

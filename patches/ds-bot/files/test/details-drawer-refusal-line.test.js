// #2385: the drawer's own Settings view drew the refused sentence at the top of the scrolling box
// (`details-drawer.js:281` `errorLine`, first child of `bt-drawer-body bt-set-body`, and
// `styles.js:389` makes that box `overflow-y:auto`). A person who scrolled to the bottom and pressed
// Pin / Hide / Make admin got a `bot/read-only` refusal written above the viewport, so the card and
// the buttons never changed and the press looked ignored. The Settings dialog already draws the
// same sentence outside its scroll box (#2194, `settings.js:213`, `docs/subsystems/core-client.md`
// "the refusal line sits outside the scrolling box"); the drawer's Settings view now does the same:
// the line is a sibling above the body, and a write that succeeds draws no line at all.
// React and the host are replaced by the same tiny stubs `room-approvals-readonly.test.js` uses
// (no jsdom here), so "press Pin, the host refuses, the card says why" is measurable.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { deps: undefined }
    inst.effects.push([i, fn, deps])
  },
}
reactStub.useRef = (value) => {
  const { inst } = live
  const i = live.idx++
  if (!(i in inst.hooks)) inst.hooks[i] = { current: value }
  return inst.hooks[i]
}
reactStub.useMemo = (fn) => {
  const { inst } = live
  const i = live.idx++
  if (!(i in inst.hooks)) inst.hooks[i] = { value: fn() }
  return inst.hooks[i].value
}
reactStub.useCallback = (fn) => {
  const { inst } = live
  const i = live.idx++
  if (!(i in inst.hooks)) inst.hooks[i] = { value: fn }
  return inst.hooks[i].value
}
for (const name of ['useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value
globalThis.__reactStub = reactStub
const hostCalls = []
let hostAnswer = () => Promise.resolve()
globalThis.__hostCall = (endpoint, payload) => { hostCalls.push([endpoint, payload]); return hostAnswer(endpoint, payload) }
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: 'data:text/javascript,const r=globalThis.__reactStub;export default r;export const {createElement,Fragment,Component,useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect,useContext,useReducer,useId,useSyncExternalStore,useTransition,useDeferredValue,memo,forwardRef,createContext,createPortal,cloneElement,isValidElement,startTransition}=r', shortCircuit: true }
    if (specifier === './api.js' && context.parentURL?.includes('/src/client/')) return { url: 'data:text/javascript,export const call = (endpoint, payload) => globalThis.__hostCall(endpoint, payload)', shortCircuit: true }
    if (specifier === 'react-dom') return { url: 'data:text/javascript,export const createPortal = node => node', shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { url: 'data:text/javascript,export const MarkdownText = node => node;export const FishLogo = node => node', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
globalThis.window ??= globalThis
globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

const REFUSAL = 'This Bot team is open in another window, so the change was not sent.'
const bot = { id: 'b1', name: 'Helper', ownerId: 'm1', sessionId: 's1', pinned: false }
const room = {
  id: 'r1', name: 'Team room', origin: 'group', viewerRole: 'invited-owner', members: ['b1'], admin: 'b1',
  participants: [], presentedParticipants: [], pinned: false, hidden: false, notice: '', workDir: '', mode: 'everyone',
}
const roster = {
  self: { memberId: 'm1' }, bots: [bot], byId: { b1: bot }, humans: [], remoteBots: [], readOnly: '',
  rooms: [room], roomsById: { r1: room }, exchangeTurns: {}, prefs: {}, mainBotIds: [], connectors: [], memory: false, questions: {},
}
const map = () => new Map()
const fakeList = { byId: {}, projectionsBySession: {} }
const actions = {
  closeOverlay() {}, openSession() {}, openSettings() {}, openBrowser() {}, closeSettings() {},
  updateRoom: () => Promise.resolve(), deleteRoom: () => Promise.resolve(), setFlags: () => Promise.resolve(),
  notify() {}, reportError() {},
}
const drawer = (acts = actions) => ({
  hooks: {}, effects: [], rendered: false,
  props: {
    sessionId: 'r1', startTab: 'settings', hasStrip: false, roster, actions: acts,
    useSessions: (pick) => pick(fakeList), useSessionStatus: (pick) => pick(map()),
    useActivity: (pick) => pick(map()), useWork: (pick) => pick(map()),
    useBrowserTabs: (pick) => pick(map()), useBrowserPages: (pick) => pick(map()),
  },
})
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function' && !node.type.prototype?.render) return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const render = (inst) => {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  const tree = expand(DetailsDrawer(inst.props))
  inst.rendered = true
  return tree
}
// Document order with the ancestors of every node, so "inside the scrolling box" is answerable.
const flatten = (node, ancestors = [], out = []) => {
  if (Array.isArray(node)) { for (const child of node) flatten(child, ancestors, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push({ node, ancestors })
  flatten(node.props?.children, [...ancestors, node], out)
  return out
}
const flat = (tree) => flatten(tree)
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object') return String(node)
  return text(node.props?.children)
}
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const alerts = (entries) => entries.filter(({ node }) => node.props?.role === 'alert')
const body = (entries) => entries.find(({ node }) => hasClass(node, 'bt-drawer-body') && hasClass(node, 'bt-set-body'))
const switchNamed = (entries, label) => entries.find(({ node }) => node.type === 'button' && node.props?.role === 'switch' && node.props?.['aria-label'] === label)

let DetailsDrawer
test.before(async () => {
  ;({ DetailsDrawer } = await import('../src/client/details-drawer.js'))
})

test('#2385: a refused Settings write says so in one alert line outside the scrolling box', async () => {
  hostCalls.length = 0
  hostAnswer = () => Promise.reject(new Error(REFUSAL))
  const acts = { ...actions, setFlags: () => { hostCalls.push(['set-flags']); return Promise.reject(new Error(REFUSAL)) } }
  const inst = drawer(acts)
  try {
    const pin = switchNamed(flat(render(inst)), 'Pin')
    assert.ok(pin, 'the writable group Settings page draws its Pin switch')
    pin.node.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    const entries = flat(render(inst))
    const lines = alerts(entries)
    assert.equal(lines.length, 1, 'the refusal is written once')
    assert.equal(text(lines[0].node.props?.children), REFUSAL, 'the line is the host sentence, not a swallowed failure')
    assert.equal(lines[0].ancestors.some((node) => hasClass(node, 'bt-drawer-body')), false,
      'the refusal line is not inside the scrolling box that hides it')
  } finally {
    hostAnswer = () => Promise.resolve()
  }
})

test('#2385: the refusal line comes before the scrolling box in document order', async () => {
  hostAnswer = () => Promise.reject(new Error(REFUSAL))
  const acts = { ...actions, setFlags: () => Promise.reject(new Error(REFUSAL)) }
  const inst = drawer(acts)
  try {
    const pin = switchNamed(flat(render(inst)), 'Pin')
    assert.ok(pin, 'the writable group Settings page draws its Pin switch')
    pin.node.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    const entries = flat(render(inst))
    const line = alerts(entries)[0]
    const box = body(entries)
    assert.ok(box, 'the Settings view still draws its scrolling body')
    assert.ok(entries.indexOf(line) < entries.indexOf(box),
      'the refusal line is drawn above the scrolling box, where the press happened')
  } finally {
    hostAnswer = () => Promise.resolve()
  }
})

test('#2385: a write that succeeds draws no refusal line', async () => {
  hostAnswer = () => Promise.resolve()
  const inst = drawer()
  const pin = switchNamed(flat(render(inst)), 'Pin')
  assert.ok(pin, 'the writable group Settings page draws its Pin switch')
  pin.node.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(alerts(flat(render(inst))), [], 'a successful write draws no alert line')
})

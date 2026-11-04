// #2381: a read-only window still drew `Approve` / `Reject` on the shared room overview's
// "Waiting for your approval" card (`details-drawer.js` `SharedRoomApprovals`). The card reaches
// such a window on purpose — an approval is a read — but `decide` is not, so the two buttons could
// only earn `bot/read-only` after the click, and the component swallowed that failure in a
// `try/finally` with no `catch`, so the card said nothing at all.
// The drawer's own Settings view already asks `lockedWindow(roster)` and prints the host's
// sentence (`details-drawer.js:270`); this card never did. It now does, and a refused decision
// writes one `role="alert"` line instead of vanishing.
// React is replaced by the same tiny renderer `approvals-readonly.test.js` uses (no jsdom here);
// the host call is replaced too, so "the click was refused and the card said why" is measurable.
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
// The drawer keeps a `useRef` object and memoises values, so these three answer the way React does.
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
// Every host call the card makes, in order: `[endpoint, payload]`.
const hostCalls = []
let hostAnswer = () => Promise.resolve([])
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

const LOCK = 'Another FlyBot window has this Bot team open, so this window is read-only.'
const FAILURE = 'This Bot team is open in another window, so the decision was not sent.'
const host = { id: 'b1', name: 'Helper', ownerId: 'm1', sessionId: 's1' }
const writable = {
  self: { memberId: 'm1' }, bots: [host], byId: { b1: host }, rooms: [], roomsById: {}, readOnly: '',
  exchangeTurns: {}, prefs: {}, mainBotIds: [], connectors: [], memory: false, questions: {},
}
const locked = { ...writable, readOnly: LOCK }
const room = {
  id: 'r1', name: 'Team room', origin: 'group', viewerRole: 'invited-owner', pendingCount: 1,
  pendingApprovals: [{ id: 'a1', text: 'Which file?' }], members: [], participants: [],
}
const withRoom = (roster) => ({ ...roster, roomsById: { r1: room }, rooms: [room] })

const map = () => new Map()
const fakeList = { byId: {}, projectionsBySession: {} }
const actions = {
  closeOverlay() {}, openSession() {}, openSettings() {}, openBrowser() {},
  updateRoom: () => Promise.resolve(), notify() {}, reportError() {},
}
const drawer = (roster) => ({
  hooks: {}, effects: [], rendered: false,
  props: {
    sessionId: 'r1', startTab: 'details', hasStrip: false, roster: withRoom(roster), actions,
    useSessions: (pick) => pick(fakeList), useSessionStatus: (pick) => pick(map()),
    useActivity: (pick) => pick(map()), useWork: (pick) => pick(map()),
    useBrowserTabs: (pick) => pick(map()), useBrowserPages: (pick) => pick(map()),
  },
})
// The drawer returns elements; React draws the function components inside them, so they are
// expanded here the same way — every function component runs on the one hook runtime above.
// The hook slots are positional, so the tree is expanded in one pass: the drawer runs first, then
// each function component in tree order, the way the settings-drawer test draws it.
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
const nodes = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  nodes(node.props?.children, out)
  return out
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object') return String(node)
  return text(node.props?.children)
}
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const DECISIONS = ['Approve', 'Reject']
const decisionLabels = tree => nodes(tree)
  .filter(node => node.type === 'button')
  .map(node => text(node.props?.children))
  .filter(label => DECISIONS.includes(label))
  .sort()
const hints = tree => nodes(tree).filter(node => hasClass(node, 'bt-read-only'))
const alerts = tree => nodes(tree).filter(node => node.props?.role === 'alert')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node.props?.children) === label)

let DetailsDrawer
test.before(async () => {
  ;({ DetailsDrawer } = await import('../src/client/details-drawer.js'))
})

test('#2381: a read-only window draws neither Approve nor Reject on the room approval card', () => {
  const drawn = render(drawer(locked))
  assert.deepEqual(decisionLabels(drawn), [], `a read-only room card still offers ${JSON.stringify(decisionLabels(drawn))}`)
  // What the card is for stays: the headline, the count and the row's own text.
  const shown = text(drawn)
  assert.match(shown, /Waiting for your approval/)
  assert.match(shown, /Which file\?/)
})

test('#2381: the read-only room card carries the host sentence in one status line', () => {
  const drawn = render(drawer(locked))
  const lines = hints(drawn)
  assert.equal(lines.length, 1, 'one read-only line on the card')
  assert.equal(lines[0].props.role, 'status', 'the line is announced')
  assert.equal(text(lines[0].props?.children), LOCK, "the line is the host's own sentence")
  // A writable window draws no line and keeps both decisions: the zero above is the lock, not a
  // card that never drew anything.
  const open = render(drawer(writable))
  assert.deepEqual(hints(open), [], 'a writable window draws no read-only line')
  assert.deepEqual(decisionLabels(open), ['Approve', 'Reject'], 'a writable window keeps both decisions')
})

test('#2381: a refused decision says so in one alert line instead of vanishing', async () => {
  hostCalls.length = 0
  hostAnswer = () => Promise.reject(new Error(FAILURE))
  const inst = drawer(writable)
  try {
    const approve = button(render(inst), 'Approve')
    assert.ok(approve, 'the writable card draws Approve')
    // The press is observed here: a rejection the component itself never catches escapes as an
    // unhandled one, which is the shape this test exists to end.
    const pressed = approve.props.onClick({ preventDefault() {}, stopPropagation() {} })
    const escaped = await Promise.resolve(pressed).then(() => null, (error) => error)
    await new Promise(resolve => setTimeout(resolve, 0))
    const drawn = render(inst)
    assert.deepEqual(hostCalls.map(([endpoint]) => endpoint), ['social/decide-approval'], 'the press reached the host')
    const lines = alerts(drawn)
    assert.equal(lines.length, 1, 'the refusal is written once')
    assert.equal(text(lines[0].props?.children), FAILURE, 'the line is the real reason, not a swallowed failure')
    assert.deepEqual(decisionLabels(drawn), ['Approve', 'Reject'], 'the card is still there after a refusal')
    assert.equal(escaped, null, 'the refusal did not escape the component')
  } finally {
    hostAnswer = () => Promise.resolve([])
  }
})

// #2409: an approval card never said how long it had been waiting, so a hold from half an hour ago
// and one that had just arrived looked identical. The host has written `createdAt` on every hold
// since the start (`core/src/host/hooks.js` hold), and the room's card receives the plugin's
// `createdAt` (an ISO string or absent), but none of the three drawing points read it. They now do,
// through `relativeShort()` and the four strings already in `i18n.js`: `Waiting for approval · 12 min`.
// React is replaced by the tiny renderer the other client tests use (no jsdom here).
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
globalThis.__hostCall = () => Promise.resolve([])
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

function render(Component, inst) {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  const out = Component(inst.props ?? {})
  inst.rendered = true
  return out
}
// The drawer returns elements; React draws the function components inside them, so they are
// expanded here the same way the room-approvals test draws it.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const props = node.props ?? {}
  if (typeof node.type === 'function' && !node.type.prototype?.render) return expand(node.type(props))
  return { ...node, props: { ...props, children: expand(props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object') return String(node)
  return text(node.props?.children ?? node.children)
}

// 12 minutes is the issue's own example: `relativeShort` floors it to `12 min`.
const TWELVE = 12 * 60 * 1000
const twelveAgo = () => Date.now() - TWELVE

const host = { id: 'b1', name: 'Helper', ownerId: 'm1', sessionId: 's1' }
const writable = { self: { memberId: 'm1' }, bots: [host], byId: { b1: host }, rooms: [], roomsById: {}, readOnly: '', exchangeTurns: {}, prefs: {}, mainBotIds: [], connectors: [], memory: false, questions: {} }
const approval = (extra = {}) => ({
  id: 'a1', status: 'pending', by: 'tree', senderName: 'Helper', targetName: '@chief.uia.home',
  request: { from: 'bot-helper', to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 },
  ...extra,
})
const room = (pendingApprovals) => ({
  id: 'r1', name: 'Team room', origin: 'group', viewerRole: 'invited-owner', pendingCount: pendingApprovals.length,
  pendingApprovals, members: [], participants: [],
})
const map = () => new Map()
const fakeList = { byId: {}, projectionsBySession: {} }
const actions = {
  closeOverlay() {}, openSession() {}, openSettings() {}, openBrowser() {},
  updateRoom: () => Promise.resolve(), notify() {}, reportError() {},
}
const drawer = (pendingApprovals, rosterExtra = {}) => {
  const r = room(pendingApprovals)
  return {
    hooks: {}, effects: [], rendered: false,
    props: {
      sessionId: 'r1', startTab: 'details', hasStrip: false, roster: { ...writable, ...rosterExtra, roomsById: { r1: r }, rooms: [r] }, actions,
      useSessions: (pick) => pick(fakeList), useSessionStatus: (pick) => pick(map()),
      useActivity: (pick) => pick(map()), useWork: (pick) => pick(map()),
      useBrowserTabs: (pick) => pick(map()), useBrowserPages: (pick) => pick(map()),
    },
  }
}

// The read-only window is the one the host draws without writes: `lockedWindow()` reads this string.
const lockedRoster = { ...writable, readOnly: 'read-only window' }
// A card is found by one of its own class names, so the assertions below cannot drift onto a
// neighbouring surface: exactly one card, and only its buttons are read.
const findAll = (node, keep, out = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, keep, out); return out }
  if (!node || typeof node !== 'object') return out
  if (keep(node)) out.push(node)
  findAll(node.props?.children, keep, out)
  return out
}
const card = (node, marker) => {
  const found = findAll(node, n => typeof n?.props?.className === 'string' && n.props.className.split(' ').includes(marker))
  assert.equal(found.length, 1, `exactly one ${marker} card`)
  return found[0]
}
const buttonLabels = (node) => findAll(node, n => n?.type === 'button').map(n => text(n))
const decisions = (node) => buttonLabels(node).filter(label => ['Approve', 'Reject', 'Retry'].includes(label))
const countOf = (hay, needle) => hay.split(needle).length - 1

// Hook slots of FlyBotApprovals: useSlot x2 = 0-3, claimed = 4-5, pending = 6.
const PENDING = 6
const dock = (list, roster = writable) => {
  const inst = { hooks: {}, effects: [], rendered: false, props: { actions: {}, useRoster: pick => pick(roster) } }
  render(FlyBotApprovals, inst)
  inst.hooks[PENDING].value = list
  return render(FlyBotApprovals, inst)
}
const bubble = (held, roster = writable) => render(HeldReplyActions, { hooks: {}, effects: [], rendered: false, props: { held, actions: {}, roster } })
const held = (extra = {}) => ({ id: 'h1', status: 'pending', by: 'social', from: 'Helper', toName: '@friend.bot', ...extra })

let FlyBotApprovals
let HeldReplyActions
let DetailsDrawer
test.before(async () => {
  ;({ FlyBotApprovals } = await import('../src/client/flybot-slots.js'))
  ;({ HeldReplyActions } = await import('../src/client/held-reply.js'))
  ;({ DetailsDrawer } = await import('../src/client/details-drawer.js'))
})

test('#2409: the dock card says how long the hold has waited', () => {
  const drawn = dock([approval({ createdAt: twelveAgo() })])
  assert.match(text(drawn), /Waiting for approval · 12 min/, 'the head line carries the age')
})

test('#2409: the held-reply bubble says how long the hold has waited', () => {
  const drawn = bubble(held({ createdAt: twelveAgo() }))
  assert.match(text(drawn), /Waiting for your approval · 12 min/, 'the head line carries the age')
})

test('#2409: the room overview card says how long the hold has waited', () => {
  const drawn = expand(render(DetailsDrawer, drawer([{ id: 'a1', text: 'Which file?', createdAt: new Date(twelveAgo()).toISOString() }])))
  assert.match(text(drawn), /Which file\? · 12 min/, 'the row carries the age')
})

test('#2409: a card without a createdAt draws no age at all', () => {
  const openedDock = dock([approval()])
  assert.doesNotMatch(text(openedDock), /\d+ min|just now|Invalid Date|NaN/, 'the dock draws no age when the field is missing')
  const openedBubble = bubble(held())
  assert.doesNotMatch(text(openedBubble), /\d+ min|just now/, 'the bubble draws no age when the field is missing')
  const openedRoom = expand(render(DetailsDrawer, drawer([{ id: 'a1', text: 'Which file?' }])))
  assert.doesNotMatch(text(openedRoom), /\d+ min|just now/, 'the room row draws no age when the field is missing')
})

// #2409 must-fix: a truthiness test drew " · Invalid Date" for any non-empty junk string. The
// three surfaces now share one rule, so these two cases must read exactly like the missing field —
// byte for byte, not merely "no digits", which is what let the unfixed code stay green.
test('#2409: an unparseable createdAt draws exactly what a missing one draws', () => {
  const missing = text(dock([approval()]))
  for (const junk of ['not-a-date', 'NaN']) {
    const drawn = text(dock([approval({ createdAt: junk })]))
    assert.doesNotMatch(drawn, /Invalid Date|NaN/, `the dock draws no junk for ${junk}`)
    assert.equal(drawn, missing, `the dock is unchanged by ${junk}`)
  }
  const missingBubble = text(bubble(held()))
  for (const junk of ['not-a-date', 'NaN']) {
    const drawn = text(bubble(held({ createdAt: junk })))
    assert.doesNotMatch(drawn, /Invalid Date|NaN/, `the bubble draws no junk for ${junk}`)
    assert.equal(drawn, missingBubble, `the bubble is unchanged by ${junk}`)
  }
})

// Product's finding: the read-only path was only covered by items without `createdAt`, so a
// regression that dropped the age in a locked window stayed silence. This pins all three faces:
// exactly one age, and no decision button at all.
test('#2409: a read-only window still says how long the hold has waited', () => {
  const docked = card(dock([approval({ createdAt: twelveAgo() })], lockedRoster), 'bt-flybot-approval')
  assert.equal(countOf(text(docked), ' · 12 min'), 1, 'the dock head carries exactly one age')
  assert.match(text(docked), /Waiting for approval · 12 min/)
  assert.deepEqual(decisions(docked), [], 'a read-only dock card offers no decision')
  assert.deepEqual(buttonLabels(docked), [], 'a read-only dock card is not pressable')

  const bubbled = card(bubble(held({ createdAt: twelveAgo() }), lockedRoster), 'bt-held-actions')
  assert.equal(countOf(text(bubbled), ' · 12 min'), 1, 'the bubble head carries exactly one age')
  assert.match(text(bubbled), /Waiting for your approval · 12 min/)
  assert.deepEqual(decisions(bubbled), [], 'a read-only bubble offers no decision')
  assert.deepEqual(buttonLabels(bubbled), [], 'a read-only bubble is not pressable')

  const opened = expand(render(DetailsDrawer, drawer([{ id: 'a1', text: 'Which file?', createdAt: new Date(twelveAgo()).toISOString() }], { readOnly: 'read-only window' })))
  const roomCard = card(opened, 'bt-shared-wait')
  assert.equal(countOf(text(roomCard), ' · 12 min'), 1, 'the room row carries exactly one age')
  assert.match(text(roomCard), /Which file\? · 12 min/)
  assert.deepEqual(decisions(roomCard), [], 'a read-only room card offers no decision')
  assert.deepEqual(buttonLabels(roomCard), [], 'a read-only room card is not pressable')
})

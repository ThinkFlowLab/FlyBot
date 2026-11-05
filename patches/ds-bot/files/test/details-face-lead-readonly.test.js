// A read-only window's face-to-face Drawer still drew the Room lead card's `Change` control
// (`group-settings.js` `FaceLead`). The card reaches such a window on purpose — the lead, its
// name and the sentence about it are reads — but `Change` opens the seat picker and `Make lead`
// calls `social/face-lead`, a write the host answers with `bot/read-only` (`plugins/social`
// `social/face-lead` is not `{ read: true }`), and the room's own creator keeps `canPick: true` in
// that window because the host still knows who created the room. So the card could only offer a
// control that earns a refusal.
// A locked window now draws the lead's name and its one sentence and nothing else: no `Change`,
// no picker, and not the "Only the person who created this room can change it." hint either, since
// nobody in that window can change it. A writable window keeps all three.
// The harness is `room-approvals-readonly.test.js`'s: React and the host call replaced by stubs,
// hook slots that survive a re-render, and no jsdom.
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
// Every host call the page makes, in order: `[endpoint, payload]`.
const hostCalls = []
let hostAnswer = () => Promise.resolve([])
globalThis.__hostCall = (endpoint, payload) => { hostCalls.push([endpoint, JSON.parse(JSON.stringify(payload ?? null))]); return hostAnswer(endpoint, payload) }
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

const SENTENCE = 'The Bot team in /home/xuke/.flybot is open in another dsh (Web or Desktop, pid 41 on host). Close the other one and reload.'
const WHY = 'Only the person who created this room can change it.'
const host = { id: 'chief', name: 'Chief', ownerId: 'm1', sessionId: 's1' }
// Two people, one Bot each: my own Chief (Ann) and a friend's Writer (Bob), which is the room's
// shape in `settings-readonly-pages.test.js`.
const faceRoom = {
  id: 'face', name: 'Face-to-face · Ann, Bob · 482913', origin: 'face-to-face', named: false,
  members: [], mode: 'everyone', workDir: '/work/face', notice: '', admin: '',
  participants: [
    { kind: 'bot', id: 'chief', handle: '@chief.ann.home', ownerName: 'Ann', ownerHome: 'ann.home' },
    { kind: 'bot', id: 'writer-bob', remote: true, handle: '@writer.bob.home', ownerName: 'Bob', ownerHome: 'bob.home', displayName: 'Writer' },
  ],
  face: { lead: { handle: '@chief.ann.home', picked: true, canPick: true, supported: true } },
}
const base = {
  self: { memberId: 'm1', displayName: 'Ann' }, bots: [host], byId: { chief: host }, rooms: [faceRoom], roomsById: { face: faceRoom },
  readOnly: '', exchangeTurns: {}, prefs: {}, mainBotIds: [], connectors: [], memory: false, questions: {},
}
const writable = base
const locked = { ...base, readOnly: SENTENCE }
const notCreator = (roster) => ({ ...roster, roomsById: { face: { ...faceRoom, face: { lead: { ...faceRoom.face.lead, canPick: false } } } }, rooms: [] })

const actions = {
  openSettings() {}, closeSettings() {}, closeOverlay() {}, openSession() {}, openBrowser() {},
  notify() {}, reportError() {}, setFlags: () => Promise.resolve(),
  updateBot: () => Promise.resolve(), updateRoom: () => Promise.resolve(),
  schedules: () => Promise.resolve({ available: true, tasks: [] }),
}
const map = () => new Map()
const fakeList = { byId: {}, projectionsBySession: {} }
const drawer = (roster) => ({
  hooks: {}, effects: [], dirty: false,
  props: {
    sessionId: 'face', startTab: 'details', hasStrip: false, roster, actions,
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
let DetailsDrawer
const render = (inst) => {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  return expand(DetailsDrawer(inst.props))
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
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node.props?.children).trim() === label)
const buttonLabels = tree => nodes(tree).filter(node => node.type === 'button').map(node => text(node.props?.children).trim())
const leadCard = tree => nodes(tree).find(node => hasClass(node, 'bt-face-lead'))

test.before(async () => {
  ;({ DetailsDrawer } = await import('../src/client/details-drawer.js'))
})

test('a read-only window draws the room lead as text: no Change, no picker, no refusal hint', () => {
  hostCalls.length = 0
  const drawn = render(drawer(locked))
  const card = leadCard(drawn)
  assert.ok(card, 'the Room lead card is still drawn: the lead is a read')
  const shown = text(card)
  assert.match(shown, /Room lead/, 'the card keeps its title')
  assert.match(shown, /Chief \(Ann\)/, "the card names the lead, as the room labels it")
  assert.match(shown, /Writes the plan and gives each Bot its part\./, 'and keeps the sentence about what the lead does')
  assert.deepEqual(buttonLabels(card), [], 'the card itself offers no control')
  assert.equal(button(card, 'Change'), undefined, 'Change is a write the host would refuse')
  assert.equal(shown.includes(WHY), false, 'a locked window does not say who *can* change a lead nobody there can change')
  assert.deepEqual(hostCalls, [], 'drawing the card reached the host with nothing')
})

test('a read-only window draws no Change for the creator and no refusal hint for anyone else', () => {
  const mine = render(drawer(locked))
  assert.equal(button(mine, 'Change'), undefined, 'the creator cannot change the lead in a read-only window either')
  const theirs = render(drawer(notCreator(locked)))
  assert.equal(button(theirs, 'Change'), undefined, 'nor is Change drawn for someone who never could')
  assert.equal(text(theirs).includes(WHY), false, 'the "only the person who created this room" hint is not the locked sentence')
  assert.match(text(theirs), /Chief \(Ann\)/, 'the lead is still named')
})

test('a writable window keeps Change, the picker and exactly one social/face-lead write', async () => {
  hostCalls.length = 0
  const inst = drawer(writable)
  const open = render(inst)
  const change = button(open, 'Change')
  assert.ok(change, 'a writable window keeps Change')
  await change.props.onClick()
  const picked = render(inst)
  const make = button(picked, 'Make lead')
  assert.ok(make, 'pressing Change lists the other seat with Make lead')
  await make.props.onClick()
  assert.deepEqual(hostCalls, [['social/face-lead', { roomId: 'face', bot: '@writer.bob.home' }]],
    'one press is exactly one social/face-lead for the seat that was chosen')
  const others = render(drawer(notCreator(writable)))
  assert.equal(button(others, 'Change'), undefined, 'someone who is not the creator never sees Change')
  assert.match(text(others), /Only the person who created this room can change it\./, 'and is told why, as before')
})

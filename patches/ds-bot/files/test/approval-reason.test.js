// P-538: the host's reason for holding a message was reachable only as a hover `title` on the
// session dock's approval card, and on a held reply's own bubble it was not there at all — `heldOf()`
// copied id/by/status/sessionId/turn/to/error and left `reason` behind, so the waiting card had
// nothing to say about why it waited. A `title` is invisible to a keyboard, a touch screen and a
// screen reader, and the waiting bubble is exactly where a person is looking.
//
// Both drawing points now show the same line under the origin: the host's sentence, one node, and
// the whole sentence again in `title` because the visible text is bounded to 200 code points with an
// ellipsis. A reason that is empty or only whitespace is no reason: neither surface draws an empty
// line, and neither draws a `title` for one. The bound is counted in code points (a character
// outside the BMP costs one) and never splits a surrogate pair, so `'😀'.repeat(201)` loses its last
// emoji whole rather than leaving half of one behind.
//
// React and the host call are replaced by the same tiny stubs the other client tests use.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
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
for (const name of ['useRef', 'useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value
globalThis.__reactStub = reactStub
globalThis.__hostCall = () => Promise.resolve([])
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: 'data:text/javascript,const r=globalThis.__reactStub;export default r;export const {createElement,Fragment,Component,useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect,useContext,useReducer,useId,useSyncExternalStore,useTransition,useDeferredValue,memo,forwardRef,createContext,createPortal,cloneElement,isValidElement,startTransition}=r', shortCircuit: true }
    if (specifier === './api.js' && context.parentURL?.includes('/src/client/')) return { url: 'data:text/javascript,export const call = (endpoint, payload) => globalThis.__hostCall(endpoint, payload)', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
globalThis.window ??= globalThis
globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

function render(Component, inst) {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  return Component(inst.props ?? {})
}
const nodes = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  nodes(node.children, out)
  return out
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object') return String(node)
  return text(node.children)
}
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const reasonNodes = tree => nodes(tree).filter(node => hasClass(node, 'bt-flybot-approval-reason'))
const labels = tree => nodes(tree).filter(node => node.type === 'button').map(node => text(node.children))
const DECISIONS = ['Approve', 'Reject', 'Retry']
const decisionLabels = tree => labels(tree).filter(label => DECISIONS.includes(label)).sort()
const pressables = tree => nodes(tree).filter(node => typeof node.props?.onClick === 'function')

const PENDING = 6
const host = { id: 'b1', name: 'Helper', ownerId: 'm1', sessionId: 's1' }
const writable = { self: { memberId: 'm1' }, bots: [host], byId: { b1: host }, rooms: [], roomsById: {}, readOnly: '' }
const locked = { ...writable, readOnly: 'Another FlyBot window has this Bot team open, so this window is read-only.' }
const REASON = 'The room is locked: one of the members has not opened this chat yet.'
const approval = (extra = {}) => ({
  id: 'a1', status: 'pending', by: 'tree', senderName: 'Helper', targetName: '@chief.uia.home', reason: REASON,
  request: { from: 'bot-helper', to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 },
  ...extra,
})
const dock = (roster, list) => {
  const inst = { hooks: {}, effects: [], rendered: false, props: { actions: {}, useRoster: pick => pick(roster) } }
  render(FlyBotApprovals, inst)
  inst.hooks[PENDING].value = list
  return render(FlyBotApprovals, inst)
}
const bubble = (roster, held = { id: 'h1', status: 'pending', by: 'social', from: 'Helper', toName: '@friend.bot', reason: REASON }) =>
  render(HeldReplyActions, { hooks: {}, effects: [], rendered: false, props: { held, actions: {}, roster } })

let FlyBotApprovals
let HeldReplyActions
test.before(async () => {
  ;({ FlyBotApprovals } = await import('../src/client/flybot-slots.js'))
  ;({ HeldReplyActions } = await import('../src/client/held-reply.js'))
})

test('P-538: the dock card shows the hold reason once, with the whole sentence in the title', () => {
  const card = dock(writable, [approval()])
  const shown = reasonNodes(card)
  assert.equal(shown.length, 1, 'the card draws the reason as its own line')
  assert.equal(text(shown[0]), REASON, 'the visible line is the host sentence, verbatim')
  assert.equal(shown[0].props.title, REASON, 'the whole sentence stays reachable as a title')
  // It is a sentence, not a control: the decision row is unchanged and nothing inside the line is pressable.
  assert.deepEqual(decisionLabels(card), ['Approve', 'Reject'], 'the reason does not replace the decisions')
  assert.deepEqual(pressables(shown[0]), [], 'the reason line carries no control')
})

test('P-538: 200 code points show whole, 201 lose one codepoint to an ellipsis, the title keeps it all', () => {
  const full200 = 'a'.repeat(200)
  const full201 = 'b'.repeat(201)
  const shortCard = dock(writable, [approval({ reason: full200 })])
  assert.equal(text(reasonNodes(shortCard)[0]), full200, 'a sentence of exactly 200 code points is not cut')
  assert.equal(reasonNodes(shortCard)[0].props.title, full200)

  const longCard = dock(writable, [approval({ reason: full201 })])
  const long = reasonNodes(longCard)[0]
  assert.equal(text(long), `${'b'.repeat(200)}…`, 'the 201st code point gives way to the ellipsis')
  assert.equal([...text(long)].length, 201, 'the cut is counted in code points')
  assert.equal(long.props.title, full201, 'the title carries the sentence that was cut')

  // A character outside the BMP costs one code point and must not be split in half.
  const emoji = '😀'.repeat(201)
  const emojiCard = dock(writable, [approval({ reason: emoji })])
  const cut = text(reasonNodes(emojiCard)[0])
  assert.equal(cut, `${'😀'.repeat(200)}…`, 'the cut falls between two emoji, never inside one')
  assert.equal([...cut].length, 201)
  assert.ok(cut.isWellFormed(), 'no lone surrogate survives the cut')
  assert.equal(reasonNodes(emojiCard)[0].props.title, emoji, 'the title keeps all 201 emoji')
})

test('P-538: no reason, an empty reason and a blank reason draw no line and no empty title', () => {
  for (const [name, reason] of [['absent', undefined], ['null', null], ['empty', ''], ['blank', '   \n\t ']]) {
    const card = dock(writable, [approval({ reason })])
    assert.deepEqual(reasonNodes(card), [], `${name}: the card draws no reason line`)
    assert.equal(card.props.title, undefined, `${name}: the card carries no empty title`)
    const shown = text(card)
    assert.match(shown, /Waiting for approval/, `${name}: the headline stays`)
    assert.match(shown, /Helper → @chief\.uia\.home/, `${name}: the origin stays`)
    assert.match(shown, /Which file\?/, `${name}: the message stays`)
    assert.deepEqual(reasonNodes(bubble(writable, { id: 'h1', status: 'pending', by: 'social', from: 'Helper', toName: '@friend.bot', reason })), [], `${name}: the waiting bubble draws no reason line`)
  }
})

test('P-538: a read-only window keeps the reason and still draws no decision', () => {
  const card = dock(locked, [approval()])
  const shown = reasonNodes(card)
  assert.equal(shown.length, 1, 'the reason is not a write: a locked window still shows it')
  assert.equal(text(shown[0]), REASON)
  assert.deepEqual(decisionLabels(card), [], 'the decisions are still gone')
  assert.deepEqual(pressables(card), [], 'nothing on the card is pressable')
})

test('P-538: the held reply bubble draws the same line, same bound, same title', () => {
  const waiting = bubble(writable)
  const shown = reasonNodes(waiting)
  assert.equal(shown.length, 1, 'the waiting card draws the host reason')
  assert.equal(text(shown[0]), REASON, 'the same sentence as the dock card')
  assert.equal(shown[0].props.title, REASON, 'the same title')
  assert.deepEqual(decisionLabels(waiting), ['Approve', 'Reject'], 'the decisions stay while waiting')

  const long = 'c'.repeat(201)
  const longShown = reasonNodes(bubble(writable, { id: 'h1', status: 'pending', by: 'social', from: 'Helper', toName: '@friend.bot', reason: long }))[0]
  assert.equal(text(longShown), `${'c'.repeat(200)}…`, 'the bubble uses the same 200-code-point bound')
  assert.equal(longShown.props.title, long, 'and keeps the whole sentence in its title')
})

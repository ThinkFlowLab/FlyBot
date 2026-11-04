// #2310: a read-only window still drew `Retry` / `Reject` / `Approve` on approval cards in the
// session dock and on a held reply's own bubble in a chat. The cards reach such a window on
// purpose — `approvals` is in the host read whitelist — but `decide` is not, so the only thing the
// three buttons could do is earn `bot/read-only` after the click. In a read-only window the card
// keeps the message, who sent it to whom and (while it waits) its headline; the buttons give way to
// one line carrying the host's own sentence, the shape #2279, #2284 and #2307 already use.
// The count is read per status, never as one total: a card draws Retry only when it failed and can
// be retried, and Reject/Approve only while it waits, and the two are mutually exclusive
// (`shared/approval-waiting.js`), so a pending card offers 2 and a failed-but-retryable card 1 —
// three on one card would be a button that cannot exist. A held reply has the same two shapes: the
// waiting card, and the settled `bt-held-note` row whose own Retry sits outside the action row.
// React is replaced by the same tiny renderer the other client tests use (no jsdom here); the host
// call is replaced too, so "pressed it and nothing was called" is what the last case measures.
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
// Every host call the two drawing points make, in order: `[endpoint, payload]`.
const hostCalls = []
globalThis.__hostCall = (endpoint, payload) => { hostCalls.push([endpoint, payload]); return Promise.resolve([]) }
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: 'data:text/javascript,const r=globalThis.__reactStub;export default r;export const {createElement,Fragment,Component,useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect,useContext,useReducer,useId,useSyncExternalStore,useTransition,useDeferredValue,memo,forwardRef,createContext,createPortal,cloneElement,isValidElement,startTransition}=r', shortCircuit: true }
    // The client's own host-call module, so a press is observable without a server.
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
  const out = Component(inst.props ?? {})
  inst.rendered = true
  return out
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
const labels = tree => nodes(tree).filter(node => node.type === 'button').map(node => text(node.children))
const DECISIONS = ['Approve', 'Reject', 'Retry']
const decisionLabels = tree => labels(tree).filter(label => DECISIONS.includes(label)).sort()
const hints = tree => nodes(tree).filter(node => hasClass(node, 'bt-read-only'))
const pressables = tree => nodes(tree).filter(node => typeof node.props?.onClick === 'function')

// Hook slots of FlyBotApprovals: useSlot x2 (entries, docks) = 0-3, claimed = 4-5, pending = 6.
const PENDING = 6

const LOCK = 'Another FlyBot window has this Bot team open, so this window is read-only.'
const host = { id: 'b1', name: 'Helper', ownerId: 'm1', sessionId: 's1' }
const writable = { self: { memberId: 'm1' }, bots: [host], byId: { b1: host }, rooms: [], roomsById: {}, readOnly: '' }
const locked = { ...writable, readOnly: LOCK }
const blank = { ...writable, readOnly: '   ' }
const unset = { ...writable }
delete unset.readOnly
const FAILURE = 'The file changed while it was being read.'
const approval = (extra = {}) => ({
  id: 'a1', status: 'pending', by: 'tree', senderName: 'Helper', targetName: '@chief.uia.home',
  request: { from: 'bot-helper', to: { handle: '@chief.uia.home' }, text: 'Which file?', hop: 0 },
  ...extra,
})
const WAITING = () => approval()
const FAILED = () => approval({ status: 'failed', error: FAILURE })
const dock = (roster, list) => {
  const inst = { hooks: {}, effects: [], rendered: false, props: { actions: {}, useRoster: pick => pick(roster) } }
  render(FlyBotApprovals, inst)
  inst.hooks[PENDING].value = list
  return render(FlyBotApprovals, inst)
}
const bubble = (roster, held = { id: 'h1', status: 'pending', by: 'social', from: 'Helper', toName: '@friend.bot' }) =>
  render(HeldReplyActions, { hooks: {}, effects: [], rendered: false, props: { held, actions: {}, roster } })
const settled = (roster, extra = {}) => bubble(roster, { id: 'h1', status: 'failed', by: 'social', from: 'Helper', toName: '@friend.bot', error: FAILURE, ...extra })

let FlyBotApprovals
let HeldReplyActions
test.before(async () => {
  ;({ FlyBotApprovals } = await import('../src/client/flybot-slots.js'))
  ;({ HeldReplyActions } = await import('../src/client/held-reply.js'))
})

test('#2310: a read-only window draws neither Reject nor Approve on a pending card or its bubble', () => {
  const card = dock(locked, [WAITING()])
  assert.deepEqual(decisionLabels(card), [], `a read-only pending card still offers ${JSON.stringify(decisionLabels(card))}`)
  assert.deepEqual(decisionLabels(bubble(locked)), [], 'a read-only pending bubble still offers a decision')
  // What the card is for stays: the headline, who sent it to whom and the message.
  const shown = text(card)
  assert.match(shown, /Waiting for approval/)
  assert.match(shown, /Helper → @chief\.uia\.home/)
  assert.match(shown, /Which file\?/)
})

test('#2310: a read-only window draws no Retry on a failed card or on the settled bubble row', () => {
  const card = dock(locked, [FAILED()])
  assert.deepEqual(decisionLabels(card), [], `a read-only failed card still offers ${JSON.stringify(decisionLabels(card))}`)
  // The third drawing point: the `bt-held-note` Retry sits outside the action row, next to
  // "Not sent: delivery failed", and reaches the same `decide('retry')`.
  const note = settled(locked)
  assert.deepEqual(decisionLabels(note), [], 'the settled bubble still offers Retry')
  assert.match(text(note), /Not sent: delivery failed/, 'the state sentence stays')
})

test('#2310: a writable window keeps exactly two decisions on a pending card and its bubble', () => {
  assert.deepEqual(decisionLabels(dock(writable, [WAITING()])), ['Approve', 'Reject'], 'a pending card offers Reject and Approve')
  assert.deepEqual(decisionLabels(bubble(writable)), ['Approve', 'Reject'], 'a pending bubble offers Reject and Approve')
  assert.equal(nodes(dock(writable, [WAITING()])).filter(node => hasClass(node, 'bt-flybot-approval-actions')).length, 1, 'the action row is untouched')
})

test('#2310: a writable window keeps exactly one decision on a failed card and its settled bubble', () => {
  assert.deepEqual(decisionLabels(dock(writable, [FAILED()])), ['Retry'], 'a failed card offers Retry only: failed and waiting are exclusive')
  assert.deepEqual(decisionLabels(settled(writable)), ['Retry'], 'the settled bubble keeps its own Retry')
})

test('#2310: the read-only line carries the host sentence, and a read-only window cannot call `decide`', () => {
  const cardHints = hints(dock(locked, [WAITING()]))
  const bubbleHints = hints(bubble(locked))
  const noteHints = hints(settled(locked))
  assert.deepEqual([cardHints.length, bubbleHints.length, noteHints.length], [1, 1, 1], 'one line on each drawing point')
  for (const [where, node] of [['card', cardHints[0]], ['bubble', bubbleHints[0]], ['settled', noteHints[0]]]) {
    assert.equal(node.props.role, 'status', `${where}: the line is announced`)
    // The host's own words, not a second wording this client invents.
    assert.equal(text(node.children), LOCK, `${where}: the line is the host sentence`)
  }
  // A writable window, a blank sentence and a roster without the field all draw nothing: one predicate.
  for (const [name, roster] of [['writable', writable], ['blank', blank], ['unset', unset]]) {
    assert.deepEqual(hints(dock(roster, [WAITING()])), [], `${name}: no line on the card`)
    assert.deepEqual(hints(bubble(roster)), [], `${name}: no line on the waiting bubble`)
    assert.deepEqual(hints(settled(roster)), [], `${name}: no line on the settled bubble`)
  }
  // Nothing on a read-only tree can be pressed, and pressing whatever is there calls nothing.
  hostCalls.length = 0
  const trees = [dock(locked, [WAITING()]), dock(locked, [FAILED()]), bubble(locked), settled(locked)]
  assert.deepEqual(trees.map(tree => pressables(tree).length), [0, 0, 0, 0], 'a read-only card draws no pressable control at all')
  for (const tree of trees) for (const node of pressables(tree)) node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(hostCalls.filter(([endpoint]) => endpoint.includes('decide')), [], 'no decision was sent')
})

// Part 2 of the same slice (#2310): the two plugin card slots draw their own buttons, so the
// window lock has to reach them too — the dock's `flybot.approvals` component and the inline card
// on a held reply's bubble. Passing the flag does not hide a plugin's buttons; it makes them
// hideable. A component that records its props is enough to prove the flag arrives, and the last
// render is the one measured (the first pass has no cards yet).
test('#2310: a plugin card is told whether this window is read-only', async () => {
  const { registry } = await import('../src/client/flybot-registry.js')
  const slots = registry()
  const probe = () => null
  // The plain renderer only calls the top component, so a plugin card sits in the tree as an element
  // under its boundary. Expand the plain function boundaries (`Safe`, `h` elements) the way React
  // would, stop at classes (the boundary itself), and read the plugin element's props.
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (node.type === probe) return node
    if (typeof node.type === 'function' && !node.type.prototype?.render) return expand({ ...node.type(node.props ?? {}), key: node.key })
    return { ...node, children: expand(node.children) }
  }
  const pluginCard = tree => {
    const found = nodes(expand(tree)).find(node => node.type === probe)
    assert.ok(found, 'the plugin card is drawn')
    return found
  }
  const offDock = slots.register('flybot.approvals', { id: 'readonly-probe-dock', order: 1, policy: 'tree', component: probe })
  const offInline = slots.register('flybot.approvals', { id: 'readonly-probe-inline', order: 2, inline: true, policy: 'social', component: probe })
  try {
    assert.equal(pluginCard(dock(locked, [WAITING()])).props.readOnly, true, 'the dock card is told the window is read-only')
    assert.equal(pluginCard(dock(writable, [WAITING()])).props.readOnly, false, 'a writable window tells the card it may decide')
    assert.equal(pluginCard(bubble(locked)).props.readOnly, true, "the held reply's inline card is told the window is read-only")
    assert.equal(pluginCard(bubble(writable)).props.readOnly, false, 'a writable window tells the inline card it may decide')
  } finally {
    offDock()
    offInline()
  }
})

// #1607: the room approval dock's "someone else is waiting" card was decided from a snapshot that can
// be one poll behind. `mine` is built from `social/status` and `social/approvals`, which load on their
// own; an empty `mine` therefore means "not loaded yet" as often as it means "this room's pending card
// belongs to another home", and the dock drew "Waiting for the owner's approval" with no buttons for a
// card of our own. React is replaced by the tiny slot renderer the other client tests use (no jsdom).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

// The browser bundle registers a factory under its package name; load it the way web-entry.test.js does
// and hand ChatApprovalDock the hook-slot react above.
function loadDock() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? reactStub : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')
}

const fresh = () => ({ hooks: {}, effects: [] })
function render(Component, inst) {
  live.inst = inst
  live.idx = 0
  inst.effects = []
  const out = Component(inst.props ?? {})
  inst.rendered = true
  return out
}
// A component element is a function in `type`: it has to be called to see the card it draws. Its own
// hook slots are separate from the dock's, the way React keeps them apart.
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx }
  live.inst = fresh()
  live.idx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  return out
}
function drawn(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(drawn).join('')
  if (typeof node.type === 'function') return `${node.props?.canDecide === false ? '[no-buttons]' : ''}${drawn(mount(node))}`
  return (node.children ?? []).map(drawn).join('')
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// A face-to-face room with one pending card in it (this is the count the dock saw).
const room = () => ({ id: 'r1', origin: 'face-to-face', pendingCount: 1, face: { roomId: 'frm1' }, participants: [] })
// The two lists the dock reads are the two things this test drives: `social/status` answers at once,
// the home's own approval list is held back, which is the lagging poll of the issue. A held line as
// `flybot/social/approvals` lists it names its room in `request.meta.roomId` (`localHoldView`, #188).
const ourHold = () => ({ id: 'a1', status: 'pending', senderName: 'SelfTest A2', request: { text: 'hello room', to: { handle: 'the room' }, via: 'composer', meta: { roomId: 'frm1' } } })
function harness() {
  const state = { calls: [], resolveApprovals: null }
  globalThis.__flybot__ = {
    call: (endpoint) => {
      state.calls.push(endpoint)
      if (endpoint === 'social/status') return Promise.resolve({ approvals: [] })
      if (endpoint === 'approvals') return new Promise(resolve => { state.resolveApprovals = resolve })
      return Promise.resolve({})
    },
  }
  const inst = { hooks: {}, effects: [], rendered: false, props: { sessionId: 's1', roster: { bots: [], byId: {} }, room: room(), claim: () => {}, actions: {} } }
  return { state, inst }
}
const runEffects = inst => { for (const [, fn] of inst.effects) fn() }

test('#1607: a dock whose lists have not answered yet claims no other owner and draws no buttonless card', () => {
  const app = loadDock()
  const { inst } = harness()
  try {
    // First frame, both lists still loading: that is "unknown", not "somebody else's card".
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.doesNotMatch(tree, /Waiting for the owner's approval/, 'no card claims another owner before the lists answered')
    assert.doesNotMatch(tree, /\[no-buttons\]/, 'no buttonless card is drawn from a list that has not loaded')
  } finally { delete globalThis.__flybot__ }
})

test('#1607: our own pending room card turns into Approve / Reject once the list answers', async () => {
  const app = loadDock()
  const { state, inst } = harness()
  try {
    render(app.ChatApprovalDock, inst)
    runEffects(inst)
    state.resolveApprovals([ourHold()])
    await tick()
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.match(tree, /Approve/, 'our own card is decidable')
    assert.match(tree, /Reject/, 'our own card is decidable')
    assert.doesNotMatch(tree, /Waiting for the owner's approval/, 'our own card is never narrated as another owner waiting')
  } finally { delete globalThis.__flybot__ }
})

test('#1607: an answered, empty list keeps the honest "another owner" card for a room card we do not hold', async () => {
  const app = loadDock()
  const { state, inst } = harness()
  try {
    render(app.ChatApprovalDock, inst)
    runEffects(inst)
    // The list has answered: it holds nothing for this room, so the pending count is somebody else's.
    state.resolveApprovals([])
    await tick()
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.match(tree, /Waiting for the owner's approval/, 'the other-owner card still appears once the list is authoritative')
    assert.doesNotMatch(tree, /Approve/, 'no decision is offered for a card we cannot see')
  } finally { delete globalThis.__flybot__ }
})

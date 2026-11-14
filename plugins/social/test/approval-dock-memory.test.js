// #3082: `conversation.input.dock` is a session-scoped slot, so the chat's dock is unmounted when the
// person opens another chat and mounted again on the way back. A send that failed lived in that
// component's own state, and a Retry already spent lived in its own ref, so the way back drew the very
// card #3075 fixed as "Waiting for approval" again and offered a Retry that had already gone out.
// What a failed send remembers therefore has to outlive the component: this file mounts one dock,
// lets a send fail, throws the mount away and mounts a fresh one the way a chat switch does.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0, rIdx: 0, eIdx: 0 }
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
  useRef(init) {
    const { inst } = live
    const i = live.rIdx++
    if (!(i in inst.refs)) inst.refs[i] = { current: init }
    return inst.refs[i]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.eIdx++
    inst.effects.push([i, fn, deps])
  },
}
for (const name of ['useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

// The browser bundle registers its factory once; load it the way the other client tests do and hand the
// dock the hook slots above. One load is one module: two mounts of it share what the module keeps.
function loadDock() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? reactStub : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')
}

const fresh = () => ({ hooks: {}, refs: {}, effects: [], dirty: false })
function render(Component, inst, props = inst.props) {
  live.inst = inst
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  inst.effects = []
  inst.props = props
  inst.dirty = false
  const out = Component(props)
  inst.rendered = true
  return out
}
// A child component element is a function in `type`: it is called to see the card it draws, with its own
// hook slots, the way React gives it its own.
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx, rIdx: live.rIdx, eIdx: live.eIdx }
  live.inst = fresh()
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  live.rIdx = outer.rIdx
  live.eIdx = outer.eIdx
  return out
}
function drawn(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(drawn).join('')
  if (typeof node.type === 'function') return drawn(mount(node))
  return (node.children ?? []).map(drawn).join('')
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
// The dock's effects are its two polls, its claim and its memory subscription; a frame is drawn and then
// every effect runs, as React does on mount.
async function frame(app, inst, props) {
  render(app.ChatApprovalDock, inst, props)
  for (const [, fn] of inst.effects) fn()
  await tick()
  return render(app.ChatApprovalDock, inst, props)
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  if (typeof node.type === 'function') return find(mount(node), predicate)
  return find(node.children, predicate)
}
const byLabel = label => node => node.type === 'button' && node.children?.[0] === label
const byFlybot = id => node => node.props?.['data-flybot'] === id

// A face-to-face room with one pending card in it, held by Bot Social's own list (`social/status`), which
// is the list whose send endpoint fails here: `source` is undefined, so the dock keeps the reason (#3075).
const room = () => ({ id: 'r1', origin: 'face-to-face', pendingCount: 1, face: { roomId: 'frm1' }, participants: [] })
const roomHold = () => ({ id: 'a1', kind: 'face_room_message', status: 'pending', roomId: 'frm1', from: 'SelfTest A2', to: 'the room', text: 'hello room' })

function harness({ decide = 'fail' } = {}) {
  const state = { calls: [], decide, status: [roomHold()], local: [] }
  globalThis.__flybot__ = {
    call: (endpoint) => {
      state.calls.push(endpoint)
      if (endpoint === 'social/status') return Promise.resolve({ approvals: [...state.status] })
      if (endpoint === 'approvals') return Promise.resolve([...state.local])
      if (endpoint === 'social/decide-approval') {
        return state.decide === 'fail' ? Promise.reject(new Error('Bot Social refused this send')) : Promise.resolve({})
      }
      return Promise.resolve({})
    },
  }
  state.props = () => ({ sessionId: 's1', roster: { bots: [], byId: {} }, room: room(), claim: () => {}, actions: {} })
  state.sent = () => state.calls.filter(endpoint => endpoint === 'social/decide-approval')
  return state
}

// The chat switch this file is about: the dock mounted for `sessionId` and thrown away, then the same
// chat opened again as a new mount with its own hook slots.
async function openChat(app, state) {
  const inst = { ...fresh(), props: state.props() }
  const tree = await frame(app, inst, state.props())
  return { inst, tree }
}

test('#3082: a failed send still says Not sent after the chat is left and opened again', async () => {
  const app = loadDock()
  const state = harness()
  try {
    const first = await openChat(app, state)
    assert.match(drawn(first.tree), /Waiting for approval/, 'the card starts as a wait')
    const approve = find(first.tree, byLabel('Approve'))
    assert.ok(approve, 'the waiting card offers Approve')
    await approve.props.onClick()
    const failed = render(app.ChatApprovalDock, first.inst, state.props())
    assert.match(drawn(failed), /Not sent/, 'the failed send says so on the card')
    assert.match(drawn(failed), /Bot Social refused this send/, 'and says why')

    // The person opens another chat and comes back: a new dock, the same session, the same hold still
    // pending upstream (the server did not take the send, so nothing else answers for it).
    const second = await openChat(app, state)
    const text = drawn(second.tree)
    assert.match(text, /Not sent/, 'the way back still says the send did not go')
    assert.match(text, /Bot Social refused this send/, 'the reason survives the chat switch too')
    assert.doesNotMatch(text, /Waiting for approval/, 'a card that failed is never drawn as a fresh wait again')
  } finally { delete globalThis.__flybot__ }
})

test('#3082: a Retry that already went out is not sent a second time after the chat is left and opened again', async () => {
  const app = loadDock()
  const state = harness()
  try {
    const first = await openChat(app, state)
    await find(first.tree, byLabel('Approve')).props.onClick()
    const retried = render(app.ChatApprovalDock, first.inst, state.props())
    const retry = find(retried, byFlybot('hold-retry'))
    assert.ok(retry, 'the failed card offers Retry')
    state.decide = 'ok'
    await retry.props.onClick()
    const sent = state.sent().length
    assert.equal(sent, 2, 'the Retry went out once, after the failed Approve before it')

    // The next poll writes the same hold back as failed — Bot Social's own status has not settled yet —
    // so the card the person sees again offers Retry for a send that has already gone out.
    state.status = [{ ...roomHold(), status: 'failed' }]
    const second = await openChat(app, state)
    const again = find(second.tree, byFlybot('hold-retry'))
    assert.ok(again, 'the card the poll wrote back as failed still offers Retry')
    await again.props.onClick()
    assert.equal(state.sent().length, sent, 'a Retry already sent sends nothing the second time, not even from a new mount')
  } finally { delete globalThis.__flybot__ }
})

test('#3082: a record goes when its hold leaves the lists, so a later card is a wait again', async () => {
  const app = loadDock()
  const state = harness()
  try {
    const first = await openChat(app, state)
    await find(first.tree, byLabel('Approve')).props.onClick()
    assert.match(drawn(render(app.ChatApprovalDock, first.inst, state.props())), /Not sent/)

    // Both polls answer without the hold: it was decided in another window or is gone, so nothing is
    // left to explain. The next poll brings the id back as a plain wait.
    state.status = []
    await frame(app, first.inst, state.props())
    state.status = [roomHold()]
    await frame(app, first.inst, state.props())
    const text = drawn(render(app.ChatApprovalDock, first.inst, state.props()))
    assert.match(text, /Waiting for approval/, 'a card whose record was dropped is a wait again')
    assert.doesNotMatch(text, /Not sent/, 'a stale record never outlives the card it explained')
  } finally { delete globalThis.__flybot__ }
})

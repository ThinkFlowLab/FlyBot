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

// #1638: the room object the dock is handed already carries `pendingApprovals` — in
// `core/src/host/channel.js` that array is the very one `pendingCount` counts — so the room view knows
// it holds a card while the dock's own two polls are still a beat behind. A card this dock would draw
// is never called somebody else's just because those 5 s lists have not caught up; a card the dock
// never draws (decided on its own bubble or in the Bot's chat) keeps the line, because there the
// sentence is true.
//
// The room's list is Bot Social's own (`plugins/social/src/social.js` `pendingApprovals` through the
// room provider), not the host's `flybot/approvals` wrapper: a held line of this face room is
// `kind: 'face_room_message'` with the room id in `roomId` and no `request` envelope.
const roomLine = () => ({ id: 'a1', kind: 'face_room_message', status: 'pending', roomId: 'frm1', from: 'SelfTest A2', to: 'the room', text: 'hello room' })
const roomWithCard = () => ({ ...room(), pendingApprovals: [roomLine()] })

test('#1638: a room holding its own pending card is never announced as another owner waiting', async () => {
  const app = loadDock()
  const { state, inst } = harness()
  inst.props.room = roomWithCard()
  try {
    render(app.ChatApprovalDock, inst)
    runEffects(inst)
    // One beat behind: both of the dock's own lists answer without this room's card (the lagging poll).
    state.resolveApprovals([])
    await tick()
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.doesNotMatch(tree, /Waiting for the owner's approval/, "the room's own card is never narrated as another owner waiting")
    assert.doesNotMatch(tree, /\[no-buttons\]/, 'the lagging poll draws no buttonless card')
  } finally { delete globalThis.__flybot__ }
})

// A card this dock never draws, whatever list names it: a held reply is decided on its own bubble (#418),
// and the dock's own list drops it by that marker (`held`, `!item.inline`). Bot Social's room list carries
// no such marker today (only the host's `localHoldView` sets it), so this pins that the two rules agree if
// one ever arrives: a card already on screen is not silenced as "somebody else's" nor as nothing.
test('#1638: a room card drawn on its own bubble keeps the waiting line', async () => {
  const app = loadDock()
  const { state, inst } = harness()
  inst.props.room = { ...room(), pendingApprovals: [{ ...roomLine(), inline: 's9' }] }
  try {
    render(app.ChatApprovalDock, inst)
    runEffects(inst)
    state.resolveApprovals([])
    await tick()
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.match(tree, /Waiting for the owner's approval/, 'a card drawn on its bubble keeps the honest line here')
    assert.doesNotMatch(tree, /Approve/, 'the dock does not decide a card it never draws')
  } finally { delete globalThis.__flybot__ }
})

// The line is not silenced wholesale, or a room that counts a card this chat never draws would lose
// its only honest voice: our Bot's held direct message to a friend is decided in the Bot's chat
// (#254, #418), and the room's provider counts it by the sender's handle (`social.js` `roomApprovals`),
// so the room holds it while this dock draws nothing (#1607). Marking it "another owner's" would be
// wrong, but "waiting for the owner's approval" is true.
test('#1638: a room card this chat never draws keeps the waiting line', async () => {
  const app = loadDock()
  const { state, inst } = harness()
  // A group room with the Bot that wrote the held line among its participants; the hold is an
  // `outbound_message` to a friend, which `pendingApprovals` tags with the local Bot's `fromId`.
  inst.props.room = {
    id: 'g1',
    pendingCount: 1,
    pendingApprovals: [{ id: 'b1', kind: 'outbound_message', status: 'pending', from: '@self.home', fromId: 'bot1', to: '@friend.home', text: 'a line to a friend' }],
    participants: [{ kind: 'bot', remote: true, handle: '@self.home' }],
  }
  try {
    render(app.ChatApprovalDock, inst)
    runEffects(inst)
    state.resolveApprovals([])
    await tick()
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.match(tree, /Waiting for the owner's approval/, 'a card decided elsewhere keeps the honest line')
    assert.doesNotMatch(tree, /Approve/, 'no decision is offered where the card is not drawn')
  } finally { delete globalThis.__flybot__ }
})

// A quiet room (nothing pending) still draws nothing at all.
test('#1638: a room with no pending card and a zero count draws no card', () => {
  const app = loadDock()
  const { inst } = harness()
  inst.props.room = { ...room(), pendingCount: 0, pendingApprovals: [] }
  try {
    const tree = drawn(render(app.ChatApprovalDock, inst))
    assert.equal(tree, '', 'a quiet room draws no card')
  } finally { delete globalThis.__flybot__ }
})

// #1640: the waiting card said nothing about where the room's card is. A held reply is decided on
// its own bubble in this chat (#418); a local Bot's hold is decided in that Bot's chat (#254).
const coder = { id: 'bot1', name: 'Coder', color: 'blue' }
const botHold = () => ({ id: 'a2', status: 'pending', senderName: 'SelfTest A2', request: { text: 'hi', from: 'bot1', to: { handle: '@friend.home' }, via: 'auto' } })
const inlineHold = () => ({ id: 'a3', status: 'pending', senderName: 'SelfTest A2', request: { text: 'hi', from: 'bot1', to: { handle: '@friend.home' }, via: 'auto-reply', meta: { replyIn: { sessionId: 's1' } } } })
// The button an approval card offers, found the way the rest of this file walks the tree.
const button = (node, id) => {
  if (Array.isArray(node)) return node.map(child => button(child, id)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  if (node.props?.['data-flybot'] === id) return node
  if (typeof node.type === 'function') return button(mount(node), id)
  return button(node.children, id)
}
async function settle(hold) {
  const app = loadDock()
  const { state, inst } = harness()
  const opened = []
  inst.props.roster = { bots: [coder], byId: { bot1: coder }, roomsById: {} }
  inst.props.actions = { openSession: id => opened.push(id) }
  render(app.ChatApprovalDock, inst)
  runEffects(inst)
  state.resolveApprovals(hold)
  await tick()
  return { app, inst, opened, tree: render(app.ChatApprovalDock, inst) }
}

test("#1640: a hold written by a local Bot names that Bot's chat and opens it", async () => {
  const { opened, tree } = await settle([botHold()])
  try {
    const text = drawn(tree)
    assert.match(text, /Waiting for the owner's approval/, 'the waiting card still says it is a card we cannot decide here')
    assert.match(text, /Decide in Coder's chat\./, 'the card names the Bot chat the card is decided in')
    const open = button(tree, 'chat-approval-open-chat')
    assert.ok(open, 'the card offers the way there')
    assert.equal(open.props.type, 'button')
    assert.equal(drawn(open), "Open Coder's chat")
    open.props.onClick()
    assert.deepEqual(opened, ['bot1'], 'one click opens that Bot chat')
    assert.doesNotMatch(text, /Approve/, 'the waiting card never offers a decision here')
  } finally { delete globalThis.__flybot__ }
})

test('#1640: a held reply names the reply bubble above and offers no jump, because it is on screen', async () => {
  const { tree } = await settle([inlineHold()])
  try {
    const text = drawn(tree)
    assert.match(text, /Waiting for the owner's approval/)
    assert.match(text, /Decide on the reply bubble above\./, 'the card names the reply bubble it is decided on')
    assert.equal(button(tree, 'chat-approval-open-chat'), undefined, 'nothing to jump to: the bubble is here')
    assert.doesNotMatch(text, /Opens? .* chat/, 'no destination is invented')
  } finally { delete globalThis.__flybot__ }
})

test('#1640: a held reply from another chat is not this room\'s bubble', async () => {
  // `local` is every local hold, not only this chat's: a bubble in another chat is not "above" here.
  const { tree } = await settle([{ ...inlineHold(), id: 'a4', request: { ...inlineHold().request, meta: { replyIn: { sessionId: 's9' } } } }])
  try {
    const text = drawn(tree)
    assert.match(text, /Waiting for the owner's approval/)
    assert.doesNotMatch(text, /Decide on the reply bubble above/, 'a bubble in another chat is not this chat\'s bubble')
    assert.equal(button(tree, 'chat-approval-open-chat'), undefined, 'and it is no chat to jump to either')
  } finally { delete globalThis.__flybot__ }
})

test('#1640: a room count this dock cannot place keeps the neutral sentence and no button', async () => {
  const { tree } = await settle([])
  try {
    const text = drawn(tree)
    assert.match(text, /Waiting for the owner's approval/, 'the neutral sentence stays')
    assert.equal(button(tree, 'chat-approval-open-chat'), undefined, 'an unknown destination draws no jump')
    assert.doesNotMatch(text, /Decide in |Decide on the reply bubble/, 'no destination is invented')
  } finally { delete globalThis.__flybot__ }
})

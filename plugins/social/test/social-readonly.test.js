// #2219: a read-only window (the shell names it in `roster.readOnly`) still offered Bot Social's
// write entries. This test mounts the real client.js with the same tiny hook renderer the other
// client tests use (no jsdom) and counts the entries it draws, and the '+' menu rows it offers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRegistry, newChatActionRows } from '../../../core/src/client/flybot-registry.js'

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
  useRef(value) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: value }
    return inst.hooks[i]
  },
}
for (const name of ['useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

function loadApp() {
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
  return Component(inst.props ?? {})
}
// A component element is a function in `type`: it has to be called to see the card it draws. Its own
// hook slots are separate from the caller's, the way React keeps them apart.
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx }
  live.inst = fresh()
  live.idx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  return out
}
// Every node drawn, with the component trees expanded (same walk as the drawn() helper next door).
function walk(node, visit, seen = []) {
  if (node == null || node === false || node === true) return seen
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, seen); return seen }
  if (typeof node === 'string' || typeof node === 'number') return seen
  visit(node)
  if (typeof node.type === 'function') return walk(mount(node), visit, seen)
  return walk(node.children ?? [], visit, seen)
}
const flybotTags = tree => {
  const tags = []
  walk(tree, node => { const tag = node?.props?.['data-flybot']; if (typeof tag === 'string') tags.push(tag) })
  return tags
}
const buttonLabels = tree => {
  const labels = []
  walk(tree, node => { if (node.type === 'button') labels.push(String((node.children ?? []).flat().join(' ')).trim()) })
  return labels
}
const byTag = (tree, tag) => {
  const found = []
  walk(tree, node => { if (node?.props?.['data-flybot'] === tag) found.push(node) })
  return found
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const runEffects = inst => { for (const [, fn] of inst.effects) fn() }

const LOCK = 'Another FlyBot window has this home open; this window is read-only.'
const readOnlyRoster = () => ({ bots: [], byId: {}, readOnly: LOCK })
const writableRoster = () => ({ bots: [], byId: {} })
const status = () => ({
  approvals: [],
  shareRequests: [{ id: 'sr1', name: 'Eve', owner: '@eve.home', botId: 'bot_eve', botName: 'Eve Bot', from: '@eve.home' }],
  acceptNotices: [{ id: 'an1', name: 'Eve', owner: '@eve.home', botName: 'Eve Bot' }],
})
function fixtures({ approvals = [] } = {}) {
  const state = { calls: [], resolveApprovals: null }
  globalThis.__flybot__ = {
    call: (endpoint, payload) => {
      state.calls.push([endpoint, payload])
      if (endpoint === 'social/status') return Promise.resolve(status())
      if (endpoint === 'social/face-rooms') return Promise.resolve({ rooms: [] })
      if (endpoint === 'approvals') return new Promise(resolve => { state.resolveApprovals = resolve })
      return Promise.resolve({})
    },
  }
  state.resolveApprovals = (list) => { state.pendingApprovals = list }
  void approvals
  return state
}
const liveRoom = () => ({
  roomId: 'r1', faceRoomId: 'frm1', status: 'open', members: [{ handle: '@eve.home', displayName: 'Eve' }], face: { roomId: 'frm1' },
})

test('#2219: a read-only window draws no Bot Social write control', async () => {
  const app = loadApp()
  const state = fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: { remoteChats: [], actions: {}, roster: readOnlyRoster() } }
    render(app.FriendsBots, inst)
    runEffects(inst)
    await tick()
    const tree = render(app.FriendsBots, inst)
    const tags = flybotTags(tree)
    // A live room card is the fourth write entry: Leave.
    const card = { hooks: {}, effects: [], props: { room: liveRoom(), roster: readOnlyRoster(), actions: {}, onChange: () => {} } }
    const cardTree = render(app.FaceRoomCard, card)
    const cardTags = flybotTags(cardTree)
    // #2219 red first: today 3 in the section (Dismiss, Ask them to share a Bot, Dismiss on the
    // share request) and 1 on the room card (Leave) — 4 together.
    const writes = [
      ...tags.filter(tag => tag === 'accept-notice-dismiss' || tag === 'accept-notice-ask' || tag === 'share-request-dismiss'),
      ...cardTags.filter(tag => tag === 'face-leave'),
    ]
    assert.deepEqual(writes, [], `no write control in a read-only window, saw ${writes.join(',')}`)
    // The read half stays: the section still reads its status and still draws the rows.
    assert.equal(state.calls.filter(([endpoint]) => endpoint === 'social/status').length, 1, 'the section reads its status once')
    assert.ok(tags.includes('share-request'), 'the share request is still listed')
    assert.ok(tags.includes('share-request-open'), 'opening the Sharing page is navigation and stays')
    assert.ok(tags.includes('accept-notice'), 'the accept notice is still listed')
  } finally { delete globalThis.__flybot__ }
})

test('#2219: a read-only window draws no way to decide a held send', async () => {
  const app = loadApp()
  const state = fixtures()
  try {
    const room = { id: 'r1', origin: 'face-to-face', pendingCount: 1, face: { roomId: 'frm1' }, participants: [] }
    const dock = { hooks: {}, effects: [], props: { sessionId: 's1', roster: readOnlyRoster(), room, claim: () => {}, actions: {} } }
    // The window state reaches the bubble card too: the sidebar is mounted in every window.
    const section = { hooks: {}, effects: [], props: { remoteChats: [], actions: {}, roster: readOnlyRoster() } }
    render(app.FriendsBots, section)
    runEffects(section)
    await tick()
    render(app.FriendsBots, section)
    // The dock's own pending card: today Approve / Reject / Auto-send from now on.
    render(app.ChatApprovalDock, dock)
    runEffects(dock)
    state.resolveApprovals([{ id: 'a1', status: 'pending', senderName: 'SelfTest A2', request: { text: 'hello room', to: { handle: 'the room' }, via: 'composer', meta: { roomId: 'frm1' } } }])
    await tick()
    const dockTree = render(app.ChatApprovalDock, dock)
    const dockLabels = buttonLabels(dockTree)
    assert.deepEqual(dockLabels.filter(label => label === 'Approve' || label === 'Reject'), [], `no decision on a held send, saw ${dockLabels.join(',')}`)
    assert.deepEqual(byTag(dockTree, 'hold-always'), [], 'no Auto-send from now on')
    assert.deepEqual(byTag(dockTree, 'approve-all'), [], 'no Approve all')
    // The held reply's own bubble card (flybot.approvals): same rule.
    const bubble = { hooks: {}, effects: [], props: { held: { id: 'a9', from: 'Chief', to: '@eve.home', toName: 'Eve', status: 'pending' }, decide: async () => {}, call: async () => ({}), actions: {} } }
    const bubbleTree = render(app.HeldReplyCard, bubble)
    const bubbleLabels = buttonLabels(bubbleTree)
    assert.deepEqual(bubbleLabels.filter(label => label === 'Approve' || label === 'Reject'), [], `no decision on the reply bubble, saw ${bubbleLabels.join(',')}`)
    assert.deepEqual(byTag(bubbleTree, 'hold-always'), [], 'no Auto-send from now on')
  } finally { delete globalThis.__flybot__ }
})

test('#2219: a read-only window offers no Bot Social row in the + menu', async () => {
  const app = loadApp()
  const slots = createRegistry()
  globalThis.__flybot__ = { slots, call: async () => ({}) }
  try {
    app.apply({})
    const socialRows = context => newChatActionRows(context).filter(row => ['social-face-join', 'social-face-start', 'social-add-friend'].includes(row.key))
    // #2219 red first: today 3 rows in both windows.
    assert.equal(socialRows({ roster: readOnlyRoster() }).length, 0, 'no Bot Social row opens a write panel in a read-only window')
    assert.equal(socialRows({ roster: writableRoster() }).length, 3, 'a writable window keeps all three rows')
  } finally { delete globalThis.__flybot__ }
})

test('#2219: a writable window keeps every entry, and Dismiss still sends the same call', async () => {
  const app = loadApp()
  const state = fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: { remoteChats: [], actions: {}, roster: writableRoster() } }
    render(app.FriendsBots, inst)
    runEffects(inst)
    await tick()
    const tree = render(app.FriendsBots, inst)
    const tags = flybotTags(tree)
    const writes = tags.filter(tag => tag === 'accept-notice-dismiss' || tag === 'accept-notice-ask' || tag === 'share-request-dismiss')
    assert.equal(writes.length, 3, `every write control is drawn in a writable window, saw ${tags.join(',')}`)
    const card = { hooks: {}, effects: [], props: { room: liveRoom(), roster: writableRoster(), actions: {}, onChange: () => {} } }
    assert.equal(byTag(render(app.FaceRoomCard, card), 'face-leave').length, 1, 'a writable window keeps Leave')
    const dismiss = byTag(tree, 'share-request-dismiss')[0]
    assert.ok(dismiss, 'the Dismiss button is drawn')
    await dismiss.props.onClick()
    const sent = state.calls.filter(([endpoint]) => endpoint === 'social/share-request-dismiss')
    assert.equal(sent.length, 1, 'clicking Dismiss sends the same call as today')
    assert.deepEqual(sent[0][1], { id: 'sr1' }, 'the call carries the row it dismisses')
  } finally { delete globalThis.__flybot__ }
})

test('#2219: a writable window keeps the decision buttons', async () => {
  const app = loadApp()
  const state = fixtures()
  try {
    const room = { id: 'r1', origin: 'face-to-face', pendingCount: 1, face: { roomId: 'frm1' }, participants: [] }
    const dock = { hooks: {}, effects: [], props: { sessionId: 's1', roster: writableRoster(), room, claim: () => {}, actions: {} } }
    render(app.ChatApprovalDock, dock)
    runEffects(dock)
    state.resolveApprovals([{ id: 'a1', status: 'pending', senderName: 'SelfTest A2', request: { text: 'hello room', to: { handle: 'the room' }, via: 'composer', meta: { roomId: 'frm1' } } }])
    await tick()
    const tree = render(app.ChatApprovalDock, dock)
    const labels = buttonLabels(tree)
    assert.ok(labels.includes('Approve') && labels.includes('Reject'), `a writable dock still decides, saw ${labels.join(',')}`)
    assert.equal(byTag(tree, 'hold-always').length, 1, 'Auto-send from now on stays')
  } finally { delete globalThis.__flybot__ }
})

// #2228: the room view's own head row. A live room's overview drew Leave, the Auto-send switch and
// the invite in a read-only window, and the three host endpoints behind them can only be refused.
const overviewRoom = () => ({
  id: 'r1',
  origin: 'face-to-face',
  face: { roomId: 'frm1', status: 'open', joinCode: '482913' },
  participants: [{ id: 'bot_a', name: 'Alice', remote: false, handle: '@alice.home' }],
})
const WRITE_TAGS = ['face-leave', 'face-auto-send', 'face-auto-bot', 'face-invite', 'face-invite-mint']
const overview = (roster, room = overviewRoom()) => {
  const inst = { hooks: {}, effects: [], props: { room, roster, actions: {} } }
  return render(loadApp().FaceRoomOverview, inst)
}

test('#2228: a read-only window draws no room-overview write control', async () => {
  fixtures()
  try {
    const tree = overview(readOnlyRoster())
    const tags = flybotTags(tree)
    // Not hidden: not drawn at all. Red first on 986399246f: 5 tags and Leave / Create link.
    const writes = tags.filter(tag => WRITE_TAGS.includes(tag))
    assert.deepEqual(writes, [], `no write control in a read-only room view, saw ${writes.join(',')}`)
    const writeButtons = buttonLabels(tree).filter(label => label === 'Leave' || label === 'Create link')
    assert.deepEqual(writeButtons, [], `no write button in a read-only room view, saw ${writeButtons.join(',')}`)
    // The read half stays: the head is the status chip, not an empty row.
    assert.ok(tags.includes('face-status'), 'the status chip is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#2228: a writable window keeps the three room-overview controls', async () => {
  fixtures()
  try {
    const tree = overview(writableRoster())
    const tags = flybotTags(tree)
    for (const tag of WRITE_TAGS) assert.ok(tags.includes(tag), `a writable window keeps ${tag}`)
    const labels = buttonLabels(tree)
    assert.ok(labels.includes('Leave'), 'a writable window keeps Leave')
    assert.ok(labels.includes('Create link'), 'a writable window keeps Create link')
  } finally { delete globalThis.__flybot__ }
})

test('#2228: a read-only waiting room keeps its code, drops Leave and Enter chat', async () => {
  fixtures()
  try {
    const room = { ...overviewRoom(), face: { roomId: 'frm1', status: 'candidate', joinCode: '482913' } }
    const tree = overview(readOnlyRoster(), room)
    const tags = flybotTags(tree)
    assert.deepEqual(byTag(tree, 'face-wait-foot'), [], 'no Leave / Enter chat foot in a read-only window')
    assert.deepEqual(buttonLabels(tree).filter(label => label === 'Leave' || label === 'Enter chat'), [])
    assert.ok(tags.includes('face-wait-code'), 'the room number is still drawn')
    assert.ok(tags.includes('face-wait-roster'), 'who has joined is still drawn')
  } finally { delete globalThis.__flybot__ }
})

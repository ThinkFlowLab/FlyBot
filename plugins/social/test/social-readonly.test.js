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

// #2418: a Bot's own settings → Sharing. A read-only window drew the invite mint, the one-click share
// and People with access (Revoke); the host refuses every one of them with `bot/read-only`.
const detailsTree = (roster) => {
  const app = loadApp()
  const inst = { hooks: {}, effects: [], props: { bot: { id: 'bot_a', name: 'Alice' }, actions: {}, roster } }
  render(app.BotSocialDetails, inst)
  return render(app.BotSocialDetails, inst)
}
// #2446: People with access is a read card (`social/access` is `{ read: true }`), so only the
// invite and the one-click share are writes here; its Revoke and Auto-send are checked below.
const SHARING_WRITES = ['mint-invite', 'share-with-friend']
// #2446: the write tags inside People with access, read by the same probe the other read-only tests use.
const ACCESS_WRITES = ['manage-access-revoke', 'revoke-grant', 'access-auto-send']

test('#2418: a read-only window draws no Sharing write control', async () => {
  fixtures()
  try {
    const tree = detailsTree(readOnlyRoster())
    const tags = flybotTags(tree)
    // Red first on a091ddc07d: 3 tags and the Copy invite link button. #2446: People with access is
    // a read (social/access is `{ read: true }`), so the card stays and only its writes go; the read
    // half is checked below.
    const writes = tags.filter(tag => SHARING_WRITES.includes(tag))
    assert.deepEqual(writes, [], `no Sharing write control in a read-only window, saw ${writes.join(',')}`)
    const sharingWrites = ['mint-invite', 'share-with-friend', 'manage-access-revoke', 'revoke-grant', 'access-auto-send']
    assert.deepEqual(tags.filter(tag => sharingWrites.includes(tag)), [], `no write inside the Sharing card, saw ${tags.filter(tag => sharingWrites.includes(tag)).join(',')}`)
    const writeButtons = buttonLabels(tree).filter(label => label.startsWith('Copy invite link') || label === 'Share with a friend')
    assert.deepEqual(writeButtons, [], `no Sharing write button in a read-only window, saw ${writeButtons.join(',')}`)
    // The read half stays: the list of who has this Bot is drawn, without a way to change it.
    assert.equal(byTag(tree, 'manage-access').length, 1, 'People with access is still drawn in a read-only window')
    assert.deepEqual(byTag(tree, 'revoke-grant'), [], 'no Revoke in a read-only window')
    // The card is not silently blank: it says why.
    const hint = byTag(tree, 'sharing-readonly')
    assert.equal(hint.length, 1, 'the Sharing card says the window is read-only')
    assert.match(String((hint[0].children ?? []).flat().join(' ')), /read-only/, 'the sentence names the reason')
  } finally { delete globalThis.__flybot__ }
})

test('#2418: a writable window keeps the Sharing controls', async () => {
  fixtures()
  try {
    const tree = detailsTree(writableRoster())
    const tags = flybotTags(tree)
    for (const tag of SHARING_WRITES) assert.ok(tags.includes(tag), `a writable window keeps ${tag}`)
    assert.equal(byTag(tree, 'manage-access').length, 1, 'a writable window keeps People with access')
    assert.deepEqual(tags.filter(tag => ACCESS_WRITES.includes(tag)), [], 'a writable window draws the read card before its list loads, with no write tag yet')
    assert.deepEqual(byTag(tree, 'sharing-readonly'), [], 'a writable window shows no read-only note')
  } finally { delete globalThis.__flybot__ }
})

// #2418: a local group's Members card (flybot.room.members) — Invite by link mints a real join link.
const membersTree = (roster) => {
  const app = loadApp()
  const inst = { hooks: {}, effects: [], props: { room: { id: 'r1', members: [] }, roster, actions: {}, call: async () => ({}), host: async () => ({}) } }
  return render(app.LocalInviteRow, inst)
}

test('#2418: a read-only window draws no Members-card invite control', async () => {
  fixtures()
  try {
    const tree = membersTree(readOnlyRoster())
    assert.deepEqual(byTag(tree, 'room-invite-mint'), [], 'no Create link in a read-only window')
    assert.deepEqual(buttonLabels(tree).filter(label => label === 'Create link' || label === 'New link'), [])
    assert.equal(byTag(tree, 'room-invite-readonly').length, 1, 'the Members card says the window is read-only')
  } finally { delete globalThis.__flybot__ }
})

test('#2418: a writable window keeps the Members-card invite control', async () => {
  fixtures()
  try {
    const tree = membersTree(writableRoster())
    assert.equal(byTag(tree, 'room-invite-mint').length, 1, 'a writable window keeps Create link')
    assert.deepEqual(byTag(tree, 'room-invite-readonly'), [])
  } finally { delete globalThis.__flybot__ }
})

// #2446 (P-557): #2418 dropped the whole Sharing card in a read-only window, but People with access
// is a read (`social/access` is registered `{ read: true }`). The list stays; only its writes go.
const ACCESS = {
  grants: [
    { id: 'g1', grantee: '@eve.home', name: 'Eve', handle: '@eve.home', home: '@eve.home', person: '@eve.home', autoSend: true, rooms: [] },
    { id: 'g2', grantee: '@bob.home', name: 'Bob', handle: '@bob.home', home: '@bob.home', person: '@bob.home', autoSend: false, rooms: [] },
  ],
  rooms: [],
}
const accessFixtures = () => {
  const calls = []
  globalThis.__flybot__ = {
    call: (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'social/access') return Promise.resolve(ACCESS)
      return Promise.resolve({})
    },
  }
  return calls
}
const accessTree = async (props) => {
  const app = loadApp()
  const inst = { hooks: {}, effects: [], props: { bot: { id: 'bot_a', name: 'Alice' }, ...props } }
  render(app.ManageAccess, inst)
  runEffects(inst)
  await tick()
  return render(app.ManageAccess, inst)
}

test('#2446: a read-only Sharing card keeps the People with access list', async () => {
  const calls = accessFixtures()
  try {
    const tree = await accessTree({ readOnly: true })
    const tags = flybotTags(tree)
    assert.ok(tags.includes('manage-access'), 'the People with access card is still drawn')
    assert.equal(tags.filter(tag => tag === 'access-grant').length, 2, 'every person with access is still listed')
    const names = []
    walk(tree, node => { if (node?.props?.className === 'fs-name') names.push(String((node.children ?? []).flat().join(' ')).trim()) })
    assert.deepEqual(names.filter(name => name === 'Eve' || name === 'Bob'), ['Eve', 'Bob'], 'each row names its person')
    assert.ok(tags.includes('access-meta'), 'the handle under the name is still read from social/access')
    // The read half is a read: only social/access is asked, and nobody can take access away here.
    assert.deepEqual(calls.filter(([endpoint]) => endpoint !== 'social/access'), [], 'a read-only card writes nothing')
    assert.deepEqual(tags.filter(tag => ['manage-access-revoke', 'revoke-grant', 'access-auto-send'].includes(tag)), [], 'no Revoke and no Auto-send switch in a read-only window')
    assert.deepEqual(buttonLabels(tree).filter(label => label === 'Revoke' || label === 'Keep'), [], 'no revoke step in a read-only window')
  } finally { delete globalThis.__flybot__ }
})

test('#2446: a read-only Sharing card shows Auto-send as a state, not a switch', async () => {
  accessFixtures()
  try {
    const tree = await accessTree({ readOnly: true })
    assert.deepEqual(byTag(tree, 'access-auto-send'), [], 'no Auto-send switch in a read-only window')
    const states = byTag(tree, 'access-auto-state')
    assert.equal(states.length, 2, 'one Auto-send state per person')
    assert.deepEqual(states.map(node => String((node.children ?? []).flat().join(' ')).trim()), ['Auto-send on', 'Auto-send off'], 'the state says what the pair is set to')
  } finally { delete globalThis.__flybot__ }
})

test('#2446: a writable Sharing card keeps Revoke and the Auto-send switch', async () => {
  accessFixtures()
  try {
    const tree = await accessTree({})
    assert.equal(byTag(tree, 'revoke-grant').length, 2, 'a writable window keeps one Revoke per person')
    assert.equal(byTag(tree, 'access-auto-send').length, 2, 'a writable window keeps the Auto-send switch')
    assert.deepEqual(byTag(tree, 'access-auto-state'), [], 'a writable window draws no state text instead of its switch')
  } finally { delete globalThis.__flybot__ }
})

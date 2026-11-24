// #3315: the waiting room (2 s) and the room overview (3 s) refreshed `social/face-rooms` at their
// full rate while the tab was hidden, and a tab that came back waited out the rest of the period
// instead of reading once at once. Both effects now go through `pollWhileVisible`: no timer while
// `document.hidden`, one read as the tab comes back, and the cadence restarts from that read.
//
// The client is a classic script; react is the tiny hook runner the other client tests use, and
// `setInterval` / `visibilitychange` are recorded instead of waited on (no jsdom). The assertions
// count calls per mount and per window, never a golden log.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0, stateIdx: 0, queue: null }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  useState(init) {
    const inst = live.inst
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: live.queue ? live.queue[live.stateIdx++] : (typeof init === 'function' ? init() : init) }
    const slot = inst.hooks[i]
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
  },
  useEffect(fn, deps) {
    live.inst.effects.push([live.idx++, fn, deps])
  },
  useRef(value) {
    const inst = live.inst
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: value }
    return inst.hooks[i]
  },
  useMemo(fn) { live.idx++; return fn() },
  useCallback(fn) { live.idx++; return fn },
}

// The browser bundle registers its factory under its package name; load it the way the other client
// tests do and hand the factory the hook stub above.
function loadApp() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: entry => modules.set(entry.id, entry.factory) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')(name => (name === 'react' ? reactStub : {}))
}

// A document whose `hidden` can change and whose `visibilitychange` listeners the test fires, and a
// timer table the test advances — both installed as globals for the duration of a case.
function makeDocument({ hidden = false } = {}) {
  const listeners = new Map()
  return {
    hidden,
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild() {} },
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    listening: type => (listeners.get(type) ?? new Set()).size,
    emit(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn() },
  }
}
function makeTimers() {
  let next = 0
  const timers = new Map()
  return {
    setInterval(fn, ms) { const id = `t${++next}`; timers.set(id, { fn, ms }); return id },
    clearInterval(id) { timers.delete(id) },
    periods: () => [...timers.values()].map(timer => timer.ms),
    tick() { for (const timer of [...timers.values()]) timer.fn() },
  }
}
// One case: a fresh document, timer table, call log and module instance.
function scene({ hidden = true } = {}) {
  const doc = makeDocument({ hidden })
  const timers = makeTimers()
  const calls = []
  const app = loadApp()
  const saved = {
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    flybot: globalThis.__flybot__,
  }
  globalThis.document = doc
  globalThis.setInterval = timers.setInterval
  globalThis.clearInterval = timers.clearInterval
  globalThis.__flybot__ = {
    call: (endpoint, payload) => { calls.push([endpoint, payload]); return Promise.resolve({ rooms: [], bots: [] }) },
    canRetry: () => true,
  }
  return {
    doc, timers, calls, app,
    faceCalls: () => calls.filter(([endpoint]) => endpoint === 'social/face-rooms').length,
    restore() {
      globalThis.document = saved.document
      globalThis.setInterval = saved.setInterval
      globalThis.clearInterval = saved.clearInterval
      globalThis.__flybot__ = saved.flybot
    },
  }
}
// React would run the first-mount effects after drawing; here that is the call site's own immediate
// read plus its timer, which is exactly what the cases below observe.
function mount(app, name, props, queue = null) {
  live.inst = { hooks: {}, effects: [], dirty: false }
  live.idx = 0
  live.stateIdx = 0
  live.queue = queue
  const out = app[name](props)
  live.queue = null
  const cleanups = []
  for (const [, fn] of live.inst.effects) {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
  }
  return { out, cleanups }
}
const unmount = cleanups => { for (const off of cleanups.reverse()) off() }

const roster = { readOnly: '', byId: {} }
const openRoom = () => ({ id: 'r1', origin: 'face-to-face', face: { status: 'open', roomId: 'fr1' }, participants: [] })
const overview = app => mount(app, 'FaceRoomOverview', { room: openRoom(), roster, actions: {} })

test('#3315: a hidden tab does not poll the room overview', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = overview(s.app)
    s.timers.tick()
    s.timers.tick()
    assert.equal(s.faceCalls(), 0, `a hidden tab made ${s.faceCalls()} face-room call(s) in one mount`)
    assert.deepEqual(s.timers.periods(), [], 'a hidden tab holds no poll timer')
    unmount(cleanups)
  } finally { s.restore() }
})

test('#3315: coming back reads once at once and restarts the 3 s cadence', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = overview(s.app)
    // The hidden mount must add nothing: whatever the log holds was the mounted call, not this return.
    s.calls.length = 0
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.faceCalls(), 1, `coming back made ${s.faceCalls()} face-room call(s), not one`)
    assert.deepEqual(s.timers.periods(), [3000], 'the timer restarts from that read')
    s.timers.tick()
    assert.equal(s.faceCalls(), 2, 'and one period later reads again, once')
    unmount(cleanups)
  } finally { s.restore() }
})

test('#3315: going hidden stops the cadence, and unmount removes the listener', () => {
  const s = scene({ hidden: false })
  try {
    const { cleanups } = overview(s.app)
    assert.equal(s.faceCalls(), 1, 'a visible mount reads at once')
    assert.deepEqual(s.timers.periods(), [3000])
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(s.faceCalls(), 1, 'a tab that went hidden makes no further call')
    assert.deepEqual(s.timers.periods(), [], 'its timer is cleared, not just guarded')
    assert.equal(s.doc.listening('visibilitychange'), 1, 'the listener is still there to know it came back')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.faceCalls(), 2, 'the tab that comes back reads once at once')
    assert.deepEqual(s.timers.periods(), [3000], 'from a rebuilt timer, not a hidden phase’s remainder')
    unmount(cleanups)
    assert.equal(s.doc.listening('visibilitychange'), 0, 'unmount removes the listener')
    assert.deepEqual(s.timers.periods(), [], 'and its timer')
  } finally { s.restore() }
})

// The waiting room's own effect: the same helper at 2 s. Its eleven state slots are answered in the
// order the component asks for them, as the waiting-room i18n test does.
const WAIT_ROOM = {
  roomId: 'local1', faceRoomId: 'fr1', joinCode: '482913', status: 'open', mineHandles: ['@chief.home'],
  members: [{ id: 'b1', remote: false, handle: '@chief.home', name: 'Chief', ownerName: 'Ann' }],
}
const BOT = { id: 'b1', name: 'Chief', handle: '@chief.home', isMain: true }
const waiting = app => mount(app, 'FaceToFaceGroup', { mode: 'join', roster, remoteChats: [] },
  ['waiting', [BOT], ['b1'], '482913', false, null, [], WAIT_ROOM, 0, null, { link: '', status: null }])

test('#3315: the waiting room stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = waiting(s.app)
    s.timers.tick()
    s.timers.tick()
    assert.equal(s.faceCalls(), 0, `a hidden waiting room made ${s.faceCalls()} face-room call(s)`)
    assert.deepEqual(s.timers.periods(), [], 'a hidden waiting room holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.faceCalls(), 1, `coming back made ${s.faceCalls()} face-room call(s), not one`)
    assert.deepEqual(s.timers.periods(), [2000], 'the waiting room keeps its 2 s cadence')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(s.faceCalls(), 1, 'and going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// ③ follow-up to #3315: the paused-chat card reloaded on a bare 5 s `setInterval`. Its read returned
// early while `document.hidden`, so a hidden tab kept the timer ticking for nothing and a tab that
// came back waited out the rest of the period instead of reading once at once.
const pausedChat = app => mount(app, 'PausedChat', { bot: { id: 'b1', name: 'Chief', remote: { handle: '@chief.home' } } })

test('#3315: the paused-chat card stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const pausedCalls = () => s.calls.filter(([endpoint]) => endpoint === 'social/paused').length
    const { cleanups } = pausedChat(s.app)
    assert.equal(pausedCalls(), 0, 'a hidden card makes no read')
    assert.deepEqual(s.timers.periods(), [], 'a hidden card holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(pausedCalls(), 1, `coming back made ${pausedCalls()} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [5000], 'the 5 s cadence restarts from that read')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(pausedCalls(), 1, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// ④ follow-up to #3315: the connecting state of Settings → Bot Social read `social/server` again on a
// bare 2 s `setInterval` with no visibility check at all, so a hidden tab polled at full rate and a
// tab that came back did not read before the next tick.
const SETTINGS_VIEW = {
  state: 'connecting', server: 'https://social.example', source: 'settings', displayName: 'Home',
  defaultServer: null, known: [], platform: null,
}
const settingsOpen = app => mount(app, 'SocialServerSettings', { t: undefined, Section: undefined, Row: undefined, actions: {}, roster }, [
  SETTINGS_VIEW, null, null, false, '', '', null, false, null, null, '', null,
])

test('#3315: the connecting settings page stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const serverCalls = () => s.calls.filter(([endpoint]) => endpoint === 'social/server').length
    const { cleanups } = settingsOpen(s.app)
    const afterMount = serverCalls()
    assert.deepEqual(s.timers.periods(), [], 'a hidden settings page holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(serverCalls(), afterMount + 1, `coming back made ${serverCalls() - afterMount} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [2000], 'the 2 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(serverCalls(), afterMount + 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(serverCalls(), afterMount + 2, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// The peer-thinking row (#443) is the same shape again: a bare 2 s `setInterval` with the visibility
// check inside `load`, so a hidden tab keeps the timer ticking for nothing and a tab that comes back
// waits out the rest of the period before its first read.
const peerRoom = () => ({ id: 'r1', origin: 'face-to-face', face: { status: 'open', roomId: 'fr1' }, participants: [] })
const peerThinking = app => mount(app, 'PeerThinking', { room: peerRoom(), bot: { id: 'b1', name: 'Chief', remote: { handle: '@chief.home' } } })

test('the peer-thinking row stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const typingCalls = () => s.calls.filter(([endpoint]) => endpoint === 'social/typing').length
    const { cleanups } = peerThinking(s.app)
    assert.equal(typingCalls(), 0, 'a hidden row makes no read')
    assert.deepEqual(s.timers.periods(), [], 'a hidden row holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(typingCalls(), 1, `coming back made ${typingCalls()} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [2000], 'the 2 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(typingCalls(), 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(typingCalls(), 2, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// The face-rooms page (#3327 follow-up ⑤) is the same shape once more: an immediate `load(true)` on
// mount and a bare 5 s `setInterval` whose tick returns while `document.hidden`, so a hidden tab keeps
// a timer ticking for nothing and a tab that comes back waits out the rest of the period.
const faceRoomsPage = app => mount(app, 'FaceRooms', { actions: {}, roster, remoteChats: [] })

test('the face-rooms page stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = faceRoomsPage(s.app)
    assert.deepEqual(s.timers.periods(), [], 'a hidden page holds no poll timer')
    assert.equal(s.faceCalls(), 0, `a hidden page made ${s.faceCalls()} face-room call(s)`)
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.faceCalls(), 1, `coming back made ${s.faceCalls()} face-room call(s), not one`)
    assert.deepEqual(s.timers.periods(), [5000], 'the 5 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(s.faceCalls(), 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(s.faceCalls(), 2, 'going hidden again stops it')
    unmount(cleanups)
    assert.equal(s.doc.listening('visibilitychange'), 0, 'unmount removes the listener')
    assert.deepEqual(s.timers.periods(), [], 'and its timer')
  } finally { s.restore() }
})

// The chat approval dock (#1607) is the same shape once more: a bare 5 s `setInterval` whose `load`
// returns while `document.hidden`, so the timer ticks for a tab nobody is reading and the dock's own
// `visibilitychange` listener does the catch-up.
const dock = app => mount(app, 'ChatApprovalDock', {
  sessionId: 's1', roster, room: openRoom(), bot: { id: 'b1', name: 'Chief' }, actions: {},
})

test('the chat approval dock stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const statusCalls = () => s.calls.filter(([endpoint]) => endpoint === 'social/status').length
    const { cleanups } = dock(s.app)
    assert.equal(statusCalls(), 0, `a hidden dock made ${statusCalls()} read(s)`)
    assert.deepEqual(s.timers.periods(), [], 'a hidden dock holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(statusCalls(), 1, `coming back made ${statusCalls()} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [5000], 'the 5 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(statusCalls(), 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(statusCalls(), 2, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// The friends-and-Bots settings panel (#1054) polls `social/status` on a bare 15 s `setInterval` whose
// tick returns while `document.hidden`, and it has no visibility listener, so a tab that comes back
// waits out the rest of the period before its first read.
const friendsBots = app => mount(app, 'FriendsBots', { remoteChats: [], actions: {}, roster })

test('the friends settings panel stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const statusCalls = () => s.calls.filter(([endpoint]) => endpoint === 'social/status').length
    const { cleanups } = friendsBots(s.app)
    assert.equal(statusCalls(), 0, `a hidden panel made ${statusCalls()} read(s)`)
    assert.deepEqual(s.timers.periods(), [], 'a hidden panel holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(statusCalls(), 1, `coming back made ${statusCalls()} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [15000], 'the 15 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(statusCalls(), 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(statusCalls(), 2, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// A poll exists to refresh what the person can see, so a tab nobody is looking at should make no read
// and hold no timer. The chat approval dock and the friends/Bot Social panel (share requests, accept
// notices) each ran a bare `setInterval` — the dock skipped the read inside `load`, the panel skipped
// it inside a tick — so a hidden tab kept a timer alive, and the panel had no `visibilitychange`
// listener at all: coming back waited out the rest of the period before its first read.
//
// `pollWhileVisible` is the one rule both now use: no timer while hidden, one read as the tab returns,
// and the cadence restarting from that read. React is replaced by the tiny slot renderer the other
// client tests use, and `document` / `setInterval` are recorded instead of waited on (no jsdom).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const inst = live.inst
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
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
function scene({ hidden = false } = {}) {
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
    call: (endpoint, payload) => { calls.push([endpoint, payload]); return Promise.resolve({}) },
    canRetry: () => true,
  }
  return {
    doc, timers, calls, app,
    reads: endpoint => calls.filter(([name]) => name === endpoint).length,
    restore() {
      globalThis.document = saved.document
      globalThis.setInterval = saved.setInterval
      globalThis.clearInterval = saved.clearInterval
      globalThis.__flybot__ = saved.flybot
    },
  }
}
const unmount = cleanups => { for (const off of cleanups.reverse()) off() }

function mount(app, name, props) {
  live.inst = { hooks: {}, effects: [], dirty: false }
  live.idx = 0
  app[name](props)
  const cleanups = []
  for (const [, fn] of live.inst.effects) {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
  }
  return { cleanups }
}

const roster = { bots: [], byId: {}, remoteBots: [] }
const openRoom = () => ({ id: 'r1', origin: 'face-to-face', participants: [] })

test('the chat approval dock stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = mount(s.app, 'ChatApprovalDock', {
      sessionId: 's1', roster, room: openRoom(), bot: { id: 'b1', name: 'Chief' }, actions: {},
    })
    assert.equal(s.reads('social/status'), 0, `a hidden dock made ${s.reads('social/status')} read(s)`)
    assert.deepEqual(s.timers.periods(), [], 'a hidden dock holds no poll timer')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.reads('social/status'), 1, `coming back made ${s.reads('social/status')} read(s), not one`)
    assert.deepEqual(s.timers.periods(), [5000], 'the 5 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(s.reads('social/status'), 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(s.reads('social/status'), 2, 'going hidden again stops it')
    unmount(cleanups)
  } finally { s.restore() }
})

// The panel's own one-shot mount read of `social/status` (which Bots are mine, my handle) is not the
// poll; the cases below count only the poll's reads, which is what a hidden tab must not make.
test('the friends and requests panel stops while hidden and reads once when the tab returns', () => {
  const s = scene({ hidden: true })
  try {
    const { cleanups } = mount(s.app, 'FriendsBots', { remoteChats: [], actions: {}, roster })
    // Whatever this panel reads once for itself is not the poll: the poll is the only thing that could
    // keep repeating, so it is counted relative to the mount and must add nothing while hidden.
    const mountReads = s.reads('social/status')
    assert.deepEqual(s.timers.periods(), [], 'a hidden panel holds no poll timer')
    s.doc.emit('visibilitychange')
    assert.equal(s.reads('social/status'), mountReads, 'a hidden tab reads nothing when a show event fires')
    s.doc.hidden = false
    s.doc.emit('visibilitychange')
    assert.equal(s.reads('social/status'), mountReads + 1, 'coming back makes one poll read at once')
    assert.deepEqual(s.timers.periods(), [15000], 'the 15 s cadence restarts from that read')
    s.timers.tick()
    assert.equal(s.reads('social/status'), mountReads + 2, 'and one period later reads again, once')
    s.doc.hidden = true
    s.doc.emit('visibilitychange')
    s.timers.tick()
    assert.equal(s.reads('social/status'), mountReads + 2, 'going hidden again stops it')
  } finally { s.restore() }
})

test('unmounting a polled component removes its visibility listener', () => {
  const s = scene({ hidden: false })
  try {
    const { cleanups } = mount(s.app, 'ChatApprovalDock', {
      sessionId: 's1', roster, room: openRoom(), bot: { id: 'b1', name: 'Chief' }, actions: {},
    })
    assert.equal(s.doc.listening('visibilitychange'), 1, 'the mounted dock listens once')
    unmount(cleanups)
    assert.equal(s.doc.listening('visibilitychange'), 0, 'unmount removes the listener')
    assert.deepEqual(s.timers.periods(), [], 'and its timer')
  } finally { s.restore() }
})

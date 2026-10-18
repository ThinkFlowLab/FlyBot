// The browser data layer (client.js): loaded the way the dsh module loader does, then driven with
// a manual scheduler and a fake `flybot.call`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }), useState: v => [v, () => {}], useEffect() {}, useCallback: f => f }
function loadClient() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules
}
const client = () => loadClient().get('@flybot/timeline')

const good = (extra = {}) => ({ version: 1, lanes: [], turns: [], exchanges: [], edges: [], utilization: [], ...extra })
function rig({ visible = true } = {}) {
  const calls = []
  const pending = []
  const scheduled = []
  const timers = {
    setTimeout: (fn, ms) => { const timer = { ms, cleared: false, fn: () => { timer.cleared = true; fn() } }; scheduled.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.cleared = true },
  }
  const flybot = { call: (endpoint, body) => new Promise((resolve, reject) => { calls.push([endpoint, body]); pending.push({ resolve, reject }) }) }
  const state = { visible }
  const watchers = new Set()
  const store = client().createStore(flybot, { timers, visible: () => state.visible, onVisible: fn => { watchers.add(fn); return () => watchers.delete(fn) } })
  const live = () => scheduled.filter(timer => !timer.cleared)
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  return { store, calls, pending, scheduled, live, state, tick, watchers }
}

test('the loader entry registers @flybot/timeline with the flybot service injected', () => {
  const modules = loadClient()
  assert.deepEqual([...modules.keys()], ['@flybot/timeline'])
  const mod = modules.get('@flybot/timeline')
  assert.deepEqual(mod.inject, ['flybot'])
  assert.equal(mod.ENDPOINT, 'timeline/window')
  assert.equal(mod.POLL_MS, 2000)
})

test('nothing is requested until a panel opens, then one poll runs every 2 s', async () => {
  const { store, calls, pending, live, tick } = rig()
  assert.equal(calls.length, 0)
  const close = store.open()
  assert.equal(store.state.status, 'loading')
  assert.deepEqual(calls, [['timeline/window', { windowMs: 900_000 }]])
  pending[0].resolve(good({ now: 1 }))
  await tick()
  assert.equal(store.state.status, 'ok')
  assert.equal(store.state.window.now, 1)
  assert.equal(live().length, 1)
  assert.equal(live()[0].ms, 2000)
  live()[0].fn()
  await tick()
  assert.equal(calls.length, 2)
  close()
  assert.equal(live().length, 0)
})

test('one request in flight at a time, and two panels share one poll', async () => {
  const { store, calls, pending, live, tick } = rig()
  const closeA = store.open()
  const closeB = store.open()
  assert.equal(calls.length, 1)
  store.refresh() // a new request replaces the one in flight
  assert.equal(calls.length, 2)
  pending[0].resolve(good({ now: 'stale' }))
  await tick()
  assert.equal(store.state.window, undefined) // the replaced answer is dropped
  pending[1].resolve(good({ now: 'fresh' }))
  await tick()
  assert.equal(store.state.window.now, 'fresh')
  closeA()
  assert.equal(live().length, 1) // B still holds it
  closeA() // closing twice does not close B's hold
  assert.equal(live().length, 1)
  closeB()
  assert.equal(live().length, 0)
})

test('a hidden page loads once, then does not poll; showing it again refreshes at once (#259)', async () => {
  const { store, calls, pending, live, state, tick, watchers } = rig({ visible: false })
  store.open()
  await tick()
  // Never "Loading…" forever in a background tab: the first fetch does not wait for visibility.
  assert.equal(calls.length, 1)
  pending[0].resolve(good({ now: 'first' }))
  await tick()
  assert.equal(store.state.status, 'ok')
  assert.equal(live().length, 1)
  // Still hidden: the next tick polls nothing.
  live()[0].fn()
  await tick()
  assert.equal(calls.length, 1)
  // Visible again: one fetch right away.
  state.visible = true
  assert.equal(watchers.size, 1)
  for (const fn of [...watchers]) fn()
  await tick()
  assert.equal(calls.length, 2)
})

test('closing the last panel stops watching visibility', async () => {
  const { store, watchers, tick } = rig()
  const close = store.open()
  await tick()
  assert.equal(watchers.size, 1)
  close()
  assert.equal(watchers.size, 0)
})

test('an error backs off, keeps the last good window, and recovers', async () => {
  const { store, pending, live, tick } = rig()
  store.open()
  pending[0].resolve(good({ now: 'ok' }))
  await tick()
  live().at(-1).fn()
  await tick()
  pending[1].reject(new Error('host down'))
  await tick()
  assert.equal(store.state.status, 'error')
  assert.equal(store.state.error, 'host down')
  assert.equal(store.state.window.now, 'ok')
  assert.equal(live().at(-1).ms, 4000)
  live().at(-1).fn()
  await tick()
  pending[2].reject(new Error('still down'))
  await tick()
  assert.equal(live().at(-1).ms, 8000)
  live().at(-1).fn()
  await tick()
  pending[3].resolve(good({ now: 'back' }))
  await tick()
  assert.equal(store.state.status, 'ok')
  assert.equal(live().at(-1).ms, 2000)
})

test('a reply of another version or shape is an error state, never drawn from', async () => {
  const { store, pending, tick } = rig()
  store.open()
  pending[0].resolve({ version: 2, lanes: [], turns: [], exchanges: [], edges: [], utilization: [] })
  await tick()
  assert.equal(store.state.status, 'error')
  assert.match(store.state.error, /version 2/)
  assert.equal(store.state.window, undefined)
  const checks = client().checkWindow
  assert.match(checks(null), /no timeline/)
  assert.match(checks({ version: 1, lanes: [] }), /no turns/)
  assert.equal(checks(good()), undefined)
})

test('negative: an error message from the host is length-capped and shown as text', async () => {
  const { store, pending, tick } = rig()
  store.open()
  pending[0].reject(new Error('x'.repeat(5000)))
  await tick()
  assert.equal(store.state.error.length, 200)
})

test('setWindow clamps, asks again with the new window and looks back with `to`', async () => {
  const { store, calls, pending, tick } = rig()
  store.open()
  pending[0].resolve(good())
  await tick()
  store.setWindow({ windowMs: 5, to: 123456 })
  assert.deepEqual(calls.at(-1), ['timeline/window', { windowMs: 30_000, to: 123456 }])
  store.setWindow({ windowMs: 1e12 })
  assert.deepEqual(calls.at(-1), ['timeline/window', { windowMs: 86_400_000 }])
  store.setWindow({ windowMs: 'x', to: 'x' })
  assert.deepEqual(calls.at(-1), ['timeline/window', { windowMs: 86_400_000 }])
})

test('apply exposes ctx.flybot.timeline and globalThis.__flybot__.timeline, and cleans up', () => {
  const mod = client()
  globalThis.__flybot__ = {}
  try {
    const cleanups = []
    const flybot = { call: async () => good() }
    const off = mod.apply({ flybot, effect: execute => { cleanups.push(execute()) } })
    assert.equal(typeof flybot.timeline.open, 'function')
    assert.equal(globalThis.__flybot__.timeline, flybot.timeline)
    assert.equal(flybot.timeline.state.status, 'idle')
    assert.equal(cleanups.length, 1)
    off()
    assert.equal(flybot.timeline, undefined)
    assert.equal(globalThis.__flybot__.timeline, undefined)
    assert.throws(() => mod.apply({ flybot: {} }), /needs the flybot browser service/)
  } finally {
    delete globalThis.__flybot__
  }
})

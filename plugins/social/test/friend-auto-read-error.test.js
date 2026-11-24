// A friend Bot's settings card reads the pair's Auto-send setting once, on mount, through
// `social/settings`. Its rejection branch was an empty function, so a read that failed left the
// checkbox at its initial `false` — drawn exactly like a setting that is off — while the switch
// stayed live; the person then reads "my Bots' replies to Eve go out without asking" as the state
// they chose. The failure is the card's answer while it lasts (#3323/#3325/#3359 fixed the same gap
// for the friends list, the paused card and the approval cards): one quiet status row, and the switch
// is not offered until the value is known, because a value nobody read is not a value to flip. A
// remount (reopen the card) retries; no button, no new copy.
//
// The harness is the one `poll-visibility.test.js` uses: the client is a classic script, react is the
// tiny hook runner the other client tests use, and `setInterval` / `visibilitychange` are recorded
// instead of waited on (no jsdom). `rerender()` reuses the hook table and does not re-run effects.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
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

// One case: a fresh document, timer table, answer queue and module instance. Each `call` takes the next
// queued answer; an `Error` in the queue is a rejection. `settle()` lets the promise chain land before
// the next render, so a case never reads a half-updated card.
function scene({ hidden = false, answers = [] } = {}) {
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
  let queued = [...answers]
  globalThis.document = doc
  globalThis.setInterval = timers.setInterval
  globalThis.clearInterval = timers.clearInterval
  globalThis.__flybot__ = {
    call: (endpoint, payload) => {
      calls.push([endpoint, payload])
      const answer = queued.length > 0 ? queued.shift() : {}
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    canRetry: () => true,
  }
  return {
    doc, timers, calls, app,
    restore() {
      globalThis.document = saved.document
      globalThis.setInterval = saved.setInterval
      globalThis.clearInterval = saved.clearInterval
      globalThis.__flybot__ = saved.flybot
    },
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const unmount = cleanups => { for (const off of cleanups.reverse()) off() }

// React would run the first-mount effects after drawing; here that is the call site's own immediate
// read plus its timer, which is exactly what the cases below observe.
function mount(app, name, props) {
  live.inst = { hooks: {}, effects: [], dirty: false }
  live.idx = 0
  const out = app[name](props)
  const cleanups = []
  for (const [, fn] of live.inst.effects) {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
  }
  return { out, cleanups }
}
// A state update asks React for a new render; this reuses the hook table and runs no effect again.
function rerender(app, name, props) {
  live.idx = 0
  return app[name](props)
}
// Every element in a drawn tree, depth first, for counting what a state shows.
function nodes(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  nodes(node.children ?? [], out)
  return out
}
const byMark = (tree, mark) => nodes(tree).filter(node => node?.props?.['data-flybot'] === mark)
const textOf = node => (Array.isArray(node?.children) ? node.children : [node?.children]).join('')

const friendBot = { id: 'f1', name: 'Eve', remote: { home: '@eve.home', handle: '@eve.bot', homeName: 'Eve' } }
const settingsCard = app => mount(app, 'FriendChatSettings', { bot: friendBot })
const switchOf = tree => nodes(byMark(tree, 'friend-auto-send')[0] ?? {}).find(node => node?.type === 'input')

test('a settings read that fails is drawn as a failure, not as a setting', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = rerender(s.app, 'FriendChatSettings', { bot: friendBot }, out)
    assert.equal(byMark(tree, 'friend-auto-read-error').length, 1, 'the failed read is the card’s answer')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a NETWORK failure names the reason the users can act on', async () => {
  const s = scene({ answers: [Object.assign(new Error('offline'), { code: 'NETWORK' })] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = rerender(s.app, 'FriendChatSettings', { bot: friendBot }, out)
    assert.equal(textOf(byMark(tree, 'friend-auto-read-error')[0]), 'Could not reach FlyBot. Check that it is still running.')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a setting nobody read is not offered as a switch to flip', async () => {
  const s = scene({ answers: [new Error('offline')] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = rerender(s.app, 'FriendChatSettings', { bot: friendBot }, out)
    assert.equal(switchOf(tree).props.disabled, true, 'an unknown setting is not a checkbox')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a read that says the setting is on still draws a checked switch', async () => {
  const s = scene({ answers: [{ autoAccept: { '@eve.home': true } }] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = rerender(s.app, 'FriendChatSettings', { bot: friendBot }, out)
    assert.equal(switchOf(tree).props.checked, true, 'on is drawn as on')
    assert.equal(byMark(tree, 'friend-auto-read-error').length, 0, 'a read that answered draws no failure')
    unmount(cleanups)
  } finally { s.restore() }
})

test('a read that says the setting is off still draws an unchecked switch', async () => {
  const s = scene({ answers: [{ autoAccept: { '@eve.home': false } }] })
  try {
    const { cleanups, out } = settingsCard(s.app)
    await settle()
    const tree = rerender(s.app, 'FriendChatSettings', { bot: friendBot }, out)
    assert.equal(switchOf(tree).props.checked, false, 'off is drawn as off')
    unmount(cleanups)
  } finally { s.restore() }
})

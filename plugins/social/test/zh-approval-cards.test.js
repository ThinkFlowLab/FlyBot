// #3004: in a Chinese window the two approval cards and the friend panel still read English.
// Every one of these phrases already has a Chinese entry in `core/src/client/i18n.js`; the draw
// sites handed the bare literal to `h()` instead of passing it through `tr()`, so the entries were
// dead code. This mounts the real client.js with the tiny hook renderer the other client tests use
// (no jsdom), binds `__flybot__.t` to the zh dictionary, and checks the cards say the dictionary's
// words and not the English original — the four approval strings, the friend panel's three, the
// two inline confirmations (Keep/Remove) and the share retry.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY } from '../../../core/src/client/i18n.js'

const zh = DICTIONARY.zh
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
// A component element is a function in `type`: it has to be called to see the card it draws.
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx }
  live.inst = fresh()
  live.idx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  return out
}
function walk(node, visit, seen = []) {
  if (node == null || node === false || node === true) return seen
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, seen); return seen }
  if (typeof node === 'string' || typeof node === 'number') return seen
  visit(node)
  if (typeof node.type === 'function') return walk(mount(node), visit, seen)
  return walk(node.children ?? [], visit, seen)
}
// Every string drawn, once per node, so a card that still says the English word is catchable.
const drawn = tree => {
  const out = []
  walk(tree, node => { for (const child of node.children ?? []) if (typeof child === 'string') out.push(child) })
  return out
}
const labels = tree => {
  const out = []
  walk(tree, node => { const value = node?.props?.['aria-label']; if (typeof value === 'string') out.push(value) })
  return out
}
const clicker = (tree, name) => {
  let hit = null
  walk(tree, node => { if (!hit && node?.props?.['data-flybot'] === name) hit = node.props })
  return hit
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const runEffects = inst => { for (const [, fn] of inst.effects) fn() }

// The host's `t`: the dictionary entry when it has one, the English otherwise, which is what a
// Chinese window sees.
const hostT = (text, params) => {
  const hit = Object.hasOwn(zh, text) ? zh[text] : text
  return String(hit).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))
}

function fixtures({ incoming = [], grants = [], friends = undefined } = {}) {
  globalThis.__flybot__ = {
    t: hostT,
    call: (endpoint) => {
      if (endpoint === 'social/access') return Promise.resolve({ grants, note: '' })
      if (endpoint === 'social/overview') return Promise.resolve({ incoming, outgoing: [] })
      if (endpoint === 'social/status') return Promise.resolve({ bots: [], home: '' })
      if (endpoint === 'social/face-rooms') return Promise.resolve({ rooms: [] })
      if (endpoint === 'social/settings') return Promise.resolve({})
      if (endpoint === 'social/share-friends') {
        return friends === undefined ? Promise.reject(new Error('read failed')) : Promise.resolve({ friends })
      }
      return Promise.resolve({})
    },
  }
}

const pendingItem = {
  id: 'a1', status: 'pending', from: '@me.home', to: '@eve.home',
  text: 'x'.repeat(200), reasons: [],
}

test('#3004: the chat approval card speaks the window’s language', () => {
  const app = loadApp()
  fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: { item: pendingItem, canDecide: true, onDecide() {} } }
    const tree = render(app.ChatApproval, inst)
    const words = drawn(tree)
    for (const key of ['Waiting for approval', 'Show more', 'Approve', 'Reject']) {
      assert.ok(words.includes(zh[key]), `expected ${zh[key]} (${key}), saw ${JSON.stringify(words)}`)
      assert.ok(!words.includes(key), `the English ${JSON.stringify(key)} is still drawn`)
    }
    const heard = labels(tree)
    assert.ok(heard.includes(zh['Waiting for approval']), `expected aria-label ${zh['Waiting for approval']}, saw ${JSON.stringify(heard)}`)
    assert.ok(!heard.includes('Waiting for approval'), 'the English aria-label is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#3004: the held-reply card speaks the window’s language', () => {
  const app = loadApp()
  fixtures()
  try {
    const held = { id: 'h1', from: '@me.home', to: '@eve.home' }
    const inst = { hooks: {}, effects: [], props: { held, decide: async () => {} } }
    const tree = render(app.HeldReplyCard, inst)
    const words = drawn(tree)
    for (const key of ['Waiting for approval', 'Approve', 'Reject']) {
      assert.ok(words.includes(zh[key]), `expected ${zh[key]} (${key}), saw ${JSON.stringify(words)}`)
      assert.ok(!words.includes(key), `the English ${JSON.stringify(key)} is still drawn`)
    }
    const heard = labels(tree)
    assert.ok(heard.includes(zh['Waiting for approval']), `expected aria-label ${zh['Waiting for approval']}, saw ${JSON.stringify(heard)}`)
    assert.ok(!heard.includes('Waiting for approval'), 'the English aria-label is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#3004: the friend panel speaks the window’s language', async () => {
  const app = loadApp()
  fixtures({ incoming: [{ relationshipId: 'rel9', handle: '@eve.home', name: 'Eve' }] })
  try {
    const inst = { hooks: {}, effects: [], props: { onDone() {} } }
    render(app.AddFriend, inst)
    runEffects(inst)
    await tick()
    await tick()
    const words = drawn(render(app.AddFriend, inst))
    for (const key of ['Friend requests', 'Accept', 'Done']) {
      assert.ok(words.includes(zh[key]), `expected ${zh[key]} (${key}), saw ${JSON.stringify(words)}`)
      assert.ok(!words.includes(key), `the English ${JSON.stringify(key)} is still drawn`)
    }
  } finally { delete globalThis.__flybot__ }
})

test('#3004: a failed friend list offers its retry in the window’s language', async () => {
  const app = loadApp()
  fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: { bot: { id: 'b1', name: 'Mine' } } }
    render(app.ShareWithFriend, inst)
    runEffects(inst)
    await tick()
    await tick()
    const words = drawn(render(app.ShareWithFriend, inst))
    assert.ok(words.includes(zh['Try again']), `expected ${zh['Try again']}, saw ${JSON.stringify(words)}`)
    assert.ok(!words.includes('Try again'), 'the English retry is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#3004: the two inline confirmations speak the window’s language', async () => {
  const app = loadApp()
  fixtures({ grants: [{ id: 'g1', grantee: '@eve.home', name: 'Eve', home: '@eve.home', rooms: [] }] })
  try {
    const access = { hooks: {}, effects: [], props: { bot: { id: 'b1', name: 'Mine' } } }
    render(app.ManageAccess, access)
    runEffects(access)
    await tick()
    clicker(render(app.ManageAccess, access), 'revoke-grant').onClick()
    const asked = drawn(render(app.ManageAccess, access))
    assert.ok(asked.includes(zh.Keep), `expected ${zh.Keep} (Keep), saw ${JSON.stringify(asked)}`)
    assert.ok(!asked.includes('Keep'), 'the English Keep on the revoke confirm is still drawn')
  } finally { delete globalThis.__flybot__ }

  fixtures()
  try {
    const bot = { id: 'b1', name: 'Mine', remote: { handle: '@eve.home', home: '@eve.home' } }
    const friend = { hooks: {}, effects: [], props: { bot, actions: {}, roster: {} } }
    render(app.FriendChatSettings, friend)
    runEffects(friend)
    await tick()
    clicker(render(app.FriendChatSettings, friend), 'remove-friend-bot').onClick()
    const asked = drawn(render(app.FriendChatSettings, friend))
    for (const key of ['Remove', 'Keep']) {
      assert.ok(asked.includes(zh[key]), `expected ${zh[key]} (${key}), saw ${JSON.stringify(asked)}`)
      assert.ok(!asked.includes(key), `the English ${JSON.stringify(key)} is still drawn`)
    }
  } finally { delete globalThis.__flybot__ }
})

// The other direction: with no translator bound, the same cards keep today's English byte for byte
// (a zh window is the only thing this change is allowed to move).
test('#3004: with no translator the cards keep today’s English', () => {
  const app = loadApp()
  globalThis.__flybot__ = { call: () => Promise.resolve({}) }
  try {
    const inst = { hooks: {}, effects: [], props: { item: pendingItem, canDecide: true, onDecide() {} } }
    const words = drawn(render(app.ChatApproval, inst))
    for (const key of ['Waiting for approval', 'Show more', 'Approve', 'Reject']) {
      assert.ok(words.includes(key), `expected ${JSON.stringify(key)}, saw ${JSON.stringify(words)}`)
    }
  } finally { delete globalThis.__flybot__ }
})

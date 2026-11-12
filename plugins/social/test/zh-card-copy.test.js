// #2973: in a Chinese window the Sharing and friend cards still drew English, although
// `core/src/client/i18n.js` already carries the Chinese for every one of these phrases — the
// entries were dead code because these five call sites emitted bare strings instead of going
// through the translator. This test mounts the real client.js with the tiny hook renderer the
// other client tests use (no jsdom), binds `__flybot__.t` to the zh dictionary, and checks the
// five cards say the dictionary's words and not the English original.
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
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const runEffects = inst => { for (const [, fn] of inst.effects) fn() }

// The host's `t`: the dictionary entry when it has one, the English otherwise, which is what a
// Chinese window sees. `{param}` filling is core's job and no case here needs it.
const hostT = (text, params) => {
  const hit = Object.hasOwn(zh, text) ? zh[text] : text
  return String(hit).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))
}

function fixtures() {
  const calls = []
  globalThis.__flybot__ = {
    t: hostT,
    call: (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'social/access') return Promise.resolve({ grants: [], note: '' })
      if (endpoint === 'social/overview') return Promise.resolve({ incoming: [], outgoing: [{ relationshipId: 'rel1', handle: '@eve.home', name: 'Eve' }] })
      if (endpoint === 'social/status') return Promise.resolve({ bots: [], home: '' })
      if (endpoint === 'social/face-rooms') return Promise.resolve({ rooms: [] })
      return Promise.resolve({})
    },
  }
  return calls
}

test('#2973: the Sharing card names who has access in the window’s language', async () => {
  const app = loadApp()
  fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: { bot: { id: 'bot_1', name: 'Mine' } } }
    render(app.ManageAccess, inst)
    runEffects(inst)
    await tick()
    const words = drawn(render(app.ManageAccess, inst))
    assert.ok(words.includes(zh['People with access']), `expected ${zh['People with access']}, saw ${JSON.stringify(words.slice(0, 8))}`)
    assert.ok(!words.includes('People with access'), 'the English heading is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#2973: the friend card names its two groups in the window’s language', async () => {
  const app = loadApp()
  fixtures()
  try {
    const inst = { hooks: {}, effects: [], props: {} }
    render(app.AddFriend, inst)
    runEffects(inst)
    await tick()
    const words = drawn(render(app.AddFriend, inst))
    assert.ok(words.includes(zh['Add friend']), `expected ${zh['Add friend']}, saw ${JSON.stringify(words.slice(0, 8))}`)
    assert.ok(words.includes(zh['Waiting for them to accept']), `expected ${zh['Waiting for them to accept']}, saw ${JSON.stringify(words.slice(0, 20))}`)
    assert.ok(!words.includes('Add friend'), 'the English heading is still drawn')
    assert.ok(!words.includes('Waiting for them to accept'), 'the English waiting line is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#2973: a send that never went says so in the window’s language', async () => {
  const app = loadApp()
  fixtures()
  try {
    const item = { status: 'failed', from: '@me.home', to: '@eve.home', error: 'boom' }
    const inst = { hooks: {}, effects: [], props: { item } }
    const words = drawn(render(app.ChatApproval, inst))
    assert.ok(words.includes(zh['Not sent']), `expected ${zh['Not sent']}, saw ${JSON.stringify(words.slice(0, 8))}`)
    assert.ok(!words.includes('Not sent'), 'the English label is still drawn')
  } finally { delete globalThis.__flybot__ }
})

test('#2973: the room invitation card offers a link in the window’s language', async () => {
  const app = loadApp()
  fixtures()
  try {
    const room = { id: 'r1', origin: 'face-to-face', face: { roomId: 'frm1', status: 'open' }, participants: [] }
    const inst = { hooks: {}, effects: [], props: { room, roster: { byId: {} }, actions: {} } }
    render(app.FaceRoomOverview, inst)
    runEffects(inst)
    await tick()
    const words = drawn(render(app.FaceRoomOverview, inst))
    assert.ok(words.includes(zh['Invite by link']), `expected ${zh['Invite by link']}, saw ${JSON.stringify(words.slice(0, 12))}`)
    assert.ok(!words.includes('Invite by link'), 'the English label is still drawn')
  } finally { delete globalThis.__flybot__ }
})

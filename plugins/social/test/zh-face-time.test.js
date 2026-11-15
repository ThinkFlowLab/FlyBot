// #P769b: a Past room row's time read English in a zh window. The row itself says `14:05` today and
// `Oct 19` on an earlier day; hovering it says `Ended Oct 19 14:05`. Both the word (`Ended` / `Started`)
// and the month/day order were English text built at the draw site, so no dictionary entry could ever
// reach them — `text: …, full: `${…} ${day} ${hhmm}`` is the kind of template literal the copy scans
// cannot see. This mounts the real client.js with the tiny hook renderer the other client tests use
// (no jsdom), binds `__flybot__.t` to the zh dictionary, and reads the `face-time` node's own text and
// `title` out of a Past card.
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
function walk(node, visit) {
  if (node == null || node === false || node === true) return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node === 'string' || typeof node === 'number') return
  visit(node)
  if (typeof node.type === 'function') return walk(mount(node), visit)
  return walk(node.children ?? [], visit)
}
const nodeOf = (tree, name) => {
  let hit = null
  walk(tree, node => { if (!hit && node?.props?.['data-flybot'] === name) hit = node })
  return hit
}
const nodeByClass = (tree, name) => {
  let hit = null
  walk(tree, node => { if (!hit && node?.props?.className === name) hit = node })
  return hit
}

// The host's `t`: the dictionary entry when it has one, the English otherwise, which is what a
// Chinese window sees.
const hostT = (text, params) => {
  const hit = Object.hasOwn(zh, text) ? zh[text] : text
  return String(hit).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))
}
const englishT = (text, params) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))

// One local timestamp, so the day the row names does not depend on the runner's zone.
const local = (day, hh, mm) => new Date(2026, 9, day, hh, mm).toISOString()

// A Past room's time: the row's own text, and the hover a reader gets on `face-time`.
const faceRowTime = (t, room) => {
  globalThis.__flybot__ = { t, call: () => Promise.resolve({}) }
  const app = loadApp()
  const inst = { hooks: {}, effects: [], props: { room: { roomId: 'r1', faceRoomId: 'frm1', name: 'Hall', members: [], ...room }, past: true } }
  const node = nodeOf(render(app.FaceRoomCard, inst), 'face-time')
  assert.ok(node, 'the Past row draws its time')
  return { text: (node.children ?? []).filter(child => typeof child === 'string').join(''), title: node.props?.title }
}

test('#P769b: a Past row’s hover names the end and the day in the window’s language', () => {
  try {
    const seen = faceRowTime(hostT, { endedAt: local(19, 14, 5) })
    assert.equal(seen.text, '10月19日', `the row’s own day: saw ${JSON.stringify(seen.text)}`)
    assert.equal(seen.title, `${zh.Ended} 10月19日 14:05`, `the hover: saw ${JSON.stringify(seen.title)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#P769b: a room that never ended says when it started, in the window’s language', () => {
  try {
    const seen = faceRowTime(hostT, { startedAt: local(19, 14, 5) })
    assert.equal(seen.text, '10月19日', `the row’s own day: saw ${JSON.stringify(seen.text)}`)
    assert.equal(seen.title, `${zh.Started} 10月19日 14:05`, `the hover: saw ${JSON.stringify(seen.title)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#P769b: today’s row keeps its bare clock and still hovers in the window’s language', () => {
  try {
    const now = new Date()
    const seen = faceRowTime(hostT, { endedAt: now.toISOString() })
    assert.match(seen.text, /^\d\d:\d\d$/, `today’s row text: saw ${JSON.stringify(seen.text)}`)
    assert.ok(seen.title.startsWith(`${zh.Ended} `), `the hover’s word: saw ${JSON.stringify(seen.title)}`)
    assert.ok(/\d+月\d+日 {1,2}\d\d:\d\d$/.test(seen.title), `the hover’s day: saw ${JSON.stringify(seen.title)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#P769b: an English window keeps the row and hover bytes it drew before', () => {
  try {
    const ended = faceRowTime(englishT, { endedAt: local(19, 14, 5) })
    assert.equal(ended.text, 'Oct 19', `the English row day: saw ${JSON.stringify(ended.text)}`)
    assert.equal(ended.title, 'Ended Oct 19 14:05', `the English hover: saw ${JSON.stringify(ended.title)}`)
    const started = faceRowTime(englishT, { startedAt: local(19, 14, 5) })
    assert.equal(started.title, 'Started Oct 19 14:05', `the English hover: saw ${JSON.stringify(started.title)}`)
  } finally { delete globalThis.__flybot__ }
})

// The row's own title is built the same way when the stored name carries no people: the word and the
// day are display text, while the `Face-to-face · …` parsing above them stays on the stored English.
const faceTitle = (t, room) => {
  globalThis.__flybot__ = { t, call: () => Promise.resolve({}) }
  const app = loadApp()
  const inst = { hooks: {}, effects: [], props: { room: { roomId: 'r1', faceRoomId: 'frm1', name: 'Face-to-face room', members: [{ handle: '@alice', ownerName: 'Alice' }], ...room }, past: true } }
  const node = nodeByClass(render(app.FaceRoomCard, inst), 'fs-name')
  assert.ok(node, 'the Past row draws its title')
  return { title: node.props?.title, text: (node.children ?? []).filter(child => typeof child === 'string').join('') }
}

test('#P769b: a Past row’s rebuilt title reads the window’s language too', () => {
  try {
    const built = faceTitle(hostT, { createdAt: local(19, 14, 5) })
    assert.equal(built.title, `面对面 · Alice · 10月19日 14:05`, `a rebuilt title: saw ${JSON.stringify(built.title)}`)
    assert.equal(built.text, built.title, 'the row and its hover name the same room')
    // A stored auto title carries its own English stamp; it is still display text here.
    const stored = faceTitle(hostT, { name: 'Face-to-face · Oct 19 14:05' })
    assert.equal(stored.title, `面对面 · Alice · 10月19日 14:05`, `a stored stamp: saw ${JSON.stringify(stored.title)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#P769b: an English window keeps the rebuilt title bytes it drew before', () => {
  try {
    const built = faceTitle(englishT, { createdAt: local(19, 14, 5) })
    assert.equal(built.title, 'Face-to-face · Alice · Oct 19 14:05', `the English rebuilt title: saw ${JSON.stringify(built.title)}`)
    const stored = faceTitle(englishT, { name: 'Face-to-face · Oct 19 14:05' })
    assert.equal(stored.title, 'Face-to-face · Alice · Oct 19 14:05', `the English stored title: saw ${JSON.stringify(stored.title)}`)
  } finally { delete globalThis.__flybot__ }
})

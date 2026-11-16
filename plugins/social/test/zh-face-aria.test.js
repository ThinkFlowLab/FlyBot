// #3100: the two accessible names on a card read English in a zh window. The row's button
// says `Open <title>` and the member stack says `Members`; both are drawn as literals at the draw
// site, so the dictionary never reaches them even though it already carries `Open {title}` and
// `Members`. This mounts the real client.js with the tiny hook renderer the other client tests use
// (no jsdom), binds `__flybot__.t` to the zh dictionary, and reads the two `aria-label` values off
// a Past card.
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
const nodeWhere = (tree, match) => {
  let hit = null
  walk(tree, node => { if (!hit && match(node)) hit = node })
  return hit
}

// The host's `t`: the dictionary entry when it has one, the English otherwise, which is what a
// Chinese window sees.
const hostT = (text, params) => {
  const hit = Object.hasOwn(zh, text) ? zh[text] : text
  return String(hit).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))
}
const englishT = (text, params) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(params?.[key] ?? ''))

// One local timestamp, so the day the card names does not depend on the runner's zone.
const local = (day, hh, mm) => new Date(2026, 9, day, hh, mm).toISOString()

// The Past card's two accessible names: the row button that opens the room, and the member stack.
const faceCard = (t, room = {}) => {
  globalThis.__flybot__ = { t, call: () => Promise.resolve({}) }
  const app = loadApp()
  const inst = {
    hooks: {},
    effects: [],
    props: {
      room: {
        roomId: 'r1', faceRoomId: 'frm1', name: 'Face-to-face room',
        members: [{ handle: '@alice', ownerName: 'Alice' }], createdAt: local(19, 14, 5), ...room,
      },
      past: true,
    },
  }
  const tree = render(app.FaceRoomCard, inst)
  const row = nodeWhere(tree, node => node?.props?.role === 'button' && 'aria-label' in (node.props ?? {}))
  const stack = nodeWhere(tree, node => node?.props?.className === 'fs-stack')
  assert.ok(row, 'the Past row is one button')
  assert.ok(stack, 'the row draws its member stack')
  return { row: row.props['aria-label'], stack: stack.props['aria-label'] }
}

test('#3100: a Past row’s open button names the room in the window’s language', () => {
  try {
    const seen = faceCard(hostT)
    assert.equal(seen.row, `打开 面对面 · Alice · 10月19日 14:05`, `the row’s accessible name: saw ${JSON.stringify(seen.row)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#3100: the member stack’s accessible name reads the window’s language', () => {
  try {
    const seen = faceCard(hostT)
    assert.equal(seen.stack, '成员', `the member stack’s accessible name: saw ${JSON.stringify(seen.stack)}`)
  } finally { delete globalThis.__flybot__ }
})

test('#3100: an English window keeps the accessible names it drew before', () => {
  try {
    const seen = faceCard(englishT)
    assert.equal(seen.row, 'Open Face-to-face · Alice · Oct 19 14:05', `the row’s accessible name: saw ${JSON.stringify(seen.row)}`)
    assert.equal(seen.stack, 'Members', `the member stack’s accessible name: saw ${JSON.stringify(seen.stack)}`)
  } finally { delete globalThis.__flybot__ }
})

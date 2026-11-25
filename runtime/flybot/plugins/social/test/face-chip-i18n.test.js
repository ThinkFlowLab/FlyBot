// #3090: the face-to-face room chip says "Open" through the translator and four of its five
// states do not — `Closed`, `Left`, `ended` (lowercase, and a status id rather than a word) and
// `Joining` are bare literals, so a window whose language is not English keeps drawing them in
// English. This pins every branch of `faceChipLabel` to the interface language: the stub below
// answers only for the English key it was given, so a label that never reaches it, or reaches it
// spelled differently, stays English and fails.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0, rIdx: 0, eIdx: 0 }
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
  useRef(init) {
    const { inst } = live
    const i = live.rIdx++
    if (!(i in inst.refs)) inst.refs[i] = { current: init }
    return inst.refs[i]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.eIdx++
    inst.effects.push([i, fn, deps])
  },
}
for (const name of ['useMemo', 'useCallback', 'useLayoutEffect', 'useContext', 'useReducer', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'memo', 'forwardRef', 'createContext', 'createPortal', 'cloneElement', 'isValidElement', 'startTransition']) reactStub[name] = (value) => value

globalThis.document ??= { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, removeEventListener() {} }

const fresh = () => ({ hooks: {}, refs: {}, effects: [], dirty: false })
function render(Component, inst, props = inst.props) {
  live.inst = inst
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  inst.effects = []
  inst.props = props
  inst.dirty = false
  return Component(props)
}
function mount(element) {
  const outer = { inst: live.inst, idx: live.idx, rIdx: live.rIdx, eIdx: live.eIdx }
  live.inst = fresh()
  live.idx = 0
  live.rIdx = 0
  live.eIdx = 0
  const out = element.type(element.props ?? {})
  live.inst = outer.inst
  live.idx = outer.idx
  live.rIdx = outer.rIdx
  live.eIdx = outer.eIdx
  return out
}
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  if (typeof node.type === 'function') return find(mount(node), predicate)
  return find(node.children, predicate)
}
const byFlybot = id => node => node.props?.['data-flybot'] === id
const chipText = node => (node.children ?? []).map(child => (typeof child === 'string' ? child : '')).join('')

// The language a window runs in: `t` answers for the English key it is handed and echoes anything
// else, which is what the host's own translator does for a key the dictionary does not carry.
const ZH = { Open: '打开', Closed: '已关闭', Left: '已离开', Ended: '已结束', Joining: '加入中' }

function loadApp() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? reactStub : {}))) } }
  const file = process.env.FACE_CHIP_CLIENT ?? '../client.js'
  new Function('window', readFileSync(new URL(file, import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')
}

// A Past row is the read-only chip surface: no leave button, no room to open, just the chip.
function chipOf(app, room) {
  const inst = fresh()
  const tree = render(app.FaceRoomCard, inst, {
    room: { id: 'r1', faceRoomId: 'frm1', members: [], ...room },
    actions: {}, onChange: () => {}, roster: { bots: [], byId: {} }, remoteChats: [], past: true,
  })
  const chip = find(tree, byFlybot('face-status'))
  assert.ok(chip, 'the room row draws a status chip')
  return chipText(chip)
}

function withLanguage(fn) {
  globalThis.__flybot__ = { t: (text) => ZH[text] ?? String(text) }
  try { return fn() } finally { delete globalThis.__flybot__ }
}

test('#3090: an open face-to-face room says Open in the interface language', () => {
  const app = loadApp()
  withLanguage(() => assert.equal(chipOf(app, { status: 'open' }), '打开'))
})

test('#3090: a closed face-to-face room says Closed in the interface language', () => {
  const app = loadApp()
  withLanguage(() => assert.equal(chipOf(app, { status: 'closed' }), '已关闭'))
  // A dictionary without the key falls back to the English word, not to a guessed translation.
  globalThis.__flybot__ = { t: text => String(text) }
  try { assert.equal(chipOf(app, { status: 'closed' }), 'Closed') } finally { delete globalThis.__flybot__ }
})

test('#3090: a left face-to-face room says Left in the interface language', () => {
  const app = loadApp()
  withLanguage(() => assert.equal(chipOf(app, { status: 'left' }), '已离开'))
})

test('#3090: an ended face-to-face room says Ended, not a lowercase status id', () => {
  const app = loadApp()
  withLanguage(() => assert.equal(chipOf(app, { status: 'candidate', expiresAt: new Date(Date.now() - 60_000).toISOString() }), '已结束'))
})

test('#3090: a room still joining says Joining in the interface language', () => {
  const app = loadApp()
  // A candidate without a deadline is the joining state: no countdown to show yet.
  withLanguage(() => assert.equal(chipOf(app, { status: 'candidate' }), '加入中'))
})

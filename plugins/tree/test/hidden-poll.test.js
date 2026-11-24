// The reorganization notice reads `tree/reorg` from the host on a timer (every 30 s). A window
// nobody is looking at must not keep asking, and coming back must show the result at once rather
// than up to 30 s later — the same rule the timeline and workflow panels follow.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const live = { inst: null, idx: 0 }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (!Object.is(value, slot.value)) { slot.value = value; inst.root.schedule() }
    }]
  },
  useEffect(fn, deps) {
    const { inst } = live
    const i = live.idx++
    const prev = inst.hooks[i]
    const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((dep, k) => !Object.is(dep, prev.deps[k]))
    if (!prev) inst.hooks[i] = { deps }
    if (changed) { inst.hooks[i].deps = deps; inst.root.pending.push({ slot: inst.hooks[i], fn }) }
  },
  useCallback(fn, deps) {
    const { inst } = live
    const i = live.idx++
    const prev = inst.hooks[i]
    const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((dep, k) => !Object.is(dep, prev.deps[k]))
    if (changed) inst.hooks[i] = { fn, deps }
    return inst.hooks[i].fn
  },
}

function mount(Component, props = {}) {
  const root = { instances: new Map(), pending: [], rendering: false, dirty: false, tree: undefined }
  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node === 'boolean') return undefined
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}.${i}`))
    if (typeof node.type === 'function') {
      let inst = root.instances.get(path)
      if (!inst) { inst = { hooks: [], root }; root.instances.set(path, inst) }
      inst.used = true
      live.inst = inst
      live.idx = 0
      return expand(node.type({ ...node.props, children: node.children }), `${path}/c`)
    }
    return { type: node.type, props: node.props, children: node.children.map((child, i) => expand(child, `${path}.${i}`)).flat(Infinity).filter(child => child !== undefined) }
  }
  const render = () => {
    root.rendering = true
    for (const inst of root.instances.values()) inst.used = false
    root.tree = expand({ type: Component, props, children: [] }, 'r')
    const run = root.pending.splice(0)
    for (const { slot, fn } of run) { slot.cleanup?.(); const out = fn(); slot.cleanup = typeof out === 'function' ? out : undefined }
    root.rendering = false
    if (root.dirty || root.pending.length) { root.dirty = false; render() }
  }
  root.schedule = () => { if (root.rendering) root.dirty = true; else render() }
  render()
  return {
    get tree() { return root.tree },
    unmount() { for (const inst of root.instances.values()) for (const slot of inst.hooks) slot?.cleanup?.(); root.instances.clear() },
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const loadClient = () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => react) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  return mod
}

const run = { id: 'run-1', at: Date.now() - 60_000, trigger: 'full', summary: ['Moved 3 Bots under FlyBot Lead'], actions: [] }

test('a hidden window does not read tree/reorg, and coming back reads it at once', async () => {
  const mod = loadClient()
  const reads = []
  const flybot = {
    call(name) { if (name === 'tree/reorg') { reads.push(name); return Promise.resolve({ runs: [run], dismissed: null }) } return Promise.resolve({ ok: true }) },
    fields: { on: () => () => {} },
  }
  const timers = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id }
  globalThis.clearInterval = (id) => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1) }
  const realDoc = globalThis.document
  const listeners = []
  const doc = {
    hidden: true,
    visibilityState: 'hidden',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild() {} },
    addEventListener(name, fn) { if (name === 'visibilitychange') listeners.push(fn) },
    removeEventListener(name, fn) { const at = listeners.indexOf(fn); if (name === 'visibilitychange' && at >= 0) listeners.splice(at, 1) },
  }
  globalThis.document = doc
  const Notice = mod.makeReorgNotice(flybot)
  let view
  try {
    view = mount(Notice, { roster: { bots: [] }, actions: {}, call: flybot.call })
    await flush()
    assert.equal(reads.length, 1, 'the first paint reads tree/reorg once')
    for (const timer of timers.slice()) timer.fn()
    await flush()
    assert.equal(reads.length, 1, 'a hidden window does not read tree/reorg again')
    doc.hidden = false
    doc.visibilityState = 'visible'
    for (const fn of listeners.slice()) fn()
    await flush()
    assert.equal(reads.length, 2, 'coming back reads tree/reorg at once')
    view.unmount()
    view = undefined
    assert.equal(timers.length, 0, 'unmount clears every interval')
    assert.equal(listeners.length, 0, 'unmount removes the visibility listener')
  } finally {
    if (view) view.unmount()
    globalThis.document = realDoc
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

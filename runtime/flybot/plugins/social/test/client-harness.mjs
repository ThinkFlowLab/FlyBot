// Shared bench for the client-side tests that draw a component from `client.js` and answer its
// `__flybot__.call` reads themselves: a tiny hook runner instead of React, a document whose `hidden`
// the case can flip and whose `visibilitychange` listeners it fires, and a timer table it advances.
// No jsdom — the client is a classic script, so it is loaded into a fake `window` by `loadApp`.
import { readFileSync } from 'node:fs'

// The hook slots of the component being rendered. `mount` swaps in a fresh table per component, so a
// child's hooks never land in its parent's slots (the way React keeps them apart).
export const live = { inst: null, idx: 0 }

export const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'F',
  Component: class {},
  useState(init) {
    const inst = live.inst
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
    const slot = inst.hooks[i]
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; inst.dirty = true }]
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
export function loadApp() {
  const modules = new Map()
  const window = { __ModuleLoader__: { load: entry => modules.set(entry.id, entry.factory) } }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/social')(name => (name === 'react' ? reactStub : {}))
}

export function makeDocument({ hidden = false } = {}) {
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

export function makeTimers() {
  let next = 0
  const timers = new Map()
  return {
    setInterval(fn, ms) { const id = `t${++next}`; timers.set(id, { fn, ms }); return id },
    clearInterval(id) { timers.delete(id) },
    periods: () => [...timers.values()].map(timer => timer.ms),
    tick() { for (const timer of [...timers.values()]) timer.fn() },
  }
}

// One case: a fresh document, timer table, call log and module instance. Each `call` takes the next
// queued answer; an `Error` in the queue is a rejection, and an empty queue answers `{}`.
export function scene({ hidden = false, answers = [] } = {}) {
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

export const settle = () => new Promise(resolve => setTimeout(resolve, 0))
export const unmount = (cleanups) => { for (const off of cleanups.reverse()) off() }

// React would run the first-mount effects after drawing; here that is the call site's own immediate
// read plus its timer, which is exactly what the cases observe.
export function mount(app, name, props) {
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
export function rerender(app, name, props) {
  live.idx = 0
  return app[name](props)
}

// Every element in a drawn tree, depth first, for counting what a state shows.
export function nodes(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  nodes(node.children ?? [], out)
  return out
}

export const byMark = (tree, mark) => nodes(tree).filter(node => node?.props?.['data-flybot'] === mark)
export const textOf = node => (Array.isArray(node?.children) ? node.children : [node?.children]).join('')

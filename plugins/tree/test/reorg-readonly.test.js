// #2220: the reorganization notice is a read (`tree/reorg`), so a read-only window keeps the card —
// what moved, when, `Kept:` — but `tree/undo` and `tree/dismiss` are writes the host refuses, so the
// card must not offer them there. `roster.readOnly`, trimmed, is the same signal the workflow page
// uses (#2200). A writable roster draws the card byte for byte as before.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// A hook renderer: unlike ./render.js it keeps state and runs effects, so the notice's `load()`
// lands and `__flybot__`-style handlers can be pressed. `useCallback` is memoised by deps — the
// client's effect depends on `load`, and a fresh callback per render would re-run it forever.
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
    const stale = []
    for (const [path, inst] of root.instances) if (!inst.used) stale.push(path)
    for (const path of stale) {
      for (const slot of root.instances.get(path).hooks) slot?.cleanup?.()
      root.instances.delete(path)
    }
    const run = root.pending.splice(0)
    for (const { slot, fn } of run) { slot.cleanup?.(); const out = fn(); slot.cleanup = typeof out === 'function' ? out : undefined }
    root.rendering = false
    if (root.dirty || root.pending.length) { root.dirty = false; render() }
  }
  root.schedule = () => { if (root.rendering) root.dirty = true; else render() }
  render()
  return {
    get tree() { return root.tree },
    rerender(nextProps = {}) { Object.assign(props, nextProps); root.schedule() },
    unmount() { for (const inst of root.instances.values()) for (const slot of inst.hooks) slot?.cleanup?.(); root.instances.clear() },
  }
}

const findAll = (node, pred, out = []) => {
  if (Array.isArray(node)) { for (const child of node) findAll(child, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, pred, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : node ? (node.children ?? []).map(textOf).join('') : '')
const buttonsOf = tree => findAll(tree, node => node.type === 'button' && node.props?.className === 'flybot-reorg-btn')
const labelOf = node => textOf(node)
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) }

const loadClient = () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => react) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  return mod
}

const READ_ONLY = 'This window shows the team but cannot change it.'
const run = { id: 'run-1', at: Date.now() - 60_000, trigger: 'full', summary: ['Moved 3 Bots under FlyBot Lead'], actions: [] }

/** A fake `ctx.flybot` that answers `tree/reorg` and records every call. */
function fakeFlybot(overview) {
  const calls = []
  return {
    calls,
    call(name, body) {
      calls.push({ name, body })
      if (name === 'tree/reorg') return Promise.resolve(overview)
      return Promise.resolve({ ok: true })
    },
    fields: { on: () => () => {} },
  }
}

const notice = (mod, overview, roster) => {
  const flybot = fakeFlybot(overview)
  const Notice = mod.makeReorgNotice(flybot)
  const root = mount(Notice, { roster, actions: {}, call: flybot.call })
  return { flybot, root }
}

test('#2220: a read-only window keeps the notice but offers no Undo and no Dismiss', async () => {
  const mod = loadClient()
  const { flybot, root } = notice(mod, { runs: [run], dismissed: null }, { bots: [], readOnly: READ_ONLY })
  try {
    await flush()
    const buttons = buttonsOf(root.tree)
    assert.equal(buttons.length, 0, `a read-only notice draws no write entry, got ${buttons.map(labelOf).join(', ')}`)
    assert.equal(findAll(root.tree, n => n.props?.className === 'flybot-reorg').length, 1, 'the card itself stays')
    const text = textOf(root.tree)
    assert.match(text, /Tree reorganized/)
    assert.match(text, /Moved 3 Bots under FlyBot Lead/, 'what moved is still readable')
    assert.deepEqual(flybot.calls.filter(c => c.name === 'tree/undo' || c.name === 'tree/dismiss'), [], 'no write is even attempted')
    assert.equal(flybot.calls.filter(c => c.name === 'tree/reorg').length >= 1, true, 'the read still happened')
  } finally { root.unmount() }
})

test('#2220: a read-only window still shows what Undo kept', async () => {
  const mod = loadClient()
  const undone = { ...run, undone: { at: run.at + 1, restored: [], kept: ['FlyBot Dev: moved again since'] } }
  const { root } = notice(mod, { runs: [undone], dismissed: null }, { bots: [], readOnly: READ_ONLY })
  try {
    await flush()
    assert.equal(buttonsOf(root.tree).length, 0)
    const text = textOf(root.tree)
    assert.match(text, /Tree reorganization undone/)
    assert.match(text, /Kept: FlyBot Dev: moved again since/)
  } finally { root.unmount() }
})

test('#2220: a writable roster keeps both buttons, and Undo issues tree/undo', async () => {
  const mod = loadClient()
  for (const roster of [{ bots: [] }, { bots: [], readOnly: '' }, { bots: [], readOnly: '   ' }]) {
    const { flybot, root } = notice(mod, { runs: [run], dismissed: null }, roster)
    try {
      await flush()
      const buttons = buttonsOf(root.tree)
      assert.deepEqual(buttons.map(labelOf), ['Undo', 'Dismiss'], `roster ${JSON.stringify(roster.readOnly)} stays writable`)
      buttons[0].props.onClick()
      await flush()
      assert.deepEqual(flybot.calls.filter(c => c.name === 'tree/undo').map(c => c.body), [{ runId: 'run-1' }])
    } finally { root.unmount() }
  }
})

test('#2220: no fresh run draws no card, read-only or writable', async () => {
  const mod = loadClient()
  const stale = { runs: [{ ...run, at: Date.now() - 8 * 24 * 60 * 60 * 1000 }], dismissed: null }
  const dismissed = { runs: [run], dismissed: 'run-1' }
  const empty = { runs: [] }
  for (const overview of [stale, dismissed, empty]) {
    for (const roster of [{ bots: [] }, { bots: [], readOnly: READ_ONLY }]) {
      const { root } = notice(mod, overview, roster)
      try {
        await flush()
        assert.equal(findAll(root.tree ?? null, n => n.props?.className === 'flybot-reorg').length, 0)
        assert.equal(buttonsOf(root.tree ?? null).length, 0)
      } finally { root.unmount() }
    }
  }
})

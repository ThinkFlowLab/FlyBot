// Settings → Workflows (#1364). The page lists factory pipelines and the owner's own
// workflows and opens the drag-drop flowchart. It does not teach workflows/<id>.json,
// and a read that never returns settles as an error instead of "Reading workflows…".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

const { outputFiles } = await build({
  stdin: {
    contents: "export { WorkflowsPage, WorkflowsView, readWorkflows, settleWorkflowRead, moveNode, connectNodes, dropBot, removeNode } from './src/client/workflows.js'\nexport * as wf from './src/client/workflows.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
// #1810: the old fixture faked React with a no-op useEffect and a setter that never
// re-rendered, so no case in this file could observe an effect or a second read — a
// polling case written against it passed no matter what the page did. This runtime
// keeps hook slots per component, re-runs an effect only when its deps change, and
// re-renders when a setter fires. The 2 s beat stays in the test's hands (the env
// `setInterval` below is a fake clock); real `setTimeout` stays real so the
// read-timeout cases still settle.
const runtime = {
  instances: new Map(),
  key: 'root',
  index: 0,
  dirty: false,
  unmounted: false,
  reset() {
    this.instances = new Map()
    this.key = 'root'
    this.index = 0
    this.dirty = false
    this.unmounted = false
  },
  instance(key) {
    let inst = this.instances.get(key)
    if (!inst) {
      inst = { slots: [], refs: [], pending: [], deps: new Map(), cleanups: new Map() }
      this.instances.set(key, inst)
    }
    return inst
  },
}
function withInstance(key, run) {
  const previousKey = runtime.key
  const previousIndex = runtime.index
  runtime.key = key
  runtime.index = 0
  try { return run() } finally { runtime.key = previousKey; runtime.index = previousIndex }
}
function recordEffect(run, deps) {
  const inst = runtime.instance(runtime.key)
  inst.pending.push({ index: runtime.index++, run, deps })
}
function commitEffects() {
  for (const inst of runtime.instances.values()) {
    const pending = inst.pending
    inst.pending = []
    for (const { index, run, deps } of pending) {
      const previous = inst.deps.get(index)
      const changed = !deps || !previous || deps.length !== previous.length || deps.some((dep, at) => !Object.is(dep, previous[at]))
      if (!changed) continue
      const cleanup = inst.cleanups.get(index)
      if (typeof cleanup === 'function') cleanup()
      inst.cleanups.delete(index)
      inst.deps.set(index, deps ? [...deps] : null)
      const next = run()
      if (typeof next === 'function') inst.cleanups.set(index, next)
    }
  }
}
function unmountAll() {
  runtime.unmounted = true
  for (const inst of runtime.instances.values()) {
    for (const cleanup of inst.cleanups.values()) if (typeof cleanup === 'function') cleanup()
    inst.cleanups.clear()
    inst.pending = []
  }
  runtime.instances.clear()
}
const react = {
  createElement: h, Fragment: Symbol('F'),
  useEffect: (run, deps) => recordEffect(run, deps),
  useLayoutEffect: (run, deps) => recordEffect(run, deps),
  useMemo: (fn) => fn(), useCallback: (fn) => fn(),
  useRef: (current) => {
    const inst = runtime.instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.refs)) inst.refs[index] = { current }
    return inst.refs[index]
  },
  useSyncExternalStore: (_s, get) => get(),
  useState: (initial) => {
    const inst = runtime.instance(runtime.key)
    const index = runtime.index++
    if (!(index in inst.slots)) inst.slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.slots[index]) : next
      if (Object.is(value, inst.slots[index])) return
      inst.slots[index] = value
      if (!runtime.unmounted) runtime.dirty = true
    }
    return [inst.slots[index], set]
  },
}
// The fake beat: only `setInterval` is faked, so `advance` is the test's sole clock.
const beat = {
  now: 0, nextId: 0, timers: new Map(),
  reset() { this.now = 0; this.nextId = 0; this.timers.clear() },
  setInterval(fn, ms) {
    const id = ++this.nextId
    this.timers.set(id, { at: this.now + (Number(ms) || 0), every: Math.max(1, Number(ms) || 1), fn })
    return id
  },
  clearInterval(id) { this.timers.delete(id) },
  due(target) {
    let found = null
    for (const [id, timer] of this.timers) {
      if (timer.at > target) continue
      if (!found || timer.at < found.timer.at) found = { id, timer }
    }
    return found
  },
  fire(found) {
    this.now = found.timer.at
    this.timers.set(found.id, { ...found.timer, at: found.timer.at + found.timer.every })
    found.timer.fn()
  },
}
const env = {
  module: { exports: {} },
  document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout,
  setInterval: (fn, ms) => beat.setInterval(fn, ms),
  clearInterval: (id) => beat.clearInterval(id),
}
env.require = (name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (node) => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`Unexpected platform module ${name}`)
}
env.module.exports = env.module.exports
runInNewContext(outputFiles[0].text, env)
const { WorkflowsPage, WorkflowsView, readWorkflows, settleWorkflowRead, moveNode, connectNodes, dropBot, removeNode, installLocale, wf } = env.module.exports

const PLUGIN_HINT = 'The Workflow plugin is not installed or not enabled. A default install includes @flybot/workflow.'

function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

const expand = (node, path = 'r') => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((child, at) => expand(child, `${path}.${at}`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return withInstance(path, () => expand(node.type(node.props), path))
  return { ...node, props: { ...node.props, children: expand(node.props.children, path) } }
}
const all = (node, out = []) => {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach((child) => all(child, out))
    else { out.push(node); all(node.props?.children, out) }
  }
  return out
}
const text = (node) => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
// A render pass: drop every fresh effect record, render, then commit the effects
// whose deps changed. A setter fired inside an effect marks the tree dirty, and the
// caller's `settle` renders again — the shape of a page that reacts to a read.
function renderTree(node) {
  runtime.dirty = false
  for (const inst of runtime.instances.values()) inst.pending = []
  const tree = expand(node)
  commitEffects()
  return tree
}
const renderPage = (props) => {
  runtime.reset()
  return renderTree(h(WorkflowsPage, props))
}
const renderView = (props) => expand(h(WorkflowsView, props))

// Mounts the page and hands the test the clock and the tree it can drive. Nothing
// here is a second implementation of the page: the same component renders, the same
// effects run, and `advance` is the only thing that moves time.
function mountPage(props) {
  runtime.reset()
  beat.reset()
  let tree = renderTree(h(WorkflowsPage, props))
  const settle = async () => {
    for (let guard = 0; guard < 50; guard += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!runtime.dirty) return
      tree = renderTree(h(WorkflowsPage, props))
    }
    throw new Error('the page never settled')
  }
  const page = {
    get tree() { return tree },
    settle,
    async advance(ms) {
      const target = beat.now + ms
      for (let guard = 0; guard < 200; guard += 1) {
        const found = beat.due(target)
        if (!found) break
        beat.fire(found)
        // A real 2 s tick lets its read land and re-render before the next tick, so a
        // poll that stops the interval (the run finished) stops it here too.
        await settle()
      }
      beat.now = Math.max(beat.now, target)
    },
    unmount() { unmountAll() },
    async click(match) {
      const button = all(tree).find((entry) => entry.type === 'button' && match(entry))
      assert.ok(button, 'the button the test clicks exists')
      button.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} })
      await settle()
      return button
    },
  }
  return page
}
const chipOf = (tree, id) => {
  const card = all(tree).find((entry) => entry.props?.['data-node'] === id)
  const chip = card ? all(card).find((entry) => typeof entry.props?.className === 'string' && entry.props.className.startsWith('bt-wf-chip')) : null
  return chip ? text(chip) : ''
}
const openWorkflow = (page, id) => page.click((entry) => entry.props?.['data-workflow'] === id)

const HOSTILE = '<img src=x onerror=alert(1)>'
const factory = {
  id: 'delivery',
  name: '发布交付流水线',
  description: 'Planner then a parallel review.',
  chain: 'Planner → Coder → Reviewer ‖ Tester',
  nodes: [
    { id: 'planner', name: 'Planner', role: '计划', x: 0, y: 0 },
    { id: 'coder', name: 'Coder', role: HOSTILE, x: 0, y: 108 },
    { id: 'reviewer', name: 'Reviewer', role: '审阅', x: -94, y: 216 },
    { id: 'tester', name: 'Tester', role: '测试', x: 94, y: 216 },
  ],
  edges: [
    { from: 'planner', to: 'coder' },
    { from: 'coder', to: 'reviewer' },
    { from: 'coder', to: 'tester' },
  ],
  layers: [['planner'], ['coder'], ['reviewer', 'tester']],
}
const own = {
  id: 'wf-mine',
  name: 'Hotfix lane',
  description: 'A short lane.',
  chain: 'Planner → Coder',
  nodes: [
    { id: 'planner', name: 'Planner', role: '计划', x: 0, y: 0 },
    { id: 'coder', name: 'Coder', role: '实现', x: 0, y: 108 },
  ],
  edges: [{ from: 'planner', to: 'coder' }],
  layers: [['planner'], ['coder']],
  run: { status: 'running', nodeStatus: { planner: 'done', coder: 'running' } },
}
const pack = { ok: true, templates: [factory], workflows: [factory, own] }

test('the page is not a file-path tutorial, even while it is still reading', () => {
  const tree = renderPage({ call: () => new Promise(() => {}) })
  const body = text(tree)
  assert.doesNotMatch(body, /workflows\/<id>\.json/)
  assert.doesNotMatch(body, /workflows\/\{id\}\.json/)
  assert.equal(all(tree).some((entry) => entry.props?.className === 'bt-wf-path'), false)
  assert.match(body, /Reading workflows/)
})

test('a settled read lists factory pipelines and your own, and opens the flowchart', () => {
  const tree = renderView({ phase: 'ready', pack, opened: null, error: '' })
  const body = text(tree)
  assert.doesNotMatch(body, /workflows\/<id>\.json/)
  assert.match(body, /Factory presets/)
  assert.match(body, /Yours/)
  assert.match(body, /发布交付流水线/)
  assert.match(body, /Hotfix lane/)
  assert.doesNotMatch(body, /Reading workflows/)

  const opened = renderView({
    phase: 'ready', pack, opened: { source: 'factory', id: 'delivery' }, error: '', editing: false,
    roster: { bots: [{ id: 'bot-docs', name: 'Docs', role: 'notes', remote: false }, { id: 'bot-friend', name: 'Remote', remote: true }] },
  })
  const nodes = all(opened).filter((entry) => entry.props?.['data-node']).map((entry) => entry.props['data-node']).sort()
  assert.deepEqual(nodes, ['coder', 'planner', 'reviewer', 'tester'])
  assert.match(text(opened), /Parallel branch/)
  const wires = all(opened).filter((entry) => entry.type === 'path' && typeof entry.props?.d === 'string' && entry.props.d.startsWith('M '))
  assert.equal(wires.length, factory.edges.length)
  assert.match(wires[0].props.d, /C /)
  // A factory graph has no run, so every seat is idle — not a fake queue.
  assert.match(text(opened), /Idle/)
  assert.doesNotMatch(text(opened), /Queued/)
  assert.equal(all(opened).some((entry) => entry.type === 'img' || entry.type === 'script'), false)
  assert.match(text(opened), new RegExp(HOSTILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const editing = renderView({
    phase: 'ready', pack, opened: { source: 'own', id: 'wf-mine' }, error: '', editing: true,
    roster: { bots: [{ id: 'bot-docs', name: 'Docs', role: 'notes', remote: false }, { id: 'bot-friend', name: 'Remote', remote: true }] },
  })
  assert.match(text(editing), /Docs/)
  assert.doesNotMatch(text(editing), /Remote/)
  assert.match(text(editing), /Done/)
  assert.match(text(editing), /Running/)
  const coder = all(editing).find((entry) => entry.props?.['data-node'] === 'coder')
  assert.match(coder.props.className, /editing/)
  assert.equal(all(coder).some((entry) => entry.props?.['data-remove'] === 'coder'), true)
})

test('#1789: a node the run skipped is named Skipped, the word the Room uses', () => {
  const branchy = {
    id: 'wf-branchy',
    name: 'Branchy lane',
    chain: 'Planner → Coder',
    nodes: [
      { id: 'planner', name: 'Planner', role: '计划', x: 0, y: 0 },
      { id: 'coder', name: 'Coder', role: '实现', x: 0, y: 108 },
    ],
    edges: [{ from: 'planner', to: 'coder' }],
    layers: [['planner'], ['coder']],
    run: { status: 'done', nodeStatus: { planner: 'done', coder: 'skipped' } },
  }
  const view = () => renderView({
    phase: 'ready', pack: { ok: true, templates: [], workflows: [branchy] },
    opened: { source: 'own', id: 'wf-branchy' }, error: '', roster: { bots: [] },
  })
  const chipOf = (tree) => all(tree).find((entry) => typeof entry.props?.className === 'string' && entry.props.className.startsWith('bt-wf-chip skipped'))
  const chip = chipOf(view())
  assert.ok(chip, 'the skipped node is drawn on the canvas')
  assert.equal(text(chip), 'Skipped')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(text(chipOf(view())), '跳过')
  } finally {
    off()
  }
})

test('an empty list and a failed read are settled states, not a permanent reading line', () => {
  const empty = renderView({ phase: 'empty', pack: { templates: [], workflows: [] }, error: '' })
  assert.match(text(empty), /No workflows yet/)
  assert.doesNotMatch(text(empty), /Reading workflows/)
  const failed = renderView({ phase: 'error', error: 'Could not read workflows', pack: null })
  assert.match(text(failed), /Could not read workflows/)
  assert.match(text(failed), /Retry/)
  assert.doesNotMatch(text(failed), /Reading workflows/)
  assert.doesNotMatch(text(failed), /workflows\/<id>\.json/)
})

test('a read that never returns becomes an error, and a good payload opens as ready', async () => {
  const hung = await readWorkflows(() => new Promise(() => {}), { timeoutMs: 15 })
  assert.equal(hung.phase, 'error')
  assert.equal(hung.pack, null)
  const rejected = await readWorkflows(() => { throw new Error('workflow host down') }, { timeoutMs: 1000 })
  assert.equal(rejected.phase, 'error')
  assert.match(rejected.error, /workflow host down/)
  const ready = settleWorkflowRead(pack)
  assert.equal(ready.phase, 'ready')
  assert.equal(settleWorkflowRead({ ok: false, error: 'no' }).phase, 'error')
  assert.equal(settleWorkflowRead({ ok: true, templates: [], workflows: [] }).phase, 'empty')
})

test('a missing workflow plugin is an enable hint, not the host endpoint string (#1381)', async () => {
  const missing = Object.assign(new Error('Unknown FlyBot endpoint workflow/state'), { code: 'bot/not-found' })
  const settled = await readWorkflows(() => { throw missing }, { timeoutMs: 1000 })
  assert.equal(settled.phase, 'error')
  assert.equal(settled.pack, null)
  assert.equal(settled.error, PLUGIN_HINT)
  assert.doesNotMatch(settled.error, /Unknown FlyBot endpoint/)

  const messageOnly = await readWorkflows(() => { throw new Error('Unknown FlyBot endpoint workflow/create') }, { timeoutMs: 1000 })
  assert.equal(messageOnly.error, PLUGIN_HINT)
  const codeOnly = await readWorkflows(() => { throw Object.assign(new Error('no such route'), { code: 'bot/not-found' }) }, { timeoutMs: 1000 })
  assert.equal(codeOnly.error, PLUGIN_HINT)
  const graph = await readWorkflows(() => { throw new Error('Unknown FlyBot endpoint workflow/graph') }, { timeoutMs: 1000 })
  assert.equal(graph.error, PLUGIN_HINT)
  const returned = settleWorkflowRead({ ok: false, error: 'Unknown FlyBot endpoint workflow/state' })
  assert.equal(returned.phase, 'error')
  assert.equal(returned.error, PLUGIN_HINT)
  assert.equal(settleWorkflowRead({ ok: false, error: 'no' }).error, 'no')

  const down = await readWorkflows(() => { throw new Error('workflow host down') }, { timeoutMs: 1000 })
  assert.equal(down.error, 'workflow host down')
  const ready = settleWorkflowRead(pack)
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.error, '')

  const view = renderView({ phase: 'error', error: PLUGIN_HINT, pack: null })
  assert.match(text(view), /not installed or not enabled/)
  assert.match(text(view), /@flybot\/workflow/)
  assert.match(text(view), /Retry/)
  assert.doesNotMatch(text(view), /Unknown FlyBot endpoint/)
  assert.doesNotMatch(text(view), /Reading workflows/)
  const open = renderView({ phase: 'ready', pack, opened: null, error: '' })
  assert.match(text(open), /Factory presets/)
  assert.doesNotMatch(text(open), /not installed or not enabled/)

  assert.equal(DICTIONARY.zh[PLUGIN_HINT], '工作流插件没有安装，或没有启用。默认安装包含 @flybot/workflow。')
  const off = installLocale(fakeLocale('zh'))
  try {
    const zh = renderView({ phase: 'error', error: PLUGIN_HINT, pack: null })
    const body = text(zh)
    assert.match(body, /工作流插件没有安装，或没有启用/)
    assert.match(body, /@flybot\/workflow/)
    assert.match(body, /重试/)
    assert.doesNotMatch(body, /Unknown FlyBot endpoint/)
    assert.doesNotMatch(body, /Retry/)
  } finally {
    off()
  }
})

test('editing the graph moves a node, draws an edge, drops a local Bot and removes one', () => {
  const moved = moveNode(own.nodes, 'coder', 40, 80)
  assert.equal(moved.find((node) => node.id === 'coder').x, 40)
  assert.equal(moved.find((node) => node.id === 'planner').x, 0)
  const wired = connectNodes(own.edges, 'planner', 'coder')
  assert.equal(wired.length, 1)
  const extra = connectNodes(own.edges, 'coder', 'planner')
  assert.ok(extra.some((edge) => edge.from === 'coder' && edge.to === 'planner'))
  const dropped = dropBot(own.nodes, { id: 'bot-docs', name: 'Docs', role: 'notes' }, 12, 24)
  const seat = dropped.find((node) => node.botId === 'bot-docs')
  assert.equal(seat.name, 'Docs')
  assert.equal(seat.x, 12)
  assert.equal(seat.y, 24)
  assert.match(seat.id, /^n\d+$/)
  const gone = removeNode(dropped, extra, seat.id)
  assert.equal(gone.nodes.some((node) => node.id === seat.id), false)
  assert.equal(gone.edges.some((edge) => edge.from === seat.id || edge.to === seat.id), false)
})

test('a drag on the open flowchart commits the moved graph', () => {
  const commits = []
  const tree = renderView({
    phase: 'ready', pack, opened: { source: 'own', id: 'wf-mine' }, editing: true, error: '',
    roster: { bots: [] },
    onCommit: (graph) => commits.push(graph),
  })
  const coder = all(tree).find((entry) => entry.props?.['data-node'] === 'coder')
  coder.props.onPointerDown({ clientX: 10, clientY: 20, target: { dataset: {} } })
  const canvas = all(tree).find((entry) => entry.props?.className === 'bt-wf-canvas')
  canvas.props.onPointerUp({ clientX: 30, clientY: 50, target: { dataset: {} } })
  assert.equal(commits.length, 1)
  assert.equal(commits[0].nodes.find((node) => node.id === 'coder').x, 20)
  assert.equal(commits[0].nodes.find((node) => node.id === 'coder').y, 138)
})

// #1393: a node's system prompt is the prompt of that node's run Bot, and the
// Settings editor writes it the way the sidebar flowchart does — same graph,
// with the edges kept.
test('edit mode sets a node system prompt and the commit keeps the edges', () => {
  const withPrompt = {
    ...own,
    nodes: own.nodes.map((node) => (node.id === 'coder' ? { ...node, prompt: 'Write the fix.' } : node)),
  }
  const mine = { ...pack, workflows: [factory, withPrompt] }

  const readOnly = renderView({ phase: 'ready', pack: mine, opened: { source: 'own', id: 'wf-mine' }, error: '' })
  assert.equal(all(readOnly).some((entry) => entry.type === 'textarea'), false)

  const commits = []
  const tree = renderView({
    phase: 'ready', pack: mine, opened: { source: 'own', id: 'wf-mine' }, editing: true, error: '',
    roster: { bots: [] },
    onCommit: (graph) => commits.push(graph),
  })
  const fields = all(tree).filter((entry) => entry.type === 'textarea')
  assert.deepEqual(fields.map((entry) => entry.props['data-prompt']).sort(), ['coder', 'planner'])
  const coder = fields.find((entry) => entry.props['data-prompt'] === 'coder')
  assert.equal(coder.props.defaultValue, 'Write the fix.')
  const planner = fields.find((entry) => entry.props['data-prompt'] === 'planner')
  assert.equal(planner.props.defaultValue, '')
  assert.match(text(tree), /Coder · System prompt/)

  // An untouched field commits nothing, so a click-through cannot rewrite a graph.
  planner.props.onBlur({ target: { value: '' } })
  coder.props.onBlur({ target: { value: 'Write the fix.' } })
  assert.equal(commits.length, 0)

  planner.props.onBlur({ target: { value: 'Plan the work.' } })
  assert.equal(commits.length, 1)
  assert.equal(commits[0].nodes.find((node) => node.id === 'planner').prompt, 'Plan the work.')
  assert.equal(commits[0].nodes.find((node) => node.id === 'coder').prompt, 'Write the fix.')
  assert.equal(commits[0].nodes.find((node) => node.id === 'planner').x, 0)
  assert.deepEqual(commits[0].edges, own.edges)
  assert.equal(DICTIONARY.zh['System prompt'], '系统提示词')
})

// #1396: opening a factory preset that already has a live copy stores the factory id in
// `fromFactory` (a string), so the copy entry must stay on that graph. Before the fix the
// guard compared it with `true` and the button never rendered.
const labelsOfGraph = (opened) => all(renderView({ phase: 'ready', pack, opened, error: '', editing: false }))
  .filter((entry) => entry.type === 'button')
  .map((entry) => text(entry))

test('a factory preset with a live copy keeps the Use this entry (#1396)', () => {
  assert.deepEqual(labelsOfGraph({ source: 'own', id: 'delivery', fromFactory: 'delivery' }), ['Back', 'Use this', 'Edit'])
})

test('Use this on a preset with a live copy hands the factory id to onUse (#1396)', () => {
  const used = []
  const tree = renderView({
    phase: 'ready', pack, opened: { source: 'own', id: 'delivery', fromFactory: 'delivery' }, error: '', editing: false,
    onUse: (id) => used.push(id),
  })
  const button = all(tree).find((entry) => entry.type === 'button' && text(entry) === 'Use this')
  assert.ok(button, 'the Use this button renders')
  button.props.onClick()
  assert.deepEqual(used, ['delivery'])
})

// The other side of the same contract: a factory preset without a live copy still copies, and
// your own workflow is not a template at all.
test('only a factory-backed graph offers Use this (#1396)', () => {
  assert.deepEqual(labelsOfGraph({ source: 'factory', id: 'delivery' }), ['Back', 'Use this'])
  assert.deepEqual(labelsOfGraph({ source: 'own', id: 'wf-mine' }), ['Back', 'Edit'])
})

// #1752: Settings → Workflows drew a parallel layer as one row whatever the stored y said,
// so a member the editor had left lower sat outside the dashed frame; and it drew the 960px
// design plane at 1:1, so a branch near the right edge (and the wire into it) was clipped by
// the canvas instead of the graph fitting the width.
const forkGraph = {
  id: 'wf-fork',
  name: 'Fork lane',
  description: 'A fork with one stored offset.',
  chain: 'Triage → Claim ‖ 取证 → Gate',
  nodes: [
    { id: 'triage', name: 'Triage', role: '分诊', x: 0, y: 0 },
    { id: 'claim', name: 'Claim', role: '认领', x: -94, y: 108 },
    { id: 'forensics', name: '取证', role: '真机取证', x: 94, y: 159 },
    { id: 'gate', name: 'Gate', role: '门禁', x: 0, y: 267 },
  ],
  edges: [
    { from: 'triage', to: 'claim' },
    { from: 'triage', to: 'forensics' },
    { from: 'claim', to: 'gate' },
    { from: 'forensics', to: 'gate' },
  ],
  layers: [['triage'], ['claim', 'forensics'], ['gate']],
}
const forkPack = { ok: true, templates: [], workflows: [forkGraph] }

test('a parallel frame encloses a member stored lower than its partner (#1752)', () => {
  const tree = renderView({ phase: 'ready', pack: forkPack, opened: { source: 'own', id: forkGraph.id }, error: '', editing: false })
  const frame = all(tree).find((entry) => entry.props?.className === 'bt-wf-par')
  assert.ok(frame, 'the parallel frame renders')
  const left = frame.props.style.left
  const top = frame.props.style.top
  const right = left + frame.props.style.width
  const bottom = top + frame.props.style.height
  const pair = all(tree)
    .filter((entry) => ['claim', 'forensics'].includes(entry.props?.['data-node']))
    .map((entry) => {
      const cardLeft = entry.props.style.left
      const cardTop = entry.props.style.top
      return { id: entry.props['data-node'], left: cardLeft, top: cardTop, right: cardLeft + 168, bottom: cardTop + 72 }
    })
  assert.equal(pair.length, 2)
  for (const card of pair) {
    assert.ok(left <= card.left && top <= card.top && right >= card.right && bottom >= card.bottom,
      `the frame ${top}..${bottom} leaves ${card.id} (${card.top}..${card.bottom}) outside`)
  }
})

test('the Settings graph fits its plane into the canvas width (#1752)', () => {
  const tree = renderView({ phase: 'ready', pack: forkPack, opened: { source: 'own', id: forkGraph.id }, error: '', editing: false })
  const fit = all(tree).find((entry) => entry.props?.className === 'bt-wf-fit')
  assert.ok(fit, 'the canvas wraps the plane in a fit layer')
  assert.match(String(fit.props.style?.transform ?? ''), /scale\(/)
})

test('a fitted graph keeps the right-hand card and the wire into it inside the canvas (#1752)', () => {
  assert.equal(typeof wf.fitScale, 'function', 'the fit is a pure helper')
  // The reported workflow stored the branch card at x = 226, past the 380px canvas edge.
  const nodes = forkGraph.nodes.map((node) => (node.id === 'forensics' ? { ...node, x: 226 } : node))
  const width = 380
  const scale = wf.fitScale(nodes, width)
  assert.ok(scale < 1, `a ${width}px canvas scales a graph that reaches 310px from its centre`)
  assert.ok(scale >= 0.5, 'the plane never shrinks past half size')
  const half = width / 2
  for (const node of nodes) {
    assert.ok((Math.abs(node.x ?? 0) + 84) * scale <= half + 0.01,
      `${node.id} stays inside the canvas after the fit`)
  }
  assert.ok(226 * scale <= half + 0.01, 'the Claim → 取证 arrowhead lands inside the canvas, not on the clip line')
})

// #1769: below MIN_FIT the drawing stops shrinking, so a graph wider than the canvas
// overflowed on both sides — and the left half of a scroller cannot be reached, because
// `scrollLeft` stops at 0. The fit therefore reserves the left overflow as stage padding,
// so nothing sits left of the canvas edge and the rest scrolls to the right.
const NARROW = 380
const wideGraph = {
  ...forkGraph,
  nodes: forkGraph.nodes.map((node) => (node.id === 'forensics' ? { ...node, x: -400 } : node)),
}
const widePack = { ok: true, templates: [], workflows: [wideGraph] }
const wideLayout = () => wf.fitLayout(wideGraph.nodes, NARROW)

test('a graph wider than the canvas is fitted at half size with a reachable left edge (#1769)', () => {
  assert.equal(typeof wf.fitLayout, 'function', 'the fit and its offset come from one helper')
  const layout = wideLayout()
  // 400px of card plus the 108px frame reach the canvas as 508px; half a 380px canvas is
  // 190px, so #1752's scale stops at the MIN_FIT floor instead of shrinking further.
  assert.equal(layout.scale, 0.5)
  // The 64px the plane still overflows is reserved on the LEFT of the stage, so the
  // scroller only ever has to scroll right.
  assert.equal(layout.pad, 64)
  assert.equal(layout.left, 0)
  assert.ok(layout.right > NARROW, 'the graph still overflows on the right, where it can be scrolled')
  assert.ok(layout.scrollWidth - NARROW > 0, 'the canvas keeps a scroll range')
  assert.ok(layout.scrollWidth >= layout.right, 'the scroll range covers the right edge it draws')
  // The leftmost card sits at the canvas' own left edge in screen pixels: pad + width/2
  // centred, then the card's own half (84px) at the fitted scale (CARD_HALF).
  const cardLeft = layout.pad + NARROW / 2 + (-400 - 84) * layout.scale
  assert.equal(cardLeft, 12, 'the leftmost card starts 12px INSIDE the canvas, not under the clip line')
})

test('the fitted stage carries the left offset and the plane is the same size as the helper says (#1769)', () => {
  const tree = renderView({
    phase: 'ready', pack: widePack, opened: { source: 'own', id: wideGraph.id }, error: '', editing: false,
    canvasWidth: NARROW,
  })
  const stage = all(tree).find((entry) => entry.props?.className === 'bt-wf-stage')
  const fit = all(tree).find((entry) => entry.props?.className === 'bt-wf-fit')
  assert.ok(stage, 'the stage renders')
  assert.ok(fit, 'the fit layer renders')
  assert.equal(stage.props.style.paddingLeft, 64)
  assert.equal(fit.props.style.transform, 'scale(0.5)')
  assert.equal(stage.props.style.height, Math.round(Math.max(420, ...wideGraph.nodes.map((node) => node.y + 150)) * 0.5))
})

test('a graph that fits keeps the #1752 scale and no left offset (#1769)', () => {
  // The reported regression would be a wider change: a plane that fits must keep the scale
  // #1752 shipped with, and must not be shifted by even one pixel.
  assert.equal(wf.fitScale(forkGraph.nodes, NARROW), 190 / 202)
  const layout = wf.fitLayout(forkGraph.nodes, NARROW)
  assert.equal(layout.pad, 0)
  assert.ok(Math.abs(layout.left) < 1e-6, `the fitted plane starts at the canvas edge (${layout.left})`)
  const tree = renderView({
    phase: 'ready', pack: forkPack, opened: { source: 'own', id: forkGraph.id }, error: '', editing: false,
    canvasWidth: NARROW,
  })
  const stage = all(tree).find((entry) => entry.props?.className === 'bt-wf-stage')
  const fit = all(tree).find((entry) => entry.props?.className === 'bt-wf-fit')
  assert.equal(stage.props.style.paddingLeft, undefined, 'a plane that fits is not padded')
  assert.equal(fit.props.style.transform, `scale(${190 / 202})`)
})

test('the measured width is the canvas clientWidth, the same box the scroll range is read in (#1769)', () => {
  // `clientWidth` excludes the border and includes the padding, which is exactly the box the
  // pad is reserved in — so the measurement is injected as that same property, never as a
  // border box, and the pad does not pay a pixel for the border.
  const el = { getBoundingClientRect: () => ({ width: NARROW + 2 }) }
  Object.defineProperty(el, 'clientWidth', { value: NARROW, configurable: true })
  assert.equal(wf.measureCanvasWidth(el), NARROW, 'clientWidth decides, not the border box')
  assert.equal(wf.fitLayout(wideGraph.nodes, wf.measureCanvasWidth(el)).pad, 64, 'the border is not folded into the pad')
  assert.equal(wf.measureCanvasWidth({}), 0, 'a host that has no layout yet reads as 0')
  assert.equal(wf.measureCanvasWidth({ clientWidth: -1 }), 0)
  assert.equal(wf.measureCanvasWidth({ clientWidth: Number.NaN }), 0)
})

// #1810: Settings → Workflows read once at mount, so a step that went running → done
// left its chip frozen until the page was reopened, while the room drawer for the same
// run already moved every 2 s. These cases drive the page through a fake clock: the
// mount read, then the ticks, then the render each answer causes.
const livePack = (nodeStatus, { activeCount = 1, status = 'running' } = {}) => ({
  ok: true,
  templates: [factory],
  workflows: [{ ...own, activeCount, run: { status, nodeStatus } }],
})

test('#1810: a running workflow is read again every 2 s and the chip follows the run', async () => {
  let reads = 0
  const answers = [
    livePack({ planner: 'done', coder: 'running' }),
    livePack({ planner: 'done', coder: 'done' }, { activeCount: 0, status: 'done' }),
  ]
  const page = mountPage({
    call: async () => {
      reads += 1
      return answers[Math.min(reads - 1, answers.length - 1)]
    },
    roster: { bots: [] },
  })
  await page.settle()
  assert.equal(reads, 1, 'the mount read')
  await openWorkflow(page, 'wf-mine')
  assert.equal(chipOf(page.tree, 'coder'), 'Running')

  await page.advance(6000)
  assert.ok(reads >= 2, `the page asked again while the run was live (${reads} read(s))`)
  assert.equal(chipOf(page.tree, 'coder'), 'Done', 'the chip moved without remounting the page')
  assert.equal(chipOf(page.tree, 'planner'), 'Done')

  // The last answer said every run is finished, so the beat stops: no more reads.
  assert.equal(reads, 2)
  await page.advance(6000)
  assert.equal(reads, 2, 'a finished run is not read again')
})

test('#1810: nothing running means one read in ten seconds, not a poll', async () => {
  let reads = 0
  const idle = { ok: true, templates: [factory], workflows: [{ ...own, activeCount: 0, run: { status: 'done', nodeStatus: { planner: 'done', coder: 'done' } } }] }
  const page = mountPage({ call: async () => { reads += 1; return idle }, roster: { bots: [] } })
  await page.settle()
  assert.equal(reads, 1)
  await page.advance(10000)
  assert.equal(reads, 1, 'an idle page never asks a second time')
})

test('#1810: an edit suspends the poll and finishing it brings the poll back', async () => {
  let reads = 0
  const page = mountPage({ call: async () => { reads += 1; return livePack({ planner: 'done', coder: 'running' }) }, roster: { bots: [] } })
  await page.settle()
  await openWorkflow(page, 'wf-mine')
  await page.click((entry) => text(entry) === 'Edit')
  assert.equal(reads, 1)
  await page.advance(10000)
  assert.equal(reads, 1, 'a refresh does not land in the middle of an edit')
  await page.click((entry) => text(entry) === 'Finish editing')
  await page.advance(2500)
  assert.equal(reads, 2, 'leaving the editor resumes the beat')
})

test('#1810: a page that unmounts stops asking', async () => {
  let reads = 0
  const page = mountPage({ call: async () => { reads += 1; return livePack({ planner: 'done', coder: 'running' }) }, roster: { bots: [] } })
  await page.settle()
  assert.equal(reads, 1)
  page.unmount()
  await page.advance(10000)
  assert.equal(reads, 1, 'no read after the page is gone')
})

test('#1810: a failed poll shows the error line and Retry, not an empty page', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let reads = 0
    const page = mountPage({
      call: async () => {
        reads += 1
        if (reads === 1) return livePack({ planner: 'done', coder: 'running' })
        throw new Error('workflow host down')
      },
      roster: { bots: [] },
    })
    await page.settle()
    await openWorkflow(page, 'wf-mine')
    await page.advance(2000)
    assert.equal(reads, 2, 'the poll happened and failed')
    const body = text(page.tree)
    assert.match(body, /workflow host down/)
    assert.match(body, /Retry/)
    assert.doesNotMatch(body, /No workflows yet/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

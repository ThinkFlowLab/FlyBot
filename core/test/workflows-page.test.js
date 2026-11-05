// Settings → Workflows (#1364). The page lists factory pipelines and the owner's own
// workflows and opens the drag-drop flowchart. It does not teach workflows/<id>.json,
// and a read that never returns settles as an error instead of "Reading workflows…".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'
import { normalizeGraph } from '../../plugins/workflow/src/graph.js'
import { deliveryWorkflow } from '../../plugins/workflow/src/template.js'

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
  // P-395 adds a hit path per route, so this counts the drawn stroke: one per edge.
  const wires = all(opened).filter((entry) => entry.type === 'path' && entry.props?.['data-route'] !== undefined
    && typeof entry.props?.d === 'string' && entry.props.d.startsWith('M '))
  assert.equal(wires.length, factory.edges.length)
  assert.match(wires[0].props.d, /M .* L /)
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

// #2017: the avatar took the name's first UTF-16 unit, so a name starting with an emoji
// showed the lone surrogate `\ud83d` in place of the emoji. One code point is what the circle
// shows, and a node with no name still falls back to `?`.
test('#2017: a node avatar takes the first code point, so an emoji name is whole', () => {
  const lane = {
    id: 'wf-rocket',
    name: 'Rocket lane',
    chain: '🚀 Deployer → Nameless',
    nodes: [
      { id: 'launch', name: '🚀 Deployer', role: '发布', x: 0, y: 0 },
      { id: 'nameless', role: '无名', x: 0, y: 108 },
    ],
    edges: [{ from: 'launch', to: 'nameless' }],
  }
  const view = renderView({
    phase: 'ready', pack: { ok: true, templates: [], workflows: [lane] },
    opened: { source: 'own', id: 'wf-rocket' }, error: '', roster: { bots: [] },
  })
  const avatarOf = (id) => {
    const card = all(view).find((entry) => entry.props?.['data-node'] === id)
    const avatar = card ? all(card).find((entry) => entry.props?.className === 'bt-wf-av') : null
    assert.ok(avatar, `the ${id} node is drawn with an avatar`)
    return text(avatar)
  }
  const rocket = avatarOf('launch')
  assert.equal(rocket, '🚀')
  assert.equal(rocket.isWellFormed(), true, 'the avatar is not half a surrogate pair')
  assert.equal(avatarOf('nameless'), '?')
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

// #2122: the run canvas drew every wire as the same symmetric cubic between card
// centres (same mid point, same tangent), so a fork's two arms, a join's two arms and
// every back edge collapsed onto one stroke; a wire whose endpoints shared an x became
// a straight vertical that ran through whatever card sat between them. The routes are
// pinned here by the path each wire actually carries, not by the node positions.
const runGraph = {
  id: 'wf-run',
  name: 'Run lane',
  description: 'A fork, a join and a return path.',
  chain: 'Triage → Claim ‖ 取证 → Gate → Escalate',
  nodes: [
    { id: 'triage', name: 'Triage', role: '分诊', x: 0, y: 0 },
    { id: 'claim', name: 'Claim', role: '认领', x: -94, y: 108 },
    { id: 'forensics', name: '取证', role: '真机取证', x: 94, y: 159 },
    { id: 'gate', name: 'Gate', role: '门禁', x: 0, y: 267 },
    { id: 'escalate', name: 'Escalate', role: '升级', x: 0, y: 360 },
  ],
  edges: [
    { from: 'triage', to: 'claim' },
    { from: 'triage', to: 'forensics' },
    { from: 'claim', to: 'gate' },
    { from: 'forensics', to: 'gate' },
    { from: 'gate', to: 'escalate' },
    { from: 'escalate', to: 'claim' },
  ],
  layers: [['triage'], ['claim', 'forensics'], ['gate'], ['escalate']],
}
const runPack = { ok: true, templates: [], workflows: [runGraph] }
const CARD_W = 168
const cubicAt = (a, b, c, d, t) => {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}
// Every curve is flattened into points about 2px apart, so distance and run length can
// be measured on the drawn stroke rather than on its control points.
function flattenPath(d) {
  const tokens = String(d).match(/[MLCQ]|-?\d+(?:\.\d+)?/g) ?? []
  const points = []
  let x = 0
  let y = 0
  let at = 0
  while (at < tokens.length) {
    const op = tokens[at]
    if (op === 'M') {
      x = Number(tokens[at + 1])
      y = Number(tokens[at + 2])
      points.push([x, y])
      at += 3
      continue
    }
    if (op === 'L' || op === 'Q') {
      const nx = Number(tokens[at + 1])
      const ny = Number(tokens[at + 2])
      const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 2))
      for (let step = 1; step <= steps; step += 1) points.push([x + ((nx - x) * step) / steps, y + ((ny - y) * step) / steps])
      x = nx
      y = ny
      at += op === 'Q' ? 5 : 3
      continue
    }
    if (op === 'C') {
      const [x1, y1, x2, y2, x3, y3] = tokens.slice(at + 1, at + 7).map(Number)
      const sx = x
      const sy = y
      for (let step = 1; step <= 48; step += 1) {
        const t = step / 48
        points.push([cubicAt(sx, x1, x2, x3, t), cubicAt(sy, y1, y2, y3, t)])
      }
      x = x3
      y = y3
      at += 7
      continue
    }
    at += 1
  }
  return points
}
const wireOf = (tree, from, to) => all(tree).find((entry) => entry.props?.markerEnd === 'url(#bt-wf-arrow)'
  && String(entry.props.key ?? '') === `${from}>${to}`)
const cardsOf = (tree, heights = {}) => new Map(all(tree)
  .filter((entry) => typeof entry.props?.['data-node'] === 'string')
  .map((entry) => {
    const top = entry.props.style.top
    return [entry.props['data-node'], {
      id: entry.props['data-node'],
      left: entry.props.style.left,
      top,
      right: entry.props.style.left + CARD_W,
      bottom: top + (heights[entry.props['data-node']] ?? 72),
    }]
  }))
const insideCard = (card, [x, y]) => x > card.left + 0.5 && x < card.right - 0.5 && y > card.top + 0.5 && y < card.bottom - 0.5

test('#2122: every wire leaves a port and never cuts through a card', () => {
  const tree = renderView({ phase: 'ready', pack: runPack, opened: { source: 'own', id: runGraph.id }, error: '', editing: false })
  const cards = cardsOf(tree)
  const failures = []
  for (const edge of runGraph.edges) {
    const wire = wireOf(tree, edge.from, edge.to)
    assert.ok(wire, `the wire ${edge.from}>${edge.to} renders`)
    const from = cards.get(edge.from)
    const to = cards.get(edge.to)
    const points = flattenPath(wire.props.d)
    const first = points[0]
    const last = points[points.length - 1]
    // A forward edge runs port-to-port down the bottom and top edges; a back edge (its
    // target above its source) leaves and lands on the right edge, so it can loop.
    const back = to.top < from.top
    if (back) {
      if (first[0] !== from.right || last[0] !== to.right) failures.push(`${edge.from}>${edge.to} is a back edge but does not leave ${edge.from} and land on ${edge.to} at their right edges (${first} -> ${last})`)
    } else {
      if (first[0] !== (from.left + from.right) / 2 || first[1] !== from.bottom) failures.push(`${edge.from}>${edge.to} does not leave ${edge.from}'s bottom port (${first} instead of [${(from.left + from.right) / 2}, ${from.bottom}])`)
      if (last[0] !== (to.left + to.right) / 2 || last[1] !== to.top) failures.push(`${edge.from}>${edge.to} does not land on ${edge.to}'s top port (${last} instead of [${(to.left + to.right) / 2}, ${to.top}])`)
    }
    for (const card of cards.values()) {
      const hit = points.find((point) => insideCard(card, point))
      if (hit) failures.push(`${edge.from}>${edge.to} crosses ${card.id} at [${hit[0].toFixed(1)}, ${hit[1].toFixed(1)}]`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('#2122: a back edge is a visible loop outside the cards, not a stub', () => {
  const tree = renderView({ phase: 'ready', pack: runPack, opened: { source: 'own', id: runGraph.id }, error: '', editing: false })
  const cards = cardsOf(tree)
  const rightMost = Math.max(...[...cards.values()].map((card) => card.right))
  const wire = wireOf(tree, 'escalate', 'claim')
  assert.ok(wire, 'the back edge renders')
  const points = flattenPath(wire.props.d)
  const reach = Math.max(...points.map((point) => point[0]))
  assert.ok(reach > rightMost + 3, `the loop turns outside every card (reached ${reach.toFixed(1)}, the cards end at ${rightMost})`)
  const from = cards.get('escalate')
  const to = cards.get('claim')
  assert.ok(points[0][0] === from.right && points[0][1] > from.top && points[0][1] < from.bottom,
    `the loop leaves Escalate's right edge (${points[0]})`)
  assert.ok(points[points.length - 1][0] === to.right && points[points.length - 1][1] > to.top && points[points.length - 1][1] < to.bottom,
    `the loop lands on Claim's right edge (${points[points.length - 1]})`)
})

test('#2122: no two wires share one stroke for more than 20px', () => {
  const tree = renderView({ phase: 'ready', pack: runPack, opened: { source: 'own', id: runGraph.id }, error: '', editing: false })
  const routed = runGraph.edges.map((edge) => ({ key: `${edge.from}>${edge.to}`, points: flattenPath(wireOf(tree, edge.from, edge.to).props.d) }))
  const closeRuns = []
  for (let a = 0; a < routed.length; a += 1) {
    for (let b = a + 1; b < routed.length; b += 1) {
      const one = routed[a]
      const two = routed[b]
      let run = 0
      let worst = 0
      for (let at = 0; at < one.points.length; at += 1) {
        const point = one.points[at]
        const near = two.points.some((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) < 3)
        const step = at === 0 ? 0 : Math.hypot(point[0] - one.points[at - 1][0], point[1] - one.points[at - 1][1])
        run = near ? run + step : 0
        worst = Math.max(worst, run)
      }
      if (worst > 20) closeRuns.push(`${one.key} and ${two.key} run within 3px for ${worst.toFixed(1)}px`)
    }
  }
  assert.deepEqual(closeRuns, [], closeRuns.join('\n'))
})

test('#2122: the dashed parallel frame is built from the measured cards, not 72px', () => {
  // The run card grows with its status chip and its two text lines, so the authored
  // 72px metric is a floor. A host that knows the measured heights seeds them the way
  // `canvasWidth` seeds the width; the browser measurement wins on the next frame.
  const heights = { claim: 96, forensics: 88 }
  const tree = renderView({
    phase: 'ready', pack: runPack, opened: { source: 'own', id: runGraph.id }, error: '', editing: false,
    cardHeights: heights,
  })
  const frame = all(tree).find((entry) => entry.props?.className === 'bt-wf-par')
  assert.ok(frame, 'the parallel frame renders')
  const cards = cardsOf(tree, heights)
  const pair = ['claim', 'forensics'].map((id) => cards.get(id))
  const left = Math.min(...pair.map((card) => card.left))
  const right = Math.max(...pair.map((card) => card.right))
  const top = Math.min(...pair.map((card) => card.top))
  const bottom = Math.max(...pair.map((card) => card.bottom))
  const box = { left: frame.props.style.left, top: frame.props.style.top }
  box.right = box.left + frame.props.style.width
  box.bottom = box.top + frame.props.style.height
  const margins = [left - box.left, box.right - right, top - box.top, box.bottom - bottom]
  assert.ok(margins.every((margin) => margin > 0), `the frame ${JSON.stringify(box)} encloses the measured cards ${JSON.stringify({ left, right, top, bottom })}: margins ${margins}`)
  assert.deepEqual(margins, [margins[0], margins[0], margins[0], margins[0]], `the four margins are equal (${margins})`)
  // The wire into the frame's cards uses the measured bottom edge too.
  const join = flattenPath(wireOf(tree, 'claim', 'gate').props.d)
  assert.equal(join[0][1], 108 + heights.claim, 'the wire leaves the measured bottom of the card')
})

test('#2122: a card between two cards on one column sends the wire round it', () => {
  // The fork/join graph keeps every intervening card off a wire's own column, so it
  // cannot reach this: when the lane search gave up the forward route fell back onto
  // the column and ran as one vertical from the source's bottom port to the target's
  // top port, straight through the card sitting between them. Same x, one card between.
  const stackGraph = {
    id: 'wf-stack',
    name: 'Stacked lane',
    description: 'One column, with a card between.',
    chain: 'A → C',
    nodes: [
      { id: 'a', name: 'A', role: '甲', x: 0, y: 0 },
      { id: 'b', name: 'B', role: '乙', x: 0, y: 120 },
      { id: 'c', name: 'C', role: '丙', x: 0, y: 260 },
    ],
    edges: [{ from: 'a', to: 'c' }],
    layers: [['a'], ['b'], ['c']],
  }
  const tree = renderView({
    phase: 'ready',
    pack: { ok: true, templates: [], workflows: [stackGraph] },
    opened: { source: 'own', id: stackGraph.id },
    error: '', editing: false,
  })
  const cards = cardsOf(tree)
  const wire = wireOf(tree, 'a', 'c')
  assert.ok(wire, 'the wire a>c renders')
  const points = flattenPath(wire.props.d)
  const between = cards.get('b')
  const hit = points.find((point) => insideCard(between, point))
  assert.equal(hit, undefined, `the wire a>c runs through the card between them: ${wire.props.d}`)
  // Round the card, not along its edge: the route has to leave the column they share.
  const reach = Math.max(...points.map((point) => Math.abs(point[0])))
  assert.ok(reach > CARD_W / 2 + 3, `the wire a>c stays on the shared column (reached ${reach.toFixed(1)}, the card edge is at ${CARD_W / 2}): ${wire.props.d}`)
  const from = cards.get('a')
  const to = cards.get('c')
  assert.deepEqual(points[0], [(from.left + from.right) / 2, from.bottom], "the wire leaves A's bottom port")
  assert.deepEqual(points[points.length - 1], [(to.left + to.right) / 2, to.top], "the wire lands on C's top port")
})

// P-395: two wires that end at the same port are one stroke to the eye, and the SVG was
// `aria-hidden` with no per-wire name, so a narration that says "Reviewer hands it back"
// left no way to point at which wire. Every route now carries a hit path of its own that
// names the two cards it joins and points at itself while the pointer is on it. Read-only,
// that is all it does: no commit.
const wireName = (graph, from, to) => {
  const name = (id) => graph.nodes.find((node) => node.id === id)?.name ?? id
  return `${name(from)} → ${name(to)}`
}
const hitOf = (tree, from, to) => all(tree).find((entry) => entry.props?.['data-hit'] !== undefined
  && entry.props?.['data-key'] === `${from}>${to}`)
const drawnWireOf = (tree, from, to) => all(tree).find((entry) => entry.props?.markerEnd === 'url(#bt-wf-arrow)'
  && entry.props?.['data-key'] === `${from}>${to}`)
// A view whose state setters re-render: hovering a wire is a setter, and the assert has to
// see the tree the second render produced.
function mountView(props) {
  runtime.reset()
  let tree = renderTree(h(WorkflowsView, props))
  const render = () => {
    for (let guard = 0; guard < 10; guard += 1) {
      tree = renderTree(h(WorkflowsView, props))
      if (!runtime.dirty) break
    }
    return tree
  }
  return { get tree() { return tree }, render }
}
const flowView = (props = {}) => ({ phase: 'ready', pack: runPack, opened: { source: 'own', id: runGraph.id }, error: '', editing: false, ...props })

test('P-395: every wire joins two named cards, and a hit path names them', () => {
  const tree = renderView(flowView())
  const failures = []
  for (const edge of runGraph.edges) {
    const key = `${edge.from}>${edge.to}`
    const hit = hitOf(tree, edge.from, edge.to)
    if (!hit) { failures.push(`${key} has no hit path of its own`); continue }
    if (hit.props['data-key'] !== key) failures.push(`${key} hit path is keyed ${JSON.stringify(hit.props['data-key'])}`)
    if (hit.props.style?.strokeWidth !== 10) failures.push(`${key} hit path is ${hit.props.style?.strokeWidth}px wide, not 10`)
    const title = all(hit).find((entry) => entry.type === 'title')
    const label = title ? text(title) : ''
    if (label !== wireName(runGraph, edge.from, edge.to)) failures.push(`${key} names ${JSON.stringify(label)}, not ${JSON.stringify(wireName(runGraph, edge.from, edge.to))}`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('P-395: hovering one wire points at it and dims the others, then lets them all go', () => {
  const view = mountView(flowView())
  const hit = hitOf(view.tree, 'triage', 'claim')
  assert.ok(hit, 'the triage>claim wire has a hit path to hover')
  hit.props.onPointerEnter({})
  view.render()
  const failures = []
  for (const edge of runGraph.edges) {
    const key = `${edge.from}>${edge.to}`
    const wire = drawnWireOf(view.tree, edge.from, edge.to)
    if (!wire) { failures.push(`${key} is not drawn`); continue }
    if (key === 'triage>claim') {
      if (wire.props['data-active'] === undefined) failures.push(`${key} is not marked active while the pointer is on it`)
      if (wire.props['data-dim'] !== undefined) failures.push(`${key} is dimmed while the pointer is on it`)
    } else {
      if (wire.props['data-dim'] === undefined) failures.push(`${key} is not dimmed while another wire is pointed at`)
      if (wire.props['data-active'] !== undefined) failures.push(`${key} is marked active while the pointer is elsewhere`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
  const pointed = hitOf(view.tree, 'triage', 'claim')
  pointed.props.onPointerLeave({})
  view.render()
  const leftover = all(view.tree).filter((entry) => entry.type === 'path'
    && entry.props?.['data-key'] && (entry.props['data-active'] !== undefined || entry.props['data-dim'] !== undefined))
  assert.deepEqual(leftover.map((entry) => entry.props['data-key']), [], 'nothing stays pointed at after the pointer leaves')
})

test('P-395: a read-only graph commits nothing when a wire is hovered or clicked', async () => {
  let commits = 0
  const view = mountView(flowView({ onCommit: () => { commits += 1 } }))
  const hit = hitOf(view.tree, 'triage', 'claim')
  assert.ok(hit, 'a wire has a hit path to point at')
  hit.props.onPointerEnter({})
  view.render()
  const now = hitOf(view.tree, 'triage', 'claim')
  now.props.onPointerDown?.({ preventDefault() {}, stopPropagation() {}, target: { dataset: {} } })
  now.props.onPointerUp?.({ preventDefault() {}, stopPropagation() {}, target: { dataset: {} } })
  now.props.onClick?.({ preventDefault() {}, stopPropagation() {}, target: { dataset: {} } })
  view.render()
  assert.equal(commits, 0, 'a read-only flowchart commits nothing from a wire')
})

// #2126 routed a back edge as two straight horizontal runs at the two cards' centres.
// A parallel layer seats a card on that same row, so either run passes through it and
// the card, drawn on top, hides the wire: the delivery template's Reviewer ‖ Tester row
// is that exact case, and `loop` is the edge the sidebar's Add link → Loop creates.
const loopRoute = (from, to, height) => {
  const delivery = normalizeGraph(deliveryWorkflow())
  const graph = normalizeGraph({ ...delivery, edges: [...delivery.edges, { from, to, loop: true, max: 3 }] })
  const heights = height ? Object.fromEntries(graph.nodes.map((node) => [node.id, height])) : {}
  const route = wf.wireRoutes(graph.nodes, graph.edges, heights).find((one) => one.key === `${from}>${to}`)
  const cards = new Map(graph.nodes.map((node) => [node.id, {
    id: node.id,
    left: node.x - CARD_W / 2,
    right: node.x + CARD_W / 2,
    top: node.y,
    bottom: node.y + (heights[node.id] ?? 72),
  }]))
  return { graph, route, cards, points: route ? flattenPath(route.d) : [] }
}
const crossingsOf = (route, cards, from, to) => {
  const failures = []
  for (const card of cards.values()) {
    if (card.id === from || card.id === to) continue
    const hit = route.find((point) => insideCard(card, point))
    if (hit) failures.push(`${card.id} at [${hit[0].toFixed(1)}, ${hit[1].toFixed(1)}]`)
  }
  return failures
}
test('#2138: a back edge out of a parallel layer clears the card beside it', () => {
  for (const height of [undefined, 48, 96]) {
    const { route, cards, points } = loopRoute('deployer', 'reviewer', height)
    assert.ok(route, `deployer>reviewer renders (height ${height ?? 72})`)
    assert.equal(route.back, true, 'deployer>reviewer is a back edge')
    const failures = crossingsOf(points, cards, 'deployer', 'reviewer')
    assert.deepEqual(failures, [], `deployer>reviewer runs through ${failures.join(', ')} (height ${height ?? 72}): ${route.d}`)
    // The run that crosses the row happens in the gap above it, so the loop still
    // turns outside every card.
    const rightMost = Math.max(...[...cards.values()].map((card) => card.right))
    assert.ok(Math.max(...points.map((point) => point[0])) > rightMost + 3, `the loop turns outside every card (${route.d})`)
  }
})
test('#2138: a back edge that leaves a parallel layer clears the card beside it', () => {
  for (const height of [undefined, 48, 96]) {
    const { route, cards, points } = loopRoute('reviewer', 'coder', height)
    assert.ok(route, `reviewer>coder renders (height ${height ?? 72})`)
    assert.equal(route.back, true, 'reviewer>coder is a back edge')
    const failures = crossingsOf(points, cards, 'reviewer', 'coder')
    assert.deepEqual(failures, [], `reviewer>coder runs through ${failures.join(', ')} (height ${height ?? 72}): ${route.d}`)
  }
})
// #2151: a forward-branch edge can join two cards seated on ONE row — a loop across a
// parallel layer, or a skip across a plain row. Such a pair has no corridor between it:
// the source's bottom sits below the target's top, so the gap clamp went to 0 and the
// lane search was then handed an inverted interval (yA above yB). No card can overlap an
// inverted interval, so every slot looked open and the vertical run fell back onto the
// row's centre column — straight through a card seated there, which is drawn on top and
// hides the stroke. Both shapes are pinned here.
const rowRoute = (nodes, edges, from, to, heights = {}) => {
  const boxes = wf.cardBoxes(nodes, heights)
  const route = wf.wireRoutes(nodes, edges, heights).find((one) => one.key === `${from}>${to}`)
  const cards = new Map([...boxes.values()].map((box) => [box.id, {
    id: box.id,
    left: box.cx - CARD_W / 2,
    right: box.cx + CARD_W / 2,
    top: box.top,
    bottom: box.bottom,
  }]))
  return { route, cards, points: route ? flattenPath(route.d) : [] }
}
// The drawn stroke must clear every card that is not one of its two ends, and the wire
// must still leave and land on its ports: a run hidden under a card reads as a link to
// the neighbour, and a run that stopped short would not read as a wire at all.
const assertWireClearsRow = (route, cards, points, from, to) => {
  assert.ok(route, `${from}>${to} renders`)
  const failures = crossingsOf(points, cards, from, to)
  assert.deepEqual(failures, [], `${from}>${to} runs through ${failures.join(', ')}: ${route.d}`)
  const first = points[0]
  const last = points[points.length - 1]
  assert.deepEqual([first[0], first[1]], [cards.get(from).left + CARD_W / 2, cards.get(from).bottom], `${from}>${to} leaves ${from}'s bottom port (${route.d})`)
  assert.deepEqual([last[0], last[1]], [cards.get(to).left + CARD_W / 2, cards.get(to).top], `${from}>${to} lands on ${to}'s top port (${route.d})`)
}
test('#2151: a loop across one parallel layer clears the middle card', () => {
  // The row's cards are measured one by one, so they are not the same height: a taller
  // card beside the run must not swallow it either.
  for (const heights of [{ b1: 72, b2: 72, b3: 72 }, { b1: 48, b2: 48, b3: 48 }, { b1: 96, b2: 72, b3: 96 }, { b1: 72, b2: 96, b3: 72 }, { b1: 96, b2: 48, b3: 72 }]) {
    const nodes = [
      { id: 'start', name: 'Start', x: 0, y: 0 },
      { id: 'b1', name: 'Branch 1', x: -200, y: 108 },
      { id: 'b2', name: 'Branch 2', x: 0, y: 108 },
      { id: 'b3', name: 'Branch 3', x: 200, y: 108 },
    ]
    const edges = [
      { from: 'start', to: 'b1' }, { from: 'start', to: 'b2' }, { from: 'start', to: 'b3' },
      { from: 'b3', to: 'b1', loop: true },
    ]
    const measured = { start: 72, ...heights }
    const { route, cards, points } = rowRoute(nodes, edges, 'b3', 'b1', measured)
    assert.equal(route.back, false, 'a loop between two cards on one row takes the forward branch')
    assertWireClearsRow(route, cards, points, 'b3', 'b1')
  }
})
test('#2151: a skip across one row clears the middle card', () => {
  for (const heights of [{ a: 72, b: 72, c: 72 }, { a: 48, b: 48, c: 48 }, { a: 96, b: 72, c: 96 }, { a: 72, b: 96, c: 72 }, { a: 96, b: 48, c: 72 }]) {
    const nodes = [
      { id: 'a', name: 'A', x: 0, y: 120 },
      { id: 'b', name: 'B', x: 200, y: 120 },
      { id: 'c', name: 'C', x: 400, y: 120 },
    ]
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }]
    const { route, cards, points } = rowRoute(nodes, edges, 'a', 'c', heights)
    assert.equal(route.back, false, 'a skip inside one row takes the forward branch')
    assertWireClearsRow(route, cards, points, 'a', 'c')
  }
})
// #2151 fixed the same-row case; a forward edge that leaves its row for one below still took its
// corridor height from the source card alone. A row's cards are measured one by one, so a card
// beside the source can be taller: the horizontal run at `from.bottom + WIRE_GAP` then entered
// that card's body and, drawn behind it, read as a link to the neighbour. Both shapes are pinned
// here — one taller neighbour, and taller cards on both sides of the source.
test('a forward edge to the next row clears a taller card beside its source (#2160)', () => {
  for (const heights of [{ a: 48, b: 96, c: 72 }, { a: 48, b: 120, c: 72 }, { a: 72, b: 96, c: 72 }]) {
    const nodes = [
      { id: 'a', name: 'A', x: 0, y: 120 },
      { id: 'b', name: 'B', x: 200, y: 120 },
      { id: 'c', name: 'C', x: 800, y: 400 },
    ]
    const edges = [{ from: 'a', to: 'c' }]
    const { route, cards, points } = rowRoute(nodes, edges, 'a', 'c', heights)
    assert.equal(route.back, false, 'an edge to a lower row takes the forward branch')
    assertWireClearsRow(route, cards, points, 'a', 'c')
  }
})
test('a forward edge to the next row clears taller cards on both sides of its source (#2160)', () => {
  for (const heights of [{ a: 96, b: 48, c: 96, d: 72 }, { a: 120, b: 48, c: 96, d: 72 }, { a: 96, b: 72, c: 120, d: 72 }]) {
    const nodes = [
      { id: 'a', name: 'A', x: 0, y: 120 },
      { id: 'b', name: 'B', x: 200, y: 120 },
      { id: 'c', name: 'C', x: 400, y: 120 },
      { id: 'd', name: 'D', x: 800, y: 400 },
    ]
    const edges = [{ from: 'b', to: 'd' }]
    const { route, cards, points } = rowRoute(nodes, edges, 'b', 'd', heights)
    assert.equal(route.back, false, 'an edge to a lower row takes the forward branch')
    assertWireClearsRow(route, cards, points, 'b', 'd')
  }
})// #2164: the factory layout seats rows 108 apart and columns 188 apart, so a 48px card's own
// bottom leaves 60px to the next row while a card beside it can reach past that row's top. There
// is then no corridor under that row to run in, and the turn used to land inside the cards below.
// The clamp keeps it one pixel above that row's top instead — except on the one boundary where
// the row's lowest bottom sits exactly on that top, which keeps the turn the wire always had.
test('a forward edge into the next row keeps the factory row pitch clear (#2164)', () => {
  // 113 and up has no measurement: the tallest card measured is a 40-character CJK name at 112px
  // (see the CJK case below), so 120/140/160 are the upper-bound guard for this regression scan
  // rather than a shape either measurement saw.
  for (const heights of [{ a: 48, b: 120, c: 72, d: 72 }, { a: 48, b: 140, c: 72, d: 72 }, { a: 48, b: 160, c: 72, d: 72 }]) {
    const nodes = [
      { id: 'a', name: 'A', x: 0, y: 0 },
      { id: 'b', name: 'B', x: 188, y: 0 },
      { id: 'c', name: 'C', x: 0, y: 108 },
      { id: 'd', name: 'D', x: 188, y: 108 },
    ]
    const edges = [{ from: 'a', to: 'c' }, { from: 'a', to: 'd' }]
    // The two cards share a column, so the wire drops straight through the gap above the next
    // row instead of rounding a taller neighbour there is no room to get around.
    const straight = rowRoute(nodes, edges, 'a', 'c', heights)
    assert.equal(straight.route.back, false, 'an edge to a lower row takes the forward branch')
    assert.equal(straight.route.d, 'M 0 48 L 0 108', `a>c keeps the factory-pitch route (${straight.route.d})`)
    // The diagonal pair cannot reach the target's top port without crossing the tall card above
    // it, so matching the base crossing is the floor here; it must not also enter the next row.
    const diagonal = rowRoute(nodes, edges, 'a', 'd', heights)
    assert.equal(diagonal.route.back, false, 'an edge to a lower row takes the forward branch')
    const failures = crossingsOf(diagonal.points, diagonal.cards, 'a', 'd').map((hit) => hit.split(' ')[0])
    assert.deepEqual(failures.filter((id) => id !== 'b'), [],
      `a>d enters no card but the tall neighbour beside it (${diagonal.route.d})`)
    // The turn is clamped one pixel above the next row's top, and nothing is drawn below that
    // top: a run at it would lie along the next row's own top edge.
    const turn = diagonal.points.filter((point) => point[0] === 0).pop()[1]
    assert.ok(turn <= 107, `a>d turns above the next row (${diagonal.route.d})`)
    const below = diagonal.points.filter((point) => point[1] > 108)
    assert.deepEqual(below, [], `a>d never draws into the next row (${diagonal.route.d})`)
  }
  // The boundary: a neighbour whose bottom sits exactly on the next row's top leaves a corridor
  // of 0, and the turn stays on that edge — the route the wire had before the factory pitch was
  // broken, byte for byte. Pulling it one pixel up would draw it into the row below, which is the
  // one thing this clamp must not start doing (main's route at this height crosses no card; one
  // pixel higher would cross one).
  const edgeNodes = [
    { id: 'a', name: 'A', x: 0, y: 0 },
    { id: 'b', name: 'B', x: 188, y: 0 },
    { id: 'c', name: 'C', x: 0, y: 108 },
    { id: 'd', name: 'D', x: 188, y: 108 },
  ]
  const edge = rowRoute(edgeNodes, [{ from: 'a', to: 'd' }], 'a', 'd', { a: 48, b: 108, c: 72, d: 72 })
  assert.equal(edge.route.d, 'M 0 48 L 0 108 L 94 108 L 94 108 L 188 108 L 188 108',
    `a>d keeps the edge turn when the corridor closes (${edge.route.d})`)
  assert.deepEqual(crossingsOf(edge.points, edge.cards, 'a', 'd'), [], `a>d crosses nothing at room 0 (${edge.route.d})`)
})
// #2164: a card beside the source can stop short of the next row's top and still be taller than
// the source. With the shipped stylesheet that is every height from 47px (a short latin name) to
// 112px (a 40-character CJK name) — 30–38 latin characters measure 92px and 25–32 CJK characters
// measure 96px. Those leave a corridor under the row, and the run must turn inside it: at the
// source's own height it would head through the neighbour's body and out the other side.
test('a forward edge into the next row turns in the corridor under a taller neighbour (#2164)', () => {
  for (const b of [92, 96]) {
    const nodes = [
      { id: 'a', name: 'A', x: 0, y: 0 },
      { id: 'b', name: 'B', x: 188, y: 0 },
      { id: 'd', name: 'D', x: 188, y: 108 },
    ]
    const edges = [{ from: 'a', to: 'd' }]
    const { route, cards, points } = rowRoute(nodes, edges, 'a', 'd', { a: 48, b, d: 72 })
    assert.equal(route.back, false, 'an edge to a lower row takes the forward branch')
    assert.deepEqual(crossingsOf(points, cards, 'a', 'd'), [], `a>d clears the ${b}px neighbour (${route.d})`)
    // Every stretch that crosses the neighbour's column runs in the corridor under it: past that
    // card's bottom and still above the next row's top.
    const across = points.filter((point) => point[0] > 0 && point[0] < 188).map((point) => point[1])
    assert.ok(across.length > 0, `a>d crosses the neighbour's column (${route.d})`)
    assert.ok(Math.min(...across) > cards.get('b').bottom,
      `a>d runs under the ${b}px neighbour (${route.d})`)
    assert.ok(Math.max(...across) < cards.get('d').top,
      `a>d turns above the next row (${route.d})`)
    assert.equal(Math.min(...across), 108 - (108 - b) / 2, `a>d halves the corridor under it (${route.d})`)
  }
})
// #2164: the tallest card measured so far. A Bot name is cut at 40 characters
// (`core/src/host/roster.js:65`) and a CJK name wraps in a 112px-wide box at 8 characters a
// line; two independent readings of a 40-character Chinese name are Product 111 and Test 112,
// and this fixture takes the larger of the two. At 112 the whole 108px row pitch is used up and
// the row's lowest bottom sits past the next row's top, so the turn is clamped a pixel above it.
// The whole 108–112 band is treated as reachable: nothing in it may cross a card main does not.
const CJK_BOT_NAME = '自动发布巡检机器人负责在每次构建完成后核对全部流水线的运行状态并生成一份摘要报告'
test('a forward edge into the next row turns above the tallest CJK named card (#2164)', () => {
  assert.equal([...CJK_BOT_NAME].length, 40, 'the fixture name is the 40-character limit')
  const nodes = [
    { id: 'a', name: 'A', x: 0, y: 0 },
    { id: 'b', name: CJK_BOT_NAME, x: 188, y: 0 },
    { id: 'd', name: 'D', x: 188, y: 108 },
  ]
  const edges = [{ from: 'a', to: 'd' }]
  // 40 Chinese characters in the shipped stylesheet: measured 112px in headless chromium.
  const { route, cards, points } = rowRoute(nodes, edges, 'a', 'd', { a: 48, b: 112, d: 72 })
  assert.equal(route.back, false, 'an edge to a lower row takes the forward branch')
  // The neighbour reaches past the next row's top, so no route can clear it: one crossing is the
  // floor the base route already had, and the row below must stay untouched.
  const failures = crossingsOf(points, cards, 'a', 'd').map((hit) => hit.split(' ')[0])
  assert.deepEqual(failures, ['b'], `a>d is no worse than the base route (${route.d})`)
  const turn = points.filter((point) => point[0] === 0).pop()[1]
  assert.equal(turn, cards.get('d').top - 1, `a>d turns one pixel above the next row (${route.d})`)
  const below = points.filter((point) => point[1] > cards.get('d').top)
  assert.deepEqual(below, [], `a>d never draws into the next row (${route.d})`)
})

// #2176: a window that holds the team read-only still offered Edit on Settings → Workflows.
// The host's own sentence already arrives on the page as `roster.readOnly`; it must replace the
// control rather than show up after the fact, because `workflow/graph` is not in the channel's
// READS list (`core/src/host/channel.js:227`), so the host only refuses once the user has built
// the layout — and then the state is discarded with one technical line.
const READ_ONLY = 'another dsh holds the team, so this window is read-only'

// The host's standing sentence belongs to the Settings header, once per page: this edit bar
// used to draw a second copy of it where Edit would be, and a second live region is read out
// twice. The header keeps the sentence and its one Reload; the graph keeps Back.
test('#2176: a read-only graph draws no editing control and leaves the host sentence to the header', () => {
  const view = renderView({ phase: 'ready', pack, opened: { source: 'own', id: 'wf-mine' }, error: '', roster: { bots: [], readOnly: READ_ONLY } })
  const editingControl = all(view).filter((entry) => entry.type === 'button' && (text(entry) === 'Edit' || text(entry) === 'Finish editing'))
  assert.deepEqual(editingControl.map(text), [], 'a read-only window offers no editing control')
  assert.equal(all(view).some((entry) => text(entry) === READ_ONLY), false, 'the edit bar adds no second copy of the host sentence')
  assert.equal(all(view).some((entry) => entry.props?.role === 'status' && text(entry) === READ_ONLY), false, 'and no second live region carrying it')
  assert.equal(all(view).some((entry) => entry.props?.['data-port']), false, 'no port handles to drag')
  // The read side is untouched: the graph, its cards and the run chips still render.
  assert.ok(all(view).some((entry) => entry.props?.['data-node'] === 'coder'), 'the opened graph still renders')

  // Rename and Delete live on the list rows, so they are checked on the list the page shows
  // before a graph is opened — that is where the user would reach them.
  const list = renderView({ phase: 'ready', pack, opened: null, error: '', roster: { bots: [], readOnly: READ_ONLY } })
  assert.equal(all(list).some((entry) => entry.type === 'button' && (entry.props?.['aria-label'] === 'Rename' || entry.props?.['aria-label'] === 'Delete')), false,
    'rename and delete are not offered in a read-only window')
  assert.ok(all(list).some((entry) => entry.props?.['data-workflow'] === 'wf-mine'), 'the list still renders')
})

test('#2176: a read-only window never asks the host to save a graph the user drags', async () => {
  const calls = []
  const page = mountPage({ call: async (method) => { calls.push(method); return pack }, roster: { bots: [], readOnly: READ_ONLY } })
  await page.settle()
  await openWorkflow(page, 'wf-mine')
  // A user who is offered an editing control takes it; read-only must not offer one. On a page
  // that does, this drives the very flow that ends in the host's refusal.
  const edit = all(page.tree).find((entry) => entry.type === 'button' && (text(entry) === 'Edit' || text(entry) === 'Finish editing'))
  if (edit) {
    edit.props.onClick({ stopPropagation() {}, preventDefault() {}, target: {} })
    await page.settle()
  }
  const card = all(page.tree).find((entry) => entry.props?.['data-node'] === 'coder')
  assert.ok(card, 'the card the user would drag is on the canvas')
  card.props.onPointerDown({ clientX: 10, clientY: 20, target: { dataset: {} } })
  const canvas = all(page.tree).find((entry) => entry.props?.className === 'bt-wf-canvas')
  canvas.props.onPointerUp({ clientX: 30, clientY: 50, target: { dataset: {} } })
  await page.settle()
  assert.deepEqual(calls.filter((method) => method === 'workflow/graph'), [], 'a read-only window never writes the graph')
  assert.ok(calls.includes('workflow/state'), 'the page still reads')
})

test('#2176: a window that is not read-only keeps Edit, rename and delete', () => {
  const view = renderView({ phase: 'ready', pack, opened: { source: 'own', id: 'wf-mine' }, error: '', roster: { bots: [] } })
  assert.equal(all(view).some((entry) => entry.type === 'button' && text(entry) === 'Edit'), true, 'a normal window still offers Edit')
  assert.equal(all(view).some((entry) => text(entry) === READ_ONLY), false, 'no read-only sentence in a normal window')
  const list = renderView({ phase: 'ready', pack, opened: null, error: '', roster: { bots: [] } })
  assert.equal(all(list).some((entry) => entry.type === 'button' && entry.props?.['aria-label'] === 'Rename'), true, 'rename is still offered')
  assert.equal(all(list).some((entry) => entry.type === 'button' && entry.props?.['aria-label'] === 'Delete'), true, 'delete is still offered')
})

// #2176: `Use this` writes `workflow/create`, and the channel's READS list does not hold that
// method either (`core/src/host/channel.js:227`), so a read-only window that keeps the button
// offers the user a copy the host refuses. The button goes away with Edit; the read side stays.
test('#2176: a read-only window offers no Use this on a preset and never creates a copy', async () => {
  const calls = []
  const page = mountPage({ call: async (method) => { calls.push(method); return pack }, roster: { bots: [], readOnly: READ_ONLY } })
  await page.settle()
  await openWorkflow(page, 'delivery')
  assert.equal(all(page.tree).some((entry) => entry.type === 'button' && text(entry) === 'Use this'), false,
    'a read-only window offers no Use this')
  assert.deepEqual(calls.filter((method) => method === 'workflow/create'), [], 'a read-only window never asks the host to copy a preset')
  assert.ok(calls.includes('workflow/state'), 'the page still reads')
  assert.ok(all(page.tree).some((entry) => entry.props?.['data-node'] === 'coder'), 'the opened graph still renders')
})

test('#2176: a window that is not read-only keeps Use this and copies the preset once', async () => {
  const calls = []
  const copied = { ...pack, workflows: [...pack.workflows, { ...factory, id: 'delivery-copy', name: 'Copy of delivery' }] }
  const page = mountPage({
    call: async (method) => { calls.push(method); return method === 'workflow/create' ? copied : pack },
    roster: { bots: [] },
  })
  await page.settle()
  await openWorkflow(page, 'delivery')
  assert.equal(all(page.tree).some((entry) => entry.type === 'button' && text(entry) === 'Use this'), true, 'a normal window still offers Use this')
  await page.click((entry) => text(entry) === 'Use this')
  assert.deepEqual(calls.filter((method) => method === 'workflow/create'), ['workflow/create'], 'a normal window copies the preset once')
  assert.match(text(page.tree), /Copy of delivery/, 'the copy opens')
})

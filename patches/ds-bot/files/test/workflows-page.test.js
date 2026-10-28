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
    contents: "export { WorkflowsPage, WorkflowsView, readWorkflows, settleWorkflowRead, moveNode, connectNodes, dropBot, removeNode } from './src/client/workflows.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
let states = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useCallback: (fn) => fn(),
  useRef: (current) => ({ current }), useSyncExternalStore: (_s, get) => get(), useState: (value) => [states.length > 0 ? states.shift() : value, () => {}],
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { WorkflowsPage, WorkflowsView, readWorkflows, settleWorkflowRead, moveNode, connectNodes, dropBot, removeNode, installLocale } = module.exports

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

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach((child) => all(child, out))
    else { out.push(node); all(node.props?.children, out) }
  }
  return out
}
const text = (node) => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
const renderPage = (props, given = []) => { states = [...given]; const tree = expand(h(WorkflowsPage, props)); states = []; return tree }
const renderView = (props) => expand(h(WorkflowsView, props))

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

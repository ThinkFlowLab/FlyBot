// The workflow chat (client.js) through a small hook renderer: the sidebar row,
// the flowchart editor, and the rule that a hostile name stays text.
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
    const changed = !prev || !deps || deps.length !== prev.deps?.length || deps.some((dep, k) => !Object.is(dep, prev.deps[k]))
    if (!prev) inst.hooks[i] = { deps }
    if (changed) { inst.hooks[i].deps = deps; inst.root.pending.push({ slot: inst.hooks[i], fn }) }
  },
  useRef(init) {
    const { inst } = live
    const i = live.idx++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init }
    return inst.hooks[i]
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
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const htmlOf = (node) => {
  if (Array.isArray(node)) return node.map(htmlOf).join('')
  if (typeof node === 'string') return esc(node)
  const attrs = Object.entries(node.props ?? {}).filter(([k, v]) => v !== undefined && v !== false && typeof v !== 'function' && k !== 'key' && k !== 'ref').map(([k, v]) => ` ${k}="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}"`).join('')
  return `<${node.type}${attrs}>${(node.children ?? []).map(htmlOf).join('')}</${node.type}>`
}
const button = (tree, label) => findAll(tree, node => node.type === 'button' && textOf(node) === label)[0]

const documentStub = {
  listeners: [],
  getElementById() { return null },
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild() {} },
  querySelector() { return null },
  addEventListener(name, fn, capture) { this.listeners.push({ name, fn, capture }) },
  removeEventListener(name, fn) { this.listeners = this.listeners.filter(item => item.fn !== fn) },
}
globalThis.document = documentStub

function loadClient(reactDom) {
  const modules = new Map()
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => modules.set(id, factory(name => {
        if (name === 'react') return react
        if (name === 'react-dom') {
          if (reactDom) return reactDom
          throw new Error('no react-dom in the unit renderer')
        }
        return {}
      })),
    },
  }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/workflow')
}

const client = loadClient()
const HOSTILE = '<img src=x onerror=alert(1)>'
const SCRIPT = '<script>alert(1)</script>'

function delivery() {
  return {
    id: 'delivery',
    name: '发布交付流水线',
    description: 'Ship a notice',
    chain: 'Planner → Writer → Coder → Reviewer ‖ Tester → Deployer',
    preview: '等待任务',
    activeCount: 0,
    trigger: 'manual',
    layers: [['planner'], ['writer'], ['coder'], ['reviewer', 'tester'], ['deployer']],
    nodes: [
      { id: 'planner', name: 'Planner', role: '计划', x: 200, y: 24 },
      { id: 'writer', name: 'Writer', role: '撰写', x: 200, y: 140 },
      { id: 'coder', name: 'Coder', role: HOSTILE, x: 200, y: 260 },
      { id: 'reviewer', name: 'Reviewer', role: '审阅', x: 80, y: 380 },
      { id: 'tester', name: 'Tester', role: '测试', x: 320, y: 380 },
      { id: 'deployer', name: 'Deployer', role: '发布', x: 200, y: 520 },
    ],
    edges: [
      { from: 'planner', to: 'writer' },
      { from: 'writer', to: 'coder' },
      { from: 'coder', to: 'reviewer' },
      { from: 'coder', to: 'tester' },
      { from: 'reviewer', to: 'deployer' },
      { from: 'tester', to: 'deployer' },
    ],
    messages: [{ id: 'm1', kind: 'user', text: SCRIPT }],
    run: {
      live: true,
      status: 'running',
      task: { id: '#1280', title: '缩短交付组群 notice' },
      taskSummary: '#1280 · 缩短交付组群 notice',
      nodeStatus: { planner: 'done', writer: 'done', coder: 'running', reviewer: 'queued', tester: 'queued', deployer: 'queued' },
      running: ['coder'],
      doneCount: 2,
      nodeCount: 6,
      marks: ['done', 'done', 'running', 'queued', 'queued'],
      steps: 3,
      stepBudget: 10,
    },
  }
}

async function settle() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
}

test('the sidebar opens the flowchart, and a drag, a wire and a dropped Bot are saved', async () => {
  const calls = []
  const graph = delivery()
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    if (name === 'workflow/create') return { ok: true, workflows: [graph, { ...graph, id: 'delivery-copy', name: '发布交付流水线 副本' }] }
    return { ok: true, workflows: [graph] }
  }
  const roster = { bots: [{ id: 'bot-docs', name: 'Docs', role: 'notes', remote: false }, { id: 'bot-friend', name: 'Remote', remote: true }] }
  const view = mount(client.Section, { roster, call, actions: {} })
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/state'))
  assert.ok(textOf(view.tree).includes('发布交付流水线'))
  assert.ok(textOf(view.tree).includes('Waiting for a task'))

  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Flow')[0].props.onClick()
  const opened = textOf(view.tree)
  assert.ok(opened.includes('并行分支 · 全部通过后汇合'))
  assert.ok(opened.includes('Reviewer'))
  assert.ok(opened.includes('Tester'))
  const html = htmlOf(view.tree)
  assert.equal(html.includes('<script'), false)
  assert.equal(html.includes('<img'), false)
  assert.ok(textOf(view.tree).includes(SCRIPT))
  assert.ok(textOf(view.tree).includes(HOSTILE))

  button(view.tree, 'Edit').props.onClick()
  const coder = findAll(view.tree, node => node.props?.['data-node'] === 'coder')[0]
  coder.props.onPointerDown({ clientX: 10, clientY: 20, target: { dataset: {} } })
  let canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
  canvas.props.onPointerMove({ clientX: 58, clientY: 44 })
  canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
  canvas.props.onPointerUp({ clientX: 58, clientY: 44, target: { dataset: {} } })
  const moved = calls.find(item => item.name === 'workflow/graph')
  assert.equal(moved.body.nodes.find(node => node.id === 'coder').x, 248)
  assert.equal(moved.body.nodes.find(node => node.id === 'coder').y, 284)

  const port = findAll(view.tree, node => node.props?.['data-port'] === 'out' && node.props['aria-label'] === 'Writer')[0]
  port.props.onPointerDown({ preventDefault() {}, stopPropagation() {}, target: { dataset: { port: 'out' } } })
  canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
  canvas.props.onPointerUp({ target: { dataset: { node: 'tester' }, closest() { return null } } })
  const wired = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.ok(wired.body.edges.some(edge => edge.from === 'writer' && edge.to === 'tester'))

  const docs = findAll(view.tree, node => node.props?.['data-bot'] === 'bot-docs')[0]
  assert.ok(docs)
  assert.equal(findAll(view.tree, node => node.props?.['data-bot'] === 'bot-friend').length, 0)
  docs.props.onPointerDown({ preventDefault() {}, target: { dataset: { bot: 'bot-docs' } } })
  canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
  canvas.props.onPointerUp({ target: { dataset: { plane: '1' } }, offsetX: 30, offsetY: 40 })
  const added = calls.filter(item => item.name === 'workflow/graph').at(-1)
  const seat = added.body.nodes.find(node => node.botId === 'bot-docs')
  assert.equal(seat.name, 'Docs')
  assert.equal(seat.x, 30)
  assert.equal(seat.y, 40)

  button(view.tree, 'New').props.onClick()
  const template = findAll(view.tree, node => node.type === 'button' && node.props.className === 'wf-btn' && textOf(node) === '发布交付流水线')[0]
  template.props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/create' && item.body.template === 'delivery'))
  view.unmount()
})

test('clicking a sidebar workflow, New, or Hand-a-task keeps the section and opens the stage', async () => {
  // The shell's createPortal throws when the container is missing — the same
  // throw the sidebar slot boundary turns into an empty Workflows section (#1375).
  const portals = []
  const reactDom = {
    createPortal(node, container) {
      if (!container || container.nodeType !== 1) throw new Error('Target container is not a DOM element.')
      portals.push(container)
      return { type: 'portal', props: { container }, children: [node] }
    },
  }
  const opened = loadClient(reactDom)
  const body = { nodeType: 1 }
  const prevBody = document.body
  document.body = body
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  try {
    const view = mount(opened.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    const row = findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0]
    assert.doesNotThrow(() => row.props.onClick())
    assert.ok(textOf(view.tree).includes('Workflows'))
    assert.ok(textOf(view.tree).includes('发布交付流水线'))
    assert.ok(findAll(view.tree, node => node.props?.className === 'wf-stage').length > 0)
    assert.ok(portals.length > 0)
    assert.ok(portals.every(container => container === body))

    const beforeNew = portals.length
    button(view.tree, 'New').props.onClick()
    assert.ok(textOf(view.tree).includes('Workflows'))
    assert.ok(findAll(view.tree, node => node.props?.className === 'wf-modal').length > 0)
    assert.ok(portals.length > beforeNew)

    const beforeAssign = portals.length
    findAll(view.tree, node => node.type === 'button' && node.props.className === 'wf-row wf-assign-row')[0].props.onClick()
    assert.ok(textOf(view.tree).includes('Workflows'))
    assert.ok(textOf(view.tree).includes('Hand a task to a Workflow'))
    assert.ok(portals.length > beforeAssign)
    assert.ok(portals.every(container => container === body))
    view.unmount()
  } finally {
    document.body = prevBody
  }
})

test('settings and the flowchart save a node prompt and a link on the same graph', async () => {
  const calls = []
  const graph = delivery()
  graph.nodes = graph.nodes.map(node => node.id === 'coder' ? { ...node, prompt: 'Implement it.' } : node)
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph] }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  // Click Edit to enable inspector and edge form
  button(settings.tree, 'Edit').props.onClick()
  await settle()
  // Click the coder node to select it and open inspector
  const coderNode = findAll(settings.tree, node => node.props?.['data-node'] === 'coder')[0]
  assert.ok(coderNode, 'coder node should exist in canvas')
  coderNode.props.onClick()
  await settle()
  // Find the textarea in the inspector
  const inspectorAreas = findAll(settings.tree, node => node.type === 'textarea')
  const box = inspectorAreas.find(area => area.props?.value === 'Implement it.')
  assert.ok(box, 'inspector textarea with coder prompt should exist')
  assert.equal(box.props.value, 'Implement it.')
  const hostile = 'Keep the diff small.\n<script>alert(1)</script>'
  box.props.onChange({ target: { value: hostile } })
  await settle()
  const saved = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.equal(saved.body.workflowId, 'delivery')
  assert.equal(saved.body.nodes.find(node => node.id === 'coder').prompt, hostile)
  assert.equal(htmlOf(settings.tree).includes('<script'), false)
  findAll(settings.tree, node => node.props?.['aria-label'] === 'From node')[0].props.onChange({ target: { value: 'coder' } })
  findAll(settings.tree, node => node.props?.['aria-label'] === 'To node')[0].props.onChange({ target: { value: 'planner' } })
  button(settings.tree, 'Add link').props.onClick()
  const linked = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.ok(linked.body.edges.some(edge => edge.from === 'coder' && edge.to === 'planner'))
  settings.unmount()

  const flowCalls = []
  const flow = mount(client.Section, {
    roster: { bots: [] },
    call: async (name, body) => {
      flowCalls.push({ name, body })
      if (name === 'workflow/state') return { workflows: [graph] }
      return { ok: true, workflows: [graph] }
    },
    actions: {},
  })
  await settle()
  findAll(flow.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  button(flow.tree, 'Flow').props.onClick()
  button(flow.tree, 'Edit').props.onClick()
  await settle()
  // Click the coder node in the flowchart drawer to select it
  const flowCoderNode = findAll(flow.tree, node => node.props?.['data-node'] === 'coder')[0]
  assert.ok(flowCoderNode, 'coder node should exist in flow canvas')
  flowCoderNode.props.onClick()
  await settle()
  // Find the textarea in the per-node inspector
  const flowInspectorAreas = findAll(flow.tree, node => node.type === 'textarea')
  const area = flowInspectorAreas.find(a => (a.props?.value || a.props?.defaultValue) === 'Implement it.')
  assert.ok(area, 'inspector textarea with coder prompt should exist')
  area.props.onChange({ target: { value: 'Keep the diff small.' } })
  await settle()
  const edited = flowCalls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.equal(edited.body.nodes.find(node => node.id === 'coder').prompt, 'Keep the diff small.')
  assert.equal(htmlOf(flow.tree).includes('<script'), false)
  flow.unmount()
})

test('apply registers the sidebar section and the settings page', () => {
  const entries = []
  const off = client.apply({
    flybot: {
      call() {},
      slots: { register: (slot, entry) => { entries.push(`${slot}#${entry.id}`); return () => {} } },
    },
    effect(fn) { fn() },
  })
  assert.deepEqual(entries, ['flybot.sidebar.section#workflow', 'flybot.settings.page#workflow'])
  off()
})

test('settings can add a loop edge and a condition edge', async () => {
  const calls = []
  const graph = delivery()
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph] }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  // Click Edit to enable edge form controls
  button(settings.tree, 'Edit').props.onClick()
  await settle()
  const pick = (label) => findAll(settings.tree, node => node.props?.['aria-label'] === label)[0]
  pick('Kind').props.onChange({ target: { value: 'loop' } })
  pick('From node').props.onChange({ target: { value: 'coder' } })
  pick('To node').props.onChange({ target: { value: 'coder' } })
  pick('Max iterations').props.onChange({ target: { value: '3' } })
  pick('until').props.onChange({ target: { value: 'stop' } })
  pick('Equals').props.onChange({ target: { value: 'yes' } })
  button(settings.tree, 'Add link').props.onClick()
  const looped = calls.filter(item => item.name === 'workflow/graph').at(-1)
  const loop = looped.body.edges.find(edge => edge.from === 'coder' && edge.to === 'coder')
  assert.equal(loop.loop, true)
  assert.equal(loop.max, 3)
  assert.deepEqual(loop.until, { output: 'stop', eq: 'yes' })
  settings.unmount()
})

test('sidebar preview ignores a stale busy preview when nothing is live', async () => {
  const graph = delivery()
  graph.preview = 'Coder 正在处理 #1280…'
  graph.activeCount = 0
  graph.run = null
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  assert.ok(textOf(view.tree).includes('Waiting for a task'))
  assert.equal(textOf(view.tree).includes('Coder 正在处理'), false)
  view.unmount()
})

test('two concurrent live runs each show independent progress strips', () => {
  const workflow = {
    runs: [
      {
        id: 'run-a', live: true, status: 'running',
        task: { id: '#1422', title: 'PR 1422' },
        running: ['planner'], doneCount: 1, nodeCount: 6,
        marks: ['done', 'running', 'queued', 'queued', 'queued'],
      },
      {
        id: 'run-b', live: true, status: 'running',
        task: { id: '#1395', title: 'PR 1395' },
        running: ['coder'], doneCount: 3, nodeCount: 6,
        marks: ['done', 'done', 'done', 'running', 'queued'],
      },
    ],
    run: { id: 'run-a', live: true, status: 'running' },
  }
  assert.equal(client.resolveFocusedRun(workflow, 'run-b').doneCount, 3)
  assert.equal(client.resolveFocusedRun(workflow, null).id, 'run-a')
})

test('two concurrent live runs each get their own pause and stop controls', async () => {
  const graph = delivery()
  graph.activeCount = 2
  graph.queueDepth = 0
  graph.runs = [
    { ...graph.run, id: 'run-a', task: { id: '#1422', title: 'PR 1422' }, taskSummary: '#1422 · PR 1422', doneCount: 1, marks: ['done', 'running', 'queued', 'queued', 'queued'] },
    { ...graph.run, id: 'run-b', task: { id: '#1395', title: 'PR 1395' }, taskSummary: '#1395 · PR 1395', doneCount: 4, marks: ['done', 'done', 'done', 'done', 'running'] },
  ]
  graph.run = graph.runs[0]
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  const strips = findAll(view.tree, node => node.props?.className?.includes('wf-strip') && node.props?.['data-run-id'])
  assert.equal(strips.length, 2)
  const progressRows = findAll(view.tree, node => node.props?.className === 'wf-strip-progress')
  assert.equal(progressRows.length, 2)
  const text = textOf(view.tree)
  assert.ok(text.includes('1/6'))
  assert.ok(text.includes('4/6'))
  const pauseButtons = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Pause')
  assert.equal(pauseButtons.length, 2)
  const stopButtons = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Stop')
  assert.equal(stopButtons.length, 2)
  pauseButtons[1].props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/pause' && item.body.runId === 'run-b'))
  stopButtons[0].props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/reset' && item.body.runId === 'run-a'))
  view.unmount()
})

test('a live run shows pause, resume, and progress controls', async () => {
  const graph = delivery()
  graph.activeCount = 1
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  const labels = findAll(view.tree, node => node.type === 'button').map(node => textOf(node))
  assert.ok(labels.includes('Pause'))
  assert.ok(labels.includes('Progress'))
  button(view.tree, 'Pause').props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/pause' && item.body.workflowId === 'delivery'))
  view.unmount()
})

test('the stage has no canned demo controls', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  button(view.tree, 'Flow').props.onClick()
  const labels = findAll(view.tree, node => node.type === 'button').map(node => textOf(node))
  assert.equal(labels.some(text => text.includes('Replay demo') || text.includes('Run demo') || text.includes('重放演示') || text.includes('演示运行')), false)
  assert.equal(labels.some(text => text === 'Next ›' || text === '下一步 ›'), false)
  view.unmount()
})

test('stage chat hides workflow node Bot lines but keeps owner Bots and system lines', () => {
  const workflow = {
    nodes: [{ id: 'coder', name: 'Coder' }, { id: 'writer', name: 'Writer' }],
    messages: [
      { id: '1', kind: 'system', text: '任务已进入 Workflow' },
      { id: '2', kind: 'bot', botId: 'coder', text: 'node step output' },
      { id: '3', kind: 'user', text: 'owner note' },
      { id: '4', kind: 'bot', botId: 'bot-chief', text: 'Chief reply' },
    ],
  }
  const roster = { byId: { 'bot-chief': { id: 'bot-chief', name: 'Chief' } } }
  const visible = client.stageMessages(workflow, workflow.messages, roster)
  assert.deepEqual(visible.map(message => message.id), ['1', '3', '4'])
})

test('the hand-a-task modal lists live Tasks board rows only', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const prevHost = globalThis.__flybot__
  globalThis.__flybot__ = {
    host: async (channel) => {
      if (channel === 'tasks') {
        return [{ id: 'task-live-99', title: 'Real board card', status: 'open', priority: 'P2' }]
      }
      return []
    },
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.props?.className === 'wf-row wf-assign-row')[0].props.onClick()
  await settle()
  const text = textOf(view.tree)
  assert.ok(text.includes('Real board card'))
  assert.equal(text.includes('发布说明：Workflow Beta 上线'), false)
  assert.equal(text.includes('修复群聊 @ 提及跳转错位'), false)
  globalThis.__flybot__ = prevHost
  view.unmount()
})

test('the flowchart canvas CSS clips overflow inside its panel', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.wf-canvas\{[^}]*overflow:auto/)
  assert.match(source, /\.wf-canvas-view\{[^}]*overflow:auto/)
  assert.match(source, /\.wf-stage\{[^}]*overflow:hidden/)
})

test('delivery workflow rows are deletable even when template ids match', async () => {
  const graph = delivery()
  const calls = []
  let workflows = [graph]
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') {
      return {
        workflows,
        templates: [{ id: 'delivery', name: '发布交付流水线' }, { id: 'weekly', name: '周报汇总流程' }],
      }
    }
    if (name === 'workflow/delete' && body.workflowId === 'delivery') {
      workflows = []
      return { workflows }
    }
    return { ok: true, workflows }
  }
  const prevBody = document.body
  document.body = { nodeType: 1 }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    const row = findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0]
    assert.ok(row)
    row.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 40, clientY: 40 })
    await settle()
    const deleteBtn = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Delete')[0]
    assert.ok(deleteBtn, 'context menu Delete')
    deleteBtn.props.onClick()
    await settle()
    const confirm = findAll(view.tree, node => node.type === 'button' && node.props.className === 'wf-btn wf-danger')[0]
    assert.ok(confirm, 'delete confirm')
    confirm.props.onClick()
    await settle()
    assert.ok(calls.some(item => item.name === 'workflow/delete' && item.body.workflowId === 'delivery'))
    assert.equal(textOf(view.tree).includes('发布交付流水线'), false)
    view.unmount()
  } finally {
    document.body = prevBody
  }
})

test('a sidebar workflow row can be deleted from the context menu', async () => {
  const graph = { ...delivery(), id: 'lane-a', name: 'Lane A' }
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: 'Factory' }] }
    if (name === 'workflow/delete') return { ok: true, workflows: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  const row = findAll(view.tree, node => node.type === 'button' && textOf(node).includes('Lane A'))[0]
  row.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 40, clientY: 40 })
  await settle()
  const deleteBtn = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Delete')[0]
  assert.ok(deleteBtn)
  deleteBtn.props.onClick()
  await settle()
  const confirm = findAll(view.tree, node => node.type === 'button' && node.props.className === 'wf-btn wf-danger')[0]
  confirm.props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/delete' && item.body.workflowId === 'lane-a'))
  view.unmount()
})

test('run history lists every live run that activeCount includes', () => {
  const workflow = {
    activeCount: 2,
    history: [],
    queue: [],
    runs: [
      { id: 'run-a', live: true, status: 'running', task: { id: '#1422', title: 'PR 1422' } },
      { id: 'run-b', live: true, status: 'running', task: { id: '#1395', title: 'PR 1395' } },
    ],
    run: { id: 'run-a', live: true, status: 'running', task: { id: '#1422', title: 'PR 1422' } },
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.filter(row => row.status === 'running').length, 2)
  assert.equal(rows.length, 2)
})

test('run history does not invent a second running row when only one live run exists', () => {
  const workflow = {
    activeCount: 1,
    history: [{ task: { id: '#1', title: 'Old' }, status: 'done' }],
    queue: [],
    runs: [{ id: 'run-a', live: true, status: 'running', task: { id: '#1422', title: 'PR 1422' } }],
    run: { id: 'run-a', live: true, status: 'running', task: { id: '#1422', title: 'PR 1422' } },
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.filter(row => row.status === 'running').length, 1)
})

test('the runs tab shows one running row per concurrent live run', async () => {
  const graph = delivery()
  graph.activeCount = 2
  graph.queueDepth = 0
  graph.runs = [
    { id: 'run-a', live: true, status: 'running', task: { id: '#1422', title: 'PR 1422' }, taskSummary: '#1422 · PR 1422' },
    { id: 'run-b', live: true, status: 'running', task: { id: '#1395', title: 'PR 1395' }, taskSummary: '#1395 · PR 1395' },
  ]
  graph.run = graph.runs[0]
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  button(view.tree, 'Progress').props.onClick()
  await settle()
  const running = findAll(view.tree, node => node.props?.className === 'wf-chip running')
  assert.equal(running.length, 2)
  const text = textOf(view.tree)
  assert.ok(text.includes('PR 1422'))
  assert.ok(text.includes('PR 1395'))
  view.unmount()
})

test('wire paths for a linear three-node graph connect each step vertically', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 108 },
    { id: 'c', x: 0, y: 216 },
  ]
  const span = client.WIRE_SPAN
  const out = client.NODE_WIRE_OUT
  const ab = client.wirePath(nodes[0], nodes[1])
  const bc = client.wirePath(nodes[1], nodes[2])
  assert.match(ab, new RegExp(`^M ${span} ${out} C ${span} ${(out + 108) / 2}, ${span} ${(out + 108) / 2}, ${span} 108$`))
  const y1b = 108 + out
  assert.match(bc, new RegExp(`^M ${span} ${y1b} C ${span} ${(y1b + 216) / 2}, ${span} ${(y1b + 216) / 2}, ${span} 216$`))
})

test('wire paths between parallel nodes use orthogonal segments, not wide curves', () => {
  const from = { x: 80, y: 260 }
  const to = { x: 320, y: 380 }
  const path = client.wirePath(from, to)
  assert.match(path, /^M .+ L .+ L .+ L /)
  assert.equal(path.includes('C '), false)
})

test('parallel branch frames wrap node bounds without hard-coded width', () => {
  const members = [
    { id: 'a', x: 80, y: 380 },
    { id: 'b', x: 320, y: 380 },
  ]
  const frame = client.parallelFrameStyle(members)
  assert.equal(frame.width, 320 - 80 + client.NODE_W + 20)
  assert.equal(frame.left, 80 - client.NODE_W / 2 - 10)
})

test('the workflow stage mounts no message composer', async () => {
  const graph = delivery()
  const prevFlybot = globalThis.__flybot__
  globalThis.__flybot__ = {
    ...prevFlybot,
    Conversation: () => null,
    ConversationHeader: () => null,
  }
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  assert.equal(findAll(view.tree, node => node.props?.className === 'wf-composer').length, 0)
  assert.equal(findAll(view.tree, node => node.props?.className === 'wf-composer-wrap').length, 0)
  assert.equal(findAll(view.tree, node => node.type === 'input').length, 0)
  globalThis.__flybot__ = prevFlybot
  view.unmount()
})

test('palette chips distinguish duplicate Bot names and expose drag affordance', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const roster = {
    bots: [
      { id: 'chief-a', name: 'Chief', role: 'Triage', remote: false },
      { id: 'chief-b', name: 'Chief', role: 'Verify', remote: false },
      { id: 'chief-c', name: 'Chief', role: '', remote: false },
    ],
  }
  const view = mount(client.Section, { roster, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  button(view.tree, 'Flow').props.onClick()
  button(view.tree, 'Edit').props.onClick()
  await settle()
  assert.ok(findAll(view.tree, node => node.props?.className?.includes('wf-palette-bot')).length >= 3)
  assert.equal(client.botPaletteSubtitle({ id: 'chief-a', name: 'Chief', role: 'Triage' }, roster.bots), 'Triage')
  assert.ok(client.botPaletteSubtitle({ id: 'chief-c', name: 'Chief', role: '' }, roster.bots).includes('hief-c'))
  view.unmount()
})

test('running flow nodes use a breathing border animation only while running', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /@keyframes wf-node-live/)
  assert.match(source, /\.wf-node\.running\{[^}]*animation:wf-node-live/)
  assert.match(source, /\.wf-palette-bot\{/)
  assert.match(source, /\.wf-drag-ghost\{/)
  assert.match(source, /\.wf-node\.done\{/)
  assert.doesNotMatch(source, /\.wf-node\.done\{[^}]*animation/)
  assert.doesNotMatch(source, /\.wf-node\.queued\{[^}]*animation/)
})

test('Chinese labels follow the host Tasks translation', () => {
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = { t: key => (key === 'Tasks' ? '任务' : key) }
  try {
    assert.equal(client.tr('Edit'), '编辑')
    assert.equal(client.tr('Hand a task to a Workflow'), '把任务交给 Workflow')
    assert.equal(client.columnOf({ status: 'working' }), 'in-progress')
    assert.equal(client.shortId('task-abcdef123456'), '#123456')
  } finally {
    globalThis.__flybot__ = prev
  }
})

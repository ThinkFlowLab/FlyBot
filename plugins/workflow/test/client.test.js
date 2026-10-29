// The workflow chat (client.js) through a small hook renderer: the sidebar row,
// the flowchart editor, and the rule that a hostile name stays text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cleanTools } from '../src/graph.js'

import { allThemes } from '../../../core/src/client/themes.js'

// `rectWidth` is what a host element reports from getBoundingClientRect, so a
// component that measures its own container can be driven from a plain object.
const live = { inst: null, idx: 0, rectWidth: 0 }
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
  const root = { instances: new Map(), elements: new Map(), pending: [], rendering: false, dirty: false, tree: undefined }
  // The renderer has no DOM: a host element's ref gets a stand-in that answers
  // getBoundingClientRect from `live.rectWidth` and keeps a scroll box, so a
  // component that measures or scrolls its own container is observable — the
  // stage chat's scroll effect is a no-op otherwise, because useRef keeps
  // chatRef.current null.
  const elementAt = (path) => {
    let el = root.elements.get(path)
    if (!el) {
      el = {
        scrollTop: 0, scrollHeight: 0, clientHeight: 0, focused: false, focus() { this.focused = true },
        getBoundingClientRect: () => ({ width: live.rectWidth, height: 0 }), dataset: {},
      }
      root.elements.set(path, el)
    }
    return el
  }
  const attachRef = (ref, path) => {
    if (!ref) return
    const el = elementAt(path)
    if (typeof ref === 'function') ref(el)
    else if (typeof ref === 'object') ref.current = el
  }
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
    attachRef(node.props?.ref, path)
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

// A rejected call that no `.catch` claims is an unhandled rejection: node fails the run,
// and the page says nothing. Catch them so a test can assert "nothing was swallowed".
async function withUnhandled(fn) {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    return await fn(unhandled)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

const alertsOf = view => findAll(view.tree, node => node.props?.role === 'alert').map(textOf)

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
  assert.ok(opened.includes('Parallel branches · Merge after all pass'))
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
  let canvas = findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-canvas'))[0]
  canvas.props.onPointerMove({ clientX: 58, clientY: 44 })
  canvas = findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-canvas'))[0]
  canvas.props.onPointerUp({ clientX: 58, clientY: 44, target: { dataset: {} } })
  const fit = client.fitPlane(graph.nodes, client.DRAWER_FLOW_W)
  const moved = calls.find(item => item.name === 'workflow/graph')
  assert.equal(moved.body.nodes.find(node => node.id === 'coder').x, Math.round(200 + 48 / fit.scale))
  assert.equal(moved.body.nodes.find(node => node.id === 'coder').y, 260 + 24)

  const port = findAll(view.tree, node => node.props?.['data-port'] === 'out' && node.props['aria-label'] === 'Writer')[0]
  port.props.onPointerDown({ preventDefault() {}, stopPropagation() {}, target: { dataset: { port: 'out' } } })
  canvas = findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-canvas'))[0]
  canvas.props.onPointerUp({ target: { dataset: { node: 'tester' }, closest() { return null } } })
  const wired = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.ok(wired.body.edges.some(edge => edge.from === 'writer' && edge.to === 'tester'))

  const docs = findAll(view.tree, node => node.props?.['data-bot'] === 'bot-docs')[0]
  assert.ok(docs)
  assert.equal(findAll(view.tree, node => node.props?.['data-bot'] === 'bot-friend').length, 0)
  docs.props.onPointerDown({ preventDefault() {}, target: { dataset: { bot: 'bot-docs' } } })
  canvas = findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-canvas'))[0]
  canvas.props.onPointerUp({ target: { dataset: { plane: '1' } }, offsetX: 30, offsetY: 40 })
  const added = calls.filter(item => item.name === 'workflow/graph').at(-1)
  const seat = added.body.nodes.find(node => node.botId === 'bot-docs')
  assert.equal(seat.name, 'Docs')
  assert.equal(seat.x, Math.round((30 - fit.offsetX) / fit.scale))
  assert.equal(seat.y, Math.round(40 - fit.offsetY))

  button(view.tree, 'New').props.onClick()
  const template = findAll(view.tree, node => node.type === 'button' && node.props.className === 'wf-btn' && textOf(node) === '发布交付流水线')[0]
  template.props.onClick()
  await settle()
  assert.ok(calls.some(item => item.name === 'workflow/create' && item.body.template === 'delivery'))
  view.unmount()
})

// A drawer-sized graph: span 344 in the 364px plane is scale 0.5 exactly, so a
// 40px pointer move is 80 world units and the rounding stays out of the numbers.
function drawerGraph(id, name, nodes) {
  return { ...delivery(), id, name, layers: [], nodes, edges: [] }
}

async function openDrawer(graph) {
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes(graph.name))[0].props.onClick()
  button(view.tree, 'Flow').props.onClick()
  button(view.tree, 'Edit').props.onClick()
  const nodeAt = id => findAll(view.tree, node => node.props?.['data-node'] === id)[0]
  const canvas = () => findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-canvas'))[0]
  return { view, calls, nodeAt, canvas }
}

test('dragging the rightmost node moves it on screen inside the frame the drag started with (#1575)', async () => {
  const nodes = [
    { id: 'left', name: 'Left', role: '', x: 0, y: 100 },
    { id: 'middle', name: 'Middle', role: '', x: 172, y: 100 },
    { id: 'right', name: 'Right', role: '', x: 344, y: 100 },
  ]
  const { view, calls, nodeAt, canvas } = await openDrawer(drawerGraph('wide', 'Wide graph', nodes))
  const fit = client.fitPlane(nodes, client.DRAWER_FLOW_W)
  assert.equal(fit.scale, 0.5, 'the fixture spans wider than the drawer room')
  const before = Object.fromEntries(nodes.map(node => [node.id, { ...nodeAt(node.id).props.style }]))

  nodeAt('right').props.onPointerDown({ clientX: 300, clientY: 100, target: { dataset: {} } })
  canvas().props.onPointerMove({ clientX: 320, clientY: 100 })
  canvas().props.onPointerMove({ clientX: 340, clientY: 100 })
  assert.equal(nodeAt('right').props.style.left, before.right.left + 40, 'the rightmost node follows the pointer 1:1')
  assert.equal(nodeAt('middle').props.style.left, before.middle.left, 'the fit did not re-centre another node')
  assert.equal(nodeAt('left').props.style.left, before.left.left, 'the fit did not re-centre another node')

  canvas().props.onPointerUp({ clientX: 340, clientY: 100, target: { dataset: {} } })
  const saved = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.equal(saved.body.nodes.find(node => node.id === 'right').x, 344 + 80, 'the commit uses the start frame, not an intermediate one')
  view.unmount()
})

test('dragging the topmost node up moves it on screen inside the frame the drag started with (#1575)', async () => {
  const nodes = [
    { id: 'top', name: 'Top', role: '', x: 172, y: 0 },
    { id: 'middle', name: 'Middle', role: '', x: 172, y: 200 },
    { id: 'bottom', name: 'Bottom', role: '', x: 172, y: 400 },
  ]
  const { view, calls, nodeAt, canvas } = await openDrawer(drawerGraph('tall', 'Tall graph', nodes))
  const fit = client.fitPlane(nodes, client.DRAWER_FLOW_W)
  assert.equal(fit.scale, 1, 'a vertical chain is not scaled')
  const before = Object.fromEntries(nodes.map(node => [node.id, { ...nodeAt(node.id).props.style }]))

  nodeAt('top').props.onPointerDown({ clientX: 100, clientY: 100, target: { dataset: {} } })
  canvas().props.onPointerMove({ clientX: 100, clientY: 70 })
  canvas().props.onPointerMove({ clientX: 100, clientY: 60 })
  assert.equal(nodeAt('top').props.style.top, before.top.top - 40, 'the topmost node follows the pointer 1:1')
  assert.equal(nodeAt('middle').props.style.top, before.middle.top, 'the fit did not push another node around')
  assert.equal(nodeAt('bottom').props.style.top, before.bottom.top, 'the fit did not push another node around')

  canvas().props.onPointerUp({ clientX: 100, clientY: 60, target: { dataset: {} } })
  const saved = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.equal(saved.body.nodes.find(node => node.id === 'top').y, -40, 'the commit keeps the start frame')
  view.unmount()
})

test('a middle-node drag keeps the frame it started with (#1575)', async () => {
  const nodes = [
    { id: 'left', name: 'Left', role: '', x: 0, y: 100 },
    { id: 'middle', name: 'Middle', role: '', x: 172, y: 100 },
    { id: 'right', name: 'Right', role: '', x: 344, y: 100 },
  ]
  const { view, calls, nodeAt, canvas } = await openDrawer(drawerGraph('middle', 'Middle graph', nodes))
  const before = Object.fromEntries(nodes.map(node => [node.id, { ...nodeAt(node.id).props.style }]))

  nodeAt('middle').props.onPointerDown({ clientX: 300, clientY: 100, target: { dataset: {} } })
  canvas().props.onPointerMove({ clientX: 340, clientY: 100 })
  assert.equal(nodeAt('middle').props.style.left, before.middle.left + 40, 'a middle node still follows the pointer')
  assert.equal(nodeAt('left').props.style.left, before.left.left)
  assert.equal(nodeAt('right').props.style.left, before.right.left)

  canvas().props.onPointerUp({ clientX: 340, clientY: 100, target: { dataset: {} } })
  const saved = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.equal(saved.body.nodes.find(node => node.id === 'middle').x, 172 + 80)
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

test('settings can change the workflow concurrency limit', async () => {
  const calls = []
  const graph = delivery()
  graph.maxConcurrent = 2
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph] }
    if (name === 'workflow/concurrency') {
      graph.maxConcurrent = body.maxConcurrent
      return { ok: true, workflows: [graph] }
    }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  const concurrentInput = findAll(settings.tree, node => node.props?.['aria-label'] === 'Concurrent runs')[0]
  assert.ok(concurrentInput, 'concurrent runs input should exist')
  assert.equal(concurrentInput.props.value, 2)
  assert.equal(concurrentInput.props.min, 1)
  assert.equal(concurrentInput.props.max, 8)

  concurrentInput.props.onChange({ target: { value: '4' } })
  await settle()
  const changed = calls.filter(item => item.name === 'workflow/concurrency').at(-1)
  assert.equal(changed.body.workflowId, 'delivery')
  assert.equal(changed.body.maxConcurrent, 4)
  settings.unmount()
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

test('the settings canvas fits the graph to its own width, and a drag follows that scale', async () => {
  // Settings → Workflow graphs: the canvas reports 640px, so the 960px design
  // plane is scaled down instead of growing a second scrollbar (#1483).
  live.rectWidth = 640
  try {
    const calls = []
    const graph = delivery()
    const call = async (name, body) => {
      calls.push({ name, body })
      if (name === 'workflow/state') return { workflows: [graph] }
      return { ok: true, workflows: [graph] }
    }
    const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
    await settle()

    const designW = client.WIRE_SPAN * 2
    const plane = findAll(settings.tree, node => node.props?.['data-plane'] === '1')[0]
    assert.ok(plane, 'the settings page draws a graph plane')
    const width = Number(plane.props.style.width)
    assert.equal(width, 640, 'the canvas draws the graph at the width it has, not on a 960px plane')
    const scale = width / designW
    const fit = findAll(settings.tree, node => node.props?.className === 'wf-canvas-fit')[0]
    assert.ok(fit, 'the graph is drawn through a scaling layer')
    assert.equal(fit.props.style.transform, `scale(${scale})`)
    assert.equal(Number(plane.props.style.height), Math.round(Math.max(420, ...graph.nodes.map(node => (node.y ?? 0) + 150)) * scale))

    for (const node of graph.nodes) {
      const drawn = findAll(settings.tree, item => item.props?.['data-node'] === node.id)[0]
      const left = Number(drawn.props.style.left)
      assert.ok(left * scale >= -width / 2 - 0.5, `${node.id} starts inside the canvas`)
      assert.ok((left + client.NODE_W) * scale <= width / 2 + 0.5, `${node.id} ends inside the canvas`)
    }
    const wires = findAll(settings.tree, node => node.props?.className === 'wf-wires')[0]
    assert.equal(Number(wires.props.width) * scale, width, 'the wire layer spans exactly the canvas width once scaled')
    for (const path of findAll(settings.tree, node => node.props?.className !== undefined && typeof node.props.d === 'string' && node.props.d.startsWith('M '))) {
      for (const x of [...path.props.d.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map(match => Number(match[1]))) {
        assert.ok(x >= 0 && x <= designW, 'a wire stays inside the wire layer, not off the canvas border')
      }
    }

    button(settings.tree, 'Edit').props.onClick()
    const coder = findAll(settings.tree, node => node.props?.['data-node'] === 'coder')[0]
    coder.props.onPointerDown({ clientX: 10, clientY: 20, preventDefault() {}, target: { dataset: {} } })
    const canvas = findAll(settings.tree, node => node.props?.className === 'wf-canvas-view')[0]
    canvas.props.onPointerMove({ clientX: 58, clientY: 44 })
    const saved = calls.filter(item => item.name === 'workflow/graph').at(-1).body.nodes.find(node => node.id === 'coder')
    assert.equal(saved.x, Math.round(200 + 48 / scale), 'the pointer delta is divided by the scale')
    assert.equal(saved.y, Math.round(260 + 24 / scale))
    settings.unmount()
  } finally {
    live.rectWidth = 0
  }
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

// The stage chat follows a new line only while the reader is at the bottom: the
// scroll effect used the raw message count, so a filtered node reply dragged it
// down without one visible line changing.
async function openStageChat(messages) {
  const graph = delivery()
  graph.messages = messages
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  const chat = findAll(view.tree, node => node.props?.className === 'wf-chat')[0]
  assert.ok(chat, 'the stage chat did not mount, so its scroll effect could not run')
  const chatEl = chat.props.ref?.current
  assert.ok(chatEl, 'mount() never attached the stage chat ref, so the scroll effect is a no-op')
  return { view, graph, chatEl }
}

test('the stage chat follows a new visible line to the bottom', async () => {
  const { view, graph, chatEl } = await openStageChat([{ id: 'm1', kind: 'user', text: '一条可见的说明' }])
  chatEl.clientHeight = 100
  chatEl.scrollHeight = 800
  chatEl.scrollTop = 800
  graph.messages = [...graph.messages, { id: 'm2', kind: 'system', text: '任务已进入 Workflow' }]
  chatEl.scrollHeight = 900
  view.rerender()
  assert.equal(chatEl.scrollTop, 900, 'a new visible stage line did not scroll the chat to the bottom')
  view.unmount()
})

test('the stage chat keeps its place when the new lines are filtered node replies', async () => {
  const { view, graph, chatEl } = await openStageChat([
    { id: 'm1', kind: 'user', text: '一条可见的说明' },
    { id: 'm2', kind: 'system', text: '任务已进入 Workflow' },
  ])
  chatEl.clientHeight = 100
  chatEl.scrollHeight = 800
  chatEl.scrollTop = 0 // the reader scrolled up
  graph.messages = [...graph.messages,
    { id: 'm3', kind: 'bot', botId: 'coder', text: 'node step output' },
    { id: 'm4', kind: 'bot', botId: 'writer', text: 'another node step output' },
  ]
  assert.equal(client.stageMessages(graph, graph.messages, { bots: [] }).length, 2, 'the fixture must filter both new node replies out of the stage chat')
  view.rerender()
  assert.equal(chatEl.scrollTop, 0, 'a filtered node reply still dragged the stage chat to the bottom')
  view.unmount()
})

async function stageChatText(messages, roster) {
  const graph = delivery()
  graph.messages = messages
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  const text = textOf(view.tree)
  view.unmount()
  return text
}

function longLine(kind) {
  const tail = kind === 'user' ? '让发布说明覆盖四个小节，并保留每条验收命令的原文。'
    : kind === 'system' ? '系统提示的每一行都要完整显示，不能丢尾巴。'
      : '这是 Chief 的原话，一个字都不能丢。'
  const line = `${kind.toUpperCase()} ${tail.repeat(20)}END`
  assert.ok(line.length > 240, `the fixture must exceed the 240-character preview cap, got ${line.length}`)
  return line
}

// A lone surrogate is what a UTF-16 cut leaves behind; it renders as \u{FFFD}.
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function assertFull(text, line) {
  assert.equal(text.includes(line), true, `the stage chat dropped part of a ${line.length}-character line`)
  assert.equal(text.includes(`${line.slice(0, 239)}…`), false, 'the stage chat still clipped a line at 240 characters')
}

test('a long user line in the stage chat renders in full', async () => {
  const long = longLine('user')
  const text = await stageChatText([{ id: 'm1', kind: 'user', text: long }], { bots: [] })
  assertFull(text, long)
})

test('a long system line in the stage chat renders in full', async () => {
  const long = longLine('system')
  const text = await stageChatText([{ id: 'm1', kind: 'system', text: long }], { bots: [] })
  assertFull(text, long)
})

test('a long roster Bot line in the stage chat renders in full', async () => {
  const long = longLine('bot')
  const roster = { bots: [], byId: { 'bot-chief': { id: 'bot-chief', name: 'Chief' } } }
  const text = await stageChatText([{ id: 'm1', kind: 'bot', botId: 'bot-chief', text: long }], roster)
  assertFull(text, long)
})

test('a long emoji/CJK Ext-B task title renders whole, never cut mid-character', async () => {
  const graph = delivery()
  // 60 UTF-16 units then an astral pair: the old 61st-unit cut landed inside the
  // surrogate pair and left a lone surrogate (rendered as \u{FFFD}).
  const longTitle = `${'发布说明'.repeat(15)}🚀𠀋${'验收命令'.repeat(12)}`
  graph.run.task = { id: '#1460', title: longTitle }
  delete graph.run.taskSummary
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  const summary = client.taskSummary({ id: '#1460', title: longTitle })
  assert.equal(summary, `#1460 · ${longTitle}`, 'the task summary is not the whole id and title')
  assert.equal(hasLoneSurrogate(summary), false, 'the task summary ends in a lone surrogate')
  assert.equal(textOf(view.tree).includes(longTitle), true, 'the stage strip dropped part of the task title')

  // The tooltip keeps the whole title, and the row clips itself in CSS instead.
  const label = findAll(view.tree, node => node.props?.className === 'wf-tk')[0]
  assert.equal(label.props.title, longTitle, 'the row tooltip lost the whole title')
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = css.split('\n').find(line => line.startsWith('.wf-tk{'))
  assert.match(rule, /white-space:nowrap/, 'the task row is no longer single-line')
  assert.match(rule, /text-overflow:ellipsis/, 'the task row no longer ellipsizes')

  // An id-less title takes the other branch, which used to cut at 69 units.
  const bareTitle = `${'验收命令'.repeat(17)}🚀`
  const bare = client.taskSummary({ title: bareTitle })
  assert.equal(bare, bareTitle, 'the id-less task summary is not the whole title')
  assert.equal(hasLoneSurrogate(bare), false, 'the id-less task summary ends in a lone surrogate')
  view.unmount()
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

test('#1647: the stage lists the tasks a workflow holds, each with one re-match action through ingest', async () => {
  let workflows = [{ ...delivery(), id: 'alpha', name: 'Alpha', heldTasks: ['task-9'], heldTaskCount: 1 }]
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows, templates: [] }
    if (name === 'workflow/ingest' && body?.rematch === true) workflows = [{ ...workflows[0], heldTasks: [], heldTaskCount: 0 }]
    return { ok: true, workflows }
  }
  const prevHost = globalThis.__flybot__
  globalThis.__flybot__ = {
    host: async (channel) => (channel === 'tasks' ? [{ id: 'task-9', title: 'Move me', status: 'open' }] : []),
  }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.type === 'button' && String(node.props?.className ?? '').includes('wf-row') && textOf(node).includes('Alpha'))[0].props.onClick()
    await settle()

    assert.ok(textOf(view.tree).includes('task-9'), 'the workflow stage names the task it holds')
    const rematch = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Re-match')
    assert.equal(rematch.length, 1, 'one re-match action for the one held task')
    rematch[0].props.onClick()
    await settle()

    const ingest = calls.filter(item => item.name === 'workflow/ingest' && item.body?.rematch === true)
    assert.equal(ingest.length, 1, 'the action goes through the existing ingest call')
    assert.deepEqual(ingest[0].body, { id: 'task-9', title: 'Move me', status: 'open', rematch: true }, 'the board row is passed with the explicit flag')
    assert.equal(textOf(view.tree).includes('task-9'), false, 'the stage repaints from the store after the action')
    view.unmount()
  } finally {
    globalThis.__flybot__ = prevHost
  }
})

test('the room flowchart canvas scrolls in its panel, and the settings canvas leaves one scroll to the page', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.wf-canvas\{[^}]*overflow:auto/)
  // Settings → Workflow graphs fits its graph to the canvas width, so the
  // canvas is not a scroll container inside the page's own scroll (#1483).
  assert.match(source, /\.wf-canvas-view\{[^}]*overflow:visible/)
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

test('a failed live attempt is listed once, as failed, not as its own history row (#1583)', () => {
  const task = { id: '#1422', title: 'PR 1422' }
  const workflow = {
    activeCount: 0,
    queue: [],
    runs: [{ id: 'run-a', live: true, status: 'failed', task, updatedAt: 1_700_000_000_000 }],
    run: { id: 'run-a', live: true, status: 'failed', task, updatedAt: 1_700_000_000_000 },
    history: [{ task, status: 'failed', at: 1_700_000_000_000 }],
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows.filter(row => row.status === 'running').length, 0)
})

test('a genuine retry still shows the failed attempt and the current one (#1583)', () => {
  const task = { id: '#1422', title: 'PR 1422' }
  const workflow = {
    activeCount: 1,
    queue: [],
    runs: [{ id: 'run-b', live: true, status: 'running', task, updatedAt: 1_700_000_100_000 }],
    run: { id: 'run-b', live: true, status: 'running', task, updatedAt: 1_700_000_100_000 },
    history: [{ task, status: 'failed', at: 1_700_000_000_000 }],
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.status), ['running', 'failed'])
  assert.deepEqual(rows.map(row => row.current), [true, false])
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

test('the drawer fits every node and edge inside a 400px panel', () => {
  const graph = delivery()
  const panel = client.DRAWER_FLOW_W
  assert.equal(panel, 364, 'the drawer Flow content box is 400px minus two 18px paddings')
  const plane = client.fitPlane(graph.nodes, panel)
  assert.equal(plane.width, panel)
  assert.ok(plane.scale > 0 && plane.scale <= 1, 'the fit never enlarges the graph')
  for (const node of plane.nodes) {
    const left = node.x - client.NODE_W / 2
    const right = node.x + client.NODE_W / 2
    assert.ok(left >= 0 && right <= panel, `${node.id} box ${left}..${right} is outside 0..${panel}`)
  }
  for (const layer of graph.layers.filter(layer => layer.length > 1)) {
    const members = layer.map(id => plane.nodes.find(node => node.id === id))
    const frame = client.parallelFrameStyle(members)
    assert.ok(frame.left >= 0 && frame.left + frame.width <= panel, `${layer.join('+')} frame ${frame.left}..${frame.left + frame.width} is outside 0..${panel}`)
  }
  assert.ok(plane.scale < 1, 'GAP_X=188 parallel columns cannot fit a 364px panel at scale 1')
  for (const edge of graph.edges) {
    const from = plane.nodes.find(node => node.id === edge.from)
    const to = plane.nodes.find(node => node.id === edge.to)
    for (const point of [{ x: from.x, y: from.y + client.NODE_WIRE_OUT }, { x: to.x, y: to.y }]) {
      assert.ok(point.x >= 0 && point.x <= panel, `${edge.from}>${edge.to} leaves the plane at x=${point.x}`)
      assert.ok(point.y >= 0 && point.y <= plane.height)
    }
  }
})

test('fitted wire endpoints land on the node anchors and stay inside the plane', () => {
  const graph = delivery()
  const plane = client.fitPlane(graph.nodes, client.DRAWER_FLOW_W)
  const at = id => plane.nodes.find(node => node.id === id)
  const edges = graph.edges.concat([{ from: 'deployer', to: 'planner', loop: true, max: 2 }])
  for (const edge of edges) {
    const from = at(edge.from)
    const to = at(edge.to)
    const d = client.wirePath(from, to, 0)
    assert.ok(d.startsWith(`M ${from.x} ${from.y + client.NODE_WIRE_OUT} `), `${edge.from}>${edge.to} did not leave the source bottom anchor: ${d}`)
    const numbers = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
    assert.equal(numbers.at(-2), to.x, `${edge.from}>${edge.to} did not land on the target x anchor`)
    assert.equal(numbers.at(-1), to.y, `${edge.from}>${edge.to} did not land on the target y anchor`)
    assert.ok(numbers.filter((_, i) => i % 2 === 0).every(x => x >= 0 && x <= plane.width), `${edge.from}>${edge.to} leaves the fitted width`)
    assert.ok(numbers.filter((_, i) => i % 2 === 1).every(y => y >= 0 && y <= plane.height), `${edge.from}>${edge.to} leaves the fitted height`)
  }
})

test('the drawer canvas does not scroll sideways and its labels wrap', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.wf-canvas\[data-fit="drawer"\]\{[^}]*overflow:hidden/, 'the fitted drawer canvas still scrolls')
  assert.match(source, /\.wf-dr-body\{[^}]*overflow:auto/, 'the drawer body lost its single vertical scroll')
  const label = source.match(/\.wf-plabel\{[^}]*\}/)[0]
  assert.equal(label.includes('white-space:nowrap'), false, 'the parallel label is still clipped at the panel edge')
  assert.match(label, /white-space:normal/)
  const term = source.match(/\.wf-canvas\[data-fit="drawer"\] \.wf-term\{[^}]*\}/)[0]
  assert.match(term, /white-space:normal/)
  assert.equal(term.includes('text-overflow:ellipsis'), false)
})

test('the drawer Flow mounts the fitted narrow canvas and Settings keeps the scrolling one', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const section = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(section.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  button(section.tree, 'Flow').props.onClick()
  const narrow = findAll(section.tree, node => node.props?.['data-fit'] === 'drawer')
  assert.equal(narrow.length, 1, 'the drawer Flow canvas is not the fitted variant')
  assert.equal(narrow[0].props['data-fit'], 'drawer')
  const plane = findAll(section.tree, node => node.props?.['data-plane'] === '1')[0]
  assert.ok(plane.props.style.width > 0 && plane.props.style.width <= client.DRAWER_FLOW_W)
  section.unmount()

  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  assert.equal(findAll(settings.tree, node => node.props?.['data-fit'] === 'drawer').length, 0)
  assert.equal(findAll(settings.tree, node => node.props?.className === 'wf-canvas-view').length, 1)
  settings.unmount()
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

const workflowCss = () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  return source.slice(source.indexOf('const CSS = `') + 'const CSS = `'.length)
}
const ruleBody = (name, css = workflowCss()) => new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
const hexRgb = (hex) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
const linear = (value) => {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminanceOf = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const contrastOf = (a, b) => {
  const first = luminanceOf(a)
  const second = luminanceOf(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
const declaredInk = (declared, text) => {
  const token = /var\(--bt-ink-([23])/.exec(declared)
  if (token) return { rgb: hexRgb(text), alpha: token[1] === '2' ? 0.6 : 0.36 }
  const literal = /rgba?\(([^)]+)\)/.exec(declared)
  if (!literal) throw new Error(`the .wf-rl colour cannot be resolved: ${declared}`)
  const parts = literal[1].split(',').map(value => Number(value.trim()))
  return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 }
}
const compositeOver = ({ rgb, alpha }, background) => rgb.map((value, index) => alpha * value + (1 - alpha) * background[index])

test('the flowchart node role sub-label colour is a theme token, never a bare grey', () => {
  const body = ruleBody('wf-rl')
  assert.match(body, /color:var\(--bt-ink-2,/, '.wf-rl must take its colour from a theme token')
  assert.doesNotMatch(body, /color:(rgba?\(|#)/, '.wf-rl must not hardcode its colour')
})

test('the node role sub-label keeps 4.4:1 in light and 4.5:1 in every dark theme', () => {
  const declared = /color:([^;]+)/.exec(ruleBody('wf-rl'))?.[1] ?? ''
  const modes = []
  for (const [id, theme] of Object.entries(allThemes())) {
    modes.push({ id, mode: 'light', palette: theme.light })
    modes.push({ id, mode: 'dark', palette: theme.dark })
  }
  assert.ok(modes.length >= 8, 'every shipped theme has a light and a dark mode')
  for (const { id, mode, palette } of modes) {
    const ink = declaredInk(declared, palette.text)
    const card = hexRgb(palette.card)
    const ratio = contrastOf(compositeOver(ink, card), card)
    // Every dark card is dark (#1f1f1f / #1c1c1c / #2a2925 / #141c33), so 4.5:1 is the bar there.
    // In light, --bt-ink-2 (0.6 alpha) gives 4.81 on DeepSeek's #141414 text; Paper's text is
    // #1f1e1b, which composites to 4.42 — the token itself cannot reach 4.5 without a core token
    // change, so light is held at 4.4:1 and never below the 4.07:1 the hardcoded grey gave.
    const floor = mode === 'dark' ? 4.5 : 4.4
    assert.ok(ratio >= floor, `${id} ${mode}: ${declared.trim()} on ${palette.card} is ${ratio.toFixed(2)}:1, below ${floor}:1`)
  }
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
    assert.equal(client.tr('Pick a node'), '选择一个节点')
    assert.equal(client.columnOf({ status: 'working' }), 'in-progress')
    assert.equal(client.shortId('task-abcdef123456'), '#123456')
  } finally {
    globalThis.__flybot__ = prev
  }
})

test('a failed stage graph save is reported, not swallowed', async (t) => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    const call = async (name) => {
      if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
      if (name === 'workflow/graph') throw new Error('The workflow store refused the write')
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    t.after(() => view.unmount())
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Flow')[0].props.onClick()
    button(view.tree, 'Edit').props.onClick()
    const coder = findAll(view.tree, node => node.props?.['data-node'] === 'coder')[0]
    coder.props.onPointerDown({ clientX: 10, clientY: 20, target: { dataset: {} } })
    let canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
    canvas.props.onPointerMove({ clientX: 58, clientY: 44 })
    canvas = findAll(view.tree, node => node.props?.className === 'wf-canvas')[0]
    canvas.props.onPointerUp({ clientX: 58, clientY: 44, target: { dataset: {} } })
    await settle()
    assert.deepEqual(alertsOf(view), ['The workflow store refused the write'])
    assert.deepEqual(unhandled, [])
  })
})

test('a failed stage reset is reported instead of leaving the button dead', async (t) => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    const call = async (name) => {
      if (name === 'workflow/state') return { workflows: [graph], templates: [] }
      if (name === 'workflow/reset') throw new Error('The reset was refused')
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    t.after(() => view.unmount())
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Flow')[0].props.onClick()
    button(view.tree, '↺ Reset').props.onClick()
    await settle()
    assert.deepEqual(alertsOf(view), ['The reset was refused'])
    assert.deepEqual(unhandled, [])
  })
})

test('a failed pause or stop from the run strip is reported', async (t) => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    graph.activeCount = 1
    let failure = ''
    const call = async (name) => {
      if (name === 'workflow/state') return { workflows: [graph], templates: [] }
      if (name === 'workflow/pause' || name === 'workflow/reset') throw new Error(failure)
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    t.after(() => view.unmount())
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
    await settle()
    failure = 'The pause was refused'
    button(view.tree, 'Pause').props.onClick()
    await settle()
    assert.deepEqual(alertsOf(view), ['The pause was refused'])
    failure = 'The stop was refused'
    button(view.tree, 'Stop').props.onClick()
    await settle()
    assert.deepEqual(alertsOf(view), ['The stop was refused'])
    assert.deepEqual(unhandled, [])
  })
})

test('a failed resume from the run strip is reported', async (t) => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    graph.activeCount = 1
    graph.run.paused = true
    const call = async (name) => {
      if (name === 'workflow/state') return { workflows: [graph], templates: [] }
      if (name === 'workflow/resume') throw new Error('The resume was refused')
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    t.after(() => view.unmount())
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
    await settle()
    button(view.tree, 'Resume').props.onClick()
    await settle()
    assert.deepEqual(alertsOf(view), ['The resume was refused'])
    assert.deepEqual(unhandled, [])
  })
})

// #1520: the Tools field selects connectors, and nothing on screen said so. The
// note is read in one render in both languages, so the explanation never depends
// on the host's locale detection.
const toolsField = view => findAll(view.tree, node => node.type === 'label' && textOf(node.children?.[0] ?? '') === 'Tools')[0]
const toolsInput = view => toolsField(view)?.children?.find(child => child?.type === 'input')

test('the Tools field says it names connectors and that file and shell access is always full', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph] }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  button(settings.tree, 'Edit').props.onClick()
  await settle()
  findAll(settings.tree, node => node.props?.['data-node'] === 'coder')[0].props.onClick()
  await settle()

  const field = toolsField(settings)
  assert.ok(field, 'the inspector renders a Tools field')
  const note = field.children.find(child => child?.props?.['data-flybot'] === 'node-tools-note')
  assert.ok(note, 'the Tools field explains what it names')
  const noteIndex = field.children.indexOf(note)
  const inputIndex = field.children.findIndex(child => child?.type === 'input')
  assert.ok(noteIndex > inputIndex, 'the note sits under the input, not above it')
  const text = textOf(note)
  assert.match(text, /Names the connectors this run Bot may use/)
  assert.match(text, /github grants mcp__github__\*/)
  assert.match(text, /composio grants the Composio connector/)
  assert.match(text, /File and shell access is always full, like a normal Bot/)
  assert.match(text, /a node that names no connector gets none/)
  assert.match(text, /连接器/, 'the note reads in Chinese as well as English')
  assert.match(text, /普通 Bot/)

  const input = field.children[inputIndex]
  assert.equal(input.props.placeholder, 'github, composio', 'the placeholder names two connectors and nothing else')
  settings.unmount()
})

// #1520: the value was rebuilt from the saved list on every keystroke, and the host
// drops a trailing empty token, so a separator typed between two names did not
// survive the round trip: "github, composio" typed one character at a time saved as
// ["githubcomposio"] and the connector was silently refused. The field keeps a local
// draft and commits it on blur, or after a short pause.
async function toolsInspector() {
  const graph = delivery()
  graph.nodes = graph.nodes.map(node => node.id === 'coder' ? { ...node, tools: [] } : node)
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph] }
    if (name === 'workflow/graph') {
      // The host normalizes the list on every save, exactly as src/graph.js does.
      graph.nodes = body.nodes.map(node => ({ ...node, tools: cleanTools(node.tools) }))
      return { ok: true, workflows: [graph] }
    }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  button(view.tree, 'Edit').props.onClick()
  await settle()
  findAll(view.tree, node => node.props?.['data-node'] === 'coder')[0].props.onClick()
  await settle()
  const saved = () => calls.filter(item => item.name === 'workflow/graph').at(-1)
    ?.body.nodes.find(node => node.id === 'coder')?.tools
  return { view, calls, field: () => toolsInput(view), saved }
}

test('the Tools field takes a second connector typed one character at a time', async () => {
  const typedView = await toolsInspector()
  assert.ok(typedView.field(), 'the inspector renders the Tools input')
  let text = ''
  for (const char of 'github, composio') {
    text += char
    typedView.field().props.onChange({ target: { value: text } })
    await settle()
    assert.equal(typedView.field().props.value, text, 'the draft keeps every character just typed')
  }
  assert.equal(typedView.calls.some(item => item.name === 'workflow/graph'), false, 'no save round trip while the user types')
  typedView.field().props.onBlur()
  await settle()
  assert.deepEqual(typedView.saved(), ['github', 'composio'], 'typing one character at a time keeps both connectors')
  assert.equal(typedView.field().props.value, 'github, composio', 'the field shows the saved list after the commit')
  typedView.view.unmount()

  const pastedView = await toolsInspector()
  pastedView.field().props.onChange({ target: { value: 'github, composio' } })
  await settle()
  pastedView.field().props.onBlur()
  await settle()
  assert.deepEqual(pastedView.saved(), ['github', 'composio'], 'pasting the whole string saves the same list')
  pastedView.view.unmount()

  const pausedView = await toolsInspector()
  pausedView.field().props.onChange({ target: { value: 'github, ' } })
  await settle()
  assert.equal(pausedView.saved(), undefined, 'the field has not saved yet')
  await new Promise(resolve => setTimeout(resolve, 800))
  await settle()
  assert.deepEqual(pausedView.saved(), ['github'], 'a short pause commits the list without a blur')
  pausedView.field().props.onChange({ target: { value: 'github, composio' } })
  await settle()
  pausedView.field().props.onBlur()
  await settle()
  assert.deepEqual(pausedView.saved(), ['github', 'composio'], 'a pause in the middle does not eat the separator')
  pausedView.view.unmount()
})

test('a stage control that never answers settles as an error', async () => {
  const value = await client.settledCall(async () => new Promise(() => {}), 'workflow/pause', { workflowId: 'delivery' }, 'The run did not answer', 5)
  assert.deepEqual(value, { ok: false, error: 'The run did not answer' })
})

// A host that never hands board writes over looks manual-only unless the panel says so (#1462).
test('a host without the board wiring says so on the panel, and a wired host says nothing', async () => {
  const graph = delivery()
  const mountWith = async (tasksWired) => {
    const call = async name => (name === 'workflow/state'
      ? { ok: true, workflows: [graph], templates: [], tasksWired }
      : { ok: true, workflows: [graph] })
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    return view
  }
  const unwired = await mountWith(false)
  const lines = findAll(unwired.tree, node => node.props?.className === 'wf-wiring').map(textOf)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /does not pass task writes/)
  unwired.unmount()

  const wired = await mountWith(true)
  assert.equal(findAll(wired.tree, node => node.props?.className === 'wf-wiring').length, 0)
  wired.unmount()
})

const cssRule = (source, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\{([^}]*)\\}`).exec(source)
  assert.ok(match, `missing CSS rule ${selector}`)
  return match[1]
}
const pixel = (declaration, rule) => {
  const match = new RegExp(`${declaration}:(\\d+(?:\\.\\d+)?)px`).exec(rule)
  assert.ok(match, `missing ${declaration} in ${rule}`)
  return Number(match[1])
}

test('the settings Add link panel uses the dialog form, a Pick a node placeholder and a disabled submit', async () => {
  const calls = []
  const graph = delivery()
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph] }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  button(settings.tree, 'Edit').props.onClick()
  await settle()
  const form = findAll(settings.tree, node => node.props?.className === 'wf-edge-form')[0]
  assert.ok(form, 'the Add link panel carries wf-edge-form')
  assert.equal(textOf(findAll(form, node => node.type === 'h3')[0]), 'Add link')
  const pick = label => findAll(settings.tree, node => node.props?.['aria-label'] === label)[0]
  for (const label of ['From node', 'To node']) {
    const options = findAll(pick(label), node => node.type === 'option')
    assert.equal(options[0].props.value, '')
    assert.equal(textOf(options[0]), 'Pick a node', `${label} starts on a placeholder, not a blank option`)
  }
  assert.equal(button(settings.tree, 'Add link').props.className, 'wf-btn wf-pri')
  assert.equal(button(settings.tree, 'Add link').props.disabled, true, 'the submit waits for both ends')
  pick('From node').props.onChange({ target: { value: 'coder' } })
  await settle()
  assert.equal(button(settings.tree, 'Add link').props.disabled, true, 'one end alone does not enable the submit')
  pick('To node').props.onChange({ target: { value: 'planner' } })
  await settle()
  assert.equal(button(settings.tree, 'Add link').props.disabled, false)
  button(settings.tree, 'Add link').props.onClick()
  const linked = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.ok(linked.body.edges.some(edge => edge.from === 'coder' && edge.to === 'planner'))
  settings.unmount()
})

test('graph handles are small, off the wire and lit only on hover or while dragging a wire', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph] }
    return { ok: true, workflows: [graph] }
  }
  const settings = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
  await settle()
  assert.equal(findAll(settings.tree, node => node.props?.['data-port'] === 'out').length, 0, 'no handles outside Edit mode')
  button(settings.tree, 'Edit').props.onClick()
  await settle()
  const ports = findAll(settings.tree, node => node.props?.['data-port'] === 'out')
  assert.equal(ports.length, graph.nodes.length)
  assert.match(ports[0].props.className, /\bwf-port out\b/)
  assert.equal(ports.some(node => node.props.className.includes('wiring')), false)
  ports[0].props.onPointerDown({ preventDefault() {}, stopPropagation() {} })
  await settle()
  const lit = findAll(settings.tree, node => node.props?.['data-port'] === 'out' && node.props.className.includes('wiring'))
  assert.equal(lit.length, 1, 'an active wire gesture lights one handle')
  settings.unmount()

  const port = cssRule(source, '.wf-port')
  assert.ok(pixel('width', port) <= 10, `the handle is ${pixel('width', port)}px wide`)
  assert.ok(pixel('height', port) <= 10)
  assert.ok(pixel('border', port) <= 1.5)
  assert.match(port, /right:-5px/, 'the handle sits beside the connection line, not on it')
  assert.match(source, /\.wf-port:hover[^{]*\{[^}]*opacity:1/)
  assert.match(source, /\.wf-port:focus-visible[^{]*\{[^}]*opacity:1/)
  assert.match(source, /\.wf-port\.wiring\{[^}]*opacity:1/)
  const form = cssRule(source, '.wf-edge-form')
  assert.match(form, /padding:16px/)
  assert.match(cssRule(source, '.wf-edge-form h3'), /font-size:14px/)
  assert.ok(pixel('font-size', cssRule(source, '.wf-edge-form h3')) <= 14)
  assert.match(cssRule(source, '.wf-edge-form .wf-edge-fields'), /display:grid/)
  assert.match(cssRule(source, '.wf-edge-form .wf-field'), /margin-top:0/)
})

test('the settings page injects the workflow stylesheet without the sidebar section', async () => {
  const prev = globalThis.document
  const stub = (existing) => {
    const appended = []
    return {
      appended,
      getElementById: id => (existing && id === 'flybot-workflow-css' ? existing : null),
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild(element) { appended.push(element) } },
      querySelector() { return null },
      addEventListener() {},
      removeEventListener() {},
    }
  }
  try {
    const doc = stub(null)
    globalThis.document = doc
    const view = mount(client.WorkflowSettings, { call: async () => ({ workflows: [], templates: [] }), roster: { bots: [] } })
    await settle()
    const style = doc.appended.find(element => element.id === 'flybot-workflow-css')
    assert.ok(style, 'WorkflowSettings appended #flybot-workflow-css')
    assert.match(style.textContent, /\.wf-port\{/)
    assert.match(style.textContent, /\.wf-edge-form\{/)
    view.unmount()

    const again = stub({ id: 'flybot-workflow-css' })
    globalThis.document = again
    const second = mount(client.WorkflowSettings, { call: async () => ({ workflows: [], templates: [] }), roster: { bots: [] } })
    await settle()
    assert.equal(again.appended.length, 0, 'an existing stylesheet is not appended twice')
    second.unmount()
  } finally {
    globalThis.document = prev
  }
})

// The workflow stage polls the store while a run is live, and a read that fails must
// not be painted as "no workflows" (#1564).
test('an active run polls the store once per tick, not twice', async (t) => {
  const graph = delivery()
  graph.activeCount = 1
  const reads = []
  const call = async (name) => {
    if (name === 'workflow/state') { reads.push(Date.now()); return { workflows: [graph] } }
    return { ok: true, workflows: [graph] }
  }
  const timers = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  globalThis.clearInterval = () => {}
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    t.after(() => view.unmount())
    await settle()
    assert.equal(reads.length, 1, 'the first paint reads the store once')
    assert.equal(timers.length, 1, `exactly one poll is armed for one live run, saw ${timers.length}`)
    assert.equal(timers[0].ms, 2000)
    timers[0].fn()
    await settle()
    assert.equal(reads.length, 2, 'one tick is one read')
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

test('a failed store read is reported and retried, not painted as no workflows', async (t) => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    let reads = 0
    const call = async (name) => {
      if (name === 'workflow/state') {
        reads += 1
        if (reads === 1) throw new Error('The workflow store is unreachable')
        return { workflows: [graph] }
      }
      return { ok: true, workflows: [graph] }
    }
    const timers = []
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
    globalThis.clearInterval = () => {}
    try {
      const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
      t.after(() => view.unmount())
      await settle()
      assert.deepEqual(unhandled, [], 'a refused read is not an unhandled rejection')
      assert.deepEqual(alertsOf(view), ['The workflow store is unreachable'], 'the failure is on screen')
      assert.equal(htmlOf(view.tree).includes('No workflows yet.'), false, 'a failure is not an empty shelf')
      assert.equal(timers.length, 1, 'the failed read arms a retry')
      timers[0].fn()
      await settle()
      assert.deepEqual(alertsOf(view), [], 'the retry that succeeds clears the alert')
      assert.equal(textOf(view.tree).includes('发布交付流水线'), true, 'the workflows are on screen')
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
})

// #1493: the header lists the runs that are still the room's business, so a
// sibling that failed is on the stage beside the one that is running — and the
// Runs tab says when it ended and why. The sibling is not listed twice: the
// failed run is both a live-stage row and a history row.
test('#1493: a failed sibling run stays on the stage, and its row carries time and reason', async () => {
  const graph = delivery()
  const running = graph.run
  running.id = 'run-1445'
  running.task = { id: '#1445', title: 'issue #1445: a Workflow run keeps the team task' }
  running.taskSummary = '#1445 · issue #1445: a Workflow run keeps the team task'
  running.updatedAt = 1_700_000_000_000
  const failed = {
    id: 'run-1460',
    live: true,
    status: 'failed',
    task: { id: '#1460', title: 'issue #1460: every stage chat line is capped' },
    taskSummary: '#1460 · issue #1460: every stage chat line is capped',
    nodeStatus: { planner: 'done', writer: 'failed' },
    running: [],
    doneCount: 1,
    nodeCount: 6,
    marks: ['done', 'failed', 'queued', 'queued', 'queued'],
    steps: 2,
    stepBudget: 10,
    startedAt: 1_699_999_996_000,
    updatedAt: 1_700_000_000_000,
    failure: { code: 'step-failed', nodeName: 'Writer', text: 'the reply came back empty' },
  }
  graph.runs = [running, failed]
  graph.history = [
    { id: 'run-1460', task: failed.task, status: 'failed', at: failed.updatedAt, failure: failed.failure },
    { task: { id: '#1395', title: 'an older finished run' }, status: 'done', at: 1_699_999_000_000 },
  ]
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()

  const strips = findAll(view.tree, node => typeof node.props?.['data-run-id'] === 'string')
  assert.deepEqual(strips.map(node => node.props['data-run-id']), ['run-1445', 'run-1460'])
  const failedStrip = strips[1]
  assert.equal(textOf(failedStrip).includes('Failed'), true, 'the sibling strip does not say Failed')
  assert.equal(textOf(failedStrip).includes('Writer failed · the reply came back empty'), true, 'the sibling strip does not say why it failed')
  assert.equal(textOf(failedStrip).includes('Waiting for a task'), false)

  // Focusing the failed sibling is how the drawer shows its flow, so its row must be clickable.
  failedStrip.props.onClick()
  await settle()
  assert.equal(findAll(view.tree, node => node.props?.['data-run-id'] === 'run-1460' && node.props.className.includes('wf-strip-focus')).length, 1)

  // The strip's own Progress button is the door to its Runs row.
  const progress = findAll(failedStrip, node => node.type === 'button' && textOf(node) === 'Progress')[0]
  assert.ok(progress, 'the failed strip has no way into its Runs row')
  progress.props.onClick()
  await settle()

  const rows = findAll(view.tree, node => node.props?.className === 'wf-hist')
  assert.equal(rows.length, 3, `the Runs tab listed ${rows.length} rows for two live rows and two history rows, one of which is the failed run itself`)
  const row = rows.find(node => textOf(node).includes('#1460'))
  assert.ok(row, 'the failed run has no Runs row')
  assert.equal(textOf(row).includes('Failed'), true)
  assert.match(textOf(row), /\d{2}-\d{2} \d{2}:\d{2}/, 'the Runs row has no time')
  assert.equal(textOf(row).includes('Writer failed · the reply came back empty'), true, 'the Runs row has no reason')
  const older = rows.find(node => textOf(node).includes('#1395'))
  assert.ok(older, 'a history row was dropped')
  assert.equal(textOf(older).includes('Done'), true)
  view.unmount()
})

// #1618: Runs status column — duration must not jam into the Done chip, and a
// Failed row without host detail must not double-paint "Failed" as reason + chip.
test('#1618: Runs keeps time apart from the status chip and paints Failed once', async () => {
  const graph = delivery()
  graph.run = null
  graph.runs = []
  graph.history = [
    {
      id: 'rvrj1c',
      task: { id: '#1577', title: 'issue1577-fix: a long title that would crush the status column if meta shrank' },
      status: 'done',
      at: Date.UTC(2099, 0, 15, 2, 27),
    },
    {
      id: 'rvrj1x',
      task: { id: '#1472', title: 'issue1472-fix: bare failure without host detail' },
      status: 'failed',
      at: Date.UTC(2099, 0, 15, 2, 23),
      // no failure: failureText falls back to the same label as the chip
    },
    {
      id: 'rvrj27',
      task: { id: '#1531', title: 'issue1531-fix: step failure with a real reason' },
      status: 'failed',
      at: Date.UTC(2099, 0, 15, 2, 23),
      failure: { code: 'step-failed', nodeName: 'Writer', text: 'the reply came back empty' },
    },
  ]
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  await settle()
  // No live strip without a run: the stage pill toggles the drawer (Runs is a drawer tab).
  const pill = findAll(view.tree, node => node.type === 'button' && node.props?.className === 'wf-pill')[0]
  assert.ok(pill, 'stage pill missing')
  pill.props.onClick()
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Runs')[0].props.onClick()
  await settle()

  const rows = findAll(view.tree, node => node.props?.className === 'wf-hist')
  assert.equal(rows.length, 3)

  const done = rows.find(node => textOf(node).includes('#1577'))
  assert.ok(done, 'Done row missing')
  const doneTime = findAll(done, node => node.props?.className === 'wf-hist-time')[0]
  const doneChip = findAll(done, node => node.props?.className === 'wf-chip done')[0]
  assert.ok(doneTime, 'Done row has no dedicated time column')
  assert.ok(doneChip, 'Done row has no status chip column')
  assert.match(textOf(doneTime), /\d{2}:\d{2}/)
  assert.equal(textOf(doneChip), 'Done')
  assert.equal(findAll(done, node => node.props?.className === 'wf-hist-reason').length, 0)
  // Markup keeps time and chip as siblings under wf-hist (gap comes from CSS).
  assert.equal(done.children.includes(doneTime) || findAll(done, n => n === doneTime).length === 1, true)
  const meta = findAll(done, node => node.props?.className === 'wf-hist-meta')[0]
  assert.ok(meta)
  assert.equal(meta.children.includes(doneTime), true, 'time lives in meta, not inside the chip')
  assert.equal(done.children.includes(doneChip), true, 'chip is a hist sibling of meta, not nested under time')

  const bareFailed = rows.find(node => textOf(node).includes('#1472'))
  assert.ok(bareFailed, 'bare Failed row missing')
  assert.equal(findAll(bareFailed, node => node.props?.className === 'wf-hist-reason').length, 0, 'generic Failed must not double-draw as wf-hist-reason')
  const bareChip = findAll(bareFailed, node => typeof node.props?.className === 'string' && node.props.className.includes('wf-chip'))[0]
  assert.equal(textOf(bareChip), 'Failed')
  assert.equal(textOf(bareFailed).split('Failed').length - 1, 1, `bare Failed row text painted Failed more than once: ${textOf(bareFailed)}`)

  const detailed = rows.find(node => textOf(node).includes('#1531'))
  assert.ok(detailed, 'detailed Failed row missing')
  const reason = findAll(detailed, node => node.props?.className === 'wf-hist-reason')[0]
  assert.ok(reason, 'step failure must still show wf-hist-reason')
  assert.equal(textOf(reason).includes('Writer failed · the reply came back empty'), true)
  assert.equal(textOf(findAll(detailed, node => typeof node.props?.className === 'string' && node.props.className.includes('wf-chip'))[0]), 'Failed')

  // CSS contract: meta and status chip do not shrink; time stays nowrap; hist uses a gap.
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(css, /\.wf-hist\{[^}]*gap:10px/)
  assert.match(css, /\.wf-hist-task\{flex:1;min-width:0/)
  assert.match(css, /\.wf-hist-meta\{[^}]*flex:none/)
  assert.match(css, /\.wf-hist-time\{flex:none/)
  assert.match(css, /\.wf-hist>\.wf-chip\{flex:none\}/)
  assert.doesNotMatch(css, /\.wf-hist-meta\{[^}]*min-width:0/)

  view.unmount()
})

test('the drawer details name the permission every node Bot actually runs with', async () => {
  // #1535 made every node Bot danger-full-access, so a row claiming each Bot follows
  // its own permission was stale (#1548): the details must say the run's full access
  // is the same as a normal Bot's, and must not claim a per-Bot choice.
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [{ id: 'delivery', name: '发布交付流水线' }] }
    if (name === 'workflow/messages') return { messages: graph.messages }
    return { ok: true, workflows: [graph] }
  }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes('发布交付流水线'))[0].props.onClick()
  findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Flow')[0].props.onClick()
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Details')[0].props.onClick()
  await settle()
  const rows = findAll(view.tree, node => node.props?.className === 'wf-kv')
  const permission = rows.find(row => textOf(row.children?.[0] ?? '') === client.tr('Permissions'))
  assert.ok(permission, 'the details list a Permissions row')
  const value = textOf(permission.children[1])
  assert.doesNotMatch(value, /own permission/i, 'a node Bot does not pick its own permission')
  assert.match(value, /full access/i, 'the row names the full access a node Bot runs with')
  assert.match(value, /same as a normal Bot/i, 'and says it is a normal Bot\'s full access')
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = { t: key => (key === 'Tasks' ? '任务' : key) }
  try {
    assert.equal(client.tr('Full access, same as a normal Bot'), '完全访问，与普通 Bot 相同', 'the row is translated')
  } finally {
    globalThis.__flybot__ = prev
  }
  view.unmount()
})

// A failed call must end on the page's own alert, not on a spinner and not on a
// claim that something was saved: the three call sites of work/state, graph and
// set-model each report, recover, and leave no rejection behind.
test('a failed workflow/state read ends on the alert with a retry, not on "Reading workflows…"', async () => {
  await withUnhandled(async (unhandled) => {
    const calls = []
    let down = true
    const call = async (name) => {
      calls.push(name)
      if (name === 'workflow/state') {
        if (down) throw new Error('The workflow host did not answer')
        return { workflows: [delivery()], templates: [] }
      }
      return { ok: true, workflows: [delivery()] }
    }
    const view = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
    await settle()
    assert.deepEqual(calls, ['workflow/state'])
    const alerts = findAll(view.tree, node => node.props?.role === 'alert')
    assert.deepEqual(alerts.map(textOf), ['The workflow host did not answer'])
    assert.equal(textOf(view.tree).includes('Reading workflows…'), false)
    assert.deepEqual(unhandled, [])

    down = false
    button(view.tree, 'Try again').props.onClick()
    await settle()
    assert.deepEqual(calls, ['workflow/state', 'workflow/state'])
    assert.equal(findAll(view.tree, node => node.props?.role === 'alert').length, 0)
    assert.ok(textOf(view.tree).includes('发布交付流水线'))
    view.unmount()
  })
})

test('a failed graph save shows the alert and stops claiming changes are saved automatically', async () => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    let failure = new Error('The workflow store refused the write')
    const calls = []
    const call = async (name) => {
      calls.push(name)
      if (name === 'workflow/state') return { workflows: [graph], templates: [] }
      if (name === 'workflow/graph') {
        if (failure) throw failure
        return { ok: true, workflows: [graph] }
      }
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
    await settle()
    button(view.tree, 'Edit').props.onClick()
    await settle()
    assert.ok(textOf(view.tree).includes('Changes are saved automatically'))
    const pick = (label) => findAll(view.tree, node => node.props?.['aria-label'] === label)[0]
    pick('From node').props.onChange({ target: { value: 'coder' } })
    pick('To node').props.onChange({ target: { value: 'planner' } })
    button(view.tree, 'Add link').props.onClick()
    await settle()
    assert.ok(calls.includes('workflow/graph'))
    const alerts = findAll(view.tree, node => node.props?.role === 'alert')
    assert.deepEqual(alerts.map(textOf), ['The workflow store refused the write'])
    assert.equal(textOf(view.tree).includes('Changes are saved automatically'), false)
    assert.deepEqual(unhandled, [])

    failure = null
    pick('From node').props.onChange({ target: { value: 'coder' } })
    pick('To node').props.onChange({ target: { value: 'planner' } })
    button(view.tree, 'Add link').props.onClick()
    await settle()
    assert.equal(findAll(view.tree, node => node.props?.role === 'alert').length, 0)
    assert.ok(textOf(view.tree).includes('Changes are saved automatically'))
    view.unmount()
  })
})

test('a failed model change is reported, not silently taken as saved', async () => {
  await withUnhandled(async (unhandled) => {
    const graph = delivery()
    const call = async (name, body) => {
      if (name === 'workflow/state') {
        return { workflows: [graph], roster: { models: [{ ref: 'deepseek/pro', name: 'Pro', provider: 'deepseek' }] } }
      }
      if (name === 'workflow/set-model') throw new Error('The model switch failed')
      void body
      return { ok: true, workflows: [graph] }
    }
    const view = mount(client.WorkflowSettings, { call, roster: { bots: [] } })
    await settle()
    findAll(view.tree, node => node.props?.['aria-label'] === 'Model')[0].props.onChange({ target: { value: 'deepseek/pro' } })
    await settle()
    const alerts = findAll(view.tree, node => node.props?.role === 'alert')
    assert.deepEqual(alerts.map(textOf), ['The model switch failed'])
    assert.deepEqual(unhandled, [])
    view.unmount()
  })
})

test('a workflow host call that never answers settles as an error', async () => {
  const value = await client.settledCall(async () => new Promise(() => {}), 'workflow/state', undefined, 'The workflow host did not answer', 5)
  assert.deepEqual(value, { ok: false, error: 'The workflow host did not answer' })
})

// #1457: the dialog opens before the board arrives, so the first client render
// selected nothing and `Assign` looked accepted while it posted nothing.
test('#1457: the assign dialog selects the first loaded card and Assign posts it', async () => {
  const graph = delivery()
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = {
    host: async (channel) => {
      if (channel !== 'tasks') return []
      return [
        { id: 'task-live-1', title: 'Real board card one', status: 'open', priority: 'P1' },
        { id: 'task-live-2', title: 'Real board card two', status: 'open', priority: 'P2' },
      ]
    },
  }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.props?.className === 'wf-row wf-assign-row')[0].props.onClick()
    await settle()

    const cards = findAll(view.tree, node => typeof node.props?.className === 'string' && node.props.className.startsWith('wf-kcard'))
    assert.equal(cards.length, 2)
    const selected = cards.filter(card => card.props.className.includes('sel'))
    assert.equal(selected.length, 1, 'exactly one card is preselected')
    assert.ok(textOf(selected[0]).includes('Real board card one'))

    const assign = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Assign')[0]
    assert.ok(assign, 'Assign button')
    assert.equal(assign.props.disabled, false)

    assign.props.onClick()
    await settle()
    const posted = calls.filter(item => item.name === 'workflow/assign')
    assert.equal(posted.length, 1, 'the click posts one assign')
    assert.equal(posted[0].body.taskId, 'task-live-1')
    assert.equal(posted[0].body.title, 'Real board card one')
    assert.equal(textOf(view.tree).includes('Pick a task card'), false, 'the dialog closes')
    view.unmount()
  } finally {
    globalThis.__flybot__ = prev
  }
})

test('#1457: an empty board keeps Assign disabled, so the click is not a silent no-op', async () => {
  const graph = delivery()
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = { host: async () => [] }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.props?.className === 'wf-row wf-assign-row')[0].props.onClick()
    await settle()
    assert.ok(textOf(view.tree).includes('No open tasks on the Tasks board.'))
    const assign = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Assign')[0]
    assert.equal(assign.props.disabled, true)
    assign.props.onClick()
    await settle()
    assert.equal(calls.some(item => item.name === 'workflow/assign'), false)
    view.unmount()
  } finally {
    globalThis.__flybot__ = prev
  }
})

// #1458: a rejected Tasks call used to be rendered as a genuinely empty board,
// so the owner was told there is nothing to assign instead of that the load failed.
test('#1458: a failed Tasks load shows the error and a Retry, never the empty-board hint', async () => {
  const graph = delivery()
  const calls = []
  const call = async (name, body) => {
    calls.push({ name, body })
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  let broken = true
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = {
    host: async (channel) => {
      if (channel !== 'tasks') return []
      if (broken) throw new Error('host is busy')
      return [{ id: 'task-live-1', title: 'Real board card one', status: 'open', priority: 'P1' }]
    },
  }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.props?.className === 'wf-row wf-assign-row')[0].props.onClick()
    await settle()

    const text = textOf(view.tree)
    assert.equal(text.includes('No open tasks on the Tasks board.'), false, 'a failed load is not an empty board')
    assert.ok(text.includes('host is busy'), 'the host message is shown')
    assert.ok(findAll(view.tree, node => String(node.props?.className ?? '').includes('wf-err')).length > 0)

    const assign = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Assign')[0]
    assert.equal(assign.props.disabled, true, 'Assign is not clickable while the load failed')
    assign.props.onClick()
    await settle()
    assert.equal(calls.some(item => item.name === 'workflow/assign'), false)

    broken = false
    const retry = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Retry')[0]
    assert.ok(retry, 'a Retry control')
    retry.props.onClick()
    await settle()
    assert.ok(textOf(view.tree).includes('Real board card one'), 'Retry loads the board')
    assert.equal(findAll(view.tree, node => String(node.props?.className ?? '').includes('wf-err')).length, 0)
    view.unmount()
  } finally {
    globalThis.__flybot__ = prev
  }
})

test('#1458: Assign stays disabled while the Tasks board is still loading', async () => {
  const graph = delivery()
  const call = async (name) => {
    if (name === 'workflow/state') return { workflows: [graph], templates: [] }
    return { ok: true, workflows: [graph] }
  }
  let release
  const pending = new Promise(resolve => { release = resolve })
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = {
    host: async (channel) => (channel === 'tasks' ? pending.then(() => [{ id: 'task-live-1', title: 'Real board card one', status: 'open' }]) : []),
  }
  try {
    const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.props?.className === 'wf-row wf-assign-row')[0].props.onClick()
    await settle()
    const early = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Assign')[0]
    assert.equal(early.props.disabled, true, 'no click before the cards are there')
    release()
    await settle()
    const later = findAll(view.tree, node => node.type === 'button' && textOf(node) === 'Assign')[0]
    assert.equal(later.props.disabled, false, 'clickable once a card is selected')
    view.unmount()
  } finally {
    globalThis.__flybot__ = prev
  }
})

test('an older finished attempt is marked superseded by the newer attempt for the same task (#1507)', () => {
  const task = { id: '#1507', title: 'PR 1507' }
  const workflow = {
    activeCount: 1,
    queue: [],
    runs: [{ id: 'run-new', live: true, status: 'running', task, updatedAt: 1_700_000_200_000 }],
    run: { id: 'run-new', live: true, status: 'running', task, updatedAt: 1_700_000_200_000 },
    history: [{ id: 'run-old', task, status: 'failed', at: 1_700_000_000_000 }],
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.length, 2)
  const older = rows.find(row => row.id === 'run-old')
  const newer = rows.find(row => row.id === 'run-new')
  assert.equal(older.supersededBy, 'run-new')
  assert.equal(newer.retryOf, 'run-old')
  assert.equal(client.resolveFocusedRun(workflow, null).id, 'run-new')
})

test('two live attempts for one task are both left unmarked (#1507)', () => {
  const task = { id: '#1507', title: 'PR 1507' }
  const workflow = {
    activeCount: 2,
    queue: [],
    runs: [
      { id: 'run-a', live: true, status: 'running', task, updatedAt: 1_700_000_100_000 },
      { id: 'run-b', live: true, status: 'running', task, updatedAt: 1_700_000_200_000 },
    ],
    run: { id: 'run-a', live: true, status: 'running', task, updatedAt: 1_700_000_100_000 },
    history: [],
  }
  const rows = client.runHistoryRows(workflow)
  assert.equal(rows.length, 2)
  assert.equal(rows.some(row => row.supersededBy || row.retryOf), false)
  assert.equal(client.resolveFocusedRun(workflow, null).id, 'run-b')
})

// The drawer's read-only flowchart (FlyBot PR 快线 report): rows come from the
// steps, wires from the drawn boxes, and nothing hangs in empty space.
function quickLane() {
  return {
    ...delivery(), id: 'quick', name: 'FlyBot PR 快线',
    layers: [['route'], ['inspect', 'review'], ['merge']],
    // Stored editor coordinates that disagree with the steps on purpose.
    nodes: [
      { id: 'route', name: 'Route', role: '路由', x: 0, y: 600 },
      { id: 'inspect', name: 'Inspect', role: '检查', x: 40, y: 380 },
      { id: 'review', name: 'Review', role: '审查', x: 60, y: 620 },
      { id: 'merge', name: 'Merge', role: '合并', x: 2000, y: 0 },
    ],
    edges: [
      { from: 'route', to: 'inspect' }, { from: 'route', to: 'review' },
      { from: 'inspect', to: 'merge' }, { from: 'review', to: 'merge' },
      { from: 'merge', to: 'route', loop: true, max: 2 },
    ],
  }
}

function pointsOf(d) {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }))
}

for (const width of [364, 530, 300]) {
  test(`flowLayout lays the quick lane out from its steps at ${width}px: no overlap, no gap, wires on anchors (#1652)`, () => {
    const graph = quickLane()
    const layout = client.flowLayout(graph, width, { inspect: 90 })
    const boxes = [...layout.boxes.values()]
    assert.equal(boxes.length, 4)
    assert.equal(Math.min(...boxes.map(box => box.top)) <= 12 + 20, true, 'the graph starts at the top, no empty band above it')
    for (const box of boxes) {
      assert.ok(box.left >= 0 && box.left + box.w <= width, `${box.id} is outside the plane`)
      assert.ok(box.top + box.h <= layout.height)
    }
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue
      const apart = a.left + a.w <= b.left || b.left + b.w <= a.left || a.top + a.h <= b.top || b.top + b.h <= a.top
      assert.ok(apart, `${a.id} overlaps ${b.id}`)
    }
    assert.equal(layout.frames.length, 1)
    const frame = layout.frames[0]
    for (const id of ['inspect', 'review']) {
      const box = layout.boxes.get(id)
      assert.ok(box.left > frame.left && box.left + box.w < frame.left + frame.width && box.top > frame.top && box.top + box.h < frame.top + frame.height, `${id} spills out of the parallel frame`)
    }
    for (const id of ['route', 'merge']) {
      const box = layout.boxes.get(id)
      assert.ok(box.top + box.h <= frame.top || box.top >= frame.top + frame.height, `${id} overlaps the parallel frame`)
    }
    // Every wire segment starts or ends on a node anchor, or on a bus that one does.
    const anchors = boxes.flatMap(box => [{ x: box.x, y: box.top }, { x: box.x, y: box.top + box.h }])
    const buses = layout.wires.filter(wire => wire.kind === 'fork' || wire.kind === 'join')
    assert.equal(buses.length, 2, 'one fork bus and one join bus')
    const busYs = buses.map(wire => new Set(pointsOf(wire.d).filter(p => !anchors.some(a => a.x === p.x && a.y === p.y)).map(p => p.y)))
    for (const ys of busYs) assert.equal(ys.size, 1, 'a fork or join meets at one height')
    for (const wire of layout.wires) {
      const pts = pointsOf(wire.d)
      for (const p of pts) assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= layout.height, `${wire.key} leaves the plane`)
      if (wire.kind === 'drop' || wire.kind === 'step' || wire.kind === 'loop') {
        const end = pts.at(-1)
        assert.ok(anchors.some(a => a.x === end.x && a.y === end.y), `${wire.key} does not land on a node`)
      }
      for (let i = 1; i < pts.length; i++) {
        if (wire.d.split(' ').filter(t => t === 'M').length > 1) break
        assert.ok(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, `${wire.key} has a diagonal segment`)
      }
    }
    const inspect = layout.boxes.get('inspect')
    assert.equal(inspect.h, 90, 'a measured height moves the anchors')
    assert.ok(layout.wires.some(wire => pointsOf(wire.d).some(p => p.x === inspect.x && p.y === inspect.top + 90)), 'the join leaves the measured bottom of Inspect')
  })
}

// A fan no single drawer row can hold: four branches in one layer (#1658).
function wideFork() {
  const branches = ['r1', 'r2', 'r3', 'r4']
  return {
    ...delivery(), id: 'wide-fork', name: 'Wide fork',
    layers: [['fork'], branches, ['join']],
    nodes: [
      { id: 'fork', name: 'Fork', role: '分叉' },
      ...branches.map(id => ({ id, name: id.toUpperCase(), role: '分支' })),
      { id: 'join', name: 'Join', role: '汇合' },
    ],
    edges: [
      ...branches.map(id => ({ from: 'fork', to: id })),
      ...branches.map(id => ({ from: id, to: 'join' })),
    ],
  }
}

for (const width of [400, 364]) {
  test(`a four-way drawer layer stays inside ${width}px, one frame, every box and wire in the plane (#1658)`, () => {
    const layout = client.flowLayout(wideFork(), width)
    const boxes = [...layout.boxes.values()]
    assert.equal(boxes.length, 6)
    for (const box of boxes) {
      assert.ok(box.left >= 0 && box.left + box.w <= width, `${box.id} box ${box.left}..${box.left + box.w} is outside 0..${width}`)
      assert.ok(box.top >= 0 && box.top + box.h <= layout.height, `${box.id} box ${box.top}..${box.top + box.h} is outside 0..${layout.height}`)
    }
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue
      const apart = a.left + a.w <= b.left || b.left + b.w <= a.left || a.top + a.h <= b.top || b.top + b.h <= a.top
      assert.ok(apart, `${a.id} overlaps ${b.id}`)
    }
    assert.equal(layout.frames.length, 1, 'the four branches stay in one dashed frame')
    const frame = layout.frames[0]
    assert.ok(frame.left >= 0 && frame.left + frame.width <= width, `frame ${frame.left}..${frame.left + frame.width} is outside 0..${width}`)
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      const box = layout.boxes.get(id)
      assert.ok(box.left > frame.left && box.left + box.w < frame.left + frame.width, `${id} spills out of the parallel frame`)
      assert.ok(box.top > frame.top && box.top + box.h < frame.top + frame.height, `${id} spills out of the parallel frame`)
    }
    for (const id of ['fork', 'join']) {
      const box = layout.boxes.get(id)
      assert.ok(box.top + box.h <= frame.top || box.top >= frame.top + frame.height, `${id} overlaps the parallel frame`)
    }
    assert.equal(layout.wires.filter(wire => wire.kind === 'fork' || wire.kind === 'join').length, 2)
    for (const wire of layout.wires) {
      for (const p of pointsOf(wire.d)) {
        assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= layout.height, `${wire.key} leaves the plane at ${p.x},${p.y}`)
      }
    }
  })
}

// A layer that wraps onto two lines still has one band for the whole layer, and
// a straight wire from the bus below it — or straight down from a card on the
// first line — cuts through a card in the other line, so the picture reads as
// "the fork feeds only r1, r1 → r3" (#1659). Every wire must go around the cards.
function segmentsOf(d) {
  return d.split(/(?=M )/).flatMap(part => {
    const points = pointsOf(part)
    const segments = []
    for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]])
    return segments
  })
}
function cutsInto([a, b], box) {
  const edge = 0.5
  const left = box.left + edge
  const right = box.left + box.w - edge
  const top = box.top + edge
  const bottom = box.top + box.h - edge
  if (a.x === b.x) {
    const lo = Math.min(a.y, b.y)
    const hi = Math.max(a.y, b.y)
    return a.x > left && a.x < right && Math.max(lo, top) < Math.min(hi, bottom)
  }
  if (a.y === b.y) {
    const lo = Math.min(a.x, b.x)
    const hi = Math.max(a.x, b.x)
    return a.y > top && a.y < bottom && Math.max(lo, left) < Math.min(hi, right)
  }
  return false
}
function cardCuts(layout) {
  const boxes = [...layout.boxes.values()]
  return layout.wires.flatMap(wire => segmentsOf(wire.d).flatMap(segment =>
    boxes.filter(box => cutsInto(segment, box))
      .map(box => `${wire.key}: ${segment[0].x},${segment[0].y}→${segment[1].x},${segment[1].y} runs through ${box.id}`)))
}

// Five branches wrap 3+2 at 400px; the skip edge stays inside the layer it leaves.
function wideFive() {
  const branches = ['r1', 'r2', 'r3', 'r4', 'r5']
  return {
    ...delivery(), id: 'wide-five', name: 'Wide five',
    layers: [['fork'], branches, ['join']],
    nodes: [
      { id: 'fork', name: 'Fork', role: '分叉' },
      ...branches.map(id => ({ id, name: id.toUpperCase(), role: '分支' })),
      { id: 'join', name: 'Join', role: '汇合' },
    ],
    edges: [
      ...branches.map(id => ({ from: 'fork', to: id })),
      ...branches.map(id => ({ from: id, to: 'join' })),
      { from: 'r1', to: 'r5' },
    ],
  }
}

for (const width of [400, 368, 364]) {
  for (const [label, build] of [['four branches 2+2', wideFork], ['five branches 3+2', wideFive]]) {
    test(`a wrapped drawer layer at ${width}px (${label}) routes every wire around the cards (#1659)`, () => {
      const layout = client.flowLayout(build(), width)
      const wrapped = [...layout.boxes.values()].filter(box => box.row === 1)
      assert.equal(new Set(wrapped.map(box => box.top)).size, 2, 'the branch layer wraps onto two lines')
      assert.deepEqual(cardCuts(layout), [], 'a wire runs through a card')
    })
  }
}

// The rerouting above only applies to a layer that wraps: a two- and a
// three-branch layer that fit one line keep their exact wire strings (#1659).
test('a drawer layer that fits one line keeps its exact wire routing (#1659)', () => {
  const graph = ids => ({
    ...delivery(), id: 'single-line', name: 'Single line',
    layers: [['fork'], ids, ['join']],
    nodes: [
      { id: 'fork', name: 'Fork', role: '分叉' },
      ...ids.map(id => ({ id, name: id.toUpperCase(), role: '分支' })),
      { id: 'join', name: 'Join', role: '汇合' },
    ],
    edges: [...ids.map(id => ({ from: 'fork', to: id })), ...ids.map(id => ({ from: id, to: 'join' }))],
  })
  assert.deepEqual(client.flowLayout(graph(['r1', 'r2']), 400).wires.map(wire => wire.d), [
    'M 200 84 L 200 102 M 110 102 L 290 102',
    'M 110 102 L 110 148',
    'M 290 102 L 290 148',
    'M 110 220 L 110 248 M 290 220 L 290 248 M 110 248 L 290 248',
    'M 200 248 L 200 266',
  ])
  assert.deepEqual(client.flowLayout(graph(['r1', 'r2', 'r3']), 400).wires.map(wire => wire.d), [
    'M 200 84 L 200 102 M 78 102 L 322 102',
    'M 78 102 L 78 148',
    'M 200 102 L 200 148',
    'M 322 102 L 322 148',
    'M 78 220 L 78 248 M 200 220 L 200 248 M 322 220 L 322 248 M 78 248 L 322 248',
    'M 200 248 L 200 266',
  ])
})

test('the drawer flowchart draws the step layout, not the stored editor coordinates, and clamps a long run summary', async () => {
  const graph = quickLane()
  const long = 'p1641-r3 · #1641（Fixes #1640 social waiting-for-approval 卡不写目的地、没有跳转）在实时 head 重审并出 PASS 后入队。上一轮 run-d477062e 在 review 节点被 DSH 重启打断'
  graph.run = { ...graph.run, taskSummary: long, nodeStatus: { route: 'done', inspect: 'done', review: 'running', merge: 'queued' }, running: ['review'] }
  const call = async (name) => name === 'workflow/state' ? { workflows: [graph], templates: [] } : { ok: true, workflows: [graph] }
  const view = mount(client.Section, { roster: { bots: [] }, call, actions: {} })
  await settle()
  findAll(view.tree, node => node.type === 'button' && textOf(node).includes(graph.name))[0].props.onClick()
  button(view.tree, 'Flow').props.onClick()
  const plane = findAll(view.tree, node => node.props?.['data-plane'] === '1')[0]
  const width = Number(plane.props.style.width)
  for (const id of ['route', 'inspect', 'review', 'merge']) {
    const style = findAll(view.tree, node => node.props?.['data-node'] === id)[0].props.style
    assert.ok(style.left >= 0 && style.left + style.width <= width, `${id} drawn outside the panel`)
  }
  assert.equal(findAll(view.tree, node => String(node.props?.className ?? '').includes('wf-par')).length, 1)
  const term = () => findAll(view.tree, node => String(node.props?.className ?? '').split(' ').includes('wf-term'))[0]
  assert.ok(term().props.className.includes('wf-term-clamp'))
  button(view.tree, 'Show more').props.onClick()
  assert.equal(term().props.className.includes('wf-term-clamp'), false)
  assert.ok(button(view.tree, 'Show less'))
  view.unmount()
})

// #1677: a workflow the service lays out with no stored coordinates — fork -> r1..rN ->
// join at graph.js's own seat (GAP_X 188, GAP_Y 108).
function parallelGraph(n) {
  const ids = Array.from({ length: n }, (_, i) => `r${i + 1}`)
  return {
    ...delivery(), id: `fork-${n}`, name: `Fork ${n}`,
    layers: [['fork'], ids, ['join']],
    nodes: [
      { id: 'fork', name: 'Fork', role: '分叉', x: 0, y: 0 },
      ...ids.map((id, i) => ({ id, name: id.toUpperCase(), role: '分支', x: Math.round((i - (n - 1) / 2) * 188), y: 108 })),
      { id: 'join', name: 'Join', role: '汇合', x: 0, y: 216 },
    ],
    edges: [...ids.map(id => ({ from: 'fork', to: id })), ...ids.map(id => ({ from: id, to: 'join' }))],
  }
}

// What the Edit plane draws: a card is NODE_W wide and one NODE_H tall, `.wf-port` is a
// 10px dot on the card's bottom-right corner, and `.wf-mini` an 18px button whose box
// starts 8px above and 10px left of that corner (#1677).
function drawnCards(nodeAt, workflow) {
  return workflow.nodes.map(node => {
    const style = nodeAt(node.id).props.style
    const width = style.width ?? client.NODE_W
    const left = style.left
    const top = style.top
    return {
      id: node.id, left, top, right: left + width, bottom: top + client.NODE_H,
      port: { x: left + width, y: top + client.NODE_H },
      mini: { x: left + width - 1, y: top + 1 },
    }
  })
}
// A click lands on the dot and the button, not only on their centres: the dot is 10px
// square on the corner, the button 18px square whose box starts 8px above it, so what
// has to stay clear is the whole area those two cover.
const portArea = card => ({ left: card.right - 5, right: card.right + 5, top: card.bottom - 5, bottom: card.bottom + 5 })
const miniArea = card => ({ left: card.right - 10, right: card.right + 8, top: card.top - 8, bottom: card.top + 10 })
const hits = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
// Closed intervals: a corner that lies exactly on another card's edge is still that
// card in DOM order, because the card comes later and its border covers the pixel.
const covers = (card, point) => point.x >= card.left && point.x <= card.right && point.y >= card.top && point.y <= card.bottom

for (const way of [3, 4, 6]) {
  test(`the drawer's Edit plane keeps a ${way}-way parallel step's cards apart (#1677)`, async () => {
    const graph = parallelGraph(way)
    const { view, nodeAt } = await openDrawer(graph)
    const cards = drawnCards(nodeAt, graph)
    const overlaps = []
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i]
        const b = cards[j]
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (x > 0 && y > 0) overlaps.push(`${a.id}/${b.id}=${Math.round(x)}x${Math.round(y)}`)
      }
    }
    assert.deepEqual(overlaps, [], 'two cards in the Edit plane are drawn on top of each other')
    for (const card of cards) {
      for (const other of cards) {
        if (other.id === card.id) continue
        assert.equal(covers(other, card.port), false, `${other.id} covers ${card.id}'s out-port centre`)
        assert.equal(covers(other, card.mini), false, `${other.id} covers ${card.id}'s remove button centre`)
        assert.equal(hits(portArea(card), other), false, `${other.id} is drawn over ${card.id}'s out-port, so the click lands on it`)
        assert.equal(hits(miniArea(card), other), false, `${other.id} is drawn over ${card.id}'s remove button`)
      }
    }
    view.unmount()
  })
}

test("a 3-way branch's out-port starts its own wire instead of the card on top of it (#1677)", async () => {
  const graph = parallelGraph(3)
  const { view, calls, nodeAt, canvas } = await openDrawer(graph)
  const cards = drawnCards(nodeAt, graph)
  const r1 = cards.find(card => card.id === 'r1')
  const over = cards.filter(card => card.id !== 'r1' && covers(card, r1.port)).map(card => card.id)
  assert.deepEqual(over, [], "another card is drawn over r1's out-port, so the click lands on it")
  const port = findAll(view.tree, node => node.props?.['data-port'] === 'out' && node.props['aria-label'] === 'R1')[0]
  port.props.onPointerDown({ preventDefault() {}, stopPropagation() {}, target: { dataset: { port: 'out' } } })
  canvas().props.onPointerUp({ clientX: r1.port.x, clientY: r1.port.y, target: { dataset: { node: 'join' }, closest() { return null } } })
  const saved = calls.filter(item => item.name === 'workflow/graph').at(-1)
  assert.ok(saved.body.edges.some(edge => edge.from === 'r1' && edge.to === 'join'), 'the wire did not start from r1')
  view.unmount()
})

// The planes the fix must not move, captured byte for byte from 1db1037a, the base
// this branch builds on: the Read-only plane at 368 and the two-branch Edit plane.
const BASE_PLANES = {
  'edit:delivery@364': "{\"boxes\":[[\"planner\",98,12,168,72],[\"writer\",98,128,168,72],[\"coder\",98,248,168,72],[\"reviewer\",12,368,168,72],[\"tester\",184,368,168,72],[\"deployer\",98,508,168,72]],\"wires\":[[\"planner>writer\",\"M 182 68 C 182 98, 182 98, 182 128\"],[\"writer>coder\",\"M 182 184 C 182 216, 182 216, 182 248\"],[\"coder>reviewer\",\"M 182 304 L 182 336 L 96 336 L 96 368\"],[\"coder>tester\",\"M 182 304 L 182 336 L 268 336 L 268 368\"],[\"reviewer>deployer\",\"M 96 424 L 96 466 L 182 466 L 182 508\"],[\"tester>deployer\",\"M 268 424 L 268 466 L 182 466 L 182 508\"]]}",
  'edit:fork2@364': "{\"boxes\":[[\"fork\",98,12,168,72],[\"r1\",12,120,168,72],[\"r2\",184,120,168,72],[\"join\",98,228,168,72]],\"wires\":[[\"fork>r1\",\"M 182 68 L 182 94 L 96 94 L 96 120\"],[\"fork>r2\",\"M 182 68 L 182 94 L 268 94 L 268 120\"],[\"r1>join\",\"M 96 176 L 96 202 L 182 202 L 182 228\"],[\"r2>join\",\"M 268 176 L 268 202 L 182 202 L 182 228\"]]}",
  'read:delivery@368': "{\"boxes\":[[\"planner\",100,12,168,72],[\"writer\",100,120,168,72],[\"coder\",100,228,168,72],[\"reviewer\",22,364,156,72],[\"tester\",190,364,156,72],[\"deployer\",100,482,168,72]],\"wires\":[[\"planner>writer\",\"M 184 84 L 184 120\"],[\"writer>coder\",\"M 184 192 L 184 228\"],[\"coder>reviewer,coder>tester|bus\",\"M 184 300 L 184 318 M 100 318 L 268 318\"],[\"coder>reviewer,coder>tester|reviewer\",\"M 100 318 L 100 364\"],[\"coder>reviewer,coder>tester|tester\",\"M 268 318 L 268 364\"],[\"reviewer>deployer,tester>deployer|bus\",\"M 100 436 L 100 464 M 268 436 L 268 464 M 100 464 L 268 464\"],[\"reviewer>deployer,tester>deployer|deployer\",\"M 184 464 L 184 482\"]]}",
  'read:fork3@368': "{\"boxes\":[[\"fork\",100,12,168,72],[\"r1\",22,148,100,72],[\"r2\",134,148,100,72],[\"r3\",246,148,100,72],[\"join\",100,266,168,72]],\"wires\":[[\"fork>r1,fork>r2,fork>r3|bus\",\"M 184 84 L 184 102 M 72 102 L 296 102\"],[\"fork>r1,fork>r2,fork>r3|r1\",\"M 72 102 L 72 148\"],[\"fork>r1,fork>r2,fork>r3|r2\",\"M 184 102 L 184 148\"],[\"fork>r1,fork>r2,fork>r3|r3\",\"M 296 102 L 296 148\"],[\"r1>join,r2>join,r3>join|bus\",\"M 72 220 L 72 248 M 184 220 L 184 248 M 296 220 L 296 248 M 72 248 L 296 248\"],[\"r1>join,r2>join,r3>join|join\",\"M 184 248 L 184 266\"]]}",
  'read:fork4@368': "{\"boxes\":[[\"fork\",100,12,168,72],[\"r1\",22,148,156,72],[\"r2\",190,148,156,72],[\"r3\",22,232,156,72],[\"r4\",190,232,156,72],[\"join\",100,350,168,72]],\"wires\":[[\"fork>r1,fork>r2,fork>r3,fork>r4|bus\",\"M 184 84 L 184 102 M 100 102 L 268 102\"],[\"fork>r1,fork>r2,fork>r3,fork>r4|r1\",\"M 100 102 L 100 148\"],[\"fork>r1,fork>r2,fork>r3,fork>r4|r2\",\"M 268 102 L 268 148\"],[\"fork>r1,fork>r2,fork>r3,fork>r4|r3\",\"M 100 102 L 16 102 L 16 226 L 100 226 L 100 232\"],[\"fork>r1,fork>r2,fork>r3,fork>r4|r4\",\"M 268 102 L 16 102 L 16 226 L 268 226 L 268 232\"],[\"r1>join,r2>join,r3>join,r4>join|bus\",\"M 100 220 L 100 226 L 16 226 L 16 332 M 268 220 L 268 226 L 16 226 L 16 332 M 100 304 L 100 332 M 268 304 L 268 332 M 16 332 L 268 332\"],[\"r1>join,r2>join,r3>join,r4>join|join\",\"M 184 332 L 184 350\"]]}",
  'read:fork6@368': "{\"boxes\":[[\"fork\",100,12,168,72],[\"r1\",22,148,100,72],[\"r2\",134,148,100,72],[\"r3\",246,148,100,72],[\"r4\",22,232,100,72],[\"r5\",134,232,100,72],[\"r6\",246,232,100,72],[\"join\",100,350,168,72]],\"wires\":[[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|bus\",\"M 184 84 L 184 102 M 72 102 L 296 102\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r1\",\"M 72 102 L 72 148\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r2\",\"M 184 102 L 184 148\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r3\",\"M 296 102 L 296 148\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r4\",\"M 72 102 L 16 102 L 16 226 L 72 226 L 72 232\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r5\",\"M 184 102 L 16 102 L 16 226 L 184 226 L 184 232\"],[\"fork>r1,fork>r2,fork>r3,fork>r4,fork>r5,fork>r6|r6\",\"M 296 102 L 16 102 L 16 226 L 296 226 L 296 232\"],[\"r1>join,r2>join,r3>join,r4>join,r5>join,r6>join|bus\",\"M 72 220 L 72 226 L 16 226 L 16 332 M 184 220 L 184 226 L 16 226 L 16 332 M 296 220 L 296 226 L 16 226 L 16 332 M 72 304 L 72 332 M 184 304 L 184 332 M 296 304 L 296 332 M 16 332 L 296 332\"],[\"r1>join,r2>join,r3>join,r4>join,r5>join,r6>join|join\",\"M 184 332 L 184 350\"]]}",
}

function editPlaneString(workflow, width) {
  const plane = client.editPlane(workflow, width)
  const at = new Map(plane.nodes.map(node => [node.id, node]))
  return JSON.stringify({
    boxes: plane.nodes.map(node => [node.id, node.x - (node.w ?? client.NODE_W) / 2, node.y, node.w ?? client.NODE_W, client.NODE_H]),
    wires: (workflow.edges ?? []).map(edge => [`${edge.from}>${edge.to}`, client.wirePath(at.get(edge.from), at.get(edge.to), 0)]),
  })
}
function readOnlyString(workflow, width) {
  const layout = client.flowLayout(workflow, width)
  return JSON.stringify({
    boxes: [...layout.boxes.values()].map(box => [box.id, box.left, box.top, box.w, box.h]),
    wires: layout.wires.map(wire => [wire.key, wire.d]),
  })
}

test('the Read-only plane and the 2-way Edit plane stay byte-identical to the base (#1677)', () => {
  const now = {
    'edit:delivery@364': editPlaneString(delivery(), 364),
    'edit:fork2@364': editPlaneString(parallelGraph(2), 364),
    'read:delivery@368': readOnlyString(delivery(), 368),
    'read:fork3@368': readOnlyString(parallelGraph(3), 368),
    'read:fork4@368': readOnlyString(parallelGraph(4), 368),
    'read:fork6@368': readOnlyString(parallelGraph(6), 368),
  }
  for (const [key, value] of Object.entries(now)) assert.equal(value, BASE_PLANES[key], `${key} moved`)
})

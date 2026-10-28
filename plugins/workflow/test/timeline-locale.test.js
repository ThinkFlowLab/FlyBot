// #1489: the stage timeline speaks the shell's language, and its clock is read
// from each line's own stamp instead of a literal 「刚刚」 written once at emit
// time. The renderer below is the one client.test.js mounts; it is copied here
// so this file loads alone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { linesFor } from '../src/narrate.js'
import { DEFAULT_STEP_TIMEOUT_MINUTES, STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, deliveryWorkflow } from '../src/template.js'

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

globalThis.document = {
  listeners: [],
  getElementById() { return null },
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild() {} },
  querySelector() { return null },
  addEventListener(name, fn, capture) { this.listeners.push({ name, fn, capture }) },
  removeEventListener(name, fn) { this.listeners = this.listeners.filter(item => item.fn !== fn) },
}

function loadClient() {
  const modules = new Map()
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => modules.set(id, factory(name => (name === 'react' ? react : {}))),
    },
  }
  new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  return modules.get('@flybot/workflow')
}

const client = loadClient()
const T0 = Date.now()

async function settle() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
}

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

// The host's t() as @deepseek-ai/dsh-client-locale implements it: a key it does
// not know comes back as itself with params filled, a known key comes from the
// dictionary. Only the keys FlyBot core already ships are translated here.
function hostFor(lang) {
  const dict = lang === 'zh'
    ? {
        Tasks: '任务',
        'just now': '刚刚',
        '{n} min': '{n} 分钟',
        '{n} h': '{n} 小时',
        '{n} d': '{n} 天',
        'In progress': '进行中',
      }
    : {}
  return (key, params) => fill(dict[key] ?? key, params)
}

function lane(messages) {
  return {
    id: 'delivery',
    name: 'Delivery lane',
    description: '',
    chain: 'Planner → Writer',
    preview: 'Waiting for a task',
    activeCount: 0,
    queueDepth: 0,
    trigger: 'manual',
    layers: [['planner'], ['writer']],
    nodes: [
      { id: 'planner', name: 'Planner', role: 'plan', x: 200, y: 24 },
      { id: 'writer', name: 'Writer', role: 'write', x: 200, y: 140 },
    ],
    edges: [{ from: 'planner', to: 'writer' }],
    messages,
  }
}

async function stageTree(messages, lang, graph = lane(messages)) {
  const prev = globalThis.__flybot__
  globalThis.__flybot__ = { ...prev, t: hostFor(lang) }
  try {
    const call = async (name) => (name === 'workflow/state'
      ? { workflows: [graph], templates: [] }
      : { ok: true, workflows: [graph] })
    // The stage drops a bot line whose sender the roster does not know (#?):
    // register the run's own senders so both sides of a real timeline render.
    const byId = Object.fromEntries([...new Set(messages.filter(line => line.kind === 'bot').map(line => line.botId))]
      .map(id => [id, { id, name: id }]))
    const view = mount(client.Section, { roster: { bots: [], byId }, call, actions: {} })
    await settle()
    findAll(view.tree, node => node.type === 'button' && textOf(node).includes(graph.name))[0].props.onClick()
    await settle()
    const tree = view.tree
    view.unmount()
    return tree
  } finally {
    globalThis.__flybot__ = prev
  }
}

const stageText = async (messages, lang, graph) => textOf(await stageTree(messages, lang, graph))

// Only the timeline itself: the sidebar and the run strip show workflow data,
// which is not copy this change localizes.
const stageBubbles = async (messages, lang, graph) => {
  const tree = await stageTree(messages, lang, graph)
  return findAll(tree, node => typeof node.props?.className === 'string' && /(^|\s)wf-(sys|bub|ts)(\s|$)/.test(node.props.className))
    .map(textOf).join('\n')
}

// What service.js pushes after #1489: a key + params for the renderer, the
// Chinese text kept only as the fallback for rows written before the key.
const EVENTS = [
  { id: 'e1', kind: 'system', key: 'Task assigned · {task} → {workflow}', params: { task: '#1489 · Timeline copy', workflow: 'Delivery lane' }, text: '任务已分配 · #1489 · Timeline copy → Delivery lane' },
  { id: 'e2', kind: 'system', key: 'Queued · {task} ({ahead} ahead)', params: { task: '#1489 · Timeline copy', ahead: 2 }, text: '排队 · #1489 · Timeline copy（前面 2 个）' },
  { id: 'e3', kind: 'system', key: 'Workflow "{name}" created · members {members}', params: { name: 'Delivery lane', members: 'Planner, Writer' }, text: 'Workflow「Delivery lane」已创建 · 成员 Planner、Writer' },
  { id: 'e4', kind: 'system', key: '⏸ Paused · {task}', params: { task: '#1489 · Timeline copy' }, text: '⏸ 已暂停 · #1489 · Timeline copy' },
  { id: 'e5', kind: 'system', key: '▶ Resumed · {task}', params: { task: '#1489 · Timeline copy' }, text: '▶ 已继续 · #1489 · Timeline copy' },
  { id: 'e6', kind: 'system', tone: 'bad', key: '■ Stopped · {task}', params: { task: '#1489 · Timeline copy' }, text: '■ 已停止 · #1489 · Timeline copy' },
  { id: 'e7', kind: 'system', tone: 'bad', key: '{node} cannot start: missing input {missing}.', params: { node: 'Writer', missing: 'brief' }, text: 'Writer 不能开始：缺少输入 brief。' },
  { id: 'e8', kind: 'system', tone: 'bad', key: '{node} did not take this step ({code}); retrying in {seconds}s ({tries}/{total}).', params: { node: 'Writer', code: 'deny', seconds: 1, tries: 1, total: 2 }, text: 'Writer 没有接到这一步（deny），1 秒后重试（1/2）。' },
  { id: 'e9', kind: 'system', tone: 'bad', key: '{node} did not take this step ({code}); {total} retries did not land, the run failed.', params: { node: 'Writer', code: 'deny', total: 2 }, text: 'Writer 没有接到这一步（deny），重试 2 次仍未落地，run 已标记失败。' },
  { id: 'e10', kind: 'system', tone: 'bad', key: '{node} timed out: no reply for {minutes} minutes, the run was marked failed.', params: { node: 'Writer', minutes: 10 }, text: 'Writer 超时：10 分钟没有回包，run 已标记失败。' },
]

const CHINESE_FRAMES = ['任务已分配', '排队 ·', '已创建 · 成员', '已暂停', '已继续', '已停止', '不能开始', '没有接到这一步', '超时']

test('the English shell renders the timeline event lines in English', async () => {
  const text = await stageText(EVENTS, 'en')
  assert.ok(text.includes('Task assigned · #1489 · Timeline copy → Delivery lane'), `assigned line missing from: ${text}`)
  assert.ok(text.includes('Queued · #1489 · Timeline copy (2 ahead)'))
  assert.ok(text.includes('Workflow "Delivery lane" created · members Planner, Writer'))
  assert.ok(text.includes('⏸ Paused · #1489 · Timeline copy'))
  assert.ok(text.includes('▶ Resumed · #1489 · Timeline copy'))
  assert.ok(text.includes('■ Stopped · #1489 · Timeline copy'))
  assert.ok(text.includes('Writer cannot start: missing input brief.'))
  assert.ok(text.includes('Writer did not take this step (deny); retrying in 1s (1/2).'))
  assert.ok(text.includes('Writer did not take this step (deny); 2 retries did not land, the run failed.'))
  assert.ok(text.includes('Writer timed out: no reply for 10 minutes, the run was marked failed.'))
  for (const frame of CHINESE_FRAMES) assert.equal(text.includes(frame), false, `the English shell still shows the Chinese frame ${frame}`)
})

test('the Chinese shell renders the same timeline event lines in Chinese', async () => {
  const text = await stageText(EVENTS, 'zh')
  assert.ok(text.includes('任务已分配 · #1489 · Timeline copy → Delivery lane'), `assigned line missing from: ${text}`)
  assert.ok(text.includes('排队 · #1489 · Timeline copy（前面 2 个）'))
  assert.ok(text.includes('Workflow「Delivery lane」已创建 · 成员 Planner, Writer'))
  assert.ok(text.includes('⏸ 已暂停 · #1489 · Timeline copy'))
  assert.ok(text.includes('▶ 已继续 · #1489 · Timeline copy'))
  assert.ok(text.includes('■ 已停止 · #1489 · Timeline copy'))
  assert.ok(text.includes('Writer 不能开始：缺少输入 brief。'))
  assert.ok(text.includes('Writer 没有接到这一步（deny），1 秒后重试（1/2）。'))
  assert.ok(text.includes('Writer 没有接到这一步（deny），重试 2 次仍未落地，run 已标记失败。'))
  assert.ok(text.includes('Writer 超时：10 分钟没有回包，run 已标记失败。'))
  assert.equal(text.includes('Task assigned'), false, 'the Chinese shell still shows the English frame')
  assert.equal(text.includes('cannot start'), false, 'the Chinese shell still shows the English failure frame')
})

test('a timestamp is read from its own at, so it ages instead of freezing at 刚刚', async () => {
  const rows = [
    { id: 't1', kind: 'time', at: T0 - 2 * 3_600_000, text: '刚刚' },
    { id: 't2', kind: 'time', at: T0 - 3 * 86_400_000 },
    { id: 't3', kind: 'time', at: T0 - 45 * 86_400_000 },
    { id: 't4', kind: 'time', at: T0 - 1_000 },
  ]
  const text = await stageText(rows, 'en')
  assert.ok(text.includes('2 h'), `two hours should read "2 h": ${text}`)
  assert.ok(text.includes('3 d'), `three days should read "3 d": ${text}`)
  assert.ok(text.includes('just now'))
  assert.equal(text.includes('刚刚'), false, 'a stamped row must not paint the stored literal')
  assert.match(text, /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/, 'older than 30 days should show a date')
})

test('the Chinese shell ages the same timestamps in Chinese', async () => {
  const rows = [
    { id: 't1', kind: 'time', at: T0 - 2 * 3_600_000 },
    { id: 't2', kind: 'time', at: T0 - 3 * 86_400_000 },
    { id: 't3', kind: 'time', at: T0 - 1_000 },
  ]
  const text = await stageText(rows, 'zh')
  assert.ok(text.includes('2 小时'), `two hours should read "2 小时": ${text}`)
  assert.ok(text.includes('3 天'))
  assert.ok(text.includes('刚刚'))
  assert.equal(text.includes(' just now'), false)
})

test('a row without at, or without key, still renders the stored text', async () => {
  const legacy = await stageText([
    { id: 't1', kind: 'time', text: '刚刚' },
    { id: 's1', kind: 'system', text: '任务已分配 · #1489 · Timeline copy → Delivery lane' },
  ], 'en')
  assert.ok(legacy.includes('刚刚'), 'a time row with no at keeps its stored text')
  assert.ok(legacy.includes('任务已分配 · #1489 · Timeline copy → Delivery lane'), 'a system row with no key keeps its stored text')
})

test('the producer pushes a key and params, and keeps the Chinese text as the fallback', async () => {
  const svc = createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => [] })
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  const rowOf = state => state.workflows.find(item => item.id === DELIVERY_ID)
  const lineWith = (state, key) => rowOf(state).messages.filter(line => line.key === key).at(-1)
  const opened = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1489', title: 'Timeline copy' })
  const row = rowOf(opened)
  const stamp = row.messages[0]
  const assigned = row.messages[1]
  assert.equal(stamp.kind, 'time')
  assert.equal(stamp.text, undefined, 'a time row no longer carries the literal 刚刚')
  assert.equal(stamp.at, 1_700_000_000_000, 'the push stamps the row')
  assert.equal(assigned.key, 'Task assigned · {task} → {workflow}')
  assert.deepEqual(assigned.params, { task: '#1489 · Timeline copy', workflow: row.name })
  assert.match(assigned.text, /^任务已分配 · /, 'the Chinese text stays as the fallback')

  const second = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1490', title: 'Queue me' })
  const queued = rowOf(second).messages.at(-1)
  assert.equal(queued.key, 'Queued · {task} ({ahead} ahead)')
  assert.deepEqual(queued.params, { task: '#1490 · Queue me', ahead: 0 })
  assert.match(queued.text, /^排队 · /)

  const paused = svc.pause({ workflowId: DELIVERY_ID })
  const pauseLine = lineWith(paused, '⏸ Paused · {task}')
  assert.ok(pauseLine, 'the pause line must carry its key')
  assert.match(pauseLine.text, /^⏸ 已暂停 · /)

  const resumed = await svc.resume({ workflowId: DELIVERY_ID })
  assert.ok(lineWith(resumed, '▶ Resumed · {task}'), 'the resume line must carry its key')

  const run = rowOf(resumed).runs.find(item => item.status === 'running')
  assert.ok(run, 'a live run to stop')
  const stopped = await svc.reset({ workflowId: DELIVERY_ID, runId: run.id })
  const stopLine = lineWith(stopped, '■ Stopped · {task}')
  assert.ok(stopLine, 'the stop line must carry its key')
  assert.match(stopLine.text, /^■ 已停止 · /)

  const created = svc.create({ name: 'Fresh lane', nodes: [{ id: 'a', name: 'Planner' }], layers: [['a']] })
  const fresh = created.workflows.find(item => item.name === 'Fresh lane')
  const createdLine = fresh.messages.at(-1)
  assert.equal(createdLine.key, 'Workflow "{name}" created · members {members}')
  assert.deepEqual(createdLine.params, { name: 'Fresh lane', members: 'Planner' })
  assert.match(createdLine.text, /^Workflow「Fresh lane」已创建 · 成员 /)
})

// The whole frame set the stage timeline emits — narrate.js, not just the service
// lines above — around a real run.
const REAL = (() => {
  const svc = createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => [] })
  const rowOf = state => state.workflows.find(item => item.id === DELIVERY_ID)
  svc.assign({ workflowId: DELIVERY_ID, taskId: '#1489', title: 'Timeline copy' })
  for (const nodeId of ['planner', 'writer', 'coder', 'tester', 'reviewer', 'deployer']) {
    svc.advance({ workflowId: DELIVERY_ID, nodeId, outcome: 'done' })
  }
  svc.assign({ workflowId: DELIVERY_ID, taskId: '#1490', title: 'Reset me' })
  svc.reset({ workflowId: DELIVERY_ID })
  return rowOf(svc.state()).messages
})()

const NARRATE_FRAMES = ['开始 ·', '并行分支开始', '并行分支汇合', '✓ 完成', '↺ 已重置运行', '已停止', '任务已分配', '排队 ·', '失败', '重试']

test('the English shell renders a real run timeline — every narrate.js frame included — in English', async () => {
  const text = await stageBubbles(REAL, 'en')
  assert.ok(text.includes('Task assigned · #1489 · Timeline copy'), `assigned line missing from: ${text}`)
  assert.ok(text.includes('Started · #1489 · Timeline copy · Planner'), `start frame missing from: ${text}`)
  assert.ok(text.includes('∥ Parallel branches started: Reviewer ‖ Tester'), `parallel frame missing from: ${text}`)
  assert.ok(text.includes('⇢ Parallel branches joined (join) → Deployer'), `join frame missing from: ${text}`)
  assert.ok(text.includes('✓ Done · #1489 · Timeline copy · 6 steps'), `done frame missing from: ${text}`)
  assert.ok(text.includes('↺ Run reset'), `reset frame missing from: ${text}`)
  assert.ok(text.includes('Planner finished this step.'), `the bot fallback line missing from: ${text}`)
  for (const frame of NARRATE_FRAMES) assert.equal(text.includes(frame), false, `the English shell still shows the Chinese frame ${frame}`)
})

test('the Chinese shell renders the same real run timeline in Chinese', async () => {
  const text = await stageBubbles(REAL, 'zh')
  assert.ok(text.includes('开始 · #1489 · Timeline copy · Planner'), `start frame missing from: ${text}`)
  assert.ok(text.includes('∥ 并行分支开始：Reviewer ‖ Tester'), `parallel frame missing from: ${text}`)
  assert.ok(text.includes('⇢ 并行分支汇合（join）→ Deployer'), `join frame missing from: ${text}`)
  assert.ok(text.includes('✓ 完成 · #1489 · Timeline copy · 6 步'), `done frame missing from: ${text}`)
  assert.ok(text.includes('↺ 已重置运行'), `reset frame missing from: ${text}`)
  assert.ok(text.includes('Planner 完成了这一步。'), `the bot fallback line missing from: ${text}`)
  for (const frame of ['Started ·', 'Parallel branches started', 'Parallel branches joined', '✓ Done ·', '↺ Run reset']) {
    assert.equal(text.includes(frame), false, `the Chinese shell still shows the English frame ${frame}`)
  }
})

// The demo timeline (a run that is not live) is written by linesFor() only, so
// its canned copy and its recovered/retry frames are checked on the producer.
test('a non-live run frame carries an English key and keeps the Chinese text', async () => {
  const workflow = deliveryWorkflow()
  const task = { id: '#1489', title: 'Timeline copy' }
  const rows = [
    ...linesFor(workflow, task, { type: 'start', started: ['planner'] }),
    ...linesFor(workflow, task, { type: 'fail', nodeId: 'reviewer', started: ['coder'], recovered: true, layerSize: 2 }),
    ...linesFor(workflow, task, { type: 'fail', nodeId: 'writer', started: [], layerSize: 1 }),
    ...linesFor(workflow, task, { type: 'retry', nodeId: 'tester', started: [], layerSize: 1 }),
    ...linesFor(workflow, task, { type: 'complete', nodeId: 'writer', started: ['reviewer', 'tester'], joined: true, layerSize: 2, finished: false }),
    ...linesFor(workflow, task, { type: 'complete', nodeId: 'deployer', started: [], layerSize: 0, finished: true }),
    ...linesFor(workflow, task, { type: 'reset' }),
  ]
  for (const row of rows) assert.equal(typeof row.key, 'string', `a non-live frame lost its key: ${JSON.stringify(row)}`)
  for (const row of rows) assert.match(row.text, /[\u4e00-\u9fff]/, `the Chinese fallback text is missing: ${JSON.stringify(row)}`)

  const text = await stageText(rows, 'en')
  assert.equal(/[\u4e00-\u9fff]/.test(text), false, `the English shell still shows Chinese copy: ${text}`)
  assert.ok(text.includes('Task #1489 Timeline copy entered the workflow; Planner claimed it'))
  assert.ok(text.includes('Reviewer failed; went back to Coder to retry'))
  assert.ok(text.includes('↺ Recovered from failure → Coder'))
  assert.ok(text.includes('Writer failed this step and stops here.'))
  assert.ok(text.includes('↻ Tester retried automatically after a failure · Coder pushed the snapshot update'))
  assert.ok(text.includes('∥ Parallel branches started: Reviewer ‖ Tester'))
  assert.ok(text.includes('⇢ Parallel branches joined (join) → Reviewer ‖ Tester'))
  assert.ok(text.includes('Draft done (86 chars → 31)'))
  assert.ok(text.includes('✓ Done · #1489 · Timeline copy · 6 steps'))
  assert.ok(text.includes('↺ Run reset'))

  const zh = await stageText(rows, 'zh')
  assert.ok(zh.includes('任务 #1489 Timeline copy 已进入 Workflow，Planner 认领'))
  assert.ok(zh.includes('Writer 这一步失败了，停在本节点。'))
  assert.ok(zh.includes('↻ Tester 失败后自动重试 · Coder 已推送快照更新'))
  assert.ok(zh.includes('✓ 完成 · #1489 · Timeline copy · 6 步'))
})

test('the stage clock is 12px on the readable ink token, still centred', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = /\.wf-ts\{([^}]*)\}/.exec(source)
  assert.ok(rule, 'the .wf-ts rule is missing')
  assert.doesNotMatch(rule[1], /font-size:\s*11(?:\.\d+)?px/, '.wf-ts is still the 11px stamp')
  assert.match(rule[1], /font-size:\s*1[2-9](?:\.\d+)?px/, '.wf-ts must be at least 12px')
  assert.equal(rule[1].includes('--bt-ink-3'), false, '.wf-ts still uses the lowest ink token')
  assert.match(rule[1], /color:\s*var\(--bt-ink-2\b/)
  assert.match(rule[1], /text-align:\s*center/)
})

// #1530 landed after the reviewed tip: a step nobody answers now times out, and
// that line is the same stage timeline. Driven through the real service and its
// injected timer, so the frame is checked where it is emitted, not in a fixture.
test('the deadline timeout frame reads in the shell language, from the real service', async () => {
  const queue = new Map()
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false }],
    spawn: async (spec) => `eph-${spec.nodeId}-${++seq}`,
    release: async () => {},
    dispatch: async () => ({ ok: true }),
    setTimer: (fn, ms) => {
      const id = ++seq
      queue.set(id, { fn, due: Math.max(1, Number(ms) || 0) })
      return id
    },
    clearTimer: (id) => queue.delete(id),
  })
  const made = svc.define({
    name: 'Timeout lane',
    nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' }],
    edges: [],
  })
  assert.equal(made.ok, true, JSON.stringify(made.reasons ?? made))
  const flow = made.workflows.find(item => item.name === 'Timeout lane')
  await svc.assign({ workflowId: flow.id, taskId: '#1489', title: 'Stuck step' })

  const deadline = [...queue.values()].find(entry => entry.due === STEP_DEADLINE_MS)
  assert.ok(deadline, 'the running step armed its deadline')
  await deadline.fn()

  const row = svc.state().workflows.find(item => item.id === flow.id)
  const line = row.messages
    .filter(message => message.key === '{node} timed out: no reply for {minutes} minutes, the run was marked failed.')
    .at(-1)
  assert.ok(line, 'the timeout frame must carry its key')
  assert.deepEqual(line.params, { node: 'Planner', minutes: DEFAULT_STEP_TIMEOUT_MINUTES })
  assert.match(line.text, new RegExp(`^Planner 超时：${DEFAULT_STEP_TIMEOUT_MINUTES} 分钟没有回包`))

  const en = await stageText(row.messages, 'en')
  assert.ok(en.includes(`Planner timed out: no reply for ${DEFAULT_STEP_TIMEOUT_MINUTES} minutes, the run was marked failed.`), `the English deadline frame is missing from: ${en}`)
  assert.equal(/[\u4e00-\u9fff]/.test(en), false, `the English shell still shows Chinese copy: ${en}`)

  const zh = await stageText(row.messages, 'zh')
  assert.ok(zh.includes(`Planner 超时：${DEFAULT_STEP_TIMEOUT_MINUTES} 分钟没有回包`), `the Chinese deadline frame is missing from: ${zh}`)
})

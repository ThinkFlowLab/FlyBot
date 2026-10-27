import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'
import { matchTask } from '../src/match.js'

const roster = [
  { id: 'bot-planner', name: 'Planner', role: '计划', remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
  { id: 'bot-friend', name: 'Remote', remote: true },
]

function service(extra = {}) {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster, ...extra })
}

function delivery(state) {
  return state.workflows.find(item => item.id === DELIVERY_ID)
}

test('assigning a board task starts the run at the first Bot and posts the claim', () => {
  const svc = service()
  const opened = delivery(svc.state())
  assert.equal(opened.preview, 'Coder 正在处理 #1280…')
  assert.equal(opened.run.steps, 3)
  assert.equal(opened.run.stepBudget, 10)
  assert.equal(opened.run.doneCount, 2)
  assert.deepEqual(opened.run.running, ['coder'])
  assert.equal(opened.run.nodeStatus.deployer, 'queued')
  assert.ok(opened.messages.some(message => message.kind === 'user' && message.text.includes('#1280')))

  const assigned = svc.assign({ workflowId: DELIVERY_ID, taskId: '#1281', title: '发布说明：Workflow Beta 上线' })
  const run = delivery(assigned).run
  assert.equal(assigned.ok, true)
  assert.equal(run.task.id, '#1281')
  assert.equal(run.status, 'running')
  assert.equal(run.nodeStatus.planner, 'running')
  assert.equal(run.nodeStatus.writer, 'queued')
  assert.equal(run.nodeStatus.deployer, 'queued')
  const claim = delivery(assigned).messages.filter(message => message.tone === 'accent').at(-1)
  assert.match(claim.text, /#1281/)
  assert.match(claim.text, /Planner 认领/)
  assert.ok(delivery(assigned).messages.some(message => message.text.includes('Tasks 看板')))
  assert.equal(svc.assign({ workflowId: DELIVERY_ID, taskId: '', title: 'x' }).ok, false)
})

test('advance walks the parallel join: Deployer stays queued until both branches are done', () => {
  const svc = service()
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-abcdef123456', title: 'Ship the note' })
  const step = (nodeId, outcome) => svc.advance({ workflowId: DELIVERY_ID, nodeId, outcome })
  step('planner', 'done')
  step('writer', 'done')
  const opened = step('coder', 'done')
  const mid = delivery(opened).run
  assert.equal(mid.nodeStatus.reviewer, 'running')
  assert.equal(mid.nodeStatus.tester, 'running')
  assert.equal(mid.nodeStatus.deployer, 'queued')
  assert.ok(delivery(opened).messages.some(message => message.text.includes('并行分支开始')))

  const half = step('reviewer', 'done')
  assert.equal(delivery(half).run.nodeStatus.deployer, 'queued')
  assert.equal(delivery(half).run.nodeStatus.tester, 'running')

  const joined = step('tester', 'done')
  assert.equal(delivery(joined).run.nodeStatus.deployer, 'running')
  assert.ok(delivery(joined).messages.some(message => message.text.includes('汇合')))

  const finished = step('deployer', 'done')
  const done = delivery(finished).run
  assert.equal(done.status, 'done')
  assert.equal(done.doneCount, 6)
  assert.ok(delivery(finished).messages.some(message => message.tone === 'ok'))
  assert.equal(step('deployer', 'done').ok, false)
})

test('the demo step fails Tester once and still joins both branches', () => {
  const svc = service()
  svc.reset({ workflowId: DELIVERY_ID })
  const ops = []
  for (let i = 0; i < 12 && delivery(svc.state()).run.status !== 'done'; i += 1) {
    const before = delivery(svc.state()).run.nodeStatus.tester
    svc.demoStep({ workflowId: DELIVERY_ID })
    const after = delivery(svc.state()).run.nodeStatus.tester
    if (before !== after) ops.push(`${before}->${after}`)
  }
  assert.ok(ops.includes('running->failed'), ops.join(','))
  assert.equal(delivery(svc.state()).run.status, 'done')
  assert.equal(delivery(svc.state()).run.nodeStatus.deployer, 'done')
})

test('create seats a local Bot and refuses a remote one', () => {
  const svc = service()
  const made = svc.create({
    name: 'Hotfix',
    nodes: [
      { id: 'plan', botId: 'bot-planner', name: 'Planner' },
      { id: 'code', botId: 'bot-coder', name: 'Coder' },
    ],
    layers: [['plan'], ['code']],
  })
  assert.equal(made.ok, true)
  const hotfix = made.workflows.find(item => item.name === 'Hotfix')
  assert.equal(hotfix.nodes[0].botId, 'bot-planner')
  assert.equal(hotfix.nodes[1].botId, 'bot-coder')
  assert.match(hotfix.messages[0].text, /已创建/)

  const remote = svc.create({
    name: 'Nope',
    nodes: [{ id: 'friend', botId: 'bot-friend', name: 'Remote' }],
    layers: [['friend']],
  })
  assert.equal(remote.ok, false)
  assert.match(remote.error, /local Bots only/)
  assert.equal(svc.create({
    name: 'Twice',
    nodes: [
      { id: 'a', botId: 'bot-coder', name: 'Coder' },
      { id: 'b', botId: 'bot-coder', name: 'Coder' },
    ],
    layers: [['a'], ['b']],
  }).ok, false)
})

test('a read-only host refuses assign, and a say lands in the workflow chat', () => {
  const svc = service({ readOnly: () => true })
  const refused = svc.assign({ workflowId: DELIVERY_ID, taskId: '#1', title: 'No' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'read-only')

  const live = service()
  const said = live.say({ workflowId: DELIVERY_ID, text: '请把 notice 再短一点' })
  const messages = delivery(said).messages
  assert.equal(messages.at(-2).kind, 'user')
  assert.match(messages.at(-1).text, /Coder/)
  assert.match(messages.at(-1).text, /请把 notice 再短一点|收到/)
})

test('the store reloads a workflow file and drops a file that does not parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-'))
  try {
    const first = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => roster })
    first.assign({ workflowId: DELIVERY_ID, taskId: '#9', title: 'Keep me' })
    const second = createWorkflowService({ dir, persist: true, now: () => 6, bots: () => roster })
    assert.equal(delivery(second.state()).run.task.title, 'Keep me')
    const warnings = []
    const file = join(dir, 'workflows.json')
    const raw = readFileSync(file, 'utf8')
    assert.equal(JSON.parse(raw).version, 1)
    const broken = createWorkflowService({
      dir: join(dir, 'missing'),
      persist: true,
      now: () => 7,
      bots: () => [],
      warn: (line) => warnings.push(line),
    })
    assert.equal(delivery(broken.state()).id, DELIVERY_ID)
    assert.equal(warnings.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dragged graph persists and the reloaded run still highlights those nodes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-edit-'))
  try {
    const first = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => roster })
    const before = delivery(first.state())
    const coder = before.nodes.find(node => node.id === 'coder')
    const saved = first.saveGraph({
      workflowId: DELIVERY_ID,
      nodes: before.nodes.map(node => node.id === 'coder' ? { ...node, x: coder.x + 48, y: coder.y } : node),
      edges: before.edges.filter(edge => !(edge.from === 'coder' && edge.to === 'tester')).concat([{ from: 'writer', to: 'tester' }]),
    })
    assert.equal(saved.ok, true)
    const edited = delivery(saved)
    assert.equal(edited.nodes.find(node => node.id === 'coder').x, coder.x + 48)
    assert.equal(edited.run.nodeStatus.coder, 'running')
    assert.ok(edited.edges.some(edge => edge.from === 'writer' && edge.to === 'tester'))
    assert.equal(edited.edges.some(edge => edge.from === 'coder' && edge.to === 'tester'), false)

    const second = createWorkflowService({ dir, persist: true, now: () => 6, bots: () => roster })
    const loaded = delivery(second.state())
    assert.equal(loaded.nodes.find(node => node.id === 'coder').x, coder.x + 48)
    assert.equal(loaded.run.nodeStatus.coder, 'running')
    assert.equal(loaded.run.nodeStatus.planner, 'done')
    const refused = second.assign({ workflowId: DELIVERY_ID, taskId: '#9', title: 'Ship the note' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /patch/)
    assert.equal(delivery(second.state()).run.nodeStatus.coder, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('templates, a Bot-defined graph, and run_workflow share one store', () => {
  const svc = service()
  const templates = svc.state().templates.map(item => item.id)
  assert.deepEqual(templates, ['delivery', 'weekly'])
  const deliveryTemplate = svc.state().templates.find(item => item.id === 'delivery')
  assert.ok(deliveryTemplate.nodes.some(node => node.id === 'coder' && Number.isFinite(node.x)))
  assert.ok(deliveryTemplate.edges.some(edge => edge.from === 'coder' && edge.to === 'reviewer'))
  assert.match(deliveryTemplate.chain, /Reviewer ‖ Tester/)
  const copy = svc.create({ template: 'delivery', name: '发布交付流水线' })
  const made = copy.workflows.find(item => item.name === '发布交付流水线 副本')
  assert.ok(made)
  assert.ok(made.edges.some(edge => edge.from === 'coder' && edge.to === 'reviewer'))
  assert.ok(made.layers.some(layer => layer.includes('reviewer') && layer.includes('tester')))

  const defined = svc.define({
    name: 'Hotfix lane',
    nodes: [
      { id: 'plan', name: 'Planner', botId: 'bot-planner' },
      { id: 'code', name: 'Coder', botId: 'bot-coder' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  assert.equal(defined.ok, true)
  const lane = defined.workflows.find(item => item.name === 'Hotfix lane')
  assert.equal(lane.nodes[0].botId, 'bot-planner')
  assert.deepEqual(lane.edges, [{ from: 'plan', to: 'code' }])
  const started = svc.runNamed({ workflow: 'Hotfix lane', task: '#77', brief: 'Ship the note' })
  const running = started.workflows.find(item => item.id === lane.id)
  assert.equal(running.run.task.id, '#77')
  assert.equal(running.run.nodeStatus.plan, 'running')
  const renamed = svc.define({
    workflow: 'Hotfix lane',
    name: 'Hotfix lane',
    nodes: lane.nodes,
    edges: [{ from: 'code', to: 'plan' }],
  })
  assert.equal(renamed.workflows.find(item => item.id === lane.id).edges[0].from, 'code')
  assert.equal(renamed.workflows.find(item => item.id === lane.id).run.nodeStatus.plan, 'running')
  assert.equal(svc.runNamed({ workflow: 'missing', brief: 'x' }).ok, false)
  assert.equal(svc.define({
    name: 'Remote',
    nodes: [{ id: 'friend', name: 'Remote', botId: 'bot-friend' }],
    edges: [],
  }).ok, false)
})

test('an open task auto-starts the matching workflow, and a miss stays unassigned', () => {
  const svc = service()
  const bots = [
    { id: 'bot-coder', name: 'Coder', remote: false },
    { id: 'bot-friend', name: 'Remote', remote: true },
  ]
  const workflows = svc.state().workflows
  assert.equal(matchTask({ id: '#1', title: 'hello', status: 'open' }, { workflows, bots }), null)
  assert.equal(matchTask({ id: '#1', title: 'notice', status: 'working' }, { workflows, bots }), null)
  assert.deepEqual(matchTask({ id: '#1', title: '写周报', status: 'open' }, { workflows, bots }), { kind: 'workflow', id: 'weekly' })
  assert.deepEqual(matchTask({ id: '#1', title: 'notice 里写 workflow:weekly', status: 'open' }, { workflows, bots }), { kind: 'workflow', id: 'weekly' })
  assert.deepEqual(matchTask({ id: '#1', title: 'x', status: 'open', assignee: 'Coder' }, { workflows, bots }), { kind: 'bot', id: 'bot-coder' })
  assert.equal(matchTask({ id: '#1', title: 'x', status: 'open', assignee: 'Remote' }, { workflows, bots }), null)

  const held = svc.ingest({ id: '#1280', title: '缩短交付组群 notice', status: 'open' })
  assert.equal(held.already, true)
  assert.equal(delivery(svc.state()).run.steps, 3)

  const weekly = svc.ingest({ id: '#50', title: '周五周报', status: 'open' })
  assert.equal(weekly.matched, true)
  assert.equal(weekly.decision.id, 'weekly')
  assert.equal(svc.state().workflows.find(item => item.id === 'weekly').run.status, 'running')
  const again = svc.ingest({ id: '#50', title: '周五周报', status: 'open' })
  assert.equal(again.already, true)

  const bot = svc.ingest({ id: '#51', title: '请看一下', status: 'open', assignee: 'Coder' })
  assert.deepEqual(bot.decision, { kind: 'bot', id: 'bot-coder' })
  assert.equal(svc.ingest({ id: '#52', title: 'nothing', status: 'open' }).matched, false)
  assert.equal(svc.ingest({ id: '#53', title: 'notice', status: 'accepted' }).matched, false)
})

test('apply registers the workflow endpoints and stays quiet when disabled', () => {
  const names = []
  const writes = []
  const fb = {
    bot: { list: () => roster },
    readOnly: () => false,
    api: { handle(name, fn, opts) { names.push([name, opts?.read === true]); return () => {} } },
    tasks: { onWrite(fn) { writes.push(fn); return () => {} } },
    warn() {},
  }
  const ctx = { flybot: { scope: () => fb }, effect(fn) { fn() } }
  const started = apply(ctx, { persist: false })
  assert.equal(started.enabled, true)
  assert.ok(names.some(([name, read]) => name === 'workflow/state' && read))
  assert.ok(names.some(([name]) => name === 'workflow/assign'))
  assert.ok(names.some(([name]) => name === 'workflow/graph'))
  assert.ok(names.some(([name, read]) => name === 'workflow/templates' && read))
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0]({ id: '#9', title: 'please', status: 'open', assignee: 'Coder' }), { ownerBotId: 'bot-coder' })
  assert.equal(writes[0]({ id: '#10', title: 'nothing', status: 'open' }), null)
  const tools = []
  const withTools = { ...fb, tools: { register(spec) { tools.push(spec.name); return () => {} } } }
  apply({ flybot: { scope: () => withTools }, effect(fn) { fn() } }, { persist: false })
  assert.deepEqual(tools, ['run_workflow', 'define_workflow'])
  const off = apply({ flybot: { scope: () => fb } }, { enabled: false })
  assert.equal(off.enabled, false)
})

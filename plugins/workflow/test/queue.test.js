// #1402: a live run is not replaced. Tasks queue, a node stays running until
// the Bot replies, and a dispatch that fails is not marked handed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { completeNode, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'
import { matchTask } from '../src/match.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, WEEKLY_ID, deliveryWorkflow, fixtureTask, weeklyWorkflow } from '../src/template.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
  { id: 'bot-friend', name: 'Remote', remote: true },
]

function harness(extra = {}) {
  const spawned = []
  const released = []
  const dispatched = []
  let seq = 0
  let dispatchResult = extra.dispatchResult ?? (() => ({ ok: true }))
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => roster,
    spawn: async (spec) => {
      if (extra.blockSpawn) await extra.blockSpawn()
      const id = `eph-${++seq}`
      spawned.push({ id, spec })
      if (extra.failOn === spec.nodeId) throw new Error('spawn failed')
      return id
    },
    release: async (id) => { released.push(id) },
    dispatch: async (step) => {
      const result = await dispatchResult(step)
      dispatched.push({ step, result })
      return result
    },
  })
  return { svc, spawned, released, dispatched, setDispatch(fn) { dispatchResult = fn } }
}

function delivery(state) {
  return state.workflows.find(item => item.id === DELIVERY_ID)
}

test('a second assign queues behind a live run and does not release its Bots', async () => {
  const { svc, spawned, released } = harness()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  const first = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1397', title: 'Fix the hand-off' })
  const opened = delivery(first)
  assert.equal(opened.run.task.id, '#1397')
  assert.equal(opened.run.status, 'running')
  assert.equal(opened.run.live, true)
  assert.equal(opened.activeCount, 1)
  assert.equal(opened.queueDepth, 0)
  const bots = spawned.map(item => item.id)

  const second = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1389', title: 'Do not drop the first run' })
  const queued = delivery(second)
  assert.equal(queued.run.task.id, '#1397')
  assert.equal(queued.run.status, 'running')
  assert.equal(queued.queueDepth, 1)
  assert.equal(queued.queue[0].id, '#1389')
  assert.deepEqual(released, [])
  assert.equal(spawned.length, bots.length)
  assert.equal(queued.run.history.some(item => item.status === 'running'), false)

  const planner = opened.run.ephemeral.planner
  const replied = await svc.stepResult({ botId: planner, ok: true, text: 'Split the notice.\nOUTPUT plan: two lines' })
  assert.equal(delivery(replied).run.task.id, '#1397')
  const reply = delivery(replied).messages.at(-1).text
  assert.match(reply, /Split the notice/)
  assert.equal(reply.includes('已拆解'), false)
})

test('the queued task starts only after the live run finishes, in FIFO order', async () => {
  const { svc } = harness()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1', title: 'First' })
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#2', title: 'Second' })
  await svc.assign({ workflowId: DELIVERY_ID, taskId: '#3', title: 'Third' })
  assert.deepEqual(delivery(svc.state()).queue.map(task => task.id), ['#2', '#3'])

  const walk = async (taskId) => {
    for (let i = 0; i < 12 && delivery(svc.state()).run?.task?.id === taskId && delivery(svc.state()).run.status === 'running'; i += 1) {
      const run = delivery(svc.state()).run
      const nodeId = run.running[0]
      const botId = run.ephemeral[nodeId]
      const node = delivery(svc.state()).nodes.find(item => item.id === nodeId)
      const line = (node?.outputs ?? []).map(port => `OUTPUT ${port.name}: ${port.name} for ${taskId}`).join('\n')
      await svc.stepResult({ botId, ok: true, text: `${node?.name} did ${taskId}\n${line}` })
    }
  }
  await walk('#1')
  assert.equal(delivery(svc.state()).run.task.id, '#2')
  assert.equal(delivery(svc.state()).run.status, 'running')
  assert.deepEqual(delivery(svc.state()).queue.map(task => task.id), ['#3'])
  assert.equal(delivery(svc.state()).history.some(item => item.task.id === '#1' && item.status === 'running'), false)
  assert.equal(delivery(svc.state()).history.some(item => item.task.id === '#1' && item.status === 'done'), true)
  await walk('#2')
  assert.equal(delivery(svc.state()).run.task.id, '#3')
  await walk('#3')
  assert.equal(delivery(svc.state()).run.status, 'done')
  assert.equal(delivery(svc.state()).queueDepth, 0)
})

test('a node stays running until the Bot replies, and demo-step does not move a live run', async () => {
  const { svc, dispatched } = harness()
  const started = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#7', title: 'Wait for the Bot' })
  const run = delivery(started).run
  assert.equal(run.nodeStatus.planner, 'running')
  assert.equal(run.nodeStatus.writer, 'queued')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].step.nodeId, 'planner')
  assert.match(dispatched[0].step.inputs.task, /#7/)

  const demo = await svc.demoStep({ workflowId: DELIVERY_ID })
  assert.equal(demo.ok, false)
  assert.equal(delivery(svc.state()).run.nodeStatus.planner, 'running')
  assert.equal(delivery(svc.state()).run.nodeStatus.writer, 'queued')

  const writer = await svc.stepResult({
    botId: run.ephemeral.planner,
    ok: true,
    text: 'The plan is ready.\nOUTPUT plan: shorten the notice',
  })
  const next = delivery(writer).run
  assert.equal(next.nodeStatus.planner, 'done')
  assert.equal(next.nodeStatus.writer, 'running')
  assert.equal(dispatched.at(-1).step.nodeId, 'writer')
  assert.equal(dispatched.at(-1).step.inputs.plan, 'shorten the notice')
  assert.match(delivery(writer).messages.map(message => message.text).join('\n'), /The plan is ready/)
})

test('dispatch no-sender does not mark the node handed and the chat names it', async () => {
  const { svc, dispatched, released } = harness({ dispatchResult: () => ({ ok: false, code: 'no-sender' }) })
  const started = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#1389', title: 'No main Bot' })
  const run = delivery(started).run
  assert.equal(run.status, 'running')
  assert.equal(run.nodeStatus.planner, 'running')
  assert.equal(run.handed, undefined)
  assert.equal(dispatched.length, 1)
  assert.match(delivery(started).messages.map(message => message.text).join('\n'), /no-sender/)
  assert.deepEqual(released, [])
})

test('two assigns that overlap spawn one set per run and release none early', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = 0
  const { svc, spawned, released } = harness({
    blockSpawn: () => {
      entered += 1
      return entered === 1 ? gate : undefined
    },
  })
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  const first = svc.assign({ workflowId: DELIVERY_ID, taskId: '#1', title: 'First' })
  await new Promise(resolve => setImmediate(resolve))
  const second = svc.assign({ workflowId: DELIVERY_ID, taskId: '#2', title: 'Second' })
  release()
  await first
  await second
  assert.equal(delivery(svc.state()).activeCount, 1)
  assert.equal(delivery(svc.state()).queueDepth, 1)
  assert.equal(spawned.length, delivery(svc.state()).nodes.length)
  assert.deepEqual(released, [])
})

test('assigning to a Bot does not start a workflow, even when the title matches a trigger', async () => {
  const { svc, spawned } = harness()
  const routed = await svc.assign({ botId: 'bot-coder', taskId: '#51', title: 'notice for Coder' })
  assert.equal(routed.ok, true)
  assert.equal(routed.decision.kind, 'bot')
  assert.equal(routed.decision.id, 'bot-coder')
  assert.equal(delivery(svc.state()).activeCount, 0)
  assert.equal(spawned.length, 0)
  assert.equal(delivery(svc.state()).run, null)
  assert.equal(delivery(svc.state()).preview, '等待任务')

  const remote = svc.assign({ botId: 'bot-friend', taskId: '#52', title: 'Nope' })
  assert.equal(remote.ok, false)

  const workflows = svc.state().workflows
  assert.deepEqual(
    matchTask({ id: '#9', title: 'notice', status: 'open', assignee: 'Coder' }, { workflows, bots: roster }),
    { kind: 'bot', id: 'bot-coder' },
  )
  const ingested = svc.ingest({ id: '#9', title: 'notice', status: 'open', assignee: 'Coder' })
  assert.equal(ingested.decision.kind, 'bot')
  assert.equal(delivery(svc.state()).activeCount, 0)
})

test('a required input with no upstream provider refuses the run', async () => {
  const { svc, spawned } = harness()
  const defined = svc.define({
    name: 'Broken',
    nodes: [
      { id: 'draft', name: 'Draft', outputs: [{ name: 'note', type: 'text' }] },
      { id: 'edit', name: 'Edit', inputs: [{ name: 'plan', type: 'text', required: true }] },
    ],
    edges: [{ from: 'draft', to: 'edit' }],
  })
  const made = defined.workflows.find(item => item.name === 'Broken')
  const refused = await svc.assign({ workflowId: made.id, taskId: '#4', title: 'Missing plan' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /plan/)
  assert.equal(spawned.length, 0)
  assert.equal(defined.workflows.find(item => item.id === made.id).run, null)
})

test('outputs travel along edges and a node does not start without them', async () => {
  const { svc, dispatched } = harness()
  const defined = svc.define({
    name: 'Lane',
    nodes: [
      { id: 'plan', name: 'Planner', outputs: [{ name: 'plan', type: 'text' }] },
      { id: 'write', name: 'Writer', inputs: [{ name: 'plan', type: 'text', required: true }], outputs: [{ name: 'copy', type: 'text' }] },
      { id: 'ship', name: 'Deployer', inputs: [{ name: 'copy', type: 'text', required: true }] },
    ],
    edges: [{ from: 'plan', to: 'write' }, { from: 'write', to: 'ship' }],
  })
  const made = defined.workflows.find(item => item.name === 'Lane')
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'Ship the note', task: '#8' })
  assert.equal(started.workflows.find(item => item.id === made.id).run.nodeStatus.plan, 'running')
  assert.equal(started.workflows.find(item => item.id === made.id).run.nodeStatus.write, 'queued')
  assert.equal(started.workflows.find(item => item.id === made.id).run.nodeStatus.ship, 'queued')

  const run = started.workflows.find(item => item.id === made.id).run
  const mid = await svc.stepResult({ botId: run.ephemeral.plan, ok: true, text: 'OUTPUT plan: lead with the conclusion' })
  const after = mid.workflows.find(item => item.id === made.id).run
  assert.equal(after.nodeStatus.write, 'running')
  assert.equal(after.nodeStatus.ship, 'queued')
  assert.equal(dispatched.at(-1).step.inputs.plan, 'lead with the conclusion')

  const done = await svc.stepResult({ botId: after.ephemeral.write, ok: false, text: 'The model call failed.' })
  const stopped = done.workflows.find(item => item.id === made.id).run
  assert.equal(stopped.nodeStatus.write, 'failed')
  assert.equal(stopped.nodeStatus.ship, 'queued')
  assert.match(done.workflows.find(item => item.id === made.id).messages.map(message => message.text).join('\n'), /model call failed/)
})

test('an old store keeps the seeded script as a demo, so replay still advances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-old-'))
  try {
    const deliveryGraph = normalizeGraph(deliveryWorkflow())
    const weeklyGraph = normalizeGraph(weeklyWorkflow())
    let nodeStatus = freshStatus(deliveryGraph)
    for (const op of [{ type: 'start' }, { type: 'complete', nodeId: 'planner' }, { type: 'complete', nodeId: 'writer' }]) {
      const result = op.type === 'start' ? startFrontier(deliveryGraph, nodeStatus) : completeNode(deliveryGraph, nodeStatus, op.nodeId)
      nodeStatus = result.status
    }
    const task = fixtureTask()
    const done = freshStatus(weeklyGraph)
    for (const id of Object.keys(done)) done[id] = 'done'
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify({
      version: 1,
      workflows: [
        deliveryGraph,
        weeklyGraph,
        { id: 'solo', name: 'Solo', nodes: [{ id: 'only', name: 'Only', x: 40, y: 40 }], edges: [], layers: [['only']] },
      ],
      runs: {
        [DELIVERY_ID]: {
          id: 'run-old', workflowId: DELIVERY_ID, task, status: 'running', nodeStatus,
          steps: 3, stepBudget: 8, failedOnce: {}, history: [], startedAt: 1, updatedAt: 1,
        },
        [WEEKLY_ID]: {
          id: 'run-week', workflowId: WEEKLY_ID, task: { id: 'W42', title: '周报' }, status: 'done',
          nodeStatus: done, steps: 4, stepBudget: 4,
          history: [{ task: { id: 'W42', title: '周报' }, status: 'done', at: 1 }],
          startedAt: 1, updatedAt: 1,
        },
        solo: {
          id: 'run-live', workflowId: 'solo', task: { id: '#9', title: 'Live' }, status: 'running',
          nodeStatus: { only: 'running' }, ephemeral: { only: 'bot-live' },
          steps: 1, stepBudget: 2, history: [], startedAt: 1, updatedAt: 1,
        },
      },
      logs: { [DELIVERY_ID]: [], [WEEKLY_ID]: [], solo: [] },
      seq: 1,
    }))
    const svc = createWorkflowService({ dir, persist: true, now: () => 9, bots: () => [] })
    const opened = delivery(svc.state())
    assert.equal(opened.activeCount, 0)
    assert.equal(opened.run, null)
    assert.equal(opened.preview, '等待任务')
    const stepped = svc.demoStep({ workflowId: DELIVERY_ID })
    assert.equal(stepped.ok, true)
    const after = delivery(stepped)
    assert.equal(after.activeCount, 0)
    assert.equal(after.run.nodeStatus.coder, 'done')
    const week = stepped.workflows.find(item => item.id === WEEKLY_ID)
    assert.equal(week.activeCount, 0)
    assert.equal(week.run, null)
    assert.match(week.preview, /周五 17:00/)
    const replay = svc.demoStep({ workflowId: WEEKLY_ID })
    assert.equal(replay.ok, true)
    const replayed = replay.workflows.find(item => item.id === WEEKLY_ID)
    assert.equal(replayed.activeCount, 0)
    assert.equal(replayed.run.status, 'running')
    assert.equal(replayed.run.nodeStatus.researcher, 'running')
    assert.equal(replayed.run.nodeStatus.writer, 'queued')
    const replayNext = svc.demoStep({ workflowId: WEEKLY_ID })
    assert.equal(replayNext.workflows.find(item => item.id === WEEKLY_ID).run.nodeStatus.analyst, 'running')
    const solo = replay.workflows.find(item => item.id === 'solo')
    assert.equal(solo.activeCount, 1)
    const refused = svc.demoStep({ workflowId: 'solo' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /A live run is in progress/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a task parked at the host cap starts when any run finishes, ahead of a newer assign', async () => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { svc } = harness({
    blockSpawn: () => {
      calls += 1
      if (calls === 6) return gate
      return undefined
    },
  })
  const ids = []
  for (let n = 0; n < 7; n += 1) {
    const made = svc.define({
      name: `Cap ${n}`,
      nodes: [{ id: 'only', name: 'Only', outputs: [{ name: 'out', type: 'text' }] }],
      edges: [],
    }).workflows.find(item => item.name === `Cap ${n}`)
    ids.push(made.id)
  }
  for (let n = 0; n < 5; n += 1) {
    const started = await svc.assign({ workflowId: ids[n], taskId: `#run${n}`, title: `Run ${n}` })
    assert.equal(started.workflows.find(item => item.id === ids[n]).activeCount, 1)
  }
  const sixth = svc.assign({ workflowId: ids[5], taskId: '#six', title: 'Six' })
  await new Promise(resolve => setImmediate(resolve))
  const parked = svc.assign({ workflowId: ids[6], taskId: '#parked', title: 'Parked' })
  release()
  await sixth
  const held = await parked
  assert.equal(held.workflows.find(item => item.id === ids[5]).activeCount, 1)
  const waiting = held.workflows.find(item => item.id === ids[6])
  assert.equal(waiting.activeCount, 0)
  assert.deepEqual(waiting.queue.map(task => task.id), ['#parked'])

  const newer = await svc.assign({ workflowId: ids[6], taskId: '#newer', title: 'Newer' })
  const both = newer.workflows.find(item => item.id === ids[6])
  assert.equal(both.activeCount, 0)
  assert.deepEqual(both.queue.map(task => task.id), ['#parked', '#newer'])

  const victim = newer.workflows.find(item => item.id === ids[0]).run
  const finished = await svc.stepResult({ botId: victim.ephemeral.only, ok: true, text: 'OUTPUT out: done' })
  assert.equal(finished.workflows.find(item => item.id === ids[0]).activeCount, 0)
  const woke = finished.workflows.find(item => item.id === ids[6])
  assert.equal(woke.activeCount, 1)
  assert.equal(woke.run.task.id, '#parked')
  assert.deepEqual(woke.queue.map(task => task.id), ['#newer'])
})

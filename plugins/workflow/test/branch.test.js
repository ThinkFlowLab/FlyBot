// Loops and conditions (#1402). A loop edge is the only cycle, and it stops
// at max or until. A when edge chooses a branch; the other is skipped.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeNode, connectNodes, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, deliveryWorkflow } from '../src/template.js'

function choiceGraph() {
  return normalizeGraph({
    nodes: [
      { id: 'choose', name: 'Choose', outputs: [{ name: 'path' }] },
      { id: 'left', name: 'Left' },
      { id: 'right', name: 'Right' },
      { id: 'join', name: 'Join' },
    ],
    edges: [
      { from: 'choose', to: 'left', when: { output: 'path', eq: 'left' } },
      { from: 'choose', to: 'right', when: { output: 'path', eq: 'right' } },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' },
    ],
  })
}

function loopGraph(until) {
  return normalizeGraph({
    nodes: [
      { id: 'body', name: 'Body', outputs: [{ name: 'stop' }] },
      { id: 'next', name: 'Next' },
    ],
    edges: [
      { from: 'body', to: 'body', loop: true, max: 3, ...(until ? { until } : {}) },
      { from: 'body', to: 'next' },
    ],
  })
}

test('an if/else edge runs one branch and skips the other, then joins', () => {
  const graph = choiceGraph()
  assert.equal(graph.edges.find(edge => edge.to === 'left').when.eq, 'left')
  let status = startFrontier(graph, freshStatus(graph)).status
  assert.equal(status.choose, 'running')
  let step = completeNode(graph, status, 'choose', { outputs: { path: 'left' } })
  assert.equal(step.status.left, 'running')
  assert.equal(step.status.right, 'skipped')
  assert.equal(step.status.join, 'queued')
  step = completeNode(graph, step.status, 'left', { fired: step.fired, loops: step.loops })
  assert.equal(step.status.join, 'running')
  assert.equal(step.status.right, 'skipped')
  step = completeNode(graph, step.status, 'join', { fired: step.fired })
  assert.equal(step.finished, true)
  assert.equal(step.status.join, 'done')
})

test('the other branch is taken when the output matches it', () => {
  const graph = choiceGraph()
  let status = startFrontier(graph, freshStatus(graph)).status
  const step = completeNode(graph, status, 'choose', { outputs: { path: 'right' } })
  assert.equal(step.status.right, 'running')
  assert.equal(step.status.left, 'skipped')
})

test('a loop restarts until the break output matches, and does not start the exit early', () => {
  const graph = loopGraph({ output: 'stop', eq: 'yes' })
  assert.equal(graph.edges.find(edge => edge.loop).max, 3)
  let status = startFrontier(graph, freshStatus(graph)).status
  let step = completeNode(graph, status, 'body', { outputs: { stop: 'no' } })
  assert.equal(step.looped, true)
  assert.equal(step.status.body, 'running')
  assert.equal(step.status.next, 'queued')
  step = completeNode(graph, step.status, 'body', { outputs: { stop: 'yes' }, loops: step.loops, fired: step.fired })
  assert.equal(step.looped, false)
  assert.equal(step.status.body, 'done')
  assert.equal(step.status.next, 'running')
})

test('a loop stops at max even when the break never matches', () => {
  const graph = loopGraph({ output: 'stop', eq: 'yes' })
  let step = completeNode(graph, startFrontier(graph, freshStatus(graph)).status, 'body', { outputs: { stop: 'no' } })
  step = completeNode(graph, step.status, 'body', { outputs: { stop: 'no' }, loops: step.loops })
  assert.equal(step.status.next, 'queued')
  step = completeNode(graph, step.status, 'body', { outputs: { stop: 'no' }, loops: step.loops })
  assert.equal(step.looped, false)
  assert.equal(step.status.next, 'running')
})

test('a loop lets the next pass take the other branch', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'choose', name: 'Choose', outputs: [{ name: 'path' }] },
      { id: 'left', name: 'Left' },
      { id: 'right', name: 'Right' },
    ],
    edges: [
      { from: 'choose', to: 'left', when: { output: 'path', eq: 'left' } },
      { from: 'choose', to: 'right', when: { output: 'path', eq: 'right' } },
      { from: 'left', to: 'choose', loop: true, max: 3 },
    ],
  })
  let step = completeNode(graph, startFrontier(graph, freshStatus(graph)).status, 'choose', { outputs: { path: 'left' } })
  assert.equal(step.status.left, 'running')
  assert.equal(step.status.right, 'skipped')
  step = completeNode(graph, step.status, 'left', { fired: step.fired, loops: step.loops })
  assert.equal(step.looped, true)
  assert.equal(step.status.choose, 'running')
  assert.equal(step.status.right, 'queued')
  step = completeNode(graph, step.status, 'choose', { outputs: { path: 'right' }, fired: step.fired, loops: step.loops })
  assert.equal(step.status.right, 'running')
  assert.equal(step.status.left, 'skipped')
})

test('a loop edge is the only cycle; an unmarked back edge is still refused', () => {
  const bare = normalizeGraph({
    nodes: [{ id: 'body', name: 'Body' }, { id: 'next', name: 'Next' }],
    edges: [{ from: 'body', to: 'body', loop: true }, { from: 'body', to: 'next' }],
  })
  assert.equal(bare.edges.find(edge => edge.loop).max, 3)
  const delivery = normalizeGraph(deliveryWorkflow())
  assert.throws(() => connectNodes(delivery, 'deployer', 'planner'), /cycle/)
})

test('a multi-node loop restarts the body and leaves the exit queued', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'next', name: 'Next' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a', loop: true, max: 2 },
      { from: 'b', to: 'next' },
    ],
  })
  let step = completeNode(graph, startFrontier(graph, freshStatus(graph)).status, 'a')
  assert.equal(step.status.b, 'running')
  step = completeNode(graph, step.status, 'b', { fired: step.fired, loops: step.loops })
  assert.equal(step.looped, true)
  assert.equal(step.status.a, 'running')
  assert.equal(step.status.b, 'queued')
  assert.equal(step.status.next, 'queued')
  step = completeNode(graph, step.status, 'a', { fired: step.fired, loops: step.loops })
  step = completeNode(graph, step.status, 'b', { fired: step.fired, loops: step.loops })
  assert.equal(step.looped, false)
  assert.equal(step.status.next, 'running')
})

test('advance walks an if/else to done, and a loop clears the hand-off so the body is sent again', async () => {
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'main', name: 'Chief', isMain: true, remote: false }],
    spawn: async (spec) => {
      seq += 1
      return `eph-${spec.nodeId}-${seq}`
    },
    release: async () => {},
    dispatch: async (step) => { dispatched.push(step); return { ok: true } },
  })
  const defined = await svc.define({
    name: 'Branch',
    nodes: [
      { id: 'choose', name: 'Choose', outputs: [{ name: 'path' }] },
      { id: 'left', name: 'Left' },
      { id: 'right', name: 'Right' },
      { id: 'join', name: 'Join' },
    ],
    edges: [
      { from: 'choose', to: 'left', when: { output: 'path', eq: 'left' } },
      { from: 'choose', to: 'right', when: { output: 'path', eq: 'right' } },
      { from: 'left', to: 'join' },
      { from: 'right', to: 'join' },
    ],
  })
  const branch = defined.workflows.find(item => item.name === 'Branch')
  assert.equal(branch.edges.find(edge => edge.to === 'left').when.eq, 'left')
  await svc.assign({ workflowId: branch.id, taskId: '#if', title: 'Pick a side' })
  const chooseBot = dispatched.find(step => step.nodeId === 'choose').botId
  let state = await svc.stepResult({ botId: chooseBot, ok: true, text: 'OUTPUT path: left' })
  let run = state.workflows.find(item => item.id === branch.id).run
  assert.equal(run.nodeStatus.left, 'running')
  assert.equal(run.nodeStatus.right, 'skipped')
  assert.equal(dispatched.some(step => step.nodeId === 'right'), false)
  const leftBot = dispatched.find(step => step.nodeId === 'left').botId
  state = await svc.stepResult({ botId: leftBot, ok: true, text: 'took the left' })
  run = state.workflows.find(item => item.id === branch.id).run
  assert.equal(run.nodeStatus.join, 'running')
  const joinBot = dispatched.find(step => step.nodeId === 'join').botId
  state = await svc.stepResult({ botId: joinBot, ok: true, text: 'joined' })
  run = state.workflows.find(item => item.id === branch.id).run
  assert.equal(run.status, 'done')

  const looped = await svc.define({
    name: 'Loop',
    nodes: [
      { id: 'body', name: 'Body', outputs: [{ name: 'stop' }] },
      { id: 'next', name: 'Next' },
    ],
    edges: [
      { from: 'body', to: 'body', loop: true, max: 3, until: { output: 'stop', eq: 'yes' } },
      { from: 'body', to: 'next' },
    ],
  })
  const loop = looped.workflows.find(item => item.name === 'Loop')
  await svc.assign({ workflowId: loop.id, taskId: '#loop', title: 'Repeat' })
  const bodySteps = () => dispatched.filter(step => step.nodeId === 'body')
  assert.equal(bodySteps().length, 1)
  state = await svc.stepResult({ botId: bodySteps()[0].botId, ok: true, text: 'OUTPUT stop: no' })
  run = state.workflows.find(item => item.id === loop.id).run
  assert.equal(run.nodeStatus.body, 'running')
  assert.equal(run.nodeStatus.next, 'queued')
  assert.equal(bodySteps().length, 2)
  state = await svc.stepResult({ botId: bodySteps()[0].botId, ok: true, text: 'OUTPUT stop: yes' })
  run = state.workflows.find(item => item.id === loop.id).run
  assert.equal(run.nodeStatus.next, 'running')
  assert.equal(dispatched.at(-1).nodeId, 'next')
})

test('replay shows the demo again after a live run has finished', () => {
  const svc = createWorkflowService({ persist: false, now: () => 5 })
  const opened = svc.assign({ workflowId: DELIVERY_ID, taskId: '#live', title: 'A real task' })
  const row = opened.workflows.find(item => item.id === DELIVERY_ID)
  assert.equal(row.run.live, true)
  assert.equal(row.run.task.id, '#live')
  let status = row.run.nodeStatus
  const order = ['planner', 'writer', 'coder', 'reviewer', 'tester', 'deployer']
  let view = opened
  for (const nodeId of order) {
    if (status[nodeId] !== 'running') continue
    view = svc.advance({ workflowId: DELIVERY_ID, nodeId, outcome: 'done' })
    status = view.workflows.find(item => item.id === DELIVERY_ID).run.nodeStatus
  }
  const finished = view.workflows.find(item => item.id === DELIVERY_ID)
  assert.equal(finished.run.status, 'done')
  assert.equal(finished.run.task.id, '#live')
  assert.equal(finished.run.nodeStatus.deployer, 'done')
  const replay = svc.demoStep({ workflowId: DELIVERY_ID })
  const shown = replay.workflows.find(item => item.id === DELIVERY_ID)
  assert.equal(shown.run.task.id, '#live')
  assert.equal(shown.run.status, 'done')
  assert.equal(replay.demo.task.id, '#1280')
  assert.equal(replay.demo.live, undefined)
  assert.equal(replay.demo.status, 'running')
  assert.equal(replay.demo.nodeStatus.coder, 'done')
  assert.equal(replay.demo.nodeStatus.reviewer, 'running')
  assert.equal(replay.demo.nodeStatus.deployer, 'queued')
  assert.equal(shown.preview, '等待任务')
  const again = svc.demoStep({ workflowId: DELIVERY_ID })
  assert.equal(again.demo.task.id, '#1280')
  assert.equal(again.demo.nodeStatus.reviewer, 'running')
  assert.equal(again.demo.nodeStatus.tester, 'failed')
  assert.notEqual(again.demo.nodeStatus.deployer, 'done')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addNode, chainLabel, cleanLine, completeNode, connectNodes, doneCount, failNode, freshStatus, layerMarks,
  moveNode, nextDemoOp, normalizeGraph, reconnectEdge, removeEdge, removeNode, retryNode,
  rowPreview, startFrontier, summarizeTask, validateGraph,
} from '../src/graph.js'
import { deliveryWorkflow, weeklyWorkflow } from '../src/template.js'

const delivery = deliveryWorkflow()

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

function runToCoder() {
  let status = freshStatus(delivery)
  status = startFrontier(delivery, status).status
  status = completeNode(delivery, status, 'planner').status
  status = completeNode(delivery, status, 'writer').status
  return status
}

test('a delivery run walks in order and the parallel layer joins before Deployer', () => {
  let status = freshStatus(delivery)
  assert.deepEqual(layerMarks(delivery, status), ['queued', 'queued', 'queued', 'queued', 'queued'])

  status = startFrontier(delivery, status).status
  assert.equal(status.planner, 'running')
  assert.equal(status.writer, 'queued')

  status = completeNode(delivery, status, 'planner').status
  assert.equal(status.planner, 'done')
  assert.equal(status.writer, 'running')
  assert.equal(status.coder, 'queued')

  status = completeNode(delivery, status, 'writer').status
  assert.equal(status.coder, 'running')
  assert.equal(doneCount(status), 2)

  const opened = completeNode(delivery, status, 'coder')
  status = opened.status
  assert.deepEqual(opened.started, ['reviewer', 'tester'])
  assert.equal(status.reviewer, 'running')
  assert.equal(status.tester, 'running')
  assert.equal(status.deployer, 'queued')

  const half = completeNode(delivery, status, 'reviewer')
  status = half.status
  assert.equal(half.joined, false)
  assert.deepEqual(half.started, [])
  assert.equal(status.reviewer, 'done')
  assert.equal(status.tester, 'running')
  assert.equal(status.deployer, 'queued')

  const joined = completeNode(delivery, status, 'tester')
  status = joined.status
  assert.equal(joined.joined, true)
  assert.deepEqual(joined.started, ['deployer'])
  assert.equal(status.deployer, 'running')

  const finished = completeNode(delivery, status, 'deployer')
  assert.equal(finished.finished, true)
  assert.equal(doneCount(finished.status), 6)
  assert.equal(chainLabel(delivery), 'Planner → Writer → Coder → Reviewer ‖ Tester → Deployer')
})

test('completing a Bot that is not running is refused, and a failed Bot blocks the join', () => {
  const status = runToCoder()
  const opened = completeNode(delivery, status, 'coder').status
  assert.throws(() => completeNode(delivery, opened, 'deployer'), /not running/)
  const failed = failNode(delivery, opened, 'tester').status
  assert.equal(failed.tester, 'failed')
  const afterReview = completeNode(delivery, failed, 'reviewer')
  assert.equal(afterReview.joined, false)
  assert.equal(afterReview.status.deployer, 'queued')
  const retried = retryNode(delivery, afterReview.status, 'tester').status
  assert.equal(retried.tester, 'running')
  const joined = completeNode(delivery, completeNode(delivery, retried, 'tester').status, 'deployer')
  assert.equal(joined.finished, true)
})

test('the demo step fails Tester once, then the join still waits for both branches', () => {
  let status = runToCoder()
  status = completeNode(delivery, status, 'coder').status
  const memory = { failedOnce: {} }
  const first = nextDemoOp(delivery, status, memory)
  assert.deepEqual(first, { type: 'fail', nodeId: 'tester' })
  status = failNode(delivery, status, 'tester').status
  memory.failedOnce.tester = true
  assert.deepEqual(nextDemoOp(delivery, status, memory), { type: 'retry', nodeId: 'tester' })
  status = retryNode(delivery, status, 'tester').status
  assert.deepEqual(nextDemoOp(delivery, status, memory), { type: 'complete', nodeId: 'reviewer' })
  status = completeNode(delivery, status, 'reviewer').status
  assert.equal(status.deployer, 'queued')
  assert.deepEqual(nextDemoOp(delivery, status, memory), { type: 'complete', nodeId: 'tester' })
})

test('a weekly graph has no fail-once step, and a node cannot sit in two layers', () => {
  const weekly = weeklyWorkflow()
  let status = startFrontier(weekly, freshStatus(weekly)).status
  assert.deepEqual(nextDemoOp(weekly, status, {}), { type: 'complete', nodeId: 'researcher' })
  assert.throws(() => validateGraph({
    nodes: [{ id: 'planner', name: 'Planner' }],
    layers: [['planner'], ['planner']],
  }), /more than one step|listed twice|belongs to one step/)
})

test('moving a node keeps the edges, and reconnecting a join changes who Deployer waits for', () => {
  const graph = normalizeGraph(delivery)
  const moved = moveNode(graph, 'coder', 40, 220)
  assert.equal(moved.nodes.find(node => node.id === 'coder').x, 40)
  assert.equal(moved.nodes.find(node => node.id === 'coder').y, 220)
  assert.ok(moved.edges.some(edge => edge.from === 'coder' && edge.to === 'reviewer'))
  assert.equal(moved.nodes.find(node => node.id === 'planner').x, graph.nodes.find(node => node.id === 'planner').x)

  const dropped = removeEdge(moved, 'coder', 'tester')
  const rejoined = connectNodes(dropped, 'writer', 'tester')
  let status = freshStatus(rejoined)
  status = startFrontier(rejoined, status).status
  status = completeNode(rejoined, status, 'planner').status
  const afterWriter = completeNode(rejoined, status, 'writer')
  assert.ok(afterWriter.started.includes('tester'))
  assert.ok(afterWriter.started.includes('coder'))
  status = afterWriter.status
  status = completeNode(rejoined, status, 'coder').status
  assert.equal(status.deployer, 'queued')
  status = completeNode(rejoined, status, 'reviewer').status
  assert.equal(status.deployer, 'queued')
  status = completeNode(rejoined, status, 'tester').status
  assert.equal(status.deployer, 'running')

  assert.throws(() => connectNodes(rejoined, 'deployer', 'planner'), /cycle/)
  const swapped = reconnectEdge(rejoined, 'tester', 'deployer', 'reviewer')
  assert.ok(swapped.edges.some(edge => edge.from === 'tester' && edge.to === 'reviewer'))
  assert.equal(swapped.edges.some(edge => edge.from === 'tester' && edge.to === 'deployer'), false)
})

test('a canvas can add and remove a local Bot without losing the other seats', () => {
  const graph = normalizeGraph(delivery)
  const added = addNode(graph, { id: 'n7', name: 'Docs', botId: 'bot-docs', x: 12, y: 40 })
  assert.equal(added.nodes.at(-1).id, 'n7')
  assert.equal(added.nodes.at(-1).x, 12)
  const linked = connectNodes(added, 'deployer', 'n7')
  assert.equal(linked.layers.at(-1)[0], 'n7')
  const removed = removeNode(linked, 'n7')
  assert.equal(removed.nodes.some(node => node.id === 'n7'), false)
  assert.equal(removed.edges.some(edge => edge.to === 'n7'), false)
  assert.equal(removed.nodes.length, 6)
  assert.throws(() => addNode(graph, { id: 'planner', name: 'Planner' }), /listed twice/)
})

test('the sidebar line names a live running Bot, never a demo script', () => {
  const status = runToCoder()
  const live = { status: 'running', live: true, nodeStatus: status, task: { id: '#1280', title: 'notice' } }
  assert.equal(rowPreview(delivery, live), 'Coder 正在处理 #1280…')
  const demo = { status: 'running', nodeStatus: status, task: { id: '#1280', title: 'notice' } }
  assert.equal(rowPreview(delivery, demo), '等待任务')
  const paused = { ...live, paused: true }
  assert.equal(rowPreview(delivery, paused), '已暂停 · Coder · #1280')
  assert.equal(rowPreview(weeklyWorkflow(), { status: 'done', live: true, nodeStatus: {}, task: { id: 'W42' } }), '下次运行：周五 17:00')
  assert.equal(rowPreview(delivery, null), '等待任务')
  assert.equal(summarizeTask({ id: '#9', title: 'a'.repeat(120) }).length <= 80, false)
})

test('a long task label keeps its whole title and never ends in a lone surrogate', () => {
  const plain = 'a'.repeat(120)
  assert.equal(summarizeTask({ id: '#9', title: plain }), `#9 · ${plain}`)

  // 71 units then an astral pair: the old 72-unit cap split the pair in half.
  const astralTitle = `${'发布说明'.repeat(17)}验收命🚀`
  const astral = summarizeTask({ id: '#9', title: astralTitle })
  assert.equal(astral, `#9 · ${astralTitle}`)
  assert.equal(astral.includes('\uFFFD'), false)
  assert.equal(hasLoneSurrogate(astral), false, 'summarizeTask left a lone surrogate in the label')

  // cleanLine still cuts when it must, but on code points.
  assert.equal(cleanLine('🚀'.repeat(10), 7), '🚀'.repeat(7))
  assert.equal(hasLoneSurrogate(cleanLine('🚀'.repeat(10), 7)), false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addNode, chainLabel, cleanLine, cleanPrompt, completeNode, connectNodes, cutCodePoints, doneCount, edgeOutputs, failNode, freshStatus,
  layerMarks, missingVerdicts, moveNode, nextDemoOp, normalizeGraph, readStepResult, reconnectEdge, removeEdge, removeNode, retryNode,
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

test('a node prompt and a step reply stop on the bound without splitting the character there', () => {
  // #1588 moved cleanLine's cut onto code points; the prompt and the step body
  // still counted UTF-16 units, so a cut inside one astral character left a lone
  // surrogate — the prompt a Bot was told to follow, and its own reply, carried
  // half a character. The bound counts code points here too, so a character that
  // fits stays whole instead of being half-kept or dropped.
  const fitting = `${'a'.repeat(3999)}🚀`
  const prompt = cleanPrompt(fitting, 4000)
  assert.equal(prompt, fitting, 'a character that fits the bound is kept whole')
  assert.equal(hasLoneSurrogate(prompt), false, 'cleanPrompt left a lone surrogate at the bound')

  const over = cleanPrompt(`${'a'.repeat(4000)}🚀`, 4000)
  assert.equal(over, 'a'.repeat(4000), 'the character past the bound goes whole, never half')
  assert.equal(hasLoneSurrogate(over), false, 'cleanPrompt left a lone surrogate when it must drop one')

  const reply = `${'a'.repeat(1999)}🚀`
  const step = readStepResult(reply, { outputs: [] })
  assert.equal(step.text, reply, 'the step body keeps the whole last character')
  assert.equal(hasLoneSurrogate(step.text), false, 'readStepResult left a lone surrogate in the body')
})

// #2581: the plugin's own bound judges characters, not UTF-16 units.
test('#2581: cutCodePoints counts characters, not UTF-16 units', () => {
  assert.equal(cutCodePoints('🚀Dev', 1), '🚀')
  assert.equal(cutCodePoints('🚀Dev', 10), '🚀Dev')
  assert.equal(cutCodePoints('🚀'.repeat(3), 2), '🚀🚀')
  assert.equal(cutCodePoints('🚀'.repeat(3), 2).isWellFormed(), true)
  // A value that already carried an unpaired surrogate is flattened, never stored as one.
  assert.equal(cutCodePoints('a\uD800b', 10).isWellFormed(), true)
  assert.equal(cutCodePoints(undefined, 5), '')
})

// #2669: the gate reads the outputs of a node's outgoing edges, so the list has to
// be readable from the graph the same way missingVerdicts reads it.
test('#2669: edgeOutputs names the OUTPUT every outgoing edge reads, with its values', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'triage', name: 'Triage' },
      { id: 'review', name: 'Review' },
      { id: 'claim', name: 'Claim' },
      { id: 'escalate', name: 'Escalate' },
      { id: 'fix', name: 'Fix' },
      { id: 'done', name: 'Done' },
    ],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'fix', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { output: 'state', eq: 'blocked' } },
      { from: 'triage', to: 'done', when: { else: true } },
      { from: 'review', to: 'claim', when: { output: 'verdict', eq: 'PASS' } },
      { from: 'claim', to: 'done' },
    ],
  })
  assert.deepEqual(edgeOutputs(graph, 'triage'), [{ name: 'state', values: ['ready', 'blocked'] }],
    'one entry per output name: values in edge order, deduped, and `else` contributes nothing')
  assert.deepEqual(edgeOutputs(graph, 'review'), [{ name: 'verdict', values: ['PASS'] }])
  assert.deepEqual(edgeOutputs(graph, 'claim'), [], 'a node whose edges read no output names none')
  assert.deepEqual(edgeOutputs(graph, 'nope'), [])
})

// #2685: a node whose only gate is its loop's `until` is failed by missingVerdicts for
// a line it was never told to print, because edgeOutputs read only `when` edges. The
// two must name the same set for that node.
test('#2685: edgeOutputs offers a loop until port, and missingVerdicts agrees', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'scout', name: 'Scout' },
      { id: 'finish', name: 'Finish' },
    ],
    edges: [
      { from: 'scout', to: 'scout', loop: true, max: 3, until: { output: 'ready', eq: 'yes' } },
      { from: 'scout', to: 'finish' },
    ],
  })
  assert.deepEqual(edgeOutputs(graph, 'scout'), [{ name: 'ready', values: ['yes'] }],
    'the loop until port is named with the value it compares against')
  assert.deepEqual(missingVerdicts(graph, 'scout', {}), ['ready'])
  assert.deepEqual(edgeOutputs(graph, 'scout').map(port => port.name), missingVerdicts(graph, 'scout', {}),
    'the outputs a node owes and the ones it is told to print are the same set')
  assert.deepEqual(missingVerdicts(graph, 'scout', { ready: 'yes' }), [])
})

test('#2685: until values dedupe into the when entry of the same name', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    edges: [
      { from: 'a', to: 'b', when: { output: 'state', eq: 'ready' } },
      { from: 'a', to: 'a', loop: true, max: 2, until: { output: 'state', eq: 'done' } },
    ],
  })
  assert.deepEqual(edgeOutputs(graph, 'a'), [{ name: 'state', values: ['ready', 'done'] }],
    'one entry per name, values in edge order, deduped the same way as when')
})

// #2746 S4: 12 steps per workflow. `place > 11` is the cap on a chain's rank; a
// 13th rank used to be accepted and stored, and `stepBudget` is sized for 12.
test('a graph longer than 12 steps is refused', () => {
  const nodes = Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, name: `Step ${index}` }))
  const edges = nodes.slice(1).map((node, index) => ({ from: `s${index}`, to: node.id }))
  assert.throws(() => normalizeGraph({ nodes, edges }), /at most 12 steps/)
})

// #2746 S5: 24 Bots per workflow. The count is checked before the ranks, so a
// 25th Bot is refused even when every step it would join has room.
test('a graph with 25 Bots is refused', () => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({ id: `n${index}`, name: `Bot ${index}` }))
  const layers = [0, 1, 2, 3, 4].map(row => nodes.slice(row * 5, row * 5 + 5).map(node => node.id))
  assert.throws(() => normalizeGraph({ nodes, layers }), /at most 24 Bots/)
})

// #2746 S6: 64 links per workflow. Six Bots in the first step wired to six in the
// second is already 36; the extra 30 to the third step makes 66.
test('a graph with 66 links is refused', () => {
  const ids = step => Array.from({ length: 6 }, (_, index) => `${step}${index}`)
  const first = ids('a')
  const second = ids('b')
  const third = ids('c')
  const edges = []
  for (const from of first) for (const to of second) edges.push({ from, to })
  for (const from of second) for (const to of third.slice(0, 5)) edges.push({ from, to })
  assert.equal(edges.length, 66, 'the fixture really carries 66 links')
  const nodes = [...first, ...second, ...third].map(id => ({ id, name: id.toUpperCase() }))
  assert.throws(() => normalizeGraph({ nodes, edges }), /at most 64 links/)
})

// #2746 S7: a node coordinate is clamped to the drawable box. A stored x/y that a
// hand edit or an older board wrote far outside it used to be kept as-is, and the
// canvas drew the node where nothing can scroll to it.
test('a node coordinate is clamped to the drawable box', () => {
  const graph = normalizeGraph({ nodes: [{ id: 'only', name: 'Only', x: 99999, y: -99999 }], edges: [] })
  assert.equal(graph.nodes[0].x, 4000, 'x stops at the right edge of the box')
  assert.equal(graph.nodes[0].y, -2000, 'y stops at the top edge of the box')
})

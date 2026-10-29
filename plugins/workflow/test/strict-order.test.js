// Strict order (#1729): a graph the operator marks strict walks its nodes in the declared order
// with no parallel fan-out, and the release-shaped graph keeps working unchanged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeNode, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'
import { deliveryWorkflow } from '../src/template.js'

const parallel = {
  nodes: [
    { id: 'planner', name: 'Planner' },
    { id: 'writer', name: 'Writer' },
    { id: 'coder', name: 'Coder' },
  ],
  edges: [
    { from: 'planner', to: 'writer' },
    { from: 'planner', to: 'coder' },
  ],
}

test('a strict graph starts one node at a time in declared order (#1729)', () => {
  const graph = normalizeGraph({ ...parallel, strict: true })
  assert.equal(graph.strict, true, 'the option survives normalization')
  const first = startFrontier(graph, freshStatus(graph))
  assert.deepEqual(first.started, ['planner'], 'one node, not every root')
  assert.equal(first.status.writer, 'queued')
  assert.equal(first.status.coder, 'queued')
  const afterPlanner = completeNode(graph, first.status, 'planner')
  assert.deepEqual(afterPlanner.started, ['writer'], 'declared order decides the next one')
  assert.equal(afterPlanner.status.writer, 'running')
  assert.equal(afterPlanner.status.coder, 'queued', 'the sibling waits its turn')
  const afterWriter = completeNode(graph, afterPlanner.status, 'writer')
  assert.deepEqual(afterWriter.started, ['coder'])
  const done = completeNode(graph, afterWriter.status, 'coder')
  assert.equal(done.finished, true)
})

test('the same graph without strict still fans out (#1729)', () => {
  const graph = normalizeGraph(parallel)
  assert.equal(graph.strict, false)
  const first = startFrontier(graph, freshStatus(graph))
  assert.deepEqual(first.started, ['planner'])
  const afterPlanner = completeNode(graph, first.status, 'planner')
  assert.deepEqual(afterPlanner.started, ['writer', 'coder'], 'the default stays parallel')
})

test('the release-shaped delivery graph passes unchanged (#1729)', () => {
  const graph = normalizeGraph(deliveryWorkflow())
  assert.equal(graph.strict, false)
  const first = startFrontier(graph, freshStatus(graph))
  assert.deepEqual(first.started, ['planner'])
  const afterPlanner = completeNode(graph, first.status, 'planner')
  assert.ok(afterPlanner.started.length >= 1)
})

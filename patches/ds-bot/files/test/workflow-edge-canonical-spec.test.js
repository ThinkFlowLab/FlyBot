// One fact has one key (#1291 debt): `text: draft` and `text:draft` are the same fact, and every
// consumer/producer rule in the engine reads the node lists through `canonicalSpec`. The edge
// alignment check was the one place that compared the edge's canonical artifact against the raw
// lists, so a definition the engine can run was still refused (#2425).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifact } from '../src/shared/artifact.js'
import { dependencyEdges, enterNode, validateWorkflow } from '../src/shared/workflow.js'

const definition = (producerSpec, edgeFrom, edgeTo, consumerSpec) => ({
  id: 'draft-publish',
  name: 'Draft and publish',
  version: 1,
  inputs: [],
  deliverables: ['link:published'],
  nodes: [
    { id: 'draft', name: 'Draft', role: 'Writer', outputs: [producerSpec] },
    { id: 'publish', name: 'Publish', role: 'Publisher', inputs: [consumerSpec], outputs: ['link:published'] },
  ],
  edges: [{ from: edgeFrom, to: edgeTo }],
  loops: [],
})

test('a space on the node and none on its edge is still one fact', () => {
  const def = definition('text: draft', 'draft.text:draft', 'publish.text:draft', 'text:draft')
  const result = validateWorkflow(def)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.deepEqual(dependencyEdges(def), [{ from: 'draft', to: 'publish' }])
  const taken = enterNode(def, 'publish', {
    present: { 'text:draft': artifact('text:draft', 'abc1234') },
    current: { 'text:draft': 'abc1234' },
  })
  assert.equal(taken.ok, true, taken.refusal)
})

test('a space on the consumer and none on the edge is still one fact', () => {
  const def = definition('text:draft', 'draft.text:draft', 'publish.text:draft', 'text: draft')
  const result = validateWorkflow(def)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
})

test('the same fact with the space moved to the edge is one fact too', () => {
  const def = definition('text:draft', 'draft.text: draft', 'publish.text:draft', 'text:draft')
  const result = validateWorkflow(def)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
})

test('an edge that carries a fact the consumer does not take in is still refused (control)', () => {
  const def = definition('text:draft', 'draft.text:draft', 'publish.text:other', 'text:draft')
  const result = validateWorkflow(def)
  assert.equal(result.ok, false)
  assert.ok(
    result.problems.some((problem) => problem.code === 'edge/misaligned' || problem.code === 'edge/unknown-end'),
    JSON.stringify(result.problems),
  )
})

// An edge names one fact at each end, and a definition may spell that fact with a space (#1272,
// #1298). Everything that decides whether a definition can run keys on the parsed spec
// (`canonicalSpec`), so `text: draft` and `text:draft` are one fact on an edge too: a definition
// that mixes the two spellings between a node and its edge is runnable and must not be refused as
// misaligned. A genuinely crossed edge is still refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateWorkflow } from '../src/shared/workflow.js'

const definition = (edge) => ({
  id: 'draft-publish',
  name: 'Draft and publish',
  version: 1,
  inputs: [],
  deliverables: ['link:published'],
  nodes: [
    // The producer spells the fact with a space; the consumer spells it without one.
    { id: 'draft', name: 'Draft', role: 'Writer', outputs: ['text: draft'] },
    { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
  ],
  edges: [edge],
  loops: [],
})

test('an edge lines up when its two ends spell one fact differently', () => {
  // The edge uses the consumer's spelling against the producer's spaced one.
  const spacedNode = validateWorkflow(definition({ from: 'draft.text:draft', to: 'publish.text:draft' }))
  assert.equal(spacedNode.ok, true, JSON.stringify(spacedNode.problems))
  // The edge uses the producer's spaced spelling against the consumer's canonical one.
  const spacedEdge = validateWorkflow(definition({ from: 'draft.text: draft', to: 'publish.text:draft' }))
  assert.equal(spacedEdge.ok, true, JSON.stringify(spacedEdge.problems))
})

test('an edge that really does not line up is still refused', () => {
  const crossed = validateWorkflow(definition({ from: 'draft.text:draft', to: 'publish.link:published' }))
  assert.equal(crossed.ok, false)
  assert.ok(
    crossed.problems.some((problem) => problem.code === 'edge/misaligned' || problem.code === 'edge/unknown-end'),
    JSON.stringify(crossed.problems),
  )
})

// #1542: an onFail edge's `max` counts recoveries. max: 1 must recover once;
// the run fails permanently only after those recoveries are used.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { failNode, normalizeGraph } from '../src/graph.js'

function chain(max) {
  return normalizeGraph({
    nodes: [
      { id: 'draft', name: 'Draft' },
      { id: 'copy', name: 'Copy' },
      { id: 'review', name: 'Review' },
    ],
    edges: [
      { from: 'draft', to: 'copy' },
      { from: 'copy', to: 'review' },
      { from: 'review', to: 'draft', onFail: true, max },
    ],
  })
}

// The state just before Review fails on a three-node chain. It is rebuilt for
// each attempt so this test does not depend on how the recovered body is reset.
function reviewRunning() {
  return { draft: 'done', copy: 'done', review: 'running' }
}

describe('Failure recovery attempts', () => {
  it('max: 1 recovers on the first failure and records one attempt', () => {
    const graph = chain(1)
    const result = failNode(graph, reviewRunning(), 'review', { failAttempts: {} })

    assert.equal(result.recovered, true)
    assert.equal(result.failAttempts['review>draft'], 1)
    assert.equal(result.status.draft, 'running')
    assert.equal(result.status.review, 'queued')
  })

  it('max: 1 fails permanently on the next failure and keeps the count at max', () => {
    const graph = chain(1)
    const result = failNode(graph, reviewRunning(), 'review', { failAttempts: { 'review>draft': 1 } })

    assert.equal(result.recovered, undefined)
    assert.equal(result.status.review, 'failed')
    assert.equal(result.failAttempts['review>draft'], 1)
  })

  it('max: 2 recovers twice and then fails permanently', () => {
    const graph = chain(2)
    const first = failNode(graph, reviewRunning(), 'review', { failAttempts: {} })
    assert.equal(first.recovered, true)
    assert.equal(first.failAttempts['review>draft'], 1)

    const second = failNode(graph, reviewRunning(), 'review', { failAttempts: first.failAttempts })
    assert.equal(second.recovered, true)
    assert.equal(second.failAttempts['review>draft'], 2)

    const third = failNode(graph, reviewRunning(), 'review', { failAttempts: second.failAttempts })
    assert.equal(third.recovered, undefined)
    assert.equal(third.status.review, 'failed')
    assert.equal(third.failAttempts['review>draft'], 2)
  })
})

// Failure recovery: when a node fails, return upstream and retry (e.g. Review fail → Rework).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { completeNode, failNode, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'

describe('Failure recovery', () => {
  it('fails without recovery edge when node fails', () => {
    const graph = normalizeGraph({
      nodes: [
        { id: 'a', name: 'First' },
        { id: 'b', name: 'Second' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    })

    let status = freshStatus(graph)
    status = startFrontier(graph, status).status
    status = completeNode(graph, status, 'a').status

    const failed = failNode(graph, status, 'b')
    
    assert.equal(failed.status.b, 'failed')
    assert.equal(failed.recovered, undefined)
  })

  it('recovers to upstream node when onFail edge exists', () => {
    const graph = normalizeGraph({
      nodes: [
        { id: 'draft', name: 'Draft' },
        { id: 'review', name: 'Review' },
        { id: 'publish', name: 'Publish' },
      ],
      edges: [
        { from: 'draft', to: 'review' },
        { from: 'review', to: 'publish' },
        { from: 'review', to: 'draft', onFail: true, max: 2 },
      ],
    })

    let status = freshStatus(graph)
    status = startFrontier(graph, status).status
    status = completeNode(graph, status, 'draft').status

    // Fail review (first time) - should recover to draft
    const recovered = failNode(graph, status, 'review', { failAttempts: {} })

    assert.equal(recovered.recovered, true)
    assert.deepEqual(recovered.started, ['draft'])
    assert.equal(recovered.status.draft, 'running')
    assert.equal(recovered.status.review, 'queued')
    assert.equal(recovered.failAttempts['review>draft'], 1)
    
    // Complete draft again after recovery
    const secondDraft = completeNode(graph, recovered.status, 'draft')
    assert.equal(secondDraft.status.draft, 'done')
    assert.equal(secondDraft.status.review, 'running')
  })

  it('fails after max attempts exhausted', () => {
    const graph = normalizeGraph({
      nodes: [
        { id: 'draft', name: 'Draft' },
        { id: 'review', name: 'Review' },
      ],
      edges: [
        { from: 'draft', to: 'review' },
        { from: 'review', to: 'draft', onFail: true, max: 3 },
      ],
    })

    let status = freshStatus(graph)
    let failAttempts = {}
    
    // First attempt: draft → review (fail) → draft (recovery 1)
    status = startFrontier(graph, status).status
    status = completeNode(graph, status, 'draft').status
    let result = failNode(graph, status, 'review', { failAttempts })
    assert.equal(result.recovered, true)
    status = result.status
    failAttempts = result.failAttempts
    assert.equal(failAttempts['review>draft'], 1)

    // Second attempt: draft → review (fail) → draft (recovery 2)
    status = completeNode(graph, status, 'draft').status
    result = failNode(graph, status, 'review', { failAttempts })
    assert.equal(result.recovered, true)
    status = result.status
    failAttempts = result.failAttempts
    assert.equal(failAttempts['review>draft'], 2)

    // Third attempt: draft → review (fail) → draft (recovery 3)
    status = completeNode(graph, status, 'draft').status
    result = failNode(graph, status, 'review', { failAttempts })
    assert.equal(result.recovered, true)
    status = result.status
    failAttempts = result.failAttempts
    assert.equal(failAttempts['review>draft'], 3)

    // Fourth attempt: draft → review (fail) → STOP (max 3 recoveries used)
    status = completeNode(graph, status, 'draft').status
    result = failNode(graph, status, 'review', { failAttempts })

    assert.equal(result.recovered, undefined)
    assert.equal(result.status.review, 'failed')
    assert.equal(result.failAttempts['review>draft'], 3)
  })

  it('does not break existing failOnce behavior', () => {
    const graph = normalizeGraph({
      nodes: [
        { id: 'flaky', name: 'Flaky', failOnce: true },
      ],
      edges: [],
    })

    let status = freshStatus(graph)
    status = startFrontier(graph, status).status

    // failOnce is handled by service.js, not graph.js
    // At graph level, failNode just marks it as failed
    const failed = failNode(graph, status, 'flaky')

    assert.equal(failed.status.flaky, 'failed')
  })

  it('does not break existing loop edges', () => {
    const graph = normalizeGraph({
      nodes: [
        { id: 'body', name: 'Body', outputs: [{ name: 'done', type: 'text' }] },
        { id: 'next', name: 'Next' },
      ],
      edges: [
        { from: 'body', to: 'next' },
        { from: 'body', to: 'body', loop: true, max: 2, until: { output: 'done', eq: 'yes' } },
      ],
    })

    let status = freshStatus(graph)
    status = startFrontier(graph, status).status

    // First completion without 'done: yes' should loop
    const looped = completeNode(graph, status, 'body', {
      outputs: { done: 'no' },
      loops: {},
      fired: {},
    })

    assert.equal(looped.looped, true)
    assert.equal(looped.status.body, 'running')
    assert.equal(looped.loops['body>body'], 1)
  })
})

// #1541: a failure recovery resets every node from the recovery target through
// the failing node. A chain longer than the onFail edge's two ends must re-run
// its middle nodes too, or the retry feeds the failing node stale output.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { completeNode, failNode, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

function chain() {
  return normalizeGraph({
    nodes: [
      { id: 'draft', name: 'Draft' },
      { id: 'copy', name: 'Copy' },
      { id: 'review', name: 'Review' },
    ],
    edges: [
      { from: 'draft', to: 'copy' },
      { from: 'copy', to: 'review' },
      { from: 'review', to: 'draft', onFail: true, max: 3 },
    ],
  })
}

describe('Failure recovery body', () => {
  it('a recovered run resets the nodes between the target and the failing node', () => {
    const graph = chain()
    let status = freshStatus(graph)
    status = startFrontier(graph, status).status
    status = completeNode(graph, status, 'draft').status
    status = completeNode(graph, status, 'copy').status
    assert.equal(status.review, 'running')

    const recovered = failNode(graph, status, 'review', { failAttempts: {} })

    assert.equal(recovered.recovered, true)
    assert.deepEqual(recovered.reset.slice().sort(), ['copy', 'draft', 'review'])
    assert.equal(recovered.status.draft, 'running')
    assert.equal(recovered.status.copy, 'queued')
    assert.equal(recovered.status.review, 'queued')

    // The second pass walks draft -> copy -> review again. A done copy would
    // skip straight back to review with the output the rejection was about.
    const second = completeNode(graph, recovered.status, 'draft')
    assert.equal(second.status.copy, 'running')
    assert.deepEqual(second.started, ['copy'])
  })

  it('a recovered live run re-runs the middle node instead of feeding stale output', async () => {
    const spawned = []
    const released = []
    const dispatched = []
    let seq = 0
    const roster = [{ id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false }]
    const svc = createWorkflowService({
      persist: false,
      now: () => 1_700_000_000_000,
      bots: () => roster,
      spawn: async (spec) => {
        const id = `eph-${++seq}`
        spawned.push({ id, spec })
        return id
      },
      release: async (id) => { released.push(id) },
      dispatch: async (step) => {
        dispatched.push({ nodeId: step.nodeId, botId: step.botId })
        return { ok: true }
      },
    })
    const made = svc.define({
      name: 'Recovery chain',
      nodes: [
        { id: 'draft', name: 'Draft', prompt: 'Write it.' },
        { id: 'copy', name: 'Copy', prompt: 'Polish it.' },
        { id: 'review', name: 'Review', prompt: 'Judge it.' },
      ],
      edges: [
        { from: 'draft', to: 'copy' },
        { from: 'copy', to: 'review' },
        { from: 'review', to: 'draft', onFail: true, max: 3 },
      ],
    }).workflows.find(item => item.name === 'Recovery chain')
    const runOf = (view) => view.workflows.find(item => item.id === made.id).run

    const started = await svc.runNamed({ workflow: 'Recovery chain', brief: 'Ship the note' })
    assert.equal(runOf(started).nodeStatus.draft, 'running')
    const mid = await svc.advance({ workflowId: made.id, nodeId: 'draft', outcome: 'done' })
    assert.equal(runOf(mid).nodeStatus.copy, 'running')
    const late = await svc.advance({ workflowId: made.id, nodeId: 'copy', outcome: 'done' })
    assert.equal(runOf(late).nodeStatus.review, 'running')

    const failed = await svc.advance({ workflowId: made.id, nodeId: 'review', outcome: 'failed' })
    const parked = runOf(failed)
    assert.equal(parked.status, 'running')
    assert.equal(parked.nodeStatus.draft, 'running')
    assert.equal(parked.nodeStatus.copy, 'queued')
    assert.equal(parked.nodeStatus.review, 'queued')
    assert.equal(dispatched.filter(step => step.nodeId === 'copy').length, 1)

    const redraft = await svc.advance({ workflowId: made.id, nodeId: 'draft', outcome: 'done' })
    assert.equal(runOf(redraft).nodeStatus.copy, 'running')
    assert.equal(dispatched.filter(step => step.nodeId === 'copy').length, 2)

    const recopy = await svc.advance({ workflowId: made.id, nodeId: 'copy', outcome: 'done' })
    assert.equal(runOf(recopy).nodeStatus.review, 'running')
    assert.equal(dispatched.filter(step => step.nodeId === 'review').length, 2)
    assert.deepEqual(released, [])
  })
})

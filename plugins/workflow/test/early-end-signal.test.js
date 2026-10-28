// #1546: only a structured signal ends a run early. A step that mentions the
// markers while it works on them -- quoting an issue title, negating the label,
// reporting it absent -- must not stop its own run.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { normalizeGraph } from '../src/graph.js'

const roster = [
  { id: 'bot-triage', name: 'Triage', role: 'Triage', remote: false },
  { id: 'bot-implement', name: 'Implement', role: 'Implement', remote: false },
]

// triage -> implement, so a run that must not end is still `running` with
// `implement` dispatched by the time `advance` answers.
function pipeline() {
  return normalizeGraph({
    id: 'triage-then-implement',
    name: 'Triage then implement',
    nodes: [
      { id: 'triage', name: 'Triage', role: 'Triage', instructions: 'Triage the issue', outputs: [{ name: 'status', type: 'text' }] },
      { id: 'implement', name: 'Implement', role: 'Implement', instructions: 'Implement the fix', inputs: [{ name: 'status', type: 'text' }] },
    ],
    edges: [{ from: 'triage', to: 'implement' }],
  })
}

function started() {
  const svc = createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster })
  const graph = pipeline()
  const created = svc.create({ name: graph.name, nodes: graph.nodes, edges: graph.edges })
  const workflowId = created.workflows.find(w => w.name === graph.name).id
  svc.assign({ workflowId, taskId: '#1600', title: 'A task' })
  return { svc, workflowId }
}

function advance(svc, workflowId, { text, outputs }) {
  const state = svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', text, outputs })
  return state.workflows.find(w => w.id === workflowId).run
}

describe('Early end needs a structured signal', () => {
  it('does not end the run when the reply quotes an issue title', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'Working on #1538: "runs now end when any step marks an issue as needs-human" — implementing the detector.',
      outputs: { status: 'agent-ready' },
    })

    assert.equal(run.status, 'running')
    assert.equal(run.earlyEnd, undefined)
    assert.equal(run.nodeStatus.implement, 'running')
  })

  it('does not end the run when the reply negates the label', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'No needs-human label on this issue; it is ready for implementation.',
      outputs: { status: 'agent-ready' },
    })

    assert.equal(run.status, 'running')
    assert.equal(run.earlyEnd, undefined)
    assert.equal(run.nodeStatus.implement, 'running')
  })

  it('does not end the run when the reply reports the label as absent', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'Checked labels: needs-human = absent. Proceeding.',
      outputs: { status: 'agent-ready' },
    })

    assert.equal(run.status, 'running')
    assert.equal(run.earlyEnd, undefined)
    assert.equal(run.nodeStatus.implement, 'running')
  })

  it('does not end the run when a sentence merely mentions the already-claimed rule', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'This issue is not already claimed: no agent-working label and no Claimed-by comment.',
      outputs: { status: 'agent-ready' },
    })

    assert.equal(run.status, 'running')
    assert.equal(run.earlyEnd, undefined)
    assert.equal(run.nodeStatus.implement, 'running')
  })

  it('ends the run when a declared output equals the marker', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'Triage complete.',
      outputs: { status: 'Needs-Human' },
    })

    assert.notEqual(run.status, 'running')
    assert.equal(run.earlyEnd, 'needs-human')
    assert.notEqual(run.nodeStatus.implement, 'running')
  })

  it('ends the run on a line that owns the directive', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'Triage complete.\n\nEARLY-END needs-human\n\nThe scope needs the owner.',
      outputs: { status: 'blocked' },
    })

    assert.notEqual(run.status, 'running')
    assert.equal(run.earlyEnd, 'needs-human')
    assert.notEqual(run.nodeStatus.implement, 'running')
  })

  it('ends the run on a line that owns the already-claimed directive', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'Claim check finished.\nearly-end ALREADY-CLAIMED\n',
      outputs: { status: 'blocked' },
    })

    assert.notEqual(run.status, 'running')
    assert.equal(run.earlyEnd, 'already-claimed')
    assert.notEqual(run.nodeStatus.implement, 'running')
  })

  it('does not end the run when the directive appears inside a sentence', () => {
    const { svc, workflowId } = started()
    const run = advance(svc, workflowId, {
      text: 'The step documents the directive EARLY-END needs-human for later, and carries on.',
      outputs: { status: 'agent-ready' },
    })

    assert.equal(run.status, 'running')
    assert.equal(run.earlyEnd, undefined)
    assert.equal(run.nodeStatus.implement, 'running')
  })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { normalizeGraph } from '../src/graph.js'

const roster = [
  { id: 'bot-triage', name: 'Triage', role: 'Triage', remote: false },
  { id: 'bot-claim', name: 'Claim', role: 'Claim', remote: false },
  { id: 'bot-implement', name: 'Implement', role: 'Implement', remote: false },
]

function service(extra = {}) {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster, ...extra })
}

function deliveryPipeline() {
  const graph = normalizeGraph({
    id: 'delivery-pipeline',
    name: 'Issue Delivery Pipeline',
    nodes: [
      { id: 'triage', name: 'Triage', role: 'Triage', instructions: 'Triage the issue', outputs: [{ name: 'status', type: 'text' }] },
      { id: 'claim', name: 'Claim', role: 'Claim', instructions: 'Claim the issue', inputs: [{ name: 'status', type: 'text' }], outputs: [{ name: 'claimed', type: 'text' }] },
      { id: 'implement', name: 'Implement', role: 'Implement', instructions: 'Implement the fix', inputs: [{ name: 'claimed', type: 'text' }], outputs: [{ name: 'pr', type: 'text' }] },
    ],
    edges: [{ from: 'triage', to: 'claim' }, { from: 'claim', to: 'implement' }],
  })
  return graph
}

test('#1537: Claim step skips when issue already claimed (agent-working label)', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1513', title: 'Fix overflow bug' })
  assert.equal(assigned.ok, true)
  assert.equal(assigned.workflows.find(w => w.id === workflow.id).run.nodeStatus.triage, 'running')
  
  // Triage completes
  svc.advance({ workflowId: workflow.id, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  assert.equal(svc.state().workflows.find(w => w.id === workflow.id).run.nodeStatus.claim, 'running')
  
  // Claim Bot replies that issue is already claimed (simulate with advance, since we don't have ephemeral bots in this test)
  const claimResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Issue already claimed by HugoXK/FlyBot Lead. Found agent-working label and Claimed-by comment.',
    outputs: { claimed: 'already-claimed' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflow.id).run
  // Should skip/complete Claim without claiming again
  assert.equal(run.nodeStatus.claim, 'done')
  // Should NOT advance to Implement since the issue is claimed by another agent
  assert.notEqual(run.nodeStatus.implement, 'running')
  // Run should end (failed or done) rather than proceed
  assert.ok(run.status === 'done' || run.status === 'failed')
})

test('#1537: Claim step skips when open PR already exists fixing the issue', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1514', title: 'Another bug' })
  svc.advance({ workflowId: workflow.id, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim Bot finds an existing PR
  const claimResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Found open PR #1533 that fixes this issue.',
    outputs: { claimed: 'already-claimed' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflow.id).run
  assert.equal(run.nodeStatus.claim, 'done')
  assert.ok(run.status === 'done' || run.status === 'failed')
})

test('#1537: Claim step proceeds normally when issue is not claimed', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1520', title: 'Unclaimed bug' })
  svc.advance({ workflowId: workflow.id, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim Bot successfully claims
  const claimResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Successfully claimed issue #1520.',
    outputs: { claimed: 'success' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflow.id).run
  assert.equal(run.nodeStatus.claim, 'done')
  assert.equal(run.nodeStatus.implement, 'running')
  assert.equal(run.status, 'running')
})

test('#1538: Triage step marking needs-human ends the workflow run', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1506', title: 'Needs human decision' })
  
  // Triage marks needs-human
  const triageResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'triage',
    outcome: 'done',
    text: 'This issue needs owner design decision on API surface.',
    outputs: { status: 'needs-human' },
  })
  
  const run = triageResult.workflows.find(w => w.id === workflow.id).run
  // Run should end (not keep running)
  assert.notEqual(run.status, 'running')
  assert.ok(run.status === 'done' || run.status === 'failed')
  // Triage node should be settled
  assert.ok(run.nodeStatus.triage === 'done' || run.nodeStatus.triage === 'skipped')
  // Subsequent nodes should not start
  assert.notEqual(run.nodeStatus.claim, 'running')
  assert.notEqual(run.nodeStatus.implement, 'running')
})

test('#1538: needs-human in any step ends the run', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1540', title: 'Issue needing human later' })
  svc.advance({ workflowId: workflow.id, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim discovers it needs human
  const claimResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Issue scope is unclear, needs maintainer clarification.',
    outputs: { claimed: 'needs-human' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflow.id).run
  assert.notEqual(run.status, 'running')
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.notEqual(run.nodeStatus.implement, 'running')
})

test('#1538: needs-human detection is case-insensitive and works in text body', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  svc.state().workflows.push(workflow)
  
  const assigned = svc.assign({ workflowId: workflow.id, taskId: '#1541', title: 'Another needs-human case' })
  
  // Various ways needs-human might appear - in text body (not just outputs)
  const triageResult = svc.advance({
    workflowId: workflow.id,
    nodeId: 'triage',
    outcome: 'done',
    text: 'This issue NEEDS-HUMAN review before proceeding with implementation.',
    outputs: { status: 'blocked' },
  })
  
  const run = triageResult.workflows.find(w => w.id === workflow.id).run
  assert.notEqual(run.status, 'running')
})

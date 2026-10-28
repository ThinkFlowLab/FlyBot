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
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  assert.equal(created.ok, true)
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1513', title: 'Fix overflow bug' })
  assert.equal(svc.state().workflows.find(w => w.id === workflowId).run.nodeStatus.triage, 'running')
  
  // Triage completes
  svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  assert.equal(svc.state().workflows.find(w => w.id === workflowId).run.nodeStatus.claim, 'running')
  
  // Claim Bot replies that issue is already claimed (simulate with advance, since we don't have ephemeral bots in this test)
  const claimResult = svc.advance({
    workflowId,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Issue already claimed by HugoXK/FlyBot Lead. Found agent-working label and Claimed-by comment.',
    outputs: { claimed: 'already-claimed' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflowId).run
  // Should skip/complete Claim without claiming again
  assert.equal(run.nodeStatus.claim, 'done')
  // Should NOT advance to Implement since the issue is claimed by another agent
  assert.notEqual(run.nodeStatus.implement, 'running')
  // Run should end (failed or done) rather than proceed
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.equal(run.earlyEnd, 'already-claimed')
})

test('#1537: Claim step skips when open PR already exists fixing the issue', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1514', title: 'Another bug' })
  svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim Bot finds an existing PR
  const claimResult = svc.advance({
    workflowId,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Found open PR #1533 that fixes this issue.',
    outputs: { claimed: 'already-claimed' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflowId).run
  assert.equal(run.nodeStatus.claim, 'done')
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.equal(run.earlyEnd, 'already-claimed')
})

test('#1537: Claim step proceeds normally when issue is not claimed', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1520', title: 'Unclaimed bug' })
  svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim Bot successfully claims
  const claimResult = svc.advance({
    workflowId,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Successfully claimed issue #1520.',
    outputs: { claimed: 'success' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflowId).run
  assert.equal(run.nodeStatus.claim, 'done')
  assert.equal(run.nodeStatus.implement, 'running')
  assert.equal(run.status, 'running')
  assert.equal(run.earlyEnd, undefined)
})

test('#1538: Triage step marking needs-human ends the workflow run', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1506', title: 'Needs human decision' })
  
  // Triage marks needs-human
  const triageResult = svc.advance({
    workflowId,
    nodeId: 'triage',
    outcome: 'done',
    text: 'This issue needs owner design decision on API surface.',
    outputs: { status: 'needs-human' },
  })
  
  const run = triageResult.workflows.find(w => w.id === workflowId).run
  // Run should end (not keep running)
  assert.notEqual(run.status, 'running')
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.equal(run.earlyEnd, 'needs-human')
  // Triage node should be settled
  assert.ok(run.nodeStatus.triage === 'done' || run.nodeStatus.triage === 'skipped')
  // Subsequent nodes should not start
  assert.notEqual(run.nodeStatus.claim, 'running')
  assert.notEqual(run.nodeStatus.implement, 'running')
})

test('#1538: needs-human in any step ends the run', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1540', title: 'Issue needing human later' })
  svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', outputs: { status: 'agent-ready' } })
  
  // Claim discovers it needs human
  const claimResult = svc.advance({
    workflowId,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Issue scope is unclear, needs maintainer clarification.',
    outputs: { claimed: 'needs-human' },
  })
  
  const run = claimResult.workflows.find(w => w.id === workflowId).run
  assert.notEqual(run.status, 'running')
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.equal(run.earlyEnd, 'needs-human')
  assert.notEqual(run.nodeStatus.implement, 'running')
})

test('#1538/#1546: the early-end directive is case-insensitive and line-owning', () => {
  const svc = service()
  const workflow = deliveryPipeline()
  const created = svc.create({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges })
  const workflowId = created.workflows.find(w => w.name === workflow.name).id
  
  svc.assign({ workflowId, taskId: '#1541', title: 'Another needs-human case' })
  
  // The reply ends the run only through the directive line, in any case.
  const triageResult = svc.advance({
    workflowId,
    nodeId: 'triage',
    outcome: 'done',
    text: 'Triage report follows.\n\nEarly-End NEEDS-HUMAN\n',
    outputs: { status: 'blocked' },
  })
  
  const run = triageResult.workflows.find(w => w.id === workflowId).run
  assert.notEqual(run.status, 'running')
  assert.equal(run.earlyEnd, 'needs-human')
})

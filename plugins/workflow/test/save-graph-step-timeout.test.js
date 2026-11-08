// #2654: `define_workflow` promises `stepTimeoutMinutes` on every call, but only its create
// branch stored it. The replace branch and the `workflow/graph` endpoint share `saveGraph()`,
// so the field is decided there: a valid value is stored, an out-of-range one refuses the whole
// save without touching the record, and an omitted one keeps what is stored.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const NODES = [{ id: 'only', name: 'Only', prompt: 'Do the thing' }]

function harness() {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => [], tasksWired: false })
}

const stored = (svc, workflowId) => svc.state().workflows.find(workflow => workflow.id === workflowId)

function createProbe(svc) {
  const state = svc.define({ name: 'TimeoutProbe', nodes: NODES, edges: [], stepTimeoutMinutes: 10 })
  const item = state.workflows.find(workflow => workflow.name === 'TimeoutProbe')
  assert.equal(item.stepTimeoutMinutes, 10, 'the create branch still stores the field')
  return item.id
}

test('#2654: define() replace stores a valid stepTimeoutMinutes and refuses an invalid one', () => {
  const svc = harness()
  const workflowId = createProbe(svc)

  const replaced = svc.define({ workflow: workflowId, name: 'TimeoutProbe', nodes: NODES, edges: [], stepTimeoutMinutes: 5 })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'the replace branch stored 5')

  const bad = svc.define({ workflow: workflowId, name: 'TimeoutProbe', nodes: NODES, edges: [], stepTimeoutMinutes: 999 })
  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.match(String(bad.error), /stepTimeoutMinutes is an integer from 1 to 120/)
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'a refused replace wrote nothing')

  const omitted = svc.define({ workflow: workflowId, name: 'TimeoutProbe', nodes: NODES, edges: [] })
  assert.equal(omitted.ok, true, JSON.stringify(omitted))
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'an omitted field keeps what is stored')
})

test('#2654: workflow/graph (saveGraph) decides stepTimeoutMinutes the same way', () => {
  const svc = harness()
  const workflowId = createProbe(svc)

  const replaced = svc.saveGraph({ workflowId, nodes: NODES, edges: [], stepTimeoutMinutes: 5 })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'the graph endpoint stored 5')

  const bad = svc.saveGraph({ workflowId, nodes: NODES, edges: [], stepTimeoutMinutes: 999 })
  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.match(String(bad.error), /stepTimeoutMinutes is an integer from 1 to 120/)
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'a refused save wrote nothing')

  const omitted = svc.saveGraph({ workflowId, nodes: NODES, edges: [] })
  assert.equal(omitted.ok, true, JSON.stringify(omitted))
  assert.equal(stored(svc, workflowId).stepTimeoutMinutes, 5, 'an omitted field keeps what is stored')
})

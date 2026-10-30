// #1856: a workflow record carries `projectId`. The save is the only door that writes it, so it
// is where the three cases are decided: an unknown Project refuses the save and writes nothing,
// `null` clears the binding, and a save that omits the field keeps what is stored.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const known = { 'project-1fe64499': { id: 'project-1fe64499', name: 'FlyBot 开发' } }

function harness() {
  return createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'bot-coder', name: 'Coder', role: '实现', remote: false }],
    readProject: id => known[id] ?? null,
  })
}

async function define(svc) {
  const state = await svc.define({ name: 'ProjectProbe', nodes: [{ id: 'a', name: 'A', prompt: 'Do A.' }], edges: [] })
  const item = state.workflows.find(workflow => workflow.name === 'ProjectProbe')
  return { workflowId: item.id, nodes: item.nodes, edges: item.edges }
}

const stored = (svc, workflowId) => svc.state().workflows.find(workflow => workflow.id === workflowId)

test('#1856: an unknown Project is refused and nothing is written', async () => {
  const svc = harness()
  const graph = await define(svc)
  const saved = svc.saveGraph({ ...graph, projectId: 'project-missing' })
  assert.equal(saved.ok, false, JSON.stringify(saved))
  assert.match(String(saved.error), /Unknown Project project-missing/)
  assert.equal(stored(svc, graph.workflowId).projectId ?? null, null, 'the record kept no binding')
})

test('#1856: projectId null clears the binding', async () => {
  const svc = harness()
  const graph = await define(svc)
  assert.equal(svc.saveGraph({ ...graph, projectId: 'project-1fe64499' }).ok, true)
  assert.equal(stored(svc, graph.workflowId).projectId, 'project-1fe64499')
  assert.equal(svc.saveGraph({ ...graph, projectId: null }).ok, true)
  assert.equal(stored(svc, graph.workflowId).projectId, null)
})

test('#1856: a save that omits projectId keeps the stored binding', async () => {
  const svc = harness()
  const graph = await define(svc)
  assert.equal(svc.saveGraph({ ...graph, projectId: 'project-1fe64499' }).ok, true)
  assert.equal(svc.saveGraph({ ...graph }).ok, true)
  assert.equal(stored(svc, graph.workflowId).projectId, 'project-1fe64499')
})

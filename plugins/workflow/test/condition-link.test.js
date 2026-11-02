// #2155: a Condition link that cannot be honoured is a refusal, not a silent downgrade to a plain
// Link. `cleanWhen` rejects an empty or malformed output name, and before this the rejection was
// indistinguishable from an absent `when`, so the edge fired unconditionally at run time. The same
// rule covers a loop's `until`: absent is fine, present-but-unusable is refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeGraph } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'
import { deliveryWorkflow, weeklyWorkflow } from '../src/template.js'

const nodes = () => [{ id: 'a', name: 'A', x: 0, y: 0 }, { id: 'b', name: 'B', x: 172, y: 0 }]

function harness() {
  return createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'bot-coder', name: 'Coder', role: '实现', remote: false }],
  })
}

async function define(svc) {
  const state = await svc.define({ name: 'ConditionProbe', nodes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], edges: [] })
  const item = state.workflows.find(workflow => workflow.name === 'ConditionProbe')
  return { workflowId: item.id, nodes: item.nodes, edges: item.edges }
}

const stored = (svc, workflowId) => svc.state().workflows.find(workflow => workflow.id === workflowId)

test('#2155: a blank output name is refused, not saved as a plain Link', () => {
  assert.throws(() => normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'b', when: { output: '' } }] }),
    /A condition link needs an output name like "ready"/)
})

test('#2155: an output name the graph cannot accept is refused', () => {
  for (const output of ['result_ok', 'ready.now', 'with space', 'ready!']) {
    assert.throws(() => normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'b', when: { output } }] }),
      /A condition link needs an output name like "ready"/, `output ${JSON.stringify(output)} was accepted`)
  }
})

test('#2155: a legal condition is kept exactly', () => {
  const graph = normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'b', when: { output: 'ready', eq: 'yes' } }] })
  assert.deepEqual(graph.edges[0], { from: 'a', to: 'b', when: { output: 'ready', eq: 'yes' } })
  const other = normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'b', when: { else: true } }] })
  assert.deepEqual(other.edges[0], { from: 'a', to: 'b', when: { else: true } })
})

test('#2155: a loop with a blank until is refused, and a loop without one still saves', () => {
  assert.throws(() => normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'a', loop: true, until: { output: '' } }] }),
    /A loop needs an output name like "ready" to stop early/)
  const bare = normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'a', loop: true, max: 2 }] })
  assert.equal(bare.edges[0].loop, true)
  assert.equal(bare.edges[0].until, undefined)
  const kept = normalizeGraph({ nodes: nodes(), edges: [{ from: 'a', to: 'a', loop: true, max: 2, until: { output: 'stop', eq: 'yes' } }] })
  assert.deepEqual(kept.edges[0].until, { output: 'stop', eq: 'yes' })
})

test('#2155: the save refuses a blank or malformed condition, and nothing is written', async () => {
  const svc = harness()
  const graph = await define(svc)
  for (const output of ['', 'result_ok', 'with space']) {
    const saved = svc.saveGraph({ ...graph, edges: [{ from: 'a', to: 'b', when: { output } }] })
    assert.equal(saved.ok, false, `output ${JSON.stringify(output)} was saved: ${JSON.stringify(saved)}`)
    assert.match(String(saved.error), /A condition link needs an output name like "ready"/)
    assert.deepEqual(stored(svc, graph.workflowId).edges, [], 'the refused save wrote an edge')
  }
})

test('#2155: the save refuses a loop with a blank until, and keeps a legal one', async () => {
  const svc = harness()
  const graph = await define(svc)
  const refused = svc.saveGraph({ ...graph, edges: [{ from: 'a', to: 'a', loop: true, max: 2, until: { output: '' } }] })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(String(refused.error), /A loop needs an output name like "ready" to stop early/)
  assert.deepEqual(stored(svc, graph.workflowId).edges, [])

  const bare = svc.saveGraph({ ...graph, edges: [{ from: 'a', to: 'a', loop: true, max: 2 }] })
  assert.equal(bare.ok, true, JSON.stringify(bare))
  const kept = svc.saveGraph({ ...graph, edges: [{ from: 'a', to: 'b', when: { output: 'ready', eq: 'yes' } }] })
  assert.equal(kept.ok, true, JSON.stringify(kept))
  assert.deepEqual(stored(svc, graph.workflowId).edges[0].when, { output: 'ready', eq: 'yes' })
})

test('#2155: the templates still read back unchanged', () => {
  for (const factory of [deliveryWorkflow, weeklyWorkflow]) {
    const template = factory()
    const graph = normalizeGraph(template)
    assert.deepEqual(graph.edges, normalizeGraph(template).edges, `${template.id} changed between two reads`)
    assert.equal(graph.edges.length, normalizeGraph(template).edges.length)
  }
})

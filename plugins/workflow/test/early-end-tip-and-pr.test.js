// Early-end for tip-unchanged / open-pr, and refuse loop/onFail burns on the same tip.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeNode, failNode, freshStatus, normalizeGraph, startFrontier } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'bot-claim', name: 'Claim', role: 'Claim', remote: false },
  { id: 'bot-verify', name: 'Verify', role: 'Verify', remote: false },
  { id: 'bot-land', name: 'Land', role: 'Land', remote: false },
]

function service() {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster })
}

function nodes() {
  return [
    { id: 'claim', name: 'Claim', role: 'Claim', outputs: [{ name: 'claimed', type: 'text' }] },
    { id: 'verify', name: 'Verify', role: 'Verify', inputs: [{ name: 'claimed', type: 'text' }], outputs: [{ name: 'status', type: 'text' }] },
    { id: 'land', name: 'Land', role: 'Land', inputs: [{ name: 'status', type: 'text' }] },
  ]
}

function loopGraph() {
  return normalizeGraph({
    id: 'claim-verify-loop',
    name: 'Claim Verify Loop',
    nodes: nodes(),
    edges: [
      { from: 'claim', to: 'verify' },
      { from: 'verify', to: 'land' },
      { from: 'verify', to: 'claim', loop: true, max: 3 },
    ],
  })
}

function onFailGraph() {
  return normalizeGraph({
    id: 'claim-verify-onfail',
    name: 'Claim Verify OnFail',
    nodes: nodes(),
    edges: [
      { from: 'claim', to: 'verify' },
      { from: 'verify', to: 'land' },
      { from: 'verify', to: 'claim', onFail: true, max: 3 },
    ],
  })
}

test('tip-unchanged output ends the run and skips the Claim↔Verify loop', () => {
  const graph = loopGraph()
  let status = freshStatus(graph)
  status = startFrontier(graph, status).status
  status = completeNode(graph, status, 'claim', { outputs: { claimed: 'ok' } }).status
  const done = completeNode(graph, status, 'verify', {
    outputs: { status: 'tip-unchanged' },
    text: 'Tip SHA unchanged since last pass.',
  })
  assert.equal(done.finished, true)
  assert.equal(done.earlyEnd, 'tip-unchanged')
  assert.equal(done.looped, false)
  assert.equal(done.status.verify, 'done')
  assert.notEqual(done.status.claim, 'running')
  assert.notEqual(done.status.land, 'running')
})

test('tip unchanged / unchanged tip phrases in text end the run without an output marker', () => {
  for (const phrase of ['tip unchanged', 'unchanged tip', 'Tip-Unchanged after recheck']) {
    const graph = loopGraph()
    let status = freshStatus(graph)
    status = startFrontier(graph, status).status
    status = completeNode(graph, status, 'claim', { outputs: { claimed: 'ok' } }).status
    const done = completeNode(graph, status, 'verify', { text: `Verify: ${phrase}; escalate once.` })
    assert.equal(done.earlyEnd, 'tip-unchanged', phrase)
    assert.equal(done.finished, true, phrase)
    assert.equal(done.looped, false, phrase)
  }
})

test('EARLY-END tip-unchanged directive on its own line ends the run', () => {
  const graph = loopGraph()
  let status = freshStatus(graph)
  status = startFrontier(graph, status).status
  status = completeNode(graph, status, 'claim', { outputs: { claimed: 'ok' } }).status
  const done = completeNode(graph, status, 'verify', {
    text: 'Checked CI.\nEARLY-END tip-unchanged\n',
  })
  assert.equal(done.earlyEnd, 'tip-unchanged')
  assert.equal(done.finished, true)
})

test('open-pr / has open PR text ends Claim without advancing when the Bot forgets already-claimed', () => {
  const svc = service()
  const graph = loopGraph()
  const created = svc.create({ name: graph.name, nodes: graph.nodes, edges: graph.edges })
  const workflowId = created.workflows.find(w => w.name === graph.name).id
  svc.assign({ workflowId, taskId: '#1489', title: 'Same tip again' })

  const claimResult = svc.advance({
    workflowId,
    nodeId: 'claim',
    outcome: 'done',
    text: 'Found open PR #1533 that fixes this issue. Skipping claim.',
  })
  const run = claimResult.workflows.find(w => w.id === workflowId).run
  assert.equal(run.earlyEnd, 'open-pr')
  assert.ok(run.status === 'done' || run.status === 'failed')
  assert.notEqual(run.nodeStatus.verify, 'running')
})

test('already has open PR and has open PR phrases map to open-pr', () => {
  for (const phrase of ['already has open PR #12', 'has an open PR fixing it', 'open PR already exists']) {
    const graph = loopGraph()
    let status = freshStatus(graph)
    status = startFrontier(graph, status).status
    const done = completeNode(graph, status, 'claim', { text: phrase })
    assert.equal(done.earlyEnd, 'open-pr', phrase)
    assert.equal(done.finished, true, phrase)
  }
})

test('fail with tip-unchanged does not take onFail recovery back to Claim', () => {
  const graph = onFailGraph()
  let status = freshStatus(graph)
  status = startFrontier(graph, status).status
  status = completeNode(graph, status, 'claim', { outputs: { claimed: 'ok' } }).status
  const failed = failNode(graph, status, 'verify', {
    text: 'Full suite already green; tip unchanged.',
    outputs: { status: 'tip-unchanged' },
    failAttempts: {},
  })
  assert.equal(failed.earlyEnd, 'tip-unchanged')
  assert.equal(failed.recovered, false)
  assert.equal(failed.finished, true)
  assert.equal(failed.status.verify, 'done')
  assert.notEqual(failed.status.claim, 'running')
})

test('service: Verify fail with tip-unchanged ends the run instead of onFail looping', () => {
  const svc = service()
  const graph = onFailGraph()
  const created = svc.create({ name: graph.name, nodes: graph.nodes, edges: graph.edges })
  const workflowId = created.workflows.find(w => w.name === graph.name).id
  svc.assign({ workflowId, taskId: '#1489', title: 'Verify red same tip' })
  svc.advance({ workflowId, nodeId: 'claim', outcome: 'done', outputs: { claimed: 'ok' }, text: 'Claimed.' })

  const result = svc.advance({
    workflowId,
    nodeId: 'verify',
    outcome: 'failed',
    text: 'Verify red x3; tip unchanged from prior attempt.',
    outputs: { status: 'tip-unchanged' },
  })
  const run = result.workflows.find(w => w.id === workflowId).run
  assert.equal(run.earlyEnd, 'tip-unchanged')
  assert.notEqual(run.status, 'running')
  assert.notEqual(run.nodeStatus.claim, 'running')
})

test('needs-human and already-claimed markers still end the run', () => {
  const graph = loopGraph()
  let status = freshStatus(graph)
  status = startFrontier(graph, status).status
  const human = completeNode(graph, status, 'claim', { outputs: { claimed: 'needs-human' } })
  assert.equal(human.earlyEnd, 'needs-human')

  status = freshStatus(graph)
  status = startFrontier(graph, status).status
  const claimed = completeNode(graph, status, 'claim', {
    outputs: { claimed: 'already-claimed' },
    text: 'agent-working label present; already claimed by other agent.',
  })
  assert.equal(claimed.earlyEnd, 'already-claimed')
})

// #1866: a non-strict reason in a declared output ends the run only as a whole
// word. `data-open-project` contains `open-pr`, and a triage brief that names it
// must not be read as "an open PR already fixes this".
const triageRoster = [
  { id: 'bot-triage', name: 'Triage', role: 'Triage', remote: false },
  { id: 'bot-claim', name: 'Claim', role: 'Claim', remote: false },
]

function triageLane() {
  return normalizeGraph({
    id: 'triage-claim',
    name: 'Triage Claim',
    nodes: [
      { id: 'triage', name: 'Triage', role: 'Triage', outputs: [{ name: 'state', type: 'text' }, { name: 'brief', type: 'text' }] },
      { id: 'claim', name: 'Claim', role: 'Claim', inputs: [{ name: 'brief', type: 'text' }] },
    ],
    edges: [{ from: 'triage', to: 'claim' }],
  })
}

function triageRun() {
  const svc = createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => triageRoster })
  const graph = triageLane()
  const created = svc.create({ name: graph.name, nodes: graph.nodes, edges: graph.edges })
  const workflowId = created.workflows.find(w => w.name === graph.name).id
  svc.assign({ workflowId, taskId: '1854-impl', title: 'Issue fast line' })
  return { svc, workflowId }
}

function triageAdvance(svc, workflowId, { outputs, text }) {
  const state = svc.advance({ workflowId, nodeId: 'triage', outcome: 'done', text, outputs })
  return state.workflows.find(w => w.id === workflowId).run
}

test('a declared output that merely contains open-pr does not end the run (#1866)', () => {
  const { svc, workflowId } = triageRun()
  const run = triageAdvance(svc, workflowId, {
    text: 'Triage done.',
    outputs: {
      state: 'ready',
      brief: 'Drop the second project entry; the DOM attribute data-open-project sits in core/src/client/kanban.js:424-427.',
    },
  })
  assert.equal(run.earlyEnd, undefined)
  assert.equal(run.status, 'running')
  assert.equal(run.nodeStatus.claim, 'running')
})

test('a declared output that merely contains tip-unchanged does not end the run', () => {
  const { svc, workflowId } = triageRun()
  const run = triageAdvance(svc, workflowId, {
    text: 'Triage done.',
    outputs: { state: 'ready', brief: 'See the data-tip-unchanged-field note in the brief.' },
  })
  assert.equal(run.earlyEnd, undefined)
  assert.equal(run.status, 'running')
  assert.equal(run.nodeStatus.claim, 'running')
})

test('a declared output that is exactly open-pr still ends the run', () => {
  const { svc, workflowId } = triageRun()
  const run = triageAdvance(svc, workflowId, {
    text: 'Already handled.',
    outputs: { state: 'open-pr' },
  })
  assert.equal(run.earlyEnd, 'open-pr')
  assert.notEqual(run.status, 'running')
  assert.notEqual(run.nodeStatus.claim, 'running')
})

test('a whole EARLY-END open-pr line still ends the run', () => {
  const { svc, workflowId } = triageRun()
  const run = triageAdvance(svc, workflowId, {
    text: 'Checked the repository.\n\nEARLY-END open-pr\n',
    outputs: { state: 'ready' },
  })
  assert.equal(run.earlyEnd, 'open-pr')
  assert.notEqual(run.status, 'running')
  assert.notEqual(run.nodeStatus.claim, 'running')
})

test('open-pr as a whole word inside a declared output still ends the run', () => {
  const { svc, workflowId } = triageRun()
  const run = triageAdvance(svc, workflowId, {
    text: 'Triage done.',
    outputs: { state: 'open-pr #1854' },
  })
  assert.equal(run.earlyEnd, 'open-pr')
  assert.notEqual(run.nodeStatus.claim, 'running')
})

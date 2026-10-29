// #1706: the Inbox needs two facts about a run it never had — when a run ended and
// which node it walks now — without any change to the fields the stage and the Runs
// tab already read. publicRun() gains exactly `finishedAt` and `currentStep`; every
// old key stays and keeps its value.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000

function setup() {
  const svc = createWorkflowService({ persist: false, now: () => NOW, bots: () => [] })
  const made = svc.define({
    name: 'Lane',
    nodes: [{ id: 'plan', name: 'Planner', prompt: 'Write the plan.' }],
    edges: [],
  }).workflows.find(item => item.name === 'Lane')
  return { svc, id: made.id }
}

const runOf = (views, id) => views.workflows.find(item => item.id === id).run

// The shape before #1706: a consumer that reads only these keys sees no change.
const OLD_KEYS = [
  'id', 'workflowId', 'task', 'taskSummary', 'status', 'nodeStatus', 'steps', 'stepBudget',
  'doneCount', 'nodeCount', 'marks', 'running', 'history', 'startedAt', 'updatedAt',
]
// Flags that were already conditional, so a state may or may not carry them.
const OLD_FLAGS = ['live', 'paused', 'failure', 'earlyEnd', 'ephemeral']

const assertOnlyAdded = (run) => {
  for (const key of OLD_KEYS) assert.ok(key in run, `${run.status} run keeps ${key}`)
  const added = Object.keys(run).filter(key => !OLD_KEYS.includes(key) && !OLD_FLAGS.includes(key))
  assert.deepEqual(added.sort(), ['currentStep', 'finishedAt'])
}

test('#1706: a running run is not finished and names the node it walks', async () => {
  const { svc, id } = setup()
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'go' })
  const run = runOf(started, id)
  assertOnlyAdded(run)
  assert.equal(run.status, 'running')
  assert.equal(run.finishedAt, null)
  assert.deepEqual(run.currentStep, { id: 'plan', name: 'Planner' })
  // Old projections unchanged: one node running, nothing finished.
  assert.deepEqual(run.running, ['plan'])
  assert.deepEqual(run.marks, ['running'])
  assert.equal(run.doneCount, 0)
  assert.equal(run.steps, 1)
  assert.equal(run.updatedAt, NOW)
})

test('#1706: a paused run keeps status running, is not finished, and still names its node', async () => {
  const { svc, id } = setup()
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'go' })
  const paused = svc.pause({ workflowId: id, runId: runOf(started, id).id })
  const run = runOf(paused, id)
  assertOnlyAdded(run)
  // The engine pauses by keeping `status: 'running'` and setting `paused` (service.js pause()).
  assert.equal(run.status, 'running')
  assert.equal(run.paused, true)
  assert.equal(run.finishedAt, null)
  assert.deepEqual(run.currentStep, { id: 'plan', name: 'Planner' })
  assert.deepEqual(run.running, ['plan'])
  assert.equal(run.doneCount, 0)
})

test('#1706: a done run names when it ended and no current step', async () => {
  const { svc, id } = setup()
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'go' })
  const done = svc.advance({ workflowId: id, runId: runOf(started, id).id, nodeId: 'plan', outcome: 'done' })
  const run = runOf(done, id)
  assertOnlyAdded(run)
  assert.equal(run.status, 'done')
  assert.equal(run.finishedAt, NOW)
  assert.equal(run.currentStep, null)
  assert.deepEqual(run.running, [])
  assert.equal(run.doneCount, 1)
  assert.equal(run.steps, 2)
})

test('#1706: a failed run names when it ended and no current step, and keeps its failure', async () => {
  const { svc, id } = setup()
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'go' })
  const failed = svc.advance({ workflowId: id, runId: runOf(started, id).id, nodeId: 'plan', outcome: 'failed', text: 'the planner gave up' })
  const run = runOf(failed, id)
  assertOnlyAdded(run)
  assert.equal(run.status, 'failed')
  assert.equal(run.finishedAt, NOW)
  assert.equal(run.currentStep, null)
  assert.deepEqual(run.running, [])
  assert.deepEqual(run.marks, ['failed'])
  assert.equal(run.failure.text, 'the planner gave up')
  assert.equal(run.failure.nodeName, 'Planner')
})

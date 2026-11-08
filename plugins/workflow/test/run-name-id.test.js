// #2662: two runNamed calls in the same millisecond used to share the
// millisecond-only task id, so queuedOrRunning dropped the second run and the
// second brief replaced the first in `state.briefs`. Generated ids are random
// now; an explicit repeat of the same card still de-duplicates (#2468/#2475).
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

const laneOf = (views, id) => views.workflows.find(item => item.id === id)

test('#2662: two runNamed calls in one millisecond start two runs with two task ids', async () => {
  const { svc, id } = setup()
  svc.setConcurrency({ workflowId: id, maxConcurrent: 8 })

  const first = await svc.runNamed({ workflow: 'Lane', brief: 'Issue #1: fix the crash' })
  const second = await svc.runNamed({ workflow: 'Lane', brief: 'Issue #2: fix the timeout' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.already, undefined)
  const lane = laneOf(second, id)
  assert.equal(lane.runs.length, 2)
  assert.equal(new Set(lane.runs.map(run => run.task.id)).size, 2)
  assert.deepEqual(lane.runs.map(run => run.task.title), ['Issue #1: fix the crash', 'Issue #2: fix the timeout'])

  // #2468/#2475: an explicit repeat of the same card is still de-duplicated.
  await svc.runNamed({ workflow: 'Lane', task: 'card-1', brief: 'Issue #3: fix the build' })
  const repeat = await svc.runNamed({ workflow: 'Lane', task: 'card-1', brief: 'Issue #4: fix the lint' })
  assert.equal(repeat.already, true)
  const after = laneOf(repeat, id)
  assert.equal(after.runs.filter(run => run.task.id === 'card-1').length, 1)
  assert.equal(after.runs.length, 3)
})

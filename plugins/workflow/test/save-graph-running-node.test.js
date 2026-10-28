// #1549: dropping a running node from the graph must not strand its run.
// saveGraph clears nothing else, so a run whose only running node was deleted
// could never advance again and kept its slot under maxConcurrent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
]

function harness() {
  const spawned = []
  const released = []
  let seq = 0
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
    dispatch: async () => ({ ok: true }),
    // #1530 bounds every step with a deadline timer; this case asserts what the
    // edit ends, not when a step expires, so the scheduler is a no-op.
    setTimer: () => 0,
    clearTimer: () => {},
  })
  return { svc, spawned, released }
}

async function defineTwoNodes(svc) {
  await svc.define({
    name: 'DeleteProbe',
    nodes: [
      { id: 'a', name: 'A', prompt: 'Do A.' },
      { id: 'b', name: 'B', prompt: 'Do B.' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  })
  return svc.state().workflows.find(item => item.name === 'DeleteProbe')
}

test('deleting a running node ends its run, releases the Bot and drains the queue', async () => {
  const { svc, spawned, released } = harness()
  const workflow = await defineTwoNodes(svc)
  await svc.setConcurrency({ workflowId: workflow.id, maxConcurrent: 1 })
  await svc.assign({ workflowId: workflow.id, taskId: 'task-1', title: 'First' })
  const queued = await svc.assign({ workflowId: workflow.id, taskId: 'task-2', title: 'Second' })
  assert.equal(queued.workflows.find(item => item.id === workflow.id).queueDepth, 1, 'second task waits for the slot')
  assert.deepEqual(spawned.map(entry => entry.spec.nodeId), ['a', 'b'], 'one Bot per node at run start')
  assert.equal(queued.workflows.find(item => item.id === workflow.id).runs[0].nodeStatus.a, 'running', 'the first node is running')

  // Delete the node that is running. Its Bot must not be orphaned and the run
  // must not stay `running` with nothing left to advance it.
  const saved = await svc.saveGraph({ workflowId: workflow.id, nodes: [{ id: 'b', name: 'B', prompt: 'Do B.' }], edges: [] })
  assert.equal(saved.ok, true)
  const after = saved.workflows.find(item => item.id === workflow.id)
  // main (#1493, #1507) keeps a failed run on the stage beside the run that took its
  // slot, so the stranded attempt stays visible — as the failed sibling, not as a
  // running row: only the task that took the lane is running.
  const stillRunning = after.runs.filter(run => run.status === 'running').map(run => run.task.id)
  assert.deepEqual(stillRunning, ['task-2'], 'only the queued task runs: ' + JSON.stringify(after.runs))
  const stranded = after.runs.find(run => run.task.id === 'task-1')
  assert.equal(stranded?.status, 'failed', 'the stranded attempt shows as failed: ' + JSON.stringify(after.runs))
  assert.equal(after.runs[0].nodeStatus.b, 'running', 'the queued task started its own node')
  const closed = (after.history ?? []).find(entry => entry.task?.id === 'task-1')
  assert.equal(closed?.status, 'failed', 'the ended run is archived as failed: ' + JSON.stringify(after.history))
  assert.deepEqual([...released].sort(), ['eph-1', 'eph-2'], 'the ended run\'s Bots are released')
  assert.equal(after.activeCount, 1, 'the queued task takes the slot')
  assert.equal(after.queueDepth, 0, 'the queue drained')

  // With nothing queued the ended run stays the one on display, so the failed node
  // must still be in its map instead of dropping out of it with the graph.
  const solo = harness()
  const soloFlow = await defineTwoNodes(solo.svc)
  await solo.svc.assign({ workflowId: soloFlow.id, taskId: 'task-3', title: 'Solo' })
  const soloSaved = await solo.svc.saveGraph({ workflowId: soloFlow.id, nodes: [{ id: 'b', name: 'B', prompt: 'Do B.' }], edges: [] })
  const soloAfter = soloSaved.workflows.find(item => item.id === soloFlow.id)
  assert.equal(soloAfter.run.status, 'failed', 'the dropped run is failed: ' + JSON.stringify(soloAfter.run))
  assert.equal(soloAfter.run.nodeStatus.a, 'failed', 'the node that was running is failed: ' + JSON.stringify(soloAfter.run.nodeStatus))
  assert.deepEqual([...solo.released].sort(), ['eph-1', 'eph-2'], 'the dropped run\'s Bots are released')
})

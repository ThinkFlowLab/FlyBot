// A Resume is thrown away the same way a Pause is: the hand-off that was already in
// flight stores the run record it grabbed before, so the resolve never reaches the lane.
// The second card is the control — unless a pause survives its own landing, the resume
// case above it would pass without the fix purely because the pause was lost too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

function bench() {
  const gates = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'main', name: 'Chief', isMain: true, remote: false }],
    spawn: async () => { seq += 1; return `eph-${seq}` },
    release: () => {},
    dispatch: async () => { await new Promise(resolve => { gates.push(resolve) }); return { ok: true } },
  })
  const row = () => svc.state().workflows.find(item => item.id === DELIVERY_ID)
  const runOf = taskId => row().runs.find(run => run.task?.id === taskId)
  return { svc, gates, runOf }
}

test('resume during an in-flight step dispatch is not lost', async () => {
  const { svc, gates, runOf } = bench()

  // #9002 — the resume case: a pause and then a resume, both while the dispatch is in flight.
  const first = svc.assign({ workflowId: DELIVERY_ID, taskId: '#9002', title: 'Resume while dispatching' })
  await settle()
  const a = runOf('#9002').id
  svc.pause({ workflowId: DELIVERY_ID, runId: a })
  assert.equal(runOf('#9002').paused, true, 'the pause did not take effect')
  svc.resume({ workflowId: DELIVERY_ID, runId: a })
  assert.notEqual(runOf('#9002').paused, true, 'the resume did not take effect')
  gates[0]()
  await first
  await settle()
  assert.notEqual(runOf('#9002').paused, true, 'the resume was thrown away by the dispatch that landed')

  // #9003 — the control: the same landing with no resume has to leave the run paused.
  const second = svc.assign({ workflowId: DELIVERY_ID, taskId: '#9003', title: 'Pause while dispatching' })
  await settle()
  const b = runOf('#9003').id
  svc.pause({ workflowId: DELIVERY_ID, runId: b })
  assert.equal(runOf('#9003').paused, true, 'the pause did not take effect')
  gates[1]()
  await second
  await settle()
  assert.equal(runOf('#9003').paused, true, 'the pause was thrown away by the dispatch that landed')

  for (let round = 0; round < 3; round += 1) {
    for (const resolve of gates.splice(0)) resolve()
    await settle(20)
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELIVERY_ID } from '../src/template.js'
import { createWorkflowService } from '../src/service.js'

function delivery(state) {
  return state.workflows.find(item => item.id === DELIVERY_ID)
}

test('pause and resume gate a live run and update the sidebar line', async () => {
  const svc = createWorkflowService({ persist: false, now: () => 1, bots: () => [] })
  const opened = await svc.assign({ workflowId: DELIVERY_ID, taskId: '#77', title: 'Ship the fix' })
  const row = delivery(opened)
  assert.equal(row.run.live, true)
  assert.match(row.preview, /正在处理/)
  const paused = svc.pause({ workflowId: DELIVERY_ID })
  const parked = delivery(paused)
  assert.equal(parked.run.paused, true)
  assert.match(parked.preview, /已暂停/)
  const resumed = await svc.resume({ workflowId: DELIVERY_ID })
  const back = delivery(resumed)
  assert.equal(back.run.paused, undefined)
  assert.match(back.preview, /正在处理/)
})

test('pause refuses when there is no live run', () => {
  const svc = createWorkflowService({ persist: false, now: () => 1, bots: () => [] })
  const refused = svc.pause({ workflowId: DELIVERY_ID })
  assert.equal(refused.ok, false)
})

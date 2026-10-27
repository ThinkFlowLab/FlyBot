import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, WEEKLY_ID } from '../src/template.js'

test('a fresh store has no seeded runs in workflow/state', () => {
  const svc = createWorkflowService({ persist: false, now: () => 1 })
  const state = svc.state()
  const delivery = state.workflows.find(item => item.id === DELIVERY_ID)
  const weekly = state.workflows.find(item => item.id === WEEKLY_ID)
  assert.equal(delivery.preview, '等待任务')
  assert.equal(delivery.run, null)
  assert.equal(delivery.activeCount, 0)
  assert.match(weekly.preview, /周五 17:00/)
  assert.equal(weekly.run, null)
})

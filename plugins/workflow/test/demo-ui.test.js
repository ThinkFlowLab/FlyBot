import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELIVERY_ID } from '../src/template.js'
import { createWorkflowService } from '../src/service.js'

test('a seeded demo in demos[] never makes workflow/state look busy', () => {
  const svc = createWorkflowService({ persist: false, now: () => 1, bots: () => [] })
  const row = svc.state().workflows.find(item => item.id === DELIVERY_ID)
  assert.equal(row.activeCount, 0)
  assert.equal(row.run, null)
  assert.equal(row.preview, '等待任务')
  const stepped = svc.demoStep({ workflowId: DELIVERY_ID })
  assert.equal(stepped.ok, true)
  const after = svc.state().workflows.find(item => item.id === DELIVERY_ID)
  assert.equal(after.activeCount, 0)
  assert.equal(after.run, null)
  assert.equal(after.preview, '等待任务')
  assert.equal(stepped.demo.status, 'running')
})

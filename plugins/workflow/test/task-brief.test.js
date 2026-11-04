// #2468: `assign` resolves the brief from the task, so re-dispatching the same
// card to another lane keeps its facts and appends one handoff line.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, WEEKLY_ID } from '../src/template.js'

function service() {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => [] })
}

test('a re-dispatch to another lane keeps the brief and records one handoff', () => {
  const svc = service()
  const first = svc.state().workflows.find(item => item.id === DELIVERY_ID)
  const second = svc.state().workflows.find(item => item.id === WEEKLY_ID)
  assert.ok(first && second)
  const facts = 'Fact one.\nFact two.'

  svc.assign({ workflowId: first.id, taskId: 'task-1', title: 'A card', brief: facts })
  svc.assign({ workflowId: second.id, taskId: 'task-1', title: 'A card' })

  const lane = id => svc.state().workflows.find(item => item.id === id)
  const moved = lane(second.id).runs.find(run => run.task?.id === 'task-1')
  assert.ok(moved, 'the second lane has the card')
  assert.equal(moved.task.brief, facts)
  assert.equal(moved.task.handoff.from, first.name)
  assert.equal(moved.task.handoff.to, second.name)
  assert.ok(moved.task.handoff.at)

  // A call that still passes a brief keeps working: with none stored, it is stored.
  svc.assign({ workflowId: first.id, taskId: 'task-2', title: 'Other card', brief: 'Only fact.' })
  const other = lane(first.id).runs.find(run => run.task?.id === 'task-2')
  assert.equal(other.task.brief, 'Only fact.')
})

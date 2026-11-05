// #2475: the brief an assignment stores on the lane is a cache, and the cache
// only ever grew. An empty brief could not clear it, and deleting the lane left
// its entry behind, so the next assignment carried facts nobody holds and a
// handoff named a lane that no longer exists.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, WEEKLY_ID } from '../src/template.js'

const CLOCK = 1_700_000_000_000

function service() {
  return createWorkflowService({ persist: false, now: () => CLOCK, bots: () => [] })
}

function named(svc, name) {
  const created = svc.create({
    name,
    nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }],
    edges: [],
  })
  assert.equal(created.ok, true, created.error)
  return created.workflows.find(item => item.name === name)
}

const lane = (svc, id) => svc.state().workflows.find(item => item.id === id)

function cardOf(svc, id, taskId) {
  const item = lane(svc, id)
  return item.runs.find(run => run.task?.id === taskId) ?? item.queue.find(run => run.id === taskId)
}

test('#2475: an empty brief clears the facts the card already carries', () => {
  const svc = service()
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-a2', title: 'B card', brief: 'OLD facts.' })
  svc.assign({ workflowId: WEEKLY_ID, taskId: 'task-a2', title: 'B card', brief: '' })
  assert.equal(
    cardOf(svc, WEEKLY_ID, 'task-a2').task.brief,
    undefined,
    "brief: '' must clear the card's facts",
  )
})

test('#2475: an explicit brief replaces the facts the card already carries', () => {
  const svc = service()
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-a4', title: 'D card', brief: 'OLD facts.' })
  svc.assign({ workflowId: WEEKLY_ID, taskId: 'task-a4', title: 'D card', brief: 'NEW facts.' })
  assert.equal(
    cardOf(svc, WEEKLY_ID, 'task-a4').task.brief,
    'NEW facts.',
    "the call's brief, not the cached one, is what the node receives",
  )
})

test('#2475: deleting a lane drops the facts it cached, and the next handoff names no deleted lane', () => {
  const svc = service()
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-a3', title: 'C card', brief: 'OLD facts.' })
  svc.delete({ workflowId: DELIVERY_ID })
  svc.assign({ workflowId: WEEKLY_ID, taskId: 'task-a3', title: 'C card' })

  const moved = cardOf(svc, WEEKLY_ID, 'task-a3')
  assert.equal(moved.task?.brief, undefined, 'the deleted lane kept no facts for the card')
  assert.equal(
    moved.task?.handoff,
    undefined,
    'the lane it left is gone, so there is no handoff to record',
  )
})

// #2468: a call that omits the brief means "keep the card's facts", so the
// cache is what carries a re-dispatch. The clear has to be explicit (above).
test('#2475: a re-dispatch that passes no brief still carries the card facts', () => {
  const svc = service()
  const facts = 'Fact one.\nFact two.'
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-a5', title: 'E card', brief: facts })
  svc.assign({ workflowId: WEEKLY_ID, taskId: 'task-a5', title: 'E card' })

  const moved = cardOf(svc, WEEKLY_ID, 'task-a5')
  assert.equal(moved.task.brief, facts)
  assert.equal(moved.task.handoff.from, lane(svc, DELIVERY_ID).name)
})

test('#2475: the re-match line on the source graph still lands after the card carries facts', async () => {
  const svc = service()
  const alpha = named(svc, 'Alpha')
  const beta = named(svc, 'Beta')

  const first = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: alpha.id })
  assert.deepEqual(first.decision, { kind: 'workflow', id: alpha.id })
  svc.assign({ workflowId: alpha.id, taskId: 't-1', title: 'Ship it', brief: 'Facts.' })

  const moved = await svc.ingest({ id: 't-1', status: 'open', title: 'Ship it', workflowId: beta.id })
  assert.equal(moved.already, false)

  const reroutes = lane(svc, alpha.id).messages.filter(entry => entry.key === 'Task re-matched · {task} → {to}')
  assert.equal(reroutes.length, 1, 'the source graph keeps exactly one line saying where the card went')
  assert.equal(reroutes[0].params.to, 'Beta')
})

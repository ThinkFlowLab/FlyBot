// A card that was parked and could not start is still the owner's parked work: it stays
// in the queue and starts on the next drain, instead of leaving the queue for good.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

function bench() {
  const state = { armed: false, seed: 0 }
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'main', name: 'Chief', isMain: true, remote: false }],
    spawn: async () => {
      if (state.armed) throw new Error('the host could not start a Bot (transient)')
      state.seed += 1
      return `eph-${state.seed}`
    },
    release: () => {},
    dispatch: async () => ({ ok: true }),
  })
  return { svc, state }
}

const row = svc => svc.state().workflows.find(item => item.id === DELIVERY_ID)
const queued = svc => row(svc).queue.map(task => task.id)
const running = svc => row(svc).runs.filter(run => run.status === 'running').map(run => run.task?.id)

test('a parked card whose start fails stays in the queue', async () => {
  const { svc, state } = bench()
  svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
  await svc.ingest({ id: '#A', title: 'First card', status: 'open', workflowId: DELIVERY_ID })
  await svc.ingest({ id: '#B', title: 'Second card', status: 'open', workflowId: DELIVERY_ID })
  assert.deepEqual(queued(svc), ['#B'])

  const first = row(svc).runs.find(run => run.status === 'running')
  state.armed = true // free the slot; the spawn for the parked card fails once
  await svc.reset({ workflowId: DELIVERY_ID, runId: first.id })
  state.armed = false

  assert.deepEqual(queued(svc), ['#B'], 'the parked card left the queue without starting')
  assert.deepEqual(running(svc), [])

  // A later card joins the tail and drains the queue: the parked card starts first.
  await svc.ingest({ id: '#C', title: 'Third card', status: 'open', workflowId: DELIVERY_ID })
  assert.deepEqual(running(svc), ['#B'], 'the parked card never got its turn')
  assert.deepEqual(queued(svc), ['#C'])
})

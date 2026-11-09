// A Resume that arrives while a step's dispatch is in flight must not be thrown away either.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

test('resume during an in-flight step dispatch is not lost', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => 1_700_000_000_000,
    bots: () => [{ id: 'main', name: 'Chief', isMain: true, remote: false }],
    spawn: async () => { seq += 1; return `eph-${seq}` },
    release: () => {},
    dispatch: async () => { await gate; return { ok: true } },
  })
  const row = () => svc.state().workflows.find(item => item.id === DELIVERY_ID)

  const assigning = svc.assign({ workflowId: DELIVERY_ID, taskId: '#9002', title: 'Resume while dispatching' })
  await new Promise(resolve => setTimeout(resolve, 20)) // the dispatch is now blocked in flight
  svc.pause({ workflowId: DELIVERY_ID })
  assert.equal(row().run.paused, true)
  svc.resume({ workflowId: DELIVERY_ID })
  assert.notEqual(row().run.paused, true, 'the resume did not take effect')

  release()
  await assigning
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.notEqual(row().run.paused, true, 'the run came back paused after the dispatch landed')
})

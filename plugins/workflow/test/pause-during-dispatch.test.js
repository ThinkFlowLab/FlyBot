// A Pause that arrives while a step's dispatch is in flight must not be thrown away.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

test('pause during an in-flight step dispatch is not lost', async () => {
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

  const assigning = svc.assign({ workflowId: DELIVERY_ID, taskId: '#9001', title: 'Pause while dispatching' })
  await new Promise(resolve => setTimeout(resolve, 20)) // the dispatch is now blocked in flight
  svc.pause({ workflowId: DELIVERY_ID })
  assert.equal(row().run.paused, true)
  release()
  await assigning
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(row().run.paused, true, 'the run came back unpaused after the dispatch landed')
  assert.doesNotMatch(row().preview, /正在处理/)
})

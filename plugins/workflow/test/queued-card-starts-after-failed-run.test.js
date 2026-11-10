// #2752: a card queued behind a run that ends **failed** must start, exactly like one
// queued behind a run that ends `done`. The queue is filled while the line is at its cap,
// so the ending is what has to move it — waiting for the next assign leaves the card
// parked with `queueDepth > 0` and `activeCount 0` while the line looks idle.
//
// The ending under test is the reaper's: a run whose host died comes back from the store
// still `running`, `reap()` ends it `host-ended`, and that is a terminal transition like
// any other. A drain that lives only on the happy path never sees it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const AT = 1_700_000_000_000

function bench(dir, seed) {
  const state = { seed, spawned: [] }
  const svc = createWorkflowService({
    dir,
    now: () => AT,
    bots: () => [{ id: 'main', name: 'Chief', isMain: true, remote: false }],
    spawn: async () => {
      state.seed += 1
      const id = `eph-${state.seed}`
      state.spawned.push(id)
      return id
    },
    release: () => {},
    dispatch: async () => ({ ok: true }),
    // No deadlines here: the ending this test needs is the one the load produces.
    setTimer: () => 1,
    clearTimer: () => {},
  })
  return { svc, state }
}

const row = svc => svc.state().workflows.find(item => item.id === DELIVERY_ID)
const running = svc => row(svc).runs.filter(run => run.status === 'running').map(run => run.task?.id)
const queueDepth = svc => row(svc).queueDepth

test('a card queued behind a run the host ended failed starts after the reap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-2752-'))
  try {
    const first = bench(dir, 0)
    first.svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 1 })
    await first.svc.ingest({ id: '#A', title: 'First card', status: 'open', workflowId: DELIVERY_ID })
    await first.svc.ingest({ id: '#B', title: 'Second card', status: 'open', workflowId: DELIVERY_ID })
    assert.deepEqual(running(first.svc), ['#A'], 'the first card did not start')
    assert.equal(queueDepth(first.svc), 1, 'the second card was not parked behind the cap')

    // The host that ran #A is gone: its Bots went with it and the store still says
    // `running`. The next host loads that store and reaps the run as `host-ended`.
    const second = bench(dir, 100)
    await second.svc.reap()

    assert.deepEqual(running(second.svc), ['#B'], 'the parked card did not start after the failed run ended')
    assert.equal(queueDepth(second.svc), 0, 'the queue kept the card while the line had a free slot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

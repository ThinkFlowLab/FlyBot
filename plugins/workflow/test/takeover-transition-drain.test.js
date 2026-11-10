// #2787: a takeover reap is a terminal transition like any other, so the lane's queue
// moves on it. `#2757` gave the load-time `reap()` a drain on the serial tail; the
// takeover path (`#2704`) starts the same reaper but stopped there, so the run the dead
// window left `running` was ended `host-ended` while the card parked behind it stayed in
// `lane.queue` until some unrelated assign/ingest. `#2752` is that symptom.
//
// The takeover here is driven the way the plugin drives it: a window opens while another
// holds the lock, so it is a reader; the first call that finds the host writable is what
// takes the store over. No `assign` and no `ingest` follows — the reap itself is the only
// thing that could start the parked card.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const AT = 1_700_000_000_000
const ROSTER = [{ id: 'main', name: 'Chief', isMain: true, remote: false }]
const CLOSED = 'dead-running'
const PARKED = 'dead-queued'

// One turn of the event loop apiece: the reap and its drain are promises the caller does
// not await (`plugins/workflow/index.js` fires the load reap and moves on), so the test
// waits for the work instead of for a call to return.
const settle = async (rounds = 300) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(done => setImmediate(done))
}

function bench(dir, options = {}) {
  const seen = { released: [], spawned: [] }
  let seq = 100
  const svc = createWorkflowService({
    dir,
    persist: true,
    now: () => AT,
    bots: () => ROSTER,
    spawn: async (spec) => {
      const id = `eph-${spec.nodeId}-${++seq}`
      seen.spawned.push(id)
      return id
    },
    release: async (id) => { seen.released.push(id) },
    dispatch: async () => ({ ok: true }),
    // No deadlines or spawn bounds here: the ending under test is the reap's.
    setTimer: () => 1,
    clearTimer: () => {},
    ...options,
  })
  return { svc, seen }
}

async function seedLane(dir) {
  const first = bench(dir)
  const made = first.svc.define({
    name: 'Lane',
    nodes: [{ id: 'work', name: 'Worker', prompt: 'Work.' }],
    edges: [],
  })
  assert.equal(made.ok, true, JSON.stringify(made))
  const workflowId = made.workflows.find(item => item.name === 'Lane').id
  await first.svc.setConcurrency({ workflowId, maxConcurrent: 1 })
  await first.svc.runNamed({ workflow: 'Lane', brief: 'dead run', task: CLOSED })
  await first.svc.assign({ workflowId, taskId: PARKED, title: 'parked card' })
  const row = first.svc.state().workflows.find(item => item.id === workflowId)
  assert.deepEqual(row.runs.filter(run => run.status === 'running').map(run => run.task?.id), [CLOSED])
  assert.equal(row.queueDepth, 1)
  const deadBots = row.runs.find(run => run.task?.id === CLOSED)?.ephemeral ?? {}
  return { workflowId, deadBots: Object.values(deadBots).sort() }
}

const rowOf = (svc, workflowId) => svc.state().workflows.find(item => item.id === workflowId)
const running = (svc, workflowId) => rowOf(svc, workflowId).runs.filter(run => run.status === 'running').map(run => run.task?.id)
const depth = (svc, workflowId) => rowOf(svc, workflowId).queueDepth

test('the takeover reap starts the card parked behind the run it ends (#2787)', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-takeover-drain-'))
  try {
    const seed = await seedLane(dir)
    // The other window holds the lock while this one opens, so this one is a reader.
    const lock = { writable: false }
    const second = bench(dir, { readOnly: () => (lock.writable ? undefined : 'read-only') })
    await second.svc.reap() // what loading does: a reader touches nothing (#2673)
    assert.deepEqual(running(second.svc, seed.workflowId), [CLOSED], 'a read-only host ended the writer run')
    assert.equal(depth(second.svc, seed.workflowId), 1)

    // The first call that finds the host writable takes the store over (#2704). Nothing
    // is assigned and nothing is ingested after it: only the reap can move the queue.
    lock.writable = true
    second.svc.state()
    await settle()

    assert.deepEqual(running(second.svc, seed.workflowId), [PARKED], 'the parked card did not start after the takeover reap ended the run')
    assert.equal(depth(second.svc, seed.workflowId), 0, 'the queue kept the card while the line had a free slot')
    assert.deepEqual([...second.seen.released].sort(), seed.deadBots, 'the takeover did not release the dead run\'s step Bots once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The control: the drain belongs to the reap, not to whichever call noticed the takeover.
// (a) a writer that reaps starts the card (#2757's path), (b) a takeover reap starts it
// too (#2787's hole), (c) an explicit reap after the takeover starts it as well — and does
// not drain a second time, because `reap()` hands back the takeover's own work (#2757's
// cap-1 race is what a second drain reopens).
test('a takeover reap drains like the load reap, and a later reap does not drain twice (#2787)', { timeout: 60_000 }, async () => {
  for (const shape of ['writer', 'takeover', 'takeover-then-reap']) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-takeover-control-'))
    try {
      const seed = await seedLane(dir)
      const lock = { writable: shape === 'writer' }
      const next = bench(dir, { readOnly: () => (lock.writable ? undefined : 'read-only') })
      if (shape === 'writer') {
        await next.svc.reap()
      } else {
        lock.writable = true
        next.svc.state()
        if (shape === 'takeover-then-reap') await next.svc.reap()
        await settle()
      }
      assert.deepEqual(running(next.svc, seed.workflowId), [PARKED], `${shape}: the parked card did not start`)
      assert.equal(depth(next.svc, seed.workflowId), 0, `${shape}: the queue kept the card`)
      assert.deepEqual([...next.seen.released].sort(), seed.deadBots, `${shape}: the dead run's Bots were not released exactly once`)
      assert.equal(rowOf(next.svc, seed.workflowId).activeCount, 1, `${shape}: the lane started more than its cap`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

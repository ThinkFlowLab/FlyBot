// #2787 (folded in from P-682): every terminal transition drains. A run that ends is a
// free slot; a card parked behind it must move into that slot in the same turn, or the
// lane reports `queueDepth > 0` with nothing running and looks idle until some unrelated
// assign/ingest. #2752 is that shape on the finish paths; the reap paths (#2757, #2787)
// are the ones that were missing it.
//
// One bench for every row: a one-node lane at cap 1, one run holding the slot, one card
// parked behind it. Each row ends the run a different way and then asks the same question:
// is the lane left with a card parked behind a free slot? A row fails only itself when its
// own ending loses its drain — step success/failure, deadline, Stop, graph edit, load reap
// and takeover reap all start the parked card; Reset drops the queue by design, so its row
// asserts that the lane is emptied instead of left half-moved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const AT = 1_700_000_000_000
const ROSTER = [{ id: 'main', name: 'Chief', isMain: true, remote: false }]
const RUNNING = '#A'
const PARKED = '#B'
const WORKFLOW = 'Lane'

// Timers the test fires itself: the deadline row needs the step deadline, and every other
// row never wants a timer to move the run it is about to end.
function scheduler() {
  let seq = 0
  const queue = new Map()
  const setTimer = (fn, ms) => {
    const id = ++seq
    queue.set(id, { fn, due: Math.max(1, Number(ms) || 0) })
    return id
  }
  const clearTimer = id => { queue.delete(id) }
  async function tick(ms) {
    let left = Math.max(0, Number(ms) || 0)
    for (;;) {
      let next
      for (const [id, entry] of queue) {
        if (entry.due > left) continue
        if (!next || entry.due < next.entry.due) next = { id, entry }
      }
      if (!next) return
      queue.delete(next.id)
      left -= next.entry.due
      for (const entry of queue.values()) entry.due -= next.entry.due
      await next.entry.fn()
    }
  }
  return { setTimer, clearTimer, tick }
}

function service(dir, options = {}) {
  const seen = { released: [] }
  let seq = 0
  const timers = scheduler()
  const svc = createWorkflowService({
    dir,
    persist: true,
    now: () => AT,
    bots: () => ROSTER,
    spawn: async (spec) => `eph-${spec.nodeId}-${++seq}`,
    release: async (id) => { seen.released.push(id) },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options,
  })
  return { svc, seen, timers }
}

// The same bench for every row: cap 1, `#A` holding the slot with a live Bot on it, `#B`
// parked behind it.
async function bench(dir) {
  const made = service(dir)
  const defined = made.svc.define({
    name: WORKFLOW,
    nodes: [{ id: 'work', name: 'Worker', prompt: 'Work.' }],
    edges: [],
  })
  assert.equal(defined.ok, true, JSON.stringify(defined))
  const workflowId = defined.workflows.find(item => item.name === WORKFLOW).id
  await made.svc.setConcurrency({ workflowId, maxConcurrent: 1 })
  await made.svc.runNamed({ workflow: WORKFLOW, brief: 'first', task: RUNNING })
  await made.svc.assign({ workflowId, taskId: PARKED, title: 'parked card' })
  const row = rowOf(made.svc, workflowId)
  const live = row.runs.find(run => run.status === 'running')
  assert.equal(live?.task?.id, RUNNING, JSON.stringify(row))
  assert.equal(row.queueDepth, 1, 'the bench did not park the second card')
  return { ...made, dir, workflowId, runId: live.id }
}

const settle = async (rounds = 300) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(done => setImmediate(done))
}
const rowOf = (svc, workflowId) => svc.state().workflows.find(item => item.id === workflowId)
const runningOf = (svc, workflowId) => rowOf(svc, workflowId).runs.filter(run => run.status === 'running').map(run => run.task?.id)
const depthOf = (svc, workflowId) => rowOf(svc, workflowId).queueDepth

const ROWS = [
  {
    name: 'a step that succeeds',
    ends: 'starts',
    async run(h) {
      await h.svc.advance({ workflowId: h.workflowId, nodeId: 'work', outcome: 'done', text: 'done' })
    },
  },
  {
    name: 'a step that fails',
    ends: 'starts',
    async run(h) {
      await h.svc.advance({ workflowId: h.workflowId, nodeId: 'work', outcome: 'failed', text: 'step failed' })
    },
  },
  {
    name: 'a step deadline',
    ends: 'starts',
    async run(h) {
      await h.timers.tick(STEP_DEADLINE_MS)
    },
  },
  {
    name: 'a Stop',
    ends: 'starts',
    async run(h) {
      await h.svc.reset({ workflowId: h.workflowId, runId: h.runId })
    },
  },
  {
    // Reset is the one ending that drops the parked card on purpose: it clears the lane,
    // so the row's question is answered by an emptied lane instead of a started card.
    name: 'a Reset',
    ends: 'cleared',
    async run(h) {
      await h.svc.reset({ workflowId: h.workflowId })
    },
  },
  {
    name: 'a graph edit that drops the running node',
    ends: 'starts',
    async run(h) {
      await h.svc.saveGraph({
        workflowId: h.workflowId,
        nodes: [{ id: 'other', name: 'Other', prompt: 'Other work.' }],
        edges: [],
      })
    },
  },
  {
    // The window that loads the dead writer's store: the reap a load fires.
    name: 'a load reap',
    ends: 'starts',
    async run(h, dir) {
      const next = service(dir)
      await next.svc.reap()
      h.after = next
    },
  },
  {
    // The same reaper started by the first call that finds the host writable (#2704).
    name: 'a takeover reap',
    ends: 'starts',
    async run(h, dir) {
      const lock = { writable: false }
      const next = service(dir, { readOnly: () => (lock.writable ? undefined : 'read-only') })
      await next.svc.reap() // a reader touches nothing (#2673)
      lock.writable = true
      next.svc.state()
      h.after = next
    },
  },
]

for (const row of ROWS) {
  test(`every terminal transition drains: ${row.name}`, { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-terminal-drain-'))
    try {
      const h = await bench(dir)
      const at = { ...h }
      await row.run(h, dir)
      await settle()
      const view = h.after?.svc ?? at.svc
      const workflowId = at.workflowId

      // The run the row ended is gone either way; what differs is where the parked card went.
      if (row.ends === 'starts') {
        assert.deepEqual(runningOf(view, workflowId), [PARKED], `${row.name}: the parked card did not start`)
        assert.equal(depthOf(view, workflowId), 0, `${row.name}: the lane kept the card behind a free slot`)
      } else {
        assert.deepEqual(runningOf(view, workflowId), [], `${row.name}: a run is still holding the lane`)
        assert.equal(depthOf(view, workflowId), 0, `${row.name}: the lane kept a card it will never start`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

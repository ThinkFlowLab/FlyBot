// #2748 S3 (Test advisory on #2773): taking the step deadline off the serial tail let two drains
// reach one lane in the same turn. A card leaves the queue before its run exists (the host is asked
// to create the run Bots first) and `runningOf()` counts begun runs only, so both drains read the
// free slot and each starts a card: `maxConcurrent` 1 with `activeCount` 2. Red on
// cc35bf484932aba44e24b02a6e3d978495f09aa0; the fix counts a start in flight from the card to
// `beginRun()`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [{ id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false }]

// Absolute time: a timer keeps the instant it is due, so firing one never moves another, and a
// timer created later is due later than it. `nextAt` takes the earliest timer inside a fixed
// window, which is what lets this test fire the two step deadlines and not the spawn bound the
// first drain arms afterwards.
function scheduler() {
  let seq = 0
  let now = 0
  const queue = new Map()
  const setTimer = (fn, ms) => {
    const id = ++seq
    queue.set(id, { fn, due: now + Math.max(1, Number(ms) || 0) })
    return id
  }
  const clearTimer = id => { queue.delete(id) }
  function nextAt(target) {
    let next
    for (const [id, entry] of queue) {
      if (entry.due > target) continue
      if (!next || entry.due < next.entry.due) next = { id, entry }
    }
    if (!next) return null
    queue.delete(next.id)
    now = next.entry.due
    return next.entry.fn
  }
  return { setTimer, clearTimer, nextAt, pending: () => queue.size }
}

const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i += 1) await new Promise(done => setImmediate(done)) }

function harness() {
  const spawned = []
  const released = []
  const warnings = []
  const timers = scheduler()
  const pending = []
  let deferred = false
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: (spec) => {
      if (deferred) return new Promise(resolve => pending.push({ spec, resolve }))
      const id = `eph-${spec.nodeId}-${++seq}`
      spawned.push({ id, spec })
      return Promise.resolve(id)
    },
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: (line) => warnings.push(String(line)),
  })
  return {
    svc, timers, pending, spawned, released, warnings,
    defer(value) { deferred = value },
  }
}

const make = (svc, name) => {
  const made = svc.define({
    name,
    nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Plan.' }],
    edges: [],
  })
  assert.equal(made.ok, true, JSON.stringify(made))
  return made.workflows.find(item => item.name === name)
}

const row = (svc, id) => svc.state().workflows.find(item => item.id === id)
const tasksOf = row => {
  const names = new Set()
  for (const run of row.runs ?? []) if (run.task?.id) names.add(run.task.id)
  for (const task of row.queue ?? []) if (task.id) names.add(task.id)
  return names
}

test('#2748 S3: two drains that reach one lane in the same turn keep it under maxConcurrent', async () => {
  const host = harness()
  const { svc, timers, pending } = host
  const flow = make(svc, 'Cap')
  const other = make(svc, 'Other')
  svc.setConcurrency({ workflowId: flow.id, maxConcurrent: 1 })
  await svc.assign({ workflowId: flow.id, taskId: '#S3a', title: 'Running' })
  await svc.assign({ workflowId: flow.id, taskId: '#S3b', title: 'Second' })
  await svc.assign({ workflowId: flow.id, taskId: '#S3c', title: 'Third' })
  await svc.assign({ workflowId: other.id, taskId: '#S3d', title: 'Other lane' })
  const seeded = row(svc, flow.id)
  assert.equal(seeded.activeCount, 1, 'one live run holds the only slot')
  assert.equal(seeded.queueDepth, 2)

  // Both live runs reach their deadline in the same turn, and the host holds every spawn, so each
  // drain is still waiting for its Bots when the other one looks for a card.
  host.defer(true)
  for (let n = 0; n < 4; n += 1) {
    const fire = timers.nextAt(STEP_DEADLINE_MS + 1)
    if (!fire) break
    Promise.resolve(fire()).catch(() => {})
    await settle()
  }
  const mid = row(svc, flow.id)
  assert.ok(mid.activeCount <= 1, `the cap holds while the starts are in flight (activeCount ${mid.activeCount})`)

  // The host answers every spawn: what the lane counts is what exists now.
  for (let guard = 0; guard < 8 && pending.length > 0; guard += 1) {
    pending.shift().resolve(`e-${++guard}`)
    await settle()
  }
  await settle()
  const after = row(svc, flow.id)
  assert.equal(after.activeCount, 1, `one run at maxConcurrent 1, not ${after.activeCount}`)
  assert.ok(tasksOf(after).has('#S3c'), 'the card the cap kept out is parked, not dropped: ' + [...tasksOf(after)].join(','))
  assert.ok((after.queue ?? []).some(task => task.id === '#S3c'), 'and it is still the next card in the queue')

  // Nothing drains a parked card by itself: ending the live run is what frees the slot.
  host.defer(false)
  const live = after.runs.find(run => run.task?.id && run.task.id !== '#S3c')
  assert.ok(live, 'the run holding the slot is on the row')
  await svc.reset({ workflowId: flow.id, runId: live.id })
  await settle()
  const restarted = row(svc, flow.id)
  assert.equal(restarted.activeCount, 1)
  assert.equal(restarted.runs.find(run => run.status === 'running')?.task?.id, '#S3c', 'the parked card starts once the slot frees')
})

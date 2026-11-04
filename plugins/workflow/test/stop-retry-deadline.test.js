// A Stop whose Bot release fails leaves the run live, `paused` and
// `releasePending` so the next node is handed nothing (#1476). The step deadline
// of the node it was on is still armed — `hold()` writes those flags without
// syncing timers — and `expireStep()` returned at `paused` before doing anything,
// so the timer was consumed and nothing retried the release. The run then held a
// `maxConcurrent` slot until the owner pressed Stop again: the exact promise
// docs/subsystems/workflow.md makes — "a lost Bot cannot hold a lane slot
// forever" (#1530, #1580) — broken by the one path that has a Bot the host would
// not remove. The deadline is now the retry: it releases again, ends the run as
// `paused-expired` and frees the slot, and re-arms itself while a Bot still will
// not go.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_STEP_TIMEOUT_MINUTES, STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

// The same deterministic scheduler deadline.test.js uses: the service asks for a
// timer, the test decides when time passes.
function scheduler() {
  let seq = 0
  const queue = new Map()
  function setTimer(fn, ms) {
    const id = ++seq
    queue.set(id, { fn, due: Math.max(1, Number(ms) || 0) })
    return id
  }
  function clearTimer(id) {
    queue.delete(id)
  }
  async function tick(ms) {
    let left = Math.max(0, Number(ms) || 0)
    let guard = 0
    for (;;) {
      guard += 1
      assert.ok(guard < 100, 'the timers re-armed themselves in a loop')
      let next
      for (const [id, entry] of queue) {
        if (entry.due > left) continue
        if (!next || entry.due < next.entry.due) next = { id, entry }
      }
      if (!next) break
      queue.delete(next.id)
      left -= next.entry.due
      for (const entry of queue.values()) entry.due -= next.entry.due
      await next.entry.fn()
    }
    for (const entry of queue.values()) entry.due -= left
  }
  return { setTimer, clearTimer, tick, pending: () => queue.size }
}

function harness({ releaseFails = new Set() } = {}) {
  const released = []
  const warnings = []
  const timers = scheduler()
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: async (spec) => `eph-${spec.nodeId}-${++seq}`,
    release: async (id) => {
      if (releaseFails.has(id)) throw new Error('the host refused to remove it')
      released.push(id)
    },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: (line) => warnings.push(String(line)),
  })
  return { svc, released, warnings, timers }
}

function make(svc, name = 'Land check') {
  const made = svc.define({
    name,
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  assert.equal(made.ok, true)
  return made.workflows.find(item => item.name === name)
}

const row = (state, workflowId) => state.workflows.find(item => item.id === workflowId)

// #1476 stopped a run into `paused` + `releasePending`; this is the run that then
// had no path back out of the lane. The release the host refuses is the one id the
// run still names, so the retry has something to retry. The lane is capped at one
// run, so a task waiting behind the frozen one can only start once its slot is
// really free.
async function stoppedButHeld({ releaseFails }) {
  const built = harness({ releaseFails })
  const flow = make(built.svc)
  const capped = await built.svc.setConcurrency({ workflowId: flow.id, maxConcurrent: 1 })
  assert.equal(capped.ok, true)
  await built.svc.assign({ workflowId: flow.id, taskId: '#2600', title: 'Stuck stop' })
  const run = row(built.svc.state(), flow.id).run
  releaseFails.add(run.ephemeral.plan)
  const stopped = await built.svc.reset({ workflowId: flow.id, runId: run.id })
  assert.equal(stopped.ok, true)
  const held = row(built.svc.state(), flow.id)
  assert.equal(held.run.paused, true, 'a failed release freezes the run')
  assert.equal(held.activeCount, 1, 'and it still holds the lane slot')
  assert.equal(held.maxConcurrent, 1)
  return { ...built, flow, run }
}

test('the deadline of a Stop that could not release its Bot frees the lane it was holding', async () => {
  const releaseFails = new Set()
  const { svc, released, timers, flow, run } = await stoppedButHeld({ releaseFails })

  // The cap is one: with the frozen run holding it, the next task can only wait.
  await svc.assign({ workflowId: flow.id, taskId: '#2601', title: 'Waiting behind it' })
  const blocked = row(svc.state(), flow.id)
  assert.equal(blocked.activeCount, 1, 'the frozen run really occupies the only slot')
  assert.equal(blocked.queueDepth, 1, 'so the next task is parked, not started')

  releaseFails.clear()
  await timers.tick(STEP_DEADLINE_MS)

  const after = row(svc.state(), flow.id)
  assert.equal(after.run?.task?.id, '#2601', 'the deadline freed the slot with no button pressed, so the parked task starts')
  assert.equal(after.activeCount, 1)
  assert.equal(after.queueDepth, 0)
  assert.ok(released.includes(run.ephemeral.plan), 'the deadline retried the release that failed')
  assert.equal(after.history.length, 1, 'the stopped run is archived')
  assert.equal(after.history[0].id, run.id)
  assert.equal(after.history[0].status, 'failed')
  assert.equal(after.history[0].failure?.code, 'paused-expired', 'its ending is paused-expired, not a run that stays paused')
  assert.equal(timers.pending(), 1, 'the run that started holds its own deadline and nothing else')
})

test('a deadline retry that still cannot release keeps the Bot named and arms the next retry', async () => {
  const releaseFails = new Set()
  const { svc, timers, flow, run } = await stoppedButHeld({ releaseFails })

  await timers.tick(STEP_DEADLINE_MS)

  const after = row(svc.state(), flow.id)
  assert.equal(after.run.paused, true, 'a Bot the host will not remove keeps the run frozen, so nothing is dispatched into its slot')
  assert.equal(after.run.ephemeral?.plan, run.ephemeral.plan, 'the id it could not remove is still named, never dropped')
  assert.equal(timers.pending(), 1, 'the deadline is armed again instead of being consumed by the paused run')
  assert.equal(after.activeCount, 1, 'the slot is still held while its Bot is still there')

  // A later deadline is a later retry, not a one-shot: the second one goes through.
  releaseFails.clear()
  await timers.tick(STEP_DEADLINE_MS)
  const freed = row(svc.state(), flow.id)
  assert.equal(freed.activeCount, 0)
  assert.equal(freed.history[0].failure?.code, 'paused-expired')
})

test('the retry only happens at the deadline the run reached', async () => {
  const releaseFails = new Set()
  const { svc, released, timers, flow, run } = await stoppedButHeld({ releaseFails })
  releaseFails.clear()
  await svc.assign({ workflowId: flow.id, taskId: '#2602', title: 'Waiting behind it' })

  await timers.tick(STEP_DEADLINE_MS - 1)
  const before = row(svc.state(), flow.id)
  assert.equal(before.run.paused, true, 'a frozen run is not ended before its deadline')
  assert.equal(before.run.task.id, '#2600')
  assert.equal(before.activeCount, 1)
  assert.equal(before.queueDepth, 1, 'the parked task is still parked one millisecond early')
  assert.ok(!released.includes(run.ephemeral.plan), 'and nothing was released early')

  await timers.tick(1)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.task.id, '#2602', 'the parked task starts the moment the deadline frees the slot')
  assert.equal(after.activeCount, 1)
  assert.equal(after.queueDepth, 0)
  assert.equal(after.history[0].failure?.code, 'paused-expired')
})

test('a run nobody stopped still fails at its deadline and releases its Bots', async () => {
  const { svc, released, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#2604', title: 'Land check' })
  const run = row(svc.state(), flow.id).run

  await timers.tick(STEP_DEADLINE_MS)

  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed', `the ${DEFAULT_STEP_TIMEOUT_MINUTES}-minute deadline still fails an unanswered step`)
  assert.equal(after.activeCount, 0)
  assert.ok(released.includes(run.ephemeral.plan), 'and its Bot is still released')
  assert.equal(after.history[0].failure?.code, 'step-failed', 'the ending is still the step deadline, not the stop retry')
  assert.equal(timers.pending(), 0)
})

test('an owner Pause is still not timed out', async () => {
  const { svc, released, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#2603', title: 'Paused by hand' })
  const run = row(svc.state(), flow.id).run
  await svc.pause({ workflowId: flow.id, runId: run.id })

  await timers.tick(STEP_DEADLINE_MS * 2)

  const after = row(svc.state(), flow.id)
  assert.equal(after.run.paused, true, 'a Pause the owner asked for keeps the run where it is')
  assert.equal(after.activeCount, 1)
  assert.equal(after.history.length, 0)
  assert.deepEqual(released, [], 'and nothing is released behind the owner')
})

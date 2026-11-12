// A Reset of the whole lane releases every Bot first (#1476). When the host
// refuses one of them, `hold()` freezes every live run as `paused` +
// `releasePending` and the lane keeps its slot — but Reset clears the run timers
// before it releases, so the frozen run is left with nothing that could free it:
// no deadline, no dispatch, and the cards parked behind it wait for the owner to
// save the graph again. The step deadline is the retry a failed Stop already has
// (`hold()` on the one-run path never cleared it), so the whole-lane Reset has to
// arm it too, for every node the run still has `running`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

// The deterministic scheduler deadline.test.js and stop-retry-deadline.test.js use:
// the service asks for a timer, the test decides when time passes.
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
  return {
    setTimer,
    clearTimer,
    tick,
    pending: () => queue.size,
    dues: () => [...queue.values()].map(entry => entry.due),
  }
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

// The lane is capped at one run, so the card parked behind the frozen one can only
// start once the frozen run's deadline really frees the slot.
async function resetButHeld({ releaseFails }) {
  const built = harness({ releaseFails })
  const flow = make(built.svc)
  const capped = await built.svc.setConcurrency({ workflowId: flow.id, maxConcurrent: 1 })
  assert.equal(capped.ok, true)
  await built.svc.assign({ workflowId: flow.id, taskId: '#3100', title: 'Stuck reset' })
  const run = row(built.svc.state(), flow.id).run
  releaseFails.add(run.ephemeral.plan)
  const reset = await built.svc.reset({ workflowId: flow.id })
  assert.equal(reset.ok, true, JSON.stringify(reset))
  return { ...built, flow, run }
}

test('a whole-lane Reset whose release fails arms the deadline that frees the lane', async () => {
  const releaseFails = new Set()
  const { svc, released, timers, flow, run } = await resetButHeld({ releaseFails })

  const held = row(svc.state(), flow.id)
  assert.equal(held.run.paused, true, 'a failed release freezes the run')
  assert.equal(held.activeCount, 1, 'and the frozen run keeps the lane slot')
  assert.equal(timers.pending(), 1, 'the frozen run still carries the step deadline that will retry the release')
  assert.deepEqual(timers.dues(), [STEP_DEADLINE_MS], 'it is the step deadline the run was started with')

  await svc.assign({ workflowId: flow.id, taskId: '#3101', title: 'Waiting behind it' })
  assert.equal(row(svc.state(), flow.id).queueDepth, 1, 'the frozen run really blocks the only slot')

  releaseFails.clear()
  await timers.tick(STEP_DEADLINE_MS)

  const after = row(svc.state(), flow.id)
  assert.equal(after.run?.task?.id, '#3101', 'the deadline freed the slot with no second Reset, so the parked card starts')
  assert.equal(after.activeCount, 1)
  assert.equal(after.queueDepth, 0)
  assert.ok(released.includes(run.ephemeral.plan), 'the deadline retried the release that failed')
  assert.equal(after.history[0].id, run.id, 'the frozen run is archived')
  assert.equal(after.history[0].failure?.code, 'paused-expired', 'its ending is paused-expired, not a run that stays paused for ever')
  assert.equal(timers.pending(), 1, 'the run that started holds its own deadline and nothing else')
})

test('a whole-lane Reset that releases every Bot still leaves no timer behind', async () => {
  const releaseFails = new Set()
  const built = harness({ releaseFails })
  const flow = make(built.svc)
  await built.svc.assign({ workflowId: flow.id, taskId: '#3102', title: 'Clean reset' })
  const run = row(built.svc.state(), flow.id).run

  const reset = await built.svc.reset({ workflowId: flow.id })
  assert.equal(reset.ok, true, JSON.stringify(reset))
  const after = row(built.svc.state(), flow.id)
  assert.equal(after.activeCount, 0, 'a Reset that keeps its promise leaves the lane idle')
  assert.equal(after.history.length, 0, 'it clears the lane instead of archiving a frozen run')
  assert.ok(!after.run?.paused, 'nothing is left paused')
  assert.equal(built.timers.pending(), 0, 'and no deadline outlives the run it belonged to')
  assert.ok(built.released.includes(run.ephemeral.plan), 'the Bot did go')
})

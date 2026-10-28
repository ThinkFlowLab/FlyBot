// #1530: a live step stays running until its Bot replies, and nothing bounded
// that wait. A dispatch that never lands, or a reply that never arrives, left
// the run "running" with its node in flight forever. Every wait now has a
// deadline: a hand-off is retried a bounded number of times, a step that is not
// answered by its deadline fails the run and releases the Bots, and both
// timers are cleared when the step moves or the run stops.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_STEP_TIMEOUT_MINUTES, HANDOFF_RETRY_DELAYS_MS, STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

// A deterministic scheduler: the service asks for a timer, the test decides
// when time passes. Awaiting tick() awaits whatever the timers started, so a
// test sees the same state a host would see.
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

function harness({ dispatchResults = () => ({ ok: true }) } = {}) {
  const spawned = []
  const released = []
  const dispatched = []
  const warnings = []
  const timers = scheduler()
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: async (spec) => {
      const id = `eph-${spec.nodeId}-${++seq}`
      spawned.push({ id, spec })
      return id
    },
    release: async (id) => { released.push(id) },
    dispatch: async (step) => {
      dispatched.push(step)
      return dispatchResults(step, dispatched.length)
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: (line) => warnings.push(String(line)),
  })
  return { svc, spawned, released, dispatched, warnings, timers }
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

function row(state, workflowId) {
  return state.workflows.find(item => item.id === workflowId)
}

function chat(state, workflowId) {
  return row(state, workflowId).messages.map(message => message.text).join('\n')
}

const RETRY_SPAN = HANDOFF_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)

test('#1530: a dispatch that never lands is retried, then fails the step instead of staying running', async () => {
  const { svc, dispatched, released, warnings, timers } = harness({
    dispatchResults: () => ({ ok: false, action: 'deny', code: 'deny' }),
  })
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1530', title: 'Land check' })

  const started = row(svc.state(), flow.id)
  assert.equal(started.run.status, 'running')
  assert.equal(started.run.nodeStatus.plan, 'running')
  assert.equal(dispatched.length, 1)

  await timers.tick(RETRY_SPAN + 1)

  const after = row(svc.state(), flow.id)
  assert.equal(dispatched.length, 1 + HANDOFF_RETRY_DELAYS_MS.length)
  assert.notEqual(after.run.status, 'running')
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.equal(after.activeCount, 0)
  assert.match(chat(svc.state(), flow.id), /deny/)
  assert.ok(released.length > 0, 'the run Bots are released')
  assert.ok(warnings.some(line => /deny/.test(line)))
  assert.equal(timers.pending(), 0, 'no timer is left behind')
})

test('#1530: a transient dispatch failure is retried and leaves the step running', async () => {
  let calls = 0
  const { svc, dispatched, timers } = harness({
    dispatchResults: () => {
      calls += 1
      return calls === 1 ? { ok: false, action: 'deny', code: 'deny' } : { ok: true }
    },
  })
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1531', title: 'Land check' })

  assert.equal(dispatched.length, 1)
  await timers.tick(HANDOFF_RETRY_DELAYS_MS[0] + 1)

  const after = row(svc.state(), flow.id)
  assert.equal(dispatched.length, 2)
  assert.equal(after.run.status, 'running')
  assert.equal(after.run.nodeStatus.plan, 'running')
  assert.doesNotMatch(chat(svc.state(), flow.id), /已标记失败/)
})

test('#1530: a step nobody answers fails the run at its deadline and releases the Bots', async () => {
  const { svc, released, warnings, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1532', title: 'Land check' })

  assert.equal(row(svc.state(), flow.id).run.nodeStatus.plan, 'running')
  assert.equal(timers.pending(), 1, 'the running step holds one deadline')

  await timers.tick(STEP_DEADLINE_MS - 1)
  assert.equal(row(svc.state(), flow.id).run.status, 'running')

  await timers.tick(1)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.equal(after.activeCount, 0)
  assert.match(chat(svc.state(), flow.id), /超时|timed out/i)
  assert.ok(released.length > 0)
  assert.ok(warnings.some(line => /timed out|超时/.test(line)))
  assert.equal(timers.pending(), 0, 'the deadline is cleared once the run ends')

  // Past the deadline the Bots are gone, so a late reply must not resurrect the run.
  await timers.tick(STEP_DEADLINE_MS * 2)
  assert.equal(row(svc.state(), flow.id).run.status, 'failed')
  assert.equal(timers.pending(), 0)
})

test('#1530: a reply before the deadline advances the run and no deadline outlives its step', async () => {
  const { svc, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1533', title: 'Land check' })
  const run = row(svc.state(), flow.id).run

  await svc.stepResult({ botId: run.ephemeral.plan, text: 'The plan is ready.' })
  const moved = row(svc.state(), flow.id).run
  assert.equal(moved.nodeStatus.plan, 'done')
  assert.equal(moved.nodeStatus.code, 'running')
  assert.equal(timers.pending(), 1, 'only the step that is actually running holds a deadline')

  await timers.tick(STEP_DEADLINE_MS - 1)
  assert.equal(row(svc.state(), flow.id).run.status, 'running')
  assert.equal(row(svc.state(), flow.id).run.nodeStatus.code, 'running')

  await svc.stepResult({ botId: moved.ephemeral.code, text: 'The code is ready.' })
  const done = row(svc.state(), flow.id)
  assert.equal(done.run.status, 'done')
  assert.equal(done.run.nodeStatus.code, 'done')
  assert.equal(timers.pending(), 0)
})

test('#1530: a paused run is not timed out, and resuming arms a fresh deadline', async () => {
  const { svc, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1534', title: 'Land check' })
  const run = row(svc.state(), flow.id).run

  await svc.pause({ workflowId: flow.id, runId: run.id })
  assert.equal(timers.pending(), 0, 'a paused run holds no timer')
  await timers.tick(STEP_DEADLINE_MS * 2)
  assert.equal(row(svc.state(), flow.id).run.status, 'running')
  assert.equal(row(svc.state(), flow.id).run.paused, true)

  await svc.resume({ workflowId: flow.id, runId: run.id })
  assert.equal(timers.pending(), 1, 'resuming arms the deadline again')
  await timers.tick(STEP_DEADLINE_MS)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.nodeStatus.plan, 'failed')
})

test('#1530: Stop, Reset and dispose clear every timer and release the Bots', async () => {
  const { svc, released, timers } = harness()
  const flow = make(svc)

  await svc.assign({ workflowId: flow.id, taskId: '#1535', title: 'Stop one' })
  const first = row(svc.state(), flow.id).run
  assert.equal(timers.pending(), 1)
  const stopped = await svc.reset({ workflowId: flow.id, runId: first.id })
  assert.equal(stopped.ok, true)
  assert.equal(timers.pending(), 0, 'Stop clears the deadline')
  assert.ok(released.length >= 2)

  await svc.assign({ workflowId: flow.id, taskId: '#1536', title: 'Reset all' })
  assert.equal(timers.pending(), 1)
  const reset = await svc.reset({ workflowId: flow.id })
  assert.equal(reset.ok, true)
  assert.equal(timers.pending(), 0, 'Reset clears the deadline')

  await svc.assign({ workflowId: flow.id, taskId: '#1537', title: 'Dispose' })
  assert.equal(timers.pending(), 1)
  const beforeDispose = released.length
  await svc.dispose()
  assert.equal(timers.pending(), 0, 'dispose clears the deadline')
  assert.ok(released.length > beforeDispose)
  await timers.tick(STEP_DEADLINE_MS * 2)
  assert.equal(timers.pending(), 0)
})

test('#1530: a reply that no longer matches a running step is warned about once, not swallowed', async () => {
  const { svc, warnings, timers } = harness()
  const flow = make(svc)
  await svc.assign({ workflowId: flow.id, taskId: '#1538', title: 'Late reply' })
  const run = row(svc.state(), flow.id).run

  await timers.tick(STEP_DEADLINE_MS)
  assert.equal(row(svc.state(), flow.id).run.status, 'failed')
  const before = warnings.length
  await svc.stepResult({ botId: run.ephemeral.plan, text: 'Too late.' })
  await svc.stepResult({ botId: run.ephemeral.plan, text: 'Still too late.' })
  const late = warnings.filter(line => /no running step|no longer running/.test(line))
  assert.equal(late.length, 1)
  assert.ok(warnings.length > before)
  assert.equal(row(svc.state(), flow.id).run.status, 'failed')
})


test('#1530: a live step with no ephemeral map still expires at the deadline', async () => {
  // Hosts that cannot spawn still start live runs via advance(); the deadline
  // must arm without an ephemeral map so a silent step cannot hold the lane.
  const timers = (() => {
    let seq = 0
    const queue = new Map()
    return {
      setTimer(fn, ms) {
        const id = ++seq
        queue.set(id, { fn, due: Math.max(1, Number(ms) || 0) })
        return id
      },
      clearTimer(id) { queue.delete(id) },
      async tick(ms) {
        let left = Math.max(0, Number(ms) || 0)
        for (;;) {
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
      },
      pending: () => queue.size,
    }
  })()
  const warnings = []
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    // no spawn / release / dispatch → no ephemeral map
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: (line) => warnings.push(String(line)),
  })
  const flow = make(svc, 'No ephemeral deadline')
  await svc.assign({ workflowId: flow.id, taskId: '#1530-no-eph', title: 'Silent step' })
  assert.equal(row(svc.state(), flow.id).run.nodeStatus.plan, 'running')
  assert.equal(row(svc.state(), flow.id).run.ephemeral, undefined)
  assert.equal(timers.pending(), 1, 'deadline arms without ephemeral')
  await timers.tick(STEP_DEADLINE_MS)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.ok(warnings.some(line => /timed out|超时/.test(line)))
  assert.equal(timers.pending(), 0)
})

// #1580: the deadline is per workflow, and ten minutes was shorter than the work
// a node does, so every implementing or reviewing step was killed mid-flight.
const TIMED_NODES = [
  { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
  { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
]

function makeTimed(svc, minutes, name) {
  const made = svc.create({
    name,
    nodes: TIMED_NODES,
    edges: [{ from: 'plan', to: 'code' }],
    ...(minutes === undefined ? {} : { stepTimeoutMinutes: minutes }),
  })
  assert.equal(made.ok, true)
  return made.workflows.find(item => item.name === name)
}

test('#1580: the default deadline covers real work, so ten minutes no longer fails a step', async () => {
  const { svc, released, timers } = harness()
  const flow = makeTimed(svc, undefined, 'Default deadline')
  assert.equal(DEFAULT_STEP_TIMEOUT_MINUTES, 45)
  assert.equal(row(svc.state(), flow.id).stepTimeoutMinutes, DEFAULT_STEP_TIMEOUT_MINUTES)

  await svc.assign({ workflowId: flow.id, taskId: '#1580-default', title: 'Real work' })
  await timers.tick(10 * 60 * 1000)
  assert.equal(row(svc.state(), flow.id).run.status, 'running', 'ten minutes is inside the default')
  assert.equal(released.length, 0)

  await timers.tick(STEP_DEADLINE_MS - 10 * 60 * 1000)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed')
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.match(chat(svc.state(), flow.id), /45 分钟/)
})

test('#1580: a workflow that sets stepTimeoutMinutes times its steps out on its own number', async () => {
  const { svc, timers } = harness()
  const flow = makeTimed(svc, 20, 'Twenty minute step')
  assert.equal(row(svc.state(), flow.id).stepTimeoutMinutes, 20)

  await svc.assign({ workflowId: flow.id, taskId: '#1580-own', title: 'Own number' })
  await timers.tick(20 * 60 * 1000 - 1)
  assert.equal(row(svc.state(), flow.id).run.status, 'running')

  await timers.tick(1)
  const after = row(svc.state(), flow.id)
  assert.equal(after.run.status, 'failed')
  assert.match(chat(svc.state(), flow.id), /20 分钟/)
})

test('#1580: a stepTimeoutMinutes outside 1..120 is refused when the workflow is written', () => {
  const { svc } = harness()
  for (const [value, name] of [[0, 'Zero'], [121, 'Too long'], ['abc', 'Not a number'], [-5, 'Negative'], [1.5, 'Fractional']]) {
    const made = svc.create({ name, stepTimeoutMinutes: value, nodes: TIMED_NODES, edges: [{ from: 'plan', to: 'code' }] })
    assert.equal(made.ok, false, name + ' must be refused')
    assert.match(String(made.error), /stepTimeoutMinutes/)
  }

  const made = svc.create({ name: 'Set later', nodes: TIMED_NODES, edges: [{ from: 'plan', to: 'code' }] })
  assert.equal(made.ok, true)
  const flow = made.workflows.find(item => item.name === 'Set later')
  assert.equal(flow.stepTimeoutMinutes, DEFAULT_STEP_TIMEOUT_MINUTES)
  assert.equal(svc.setStepTimeout({ workflowId: flow.id, stepTimeoutMinutes: 999 }).ok, false)
  const good = svc.setStepTimeout({ workflowId: flow.id, stepTimeoutMinutes: 30 })
  assert.equal(good.ok, true)
  assert.equal(row(good, flow.id).stepTimeoutMinutes, 30)
  const cleared = svc.setStepTimeout({ workflowId: flow.id, stepTimeoutMinutes: null })
  assert.equal(cleared.ok, true)
  assert.equal(row(cleared, flow.id).stepTimeoutMinutes, DEFAULT_STEP_TIMEOUT_MINUTES)
})

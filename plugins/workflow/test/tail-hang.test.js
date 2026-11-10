// #2748 probes: an unbounded host call inside the serial tail parks the one
// thing that bounds everything else (the step deadline). Each case below is red
// on f2ef4dfa and names the terminal state the fix must leave behind.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_DEADLINE_MS, createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const ROSTER = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

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
  // Fire every timer that comes due within `ms` without awaiting what it starts:
  // a timer whose promise never settles is exactly the state under test, so
  // awaiting it would hang the test instead of describing the bug.
  function fire(ms) {
    let left = Math.max(0, Number(ms) || 0)
    let fired = 0
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
      fired += 1
      Promise.resolve(next.entry.fn()).catch(() => {})
    }
    for (const entry of queue.values()) entry.due -= left
    return fired
  }
  return { setTimer, clearTimer, fire, pending: () => queue.size }
}

async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i += 1) await new Promise(done => setImmediate(done))
}

function harness({ dispatch = async () => ({ ok: true }), spawn, release } = {}) {
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
    spawn: spawn ?? (async (spec) => {
      const id = `eph-${spec.nodeId}-${++seq}`
      spawned.push({ id, spec })
      return id
    }),
    release: release ?? (async (id) => { released.push(id) }),
    dispatch: async (step) => {
      dispatched.push(step)
      return dispatch(step)
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

test('#2748 C1: a dispatch that never settles still reaches failed at its step deadline', async () => {
  const never = new Promise(() => {})
  const { svc, released, timers } = harness({ dispatch: () => never })
  const flow = make(svc)
  const assigning = svc.assign({ workflowId: flow.id, taskId: '#2748-C1', title: 'Hang dispatch' })
  assigning.catch(() => {})
  await settle()

  const started = row(svc.state(), flow.id)
  assert.equal(started.run.status, 'running', 'the run started and is waiting on the peer Bot')
  assert.equal(started.run.nodeStatus.plan, 'running')

  timers.fire(STEP_DEADLINE_MS + 1)
  await settle()

  const after = row(svc.state(), flow.id)
  // eslint-disable-next-line no-console
  console.log(`# PROBE C1 status: ${after.run.status} node: ${after.run.nodeStatus.plan} active: ${after.activeCount} released: ${released.length} timersLeft: ${timers.pending()}`)
  assert.equal(after.run.status, 'failed', 'the deadline ends the run even while the dispatch hangs')
  assert.equal(after.run.nodeStatus.plan, 'failed')
  assert.equal(after.activeCount, 0)
  assert.ok(released.length > 0, 'the run Bots are released')
})

test('#2748 C2: a release that never settles does not starve another workflow\'s deadline', async () => {
  const hang = new Set()
  const released = []
  let svc
  const timers = scheduler()
  let seq = 0
  svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: async (spec) => {
      const id = `eph-${spec.nodeId}-${++seq}`
      return id
    },
    release: (id) => {
      if (hang.has(id)) return new Promise(() => {})
      released.push(id)
      return Promise.resolve()
    },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: () => {},
  })
  const alpha = make(svc, 'Alpha')
  const bravo = make(svc, 'Bravo')
  await svc.assign({ workflowId: alpha.id, taskId: '#2748-C2a', title: 'Alpha' })
  await svc.assign({ workflowId: bravo.id, taskId: '#2748-C2b', title: 'Bravo' })
  const alphaRun = row(svc.state(), alpha.id).run
  const bravoRun = row(svc.state(), bravo.id).run
  for (const id of Object.values(alphaRun.ephemeral)) hang.add(id)

  const stopping = svc.reset({ workflowId: alpha.id, runId: alphaRun.id })
  stopping.catch(() => {})
  await settle()

  timers.fire(STEP_DEADLINE_MS + 1)
  await settle()

  const bravoAfter = row(svc.state(), bravo.id)
  const bravoReleased = Object.values(bravoRun.ephemeral).filter(id => released.includes(id))
  // eslint-disable-next-line no-console
  console.log(`# PROBE C2 alpha: ${row(svc.state(), alpha.id).run.status} bravo before: ${bravoRun.status} after its deadline: ${bravoAfter.run.status} bravo node: ${bravoAfter.run.nodeStatus.plan} released: ${released.length} timersLeft: ${timers.pending()}`)
  assert.equal(bravoAfter.run.status, 'failed', 'the other workflow still reaches its deadline')
  assert.equal(bravoAfter.activeCount, 0)
  assert.equal(bravoReleased.length, Object.values(bravoRun.ephemeral).length, 'its Bots are released')
})

test('#2748 C4: a spawn that never answers keeps the queued card instead of losing it', async () => {
  const never = new Promise(() => {})
  let hangSpawn = false
  const { svc, timers } = harness({
    spawn: (spec) => (hangSpawn ? never : Promise.resolve(`eph-${spec.nodeId}`)),
  })
  const flow = make(svc)
  svc.setConcurrency({ workflowId: flow.id, maxConcurrent: 1 })
  await svc.assign({ workflowId: flow.id, taskId: '#2748-C4a', title: 'Running card' })
  const first = row(svc.state(), flow.id).run
  await svc.assign({ workflowId: flow.id, taskId: '#2748-C4b', title: 'Queued card' })
  assert.equal(row(svc.state(), flow.id).queueDepth, 1, 'the second card waits for the slot')

  // The slot frees while the host is no longer answering a spawn: takeNext has
  // already shifted the card, so the only thing that keeps it is a terminal path.
  hangSpawn = true
  let settled = false
  const finishing = (async () => {
    await svc.stepResult({ botId: first.ephemeral.plan, text: 'plan done' })
    await svc.stepResult({ botId: first.ephemeral.code, text: 'code done' })
  })()
  finishing.then(() => { settled = true }, () => { settled = true })
  await settle()
  assert.equal(row(svc.state(), flow.id).queueDepth, 0, 'on base the card is already out of the queue')

  timers.fire(STEP_DEADLINE_MS + 1)
  await settle()

  const after = row(svc.state(), flow.id)
  // eslint-disable-next-line no-console
  console.log(`# PROBE C4 settled: ${settled} queue: ${after.queueDepth} active: ${after.activeCount} card: ${after.queue[0]?.id ?? 'none'}`)
  assert.equal(settled, true, 'the call answers instead of hanging for ever')
  assert.equal(after.activeCount, 0)
  assert.equal(after.queueDepth, 1, 'the card is back in the queue')
  assert.equal(after.queue[0].id, '#2748-C4b')
})

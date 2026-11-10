// #2785: a spawn the host answers after the deadline is not released when that
// answer is a failure. `spawnAll` hangs the ids it already made on the error
// (`error.spawned`), so the deadline branch holds exactly what leaked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SPAWN_DEADLINE_MS, createWorkflowService } from '../src/service.js'

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

// `plan` is created at once, so `spawnAll` holds one id when the second spawn is
// still pending; `code` is the one the host answers late (or early, in the control).
function harness({ late = true } = {}) {
  const spawned = []
  const released = []
  const warnings = []
  const timers = scheduler()
  const gate = {}
  gate.promise = new Promise((resolve, reject) => {
    gate.resolve = resolve
    gate.reject = reject
  })
  const svc = createWorkflowService({
    persist: false,
    now: () => CLOCK,
    bots: () => ROSTER,
    spawn: async (spec) => {
      if (spec.nodeId === 'plan') {
        const id = 'eph-plan'
        spawned.push({ id, spec })
        return id
      }
      if (late) return gate.promise
      throw new Error('the host could not create the coder')
    },
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    warn: (line) => warnings.push(String(line)),
  })
  return { svc, spawned, released, warnings, timers, gate }
}

function flow(svc) {
  const made = svc.define({
    name: 'Late spawn',
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  assert.equal(made.ok, true)
  return made.workflows.find(item => item.name === 'Late spawn')
}

test('#2785: a late spawn failure still releases the Bots it made', async () => {
  const { svc, released, warnings, timers, gate } = harness({ late: true })
  const item = flow(svc)
  const assigning = svc.assign({ workflowId: item.id, taskId: '#2785-late', title: 'Late failure' })
  assigning.catch(() => {})
  await settle()

  timers.fire(SPAWN_DEADLINE_MS + 1)
  await settle()
  const refused = await assigning
  assert.equal(refused.ok, false, 'the start is refused at the deadline')
  assert.match(refused.error, /did not create the run Bots/)

  // The host answers the pending spawn after the refusal: `spawnAll` hangs the id
  // it already made on the error, and nothing else will ever name it.
  gate.reject(new Error('the host could not create the coder'))
  await settle()

  assert.deepEqual(released, ['eph-plan'], 'the Bot made before the failed answer is released')
  assert.ok(
    !warnings.some(line => line.includes('could not release its Bots')),
    `no release failed: ${warnings.join(' | ')}`,
  )
})

test('#2785 control: the same partial failure answered before the deadline is released', async () => {
  const { svc, released, timers } = harness({ late: false })
  const item = flow(svc)
  const refused = await svc.assign({ workflowId: item.id, taskId: '#2785-early', title: 'Early failure' })

  assert.equal(refused.ok, false, 'the start is refused when the spawn fails')
  assert.deepEqual(released, ['eph-plan'], 'the early answer releases the same id')
  assert.equal(timers.pending(), 0, 'the deadline is cleared when the answer arrived in time')
})

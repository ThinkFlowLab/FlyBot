// #1531: a `workflow/reset` that is going to be refused must be refused
// *before* it touches the lane. Clearing first and validating after throws away
// a queue, and drops a live run (and its Bot ids) on a path that never writes
// or releases them, so the next ordinary write flushes the empty lane to disk.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { freshStatus, normalizeGraph } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID, deliveryWorkflow } from '../src/template.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]
const CLOCK = 1_700_000_000_000
const FILE = 'workflows.json'

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
}

function lane(id, value) {
  return { active: [], queue: [], last: null, history: [], ...value }
}

function liveRun(overrides = {}) {
  return {
    id: 'run-1',
    workflowId: DELIVERY_ID,
    task: null,
    status: 'running',
    live: true,
    nodeStatus: { ...freshStatus(normalizeGraph(deliveryWorkflow())), planner: 'running' },
    steps: 0,
    stepBudget: 10,
    failedOnce: {},
    produced: {},
    history: [],
    startedAt: CLOCK,
    updatedAt: CLOCK,
    ephemeral: { plan: 'eph-plan' },
    ...overrides,
  }
}

function open(dir) {
  const released = []
  const spawned = []
  let seq = 0
  const svc = createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
    spawn: async () => {
      seq += 1
      const id = `eph-new-${seq}`
      spawned.push(id)
      return id
    },
    release: async (id) => { released.push(id) },
    dispatch: async () => ({ ok: true }),
  })
  return { svc, released, spawned }
}

// Write a lane fixture through the real store: boot the service, let a plain
// write create the file, then put the lane under test in it and reload.
function seed(dir, value) {
  const first = open(dir)
  first.svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 2 })
  const store = readStore(dir)
  store.lanes[DELIVERY_ID] = lane(DELIVERY_ID, value)
  writeFileSync(join(dir, FILE), JSON.stringify(store))
}

function itemOf(state, id = DELIVERY_ID) {
  return state.workflows.find(workflow => workflow.id === id)
}

test('a refused reset leaves the queue untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reset-'))
  try {
    seed(dir, { queue: [{ id: 'task-1', title: 'A queued task that must not vanish' }] })
    const { svc, released } = open(dir)

    const refused = await svc.reset({ workflowId: DELIVERY_ID })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'This workflow has no task')

    const after = itemOf(svc.state())
    assert.equal(after.queueDepth, 1)
    assert.equal(after.queue.length, 1)
    assert.equal(after.queue[0].id, 'task-1')
    assert.deepEqual(released, [])

    // The next ordinary write must not flush a lane the reset was refused for.
    const renamed = await svc.rename({ workflowId: DELIVERY_ID, name: 'Renamed after the refusal' })
    assert.equal(renamed.ok, true)
    assert.equal(itemOf(svc.state()).queue.length, 1)
    assert.equal(readStore(dir).lanes[DELIVERY_ID].queue.length, 1)

    // And a reload of the store still has the queued task.
    assert.equal(itemOf(open(dir).svc.state()).queue.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused reset keeps a run that has no task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reset-'))
  try {
    const run = liveRun()
    seed(dir, { active: [run] })
    const { svc, released } = open(dir)
    const before = itemOf(svc.state())

    const refused = await svc.reset({ workflowId: DELIVERY_ID })
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'This workflow has no task')

    const after = itemOf(svc.state())
    assert.equal(after.activeCount, 1)
    assert.equal(after.runs.length, 1)
    assert.equal(after.runs[0].id, run.id)
    assert.deepEqual(after.runs[0].nodeStatus, before.runs[0].nodeStatus)
    assert.equal(after.run?.status, 'running')
    assert.deepEqual(released, [])
    assert.deepEqual(readStore(dir).lanes[DELIVERY_ID].active.map(item => item.id), [run.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reset with a task still clears the lane and releases its Bots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-reset-'))
  try {
    const run = liveRun({
      task: { id: '#1472', title: 'A task that exists' },
      ephemeral: { plan: 'eph-plan', code: 'eph-code' },
    })
    seed(dir, { active: [run], queue: [{ id: 'task-2', title: 'Queued behind' }] })
    const { svc, released } = open(dir)

    const reset = await svc.reset({ workflowId: DELIVERY_ID })
    assert.equal(reset.ok, true)

    const after = itemOf(svc.state())
    assert.equal(after.activeCount, 0)
    assert.equal(after.queueDepth, 0)
    assert.deepEqual(after.runs, [])
    assert.deepEqual([...released].sort(), ['eph-code', 'eph-plan'])
    const stored = readStore(dir).lanes[DELIVERY_ID]
    assert.equal(stored.active.length, 0)
    assert.equal(stored.queue.length, 0)
    assert.equal(stored.last?.task?.id, '#1472')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

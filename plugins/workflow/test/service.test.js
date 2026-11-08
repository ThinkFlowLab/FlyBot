// #2673: a second, read-only host on the same home is a reader. It never ran the
// writer's runs, so it cannot tell which of them a dead host left behind — and it
// must not end them, release their step Bots or overwrite the store with its own
// older copy. The writer's own reap() is the one that decides.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

const CLOCK = 1_700_000_000_000

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

function storeText(dir) {
  return readFileSync(join(dir, 'workflows.json'), 'utf8')
}

function storedRun(store, workflowId, runId) {
  const lane = store.lanes?.[workflowId]
  if (!lane) return undefined
  return (lane.active ?? []).find(run => run.id === runId) ?? (lane.last?.id === runId ? lane.last : undefined)
}

function pair(name, svc) {
  return svc.define({
    name,
    nodes: [
      { id: 'plan', name: 'Planner', role: 'plan', prompt: 'Write the plan.' },
      { id: 'code', name: 'Coder', role: 'code', prompt: 'Implement it.' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  }).workflows.find(item => item.name === name)
}

// The writer starts one live run (plan running, code queued, both Bots spawned and
// written), a second service opens the same store — it holds that older copy — and
// then the writer advances the run on disk to plan done / code running.
async function twoHosts(dir, readOnly) {
  let seq = 0
  const spawned = []
  const writerReleases = []
  const readerReleases = []
  const writer = createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
    spawn: async (spec) => {
      seq += 1
      const id = `eph-${spec.nodeId}-${seq}`
      spawned.push(id)
      return id
    },
    release: async (id) => { writerReleases.push(id) },
    dispatch: async () => ({ ok: true }),
  })
  const made = pair('Lane', writer)
  const started = await writer.runNamed({ workflow: 'Lane', brief: 'Ship the notice', task: '#2673' })
  assert.equal(started.ok, true)
  const runId = started.workflows.find(item => item.id === made.id).run.id
  assert.deepEqual(Object.values(storedRun(readStore(dir), made.id, runId).ephemeral).sort(), ['eph-code-2', 'eph-plan-1'])

  const reader = createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
    readOnly,
    release: async (id) => { readerReleases.push(id) },
    dispatch: async () => ({ ok: true }),
  })

  const advanced = await writer.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'done' })
  assert.equal(advanced.ok, true)
  const live = storedRun(readStore(dir), made.id, runId)
  assert.equal(live.status, 'running')
  assert.equal(live.nodeStatus.plan, 'done')
  assert.equal(live.nodeStatus.code, 'running')

  return { writer, reader, made, runId, spawned, writerReleases, readerReleases }
}

function assertWriterRunIntact(dir, made, runId) {
  const row = storedRun(readStore(dir), made.id, runId)
  assert.equal(row.status, 'running')
  assert.equal(row.nodeStatus.plan, 'done')
  assert.equal(row.nodeStatus.code, 'running')
}

test('#2673: a read-only host does not reap the writer\'s live run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-readonly-reap-'))
  try {
    const { reader, made, runId } = await twoHosts(dir, () => true)
    const before = storeText(dir)
    await reader.reap()
    assert.equal(storeText(dir), before, 'the read-only host overwrote the writer\'s store')
    assertWriterRunIntact(dir, made, runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2673: a read-only host does not dispose the writer\'s live run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-readonly-dispose-'))
  try {
    const { reader, made, runId } = await twoHosts(dir, () => true)
    const before = storeText(dir)
    await reader.dispose()
    assert.equal(storeText(dir), before, 'the read-only host overwrote the writer\'s store')
    assertWriterRunIntact(dir, made, runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2673: a read-only host releases none of the writer\'s step Bots', async () => {
  const reapDir = mkdtempSync(join(tmpdir(), 'wf-readonly-reap-bots-'))
  try {
    const { reader, readerReleases } = await twoHosts(reapDir, () => true)
    await reader.reap()
    assert.deepEqual(readerReleases, [], 'reap() released the writer\'s step Bots')
  } finally {
    rmSync(reapDir, { recursive: true, force: true })
  }

  const disposeDir = mkdtempSync(join(tmpdir(), 'wf-readonly-dispose-bots-'))
  try {
    const { reader, readerReleases } = await twoHosts(disposeDir, () => true)
    await reader.dispose()
    assert.deepEqual(readerReleases, [], 'dispose() released the writer\'s step Bots')
  } finally {
    rmSync(disposeDir, { recursive: true, force: true })
  }
})

// The writer's side is unchanged: the same stale second service on a writable
// host still ends the run, releases its Bots and writes the record back.
test('#2673: a writable host still reaps and disposes the run it did not start', async () => {
  const reapDir = mkdtempSync(join(tmpdir(), 'wf-writer-reap-'))
  try {
    const { reader, made, runId, spawned, readerReleases } = await twoHosts(reapDir, () => false)
    const before = storeText(reapDir)
    await reader.reap()
    assert.notEqual(storeText(reapDir), before)
    const row = storedRun(readStore(reapDir), made.id, runId)
    assert.equal(row.status, 'failed')
    assert.equal(row.failure.code, 'host-ended')
    assert.equal(row.ephemeral, undefined)
    assert.equal((readStore(reapDir).lanes[made.id].active ?? []).length, 0)
    assert.deepEqual([...readerReleases].sort(), [...spawned].sort())
  } finally {
    rmSync(reapDir, { recursive: true, force: true })
  }

  const disposeDir = mkdtempSync(join(tmpdir(), 'wf-writer-dispose-'))
  try {
    const { reader, made, runId, spawned, readerReleases } = await twoHosts(disposeDir, () => false)
    const before = storeText(disposeDir)
    const disposing = reader.dispose()
    assert.equal(typeof disposing?.then, 'function', 'dispose() hands the release back as a promise')
    await disposing
    assert.notEqual(storeText(disposeDir), before)
    const row = storedRun(readStore(disposeDir), made.id, runId)
    assert.equal(row.status, 'failed')
    assert.equal(row.failure.code, 'host-ended')
    assert.equal(row.ephemeral, undefined)
    assert.equal((readStore(disposeDir).lanes[made.id].active ?? []).length, 0)
    assert.deepEqual([...readerReleases].sort(), [...spawned].sort())
  } finally {
    rmSync(disposeDir, { recursive: true, force: true })
  }
})

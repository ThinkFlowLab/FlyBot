// #1387: dispose() releases the run Bots *before* the record drops their ids,
// and hands the host a promise it can await. A state file that forgets an id
// while its Bot is still alive leaves a hidden Bot nobody can see or remove.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
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

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
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

test('#1387: dispose() releases the Bots before the record drops their ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dispose-'))
  const released = []
  const pending = deferred()
  let seq = 0
  try {
    // Two runs, two nodes each: four instances, so the release really is a set.
    const svc = createWorkflowService({
      dir,
      persist: true,
      now: () => CLOCK,
      bots: () => roster,
      spawn: async (spec) => {
        seq += 1
        return `eph-${spec.nodeId}-${seq}`
      },
      // A slow release: nothing resolves until the test says so.
      release: (id) => {
        released.push(id)
        return pending.promise
      },
      dispatch: async () => ({ ok: true }),
    })
    const first = pair('First', svc)
    const second = pair('Second', svc)
    const a = await svc.runNamed({ workflow: 'First', brief: 'Ship the note', task: '#1387a' })
    const b = await svc.runNamed({ workflow: 'Second', brief: 'Ship the other', task: '#1387b' })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    const runA = a.workflows.find(item => item.id === first.id).run
    const runB = b.workflows.find(item => item.id === second.id).run
    const ids = [...Object.values(runA.ephemeral), ...Object.values(runB.ephemeral)]
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4)

    const before = storeText(dir)
    const stored = readStore(dir)
    const rowA = storedRun(stored, first.id, runA.id)
    const rowB = storedRun(stored, second.id, runB.id)
    assert.deepEqual(Object.values(rowA.ephemeral).sort(), Object.values(runA.ephemeral).sort())
    assert.deepEqual(Object.values(rowB.ephemeral).sort(), Object.values(runB.ephemeral).sort())
    assert.equal(rowA.handed.plan, true)
    assert.equal(rowB.handed.plan, true)

    const disposing = svc.dispose()

    // The release is still in flight. The record must still name every instance,
    // or an interrupted release strands Bots that no state can ever find again.
    const during = readStore(dir)
    for (const [workflowId, run] of [[first.id, runA], [second.id, runB]]) {
      const row = storedRun(during, workflowId, run.id)
      assert.deepEqual(row.ephemeral, run.ephemeral)
      assert.equal(row.handed.plan, true)
    }
    assert.equal(storeText(dir) === before, true, 'dispose() rewrote the record before the release finished')
    assert.equal(released.length > 0, true, 'dispose() must start the release')

    // The host can await the release: dispose() is not fire-and-forget.
    assert.equal(typeof disposing?.then, 'function')

    pending.resolve()
    await disposing

    const after = readStore(dir)
    for (const [workflowId, run] of [[first.id, runA], [second.id, runB]]) {
      const row = storedRun(after, workflowId, run.id)
      assert.equal(row.status, 'failed')
      assert.equal(row.ephemeral, undefined)
      assert.equal('handed' in row, false)
      assert.equal((after.lanes?.[workflowId]?.active ?? []).length, 0)
    }
    assert.deepEqual([...released].sort(), [...ids].sort())
    assert.equal(released.length, 4)
    assert.equal(new Set(released).size, 4)
  } finally {
    pending.resolve()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1387: dispose() still returns a promise and still writes when nothing can be released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dispose-bare-'))
  try {
    // The host spawned Bots but has no release hook at all: the record still drops
    // the ids, and the caller can still await the attempt.
    const svc = createWorkflowService({
      dir,
      persist: true,
      now: () => CLOCK,
      bots: () => roster,
      spawn: async (spec) => `eph-${spec.nodeId}`,
      dispatch: async () => ({ ok: true }),
    })
    const made = pair('Bare', svc)
    await svc.runNamed({ workflow: 'Bare', brief: 'Ship it' })
    assert.deepEqual(Object.values(readStore(dir).lanes[made.id].active[0].ephemeral).sort(), ['eph-code', 'eph-plan'])

    const disposed = svc.dispose()
    assert.equal(typeof disposed?.then, 'function')
    await disposed
    const lane = readStore(dir).lanes[made.id]
    assert.equal(lane.active.length, 0)
    const row = lane.last
    assert.equal(row.status, 'failed')
    assert.equal(row.nodeStatus.plan, 'failed')
    assert.equal(row.ephemeral, undefined)
    assert.equal('handed' in row, false)

    // No spawn hook either: there are no ids, nothing is written, but dispose()
    // still resolves so every caller may await it the same way.
    const offDir = join(dir, 'off')
    const off = createWorkflowService({ dir: offDir, persist: true, now: () => CLOCK, bots: () => roster })
    const idle = off.define({ name: 'Idle', nodes: [{ id: 'only', name: 'Planner', prompt: 'Wait.' }], edges: [] })
      .workflows.find(item => item.name === 'Idle')
    const text = storeText(offDir)
    const quiet = off.dispose()
    assert.equal(typeof quiet?.then, 'function')
    await quiet
    assert.equal(storeText(offDir), text)
    assert.equal(off.state().workflows.find(item => item.id === idle.id).run, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1414: dispose() ends live runs before the record drops ephemeral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dispose-1414-'))
  const released = []
  try {
    const svc = createWorkflowService({
      dir,
      persist: true,
      now: () => CLOCK,
      bots: () => roster,
      spawn: async (spec) => `eph-${spec.nodeId}`,
      release: async (id) => { released.push(id) },
      dispatch: async () => ({ ok: true }),
    })
    const made = pair('Lane', svc)
    await svc.runNamed({ workflow: 'Lane', brief: 'Ship it', task: '#1414' })
    await svc.dispose()
    const lane = readStore(dir).lanes[made.id]
    assert.equal(lane.active.length, 0)
    assert.equal(lane.last.status, 'failed')
    assert.equal(lane.last.nodeStatus.plan, 'failed')
    assert.equal(lane.last.ephemeral, undefined)
    assert.deepEqual(released.sort(), ['eph-code', 'eph-plan'])

    const after = createWorkflowService({
      dir,
      persist: true,
      now: () => CLOCK + 1,
      bots: () => roster,
      spawn: async (spec) => `eph2-${spec.nodeId}`,
      release: async () => {},
      dispatch: async () => ({ ok: true }),
    })
    assert.equal(after.state().workflows.find(item => item.id === made.id).activeCount, 0)
    released.length = 0
    await after.reap()
    assert.deepEqual(released, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1387: a released runner name goes back into the pool', async (t) => {
  // The plugin names a runner `<stem> <4 hex>` and skips any name a live hidden
  // Bot still holds in this process. Hex is random, so a leaked name can only be
  // told apart from a fresh one by fixing the bytes: 2 bytes -> `<stem> aaaa`,
  // the 3-byte fallback after six collisions -> `<stem> bbbbbb`.
  const bytes = crypto.randomBytes
  crypto.randomBytes = size => Buffer.alloc(size, size === 2 ? 0xaa : 0xbb)
  syncBuiltinESMExports()
  t.after(() => {
    crypto.randomBytes = bytes
    syncBuiltinESMExports()
  })
  const names = []
  const removed = []
  const fb = {
    bot: {
      list: () => roster,
      async create(spec) {
        names.push(spec.name)
        return `bot-${names.length}`
      },
      async remove(id) { removed.push(id); return true },
      async send() { return { action: 'allow' } },
    },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tools: { register() { return () => {} } },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  const made = started.service.define({
    name: 'One',
    nodes: [{ id: 'plan', name: 'Planner', role: 'plan', prompt: 'Plan once.' }],
    edges: [],
  }).workflows.find(item => item.name === 'One')
  const first = await started.service.runNamed({ workflow: 'One', brief: 'First' })
  assert.equal(first.ok, true)
  assert.deepEqual(names, ['Planner aaaa'])
  const run = first.workflows.find(item => item.id === made.id).run

  await started.service.advance({ workflowId: made.id, nodeId: 'plan', outcome: 'done' })
  assert.deepEqual(removed, [run.ephemeral.plan])

  const second = await started.service.runNamed({ workflow: 'One', brief: 'Second', task: '#1387b' })
  assert.equal(second.ok, true)
  // The name the released Bot held is reusable. A leak makes the allocator skip
  // it six times and fall back to the 3-byte name.
  assert.deepEqual(names, ['Planner aaaa', 'Planner aaaa'])
})

test('#1472: dispose() releases the Bots of every concurrent live run, not just the last one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-dispose-1472-'))
  const released = []
  const spawned = []
  let seq = 0
  try {
    // One lane at the default maxConcurrent of 2: two assigns start two live
    // runs, each holding one instance per node.
    const svc = createWorkflowService({
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
      release: async (id) => { released.push(id) },
      dispatch: async () => ({ ok: true }),
    })
    const made = pair('Lane', svc)
    await svc.assign({ workflowId: made.id, taskId: '#1472a', title: 'First task' })
    await svc.assign({ workflowId: made.id, taskId: '#1472b', title: 'Second task' })
    assert.equal(svc.state().workflows.find(item => item.id === made.id).activeCount, 2)
    assert.equal(spawned.length, 4)
    assert.equal(new Set(spawned).size, 4)

    await svc.dispose()

    // Every instance the lane held is released, not only the run archived last.
    assert.deepEqual([...released].sort(), [...spawned].sort())
    assert.equal(released.length, 4)
    const lane = readStore(dir).lanes[made.id]
    assert.equal(lane.active.length, 0)
    assert.deepEqual(lane.history.map(row => row.status), ['failed', 'failed'])
    // #1387's invariant: no id is dropped while its Bot may still be alive.
    for (const id of spawned) assert.equal(storeText(dir).includes(id), false, id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

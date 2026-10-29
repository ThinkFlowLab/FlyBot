// #1632: deleting a workflow must take its task claims with it. The claim is
// what survives on disk after the run is gone, and `ingest` trusts any claim, so
// a dangling one hands the deleted workflow's id to `assign()` on every retry —
// forever, across reloads.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

function readStore(dir) {
  return JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
}

function serviceAt(dir, bots = () => roster) {
  let seq = 0
  return createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots,
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async () => ({ ok: true }),
    // The step deadline is a timer, not part of what this case asserts.
    setTimer: () => 0,
    clearTimer: () => {},
  })
}

function leaky(svc) {
  const created = svc.create({
    name: 'Leaky',
    nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }],
    edges: [],
  })
  assert.equal(created.ok, true)
  return created.workflows.find(item => item.name === 'Leaky')
}

test('#1632: delete takes the task claim with it, so the next ingest matches again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-delete-'))
  try {
    const svc = serviceAt(dir)
    const workflow = leaky(svc)
    const first = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: workflow.id })
    assert.equal(first.ok, true)
    assert.equal(first.matched, true)
    assert.deepEqual(readStore(dir).claims['task-9'], { kind: 'workflow', id: workflow.id }, 'the run recorded its claim')

    await svc.delete({ workflowId: workflow.id })
    const store = readStore(dir)
    assert.equal(store.claims['task-9'], undefined, 'a deleted workflow must not keep a claim on disk')
    assert.equal(store.routes['task-9'], undefined, 'its route goes with it')

    const again = await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it' })
    assert.notEqual(again.error, 'No such workflow', 'the stale claim must not name a deleted workflow')
    assert.deepEqual({ ok: again.ok, matched: again.matched }, { ok: true, matched: false }, 'it is matched again, not stuck')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1632: the healed task still matches after a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-reload-'))
  try {
    const first = serviceAt(dir)
    const workflow = leaky(first)
    await first.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: workflow.id })
    await first.delete({ workflowId: workflow.id })
    assert.equal(readStore(dir).claims['task-9'], undefined, 'nothing dangling reached the disk')

    const reloaded = serviceAt(dir)
    const again = await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it' })
    assert.notEqual(again.error, 'No such workflow', 'a reload must not resurrect the deleted workflow id')
    assert.deepEqual({ ok: again.ok, matched: again.matched }, { ok: true, matched: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1632: a store an older delete already poisoned drops the dangling claim on load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-poison-'))
  try {
    const svc = serviceAt(dir)
    const workflow = leaky(svc)
    await svc.ingest({ id: 'task-9', status: 'open', title: 'Ship it', workflowId: workflow.id })
    // The store an older version wrote: the workflow row is gone, its claim stayed.
    const store = readStore(dir)
    store.workflows = store.workflows.filter(item => item.id !== workflow.id)
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(store))

    const reloaded = serviceAt(dir)
    const again = await reloaded.ingest({ id: 'task-9', status: 'open', title: 'Ship it' })
    assert.notEqual(again.error, 'No such workflow', 'loading must drop a claim whose workflow is gone')
    assert.deepEqual({ ok: again.ok, matched: again.matched }, { ok: true, matched: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1632: a Bot claim that shares the id is not the delete\'s business', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-claim-kind-'))
  try {
    const bots = [...roster]
    const svc = serviceAt(dir, () => bots)
    const workflow = leaky(svc)
    // A Bot whose id is the same string: judging only by id would drop this one.
    bots.push({ id: workflow.id, name: 'Twin', role: 'Twin', remote: false })
    const routed = await svc.assign({ botId: workflow.id, taskId: 'task-bot', title: 'Owned by a Bot' })
    assert.equal(routed.ok, true)
    assert.deepEqual(readStore(dir).claims['task-bot'], { kind: 'bot', id: workflow.id })

    await svc.delete({ workflowId: workflow.id })
    assert.deepEqual(
      readStore(dir).claims['task-bot'],
      { kind: 'bot', id: workflow.id },
      'only claims that name the workflow are removed',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

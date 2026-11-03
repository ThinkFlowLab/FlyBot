// #2256: `workflow/state` lists held task ids, and the list is a page. A lane
// holding 23 cards drew 20 and then a dead line saying "3 more held tasks": the
// rows behind the cap could not be reached at all. The read now takes a
// `heldLimit` — 20 by default, 200 at most, and only for an integer above zero —
// while `heldTaskCount` stays the whole truth on either page.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const roster = [{ id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false }]

function serviceAt(dir, persist = true) {
  return createWorkflowService({
    dir,
    persist,
    now: () => CLOCK,
    bots: () => roster,
    spawn: async () => 'eph',
    release: async () => {},
    dispatch: async () => ({ ok: true }),
    // Step deadlines are timers; they are not part of what these cases assert.
    setTimer: () => 0,
    clearTimer: () => {},
  })
}

async function laneWith(svc, count) {
  const created = svc.create({ name: 'Alpha', nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }], edges: [] })
  assert.equal(created.ok, true, created.error)
  const alpha = created.workflows.find(item => item.name === 'Alpha')
  const ids = []
  for (let i = 1; i <= count; i += 1) {
    const id = `task-held-${String(i).padStart(2, '0')}`
    ids.push(id)
    const routed = await svc.ingest({ id, status: 'open', title: `Ship ${i}`, workflowId: alpha.id })
    assert.equal(routed.ok, true, routed.error)
  }
  return { alpha, ids }
}

test('#2256: the state read pages held ids, 20 by default and every one when asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-held-page-'))
  try {
    const svc = serviceAt(dir)
    const { alpha, ids } = await laneWith(svc, 23)
    const item = body => svc.state(body).workflows.find(workflow => workflow.id === alpha.id)

    assert.deepEqual(item().heldTasks, ids.slice(0, 20), 'no argument keeps the 20-id page')
    assert.equal(item().heldTaskCount, 23, 'the default page still reports the whole count')

    assert.deepEqual(item({ heldLimit: 200 }).heldTasks, ids, 'heldLimit: 200 lists every held id')
    assert.equal(item({ heldLimit: 200 }).heldTaskCount, 23, 'the wider page keeps the whole count')
    assert.deepEqual(item({ heldLimit: 23 }).heldTasks, ids, 'a limit just above the page is honoured')

    // A poll must not be able to ask for an unbounded read: anything that is not a
    // positive integer falls back to the default page.
    for (const bad of [{ heldLimit: 0 }, { heldLimit: -5 }, { heldLimit: 'many' }, { heldLimit: 3.5 }]) {
      assert.deepEqual(item(bad).heldTasks, ids.slice(0, 20), `${JSON.stringify(bad)} falls back to the default page`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2256: heldLimit is capped at 200, so a reader never turns the poll into a full read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-held-cap-'))
  try {
    const svc = serviceAt(dir, false)
    const { alpha, ids } = await laneWith(svc, 205)
    const item = body => svc.state(body).workflows.find(workflow => workflow.id === alpha.id)

    const wide = item({ heldLimit: 1000 })
    assert.equal(wide.heldTasks.length, 200, 'the widest page is 200 ids')
    assert.deepEqual(wide.heldTasks, [...ids].sort().slice(0, 200), 'and they are the first 200 of the sorted list')
    assert.equal(wide.heldTaskCount, 205, 'the count is still the whole truth past the cap')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

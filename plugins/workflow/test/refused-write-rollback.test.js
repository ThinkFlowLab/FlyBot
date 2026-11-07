// #2598: a store write that refuses before its first byte must leave memory as
// it was. `write()` refuses when the temp leaf is a link (temp-name sweep), and
// `create()` had already pushed the graph and its creation line by then, so the
// caller was told nothing was created while the next successful write persisted
// it. `rename()` writes before it keeps the new name for the same reason.
// #2623: `delete()` removed the workflow and its lane/run/log/route/claim/brief
// records before `write()`, so a refused write left the page without a workflow
// the store still held and a retry answered "No such workflow".
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const GRAPH = { name: 'Audit graph', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] }

// The store lands through `<dir>/workflows.json.<pid>.tmp`, so a symlink there
// refuses the write before any byte reaches the store (tempWritable).
function linkedStore() {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-refused-'))
  const svc = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => [] })
  const outside = join(dir, 'outside-workflows.json')
  writeFileSync(outside, 'OUTSIDE\n')
  const tmp = join(dir, `workflows.json.${process.pid}.tmp`)
  symlinkSync(outside, tmp)
  return { dir, svc, outside, tmp }
}

test('a refused create leaves no graph or creation line behind', () => {
  const { dir, svc, outside, tmp } = linkedStore()
  try {
    const before = svc.state()
    const refused = svc.create(GRAPH)
    assert.equal(refused.ok, false, 'the write is refused')
    assert.match(refused.error, /not a plain file/)
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the file behind the temp link is not written through')

    assert.deepEqual(svc.state().workflows.map(item => item.name), before.workflows.map(item => item.name), 'the refused create left no graph behind')

    // The ghost used to land on disk with the next successful write.
    rmSync(tmp)
    const second = svc.create({ name: 'Second', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] })
    assert.equal(second.ok, true)
    const stored = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
    assert.deepEqual(
      stored.workflows.map(item => item.name),
      [...before.workflows.map(item => item.name), 'Second'],
      'the next write persists only the graph that was saved',
    )
    const created = new Set(stored.workflows.map(item => item.id))
    assert.deepEqual(
      Object.keys(stored.logs).filter(id => !created.has(id)),
      [],
      'a log line belongs to a workflow that is in the store',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A directory at the temp leaf refuses the write the same way a link does, and it
// is the shape #2623 reproduces with: `delete()` had already dropped the workflow
// and its lane, run, log, route, claim and brief records from memory.
test('a refused delete keeps the workflow for the page and the next host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-delete-refused-'))
  try {
    const svc = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => [] })
    const created = svc.create(GRAPH)
    assert.equal(created.ok, true)
    const id = created.workflows.find(item => item.name === GRAPH.name).id
    const tmp = join(dir, `workflows.json.${process.pid}.tmp`)
    mkdirSync(tmp)
    const before = svc.state().workflows.map(item => item.id)

    let thrown
    try {
      await svc.delete({ workflowId: id })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, 'the refused write reaches the caller instead of answering ok')
    assert.match(thrown.message, /not a plain file/)
    assert.deepEqual(svc.state().workflows.map(item => item.id), before, 'the page still lists the workflow the store kept')

    const fresh = createWorkflowService({ dir, persist: true, now: () => 6, bots: () => [] })
    assert.ok(fresh.state().workflows.some(item => item.id === id), 'a fresh host on the same home still lists it')

    // Removing the block is what makes the retry possible at all: before this
    // fix the workflow was gone from state, so the retry answered "No such
    // workflow" until a restart brought it back from disk.
    rmSync(tmp, { recursive: true, force: true })
    const retried = await svc.delete({ workflowId: id })
    assert.equal(retried.ok, true, 'the retry removes the workflow once the store can be written')
    assert.equal(svc.state().workflows.some(item => item.id === id), false, 'the page no longer lists it')
    const stored = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
    assert.equal(stored.workflows.some(item => item.id === id), false, 'the store no longer lists it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused rename keeps the name it could not save', () => {
  const { dir, svc } = linkedStore()
  try {
    const before = svc.state().workflows.find(item => item.id === DELIVERY_ID).name
    const refused = svc.rename({ workflowId: DELIVERY_ID, name: 'Renamed' })
    assert.equal(refused.ok, false, 'the write is refused')
    assert.match(refused.error, /not a plain file/)
    assert.equal(
      svc.state().workflows.find(item => item.id === DELIVERY_ID).name,
      before,
      'the refused rename left the workflow name as it was',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

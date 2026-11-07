// #2598: a store write that refuses before its first byte must leave memory as
// it was. `write()` refuses when the temp leaf is a link (temp-name sweep), and
// `create()` had already pushed the graph and its creation line by then, so the
// caller was told nothing was created while the next successful write persisted
// it. `rename()` writes before it keeps the new name for the same reason.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// #2681: a store written by a newer build used to fall into the same branch as a store that is not
// a workflow file at all. Every endpoint then ran on the fixture and the next write renamed the
// fixture (and the new run) over it: the owner's workflows replaced by `delivery` and `weekly`,
// runs and claims reset, `seq` back to 1, the real bytes only in `workflows.json.broken-<stamp>`.
// A higher `version` is now its own answer on read and no write lands at all.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const NEWER = {
  version: 2,
  workflows: [{ id: 'mine', name: 'Mine', description: '', nodes: [{ id: 'plan', name: 'Planner' }], edges: [], stages: ['plan'] }],
  runs: { 'task-1': { status: 'running', task: 'task-1' } },
  lanes: {},
  claims: { 'task-1': { kind: 'workflow', id: 'mine' } },
  logs: {},
  seq: 41,
  stages: ['plan', 'build'],
}

function newerStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-newer-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'workflows.json')
  const bytes = Buffer.from(`${JSON.stringify(NEWER, null, 2)}\n`, 'utf8')
  writeFileSync(file, bytes)
  return { dir, file, bytes }
}

test('#2681: a store from a newer build is its own read answer, not a clean list', (t) => {
  const { dir, file, bytes } = newerStore(t)
  const warnings = []
  const svc = createWorkflowService({ dir, persist: true, bots: () => [], warn: message => warnings.push(String(message)) })
  const read = svc.state({})
  assert.equal(read.ok, false, 'a store this build cannot read is not a clean list')
  assert.equal(read.code, 'store-newer-version')
  assert.match(read.error, /workflows\.json/, 'the answer names the file')
  assert.match(read.error, /newer FlyBot/, 'and says a newer build wrote it')
  assert.match(read.error, /version 2/, 'and names the version it carries')
  assert.equal(Array.isArray(read.workflows), false, 'no fixture list is answered as the store')
  assert.ok(warnings.some(message => /newer FlyBot/.test(message)), 'the warning is still raised')
  assert.equal(readFileSync(file).equals(bytes), true, 'reading does not touch the bytes')
})

test('#2681: every write is refused and the newer store stays byte-identical', async (t) => {
  const { dir, file, bytes } = newerStore(t)
  const svc = createWorkflowService({ dir, persist: true, bots: () => [], warn: () => {} })

  const created = svc.create({ name: 'After the newer build', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] })
  assert.equal(created.ok, false, 'create is refused')
  assert.match(created.error, /newer FlyBot/)

  // A write through the generic mutation path too, so this is not one endpoint's guard.
  const renamed = svc.rename({ workflowId: 'delivery', name: 'Renamed' })
  assert.equal(renamed.ok, false, 'a mutate is refused')
  assert.match(renamed.error, /newer FlyBot/)

  assert.equal(readFileSync(file).equals(bytes), true, 'the file was not rewritten')
  assert.deepEqual(readdirSync(dir), ['workflows.json'], 'nothing was replaced, so no .broken copy was left either')
  const kept = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(kept.version, 2)
  assert.deepEqual(kept.stages, ['plan', 'build'], 'the field this build cannot read is still there')
  assert.equal(kept.seq, 41, 'the newer store own sequence is still there')

  // Closing the host is a write path too, and it must not reject the disposer its caller awaits.
  await svc.dispose()
  assert.equal(readFileSync(file).equals(bytes), true, 'closing the host leaves the newer store alone')
})

test('#2681: a version 1 store still reads and writes as before', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-v1-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'workflows.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    workflows: [{ id: 'mine', name: 'Mine', description: '', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] }],
    runs: {},
    lanes: {},
    claims: {},
    routes: {},
    logs: {},
    seq: 7,
  }))
  const svc = createWorkflowService({ dir, persist: true, bots: () => [], warn: () => {} })

  const read = svc.state({})
  assert.equal(read.ok, true, 'a store this build can read is a clean read')
  assert.ok(read.workflows.some(item => item.id === 'mine'), 'and its own workflows are listed')

  const created = svc.create({ name: 'Another', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] })
  assert.equal(created.ok, true, 'a write still lands')
  const live = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(live.version, 1)
  assert.ok(live.workflows.some(item => item.name === 'Another'), 'the new workflow is in the store')
  assert.equal(readdirSync(dir).filter(name => name.startsWith('workflows.json.broken-')).length, 0, 'a readable store is not set aside')
})

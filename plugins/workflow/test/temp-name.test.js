// The workflow store lands through `<dir>/workflows.json.<pid>.tmp` and is renamed into place.
// That temp name is a leaf like the store (temp-name sweep): a link left there would take the
// workflows outside their folder and the rename would put the link where the store belongs.
import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

test('a linked workflow-store temp name does not take the store; workflows.json stays absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-temp-'))
  try {
    const svc = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => [] })
    const outside = join(dir, 'outside-workflows.json')
    writeFileSync(outside, 'OUTSIDE\n')
    symlinkSync(outside, join(dir, `workflows.json.${process.pid}.tmp`))
    const saved = svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 3 })
    assert.equal(saved.ok, false, 'the write is refused')
    assert.match(saved.error, /not a plain file/)
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the file behind the temp link is not written through')
    const file = join(dir, 'workflows.json')
    assert.equal(existsSync(file) ? lstatSync(file).isSymbolicLink() : false, false, 'the store is not a link')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A hard link at the temp name is a plain file to `lstat`, so the store would land in the shared
// inode. It is refused, and workflows.json is not created.
test('a hard link at the workflow-store temp name does not take the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-temp-'))
  try {
    const svc = createWorkflowService({ dir, persist: true, now: () => 5, bots: () => [] })
    const outside = join(dir, 'outside-workflows.json')
    writeFileSync(outside, 'OUTSIDE\n')
    linkSync(outside, join(dir, `workflows.json.${process.pid}.tmp`))
    const saved = svc.setConcurrency({ workflowId: DELIVERY_ID, maxConcurrent: 3 })
    assert.equal(saved.ok, false, 'the write is refused')
    assert.match(saved.error, /not a plain file/)
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the shared inode keeps its bytes')
    assert.equal(lstatSync(outside).nlink, 2, 'the outside file still carries the temp name')
    const file = join(dir, 'workflows.json')
    assert.equal(existsSync(file), false, 'the store is not created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

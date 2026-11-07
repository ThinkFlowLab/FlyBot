// #2603: a crash or a full disk leaves the store truncated. `load()` warned and
// returned null, so the read behind `workflow/state` answered `ok: true` with the
// fixture and the first ordinary save renamed that fixture over the recoverable
// bytes. The read now says the store could not be read, and the first write keeps
// the bytes in `workflows.json.broken-<stamp>` before it replaces them.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const TRUNCATED = '{"version":1,"workflows":[{"id":"mine","nam'

function unreadableStore() {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-wf-unreadable-'))
  writeFileSync(join(dir, 'workflows.json'), TRUNCATED)
  return dir
}

test('a store that did not parse is answered as a failure, not as the fixture', () => {
  const dir = unreadableStore()
  const warnings = []
  const svc = createWorkflowService({ dir, persist: true, bots: () => [], warn: message => warnings.push(String(message)) })
  try {
    const read = svc.state({})
    assert.equal(read.ok, false, 'a store that could not be read is not a clean list')
    assert.equal(read.code, 'store-unreadable')
    assert.match(read.error, /workflows\.json/, 'the answer names the file')
    assert.match(read.error, /did not parse/, 'the answer names the failure')
    assert.equal(Array.isArray(read.workflows), false, 'no fixture list is answered as the store')
    assert.ok(warnings.some(message => /did not parse/.test(message)), 'the warning is still raised')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the first write keeps the unreadable bytes before it replaces them', () => {
  const dir = unreadableStore()
  const svc = createWorkflowService({ dir, persist: true, bots: () => [] })
  try {
    const created = svc.create({ name: 'After the crash', nodes: [{ id: 'plan', name: 'Planner' }], edges: [] })
    assert.equal(created.ok, true, 'the plugin still saves')

    const broken = readdirSync(dir).filter(name => name.startsWith('workflows.json.broken-'))
    assert.equal(broken.length, 1, 'the unreadable file is kept once')
    assert.equal(readFileSync(join(dir, broken[0]), 'utf8'), TRUNCATED, 'the kept copy holds the original bytes')

    const live = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
    assert.ok(live.workflows.some(item => item.name === 'After the crash'), 'the live store parses again')
    assert.equal(svc.state({}).ok, true, 'a store that can be read is a clean read again')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

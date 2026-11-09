// #2746 S1: the message-id counter travels with the store. It is written on every
// save and read back on load, so a window that restarts keeps numbering where the
// old one stopped. Without that field a reload starts at `m1` again and hands out
// ids the panel already holds, so two different log lines answer to one id.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const CLOCK = 1_700_000_000_000
const roster = [
  { id: 'main', name: 'Chief', role: 'lead', isMain: true, remote: false },
]

// No `spawn`: a run starts inside the call, so every log line it writes exists
// by the time `assign` answers.
function serviceAt(dir) {
  return createWorkflowService({
    dir,
    persist: true,
    now: () => CLOCK,
    bots: () => roster,
    setTimer: () => 0,
    clearTimer: () => {},
  })
}

function messageIds(svc, workflowId) {
  const read = svc.state({})
  assert.equal(read.ok, true, read.error)
  const item = read.workflows.find(workflow => workflow.id === workflowId)
  assert.ok(item, 'the workflow is in the read')
  return (item.messages ?? []).map(line => line.id)
}

function workflowNamed(svc, name) {
  const created = svc.create({ name, nodes: [{ id: 'only', name: 'Only', prompt: 'Do it.' }], edges: [] })
  assert.equal(created.ok, true, created.error)
  return created.workflows.find(item => item.name === name)
}

test('a reloaded store never re-issues a message id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-store-seq-'))
  try {
    const first = serviceAt(dir)
    const alpha = workflowNamed(first, 'Alpha')
    const assigned = first.assign({ workflowId: alpha.id, taskId: 'task-1', title: 'First' })
    assert.equal(assigned.ok, true, assigned.error)
    const before = messageIds(first, alpha.id)
    assert.ok(before.length > 0, 'the first run wrote log lines with ids')
    first.dispose()

    const stored = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
    assert.ok(stored.seq >= before.length, `the id counter is on disk, not only in memory (stored ${stored.seq} after ${before.length} lines)`)

    const second = serviceAt(dir)
    const again = second.assign({ workflowId: alpha.id, taskId: 'task-2', title: 'Second' })
    assert.equal(again.ok, true, again.error)
    const all = messageIds(second, alpha.id)
    const fresh = all.slice(before.length)
    assert.ok(fresh.length > 0, 'the second run wrote log lines of its own')
    const reused = fresh.filter(id => before.includes(id))
    assert.deepEqual(reused, [], 'an id the first window handed out is not handed out again')
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

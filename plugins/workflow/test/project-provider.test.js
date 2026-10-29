// #1696: the workflow plugin reports the run behind a board card through the host seam, so the
// core Project board can join both views without ever reading `workflows.json`. A run whose card
// is gone is dropped, not turned into a row of its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createWorkflowService } from '../src/service.js'
import { DELIVERY_ID } from '../src/template.js'

const roster = [
  { id: 'bot-planner', name: 'Planner', role: '计划', remote: false },
  { id: 'bot-coder', name: 'Coder', role: '实现', remote: false },
]

function service() {
  return createWorkflowService({ persist: false, now: () => 1_700_000_000_000, bots: () => roster })
}

test('a run reports the card it holds, and drops the card it can no longer see', () => {
  const svc = service()
  svc.assign({ workflowId: DELIVERY_ID, taskId: 'task-abcdef123456', title: 'Ship the note' })

  const rows = svc.projectTasks({ hasTask: () => true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskId, 'task-abcdef123456')
  assert.match(rows[0].runId, /^run-/)
  assert.equal(rows[0].nodeId, 'planner')

  assert.deepEqual(svc.projectTasks({ hasTask: () => false }), [])
  assert.deepEqual(svc.projectTasks({ hasTask: id => id === 'task-other' }), [])
})

test('the provider is registered on the host seam and answers with the run refs', () => {
  let provider = null
  let written = null
  const fb = {
    bot: { list: () => roster },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tasks: {
      onWrite(fn) { written = fn; return () => {} },
      onProjectProvider(fn) { provider = fn; return () => {} },
    },
    warn() {},
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  assert.equal(started.enabled, true)
  assert.equal(typeof written, 'function')
  assert.equal(typeof provider, 'function')

  started.service.assign({ workflowId: DELIVERY_ID, taskId: '#1696', title: 'Read the board' })
  const rows = provider({ hasTask: id => id === '#1696' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskId, '#1696')
  assert.match(rows[0].runId, /^run-/)
  assert.equal(rows[0].nodeId, 'planner')
  // The host decides which cards exist; the plugin reports none for a card it cannot see.
  assert.deepEqual(provider({ hasTask: () => false }), [])
})

test('a host built before this seam still applies, and the plugin stays quiet', () => {
  const warnings = []
  const fb = {
    bot: { list: () => roster },
    readOnly: () => false,
    api: { handle() { return () => {} } },
    tasks: { onWrite() { return () => {} } },
    warn(message) { warnings.push(String(message)) },
  }
  const started = apply({ flybot: { scope: () => fb }, effect(fn) { fn() } }, { persist: false })
  assert.equal(started.enabled, true)
  assert.equal(warnings.filter(line => line.includes('onProjectProvider')).length, 0)
})

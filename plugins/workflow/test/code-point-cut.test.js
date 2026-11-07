// #2581: every bound in this plugin judges characters, not UTF-16 units. A failed step's own text
// is the node's or the peer Bot's output, so a unit slice at 197 ends inside an emoji and the
// stored failure, the history and the API all carry a lone surrogate (U+FFFD once encoded).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000

test('#2581: a failed step keeps a well-formed text when its characters are emoji', async () => {
  const svc = createWorkflowService({ persist: false, now: () => NOW, bots: () => [] })
  const made = svc.define({
    name: 'Lane',
    nodes: [{ id: 'plan', name: 'Planner', prompt: 'Write the plan.' }],
    edges: [],
  })
  const id = made.workflows.find(item => item.name === 'Lane').id
  const started = await svc.runNamed({ workflow: 'Lane', brief: 'go' })
  const runId = started.workflows.find(item => item.id === id).run.id
  // 300 characters, 600 units: the old 197-unit slice kept 98 faces and half of the 99th.
  const text = '🚀'.repeat(300)
  const failed = svc.advance({ workflowId: id, runId, nodeId: 'plan', outcome: 'failed', text })
  const failure = failed.workflows.find(item => item.id === id).run.failure
  assert.equal(failure.text.isWellFormed(), true, 'the stored failure text is well formed')
  assert.equal(failure.text.includes('\uFFFD'), false)
  assert.equal(failure.text.endsWith('🚀…'), true)
  assert.equal(Array.from(failure.text).length, 198, '197 characters plus the ellipsis')
})

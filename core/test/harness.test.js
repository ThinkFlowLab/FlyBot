import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_HARNESS_ID, defaultHarness, resolveHarness } from '../src/host/harness.js'

test('Step 0 default harness names prompt, tools, model, step·retry, and verifiers', () => {
  const harness = defaultHarness()
  assert.equal(harness.id, DEFAULT_HARNESS_ID)
  assert.equal(harness.prompt.module, './prompt.js')
  assert.equal(harness.tools.module, './tools.js')
  assert.equal(harness.model.module, './models.js')
  assert.equal(harness.stepRetry.module, './turns.js')
  assert.ok(harness.verifiers.note)
})

test('resolveHarness only accepts default in Step 0', () => {
  assert.equal(resolveHarness().id, 'default')
  assert.throws(() => resolveHarness('lite'), /unknown harness/)
})

test('tree prompt exception is listed outside the default harness file', () => {
  const tree = defaultHarness().exceptions.find(entry => entry.id === 'tree-prompt')
  assert.equal(tree.path, 'plugins/tree')
})

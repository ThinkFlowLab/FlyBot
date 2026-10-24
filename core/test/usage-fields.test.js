import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldCalls, missingUsageFields, withUsageFields } from '../src/host/usage.js'

const header = (provider, model) => ({ type: 'request/header', data: { header: { config: { provider, model } }, reason: 'change' } })
const message = (turn, step, usage, time = 0) => ({ type: 'assistant/message', time, data: { turn, step, message: { role: 'assistant', content: [] }, stream: [], usage } })
const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens })

test('withUsageFields fills harness, issue·PR, toolCalls, wallMs, and keeps tokens', () => {
  const row = withUsageFields({ input: 1, cacheRead: 0, cacheWrite: 0, output: 2 })
  assert.deepEqual(missingUsageFields(row), [])
  assert.equal(row.harness, 'default')
  assert.equal(row.issuePr, '')
  assert.equal(row.toolCalls, 0)
  assert.equal(row.wallMs, 0)
  assert.equal(row.input, 1)
  assert.equal(row.output, 2)
})

test('missing any of the five usage fields is red', () => {
  const base = withUsageFields({ input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })
  assert.deepEqual(missingUsageFields({ ...base, harness: '' }), ['harness'])
  assert.deepEqual(missingUsageFields({ ...base, issuePr: undefined }), ['issuePr'])
  assert.deepEqual(missingUsageFields({ ...base, toolCalls: undefined }), ['toolCalls'])
  assert.deepEqual(missingUsageFields({ ...base, wallMs: undefined }), ['wallMs'])
  assert.deepEqual(missingUsageFields({ ...base, input: undefined }), ['tokens'])
})

test('foldCalls rows carry the five usage fields', () => {
  const { rows } = foldCalls([
    header('deepseek', 'v4-flash'),
    message(1, 0, usage(10, 2), 0),
  ])
  assert.equal(rows.length, 1)
  assert.deepEqual(missingUsageFields(rows[0]), [])
})

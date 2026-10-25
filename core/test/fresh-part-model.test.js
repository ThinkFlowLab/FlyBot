import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freshPartModel } from '../src/host/parts.js'

test('a fresh part takes the Bot\'s model, not the previous request\'s provider (#1127)', () => {
  const sticky = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
  assert.deepEqual(freshPartModel(sticky, 'opencsitool/DeepSeek-V4.1-Flash-1017'), { ref: 'opencsitool/DeepSeek-V4.1-Flash-1017' })
  assert.deepEqual(freshPartModel(sticky, undefined), { ref: 'deepseek-official/deepseek-flash', effort: 'high' })
  assert.equal(freshPartModel(undefined, undefined), undefined)
  assert.deepEqual(freshPartModel({ provider: 'deepseek-official', model: 'deepseek-flash' }, undefined), { ref: 'deepseek-official/deepseek-flash' })
})

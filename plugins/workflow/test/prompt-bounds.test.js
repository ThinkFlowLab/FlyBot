// The prompt and step-result text bounds of graph.js cut on code points, like cleanLine
// above them in the same file (#1705). A bound that lands between the halves of a UTF-16
// surrogate pair stores a lone surrogate, which every encoder turns into U+FFFD and every
// reader draws as a replacement character.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanPrompt, readStepResult } from '../src/graph.js'

test('a prompt bound lands on a code point boundary, not inside an emoji', () => {
  const kept = cleanPrompt(`${'a'.repeat(3999)}🚀tail`)
  assert.equal(kept.isWellFormed(), true, 'the clipped prompt keeps half a surrogate pair')
  assert.deepEqual([...kept].length, 4000, 'the prompt keeps its 4000-character bound')
  assert.equal([...kept].at(-1), '🚀', 'the last whole character is the emoji, not half of it')
})

test('the prompt bound counts code points, so whole emoji are never cut in half', () => {
  const kept = cleanPrompt('🚀'.repeat(4000))
  assert.deepEqual([...kept].length, 4000, 'all 4000 code points survive the 4000 bound')
  assert.equal(kept.length, 8000, 'the bound is counted in code points, so no emoji is cut in half')
})

test('a step result body bound lands on a code point boundary, not inside an emoji', () => {
  const result = readStepResult(`${'x'.repeat(1999)}🚀y`, { outputs: [] })
  assert.equal(result.text.isWellFormed(), true, 'the stored step result keeps half a surrogate pair')
  assert.deepEqual([...result.text].length, 2000, 'the body keeps its 2000-character bound')
  assert.equal([...result.text].at(-1), '🚀', 'the last whole character is the emoji, not half of it')
})

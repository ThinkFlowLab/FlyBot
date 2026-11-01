// #1963: `cut` is the last bound before card text reaches `state.json`, and it only moved its own
// cut point off a pair it was about to split. A string that arrived already carrying an unpaired
// high or low surrogate was copied straight through, so the stored value was not well formed — a
// UTF-8 encoder writes that unit as U+FFFD, and reading the card back gave a different string than
// the one the caller stored. Every other normaliser in the host flattens its input before bounding
// it (`delivery.js`, `remote-label.js`, `room-share.js`), and this bound does the same now.
// U+FFFD is one UTF-16 unit for the one it replaces, so a well-formed input keeps its exact prefix
// and its `cut` flag.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cut } from '../src/shared/text-boundary.js'

const LONE_HIGH = 'a\uD800b'
const LONE_LOW = 'a\uDC00b'

test('a lone high surrogate in the input comes back as U+FFFD', () => {
  const out = cut(LONE_HIGH, 8)
  assert.equal(out.text, 'a\uFFFDb')
  assert.equal(out.text.isWellFormed(), true)
  // One unit in, one unit out: repairing never spends part of the budget or grows the text.
  assert.equal(out.text.length, 3)
  assert.equal(out.cut, false)
})

test('a lone low surrogate in the input comes back as U+FFFD', () => {
  const out = cut(LONE_LOW, 8)
  assert.equal(out.text, 'a\uFFFDb')
  assert.equal(out.text.isWellFormed(), true)
  assert.equal(out.cut, false)
})

test('a lone surrogate is repaired before the bound, not after it', () => {
  // Five units, max four: the prefix that is kept still carries the unit the repair replaced.
  const out = cut('ab\uD800cd', 4)
  assert.equal(out.text, 'ab\uFFFDc')
  assert.equal(out.text.isWellFormed(), true)
  assert.equal(out.cut, true)
})

test('well-formed input keeps its exact prefix and flag', () => {
  const cases = [
    ['', 5, '', false],
    ['abcdef', 3, 'abc', true],
    ['abc', 3, 'abc', false],
    ['abc', 0, '', true],
    ['a😀', 3, 'a😀', false],
    // The pair straddles the bound, so it is dropped whole instead of being cut in half.
    ['aa😀', 3, 'aa', true],
    ['👨\u200D👩\u200D👧', 4, '👨\u200D', true],
    ['a'.repeat(2000), 2000, 'a'.repeat(2000), false],
  ]
  for (const [text, max, expected, flag] of cases) {
    const out = cut(text, max)
    assert.deepEqual(out, { text: expected, cut: flag }, `${JSON.stringify(text)} @ ${max}`)
    assert.equal(out.text.isWellFormed(), true)
  }
})

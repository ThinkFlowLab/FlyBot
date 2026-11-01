// #1979: a role label another home set on a face-room seat is bounded at 80. A cut that lands between
// the halves of a surrogate pair returns a lone high surrogate, which reaches a UTF-8 encoder as
// U+FFFD, so the bound goes through `cut()` and keeps a well-formed code-point prefix.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanRoleLabel } from '../src/host/face-lead.js'

test('a role label another home set is cut at 80 without splitting an emoji', () => {
  const label = 'a'.repeat(79) + '😀' + 'tail'
  const cleaned = cleanRoleLabel(label)
  assert.equal(cleaned.isWellFormed(), true, 'the cleaned label is well formed, never a lone high surrogate')
  assert.equal(cleaned, 'a'.repeat(79), 'the 80th unit was the first half of the pair, so the pair is dropped, not split')
  assert.ok(label.startsWith(cleaned), 'a code-point prefix of the label another home supplied')
  assert.ok(cleaned.length <= 80, 'the budget of 80 UTF-16 units is unchanged')
})

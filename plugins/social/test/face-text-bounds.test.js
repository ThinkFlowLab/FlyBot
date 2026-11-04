// A peer-controlled face-room name and role are capped before they reach a room, a transcript or
// an `<untrusted-message>` fence, and the cap must land on a code point boundary: a cut between
// the halves of a surrogate pair stores a lone surrogate, which every encoder reads as U+FFFD and
// every reader draws as a replacement character (#2438).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanFaceName, cleanFaceRole } from '../src/face-rooms.js'

test('a face-room name bound lands on a code point boundary, not inside an emoji', () => {
  const name = cleanFaceName(`${'x'.repeat(59)}🚀rest`)
  assert.equal(name.isWellFormed(), true, 'the capped name keeps half a surrogate pair')
  assert.deepEqual([...name].length, 60, 'the name keeps its 60-character cap')
  assert.equal([...name].at(-1), '🚀', 'the last whole character is the emoji, not half of it')
})

test('the name cap counts code points, so whole emoji are never cut in half', () => {
  const kept = cleanFaceName('🚀'.repeat(60))
  assert.deepEqual([...kept].length, 60, 'all 60 code points survive the cap')
  assert.equal(kept.length, 120, 'the cap is counted in code points, so no emoji is cut in half')
})

test('a face-room role bound lands on a code point boundary, not inside an emoji', () => {
  const role = cleanFaceRole(`${'y'.repeat(79)}🚀rest`)
  assert.equal(role.isWellFormed(), true, 'the capped role keeps half a surrogate pair')
  assert.deepEqual([...role].length, 80, 'the role keeps its 80-character cap')
  assert.equal([...role].at(-1), '🚀', 'the last whole character is the emoji, not half of it')
})

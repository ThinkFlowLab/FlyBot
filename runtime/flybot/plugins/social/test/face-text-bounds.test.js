import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cleanFaceName,
  cleanFaceRole,
  encodeFaceHuman,
  mapFaceError,
  mapRegisterError,
  parseFaceHuman,
  viewFaceEvent,
} from '../src/face-rooms.js'

// Peer-supplied face-room text is capped (#2438). A cap that lands between the halves of a surrogate
// pair stores a lone high surrogate, which every encoder reads as U+FFFD, so each cut must land
// on a code point and each cap must count code points. `\p{Surrogate}` with the `u` flag matches a
// lone surrogate only: a valid pair is one code point outside that range.
const ROCKET = '\u{1F680}'
const REPLACEMENT = String.fromCharCode(0xfffd)
const shapes = value => {
  assert.equal(typeof value, 'string')
  assert.ok(value.isWellFormed(), `not well formed: ${JSON.stringify(value)}`)
  assert.ok(!/\p{Surrogate}/u.test(value), `lone surrogate: ${JSON.stringify(value)}`)
  assert.ok(!value.includes(REPLACEMENT), `replacement character: ${JSON.stringify(value)}`)
  return value
}

test('a face-room name cut lands on a code point boundary, not inside an emoji', () => {
  const stored = shapes(cleanFaceName(`${'a'.repeat(59)}${ROCKET}rest`))
  assert.equal(stored, `${'a'.repeat(59)}${ROCKET}`)
})

test('the name cap counts code points, so whole emoji are never cut in half', () => {
  const stored = shapes(cleanFaceName(ROCKET.repeat(70)))
  assert.equal(Array.from(stored).length, 60)
})

test('a face-room role cut lands on a code point boundary, not inside an emoji', () => {
  const stored = shapes(cleanFaceRole(`${'a'.repeat(79)}${ROCKET}rest`))
  assert.equal(stored, `${'a'.repeat(79)}${ROCKET}`)
})

test('the role cap counts code points, so whole emoji are never cut in half', () => {
  const stored = shapes(cleanFaceRole(ROCKET.repeat(90)))
  assert.equal(Array.from(stored).length, 80)
})

test('a platform line cut lands on a code point boundary, not inside an emoji', () => {
  const viewed = viewFaceEvent({ type: 'room.pinned', text: `${'a'.repeat(199)}${ROCKET}rest` })
  const stored = shapes(viewed.text)
  assert.equal(stored, `${'a'.repeat(199)}${ROCKET}`)
})

test('the platform line cap counts code points, so whole emoji are never cut in half', () => {
  const viewed = viewFaceEvent({ type: 'room.pinned', text: ROCKET.repeat(250) })
  assert.equal(Array.from(shapes(viewed.text)).length, 200)
})

test('a failed registration detail lands on a code point boundary, not inside an emoji', () => {
  const error = mapRegisterError({ message: `${'a'.repeat(199)}${ROCKET}rest` }, { name: 'Bolt' })
  const stored = shapes(error.message)
  assert.ok(stored.endsWith(`${'a'.repeat(199)}${ROCKET}`), stored.slice(-8))
})

test('an unmapped join error message lands on a code point boundary, not inside an emoji', () => {
  const error = mapFaceError({ error: { code: 'odd_room_failure', message: `${'a'.repeat(199)}${ROCKET}rest` } }, 400)
  const stored = shapes(error.message)
  assert.equal(stored, `${'a'.repeat(199)}${ROCKET}`)
})

// The person's own face-room line is 18 000 code points, not 18 000 UTF-16 units (#2641): an
// emoji straddling that bound was kept as half a pair in the FLYBOT-FACE-HUMAN JSON, which still
// parses, and the next UTF-8 write of the parsed text became U+FFFD.
test('the face-room human line cut lands on a code point boundary, not inside an emoji', () => {
  const text = `${'a'.repeat(17_999)}${ROCKET}`
  const stored = shapes(parseFaceHuman(encodeFaceHuman({ who: 'Tester', text })).text)
  assert.equal(stored, text)
})

test('the face-room human line cap counts code points, so whole emoji are never cut in half', () => {
  const parsed = parseFaceHuman(encodeFaceHuman({ who: 'Tester', text: ROCKET.repeat(18_000) }))
  const stored = shapes(parsed.text)
  assert.equal(Array.from(stored).length, 18_000)
  assert.equal(stored, ROCKET.repeat(18_000))
})

test('a face-room human line under the cap keeps its emoji unchanged', () => {
  const text = `hello ${ROCKET} there`
  assert.equal(parseFaceHuman(encodeFaceHuman({ who: 'Tester', text })).text, text)
})

test('a cut face-room human line has no replacement character once its text is written as UTF-8', () => {
  const text = `${'a'.repeat(17_999)}${ROCKET}`
  const parsed = parseFaceHuman(encodeFaceHuman({ who: 'Tester', text }))
  const bytes = Buffer.from(parsed.text, 'utf8')
  assert.equal(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd])), false)
})

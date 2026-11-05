// A brace in a chat line is a character someone typed, not structure (#2447): `parseRoomShare`
// finds the end of the JSON envelope by counting braces, and it must not count the ones inside the
// strings `encodeRoomShare` writes — otherwise a single unbalanced brace drops the whole line.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeRoomShare, parseRoomShare } from '../src/shared/room-share.js'

const line = (text) => encodeRoomShare({ op: 'line', roomId: 'r1', seq: 7, who: 'Alice', text })

test('an open brace in a line does not end the envelope early', () => {
  const text = 'if (x) { y()'
  const parsed = parseRoomShare(line(text))
  assert.ok(parsed, 'the envelope was dropped')
  assert.equal(parsed.text, text)
})

test('a close brace in a line does not end the envelope early', () => {
  const text = 'so the closing brace is }'
  const parsed = parseRoomShare(line(text))
  assert.ok(parsed, 'the envelope was dropped')
  assert.equal(parsed.text, text)
})

test('a brace inside a quoted word, and an escaped quote, both stay text', () => {
  const text = 'he said "{" and then "}" and \\ back'
  const parsed = parseRoomShare(line(text))
  assert.ok(parsed, 'the envelope was dropped')
  assert.equal(parsed.text, text)
})

test('an envelope that really is cut short is still refused (control)', () => {
  const text = line('hello there')
  assert.equal(parseRoomShare(text.slice(0, text.length - 3)), undefined)
})

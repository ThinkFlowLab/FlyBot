// A room-share envelope is one JSON object after a marker line, and a chat line's text is a JSON
// string inside it: `{` and `}` in that text are ordinary characters, not structure. The scan that
// finds the object's end must therefore know when it is inside a string (and inside an escape), the
// same way the social plugin's own tail reader does (#855) — otherwise one brace in what someone
// typed drops the whole envelope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeRoomShare, parseRoomShare } from '../src/shared/room-share.js'

const line = (text) => parseRoomShare(encodeRoomShare({ op: 'line', roomId: 'r1', seq: 7, who: 'Alice', text }))

test('a line whose text opens a brace is read back, not dropped', () => {
  const parsed = line('if (x) { y()')
  assert.equal(parsed?.op, 'line')
  assert.equal(parsed?.roomId, 'r1')
  assert.equal(parsed?.text, 'if (x) { y()')
})

test('a line whose text closes a brace is read back, not dropped', () => {
  assert.equal(line('so the closing brace is }')?.text, 'so the closing brace is }')
})

test('a brace right after an escaped quote is still inside the string', () => {
  assert.equal(line('say "{" now')?.text, 'say "{" now')
})

test('a copied history line keeps braces too', () => {
  const wire = encodeRoomShare({ op: 'join', roomId: 'abc123', seq: 3, who: 'Alice', history: [{ who: 'Bob', text: 'map { a: 1 }' }] })
  assert.equal(parseRoomShare(wire)?.history?.[0]?.text, 'map { a: 1 }')
})

test('plain text and balanced braces keep their current reading', () => {
  assert.equal(line('plain text')?.text, 'plain text')
  assert.equal(line('a {b} c')?.text, 'a {b} c')
})

test('a truncated envelope is still no envelope', () => {
  assert.equal(parseRoomShare('FLYBOT-ROOM-SHARE\n{"v":1,"op":"line","roomId":"r1"'), undefined)
})

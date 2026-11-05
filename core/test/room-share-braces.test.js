// #2447: the brace scan that finds the end of a room-share envelope has to know when a brace is
// part of a chat line's own text. One unbalanced `{` or `}` in a message used to end the scan in
// the wrong place, JSON.parse then failed, and the whole envelope was dropped — a sent line never
// arrived, and one brace in a copied line killed the join that carried it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeRoomShare, parseRoomShare } from '../src/shared/room-share.js'

const line = (text, extra = {}) => ({ op: 'line', roomId: 'r1', seq: 7, who: 'Alice', text, ...extra })

test('a line whose text opens a brace is read back, not dropped', () => {
  const parsed = parseRoomShare(encodeRoomShare(line('if (x) { y()')))
  assert.equal(parsed?.op, 'line')
  assert.equal(parsed?.roomId, 'r1')
  assert.equal(parsed?.who, 'Alice')
  assert.equal(parsed?.text, 'if (x) { y()')
})

test('a line whose text closes a brace is read back, not dropped', () => {
  const text = 'so the closing brace is }'
  const parsed = parseRoomShare(encodeRoomShare(line(text)))
  assert.equal(parsed?.op, 'line')
  assert.equal(parsed?.text, text)
})

test('a brace right after an escaped quote is still inside the string', () => {
  const text = 'say "{" now'
  assert.equal(parseRoomShare(encodeRoomShare(line(text)))?.text, text)
  const quoteThenBrace = 'a quote " then a brace }'
  assert.equal(parseRoomShare(encodeRoomShare(line(quoteThenBrace)))?.text, quoteThenBrace)
})

test('a join keeps the braces of the lines it copies', () => {
  const parsed = parseRoomShare(encodeRoomShare({
    op: 'join',
    roomId: 'r1',
    name: 'Launch plan',
    history: [
      { who: 'Alice', text: 'if (x) { y() }' },
      { who: 'Bob', text: 'plain line' },
    ],
  }))
  assert.equal(parsed?.op, 'join')
  assert.deepEqual(parsed?.history?.map(entry => entry.text), ['if (x) { y() }', 'plain line'])
})

test('plain text and balanced braces still parse', () => {
  assert.equal(parseRoomShare(encodeRoomShare(line('hello there')))?.text, 'hello there')
  const balanced = 'plan {a} then {b}'
  assert.equal(parseRoomShare(encodeRoomShare(line(balanced)))?.text, balanced)
})

test('a truncated envelope is still refused', () => {
  const whole = encodeRoomShare(line('hello'))
  assert.ok(parseRoomShare(whole))
  assert.equal(parseRoomShare(whole.slice(0, -1)), undefined)
})

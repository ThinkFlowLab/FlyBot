import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGE_REACTIONS, hasMessageText, isLockedRoster, userMessageReactKey, messageActionIds, hasMessageActions } from '../src/shared/message-actions.js'
import { canPinSession, sessionPinned, sessionPinTarget } from '../src/shared/session-pin.js'

test('message actions only include reaction, reply, copy, and download when those can run', () => {
  assert.deepEqual(MESSAGE_REACTIONS, ['👍', '❤️', '😂', '😮', '😢', '🙏'])
  assert.deepEqual(
    messageActionIds({ text: 'Hello', sessionId: 'chief', canReact: true, canReply: true }),
    ['react', 'reply', 'copy', 'download'],
  )
  assert.ok(!messageActionIds({ text: 'Hello', sessionId: 'chief', canReact: true, canReply: true }).includes('artifacts'))
  assert.ok(!messageActionIds({ text: 'Hello' }).includes('translate'))
  assert.ok(!messageActionIds({ text: 'Hello' }).includes('forward'))
  assert.ok(!messageActionIds({ text: 'Hello' }).includes('report'))
  assert.ok(!messageActionIds({ text: 'Hello' }).includes('edit'))
  assert.ok(!messageActionIds({ text: 'Hello' }).includes('pin'))
})

test('copy and download need readable text; reply needs a session and a writable window', () => {
  assert.equal(hasMessageText('  \n'), false)
  assert.deepEqual(messageActionIds({ text: '  ', canReact: true }), ['react'])
  assert.deepEqual(messageActionIds({ text: 'Hi', canReply: true }), ['copy', 'download'])
  assert.deepEqual(messageActionIds({ text: 'Hi', sessionId: 'chief', canReply: true, locked: true }), ['copy', 'download'])
  assert.equal(hasMessageActions({ text: '', canReact: false, canReply: true, sessionId: 'chief' }), false)
  assert.equal(hasMessageActions({ text: '', canReact: false, canReply: true }), false)
})

test('a user bubble gets a reaction key only from a stable turn identity', () => {
  assert.equal(userMessageReactKey('chief', { location: { kind: 'turn', turn: 4 } }), 'chief:4:user')
  assert.equal(userMessageReactKey('chief', { data: { turn: 9 } }), 'chief:9:user')
  assert.equal(userMessageReactKey('chief', { key: 'unstable', data: { content: [] } }), undefined)
  assert.equal(userMessageReactKey('', { data: { turn: 1 } }), undefined)
})

test('session pin follows the host flag and skips remote Bots, the main tile, and a locked window', () => {
  const chief = { id: 'chief', name: 'Chief', pinned: true }
  const writer = { id: 'writer', name: 'Writer', remote: { handle: '@x' } }
  const room = { id: 'room', name: 'Review', pinned: false }
  const roster = { byId: { chief, writer }, roomsById: { room }, mainBotId: 'chief' }
  assert.equal(sessionPinTarget(roster, 'room'), room)
  assert.equal(canPinSession(roster, 'chief'), false)
  assert.equal(canPinSession(roster, 'writer'), false)
  assert.equal(canPinSession(roster, 'room'), true)
  assert.equal(sessionPinned(roster, 'chief'), true)
  assert.equal(sessionPinned(roster, 'room'), false)
  assert.equal(canPinSession({ ...roster, readOnly: 'This window is read-only' }, 'room'), false)
  assert.equal(isLockedRoster({ readOnly: '  ' }), false)
  assert.equal(canPinSession(roster, 'missing'), false)
})

import { sessionIsUnread, matchesSessionFilter } from '../src/shared/session-list-filter.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isManuallyUnread, shouldClearManualUnread, unreadEntryId } from '../src/shared/session-unread.js'

test('manual unread clears only when a chat becomes active, not while it stays open', () => {
  assert.equal(shouldClearManualUnread({ active: true, wasActive: false, marked: true }), true)
  assert.equal(shouldClearManualUnread({ active: true, wasActive: true, marked: true }), false)
  assert.equal(shouldClearManualUnread({ active: false, wasActive: true, marked: true }), false)
  assert.equal(shouldClearManualUnread({ active: true, wasActive: false, marked: false }), false)
})

test('unreadEntryId uses the Bot, room, or agent id the sidebar stores', () => {
  const writer = { id: 'writer', sessionId: 'sess-w' }
  const roster = {
    bots: [{ id: 'chief', sessionId: 'chief' }, writer],
    byId: { chief: { id: 'chief' }, writer },
    rooms: [{ id: 'room-1' }],
    roomsById: { 'room-1': { id: 'room-1' } },
    agents: [{ id: 'dsh', sessions: ['a1'] }],
  }
  assert.equal(unreadEntryId(roster, 'writer'), 'writer')
  assert.equal(unreadEntryId(roster, 'sess-w'), 'writer')
  assert.equal(unreadEntryId(roster, 'room-1'), 'room-1')
  assert.equal(unreadEntryId(roster, 'a1'), 'dsh')
  assert.equal(unreadEntryId(roster, 'missing'), 'missing')
  assert.equal(isManuallyUnread({ writer: true }, 'writer'), true)
  assert.equal(isManuallyUnread({}, 'writer'), false)
})


test('clearing the manual mark does not acknowledge system unread or remove it from unread filter', () => {
  const entry = { kind: 'bot', item: { id: 'chief' } }
  const system = { chief: { completionUnread: true } }
  assert.equal(sessionIsUnread(entry, system, { chief: true }), true)
  assert.equal(matchesSessionFilter(entry, 'unread', sessionIsUnread(entry, system, {})), true)
  assert.equal(sessionIsUnread(entry, { chief: { pendingInteraction: { kind: 'question' } } }, {}), true)
  assert.equal(sessionIsUnread(entry, {}, {}), false)
})

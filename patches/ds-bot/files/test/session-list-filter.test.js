import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesSessionFilter, sessionIsUnread, sessionStatusOf, SESSION_FILTERS } from '../src/shared/session-list-filter.js'

const chief = { kind: 'bot', item: { id: 'chief', name: 'Chief' } }
const writer = { kind: 'bot', item: { id: 'writer', name: 'Writer', sessionId: 'writer-s' } }
const room = { kind: 'room', item: { id: 'room-1', name: 'Review room' } }
const agent = { kind: 'agent', item: { id: 'dsh', sessions: ['a1', 'a2'] } }

test('the public filters are all, group, direct, and unread', () => {
  assert.deepEqual(SESSION_FILTERS, ['all', 'group', 'direct', 'unread'])
})

test('all keeps every row; group is rooms; direct is Bots and the coding agent', () => {
  assert.equal(matchesSessionFilter(chief, 'all'), true)
  assert.equal(matchesSessionFilter(room, 'all'), true)
  assert.equal(matchesSessionFilter(agent, 'all'), true)
  assert.equal(matchesSessionFilter(room, 'group'), true)
  assert.equal(matchesSessionFilter(chief, 'group'), false)
  assert.equal(matchesSessionFilter(agent, 'group'), false)
  assert.equal(matchesSessionFilter(chief, 'direct'), true)
  assert.equal(matchesSessionFilter(agent, 'direct'), true)
  assert.equal(matchesSessionFilter(room, 'direct'), false)
})

test('unread keeps only rows already marked unread, and never invents a read chip', () => {
  assert.equal(matchesSessionFilter(chief, 'unread', false), false)
  assert.equal(matchesSessionFilter(chief, 'unread', true), true)
  assert.equal(matchesSessionFilter(room, 'unread', true), true)
  assert.equal(SESSION_FILTERS.includes('read'), false)
})

test('unread follows completion, a pending bot interaction, or a manual mark', () => {
  const map = new Map([
    ['chief', { completionUnread: true }],
    ['writer-s', { pendingInteraction: { id: 'q1' } }],
    ['room-1', { completionUnread: true }],
    ['a2', { completionUnread: true }],
  ])
  assert.equal(sessionIsUnread(chief, map, {}), true)
  assert.equal(sessionIsUnread(writer, map, {}), true)
  assert.equal(sessionIsUnread(room, map, {}), true)
  assert.equal(sessionIsUnread(agent, map, {}), true)
  assert.equal(sessionIsUnread(chief, new Map(), { chief: true }), true)
  assert.equal(sessionIsUnread(writer, new Map(), {}), false)
  assert.equal(sessionIsUnread(room, new Map(), {}), false)
  assert.equal(sessionIsUnread(agent, new Map(), {}), false)
  assert.equal(sessionStatusOf({ chief: { completionUnread: true } }, 'chief')?.completionUnread, true)
  assert.equal(sessionStatusOf(null, 'chief'), undefined)
})

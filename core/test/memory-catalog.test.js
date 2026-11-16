// Directory grouping and search over already-loaded memory entries.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterMemoryEntries, memoryStats, memoryTopics, sameTopic, topicKey } from '../src/shared/memory-catalog.js'

const entries = [
  { text: 'Prefers the window seat on flights', scope: 'own', topic: 'travel', by: null },
  { text: 'Allergic to peanuts', scope: 'own', topic: null, by: null },
  { text: 'Standup is at 10:00', scope: 'team', topic: 'rituals', by: 'Chief' },
  { text: 'The travel budget is tight this quarter', scope: 'team', topic: 'travel', by: 'Writer' },
]

test('topics are grouped by scope, untagged first, then by name', () => {
  assert.deepEqual(memoryTopics(entries), [
    { scope: 'own', topic: null, count: 1 },
    { scope: 'own', topic: 'travel', count: 1 },
    { scope: 'team', topic: 'rituals', count: 1 },
    { scope: 'team', topic: 'travel', count: 1 },
  ])
  assert.deepEqual(memoryTopics([]), [])
  assert.deepEqual(memoryTopics(undefined), [])
})

test('stats count entries and named topics, not the untagged main file', () => {
  assert.deepEqual(memoryStats(entries), { entries: 4, topics: 3 })
  assert.deepEqual(memoryStats([]), { entries: 0, topics: 0 })
  // own travel and team travel are two topics
  assert.equal(memoryStats([{ topic: 'travel', scope: 'own' }, { topic: 'travel', scope: 'team' }]).topics, 2)
})

test('search keeps entries that contain every term in the text, topic, or author', () => {
  assert.equal(filterMemoryEntries(entries, '').length, 4)
  assert.deepEqual(filterMemoryEntries(entries, '  ').map(item => item.text), entries.map(item => item.text))
  assert.deepEqual(filterMemoryEntries(entries, 'window seat').map(item => item.text), ['Prefers the window seat on flights'])
  assert.deepEqual(filterMemoryEntries(entries, 'TRAVEL').map(item => item.text), [
    'Prefers the window seat on flights',
    'The travel budget is tight this quarter',
  ])
  assert.deepEqual(filterMemoryEntries(entries, 'chief').map(item => item.text), ['Standup is at 10:00'])
  assert.deepEqual(filterMemoryEntries(entries, 'window budget'), [])
})

test('a topic key treats missing and empty names as the untagged main file', () => {
  assert.equal(topicKey({ scope: 'own' }), 'own:')
  assert.equal(sameTopic({ scope: 'team', topic: 'travel' }, { scope: 'team', topic: 'travel' }), true)
  assert.equal(sameTopic({ scope: 'own', topic: 'travel' }, { scope: 'team', topic: 'travel' }), false)
})

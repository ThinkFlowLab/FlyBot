// Edge cases for the semantic recall merged in #478: CJK, stem matching across a whole word,
// determinism, and a [[topic]] graph with a cycle, a self-link and no link. Test only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph, buildIndex, relatedOf, searchIndex, termsOf, topicNode } from '../src/host/memory-search.js'

test('a Chinese query finds a Chinese entry, with no word split', () => {
  const index = buildIndex([
    { key: 'seat', ref: '用户喜欢靠窗的座位' },
    { key: 'ship', ref: 'The user ships on Friday' },
  ])
  assert.equal(searchIndex(index, '靠窗座位')[0]?.doc.key, 'seat')
  // A query that shares a term still matches; an unrelated one does not.
  assert.ok(searchIndex(index, '座位').some(hit => hit.doc.key === 'seat'))
  assert.ok(!searchIndex(index, 'noodles').some(hit => hit.doc.key === 'seat'))
})

test('a word stem matches across endings, and the ranking is deterministic', () => {
  const docs = [{ key: 'a', ref: 'The user books flights' }, { key: 'b', ref: 'Likes strong coffee' }]
  const ranked = (entries, query = 'flight bookings') => searchIndex(buildIndex(entries), query).map(hit => hit.doc.key)
  assert.deepEqual(ranked(docs), ['a'])
  // Two entries that share every term score the same, so the key breaks the tie: the recall list is
  // the same on every read, and re-reading the files in another order does not reorder it.
  const tied = [{ key: 'b', ref: 'the window seat' }, { key: 'a', ref: 'the window seat' }, { key: 'c', ref: 'nothing here' }]
  assert.deepEqual(ranked(tied, 'window seat'), ['a', 'b'])
  assert.deepEqual(ranked([...tied].reverse(), 'window seat'), ['a', 'b'])
  // An entry matching both query words ranks above one that matches a single word.
  const partial = [{ key: 'only-window', ref: 'window' }, { key: 'both', ref: 'window seat' }]
  assert.deepEqual(ranked(partial, 'window seat'), ['both', 'only-window'])
})

test('an empty query, and a tokenization with nothing to keep, return no hits', () => {
  const index = buildIndex([{ key: 'a', ref: 'x' }])
  assert.deepEqual(searchIndex(index, ''), [])
  assert.deepEqual(searchIndex(index, '  '), [])
  assert.deepEqual([...termsOf('- - -').keys()], [])
})

test('a two-way [[topic]] link does not loop, and a self-link is ignored', () => {
  const graph = buildGraph([
    { topic: 'a', entries: [{ text: 'see [[b]] and [[a]]', meta: {} }] },
    { topic: 'b', entries: [{ text: 'see [[a]]', meta: {} }] },
  ])
  const near = relatedOf(graph, topicNode('a'), { hops: 3 }).neighbours
  assert.deepEqual(near.map(node => node.name), ['b'], 'b once, a itself never')
  assert.equal(graph.edges.some(edge => edge.from === edge.to), false, 'the self-link is dropped')
})

test('an unknown start is empty, and a topic with no link has no neighbours', () => {
  const graph = buildGraph([{ topic: 'lonely', entries: [{ text: 'no links here', meta: {} }] }])
  assert.deepEqual(relatedOf(graph, topicNode('nope')).neighbours, [])
  assert.deepEqual(relatedOf(graph, topicNode('lonely')).neighbours, [])
})

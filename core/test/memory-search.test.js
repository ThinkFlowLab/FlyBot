import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botNode, buildGraph, buildIndex, relatedOf, searchIndex, termsOf, topicNode } from '../src/host/memory-search.js'

test('termsOf keeps words, adds a trigram of longer words, and splits CJK runs', () => {
  const terms = termsOf('Favourite window seats 靠窗的座位')
  for (const word of ['favourite', 'window', 'seats']) assert.ok(terms.has(word), word)
  // A word of four or more letters also contributes a character trigram, so a stem
  // matches across endings ("seat" and "seats" share #sea and #eat).
  assert.ok(terms.has('#fav'), 'favourite trigram')
  assert.equal(termsOf('seat').has('#sea'), true)
  assert.equal(termsOf('seats').has('#sea'), true)
  // CJK needs no spaces: each character and each pair is a term.
  for (const term of ['靠', '窗', '靠窗', '窗的']) assert.ok(terms.has(term), term)
})

test('searchIndex finds an entry whose wording differs from the query', () => {
  const docs = [
    { key: 'a', text: 'The user prefers window seats on long flights' },
    { key: 'b', text: 'The user ships on Friday' },
    { key: 'c', text: 'Likes strong coffee' },
  ]
  const index = buildIndex(docs)
  // "flight seat" is not a substring of entry a, but its stem matches "flights"/"seats".
  const hits = searchIndex(index, 'flight seat', { k: 3 })
  assert.equal(hits[0]?.doc.key, 'a')
  assert.ok(!hits.some(hit => hit.doc.key === 'c'), 'an unrelated entry is not returned')
  assert.equal(searchIndex(index, '', { k: 3 }).length, 0)
})

test('searchIndex ranks the entry that shares the rarer word higher', () => {
  const docs = [
    { key: 'common', text: 'The user prefers tea in the morning' },
    { key: 'rare', text: 'The user prefers tea grown in Hangzhou' },
    { key: 'other', text: 'The user prefers tea' },
  ]
  const hits = searchIndex(buildIndex(docs), 'tea Hangzhou', { k: 3 })
  assert.equal(hits[0]?.doc.key, 'rare')
})

test('buildGraph and relatedOf walk [[links]] and who wrote an entry', () => {
  const files = [
    { topic: undefined, entries: [{ text: 'See [[travel]] for trips', meta: {} }] },
    { topic: 'travel', entries: [{ text: 'Prefers window seats', meta: { by: 'Writer' } }, { text: 'Likes [[food]]', meta: {} }] },
    { topic: 'food', entries: [{ text: 'Loves noodles', meta: {} }] },
  ]
  const graph = buildGraph(files)
  assert.ok(graph.has(topicNode('travel')))
  assert.ok(graph.has(botNode('writer'))) // ids fold case
  const near = relatedOf(graph, topicNode('travel'), { hops: 1 })
  const names = near.neighbours.map(node => `${node.kind}:${node.name}`)
  assert.ok(names.includes('bot:Writer'), names.join(','))
  assert.ok(names.includes('topic:food'))
  assert.ok(names.includes('topic:memory'), 'the MEMORY.md entry point links to travel')
  // Two hops reach the topic the linked one links to.
  const far = relatedOf(graph, topicNode('memory'), { hops: 2 })
  assert.ok(far.neighbours.some(node => node.kind === 'topic' && node.name === 'food'))
  assert.deepEqual(relatedOf(graph, topicNode('nope'), { hops: 1 }).neighbours, [])
})

// The guard preview (#1272 step 3, acceptance 5): the sentence this definition would print under the
// facts somebody just read, naming both revisions, and — when the reader answered nothing — a row
// that says it could not read the fact rather than a guessed pass.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifact } from '../src/shared/artifact.js'
import { previewNode } from '../src/shared/workflow-preview.js'

const review = {
  id: 'review-flow',
  name: 'Review flow',
  version: 1,
  inputs: ['pr'],
  deliverables: ['release'],
  nodes: [
    {
      id: 'gate',
      name: 'Gate',
      role: 'Reviewer',
      column: 'in-progress',
      inputs: ['pr'],
      outputs: ['risk:tier'],
      guards: [
        { id: 'no-hold', spec: 'pr', is: 'equals', value: 'none', refusal: 'the pull request carries the `hold` label' },
        { id: 'verdict-at-tip', spec: 'verdict', is: 'fresh', refusal: 'the pull request head is {now}, not the expected {have}' },
      ],
      refusal: 'Gate cannot start: its input {input} is not current.',
    },
    { id: 'done', name: 'Done', role: 'Release', inputs: ['risk:tier'], outputs: ['release'], guards: [], refusal: 'Done cannot start.' },
  ],
  edges: [],
  loops: [],
}

const facts = (over = {}) => ({
  present: {
    pr: artifact('pr', 'abc1234', { value: 'none' }),
    verdict: artifact('verdict', 'abc1234', { value: 'PASS', by: 'Reviewer' }),
  },
  current: { pr: 'abc1234', verdict: 'def5678' },
  ...over,
})

test('a stale verdict prints the producer sentence with both revisions and no pass', () => {
  const preview = previewNode(review, 'gate', { ok: true, facts: facts() })
  assert.equal(preview.facts, 'read')
  const row = preview.rows.find((entry) => entry.id === 'verdict-at-tip')
  assert.equal(row.state, 'refuse')
  assert.equal(row.unreadable, false)
  assert.match(row.sentence, /abc1234/)
  assert.match(row.sentence, /def5678/)
  // The first refusal is the node's own answer, which is the sentence a card would show.
  assert.equal(preview.refusal, row.sentence)
  // The guard that holds says nothing at all — a row with no sentence is a fact that was read.
  assert.equal(preview.rows.find((entry) => entry.id === 'no-hold').state, 'holds')
  assert.equal(preview.rows.find((entry) => entry.id === 'no-hold').sentence, null)
})

test('a fact that could not be read is named, and a reader that answered nothing says so', () => {
  const unreadable = previewNode(review, 'gate', { ok: true, facts: facts({ current: { pr: 'abc1234', verdict: null } }) })
  const row = unreadable.rows.find((entry) => entry.id === 'verdict-at-tip')
  assert.equal(row.state, 'unreadable')
  assert.equal(row.unreadable, true)
  assert.match(row.sentence, /could not be checked against the source/)

  const silent = previewNode(review, 'gate', { ok: false, why: 'no GITHUB_TOKEN' })
  assert.equal(silent.facts, 'unavailable')
  assert.equal(silent.why, 'no GITHUB_TOKEN')
  assert.equal(silent.rows.length, 2)
  for (const entry of silent.rows) {
    assert.equal(entry.state, 'unreadable')
    assert.match(entry.sentence, /could not be read/)
    assert.doesNotMatch(entry.sentence, /passes|it is fine/i)
  }
  // The definition itself is never changed by a preview.
  assert.equal(silent.rows[0].spec, 'pr')
})

test('a check nobody implemented refuses instead of being read as present', () => {
  const broken = { ...review, nodes: [{ ...review.nodes[0], guards: [{ id: 'typo', spec: 'pr', is: 'fres' }] }] }
  const preview = previewNode(broken, 'gate', { ok: true, facts: facts() })
  assert.equal(preview.rows[0].state, 'refuse')
  assert.match(preview.rows[0].sentence, /is not one of present, fresh, equals/)
})

test('a node with no guards and a node that does not exist both answer plainly', () => {
  const none = previewNode(review, 'done', { ok: true, facts: facts() })
  assert.deepEqual(none.rows, [])
  assert.equal(none.refusal, null)
  const missing = previewNode(review, 'nope', { ok: true, facts: facts() })
  assert.deepEqual(missing.rows, [])
  assert.match(missing.refusal, /there is no node "nope"/)
})

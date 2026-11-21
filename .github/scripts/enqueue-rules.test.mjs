// `stopRequestAt` reads a sentence people actually write, so the shapes below are quoted from the
// record rather than invented: #2520's comment 6860674068 says "… say so on the PR and I will hold
// it", which is an offer to hold on request, not the request itself. The rest are the controls that
// keep the reading from widening: the imperative, the plain do-not-merge, and a first-person plan
// that names its own condition are all still stops.
import assert from 'node:assert/strict'
import test from 'node:test'

import { stopRequestAt } from './enqueue-rules.mjs'

// The row shape `stopRequestAt` reads: a person's comment (`type: 'User'`), not a review state.
// `user: { type }` and `created_at` are not read at all, so a row written that way answers `null`
// for every body and would make every case below pass for the wrong reason.
const comment = (body) => [{
  id: 6860674068,
  type: 'User',
  login: 'HugoXK',
  at: '2026-11-13T17:51:54Z',
  state: 'COMMENTED',
  body,
}]

const stopFor = (body) => stopRequestAt(comment(body), { author: 'HugoXK' })

test('#2520: an offer to hold on request is not a stop', () => {
  assert.equal(
    stopFor('If this PR should wait behind other work, say so on the PR and I will hold it; otherwise it is the oldest unanswered T3 request in the queue.'),
    null,
  )
})

test('an imperative hold is still a stop', () => {
  assert.notEqual(stopFor('Please hold it.'), null)
})

test('a do-not-merge request is still a stop', () => {
  assert.notEqual(stopFor('do not merge this tip'), null)
})

test('a first-person hold that names its condition is still a stop', () => {
  assert.notEqual(stopFor('I will hold it until the second reader signs off'), null)
})

test('an announced hold does not hide a request behind it', () => {
  assert.notEqual(stopFor('I will hold it now; do not merge this tip'), null)
})

test('a past hold is not a request', () => {
  assert.equal(stopFor('I held it until CI went green, then released'), null)
})

// The condition may sit in the clause *after* the phrase. An em dash, a semicolon or a full stop ends
// the clause without ending the sentence, and the plan is still conditional — the reader has to look
// on both sides of the bound, or an announcement swallows the stop it qualifies (#3088 advisory).
test('#3088: a plan whose condition follows the phrase is still a stop — em dash', () => {
  assert.notEqual(stopFor('I will hold it — until the second reader signs off'), null)
})

test('#3088: a plan whose condition follows the phrase is still a stop — semicolon', () => {
  assert.notEqual(stopFor('I will hold it; pending the second reader'), null)
})

test('#3088: a plan whose condition follows the phrase is still a stop — full stop', () => {
  assert.notEqual(stopFor('I will hold it. Until the second reader signs off, this waits.'), null)
})

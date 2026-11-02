// The suite judges DEEPSEEK_API_KEY in three places: the CI preflight that decides whether any
// step runs, the bench starter, and the run guard that fails the run closed. Two of them refused
// a key the third one accepted, so a short or mock key published `key=true`, ran the bench and
// failed the night for a reason the skip exists to avoid (#794). One reading, three readers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { plan } from '../../../.github/scripts/live-e2e-preflight.mjs'
import { guardRun } from '../report.mjs'

const CASES = [
  ['', 'a missing key'],
  [undefined, 'an unset key'],
  ['   ', 'a blank key'],
  ['mock-key', "the mock's key"],
  ['short', 'a short key'],
  ['a'.repeat(15), 'a key one character under the floor'],
  ['a'.repeat(16), 'a key exactly at the floor'],
  ['sk-' + 'a'.repeat(32), 'a real-looking key'],
]

const keyProblems = (apiKey) => guardRun({ apiKey, baseUrl: undefined }).problems.filter((problem) => problem.startsWith('DEEPSEEK_API_KEY'))

test('the preflight and the run guard accept exactly the same keys', () => {
  for (const [key, what] of CASES) {
    assert.equal(plan(key).present, keyProblems(key).length === 0, `the preflight and the run guard disagree about ${what}`)
  }
})

test('the bench starter reads the key through the same module, with no threshold of its own', () => {
  const bench = readFileSync(new URL('../bench.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(bench, /\blength\s*</, 'the bench keeps its own length threshold')
  assert.match(bench, /keyReading|keyState|keyProblem/, 'the bench does not read the shared verdict')
})

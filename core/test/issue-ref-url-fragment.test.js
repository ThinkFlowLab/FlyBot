// A URL fragment is not an issue reference (#1392). The repository-qualified shape
// `owner/repo#12` has no lookbehind, so a link whose path carries a segment before the `#` read as
// `<host>/<segment>#12` — `https://example.com/page#123` named issue #123 — and the dispatch wrote
// a card for an issue nobody meant (#1360).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { issueRefs, namesIssue } from '../src/shared/issue-ref.js'

const fragments = [
  'see https://example.com/page#123 for details',
  'https://example.com/docs/guide#12',
  'read https://docs.example.org/a/b#42 then',
]

for (const text of fragments) {
  test(`a URL fragment is not an issue reference: ${text}`, () => {
    assert.deepEqual(issueRefs(text), [], text)
  })
}

test('the shapes that name an issue keep working beside a URL', () => {
  assert.deepEqual(issueRefs('owner/repo#1360'), ['#1360'])
  assert.deepEqual(issueRefs('see owner/repo#1360 for the fix'), ['#1360'])
  assert.deepEqual(issueRefs('please rebase #1360 onto main'), ['#1360'])
  assert.deepEqual(issueRefs('https://github.com/o/r/issues/1360'), ['#1360'])
  assert.deepEqual(issueRefs('@Dev-2 rebase owner/repo#1360'), ['#1360'])
  assert.equal(namesIssue('https://example.com/docs/guide#12', 12), false)
  assert.equal(namesIssue('owner/repo#1360', 1360), true)
})

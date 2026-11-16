// A URL fragment is not an issue reference (#1392). The repository-qualified shape `owner/repo#12`
// had no boundary in front of it, so a link whose path carries a segment before the `#` read as
// `<host>/<segment>#12`: `https://example.com/page#123` named issue #123 and the dispatch wrote a
// card for an issue nobody meant (#1360). The boundary and the number are asserted apart: a
// fragment must not hand over digits, and a real GitHub URL with a fragment must still yield exactly
// one number.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { issueRefs, namesIssue } from '../src/shared/issue-ref.js'

const fragments = [
  ['a path segment before the #', 'see https://example.com/page#123 for details'],
  ['a two-segment path', 'https://example.com/docs/guide#12'],
  ['a nested path', 'read https://docs.example.org/a/b#42 then'],
  ['a fragment of seven digits', 'see https://example.com/page#1234567 for details'],
  ['a fragment longer than an id', 'https://example.com/page#12345678'],
]

for (const [what, text] of fragments) {
  test(`a URL fragment names no issue (${what})`, () => {
    assert.deepEqual(issueRefs(text), [], text)
  })
}

test('a fragment does not keep the digits of the link it follows', () => {
  assert.equal(namesIssue('https://example.com/page#123', 123), false)
  assert.equal(namesIssue('https://example.com/page#1234', 123), false)
})

test('one GitHub URL yields exactly one issue number, fragment and all', () => {
  assert.deepEqual(issueRefs('https://github.com/o/r/issues/123#issuecomment-4567'), ['#123'])
  assert.deepEqual(issueRefs('https://github.com/o/r/pull/9#discussion_r123456'), ['#9'])
})

test('the shapes that do name an issue keep working beside a URL', () => {
  assert.deepEqual(issueRefs('owner/repo#1360'), ['#1360'])
  assert.deepEqual(issueRefs('see owner/repo#1360 for the fix'), ['#1360'])
  assert.deepEqual(issueRefs('please rebase #1360 onto main'), ['#1360'])
  assert.deepEqual(issueRefs('https://github.com/o/r/issues/1360'), ['#1360'])
  assert.deepEqual(issueRefs('@Dev-2 rebase owner/repo#1360'), ['#1360'])
  assert.equal(namesIssue('owner/repo#1360', 1360), true)
})

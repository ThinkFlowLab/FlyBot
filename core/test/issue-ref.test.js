// A `#1234` is a reference only when the number stands on its own (P-14, from #1360's dispatch).
// A hex colour, a language version, a version string, an identifier and a URL fragment all used
// to read as one, and each of them dispatches a card that names an issue which does not exist;
// the shapes that do name an issue have to keep working beside them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { issueRefs, namesIssue } from '../src/shared/issue-ref.js'

const rejected = [
  ['a hex colour', '@Dev-2 set the accent colour to #3366ff'],
  ['a language version', 'fix C#7 codegen'],
  ['a version string', 'version in 1.2#3'],
  ['an identifier', 'the room abc#12 resolved'],
  ['a number running into letters', '#1360abc'],
  ['a URL fragment', 'see https://example.com/help/#123'],
]

for (const [what, text] of rejected) {
  test(`${what} is not an issue reference`, () => {
    assert.deepEqual(issueRefs(text), [], text)
  })
}

const accepted = [
  ['a bare number', '#1360', ['#1360']],
  ['a repository-qualified number', 'owner/repo#1360', ['#1360']],
  ['a github issue URL', 'https://github.com/o/r/issues/1360', ['#1360']],
  ['a github pull URL', 'https://github.com/o/r/pull/1360', ['#1360']],
  ['a number after a Bot mention', '@Dev-2 rebase #1360', ['#1360']],
  ['a number in a sentence', 'please rebase #1360 onto main', ['#1360']],
  ['numbers in brackets and punctuation', '(#1360), #1361.', ['#1360', '#1361']],
]

for (const [what, text, expected] of accepted) {
  test(`${what} still names the issue: ${text}`, () => {
    assert.deepEqual(issueRefs(text), expected)
  })
}

test('namesIssue answers the same question, so a colour cannot name an issue', () => {
  assert.equal(namesIssue('accent #3366ff', 3366), false)
  assert.equal(namesIssue('fix C#7', 7), false)
  assert.equal(namesIssue('1.2#3', 3), false)
  assert.equal(namesIssue('abc#12', 12), false)
  assert.equal(namesIssue('#1360abc', 1360), false)
  assert.equal(namesIssue('https://example.com/help/#123', 123), false)
  assert.equal(namesIssue('owner/repo#1360', 1360), true)
  assert.equal(namesIssue('@Dev-2 rebase #1360', 1360), true)
})

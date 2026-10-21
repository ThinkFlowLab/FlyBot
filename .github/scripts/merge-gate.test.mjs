// merge-gate: what refuses a queue entry, and the shape of the merge_group workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { judge, prFromHeadRef } from './merge-gate.mjs'

const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const ENTRY = `gh-readonly-queue/main/pr-566-${HEAD}`
const policy = { reviewers: ['reviewer-agent'], selfReview: [] }

const report = ({ tip = HEAD, verdict = 'PASS' } = {}) =>
  [`Tip SHA: ${tip}`, 'Ran:', '  - npm run verify → pass', 'Not run:', '  - smoke — host code unchanged', `Verdict: ${verdict}`].join('\n')

const say = (body = report(), at = '2026-10-21T10:31:00Z', kind = 'comment') => ({ login: 'reviewer-agent', body, at, kind })

const judgeAt = (over = {}) => judge({ labels: [], head: HEAD, author: 'opener', reports: [say()], policy, queuedSha: HEAD, ...over })

test('the queue branch is the only pointer to the pull request', () => {
  assert.deepEqual(prFromHeadRef(ENTRY), { pr: 566, sha: HEAD })
  assert.equal(prFromHeadRef('gh-readonly-queue/main/pr-616-81c708d054f43c90fd201ae3a281fd2e8e8916e7').pr, 616)
  assert.equal(prFromHeadRef('refs/heads/main'), null, 'a ref that is not a queue entry names no pull request')
  assert.equal(prFromHeadRef('gh-readonly-queue/main/pr-566-not-a-sha'), null)
  assert.equal(prFromHeadRef(undefined), null)
})

test('a PASS at the merged head lets the entry through', () => {
  const r = judgeAt()
  assert.equal(r.ok, true)
  assert.equal(r.held, false)
  assert.equal(r.verdict.by, 'reviewer-agent')
})

test('hold refuses the entry, whatever the review says', () => {
  const r = judgeAt({ labels: [{ name: 'hold' }] })
  assert.equal(r.ok, false)
  assert.equal(r.held, true)
  assert.match(r.reasons.join('; '), /`hold` label/)
  assert.equal(judgeAt({ labels: ['HOLD'] }).ok, false, 'label names compare case-insensitively')
})

test('a PASS that names an older tip is not this head', () => {
  const r = judgeAt({ reports: [say(report({ tip: OLD }))] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /not the tip/)
})

test('#610: the INC was written after the tip report, and it decides', () => {
  const r = judgeAt({
    reports: [say(report(), '2026-10-21T10:31:08Z'), say(report({ verdict: 'INC' }), '2026-10-21T11:24:37Z')],
  })
  assert.equal(r.ok, false)
  assert.equal(r.verdict.verdict, 'INC')
  assert.match(r.reasons.join('; '), /INC/)
})

test('#610: the INC is a comment, not a review, and is still read', () => {
  const r = judgeAt({ reports: [say(report(), '2026-10-21T10:31:08Z'), say(report({ verdict: 'INC' }), '2026-10-21T11:24:37Z', 'comment')] })
  assert.equal(r.ok, false)
  assert.equal(r.verdict.verdict, 'INC')
  const review = judgeAt({ reports: [say(report(), '2026-10-21T10:31:08Z'), say(report({ verdict: 'INC' }), '2026-10-21T11:24:37Z', 'review')] })
  assert.equal(review.ok, false, 'a review body is judged the same way')
})

test('a later PASS after an INC clears it: the newest conclusion wins', () => {
  const r = judgeAt({ reports: [say(report({ verdict: 'INC' }), '2026-10-21T11:00:00Z'), say(report(), '2026-10-21T12:00:00Z')] })
  assert.equal(r.ok, true)
})

test('no conclusion at all refuses: conservative, never a benefit of the doubt', () => {
  const r = judgeAt({ reports: [say('LGTM, merging this')] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no Verifier report names the tip/)
})

test('a head that moved after the entry was built is refused', () => {
  const r = judgeAt({ head: OLD, queuedSha: HEAD })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /head moved/)
})

test('no head sha refuses instead of passing', () => {
  const r = judge({ labels: [], head: '', author: 'a', reports: [say()], policy, queuedSha: '' })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no head sha/)
})

test('workflow: merge_group only, read-only, judges the base copy, acts on nothing', () => {
  const wf = readFileSync(new URL('../workflows/merge-gate.yml', import.meta.url), 'utf8')
  const triggers = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\nconcurrency:'))
  const perms = wf.slice(wf.indexOf('\npermissions:\n'), wf.indexOf('\njobs:'))
  assert.match(triggers, /^ {2}merge_group:\s*$/m, 'the gate runs on the queue entry, not on the pull request')
  assert.doesNotMatch(triggers, /pull_request_target/, 'never a write token on pull request code')
  assert.doesNotMatch(triggers, /pull_request:|push:|schedule/, 'a review written later is only visible at the queue entry')
  assert.match(perms, /^permissions:\n(?: {2}[\w-]+: read\n)+$/m)
  assert.doesNotMatch(perms, /: write/, 'the gate never writes')
  assert.match(wf, /^ {4}name: merge-gate$/m, 'the job name is what a required-check list matches')
  assert.match(wf, /ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}/, 'the script and the policy come from the base commit')
  assert.match(wf, /HEAD_REF: \$\{\{ github\.event\.merge_group\.head_ref \}\}/)
  assert.match(wf, /run: node base\/\.github\/scripts\/merge-gate\.mjs/)
  assert.doesNotMatch(wf, /continue-on-error: true/, 'a refusal must fail the job, not report it like review-gate.yml does')
  assert.doesNotMatch(wf, /gh pr merge|--approve|reviewDecision|GH_TOKEN: \$\{\{ secrets\./, 'no merge, no approval, no secret')
})

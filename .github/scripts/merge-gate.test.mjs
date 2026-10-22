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

// The real event payload, verbatim from run 39694988559 (the #626 queue entry): GitHub passes the
// queue branch fully qualified. Without this, every entry failed before judging anything.
test('#652 follow-up: a head_ref that carries refs/heads/ still names the queue entry', () => {
  assert.deepEqual(prFromHeadRef(`refs/heads/${ENTRY}`), { pr: 566, sha: HEAD })
  assert.deepEqual(prFromHeadRef('refs/heads/gh-readonly-queue/main/pr-652-020490044ccad1551f769f0ee141da218f71c1fd'), {
    pr: 652,
    sha: '020490044ccad1551f769f0ee141da218f71c1fd',
  })
  assert.equal(prFromHeadRef('refs/tags/gh-readonly-queue/main/pr-566-' + HEAD), null, 'only a branch ref is a queue entry')
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

test('workflow: merge_group judges, pull_request reports, read-only, judges the base copy', () => {
  const wf = readFileSync(new URL('../workflows/merge-gate.yml', import.meta.url), 'utf8')
  const triggers = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\nconcurrency:'))
  const perms = wf.slice(wf.indexOf('\npermissions:\n'), wf.indexOf('\njobs:'))
  assert.match(triggers, /^ {2}merge_group:\s*$/m, 'the queue entry is where the judgement happens')
  // #639: a required check that only runs on merge_group leaves every pull request waiting for a
  // status that never comes, so the same job also reports on the pull request head.
  assert.match(triggers, /^ {2}pull_request:\s*$/m, 'the same check reports on the pull request head')
  assert.doesNotMatch(triggers, /pull_request_target/, 'never a write token on pull request code')
  assert.doesNotMatch(triggers, /push:|schedule/, 'neither a merge nor a push runs this')
  assert.match(wf, /MODE: \$\{\{ github\.event_name == 'pull_request' && 'report' \|\| 'queue' \}\}/, 'the pull_request run is the reporting one')
  assert.match(perms, /^permissions:\n(?: {2}[\w-]+: read\n)+$/m)
  assert.doesNotMatch(perms, /: write/, 'the gate never writes')
  assert.match(wf, /^ {4}name: merge-gate$/m, 'the job name is what a required-check list matches')
  assert.match(wf, /ref: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/, 'the script and the policy come from the base commit, never from the pull request')
  assert.match(wf, /HEAD_REF: \$\{\{ github\.event\.merge_group\.head_ref \}\}/)
  assert.match(wf, /PR: \$\{\{ github\.event\.pull_request\.number \}\}/, 'a pull_request run has no head_ref, so it passes the number')
  assert.match(wf, /run: node base\/\.github\/scripts\/merge-gate\.mjs/)
  assert.doesNotMatch(wf, /continue-on-error: true/, 'a refusal must fail the queue entry')
  // The pull_request run is the exception: the script comes from the base commit, which may predate
  // report mode and refuse for lack of a conclusion — that must not fail the check (#639).
  assert.match(wf, /continue-on-error: \$\{\{ github\.event_name == 'pull_request' \}\}/, 'only the report run tolerates the base copy refusing')
  assert.doesNotMatch(wf, /gh pr merge|--approve|reviewDecision|GH_TOKEN: \$\{\{ secrets\./, 'no merge, no approval, no secret')
})

// ---- through the entry point the queue uses (#637): main() itself, with the API replaced by a
// fake `gh`, so the whole judgement is exercised without the network.
import { main } from './merge-gate.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeGh = ({ comments, reviews = [], labels = [], files = [] }) => (...args) => {
  const path = args[args.length - 1]
  const pull = { head: { sha: HEAD }, user: { login: 'opener' }, labels: labels.map((name) => ({ name })) }
  if (path.includes('/files')) return (files ?? []).map((filename) => JSON.stringify({ filename })).join('\n')
  if (path.includes('/comments')) return [comments].flat().map((entry) => JSON.stringify(entry)).join('\n')
  if (path.includes('/reviews')) return [reviews].flat().map((entry) => JSON.stringify(entry)).join('\n')
  if (/\/pulls\/\d+$/.test(path)) return JSON.stringify(pull)
  throw new Error('fake gh: unexpected ' + path)
}

const runGate = (fixture) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policy, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [] }))
  return main({
  gh: fakeGh(fixture),
  env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policy },
  repo: 'ThinkFlowLab/FlyBot',
  pr: 637,
  headRef: ENTRY,
  })
}

const apiComment = (body, at) => ({ user: { login: 'reviewer-agent' }, body, created_at: at })
const apiReview = (body, at) => ({ user: { login: 'reviewer-agent' }, body, submitted_at: at })

const firstLine = (verdict, tip = HEAD) => [
  `Verdict: ${verdict} at ${tip}`,
  'Written by: Reviewer. Posted by: Chief (proxy).',
  '',
  'Ran: npm run verify → pass',
  'Not run: smoke',
].join('\n')

test('#637: the queue entry refuses the newest conclusion INC, through main()', () => {
  const result = runGate({ comments: [apiComment(firstLine('PASS'), '2026-10-21T12:40:00Z'), apiComment(firstLine('INC'), '2026-10-21T12:49:00Z')] })
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('; '), /INC/)
})

test('#637: a verdict Chief posts for the Reviewer parses like the Reviewer wrote it', () => {
  const result = runGate({ comments: [apiComment(firstLine('PASS'), '2026-10-21T12:40:00Z')] })
  assert.equal(result.ok, true)
  assert.equal(result.verdict.by, 'reviewer-agent')
})

test('#637: a body that does not start with the verdict is no conclusion, so the entry is refused', () => {
  const prefixed = ['Verdict (written by Reviewer, posted by Chief)', '', firstLine('PASS')].join('\n')
  const result = runGate({ comments: [apiComment(prefixed, '2026-10-21T12:49:00Z')] })
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('; '), /no Verifier report names the tip|no Tip SHA/)
  assert.equal(result.verdict.verdict, null, 'a verdict that is not the first line is not a conclusion')
})

test('#637: hold still refuses through main()', () => {
  const result = runGate({ labels: ['hold'], comments: [apiComment(firstLine('PASS'), '2026-10-21T12:40:00Z')] })
  assert.equal(result.ok, false)
  assert.equal(result.held, true)
})

test('#637: a review body in the fixed format is judged the same as a comment', () => {
  const result = runGate({ comments: [], reviews: [apiReview(firstLine('PASS'), '2026-10-21T12:40:00Z')] })
  assert.equal(result.ok, true)
  assert.equal(result.verdict.by, 'reviewer-agent')
})

// ---- #639: the pull_request run reports and never fails; the queue entry still refuses.
test('#639: a report names what the entry would refuse and still passes', () => {
  const noVerdict = judgeAt({ mode: 'report', reports: [] })
  assert.equal(noVerdict.ok, true, 'a report never fails')
  assert.match(noVerdict.reasons.join('; '), /no Verifier report names the tip/)
  assert.equal(noVerdict.mode, 'report')

  const held = judgeAt({ mode: 'report', labels: ['hold'] })
  assert.equal(held.ok, true)
  assert.match(held.reasons.join('; '), /`hold` label/)

  const inc = judgeAt({ mode: 'report', reports: [say(report({ verdict: 'INC' }))] })
  assert.equal(inc.ok, true)
  assert.match(inc.reasons.join('; '), /INC/)

  // The same inputs at the queue entry keep their old meaning: no conclusion refuses.
  assert.equal(judgeAt({ mode: 'queue', reports: [] }).ok, false)
  assert.equal(judgeAt({ mode: 'queue', labels: ['hold'] }).ok, false)
  assert.equal(judgeAt({ mode: 'queue', reports: [say(report({ verdict: 'INC' }))] }).ok, false)
})

test('#639: the pull_request entry point reports without a head_ref and does not throw', () => {
  const policy = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policy, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [] }))
  const result = main({
    gh: fakeGh({ comments: [apiComment(report({ verdict: 'INC' }), '2026-10-21T12:49:00Z')] }),
    env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policy, MODE: 'report', PR: '639' },
    repo: 'ThinkFlowLab/FlyBot',
  })
  assert.equal(result.ok, true, 'the report passes even when the entry would be refused')
  assert.equal(result.mode, 'report')
  assert.match(result.reasons.join('; '), /INC/)
})

// ---- #640 INC point 2: T0/T1 and the daily release PR need no PASS (AGENTS.md 6).
test('#640: the tier comes from the changed files, and a label never exempts', () => {
  const t1 = judgeAt({ files: ['core/src/client/panel.js'], reports: [] })
  assert.equal(t1.ok, true)
  assert.equal(t1.exempt, true)
  assert.equal(t1.tier, 'T1')
  const t0 = judgeAt({ files: ['docs/subsystems/core-host.md'], reports: [] })
  assert.equal(t0.ok, true)
  assert.equal(t0.tier, 'T0')
  assert.equal(judgeAt({ files: ['core/src/host/turns.js'], reports: [] }).ok, false, 'T2 still needs a PASS')
  assert.equal(judgeAt({ files: [], reports: [] }).ok, false, 'no files is no exemption')

  // A label is a claim, not a fact: every Bot shares one account and a label carries no signature
  // (#627), so `risk:T1` on a T3 diff must still refuse. The tier is computed by the base copy of
  // risk-gate.mjs and its rules, never read off the label.
  const claimed = judgeAt({ files: ['core/src/host/secrets.js'], labels: ['risk:T1'], reports: [] })
  assert.equal(claimed.exempt, false, 'a risk label does not exempt')
  assert.equal(claimed.tier, 'T3')
  assert.equal(claimed.ok, false)
  // hold is not waived by a computed tier either
  assert.equal(judgeAt({ files: ['core/src/client/panel.js'], labels: ['hold'], reports: [] }).ok, false)
})

test('#640: a mechanical release PR passes on its files alone, and only on those', () => {
  const release = ['CHANGELOG.md', 'changelog.d/123-x.fixed.md', 'core/package.json', 'core/package-lock.json', 'patches/ds-bot/0007-version-and-tooling.patch']
  assert.equal(judgeAt({ files: release, reports: [] }).ok, true)
  assert.equal(judgeAt({ files: release, reports: [] }).exempt, true)
  assert.equal(judgeAt({ files: [...release, 'core/src/host/secrets.js'], reports: [] }).ok, false, 'one file outside the list needs a PASS')
  assert.equal(judgeAt({ files: [], reports: [] }).ok, false, 'no files is not a release PR')
})

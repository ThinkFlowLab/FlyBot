// merge-gate: what refuses a queue entry, and the shape of the merge_group workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { judge, prFromHeadRef } from './merge-gate.mjs'
import { guard } from './enqueue-rules.mjs'
import { fileURLToPath } from 'node:url'

const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const ENTRY = `gh-readonly-queue/main/pr-566-${HEAD}`
const policy = { reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }

const report = ({ tip = HEAD, verdict = 'PASS' } = {}) =>
  [`Tip SHA: ${tip}`, 'Written-by: Reviewer', 'Ran:', '  - npm run verify → pass', 'Not run:', '  - smoke — host code unchanged', `Verdict: ${verdict}`].join('\n')

const say = (body = report(), at = '2026-10-21T10:31:00Z', kind = 'comment') => ({ login: 'reviewer-agent', body, at, kind, association: 'MEMBER' })

const judgeAt = (over = {}) => judge({ labels: [], head: HEAD, author: 'opener', reports: [say()], policy, ...over })

test('the queue branch is the only pointer to the pull request', () => {
  assert.deepEqual(prFromHeadRef(ENTRY), { pr: 566, base: HEAD })
  assert.equal(prFromHeadRef('gh-readonly-queue/main/pr-616-81c708d054f43c90fd201ae3a281fd2e8e8916e7').pr, 616)
  assert.equal(prFromHeadRef('refs/heads/main'), null, 'a ref that is not a queue entry names no pull request')
  assert.equal(prFromHeadRef('gh-readonly-queue/main/pr-566-not-a-sha'), null)
  assert.equal(prFromHeadRef(undefined), null)
})

// The real event payload, verbatim from run 39694988559 (the #626 queue entry): GitHub passes the
// queue branch fully qualified. Without this, every entry failed before judging anything.
test('#652 follow-up: a head_ref that carries refs/heads/ still names the queue entry', () => {
  assert.deepEqual(prFromHeadRef(`refs/heads/${ENTRY}`), { pr: 566, base: HEAD })
  assert.deepEqual(prFromHeadRef('refs/heads/gh-readonly-queue/main/pr-652-020490044ccad1551f769f0ee141da218f71c1fd'), {
    pr: 652,
    base: '020490044ccad1551f769f0ee141da218f71c1fd',
  })
  assert.equal(prFromHeadRef('refs/tags/gh-readonly-queue/main/pr-566-' + HEAD), null, 'only a branch ref is a queue entry')
})

test('#655: a queue base that contains slashes still names the pull request', () => {
  assert.deepEqual(prFromHeadRef('gh-readonly-queue/release/1.0/pr-652-abc1234'), { pr: 652, base: 'abc1234' })
  assert.deepEqual(prFromHeadRef('refs/heads/gh-readonly-queue/release/1.0/pr-652-abc1234'), {
    pr: 652,
    base: 'abc1234',
  })
  assert.equal(prFromHeadRef('gh-readonly-queue/release/1.0/pr-652-not-a-sha'), null, 'a multi-segment base does not relax the hex tail')
  assert.equal(prFromHeadRef('gh-readonly-queue//pr-652-abc1234'), null, 'an empty base names no entry')
  assert.equal(prFromHeadRef('gh-readonly-queue/release/1.0/pr-abc1234'), null, 'the tail must carry a PR number')
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

test('a hand run that names a head (--sha) refuses a different live head', () => {
  const r = judgeAt({ head: OLD, expectedHead: HEAD })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /not the expected/)
  assert.equal(judgeAt({ expectedHead: HEAD.slice(0, 12) }).ok, true, 'a short sha names the same head')
})

test('no head sha refuses instead of passing', () => {
  const r = judge({ labels: [], head: '', author: 'a', reports: [say()], policy })
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

// #960 (B): the required merge-gate check now also reads the body and the labels, so the fixtures carry
// a body the guard accepts and the label a routine pull request has; a test overrides either on purpose.
const HEADERS = 'Owner: Reviewer\nReviewer: reviewer-agent\n'
// #1202: the queue entry also reads the checkpoint block, so a fixture body carries one that agrees with
// the body it sits in: same issue, same files, the Bot the Owner: line names.
const checkpointFor = (text, files = [], pr = 637) => {
  const issue = Number((text.match(/^[\s>#-]*(?:fixes|closes)\s*(?:[\w.-]+\/[\w.-]+)?#(\d+)/im) ?? [])[1] ?? 0)
  const owner = (text.match(/^\s*Owner:\s*(\S+)/im) ?? [])[1]
  const fields = {
    pr,
    claim: owner ? owner.replace(/^@/, '').replace(/,$/, '') : 'Reviewer',
    issue,
    summary: 'The queue entry reads the checkpoint and the header lines together. A missing field is refused by name. This fixture keeps the other rules the test of the moment.',
    files: files.length ? files.slice(0, 12) : ['core/src/host/turns.js'],
    checks: { ran: 'node --test .github/scripts/merge-gate.test.mjs', result: 'green', at: HEAD },
    next: 'none — ready for review',
  }
  return ['<!-- flybot:checkpoint -->', '\u0060\u0060\u0060json', JSON.stringify(fields, null, 2), '\u0060\u0060\u0060', '<!-- /flybot:checkpoint -->'].join('\n')
}
const bodyWithCheckpoint = (text, files = [], pr = 637) => (/<!-- flybot:checkpoint -->/.test(text) ? text : `${text}\n${checkpointFor(text, files, pr)}`)
const fakeGh = ({ comments, reviews = [], labels = ['agent-pr'], files = [], head = HEAD, body = null, pr = 637, headRepo = 'ThinkFlowLab/FlyBot', draft = false, merged = false }) => (...args) => {
  const path = args[args.length - 1]
  const text = bodyWithCheckpoint(body ?? `${HEADERS}Fixes #${pr}\n`, files, pr)
  const pull = { head: { sha: head, repo: { full_name: headRepo } }, user: { login: 'opener' }, labels: labels.map((name) => ({ name })), body: text, draft, merged }
  if (path.includes('/files')) return (files ?? []).map((filename) => JSON.stringify({ filename })).join('\n')
  if (path.includes('/comments')) return [comments].flat().map((entry) => JSON.stringify(entry)).join('\n')
  if (path.includes('/reviews')) return [reviews].flat().map((entry) => JSON.stringify(entry)).join('\n')
  if (/\/pulls\/\d+$/.test(path)) return JSON.stringify(pull)
  throw new Error('fake gh: unexpected ' + path)
}

const runGate = (fixture) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policy, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  return main({
  gh: fakeGh(fixture),
  env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policy },
  repo: 'ThinkFlowLab/FlyBot',
  pr: 637,
  headRef: ENTRY,
  })
}

const apiComment = (body, at) => ({ user: { login: 'reviewer-agent' }, body, created_at: at, author_association: 'MEMBER' })
const apiReview = (body, at) => ({ user: { login: 'reviewer-agent' }, body, submitted_at: at, author_association: 'MEMBER' })

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

test('#925: a CONTRIBUTOR review by a repo admin passes the queue entry, and a failed lookup does not', () => {
  const body = firstLine('PASS')
  const pull = JSON.stringify({ head: { sha: HEAD, repo: { full_name: 'ThinkFlowLab/FlyBot' } }, user: { login: 'opener' }, labels: [{ name: 'agent-pr' }], body: bodyWithCheckpoint('Owner: Reviewer\nReviewer: reviewer-agent\nFixes #925\n', ['core/src/host/turns.js'], 925) })
  const review = JSON.stringify({ user: { login: 'reviewer-agent' }, body, submitted_at: '2026-10-24T03:42:31Z', author_association: 'CONTRIBUTOR' })
  const gh = (permission) => (...args) => {
    const path = args[args.length - 1]
    if (path.includes('/permission')) {
      if (permission !== 'admin') throw new Error('404')
      return JSON.stringify({ permission: 'admin', role_name: 'admin' })
    }
    if (path.includes('/files')) return JSON.stringify({ filename: 'core/src/host/turns.js' })
    if (path.includes('/comments')) return ''
    if (path.includes('/reviews')) return review
    if (/\/pulls\/\d+$/.test(path)) return pull
    throw new Error('fake gh: unexpected ' + path)
  }
  const policyPath = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policyPath, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  const env = { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policyPath, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '925' }
  const allowed = main({ gh: gh('admin'), env, repo: 'ThinkFlowLab/FlyBot', pr: 925 })
  assert.equal(allowed.ok, true, allowed.reasons.join('; '))
  assert.equal(allowed.verdict.by, 'reviewer-agent')
  const refused = main({ gh: gh('none'), env, repo: 'ThinkFlowLab/FlyBot', pr: 925 })
  assert.equal(refused.ok, false)
  assert.match(refused.reasons.join('; '), /author association CONTRIBUTOR/)
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
  writeFileSync(policy, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
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

// ---- #654 / run 39701316520: the sha in the queue branch is the entry's BASE, not the pull request
// head. The real values from that run: main's tip d105f22 (#640), the head of #654, and the entry
// commit the queue built (GITHUB_SHA). The old gate compared the head to the base and refused every
// entry ("the pull request head moved to ad0c471666da … built at d105f222847b").
const RUN_REF = 'refs/heads/gh-readonly-queue/main/pr-654-d105f222847b97853728d85406d0727bedeaba93'
const RUN_BASE = 'd105f222847b97853728d85406d0727bedeaba93'
const RUN_HEAD = 'ad0c471666da90e4cbc66752288084fb2d61b71d'
const RUN_ENTRY = 'ee1739effa52cd97a6ec9fa100a28cf3aee7fca1'
// #654's diff touched the host, so it is not exempt: the PASS is what lets it through.
const RUN_FILES = ['core/src/host/turns.js', 'changelog.d/651.fixed.md']

const runQueue = (fixture) => {
  const policyFile = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policyFile, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  // Exactly what merge-gate.yml hands the script on a merge_group run, and no PR number.
  return main({
    // The pull request number comes from HEAD_REF on a queue entry, so the fixture is told which one it is.
    gh: fakeGh({ head: RUN_HEAD, files: RUN_FILES, pr: 654, ...fixture }),
    env: {
      GITHUB_STEP_SUMMARY: '',
      REVIEW_POLICY: policyFile,
      GH_REPO: 'ThinkFlowLab/FlyBot',
      HEAD_REF: RUN_REF,
      BASE_SHA: RUN_BASE,
      ENTRY_SHA: RUN_ENTRY,
      GITHUB_SHA: RUN_ENTRY,
      PR: '',
      MODE: 'queue',
    },
  })
}

test('#654: the queue branch sha is the base, never the head', () => {
  assert.deepEqual(prFromHeadRef(RUN_REF), { pr: 654, base: RUN_BASE })
})

test('#654: a merge_group entry with a PASS at the pull request head passes, through main()', () => {
  const result = runQueue({ comments: [apiComment(firstLine('PASS', RUN_HEAD), '2026-10-22T00:30:00Z')] })
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.head, RUN_HEAD, 'the head judged is the pull request head')
  assert.equal(result.exempt, false, 'a host change still needed its PASS')
  assert.equal(result.verdict.by, 'reviewer-agent')
})

test('#654: the queue entry keeps the policy — no PASS, a PASS at the base, an INC, or hold refuse', () => {
  assert.equal(runQueue({ comments: [] }).ok, false, 'T2 with no conclusion refuses')
  const atBase = runQueue({ comments: [apiComment(firstLine('PASS', RUN_BASE), '2026-10-22T00:30:00Z')] })
  assert.equal(atBase.ok, false, 'a PASS that names the base is not a PASS at the head')
  assert.match(atBase.reasons.join('; '), /not the tip|no Verifier report names the tip/)
  const atEntry = runQueue({ comments: [apiComment(firstLine('PASS', RUN_ENTRY), '2026-10-22T00:30:00Z')] })
  assert.equal(atEntry.ok, false, 'nor does a PASS that names the queue entry commit')
  const inc = runQueue({ comments: [apiComment(firstLine('PASS', RUN_HEAD), '2026-10-22T00:30:00Z'), apiComment(firstLine('INC', RUN_HEAD), '2026-10-22T00:40:00Z')] })
  assert.equal(inc.ok, false)
  assert.match(inc.reasons.join('; '), /INC/)
  const held = runQueue({ labels: ['hold'], comments: [apiComment(firstLine('PASS', RUN_HEAD), '2026-10-22T00:30:00Z')] })
  assert.equal(held.ok, false)
  assert.equal(held.held, true)
})

test('#654: a T1 queue entry passes without a PASS, as the pull_request report says it would', () => {
  const files = ['core/src/client/panel.js']
  const queue = runQueue({ files, comments: [] })
  assert.equal(queue.ok, true, queue.reasons.join('; '))
  assert.equal(queue.tier, 'T1')
  const policyFile = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policyFile, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  const report = main({ gh: fakeGh({ head: RUN_HEAD, files, comments: [] }), env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policyFile, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '654', MODE: 'report' } })
  assert.deepEqual(report.reasons, queue.reasons, 'both events judge the same head the same way')
  assert.equal(report.head, queue.head)
})

test('#654: the workflow hands the script the merge_group base and entry shas', () => {
  const wf = readFileSync(new URL('../workflows/merge-gate.yml', import.meta.url), 'utf8')
  assert.match(wf, /BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/)
  assert.match(wf, /ENTRY_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/)
})

// ---- #660-#663: the reviewer's real PASS reports, verbatim, through the queue's entry point. Their
// merge_group runs (39707184514, 39707395505, 39707549765, 39707707974) all refused with "Birfy's PASS
// lists no command it ran": the commands sit as `$ ` lines in a fenced block under a heading
// `Ran at this tip (…):`, and only a bare `Ran:` was read. The policy is the real review-policy.json.
const REAL = JSON.parse(readFileSync(new URL('./fixtures/review-reports-660-663.json', import.meta.url), 'utf8')).reports
const REAL_POLICY = fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))

const queueReal = (fx, body = fx.comment.body, pullBody) => main({
  gh: (...args) => {
    const path = args[args.length - 1]
    if (path.includes('/files')) return fx.files.map((filename) => JSON.stringify({ filename })).join('\n')
    if (path.includes('/comments')) return JSON.stringify({ user: { login: fx.comment.login }, body, created_at: fx.comment.created_at, author_association: 'OWNER' })
    if (path.includes('/reviews')) return ''
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify({ head: { sha: fx.head, repo: { full_name: 'ThinkFlowLab/FlyBot' } }, user: { login: fx.author }, labels: [{ name: 'agent-pr' }], body: pullBody ?? bodyWithCheckpoint(['Owner: Reviewer', 'Reviewer: Reviewer2', 'Fixes #' + fx.pr, ''].join('\n'), fx.files, fx.pr) })
    throw new Error('fake gh: unexpected ' + path)
  },
  env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: REAL_POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${fx.pr}-c74e1207${'0'.repeat(32)}`, MODE: 'queue' },
})

test('#660-#663: every real PASS lists the command it ran, through main()', () => {
  assert.equal(REAL.length, 4)
  for (const fx of REAL) {
    const result = queueReal(fx)
    assert.equal(result.head, fx.head)
    assert.equal(result.exempt, false, `#${fx.pr} is T2/T3: its PASS is what decides`)
    assert.equal(result.verdict.verdict, 'PASS', `#${fx.pr}`)
    assert.doesNotMatch(result.reasons.join('; '), /lists no command it ran/, `#${fx.pr}`)
    assert.ok(result.verdict.judged.at(-1).parsed.ran.some((c) => /node .*--test/.test(c)), `#${fx.pr}: the $ line is the command`)
  }
})

test('#660: the real PASS, which names what it did not run, passes the queue entry end to end', () => {
  const result = queueReal(REAL.find((fx) => fx.pr === 660))
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.verdict.by, 'Birfy')
})

// Owner decision 2026-10-22 09:57 Asia/Shanghai (#667): "Not run:" is no longer checked, so the three
// reports without one pass as they were written.
test('#660-#663: a PASS from another GitHub login still passes; the author\'s own comment does not (#644)', () => {
  for (const fx of REAL) {
    const result = queueReal(fx)
    assert.equal(result.head, fx.head)
    if (fx.author === fx.comment.login) {
      assert.equal(result.ok, false, `#${fx.pr} is the author's own comment and carries no attestation`)
      assert.match(result.reasons.join('; '), /not an attestation/)
    } else {
      assert.equal(result.ok, true, `#${fx.pr}: ${result.reasons.join('; ')}`)
      assert.equal(result.verdict.by, 'Birfy')
    }
  }
  assert.equal(REAL.filter((fx) => !/^Not run\b/m.test(fx.comment.body)).length, 3, '#661-#663 carry no Not run line')
  assert.equal(REAL.filter((fx) => fx.author === fx.comment.login).map((fx) => fx.pr).join(','), '663')
})

test('#644: #663 passes once the author comment attests a role that is not the Owner', () => {
  const fx = REAL.find((f) => f.pr === 663)
  const body = fx.comment.body.replace('Written-by: Reviewer\n', `Written-by: Reviewer\nAttestation: ${fx.head} role=Reviewer\n`)
  const result = queueReal(fx, body, bodyWithCheckpoint(`Owner: Dev\nReviewer: Reviewer2\nFixes #${fx.pr}\n`, fx.files, fx.pr))
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.verdict.by, 'Birfy')
})

test('#660-#663: the real reports still refuse at the queue on a wrong tip, an INC after them, or hold', () => {
  for (const fx of REAL) {
    const wrongTip = queueReal({ ...fx, head: 'f'.repeat(40) })
    assert.equal(wrongTip.ok, false, `#${fx.pr}: a PASS at another sha is not this head`)
    const inc = fx.comment.body.replace(/^Verdict: PASS at/, 'Verdict: INC at')
    assert.equal(queueReal(fx, inc).ok, false, `#${fx.pr}: INC refuses`)
  }
})

test('#660-#663: the fenced Ran block is evidence only with a $ command, and a T2/T3 PASS still needs one', () => {
  const fx = REAL.find((f) => f.pr === 660)
  const noCommand = fx.comment.body.replace(/^\$ .*$/m, '# (command omitted)')
  const r = queueReal(fx, noCommand)
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /lists no command it ran/)
})

test('#925: admin does not skip the own-author rule, and selfReview does not carry to someone else\'s pull request', () => {
  const own = judge({ labels: [], head: HEAD, author: 'reviewer-agent', reports: [say(report(), '2026-10-24T03:42:31Z', 'comment')], policy, admins: ['reviewer-agent'] })
  assert.equal(own.ok, false, 'admin does not skip the own-author rule')
  assert.match(own.reasons.join('; '), /own author is not a reviewer/)

  const listed = { reviewers: ['reviewer-agent', 'hsliuustc0106'], selfReview: ['hsliuustc0106'], writers: ['Reviewer'] }
  const other = judge({
    labels: [],
    head: HEAD,
    author: 'opener',
    reports: [{ login: 'hsliuustc0106', body: report(), at: '2026-10-24T03:42:31Z', kind: 'comment', association: 'CONTRIBUTOR' }],
    policy: listed,
    admins: [],
  })
  assert.equal(other.ok, false, 'a selfReview login judging someone else\'s pull request is not exempt (#931)')
  assert.match(other.reasons.join('; '), /author association CONTRIBUTOR/)
})

test('#925: a selfReview login with admin on someone else\'s pull request lets the entry through', () => {
  const listed = { reviewers: ['reviewer-agent', 'hsliuustc0106'], selfReview: ['hsliuustc0106'], writers: ['Reviewer'] }
  const other = { login: 'hsliuustc0106', body: report(), at: '2026-10-24T03:42:31Z', kind: 'comment', association: 'CONTRIBUTOR' }
  const refused = judge({ labels: [], head: HEAD, author: 'opener', reports: [other], policy: listed, admins: [] })
  assert.equal(refused.ok, false)
  assert.match(refused.reasons.join('; '), /author association CONTRIBUTOR/)
  const allowed = judge({ labels: [], head: HEAD, author: 'opener', reports: [other], policy: listed, admins: ['hsliuustc0106'] })
  assert.equal(allowed.ok, true, allowed.reasons.join('; '))
  assert.equal(allowed.verdict.by, 'hsliuustc0106')
})

// #943, part 2: the queue entry reads the same `decide`, so a bot account's `Verdict:` refuses the entry
// and a PASS from the shared account at the same tip lets it through.
test('#943: a bot account\'s Verdict: does not let a queue entry through', () => {
  const bot = { login: 'cursor[bot]', body: report(), at: '2026-10-24T07:40:42Z', kind: 'comment', association: 'NONE', type: 'Bot' }
  const refused = judgeAt({ reports: [bot] })
  assert.equal(refused.ok, false)
  assert.match(refused.reasons.join('; '), /bot account/)

  const shared = { login: 'Birfy', body: report(), at: '2026-10-24T07:45:10Z', kind: 'comment', association: 'MEMBER', type: 'User' }
  const r = judge({ labels: [], head: HEAD, author: 'opener', reports: [bot, shared], policy: { ...policy, reviewers: ['Birfy'], selfReview: ['Birfy'] }, expectedHead: HEAD })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// ---- #960 (B): on `merge_group` the required check is `merge-gate` alone (`enqueue-guard` is not one of
// the required contexts today), and it read only `hold` and the newest conclusion. A body with no
// `Owner:`/`Reviewer:`, no `Fixes`, or a pull request with no `agent-pr` could therefore enter main
// through a green check. The fallback calls the guard's own `guard()` for the same pull request; when the
// entry cannot name its pull request it logs one line and lets it through, because a wedged queue is
// worse than a missed judgement.
const passAt = (tip = HEAD, at = '2026-10-24T12:00:00Z') => apiComment(firstLine('PASS', tip), at)
const queueEntry = (fixture = {}) => runGate({ comments: [passAt()], ...fixture })

test('#960: the required check refuses a queue entry whose body has no Owner: line', () => {
  const result = queueEntry({ body: 'Fixes #960\n' })
  assert.equal(result.ok, false, result.reasons.join('; '))
  assert.match(result.reasons.join('; '), /missing line: Owner:/)
})

test('#960: the required check refuses a Reviewer: outside both vocabularies', () => {
  const result = queueEntry({ body: 'Owner: Reviewer\nReviewer: Somebody\nFixes #960\n' })
  assert.equal(result.ok, false, result.reasons.join('; '))
  assert.match(result.reasons.join('; '), /not a reviewers login/)
})

test('#960: the required check refuses a body with no issue reference and a pull request with no agent-pr', () => {
  const noIssue = queueEntry({ body: 'Owner: Reviewer\nReviewer: reviewer-agent\n' })
  assert.equal(noIssue.ok, false, noIssue.reasons.join('; '))
  assert.match(noIssue.reasons.join('; '), /no issue reference/)
  const noLabel = queueEntry({ labels: [] })
  assert.equal(noLabel.ok, false, noLabel.reasons.join('; '))
  assert.match(noLabel.reasons.join('; '), /missing label: agent-pr/)
})

test('#960: an entry whose head_ref names no pull request is recorded and let through, never wedged', () => {
  const result = main({
    gh: () => { throw new Error('fake gh: a ref that names no pull request is never read') },
    env: { GITHUB_STEP_SUMMARY: '' },
    repo: 'ThinkFlowLab/FlyBot',
    headRef: 'gh-readonly-queue/main/not-a-pull-request',
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'no-pull-request')
  assert.match(result.message, /letting the entry through/)
})

test('#960: a pull request the API no longer returns is recorded and let through, never wedged', () => {
  const policyPath = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policyPath, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  const result = main({
    gh: () => { throw new Error('gh: Not Found (HTTP 404)') },
    env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policyPath, GH_REPO: 'ThinkFlowLab/FlyBot', HEAD_REF: ENTRY },
    repo: 'ThinkFlowLab/FlyBot',
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'pull-request-gone')
})

test('#960: the fork flag comes from pull.head.repo, so a fork is not refused for its body', () => {
  // #711/#713: we cannot push to a fork's head and its owner keeps their own workflow there. Reading the
  // fork flag from anywhere but `pull.head.repo.full_name` would refuse every external pull request.
  const foreign = queueEntry({ headRepo: 'someone/FlyBot', body: '', labels: [] })
  assert.equal(foreign.ok, true, foreign.reasons.join('; '))
  const ours = queueEntry({ headRepo: 'ThinkFlowLab/FlyBot', body: '', labels: [] })
  assert.equal(ours.ok, false)
  assert.match(ours.reasons.join('; '), /missing line: Owner:/)
})

test('#960: the pull_request report is unchanged and still never fails on the body', () => {
  const policyPath = join(mkdtempSync(join(tmpdir(), 'merge-gate-policy-')), 'review-policy.json')
  writeFileSync(policyPath, JSON.stringify({ reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }))
  const result = main({
    gh: fakeGh({ body: '', labels: [], comments: [apiComment(firstLine('PASS'), '2026-10-24T12:00:00Z')] }),
    env: { GITHUB_STEP_SUMMARY: '', REVIEW_POLICY: policyPath, MODE: 'report', PR: '960' },
    repo: 'ThinkFlowLab/FlyBot',
    pr: 960,
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'report')
})

// #1272 step 2, acceptance 9. The fixture is the one place three of these sentences are written down:
// `core/test/workflow-repo-dev.test.js` asserts the `repo-dev` preset's gate guards refuse with the
// same words, and neither side imports the other. The readers pinned here are `judge` — the function
// merge-gate's required check runs — and `guard`, whose joined reasons are exactly what
// `enqueue-guard` prints after "do not enqueue #N:". Change a sentence on either side and this is red.
const workflowCases = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/workflow-cases.json', import.meta.url)), 'utf8'))

test('#1272 step 2: the workflow fixture sentences are the gate s own, byte for byte', () => {
  assert.ok(workflowCases.cases.length >= 3)
  for (const entry of workflowCases.cases) {
    const reports = entry.gate.reports.map((r) => say([
      `Tip SHA: ${r.tip}`,
      `Written-by: ${r.writtenBy}`,
      'Ran:',
      '  - npm run verify → pass',
      `Verdict: ${r.verdict}`,
    ].join('\n')))
    const result = judge({
      labels: entry.gate.labels,
      head: entry.gate.head,
      author: 'opener',
      reports,
      policy,
      expectedHead: entry.gate.expectedHead ?? undefined,
    })
    assert.ok(result.reasons.includes(entry.sentence), `${entry.id}: judge said ${JSON.stringify(result.reasons)}`)
    // enqueue-guard's REFUSE line is `do not enqueue #N: <reasons joined>`, so the same sentence has to
    // appear there too, for the same input.
    const refused = guard({
      pr: 1272,
      head: entry.gate.head,
      labels: [...entry.gate.labels, 'agent-pr'],
      body: 'Fixes #1272\nOwner: Dev3\nReviewer: Reviewer',
      files: ['core/src/shared/workflow.js'],
      mechanicalRelease: false,
      fork: false,
      draft: false,
      merged: false,
      result,
      reports,
      policy,
    })
    assert.equal(refused.ok, false)
    assert.ok(refused.message.includes(`${entry.sentence}`), `${entry.id}: enqueue-guard said ${refused.message}`)
  }
})

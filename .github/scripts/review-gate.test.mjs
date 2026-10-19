// review-gate: what counts as a reviewed tip, and the shape of the report-only workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, loadPolicy, parseReport, render } from './review-gate.mjs'

const HEAD = 'a4d506a1b2c3d4e5f60718293a4b5c6d7e8f9012'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const policy = { reviewers: ['reviewer-agent', 'hsliuustc0106'] }

const report = ({ tip = HEAD, verdict = 'PASS', ran = ['  - npm run verify → pass'], notRun = true } = {}) =>
  [
    `Tip SHA: ${tip}`,
    'Ran:',
    ...ran,
    ...(notRun ? ['Not run:', '  - smoke — host code unchanged'] : []),
    `Verdict: ${verdict}`,
  ].join('\n')

const comment = (login, body = report(), at = '2026-10-18T01:00:00Z', kind = 'comment') => ({ login, body, at, kind })

test('a PASS by a listed reviewer that names the tip counts', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent')], policy })
  assert.equal(r.ok, true)
  assert.equal(r.by, 'reviewer-agent')
  assert.match(r.reason, /PASS names this tip/)
})

test('a review body counts the same as a comment', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report(), '2026-10-18T01:00:00Z', 'review')], policy })
  assert.equal(r.ok, true)
})

test('a PASS that names an older tip does not count: the tip moved', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ tip: OLD }))], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not the tip/)
})

test('the pull request author does not review their own tip unless listed in selfReview', () => {
  const r = decide({ head: HEAD, author: 'reviewer-agent', reports: [comment('reviewer-agent')], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /own author is not a reviewer/)
  const other = decide({ head: HEAD, author: 'reviewer-agent', reports: [comment('reviewer-agent')], policy: { ...policy, selfReview: ['someone-else'] } })
  assert.equal(other.ok, false, 'selfReview names the authors whose own PASS counts; a different login does not unlock this author')
})

test('self-review: a listed author may PASS their own pull request at the tip (owner decision 2026-10-19)', () => {
  const selfPolicy = { reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'] }
  const r = decide({ head: HEAD, author: 'Birfy', reports: [comment('Birfy')], policy: selfPolicy })
  assert.equal(r.ok, true)
  assert.equal(r.by, 'Birfy')
  assert.equal(decide({ head: HEAD, author: 'birfy', reports: [comment('Birfy')], policy: selfPolicy }).ok, true, 'logins compare case-insensitively')
})

test('self-review keeps every other rule: tip, evidence, listed reviewer, newest wins', () => {
  const selfPolicy = { reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'] }
  const own = (body, at) => comment('Birfy', body, at)
  const run = (reports, policy = selfPolicy) => decide({ head: HEAD, author: 'Birfy', reports, policy })
  assert.equal(run([own(report({ tip: OLD }))]).ok, false, 'a new commit voids the self-PASS')
  assert.equal(run([own(report({ ran: [] }))]).ok, false, 'no Ran: command, no evidence')
  assert.equal(run([own(report({ notRun: false }))]).ok, false, 'no Not run: line, incomplete evidence')
  assert.equal(run([own(report({ verdict: 'FAIL' }))]).verdict, 'FAIL')
  assert.equal(run([own(report(), '2026-10-18T01:00:00Z'), own(report({ verdict: 'FAIL' }), '2026-10-18T02:00:00Z')]).ok, false, 'a later FAIL vetoes a self-PASS')
  assert.equal(run([own(report())], { reviewers: ['reviewer-agent'], selfReview: ['Birfy'] }).ok, false, 'selfReview does not make an unlisted login a reviewer')
  assert.equal(run([comment('reviewer-agent')]).ok, true, 'another listed reviewer still counts on that pull request')
})

test('a PASS from a login outside the policy does not count', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('someone-else')], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not a reviewer listed/)
})

test('the newest report at the tip decides: a later FAIL vetoes an earlier PASS', () => {
  const reports = [
    comment('reviewer-agent', report(), '2026-10-18T01:00:00Z'),
    comment('hsliuustc0106', report({ verdict: 'FAIL' }), '2026-10-18T02:00:00Z'),
  ]
  const r = decide({ head: HEAD, author: 'opencode-agent', reports, policy })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'FAIL')
  assert.match(r.reason, /hsliuustc0106 says FAIL/)
})

test('a later PASS replaces an earlier FAIL at the same tip', () => {
  const reports = [
    comment('reviewer-agent', report({ verdict: 'FAIL' }), '2026-10-18T01:00:00Z'),
    comment('reviewer-agent', report(), '2026-10-18T03:00:00Z'),
  ]
  const r = decide({ head: HEAD, author: 'opencode-agent', reports, policy })
  assert.equal(r.ok, true)
})

test('equal timestamps: the later comment in API order decides', () => {
  const at = '2026-10-18T01:00:00Z'
  const reports = [
    comment('reviewer-agent', report(), at),
    comment('reviewer-agent', report({ verdict: 'FAIL' }), at),
  ]
  const r = decide({ head: HEAD, author: 'opencode-agent', reports, policy })
  assert.equal(r.ok, false, 'the FAIL that came later must not lose to an equal-timestamped PASS')
  assert.equal(r.verdict, 'FAIL')
})

test('INC is not PASS', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ verdict: 'INC' }))], policy })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'INC')
})

test('a PASS that lists no command it ran is not evidence', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ ran: [] }))], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /lists no command it ran/)
})

test('a PASS with no "Not run:" line is incomplete evidence', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ notRun: false }))], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /has no "Not run:" line/)
})

test('no report at all, and no reviewer configured, say so plainly', () => {
  assert.match(decide({ head: HEAD, author: 'a', reports: [], policy }).reason, /no Verifier report names the tip/)
  assert.match(decide({ head: HEAD, author: 'a', reports: [comment('reviewer-agent')], policy: { reviewers: [] } }).reason, /no reviewer is listed/)
})

test('parse: markdown bold, backticked shas and short shas all bind', () => {
  const parsed = parseReport(['**Tip SHA:** `a4d506a`', 'Ran:', '- npm test', 'Not run:', '- smoke', '**Verdict: PASS**'].join('\n'))
  assert.equal(parsed.tip, 'a4d506a')
  assert.equal(parsed.verdict, 'PASS')
  assert.deepEqual(parsed.ran, ['- npm test'])
  assert.equal(parsed.hasNotRun, true)
})

test('parse: one body with two Verifier blocks is judged by the last block', () => {
  const parsed = parseReport([report({ tip: OLD }), '', report({ tip: HEAD, verdict: 'FAIL' })].join('\n'))
  assert.equal(parsed.tip, HEAD)
  assert.equal(parsed.verdict, 'FAIL')
})

test('parse: a body that is not a Verifier report yields nothing to bind', () => {
  const parsed = parseReport('LGTM, merging this')
  assert.equal(parsed.tip, null)
  assert.equal(parsed.verdict, null)
  assert.deepEqual(parsed.ran, [])
})

test('render names the state and keeps the report-only promise', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent')], policy })
  const text = render(r, { pr: 215, head: HEAD, author: 'opencode-agent' })
  assert.match(text, /Reviewed tip: PASS at a4d506a1b2c3/)
  assert.match(text, /Report only \(Phase 1\)/)
})

test('the policy file lists at least one reviewer', () => {
  const p = loadPolicy(new URL('../agent/review-policy.json', import.meta.url))
  assert.ok(Array.isArray(p.reviewers) && p.reviewers.length > 0)
  for (const login of p.reviewers) assert.match(login, /^[\w-]+$/)
  const reviewers = p.reviewers.map((l) => l.toLowerCase())
  for (const login of p.selfReview ?? []) assert.ok(reviewers.includes(login.toLowerCase()), `selfReview ${login} must also be a reviewer`)
})

test('workflow: pull_request, read-only, not required, acts on nothing', () => {
  const wf = readFileSync(new URL('../workflows/review-gate.yml', import.meta.url), 'utf8')
  const testYml = readFileSync(new URL('../workflows/test.yml', import.meta.url), 'utf8')
  const triggers = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\nconcurrency:'))
  const perms = wf.slice(wf.indexOf('\npermissions:\n'), wf.indexOf('\njobs:'))
  assert.match(triggers, /^ {2}pull_request:\s*$/m)
  assert.doesNotMatch(triggers, /pull_request_target/, 'a PR must not run with a write token or secrets')
  assert.doesNotMatch(triggers, /workflow_dispatch|schedule/, 'a tip is judged when it changes, not on a clock')
  assert.match(perms, /^permissions:\n(?: {2}[\w-]+: read\n)+$/m)
  assert.doesNotMatch(perms, /: write/, 'the report never writes')
  const step = wf.slice(wf.indexOf('- name: Judge the tip'))
  assert.match(step, /continue-on-error: true/, 'report only: the judge step is neutral, so the check never turns red')
  assert.doesNotMatch(wf, /gh pr merge|--approve|reviewDecision|gh api .*-X (POST|PATCH|DELETE)/)
  assert.doesNotMatch(testYml, /review-gate/, 'it is not a required check or part of tests-ok')
})

// review-gate: what counts as a reviewed tip, and the shape of the report-only workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, loadPolicy, parseReport, render } from './review-gate.mjs'

const HEAD = 'a4d506a1b2c3d4e5f60718293a4b5c6d7e8f9012'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const policy = { reviewers: ['reviewer-agent', 'hsliuustc0106'], writers: ['Reviewer', 'Chief'] }

const report = ({ tip = HEAD, verdict = 'PASS', ran = ['  - npm run verify → pass'], notRun = true } = {}) =>
  [
    `Tip SHA: ${tip}`,
    'Written-by: Reviewer',
    'Ran:',
    ...ran,
    ...(notRun ? ['Not run:', '  - smoke — host code unchanged'] : []),
    `Verdict: ${verdict}`,
  ].join('\n')

const comment = (login, body = report(), at = '2026-10-18T01:00:00Z', kind = 'comment', association = 'MEMBER') => ({ login, body, at, kind, association })

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
  const selfPolicy = { reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'], writers: ['Reviewer', 'Birfy'] }
  const r = decide({ head: HEAD, author: 'Birfy', reports: [comment('Birfy')], policy: selfPolicy })
  assert.equal(r.ok, true)
  assert.equal(r.by, 'Birfy')
  assert.equal(decide({ head: HEAD, author: 'birfy', reports: [comment('Birfy')], policy: selfPolicy }).ok, true, 'logins compare case-insensitively')
})

test('self-review keeps every other rule: tip, evidence, listed reviewer, newest wins', () => {
  const selfPolicy = { reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'], writers: ['Reviewer', 'Birfy'] }
  const own = (body, at) => comment('Birfy', body, at)
  const run = (reports, policy = selfPolicy) => decide({ head: HEAD, author: 'Birfy', reports, policy })
  assert.equal(run([own(report({ tip: OLD }))]).ok, false, 'a new commit voids the self-PASS')
  assert.equal(run([own(report({ ran: [] }))]).ok, false, 'no Ran: command, no evidence')
  assert.equal(run([own(report({ notRun: false }))]).ok, true, 'no Not run: line is no longer checked (owner decision 2026-10-22)')
  assert.equal(run([own(report({ verdict: 'FAIL' }))]).verdict, 'FAIL')
  assert.equal(run([own(report(), '2026-10-18T01:00:00Z'), own(report({ verdict: 'FAIL' }), '2026-10-18T02:00:00Z')]).ok, false, 'a later FAIL vetoes a self-PASS')
  assert.equal(run([own(report())], { reviewers: ['reviewer-agent'], selfReview: ['Birfy'], writers: ['Reviewer', 'Birfy'] }).ok, false, 'selfReview does not make an unlisted login a reviewer')
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

// Owner decision 2026-10-22 09:57 Asia/Shanghai (#667): "Not run:" is recommended, not checked.
test('a PASS with no "Not run:" line is not refused for it; the Ran command still is', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ notRun: false }))], policy })
  assert.equal(r.ok, true, r.reason)
  const noRan = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', report({ notRun: false, ran: [] }))], policy })
  assert.equal(noRan.ok, false)
  assert.match(noRan.reason, /lists no command it ran/)
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

// #637: the fixed format. The first line is the whole conclusion, so a verdict Chief posts for a
// Reviewer who cannot post (the required proxy case) parses exactly like the Reviewer's own.
test('#637: a first-line verdict carries its own tip and its evidence below parses the same', () => {
  const body = [
    `Verdict: PASS at ${HEAD}`,
    'Written by: Reviewer. Posted by: Chief (proxy — the Reviewer has no write channel).',
    '',
    'Ran: npm run verify → pass',
    'Not run: smoke — host code unchanged',
  ].join('\n')
  const parsed = parseReport(body)
  assert.equal(parsed.tip, HEAD)
  assert.equal(parsed.verdict, 'PASS')
  assert.deepEqual(parsed.ran, ['npm run verify → pass'])
  assert.equal(parsed.hasNotRun, true)
  assert.equal(decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', body)], policy }).ok, true)
})

test('#637: a verdict that is not the first line is not a conclusion', () => {
  const body = ['Verdict (written by Reviewer, posted by Chief)', '', `Verdict: PASS at ${HEAD}`, 'Ran: npm test'].join('\n')
  const result = decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', body)], policy })
  assert.equal(result.ok, false)
  assert.equal(result.verdict, null)
})

// #643: a body that quotes an older verdict at the same tip must not overwrite the first line. Seen
// with an INC whose evidence quoted the PASS it replaced, at the same sha: it parsed as PASS.
test('#643: a quoted verdict later in the body does not overwrite the first line', () => {
  const body = [
    'Verdict: INC at 1234567890abcdef',
    'Written by: Reviewer',
    '',
    'Ran: node --test .github/scripts/review-gate.test.mjs → 40 pass',
    'Not run: smoke',
    '',
    'Earlier, at the same tip, I wrote:',
    'Verdict: PASS at 1234567890abcdef',
  ].join('\n')
  const parsed = parseReport(body)
  assert.equal(parsed.verdict, 'INC', 'the first line is the conclusion')
  assert.equal(parsed.tip, '1234567890abcdef')
  assert.deepEqual(parsed.ran, ['node --test .github/scripts/review-gate.test.mjs → 40 pass'])
  assert.equal(parsed.hasNotRun, true)

  // The old block still parses, and there the last verdict in the block is the one that counts.
  const legacy = ['Tip SHA: 1234567890abcdef', 'Ran:', '  - npm test → pass', 'Not run:', '  - smoke', 'Verdict: INC'].join('\n')
  assert.equal(parseReport(legacy).verdict, 'INC')
})

// #640 INC point 1: the same hole in `out.tip`. A first line that names this tip, plus an older
// report quoted in the body, used to move the tip, so `decide` dropped the INC as "about another
// tip" and the PASS it refused stayed in force.
test('#640: a quoted Tip SHA later in the body does not move the first line to another tip', () => {
  const body = [
    'Verdict: INC at 1234567890abcdef',
    'Written by: Reviewer',
    '',
    'Ran: node --test .github/scripts/review-gate.test.mjs → 43 pass',
    'Not run: smoke',
    '',
    'For comparison, the report this replaces said:',
    'Tip SHA: 99887766554433221100ffeeddccbbaa99887766',
    'Ran:',
    '  - npm test → pass',
    'Not run:',
    '  - smoke',
    'Verdict: PASS',
  ].join('\n')
  const parsed = parseReport(body)
  assert.equal(parsed.verdict, 'INC')
  assert.equal(parsed.tip, '1234567890abcdef', 'the first line names the tip being judged')
  assert.deepEqual(parsed.ran, ['node --test .github/scripts/review-gate.test.mjs → 43 pass'])
  assert.equal(parsed.hasNotRun, true)

  // And the whole point: the INC is not dropped, so it still refuses the merge.
  const head = '1234567890abcdef000000000000000000000000'
  const at = (report, when) => ({ kind: 'comment', login: 'reviewer-agent', body: report, at: when, association: 'MEMBER' })
  const policy = { reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer'] }
  const pass = ['Tip SHA: ' + head, 'Ran:', '  - npm test → pass', 'Not run:', '  - smoke', 'Verdict: PASS'].join('\n')
  const result = decide({
    head,
    author: 'opener',
    reports: [at(pass, '2026-10-21T10:00:00Z'), at(body, '2026-10-21T11:00:00Z')],
    policy,
  })
  assert.equal(result.ok, false, 'the newer INC at this tip refuses')
  assert.equal(result.verdict, 'INC')
})

// ---- #660-#663: the `Ran` heading the reviewer writes, and the fenced `$ ` lines under it.
test('a Ran heading with words before its colon takes the $ lines of the fenced block below it', () => {
  const body = [
    `Verdict: PASS at ${HEAD}`,
    'Written-by: Reviewer',
    '',
    'Ran at this tip (tarball of the tip, nothing patched by hand):',
    '',
    '```text',
    '$ cd plugins/social && node --test "test/*.test.js"',
    '# tests 318 / pass 318 / fail 0',
    '$ npm run lint',
    '```',
    '',
    'Not run: smoke',
  ].join('\n')
  const parsed = parseReport(body)
  assert.deepEqual(parsed.ran, ['cd plugins/social && node --test "test/*.test.js"', 'npm run lint'])
  assert.equal(parsed.hasNotRun, true)
  assert.equal(decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', body)], policy }).ok, true)
})

test('the Ran heading still refuses when it shows no command', () => {
  const at = (...rest) => parseReport([`Verdict: PASS at ${HEAD}`, ...rest, 'Not run: smoke'].join('\n')).ran
  assert.deepEqual(at('Ran:', ''), [], 'an empty Ran:')
  assert.deepEqual(at('Ran: -'), [], 'Ran: -')
  assert.deepEqual(at('Ran at this tip:', '```text', '# tests 1 / pass 1', '```'), [], 'output with no $ line')
  assert.deepEqual(at('Ran at this tip:', '```', '$', '```'), [], 'a bare $')
  assert.deepEqual(at('Ran into a problem: the suite hangs'), [], 'words after a longer heading are not a command')
  assert.deepEqual(at('Ran at this tip:', '- npm test → pass'), ['- npm test → pass'], 'bullets still count under a heading')
  assert.deepEqual(at('Rank: high'), [], '`Ran` must be a whole word')
})

test('#640 still holds with the heading form: a quoted Ran block below does not replace the first one', () => {
  const body = [
    `Verdict: PASS at ${HEAD}`,
    'Written-by: Reviewer',
    'Ran at this tip:',
    '```text',
    '```',
    'Not run: smoke',
    '',
    '> Earlier report:',
    'Ran: npm test → pass',
  ].join('\n')
  assert.deepEqual(parseReport(body).ran, [], 'the conclusion showed no command; a quoted one does not lend it one')
})

test('a Not run heading with words before its colon counts as the Not run section', () => {
  assert.equal(parseReport([`Verdict: PASS at ${HEAD}`, 'Ran: npm test', 'Not run at this tip: smoke'].join('\n')).hasNotRun, true)
})

// ---- #627: every state-changing write says who wrote it. The gate buys presence and a name from a
// closed list (the shared identity means the line is a self-report, not proof — #633), and it refuses
// on two separate grounds so the log says which defect fired.
const unattributed = ({ tip = HEAD, verdict = 'PASS' } = {}) =>
  [`Tip SHA: ${tip}`, 'Ran:', '  - npm run verify → pass', 'Not run:', '  - smoke', `Verdict: ${verdict}`].join('\n')

test('#627: a report with no Written-by line is refused, and the refusal says so', () => {
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', unattributed())], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Written-by line naming its writer/)
})

test('#627: a Written-by naming a writer outside the policy is refused on its own ground', () => {
  const body = [unattributed().split('\n')[0], 'Written-by: Some Other Agent', ...unattributed().split('\n').slice(1)].join('\n')
  const r = decide({ head: HEAD, author: 'opencode-agent', reports: [comment('reviewer-agent', body)], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /Written-by names "Some Other Agent", who is not in the writers list/)
  assert.doesNotMatch(r.reason, /no Written-by line/, 'the two refusals do not collapse into one another')
})

test('#627: the line the relayed conclusion format uses parses to the writer, not to the relay', () => {
  const body = [
    `Verdict: PASS at ${HEAD}`,
    'Written-by: Reviewer',
    'Posted-by: Chief (verbatim relay; Reviewer has no write channel this turn)',
    '',
    'Ran: npm run verify → pass',
    'Not run: smoke',
  ].join('\n')
  const parsed = parseReport(body)
  assert.equal(parsed.writer, 'Reviewer')
  assert.equal(decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', body)], policy }).ok, true)

  // The older prose the repository wrote until #627 reads the same way.
  assert.equal(parseReport(['Verdict: INC at ' + HEAD, 'Written by: Reviewer. Posted by: Chief (proxy).'].join('\n')).writer, 'Reviewer')
  assert.equal(parseReport(['Written-by: reviewer'].join('\n')).writer, 'reviewer', 'the name is returned as written; decide compares case-insensitively')
  assert.equal(decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', [`Tip SHA: ${HEAD}`, 'written-by: reviewer', 'Ran:', '- npm test', 'Verdict: PASS'].join('\n'))], policy }).ok, true)
})

test('#627: a writer named further down does not attribute this report', () => {
  const body = [
    `Verdict: PASS at ${HEAD}`,
    'Ran: npm test → pass',
    'Not run: smoke',
    '',
    'For comparison, the report this replaces began:',
    'Written-by: Reviewer',
  ].join('\n')
  assert.equal(parseReport(body).writer, null)
  const r = decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', body)], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Written-by line/)
})

test('#627: an ordinary comment is not a conclusion, so a missing Written-by line is not held against it', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', 'LGTM, merging this after CI')], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Verifier report names the tip/)
  assert.doesNotMatch(r.reason, /Written-by/)

  // A `Tip SHA:` block with no verdict is no conclusion either, so it demands no attribution.
  const noVerdict = decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', [`Tip SHA: ${HEAD}`, 'Ran: npm test → pass'].join('\n'))], policy })
  assert.doesNotMatch(noVerdict.reason, /Written-by/)

  // And an attributed PASS beside an unattributed ordinary comment still counts.
  const both = decide({
    head: HEAD,
    author: 'opener',
    reports: [comment('reviewer-agent', 'LGTM', '2026-10-18T00:00:00Z'), comment('reviewer-agent', report(), '2026-10-18T01:00:00Z')],
    policy,
  })
  assert.equal(both.ok, true, both.reason)
})

// ---- #676: an invalid conclusion at the tip is still the reviewer's word. Dropping it from the
// newest-word question made a later refusal invisible and left an older PASS in force.
test('#676: a newer INC with no Written-by line vetoes an earlier PASS instead of being skipped', () => {
  const inc = [`Verdict: INC at ${HEAD}`, 'Ran: npm run verify → fail', 'Not run: smoke'].join('\n')
  const r = decide({
    head: HEAD,
    author: 'opener',
    reports: [comment('reviewer-agent', report(), '2026-10-18T01:00:00Z'), comment('reviewer-agent', inc, '2026-10-18T02:00:00Z')],
    policy,
  })
  assert.equal(r.ok, false, 'the newer INC refuses; the PASS it replaced must not survive')
  assert.equal(r.verdict, 'INC')
  assert.match(r.reason, /no Written-by line naming its writer/)
})

test('#676: a newer REQUEST_CHANGES from a login outside the policy still refuses', () => {
  const human = [
    `Verdict: REQUEST_CHANGES at ${HEAD}`,
    'Written-by: Reviewer',
    '',
    'Ran: npm test → pass',
    'Not run: smoke',
  ].join('\n')
  const r = decide({
    head: HEAD,
    author: 'opener',
    reports: [comment('reviewer-agent', report(), '2026-10-18T01:00:00Z'), comment('outside-login', human, '2026-10-18T02:00:00Z')],
    policy,
  })
  assert.equal(r.ok, false, 'a refusal is not swallowed because its author is not a listed reviewer')
  assert.equal(r.verdict, 'REQUEST_CHANGES')
  assert.match(r.reason, /not a reviewer listed/)
})

test('#676: a fixed format after an older invalid conclusion counts — the newest word decides', () => {
  const inc = [`Verdict: INC at ${HEAD}`, 'Ran: npm test → fail'].join('\n')
  const r = decide({
    head: HEAD,
    author: 'opener',
    reports: [comment('reviewer-agent', inc, '2026-10-18T01:00:00Z'), comment('reviewer-agent', report(), '2026-10-18T02:00:00Z')],
    policy,
  })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.verdict, 'PASS')
})

test('#676: a newer PASS with no command it ran still refuses over an older good PASS', () => {
  const r = decide({
    head: HEAD,
    author: 'opener',
    reports: [comment('reviewer-agent', report(), '2026-10-18T01:00:00Z'), comment('reviewer-agent', report({ ran: [] }), '2026-10-18T02:00:00Z')],
    policy,
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /lists no command it ran/)
})

// #676, as narrowed: the fail-closed newest-word rule is for people GitHub ties to this repository.
// Anyone else's `Verdict:` line is not a conclusion, so it can neither pass nor hold a merge.
test('#676: a conclusion from outside the repository counts for nothing', () => {
  const inc = [`Verdict: INC at ${HEAD}`, 'Written-by: Reviewer', '', 'Ran: npm test → fail'].join('\n')
  const outsider = { login: 'passer-by', body: inc, at: '2026-10-18T02:00:00Z', kind: 'comment', association: 'NONE' }
  const r = decide({ head: HEAD, author: 'opener', reports: [comment('reviewer-agent', report(), '2026-10-18T01:00:00Z'), outsider], policy })
  assert.equal(r.ok, true, 'the listed reviewer\'s PASS stands; an outside comment cannot block it')
  assert.equal(r.verdict, 'PASS')

  const solo = decide({ head: HEAD, author: 'opener', reports: [outsider], policy })
  assert.equal(solo.ok, false, 'nor can it pass a tip')
  assert.match(solo.reason, /author association NONE is not OWNER, MEMBER or COLLABORATOR/)

  const missing = decide({ head: HEAD, author: 'opener', reports: [{ login: 'reviewer-agent', body: report(), at: '2026-10-18T01:00:00Z', kind: 'comment' }], policy })
  assert.equal(missing.ok, false, 'an association the API did not send is not assumed')
  assert.match(missing.reason, /author association missing/)
})

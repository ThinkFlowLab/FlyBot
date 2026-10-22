// enqueue-guard (#602): a held pull request, or one whose newest conclusion is not a PASS, is not
// enqueued — and the guard never enqueues anything itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, recordOnlyAt } from './enqueue-guard.mjs'

const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const HOST_FILE = 'core/src/host/turns.js' // T2: needs a PASS
const TEST_FILE = 'core/test/enqueue-guard.test.js' // T1: needs none

const policyFile = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'enqueue-guard-policy-')), 'review-policy.json')
  writeFileSync(path, JSON.stringify({ reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'], writers: ['reviewer-agent', 'Reviewer', 'Birfy'] }))
  return path
}
const POLICY = policyFile()

// The fixed format (#637): the first line is the conclusion, the evidence below it. `Ran:` is what
// makes a PASS evidence rather than a claim (review-gate's rule, reused here).
const report = ({ tip = HEAD, verdict = 'PASS', extra = [] } = {}) =>
  [`Verdict: ${verdict} at ${tip}`, 'Written-by: reviewer-agent', '', 'Ran: npm run verify → pass', 'Not run: smoke', ...extra].join('\n')

// #676: only a comment GitHub ties to this repository can be a conclusion, so the fixture carries the
// association the API sends for the shared `Birfy` account.
const comment = (body = report(), at = '2026-10-21T10:31:00Z') =>
  ({ user: { login: 'reviewer-agent' }, body, created_at: at, author_association: 'MEMBER' })

const fakeGh = ({ body = 'Fixes #602\n', comments = [], reviews = [], labels = ['agent-pr'], files = [], head = HEAD, author = 'opener', headRepo = 'ThinkFlowLab/FlyBot' } = {}) => {
  const calls = []
  const gh = (...args) => {
    const path = args[args.length - 1]
    calls.push(path)
    if (path.includes('/files')) return files.map((f) => JSON.stringify(typeof f === 'string' ? { filename: f } : f)).join('\n')
    if (path.includes('/comments')) return comments.map((c) => JSON.stringify(c)).join('\n')
    if (path.includes('/reviews')) return reviews.map((r) => JSON.stringify(r)).join('\n')
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify({ head: { sha: head, repo: { full_name: headRepo } }, user: { login: author }, body, labels: labels.map((name) => ({ name })) })
    // Anything else — `gh pr merge` above all — is the guard doing more than checking.
    throw new Error('fake gh: unexpected ' + path)
  }
  gh.calls = calls
  return gh
}

const run = (fixture = {}) => main({
  gh: fakeGh({ files: [HOST_FILE], ...fixture }),
  env: { REVIEW_POLICY: POLICY, GH_REPO: fixture.repo ?? 'ThinkFlowLab/FlyBot', PR: '566' },
  repo: fixture.repo ?? 'ThinkFlowLab/FlyBot',
  pr: 566,
})

test('#602: a held pull request is not enqueued, whatever a PASS at its tip says', () => {
  const r = run({ labels: ['hold', 'agent-pr'], comments: [comment()] })
  assert.equal(r.ok, false)
  assert.equal(r.held, true)
  assert.match(r.reasons.join('; '), /`hold` label/)
  // The refusal says what to do ("do not enqueue") and names the hold, so it cannot be read as
  // "the PASS was missing".
  assert.match(r.message, /^do not enqueue #566: .*`hold` label/)
})

test('#602: a PASS at the tip lets it through, and the guard only prints the command', () => {
  const gh = fakeGh({ files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.command, `gh pr merge 566 --auto --squash --match-head-commit ${HEAD}`)
  // No `gh pr merge` was run: the fake throws on any path it does not recognise, and every call here
  // is a read.
  for (const path of gh.calls) assert.match(path, /\/(pulls\/\d+|files|comments|reviews)(\?|$)/)
})

test('#602: no conclusion at the tip refuses', () => {
  const r = run({ comments: [comment('LGTM, merging this')] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no Verifier report names the tip/)
})

test('#602: an INC at the tip refuses even when an older PASS names the same head', () => {
  const r = run({ comments: [comment(report(), '2026-10-21T10:31:08Z'), comment(report({ verdict: 'INC' }), '2026-10-21T11:24:37Z')] })
  assert.equal(r.ok, false)
  assert.equal(r.verdict.verdict, 'INC')
})

test('#602: a PASS naming an older tip does not clear the live head', () => {
  const r = run({ comments: [comment(report({ tip: OLD }))] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /not the tip/)
})

test('#602: a "record only — do not merge" PASS at the head keeps it out of the queue', () => {
  const parked = comment(report({ extra: ['Record only — do not merge / 仅记录、禁止入队'] }))
  const r = run({ comments: [parked] })
  assert.equal(r.ok, false)
  assert.equal(r.recordOnly, true)
  assert.match(r.reasons.join('; '), /record only/)
})

test('#602: the newest conclusion decides, so a fresh PASS supersedes an older parked report', () => {
  const parked = comment(report({ extra: ['Record only — do not merge'] }), '2026-10-21T10:00:00Z')
  const fresh = comment(report(), '2026-10-21T12:00:00Z')
  assert.equal(run({ comments: [parked, fresh] }).ok, true)
  // The same pair the other way round is a fresh freeze over an older PASS: no enqueue.
  const r = run({ comments: [fresh, comment(report({ extra: ['Record only — do not merge'] }), '2026-10-21T13:00:00Z')] })
  assert.equal(r.ok, false)
  assert.equal(r.recordOnly, true)
})

test('#602: the marker on a different tip is not this head', () => {
  const parkedOld = comment(report({ tip: OLD, extra: ['Record only — do not merge'] }), '2026-10-21T10:00:00Z')
  assert.equal(run({ comments: [parkedOld, comment(report(), '2026-10-21T12:00:00Z')] }).ok, true)
  assert.equal(recordOnlyAt([{ body: report({ tip: OLD, extra: ['Record only — do not merge'] }), at: '2026-10-21T10:00:00Z' }], HEAD), null)
})

test('#602: prose that quotes the marker without being a conclusion is not a freeze', () => {
  const note = { user: { login: 'Chief' }, body: 'The routine says "record only — do not merge" when the owner parks one; this one is not parked.', created_at: '2026-10-21T13:00:00Z' }
  assert.equal(recordOnlyAt([note], HEAD), null)
  assert.equal(run({ comments: [comment(report(), '2026-10-21T10:00:00Z'), note] }).ok, true)
})

// The first PASS written for this guard explained the rule and was refused by it: the phrase sat in the
// middle of a bullet, not as a marker. A conclusion that quotes the rule must not freeze itself (#687).
test('#602: a PASS that explains the marker in a sentence does not freeze itself', () => {
  const explaining = [
    'Verdict: PASS at ' + HEAD,
    'Written-by: Reviewer',
    '',
    'Ran: node --test .github/scripts/enqueue-guard.test.mjs',
    '',
    '- `RECORD_ONLY` matches the English marker only. `AGENTS.md` rule 2 pairs `hold` with "Record only — do not merge / 仅记录、禁止入队"; a record written only in Chinese would not keep the pull request out.',
    '- A bullet saying `Record only — do not merge` in the middle of a sentence is not a marker either.',
  ].join('\n')
  assert.equal(recordOnlyAt([{ body: explaining, at: '2026-10-22T06:10:56Z' }], HEAD), null)
  assert.equal(run({ comments: [{ user: { login: 'reviewer-agent' }, body: explaining, created_at: '2026-10-22T06:10:56Z', author_association: 'MEMBER' }] }).ok, true)
})

test('#602: the marker is a whole line, and its other language half is allowed', () => {
  for (const line of ['Record only — do not merge', '- Record only — do not merge', '> Record only — do not merge', '仅记录、禁止入队', 'Record only — do not merge / 仅记录、禁止入队']) {
    assert.ok(recordOnlyAt([{ body: report({ extra: [line] }), at: '2026-10-21T10:00:00Z' }], HEAD), line)
  }
})

test('#602: a T0/T1 pull request still needs no PASS', () => {
  const r = run({ files: [TEST_FILE], comments: [] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.exempt, true)
  assert.equal(r.tier, 'T1')
})

test('#602: hold refuses a T0/T1 pull request too', () => {
  const r = run({ files: [TEST_FILE], labels: ['hold', 'agent-pr'], comments: [] })
  assert.equal(r.ok, false)
  assert.equal(r.held, true)
})

test('#602: the self-gate case (author Birfy, PASS by Birfy) is allowed', () => {
  const r = main({
    gh: fakeGh({
      files: [HOST_FILE],
      author: 'Birfy',
      comments: [{ user: { login: 'Birfy' }, body: report(), created_at: '2026-10-21T10:31:00Z', author_association: 'OWNER' }],
    }),
    env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' },
    repo: 'ThinkFlowLab/FlyBot',
    pr: 566,
  })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #718: a pull request with no issue behind it, or with no `agent-pr` label, is refused before the
// queue: #711/#712/#713 arrived with neither and the guard said nothing, because it only read `hold`,
// the conclusions and the diff. The release PR is the one exception — it has neither by design.
test('#718: a body that names no issue is not enqueued', () => {
  const r = run({ body: '## Summary\n\nTidy up the dock.', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no issue reference in the pull request body: add "Fixes #<n>"/)
  assert.match(r.message, /^do not enqueue #566: /)
})

test('#718: a pull request without the agent-pr label is not enqueued', () => {
  const r = run({ body: 'Fixes #566\n\nthe detail', labels: [], comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing label: agent-pr'), r.reasons.join('; '))
})

test('#718: a Closes reference and the agent-pr label let it through', () => {
  const gh = fakeGh({ body: 'Closes #714\n\nthe detail', labels: ['agent-pr'], files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.command, `gh pr merge 566 --auto --squash --match-head-commit ${HEAD}`)
})

test('#718: a mechanical release pull request needs neither an issue nor the label', () => {
  const r = run({ body: 'Version 0.2.1', labels: [], files: ['changelog.d/999-x.changed.md'], comments: [] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.exempt, true)
  assert.equal(r.mechanicalRelease, true)
})

test('#718: a fork is exempt — its head is not ours to ask for an issue', () => {
  const r = run({ body: '## Summary\n\nTidy up the dock.', labels: [], files: [TEST_FILE], headRepo: 'HugoXK/FlyBot', comments: [] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.fork, true)
  // The same pull request on a branch this repository owns is refused, so the exemption is the fork and
  // not a missing fixture field.
  assert.equal(run({ body: '## Summary\n\nTidy up the dock.', labels: [], files: [TEST_FILE], comments: [] }).ok, false)
})

// The repository name in the API paths is case-insensitive, so the ownership test is too: spelling `--repo`
// in lower case used to turn our own branch into a "fork" and let both rules through (#718 INC).
test('#718: a lower-case --repo spelling does not turn our own branch into a fork', () => {
  const r = run({ body: '## Summary', labels: [], files: [TEST_FILE], repo: 'thinkflowlab/flybot', comments: [] })
  assert.equal(r.fork, false)
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no issue reference/)
  assert.match(r.reasons.join('; '), /missing label: agent-pr/)
})

test('#718: a fork stays exempt under any --repo spelling', () => {
  for (const repo of ['ThinkFlowLab/FlyBot', 'thinkflowlab/flybot']) {
    const r = run({ body: '## Summary', labels: [], files: [TEST_FILE], headRepo: 'HugoXK/FlyBot', repo, comments: [] })
    assert.equal(r.fork, true, repo)
    assert.equal(r.ok, true, repo + ' → ' + r.reasons.join('; '))
  }
})

// The guard is only in the path if the instructions that tell an agent to enqueue name it; otherwise
// the next agent runs `gh pr merge` from memory and #602 is back.
test('#602: the instructions that enqueue point at the guard', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  const fixIssue = readFileSync(new URL('../../.claude/skills/fix-issue/SKILL.md', import.meta.url), 'utf8')
  const plumbing = readFileSync(new URL('../../docs/autonomous-dev.md', import.meta.url), 'utf8')
  for (const text of [agents, fixIssue, plumbing]) assert.match(text, /enqueue-guard\.mjs/)
})

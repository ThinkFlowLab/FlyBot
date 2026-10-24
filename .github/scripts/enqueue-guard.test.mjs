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

// #943: a pull request that may enter the queue says who owns it and who reviews it, in its body.
const HEADERS = 'Owner: Dev\nReviewer: reviewer-agent\n'

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

const fakeGh = ({ body = HEADERS + 'Fixes #602\n', comments = [], reviews = [], labels = ['agent-pr'], files = [], head = HEAD, author = 'opener', headRepo = 'ThinkFlowLab/FlyBot', permission = undefined, draft = false, merged = false } = {}) => {
  const calls = []
  const gh = (...args) => {
    const path = args[args.length - 1]
    calls.push(path)
    if (path.includes('/collaborators/') && path.includes('/permission')) {
      if (permission == null || permission === 'throw') throw new Error('fake gh: permission ' + path)
      return JSON.stringify({ permission, role_name: permission, user: { login: 'reviewed' } })
    }
    if (path.includes('/files')) return files.map((f) => JSON.stringify(typeof f === 'string' ? { filename: f } : f)).join('\n')
    if (path.includes('/comments')) return comments.map((c) => JSON.stringify(c)).join('\n')
    if (path.includes('/reviews')) return reviews.map((r) => JSON.stringify(r)).join('\n')
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify({ head: { sha: head, repo: { full_name: headRepo } }, user: { login: author }, body, labels: labels.map((name) => ({ name })), draft, merged })
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
  assert.match(r.reasons.join('; '), /no issue reference in the pull request body: add "Fixes #<n>" or "Fixes owner\/repo#<n>"/)
  assert.match(r.message, /^do not enqueue #566: /)
})

test('#718: a pull request without the agent-pr label is not enqueued', () => {
  const r = run({ body: 'Fixes #566\n\nthe detail', labels: [], comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing label: agent-pr'), r.reasons.join('; '))
})

test('#718: a Closes reference and the agent-pr label let it through', () => {
  const gh = fakeGh({ body: HEADERS + 'Closes #714\n\nthe detail', labels: ['agent-pr'], files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.command, `gh pr merge 566 --auto --squash --match-head-commit ${HEAD}`)
})

// The branch lives in the code fork now, and the issue stays upstream, so the body names it in full:
// `Fixes ThinkFlowLab/FlyBot#801`. The bare spelling there points at a number the fork does not have, so
// the guard has to accept the qualified one or every fork pull request is refused at the last step.
test('a cross-repository Fixes reference is an issue reference', () => {
  const gh = fakeGh({ body: HEADERS + 'Fixes ThinkFlowLab/FlyBot#801\n\nthe detail', labels: ['agent-pr'], files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('the bare Fixes #<n> spelling still counts next to the cross-repository one', () => {
  const gh = fakeGh({ body: HEADERS + 'Fixes #801\n\nthe detail', labels: ['agent-pr'], files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// The space after the keyword was optional before the cross-repository form existed and stays optional:
// widening the pattern must not quietly drop a spelling that used to count.
test('a Fixes reference with no space before the hash still counts', () => {
  const gh = fakeGh({ body: HEADERS + 'Fixes#801\n\nthe detail', labels: ['agent-pr'], files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// The number alone is not a reference: `Fixes 801` names no issue in either repository.
test('a Fixes line without the hash is not an issue reference', () => {
  const r = run({ body: 'Fixes 801\n\nthe detail', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no issue reference in the pull request body/)
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
const contributor = (login, at = '2026-10-24T03:42:31Z') =>
  ({ user: { login }, body: report(), submitted_at: at, author_association: 'CONTRIBUTOR' })

test('#925: a MEMBER PASS is accepted and does not ask the permission API', () => {
  const gh = fakeGh({ files: [HOST_FILE], comments: [comment()] })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(gh.calls.some((path) => path.includes('/permission')), false)
})

test('#925: a CONTRIBUTOR who is not in selfReview and is not a repo admin is refused', () => {
  for (const permission of ['write', 'throw']) {
    const r = run({ reviews: [contributor('reviewer-agent')], permission })
    assert.equal(r.ok, false, permission)
    assert.match(r.reasons.join('; '), /author association CONTRIBUTOR/)
  }
})

test('#925: a CONTRIBUTOR who has admin on the repo is accepted', () => {
  const r = run({ reviews: [contributor('reviewer-agent')], permission: 'admin' })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.verdict.by, 'reviewer-agent')
})

test('#925: a selfReview login stamped CONTRIBUTOR is accepted on its own pull request without an admin lookup', () => {
  const gh = fakeGh({
    files: [HOST_FILE],
    author: 'Birfy',
    reviews: [contributor('Birfy')],
    permission: 'throw',
  })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.verdict.by, 'Birfy')
  assert.equal(gh.calls.some((path) => path.includes('/permission')), false)
})

test('#925: a selfReview login judging someone else\'s pull request is still refused (#931)', () => {
  const r = run({ author: 'opener', reviews: [contributor('Birfy')], permission: 'throw' })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /author association CONTRIBUTOR/)
})

test('#925: a tier that needs no PASS does not ask the permission API', () => {
  const gh = fakeGh({ files: [TEST_FILE], reviews: [contributor('reviewer-agent')], permission: 'throw' })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.exempt, true)
  assert.equal(gh.calls.some((path) => path.includes('/permission')), false)
})

test('#602: the instructions that enqueue point at the guard', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  const fixIssue = readFileSync(new URL('../../.claude/skills/fix-issue/SKILL.md', import.meta.url), 'utf8')
  const plumbing = readFileSync(new URL('../../docs/autonomous-dev.md', import.meta.url), 'utf8')
  for (const text of [agents, fixIssue, plumbing]) assert.match(text, /enqueue-guard\.mjs/)
})

test('#925: a selfReview login with admin on someone else\'s pull request is accepted, and the lookup is asked once', () => {
  const gh = fakeGh({ files: [HOST_FILE], author: 'opener', reviews: [contributor('Birfy')], permission: 'admin' })
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.verdict.by, 'Birfy')
  assert.ok(gh.calls.includes('repos/ThinkFlowLab/FlyBot/collaborators/Birfy/permission'))
})

// #943, part 1: the two lines the pipeline has been described with everywhere, read before the queue.
// #940 went from opened to merged in about seven minutes with the largest diff of the day and its body
// carried neither line, so the convention was a sentence nothing checked. Both lines present is not
// enough on its own — the Reviewer named has to be someone who may write a conclusion at all.
test('#943: a body with no Owner: line is refused, and the refusal names that line', () => {
  const r = run({ body: 'Reviewer: reviewer-agent\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing line: Owner:'), r.reasons.join('; '))
  assert.equal(r.reasons.some((reason) => /missing line: Reviewer:/.test(reason)), false, 'only the line that is missing is named')
})

test('#943: a body with no Reviewer: line is refused, and the refusal names that line', () => {
  const r = run({ body: 'Owner: Dev\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing line: Reviewer:'), r.reasons.join('; '))
  assert.equal(r.reasons.some((reason) => /missing line: Owner:/.test(reason)), false, 'only the line that is missing is named')
})

test('#943: a Reviewer: naming a login outside `reviewers` is refused, and the refusal names the login', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: someone-else\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('Reviewer names "someone-else", who is not in reviewers'), r.reasons.join('; '))
})

test('#943: an @ and any case are fine on a login `reviewers` lists', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: @Reviewer-Agent, BIRFY\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #941's shape: the body starts with the agent's own HTML comment, so the lines sit on the 4th and 5th
// line, not on the first two. Reading only the first two would refuse every agent pull request.
test('#943: the lines are found in the first 20 lines, not only the first two', () => {
  const r = run({ body: '<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n\n' + HEADERS + 'Fixes #943\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#943: lines after the first 20 do not count', () => {
  const far = 'Fixes #943\n' + 'filler\n'.repeat(19) + HEADERS
  const r = run({ body: far, comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing line: Owner:'), r.reasons.join('; '))
  assert.ok(r.reasons.includes('missing line: Reviewer:'), r.reasons.join('; '))
})

// A draft is not entering the queue, and history is never re-read: the check runs on the enqueue request
// for a live head only, so #940's merged record stays exactly as it is.
test('#943: a draft is not refused by the body check', () => {
  const r = run({ body: 'Fixes #943\n', draft: true, comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #943, part 2: a GitHub bot account writes no conclusion. The shared account every Bot writes as
// (`Birfy`) is a `User` and keeps counting, which is why this is a rule about account type and not a
// login list — a list containing `Birfy` would void the whole pipeline.
test('#943: a Verdict: written by a bot account is not a conclusion here either', () => {
  const bot = { user: { login: 'cursor[bot]', type: 'Bot' }, body: report(), created_at: '2026-10-24T07:40:42Z', author_association: 'NONE' }
  const shared = { user: { login: 'Birfy', type: 'User' }, body: report().replace('reviewer-agent', 'Birfy'), created_at: '2026-10-24T07:45:10Z', author_association: 'MEMBER' }

  const alone = run({ comments: [bot] })
  assert.equal(alone.ok, false)
  assert.match(alone.reasons.join('; '), /cursor\[bot\].*bot account/)
  assert.equal(alone.verdict.judged.find((e) => e.login === 'cursor[bot]').counts, false)

  const both = run({ comments: [bot, shared] })
  assert.equal(both.ok, true, both.reasons.join('; '))
  assert.equal(both.verdict.by, 'Birfy')
})

test('#943: a Reviewer: line with no login names nobody, so it is the missing line', () => {
  const r = run({ body: 'Owner: Dev\nReviewer:\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('missing line: Reviewer:'), r.reasons.join('; '))
})

// #943 INC at 87b49961: this check runs again on every comment (enqueue-guard.yml, `issue_comment`),
// so "a merged pull request is never re-judged" was only true of the code that never read `merged`.
// A sentence on #926/#925/#908 — merged without these lines, their bodies uneditable now — turned
// their check red. A merged pull request is history; only a live request is judged.
test('#943 INC: a merged pull request is not re-judged when a comment arrives', () => {
  const body = 'Fixes #602\n\nthe detail' // no Owner:/Reviewer:, the shape #926/#925/#908 merged with
  const merged = run({ body, merged: true, comments: [comment()] })
  assert.equal(merged.ok, true, merged.reasons.join('; '))
  assert.equal(merged.reasons.some((reason) => /missing line:/.test(reason)), false)
  // The negative control: the same body on an open, non-draft pull request is still refused, so the
  // exemption is `merged` and not a missing fixture field.
  const live = run({ body, comments: [comment()] })
  assert.equal(live.ok, false)
  assert.ok(live.reasons.includes('missing line: Owner:'), live.reasons.join('; '))
  assert.ok(live.reasons.includes('missing line: Reviewer:'), live.reasons.join('; '))
})

// enqueue-guard (#602): a held pull request, or one whose newest conclusion is not a PASS, is not
// enqueued — and the guard never enqueues anything itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frozenRefusal, main, recordOnlyAt } from './enqueue-guard.mjs'
import { checkpointReasons, parseCheckpoint } from './enqueue-rules.mjs'

const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const HOST_FILE = 'core/src/host/turns.js' // T2: needs a PASS
const TEST_FILE = 'core/test/enqueue-guard.test.js' // T1: needs none

// #943: a pull request that may enter the queue says who owns it and who reviews it, in its body.
const HEADERS = 'Owner: Dev\nReviewer: reviewer-agent\n'

// #1202: and it hands over with a checkpoint block. One helper builds the block, so a test can vary one
// field and leave the rest correct — which is the only way "the refusal names the field" is a real
// assertion rather than a match on a message that happened to be there.
const checkpoint = (overrides = {}) => {
  const fields = {
    pr: 566,
    claim: 'Dev',
    issue: 602,
    summary: 'The guard now reads a checkpoint block in the body. It refuses one field at a time and names the field it missed. The block is one JSON object between two HTML comments. Nothing else changed.',
    files: [HOST_FILE],
    checks: { ran: 'node --test .github/scripts/enqueue-guard.test.mjs', result: 'green', at: HEAD },
    next: 'none — ready for review',
    ...overrides,
  }
  return ['<!-- flybot:checkpoint -->', '```json', JSON.stringify(fields, null, 2), '```', '<!-- /flybot:checkpoint -->'].join('\n')
}
const BODY = `${HEADERS}Fixes #602\n\n${checkpoint()}\n`

const policyFile = (overrides = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), 'enqueue-guard-policy-')), 'review-policy.json')
  writeFileSync(path, JSON.stringify({ reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'], writers: ['reviewer-agent', 'Reviewer', 'Reviewer2', 'Birfy', 'Dev', 'Dev2', 'Dev3'], ...overrides }))
  return path
}
const POLICY = policyFile()
// #947: `Birfy` is the one identity every Bot writes as, so it is the login a `writers` Bot name stands
// for. This fixture takes it out of `reviewers`: a Bot name then names nobody who can record a PASS.
const NO_SHARED_LOGIN = policyFile({ reviewers: ['reviewer-agent'] })

// The fixed format (#637): the first line is the conclusion, the evidence below it. `Ran:` is what
// makes a PASS evidence rather than a claim (review-gate's rule, reused here).
const report = ({ tip = HEAD, verdict = 'PASS', extra = [], attest = null } = {}) =>
  [
    `Verdict: ${verdict} at ${tip}`,
    'Written-by: reviewer-agent',
    ...(attest ? [`Attestation: ${tip} role=${attest}`] : []),
    '',
    'Ran: npm run verify → pass',
    'Not run: smoke',
    ...extra,
  ].join('\n')

// #676: only a comment GitHub ties to this repository can be a conclusion, so the fixture carries the
// association the API sends for the shared `Birfy` account.
const comment = (body = report(), at = '2026-10-21T10:31:00Z') =>
  ({ user: { login: 'reviewer-agent', type: 'User' }, body, created_at: at, author_association: 'MEMBER' })

// A body written for one rule still needs a checkpoint, or every test below would fail on the rule it is
// not about. So the fixture appends one that agrees with the body it was given: same issue, same files.
const withCheckpoint = (text, files) => {
  if (/<!-- flybot:checkpoint -->/.test(text)) return text
  const issue = Number((text.match(/^[\s>#-]*(?:fixes|closes)\s*(?:[\w.-]+\/[\w.-]+)?#(\d+)/im) ?? [])[1] ?? 602)
  // Same for the claim: a test that rewrites the Owner: line must not be refused for a claim that no
  // longer matches it — that defect has its own case below.
  const owner = (text.match(/^\s*Owner:\s*(\S+)/im) ?? [])[1]
  const claim = owner ? owner.replace(/^@/, '').replace(/,$/, '') : 'Dev'
  const names = files.map((f) => (typeof f === 'string' ? f : f.filename)).filter(Boolean)
  return `${text}\n${checkpoint({ issue, claim, files: names.length ? names : [HOST_FILE] })}`
}

// #1344/#1354: the fixture also answers the contents read for the frozen list, which is read from `main`
// and never from the pull request's base or head.
const BASE = 'c'.repeat(40)
const FROZEN_PATH = '.github/agent/frozen-branches.json'
const DEFAULT_FROZEN = { branches: ['cursor/'], markers: ['CURSOR_AGENT_PR_BODY'] }
const fakeGh = ({ body = null, raw = false, comments = [], reviews = [], labels = ['agent-pr'], files = [], head = HEAD, heads = null, author = 'opener', headRepo = 'ThinkFlowLab/FlyBot', permission = undefined, draft = false, merged = false, branch = 'dev/fixture', baseSha = BASE, frozen = DEFAULT_FROZEN, prNumber = 566 } = {}) => {
  // `raw` is for the tests about the checkpoint itself: they must be able to hand over a body without one.
  const given = body ?? `${HEADERS}Fixes #602\n`
  const text = raw ? given : withCheckpoint(given, files)
  const calls = []
  let pullReads = 0
  const gh = (...args) => {
    const path = args[args.length - 1]
    calls.push(path)
    if (path.includes('/collaborators/') && path.includes('/permission')) {
      if (permission == null || permission === 'throw') throw new Error('fake gh: permission ' + path)
      return JSON.stringify({ permission, role_name: permission, user: { login: 'reviewed' } })
    }
    if (path.includes('/contents/')) {
      if (frozen === null) throw new Error('fake gh: 404 ' + path)
      return JSON.stringify({ content: Buffer.from(JSON.stringify(frozen)).toString('base64'), encoding: 'base64' })
    }
    if (path.includes('/files')) return files.map((f) => JSON.stringify(typeof f === 'string' ? { filename: f } : f)).join('\n')
    if (path.includes('/comments')) return comments.map((c) => JSON.stringify(c)).join('\n')
    if (path.includes('/reviews')) return reviews.map((r) => JSON.stringify(r)).join('\n')
    if (/\/pulls\/\d+$/.test(path)) {
      // #1112 (c): a run reads the head twice, so the fixture can answer differently the second time.
      const sha = heads ? heads[Math.min(pullReads++, heads.length - 1)] : head
      return JSON.stringify({ head: { sha, ref: branch, repo: { full_name: headRepo } }, base: { sha: baseSha }, user: { login: author }, body: text, labels: labels.map((name) => ({ name })), draft, merged, number: prNumber })
    }
    // Anything else — `gh pr merge` above all — is the guard doing more than checking.
    throw new Error('fake gh: unexpected ' + path)
  }
  gh.calls = calls
  return gh
}

const run = (fixture = {}) => main({
  gh: fakeGh({ files: [HOST_FILE], ...fixture }),
  env: { REVIEW_POLICY: fixture.policy ?? POLICY, GH_REPO: fixture.repo ?? 'ThinkFlowLab/FlyBot', PR: '566' },
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
  for (const path of gh.calls) assert.match(path, /\/(pulls\/\d+|files|comments|reviews|contents\/)/)
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
  const note = { user: { login: 'Chief', type: 'User' }, body: 'The routine says "record only — do not merge" when the owner parks one; this one is not parked.', created_at: '2026-10-21T13:00:00Z' }
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
  assert.equal(run({ comments: [{ user: { login: 'reviewer-agent', type: 'User' }, body: explaining, created_at: '2026-10-22T06:10:56Z', author_association: 'MEMBER' }] }).ok, true)
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

test('#602: the self-gate case (author Birfy, PASS by Birfy) is allowed when the comment attests a role that is not the Owner', () => {
  const r = main({
    gh: fakeGh({
      files: [HOST_FILE],
      author: 'Birfy',
      comments: [{ user: { login: 'Birfy', type: 'User' }, body: report({ attest: 'reviewer-agent' }), created_at: '2026-10-21T10:31:00Z', author_association: 'OWNER' }],
    }),
    env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' },
    repo: 'ThinkFlowLab/FlyBot',
    pr: 566,
  })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#644: the self-gate case with only the author\'s Verdict comment is refused', () => {
  const r = main({
    gh: fakeGh({
      files: [HOST_FILE],
      author: 'Birfy',
      comments: [{ user: { login: 'Birfy', type: 'User' }, body: report(), created_at: '2026-10-21T10:31:00Z', author_association: 'OWNER' }],
    }),
    env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' },
    repo: 'ThinkFlowLab/FlyBot',
    pr: 566,
  })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /not an attestation/)
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
const contributor = (login, at = '2026-10-24T03:42:31Z', body = report()) =>
  ({ user: { login, type: 'User' }, body, submitted_at: at, author_association: 'CONTRIBUTOR' })

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
    reviews: [contributor('Birfy', '2026-10-24T03:42:31Z', report({ attest: 'reviewer-agent' }))],
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

// #947 rewrote both refusal sentences: a value is now looked for in two vocabularies, so the refusal
// says which one it missed instead of claiming `reviewers` is the only list.
test('#943, reworded by #947: a Reviewer: outside both vocabularies is refused and names the word', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: someone-else\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('Reviewer names "someone-else", who is not a reviewers login'), r.reasons.join('; '))
  assert.ok(r.reasons.includes('Reviewer names "someone-else", who is not a writers Bot name'), r.reasons.join('; '))
})

// `Birfy` used to stand here as the second spelling; since #1228 it is the one value neither line may name,
// so the @ and the case are shown on the listed login itself.
test('#943: an @ and any case are fine on a login `reviewers` lists', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: @Reviewer-Agent, REVIEWER-AGENT\nFixes #943\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #947: `Reviewer:` names a workstation, so it speaks the vocabulary of `Written-by:` — the policy's
// `writers` Bot names, which is the only thing our pull requests ever wrote there. #943 compared the
// value against `reviewers` (logins) alone, so `Reviewer: Reviewer2` was refused and #941 could not
// enter the queue at all.
test('#947: a Reviewer: naming a writers Bot name is accepted', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Reviewer2\nFixes #947\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#947: either vocabulary is accepted, with an @ and in any case', () => {
  // `Reviewer: Birfy` and `Reviewer: Reviewer2, Birfy` sat in this list until #1228 made the shared identity
  // a refusal of its own; the cases that keep them out are the `#1228:` ones below.
  for (const line of ['Reviewer: @Reviewer2', 'Reviewer: reviewer', 'Reviewer: reviewer-agent, @REVIEWER2']) {
    const r = run({ body: `Owner: Dev\n${line}\nFixes #947\n`, comments: [comment()] })
    assert.equal(r.ok, true, `${line}: ${r.reasons.join('; ')}`)
  }
})

test('#947: a name in neither vocabulary is refused, and the refusal says which two lists it missed', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Nonexistent\nFixes #947\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('Reviewer names "nonexistent", who is not a reviewers login'), r.reasons.join('; '))
  assert.ok(r.reasons.includes('Reviewer names "nonexistent", who is not a writers Bot name'), r.reasons.join('; '))
})

// Chief's boundary on #947: accepting the Bot vocabulary must not become a way around the list of who
// can record a PASS. A Bot name is the shared `Birfy` account, so it names a reviewer only while that
// account is in `reviewers`; with it gone the name is vocabulary, not a reviewer.
test('#947: a writers Bot name names nobody when the shared account is not a reviewer', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Reviewer2\nFixes #947\n', comments: [comment()], policy: NO_SHARED_LOGIN })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((reason) => /"reviewer2".*writers Bot name.*Birfy/.test(reason)), r.reasons.join('; '))
  // The negative control: the same policy still accepts a real login, so the refusal is about the Bot
  // name and not a fixture that refuses everything.
  const login = run({ body: 'Owner: Dev\nReviewer: reviewer-agent\nFixes #947\n', comments: [comment()], policy: NO_SHARED_LOGIN })
  assert.equal(login.ok, true, login.reasons.join('; '))
})

// One value has to be somebody who can pass, not every value: a Bot name beside a real login is still a
// name the policy lists, and the line still names a reviewer who can record a Verdict.
test('#947: a Bot name beside a real login is accepted even when it names nobody alone', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Reviewer2, reviewer-agent\nFixes #947\n', comments: [comment()], policy: NO_SHARED_LOGIN })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #941's shape: the body starts with the agent's own HTML comment, so the lines sit on the 4th and 5th
// line, not on the first two. Reading only the first two would refuse every agent pull request.
test('#943: the lines are found in the first 20 lines, not only the first two', () => {
  // #1344: the comment text here is any agent HTML comment; the real `CURSOR_AGENT_PR_BODY_*` marker has its own case below.
  const r = run({ body: '<!-- agent-claim: reviewer-agent -->\n\n' + HEADERS + 'Fixes #943\n', comments: [comment()] })
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
  // #1344: the guard's refusal is about this tip, and the bot comment is a note beside the report it voided.
  assert.match(alone.reasons.join('; '), /no Verifier report names the tip/)
  const entry = alone.verdict.judged.find((e) => e.login === 'cursor[bot]')
  assert.equal(entry.counts, false)
  assert.match(String(entry.why), /bot account/)

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

// #951: `Owner:` and `Reviewer:` were read as two independent lines (#943/#950), so a body could name the
// same Bot in both and pass: `Reviewer: Dev` is accepted because `Dev` is a `writers` Bot name (:99-101),
// and nothing compared the values (:84). One Bot owning and reviewing one pull request is the shape #940
// had with no lines at all — the check exists so the queue knows who reviews, not so a word appears twice.
// The comparison is the same normalisation the reviewer side already uses: split on commas, strip a
// leading `@`, lowercase, then compare name by name, so a list that overlaps in either direction refuses.
const selfReviewRefusals = (r) => r.reasons.filter((reason) => /who is also the Owner of this pull request/.test(reason))

test('#951: Owner and Reviewer naming the same Bot is refused, and the reason says it is the Owner', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Dev\nFixes #951\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(selfReviewRefusals(r), ['Reviewer names "dev", who is also the Owner of this pull request'])
})

test('#951: a reviewer that is not the owner is accepted (the check compares the two lines)', () => {
  const r = run({ body: 'Owner: Dev\nReviewer: Reviewer\nFixes #951\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.deepEqual(selfReviewRefusals(r), [])
})

test('#951: overlap in either direction, in a list, or through @ and case is refused', () => {
  for (const header of [
    'Owner: Dev, Dev2\nReviewer: Dev2\n',
    'Owner: Dev\nReviewer: Dev, Reviewer\n',
    'Owner: @Dev\nReviewer: dev\n',
    'Owner: DEV\nReviewer: @dev\n',
  ]) {
    const r = run({ body: header + 'Fixes #951\n', comments: [comment()] })
    assert.equal(r.ok, false, `${header}: ${r.reasons.join('; ')}`)
    assert.equal(selfReviewRefusals(r).length, 1, `${header}: ${r.reasons.join('; ')}`)
  }
  // A list that shares no name with the owner still passes, so the comparison is per name and not per line.
  const ok = run({ body: 'Owner: Dev\nReviewer: Reviewer2, Reviewer\nFixes #951\n', comments: [comment()] })
  assert.equal(ok.ok, true, ok.reasons.join('; '))
})

// `Birfy` is both a `reviewers` login and the one identity every Bot writes as. Until #1228 that made it the
// sharpest fixture for this comparison — each line alone looked valid and only the comparison could refuse
// it; the value is now refused on its own too (:the `#1228:` cases below), so this one pins that the overlap
// refusal is still there beside it, unchanged.
test('#951: a name that is both a login and a writers name is refused on both lines', () => {
  const r = run({ body: 'Owner: Birfy\nReviewer: Birfy\nFixes #951\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(selfReviewRefusals(r), ['Reviewer names "birfy", who is also the Owner of this pull request'])
})

// #943's messages and #950's vocabularies are the same check, not rewritten by this one.
test('#951: the missing-line and vocabulary refusals are unchanged', () => {
  const missing = run({ body: 'Fixes #951\n', comments: [comment()] })
  assert.ok(missing.reasons.includes('missing line: Owner:'), missing.reasons.join('; '))
  assert.ok(missing.reasons.includes('missing line: Reviewer:'), missing.reasons.join('; '))
  const empty = run({ body: 'Owner: Dev\nReviewer:\nFixes #951\n', comments: [comment()] })
  assert.ok(empty.reasons.includes('missing line: Reviewer:'), empty.reasons.join('; '))
  const unknown = run({ body: 'Owner: Dev\nReviewer: Nonexistent\nFixes #951\n', comments: [comment()] })
  assert.ok(unknown.reasons.includes('Reviewer names "nonexistent", who is not a reviewers login'), unknown.reasons.join('; '))
  assert.ok(unknown.reasons.includes('Reviewer names "nonexistent", who is not a writers Bot name'), unknown.reasons.join('; '))
  assert.deepEqual(selfReviewRefusals(unknown), [])
})

// History is not a request: this check runs on every comment, so a merged pull request that names one
// Bot twice must stay exactly as it is (:150, #943 INC at 87b49961).
test('#951: a merged pull request naming one Bot twice is not re-judged', () => {
  const merged = run({ body: 'Owner: Dev\nReviewer: Dev\nFixes #951\n', merged: true, comments: [comment()] })
  assert.equal(merged.ok, true, merged.reasons.join('; '))
  assert.deepEqual(selfReviewRefusals(merged), [])
})

// #951 INC: refusing only an overlap can be switched off by leaving `Owner:` empty — an empty set has
// nothing to overlap with, so `Owner:` + `Reviewer: Dev` was `ok: true`. The line names nobody, which is
// the same defect as a missing line, and the vocabulary is the same `writers` list: an unknown owner name
// made the duplicate check unpassable to reason about ("Owner: Somebody" cleared it too).
test('#951 INC: an Owner: line with no value is the missing line, not an empty overlap', () => {
  for (const body of ['Owner:\nReviewer: Dev\nFixes #951\n', 'Owner:   \nReviewer: Dev\nFixes #951\n', 'Owner: @\nReviewer: Dev\nFixes #951\n']) {
    const r = run({ body, comments: [comment()] })
    assert.equal(r.ok, false, body)
    assert.ok(r.reasons.includes('missing line: Owner:'), `${body}: ${r.reasons.join('; ')}`)
    assert.equal(r.reasons.some((reason) => /who is also the Owner/.test(reason)), false, `${body}: ${r.reasons.join('; ')}`)
  }
})

test('#951 INC: an Owner: name outside the writers vocabulary is refused', () => {
  const r = run({ body: 'Owner: Somebody\nReviewer: Dev\nFixes #951\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('Owner names "somebody", who is not a writers Bot name'), r.reasons.join('; '))
  // The negative control: a name the policy lists as a writers Bot is accepted on the same line.
  const ok = run({ body: 'Owner: Dev3\nReviewer: Reviewer\nFixes #951\n', comments: [comment()] })
  assert.equal(ok.ok, true, ok.reasons.join('; '))
})

// Two different Bots are the normal shape: the rule is "not the same Bot", not "the owner may not be a
// writer" — `Dev` reviewing `Dev3`'s pull request is exactly what the pipeline does every day.
test('#951 INC: a different Bot as reviewer is accepted, writers name or login', () => {
  for (const line of ['Reviewer: Dev', 'Reviewer: Reviewer', 'Reviewer: reviewer-agent', 'Reviewer: Reviewer2, Dev']) {
    const r = run({ body: `Owner: Dev3\n${line}\nFixes #951\n`, comments: [comment()] })
    assert.equal(r.ok, true, `${line}: ${r.reasons.join('; ')}`)
  }
})

test('#951 INC: Reviewer: Dev, Dev is one name and prints one refusal', () => {
  const r = run({ body: 'Owner: Dev3\nReviewer: Dev, Dev\nFixes #951\n', comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  const same = run({ body: 'Owner: Dev\nReviewer: Dev, Dev\nFixes #951\n', comments: [comment()] })
  assert.equal(same.ok, false)
  assert.deepEqual(selfReviewRefusals(same), ['Reviewer names "dev", who is also the Owner of this pull request'])
})

// #962: `Docs` is a team member who opens documentation pull requests, and the `Owner:` line reads the
// `writers` roster (#953) — so that name has to be registered before such a pull request can enter the
// queue. The test reads the real policy, not a fixture: a fixture would keep passing while the file that
// the guard loads on main still refused the name. Registering a name grants no permission: `reviewers` and
// `selfReview` remain the two permission lists.
const REAL_POLICY = fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))

test('#962: Docs is registered in writers; Owner: Docs passes and an unknown owner still fails', () => {
  const policy = JSON.parse(readFileSync(REAL_POLICY, 'utf8'))
  assert.ok(policy.writers.includes('Docs'), 'writers lists Docs')
  const pass = {
    user: { login: 'Birfy', type: 'User' },
    body: [`Verdict: PASS at ${HEAD}`, 'Written-by: Birfy', '', 'Ran: npm run verify → pass', 'Not run: smoke'].join('\n'),
    created_at: '2026-10-24T11:30:00Z',
    author_association: 'COLLABORATOR',
  }
  const ok = run({ body: 'Owner: Docs\nReviewer: Reviewer\nFixes #962\n', comments: [pass], policy: REAL_POLICY })
  assert.equal(ok.ok, true, ok.reasons.join('; '))
  // The negative control on the same policy: the roster is still closed, so an unregistered name is refused.
  const refused = run({ body: 'Owner: Somebody\nReviewer: Reviewer\nFixes #962\n', comments: [pass], policy: REAL_POLICY })
  assert.equal(refused.ok, false)
  assert.ok(refused.reasons.includes('Owner names "somebody", who is not a writers Bot name'), refused.reasons.join('; '))
})


// #1228: the two lines name a workstation, but `reviewers` (logins) and `writers` (Bot names) overlap on
// exactly one value — `Birfy`, the shared identity every Bot writes as. Each line alone looked valid, so a
// body could name no Bot at all and still enter the queue; #1214 merged with `Reviewer: Birfy`. The value is
// refused on either line, with the same normalisation (`@`, case) the two vocabularies already use.
const SHARED_OWNER = 'Owner names "birfy", who is the shared write identity every Bot writes as — name the Bot that claims this pull request'
const SHARED_REVIEWER = 'Reviewer names "birfy", who is the shared write identity every Bot writes as — name the Bot that reviews'
const sharedRefusals = (r) => r.reasons.filter((reason) => /is the shared write identity/.test(reason))

test('#1228: Reviewer: Birfy names no reviewer, and the refusal names the line and the value', () => {
  const r = run({ body: 'Owner: Dev3\nReviewer: Birfy\nFixes #1228\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_REVIEWER])
})

test('#1228: Owner: Birfy claims no owner, and the refusal names the line and the value', () => {
  const r = run({ body: 'Owner: Birfy\nReviewer: Reviewer\nFixes #1228\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_OWNER])
})

test('#1228: two real Bots on the two lines are still accepted', () => {
  for (const body of ['Owner: Dev3\nReviewer: Reviewer\nFixes #1228\n', 'Owner: Dev3\nReviewer: reviewer-agent\nFixes #1228\n']) {
    const r = run({ body, comments: [comment()] })
    assert.equal(r.ok, true, `${body}: ${r.reasons.join('; ')}`)
    assert.deepEqual(sharedRefusals(r), [], `${body}: the rule is about one value, not about the lines`)
  }
})

test('#1228: @ and case are normalised first, so the shared identity is refused once, not twice', () => {
  const r = run({ body: 'Owner: Dev3\nReviewer: @BIRFY\nFixes #1228\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_REVIEWER])
})

test('#1228: one unusable name in a list is enough', () => {
  const r = run({ body: 'Owner: Dev3\nReviewer: Birfy, Reviewer\nFixes #1228\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_REVIEWER])
})

test('#1228: the shared identity on both lines is refused on both, and the overlap refusal is unchanged', () => {
  const r = run({ body: 'Owner: Birfy\nReviewer: Birfy\nFixes #1228\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_OWNER, SHARED_REVIEWER])
  assert.deepEqual(selfReviewRefusals(r), ['Reviewer names "birfy", who is also the Owner of this pull request'])
})

// The checkpoint compares `claim` with the Owner names, so it cannot become the way in: an Owner line that
// names nobody is already refused, and nothing new is added to the block.
test('#1228: the checkpoint cannot become the way in — claim "Birfy" under Owner: Birfy is refused', () => {
  const body = `Owner: Birfy\nReviewer: Reviewer\nFixes #1228\n\n${checkpoint({ claim: 'Birfy', issue: 1228 })}`
  const r = run({ raw: true, body, comments: [comment()] })
  assert.equal(r.ok, false)
  assert.deepEqual(sharedRefusals(r), [SHARED_OWNER])
  assert.equal(r.reasons.some((reason) => /checkpoint field "claim"/.test(reason)), false, 'no new field rule: the Owner line is what refuses it')
})

// ---- #1112: the guard reported a PASS that had not been posted yet, and a re-push could go green again.
// The three cases below are one per failure mode the issue names; each is red on the code before it.

test('#1112: a 7-character prefix is not this tip, even though the head starts with it', () => {
  // The guard went green at 05:09 on a conclusion naming a head that was PASSed at 05:12: a tip that is
  // only a prefix matches every head that begins with it, and the newest one is the tip being judged.
  const r = run({ comments: [comment(report({ tip: HEAD.slice(0, 7) }))] })
  assert.equal(r.ok, false, 'a short tip names no head')
  assert.match(r.reasons.join('; '), /7 characters/)
})

test('#1112: the summary names the comment id the decision used, and a later edit cannot change it', () => {
  const reports = [{ id: 4242, user: { login: 'reviewer-agent', type: 'User' }, body: report(), created_at: '2026-10-21T10:31:00Z', author_association: 'MEMBER' }]
  const r = run({ comments: reports })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.verdict.id, 4242)
  assert.equal(r.verdict.kind, 'comment')
  // The decision holds its own copy: an edit after the read is not a second opinion.
  reports[0].body = report({ verdict: 'INC' })
  assert.equal(r.verdict.verdict, 'PASS')
})

test('#1112: the printed head is the decided head, all 40 characters, and it names the conclusion', () => {
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    run({ comments: [{ id: 77, user: { login: 'reviewer-agent', type: 'User' }, body: report(), created_at: '2026-10-21T10:31:00Z', author_association: 'MEMBER' }] })
  } finally { console.log = log }
  assert.match(lines[0], new RegExp(`head ${HEAD},`), 'the head is printed whole, from the value judged')
  assert.match(lines.join('\n'), /conclusion used: comment 77 by reviewer-agent naming [0-9a-f]{40}/)
})

test('#1112: a head that moves while the comments are read is refused, not judged', () => {
  const later = 'c0ffee00'.repeat(5)
  let thrown = null
  try { run({ comments: [comment()], heads: [HEAD, later] }) } catch (e) { thrown = e }
  assert.ok(thrown, 'the run refuses instead of judging a head nobody will merge')
  assert.match(thrown.message, /head moved during this run/)
})

// #1202: the short checkpoint. One block in the body, seven fields, read at the queue entry. Each refusal
// names the field, because a Bot that has to guess why it was refused starts writing the block to please
// the regex instead of handing its work over.
test('#1202: a complete checkpoint is read as seven fields', () => {
  const parsed = parseCheckpoint(BODY)
  assert.equal(parsed.present, true)
  assert.equal(parsed.error, null)
  assert.deepEqual(Object.keys(parsed.fields).sort(), ['checks', 'claim', 'files', 'issue', 'next', 'pr', 'summary'])
  assert.equal(parsed.fields.pr, 566)
  assert.equal(parsed.fields.claim, 'Dev')
  assert.equal(parsed.fields.issue, 602)
  assert.deepEqual(parsed.fields.files, [HOST_FILE])
  assert.equal(parsed.fields.checks.at, HEAD)
})

test('#1202: a pull request with no checkpoint is refused, and the refusal says where to get one', () => {
  const r = run({ raw: true, comments: [comment()] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /no checkpoint: add the "## Checkpoint" section of \.github\/pull_request_template\.md/)
})

test('#1202: a block that opens and never closes is its own refusal', () => {
  const r = run({ raw: true, body: `${HEADERS}Fixes #602\n\n<!-- flybot:checkpoint -->\n{"pr": 566}`, comments: [comment()] })
  assert.match(r.reasons.join('; '), /checkpoint: the block has no closing <!-- \/flybot:checkpoint -->/)
})

test('#1202: a body that mentions the markers in prose still finds the real block', () => {
  // The pull request that introduced this rule describes it, so its own body says the marker names before
  // it carries them. A substring search read the JSON from that sentence and reported "not valid JSON".
  const prose = `${HEADERS}Fixes #602\n\nWrap the JSON in \u0060<!-- flybot:checkpoint -->\u0060 and \u0060<!-- /flybot:checkpoint -->\u0060, under 1500 characters.\n\n${checkpoint()}`
  const r = run({ raw: true, body: prose, files: [HOST_FILE], comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#1202: a marker inside a sentence is not a marker', () => {
  const inline = `${HEADERS}Fixes #602\n\nsay <!-- flybot:checkpoint --> here\n`
  assert.equal(parseCheckpoint(inline).present, false)
})

test('#1202: a block that is not JSON is refused rather than read as prose', () => {
  const body = `${HEADERS}Fixes #602\n\n<!-- flybot:checkpoint -->\nnot json\n<!-- /flybot:checkpoint -->`
  const r = run({ raw: true, body, comments: [comment()] })
  assert.match(r.reasons.join('; '), /checkpoint: the block is not valid JSON/)
})

test('#1202: each missing or wrong field is refused by name', () => {
  const cases = [
    ['pr', checkpoint({ pr: 999 }), /checkpoint field "pr": says 999, but this is pull request #566/],
    ['claim missing', checkpoint({ claim: '' }), /checkpoint field "claim": name the Bot that wrote this checkpoint/],
    ['claim not the Owner', checkpoint({ claim: 'Dev2' }), /checkpoint field "claim": says "Dev2", but the Owner: line says "dev"/],
    ['issue not closed', checkpoint({ issue: 999 }), /checkpoint field "issue": says #999, but the body closes #602/],
    ['summary empty', checkpoint({ summary: '' }), /checkpoint field "summary": write what changed/],
    ['summary too short', checkpoint({ summary: 'One sentence only. Two here.' }), /checkpoint field "summary": 2 sentences — write 3 to 5/],
    ['summary too long', checkpoint({ summary: 'A. B. C. D. E. F.' }), /checkpoint field "summary": 6 sentences — write 3 to 5/],
    ['summary over the character budget', checkpoint({ summary: ['A sentence.', 'Another sentence.', 'A third sentence.'].join(' ') + ' ' + 'x'.repeat(620) }), /checkpoint field "summary": 6\d\d characters, over the 600/],
    ['files empty', checkpoint({ files: [] }), /checkpoint field "files": list the 1-12 files/],
    ['files not paths', checkpoint({ files: ['core/src/shared/quiet-hours.js and its mirror'] }), /checkpoint field "files": every entry must be a path/],
    ['files not in the diff', checkpoint({ files: ['core/src/nowhere.js'] }), /checkpoint field "files": none of "core\/src\/nowhere.js" is in this pull request's diff/],
    ['checks.result', checkpoint({ checks: { ran: 'npm run verify', result: 'maybe', at: HEAD } }), /checkpoint field "checks.result": write one of green\/red\/none/],
    ['checks.at', checkpoint({ checks: { ran: 'npm run verify', result: 'green', at: HEAD.slice(0, 12) } }), /checkpoint field "checks.at": write the full 40-character tip sha/],
    ['checks.why', checkpoint({ checks: { ran: 'none', result: 'none', at: HEAD } }), /checkpoint field "checks.why": result "none" needs the reason nothing ran/],
    ['next empty', checkpoint({ next: '' }), /checkpoint field "next": say what the next hand is/],
  ]
  for (const [name, block, pattern] of cases) {
    const r = run({ raw: true, body: `${HEADERS}Fixes #602\n\n${block}`, comments: [comment()] })
    assert.equal(r.ok, false, `${name} must refuse`)
    assert.match(r.reasons.join('; '), pattern, name)
  }
})

test('#1202: a block over the 1500-character budget is refused, and the refusal names the size', () => {
  // Every field is individually legal here — a long summary, a long "next", twelve long paths, one of them
  // real — so the only thing wrong is the block as a whole being too big to be a handoff.
  const pads = Array.from({ length: 11 }, (_, i) => `core/test/fixtures/checkpoint-padding-${i}-${'x'.repeat(70)}.test.js`)
  const block = checkpoint({
    summary: [`One change that names ${'detail '.repeat(30)}.`, `A second sentence with ${'more '.repeat(30)}.`, 'A third sentence closes the summary.'].join(' '),
    files: [HOST_FILE, ...pads],
    next: `none — ${'ready for review. '.repeat(14)}`,
  })
  assert.ok(block.length > 1500, `the fixture is over the budget (${block.length})`)
  const r = run({ raw: true, body: `${HEADERS}Fixes #602\n\n${block}`, files: [HOST_FILE], comments: [comment()] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /checkpoint is \d+ characters: it must stay under 1500/)
})

test('#1202: the summary counts sentences as written, so a version number is not three', () => {
  const r = run({ raw: true, comments: [comment()], body: `${HEADERS}Fixes #602\n\n${checkpoint({ summary: 'Bump the pin to v0.2.3 in ds-bot.pin.json. Regenerate patches from the new pin. Keep the tree byte-identical otherwise.' })}` })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#1202: a Chinese summary counts its sentences — `。` ends one with no space after it', () => {
  // `SENTENCE_END` required whitespace after the terminator, so `第一句。第二句。第三句。` counted as one
  // sentence and a Chinese handoff was refused however good the text was (#1210). The full-width forms need
  // no space after them; the ASCII ones still do, or `v0.2.3` would be three sentences.
  const bodies = [
    '第一句说明改了什么。第二句说明边界在哪。第三句说下一步是什么。',
    '第一句说明改了什么！第二句说明边界在哪？第三句说下一步是什么。',
    'The guard reads a block. 它一次只拒一个字段。接下来交给 Reviewer。',
  ]
  for (const summary of bodies) {
    const r = run({ raw: true, comments: [comment()], body: `${HEADERS}Fixes #602\n\n${checkpoint({ summary })}` })
    assert.equal(r.ok, true, `${summary} — ${r.reasons.join('; ')}`)
  }
})

test('#1202: a Chinese summary shorter than three sentences is refused, and the count is read', () => {
  const r = run({ raw: true, comments: [comment()], body: `${HEADERS}Fixes #602\n\n${checkpoint({ summary: '只有一句说明改动。还有一句说明边界。' })}` })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), /checkpoint field "summary": 2 sentences — write 3 to 5/)
})

test('#1202: the format reads a real merged pull request of this repository', () => {
  // The body of #1206, verbatim as GitHub returned it, with the checkpoint it would have carried. A format
  // that cannot read the bodies we actually write is a format nobody will fill in.
  const path = fileURLToPath(new URL('./fixtures/pr-1206-body.md', import.meta.url))
  const body = readFileSync(path, 'utf8')
  const parsed = parseCheckpoint(body)
  assert.equal(parsed.error, null)
  assert.equal(parsed.present, true)
  assert.deepEqual(Object.keys(parsed.fields).sort(), ['checks', 'claim', 'files', 'issue', 'next', 'pr', 'summary'])
  assert.equal(parsed.fields.pr, 1206)
  assert.equal(parsed.fields.claim, 'Dev')
  assert.equal(parsed.fields.issue, 1201)
  assert.equal(parsed.fields.checks.at, 'e719e9fbf7444d0159b8e27ce803d1c1a8ef7617')
  assert.ok(parsed.chars <= 1500)
  // And the guard accepts the whole body: the header lines, the issue reference and the block together.
  const r = main({
    gh: fakeGh({ raw: true, body, files: parsed.fields.files, comments: [comment()] }),
    env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '1206' },
    repo: 'ThinkFlowLab/FlyBot',
    pr: 1206,
  })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#1202: a mechanical release pull request needs no checkpoint', () => {
  const r = run({ raw: true, body: 'Version 0.2.1', labels: [], files: ['changelog.d/999-x.changed.md'], comments: [] })
  assert.equal(r.mechanicalRelease, true)
  assert.equal(r.ok, true, r.reasons.join('; '))
})

test('#1202: a fork needs no checkpoint — nobody there could claim it', () => {
  const r = run({ raw: true, body: '## Summary\n\nTidy up the dock.', labels: [], files: [TEST_FILE], headRepo: 'HugoXK/FlyBot', comments: [] })
  assert.equal(r.fork, true)
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #1335 (#1325): the guard read only the newest `Verdict:` line, so a `Correction from <Bot>:` that
// withdrew the PASS was invisible and the head still read "passed, ready to enqueue". These cases run the
// whole way through `main` — the comment list, `judge`, `decide` and `guard` — because the defect was one
// reader disagreeing with another, not a parse detail.
const correction = ({ by = 'reviewer-agent', tip = HEAD, at = '2026-10-21T11:00:00Z', say = 'is withdrawn' } = {}) =>
  ({ user: { login: 'reviewer-agent', type: 'User' }, body: `Correction from ${by}: the PASS at \`${tip}\` ${say}.\n\nThis is not a second verdict.`, created_at: at, author_association: 'MEMBER' })

test('#1335: a PASS its own writer withdrew does not enter the queue', () => {
  const r = run({ comments: [comment(), correction()] })
  assert.equal(r.ok, false)
  assert.match(r.reasons.join('; '), new RegExp(`the PASS at ${HEAD} was withdrawn by reviewer-agent`))
  assert.match(r.message, /^do not enqueue #566: .*withdrawn by reviewer-agent/)
  // The PASS is still on the pull request: the refusal has to be readable as "withdrawn", not "no PASS".
  assert.doesNotMatch(r.reasons.join('; '), /no Verifier report names/)
})

test('#1335: a withdrawal from a name that wrote no PASS here changes nothing', () => {
  // Dev2 is a `writers` Bot name but wrote no PASS at this tip and is not a `reviewers` login.
  const r = run({ comments: [comment(), correction({ by: 'Dev2' })] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.command, `gh pr merge 566 --auto --squash --match-head-commit ${HEAD}`)
})

test('#1335: a withdrawal naming another tip leaves this tip enqueueable', () => {
  const r = run({ comments: [comment(), correction({ tip: OLD })] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// ---- #1344: the frozen seal. An external agent owns `cursor/` until its write access is settled, and the
// list lives in a JSON document on the BASE branch so the owner can delete it without a code change. It is
// a queue-entry seal, not a permission boundary: a direct push or an admin merge never reads it.
test('#1344: a cursor/ branch is refused at the queue entry even with a well-formed PASS at its tip', () => {
  const r = run({ branch: 'cursor/workflow-1318-c5f8', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('frozen: external agent branch; owner decision pending'), r.reasons.join('; '))
  assert.match(r.message, /^do not enqueue #566: frozen: external agent branch; owner decision pending/)
})

test('#1344: emptying the list on main un-freezes the branch — the seal is removable', () => {
  const frozen = run({ branch: 'cursor/workflow-1318-c5f8', comments: [comment()] })
  assert.equal(frozen.ok, false)
  const released = run({ branch: 'cursor/workflow-1318-c5f8', comments: [comment()], frozen: { branches: [], markers: [] } })
  assert.equal(released.ok, true, 'with nothing listed, the branch is judged like any other: ' + released.reasons.join('; '))
  const absent = run({ branch: 'cursor/workflow-1318-c5f8', comments: [comment()], frozen: null })
  assert.equal(absent.ok, true, 'a base without the file freezes nobody: ' + absent.reasons.join('; '))
})

test('#1344: a body carrying the agent marker is refused on a branch that matches no prefix', () => {
  const r = run({ branch: 'dev/friendly-name', body: '<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n\nFixes #602\n', comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('frozen: external agent branch; owner decision pending'), r.reasons.join('; '))
})

test('#1344: a pull request that edits the frozen list is refused, so it cannot un-freeze itself', () => {
  const r = run({ branch: 'cursor/workflow-1318-c5f8', comments: [comment()], frozen: { branches: [], markers: [] }, files: [HOST_FILE, { filename: FROZEN_PATH, status: 'modified' }] })
  assert.equal(r.ok, false, 'an emptied list inside the pull request is not the list that is read')
  assert.ok(r.reasons.includes('frozen: .github/agent/frozen-branches.json is not editable by a pull request'), r.reasons.join('; '))
})

test('#1344: adding the list is how the seal arrives — an add is not an edit', () => {
  const r = run({ branch: 'dev/1344-user-only-conclusions', comments: [comment()], frozen: null, files: [HOST_FILE, { filename: FROZEN_PATH, status: 'added' }] })
  assert.equal(r.ok, true, r.reasons.join('; '))
})

// #1350: `merged` is history and is answered before anything else. The guard is re-run on every event
// (`labeled` above all), so a merged pull request that edited this file would otherwise go red on a later
// run — the refusal exists to stop a seal being undone, and that merge has already happened.
test('#1350: a merged pull request is not refused, even when its diff edited the frozen list', () => {
  const r = run({ merged: true, files: [HOST_FILE, { filename: FROZEN_PATH, status: 'modified' }], comments: [comment()] })
  assert.equal(r.ok, true, r.reasons.join('; '))
  assert.equal(r.reasons.length, 0)
})

// ---- #1354: which policy, and what names a frozen pull request. #1328 merged through the seal: its base
// (`8d0a99c1`) is older than the seal (`#1348`, `6d1eb0be`), so a base read found no list at all and froze
// nobody, and its branch is an ordinary `dev4/…` one, so a prefix could not have caught it either.
const OLD_BASE = '8d0a99c1'.repeat(5)

test('#1354: the list is read from main, never from the pull request base', () => {
  const gh = fakeGh({ files: [HOST_FILE], branch: 'cursor/workflow-1318-c5f8', comments: [comment()] })
  main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: 'ThinkFlowLab/FlyBot', PR: '566' }, repo: 'ThinkFlowLab/FlyBot', pr: 566 })
  const reads = gh.calls.filter((p) => p.includes('/contents/'))
  assert.ok(reads.length, 'the seal reads its list')
  for (const path of reads) assert.match(path, /\?ref=main$/, 'the list is the policy as it is on main: ' + path)
  for (const path of reads) assert.doesNotMatch(path, new RegExp('ref=' + BASE), 'a base older than the seal has no list and would freeze nobody')
})

test("#1354: #1328's shape — an ordinary dev4/ branch on a base older than the seal is refused by its number", () => {
  const r = run({ prNumber: 1328, branch: 'dev4/1265-step2-one-board', baseSha: OLD_BASE, comments: [comment()] })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.includes('frozen: external agent branch; owner decision pending'), r.reasons.join('; '))
  assert.match(r.message, /^do not enqueue #566: frozen: external agent branch; owner decision pending/)
})

test('#1354: a listed number is answered with no reader at all — the list is an argument, not a fetch', () => {
  const pull = { number: 1346, merged: false, head: { ref: 'dev/whatever' }, body: 'Fixes #1', base: { sha: OLD_BASE } }
  assert.equal(frozenRefusal({ pull, files: [] }), 'frozen: external agent branch; owner decision pending')
  assert.equal(frozenRefusal({ pull: { ...pull, number: 566 }, files: [], list: { branches: [], markers: [] } }), null)
  assert.equal(frozenRefusal({ pull: { ...pull, number: 566 }, files: [], list: { branches: ['dev/whatever'], markers: [] } }), 'frozen: external agent branch; owner decision pending')
})

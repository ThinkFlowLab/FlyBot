// agent-audience (#911): the check reads the two lines a pull request body must carry and the calls
// written after its current tip, and reports where they disagree. The first case replays the real
// #907 record: the body of that pull request carried neither line, and the review rounds called
// `@Reviewer` three times while the declared reviewer (in the team chat) was Reviewer2. Those calls
// were written in the delivery group rather than on the pull request, which is why the replay feeds
// them as comment bodies; the live run sees only the GitHub comments, and reports the missing lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluate, loadPolicy, main, mentionsIn, parseDeclarations, rosterOf } from './agent-audience.mjs'

const policy = loadPolicy()
const TIP = '0c7b33a7b817eddc2c15c7edaeb20eca9f938c85'
const TIP_AT = '2026-10-24T01:27:48Z'

// The first lines of the real #907 body: no `Owner:`/`Reviewer:` anywhere.
const BODY_907 = `Written-by: Dev3

Fixes #904

A guest's copy of a linked room now lists the host's Bots and shows the room's group notice.`

// The three rounds that called `@Reviewer` for #907, at the times the group recorded them.
const callsTo907 = [
  { id: 9101, createdAt: '2026-10-24T01:27:56Z', body: '@Reviewer 请按 `0c7b33a7` 判' },
  { id: 9102, createdAt: '2026-10-24T01:28:30Z', body: '@Reviewer 这张归你判，不是 Reviewer2' },
  { id: 9103, createdAt: '2026-10-24T01:29:10Z', body: '@Reviewer 等结论' },
]

const pr907 = { number: 907, body: BODY_907, headSha: TIP }

test('#911: the #907 record is two findings — no declared reviewer, and three calls to @Reviewer', () => {
  const reports = evaluate({ pr: pr907, comments: callsTo907, policy, tipCommittedAt: TIP_AT })
  assert.deepEqual(reports, [
    '#907 @0c7b33a: pull request body has no `Owner:` and `Reviewer:` line',
    '#907 @0c7b33a: 3 calls to @Reviewer after this tip (comment 9101, 9102, 9103), but the body names no `Reviewer:`',
  ])
})

test('#911: negative control — the declared reviewer being called produces no finding', () => {
  const body = `Owner: Dev3\nReviewer: Reviewer2\n\nFixes #904\nTip SHA: ${TIP}`
  const comments = [
    { id: 9201, createdAt: '2026-10-24T01:28:00Z', body: '@Reviewer2 please judge `0c7b33a7`' },
    { id: 9202, createdAt: '2026-10-24T01:28:40Z', body: 'Written-by: Reviewer2 — running the suite now' },
  ]
  assert.deepEqual(evaluate({ pr: { number: 904, body, headSha: TIP }, comments, policy, tipCommittedAt: TIP_AT }), [])
})

test('#911: a call written before the current tip belongs to the tip it was written for', () => {
  const body = `Owner: Dev3\nReviewer: Reviewer2`
  const before = [{ id: 9301, createdAt: '2026-10-24T00:10:00Z', body: '@Reviewer old round' }]
  assert.deepEqual(evaluate({ pr: { number: 5, body, headSha: TIP }, comments: before, policy, tipCommittedAt: TIP_AT }), [])
})

test('#911: Chief is the escalation exit, not a wrong call', () => {
  const body = `Owner: Dev3\nReviewer: Reviewer2`
  const comments = [{ id: 9401, createdAt: '2026-10-24T01:30:00Z', body: '@Chief this PR has waited four rounds' }]
  assert.deepEqual(evaluate({ pr: { number: 5, body, headSha: TIP }, comments, policy, tipCommittedAt: TIP_AT }), [])
})

test('#911: a name outside the review policy is its own finding', () => {
  const body = `Owner: Dev3\nReviewer: Reviewer3`
  const reports = evaluate({ pr: { number: 5, body, headSha: TIP }, comments: [], policy, tipCommittedAt: TIP_AT })
  assert.deepEqual(reports, ['#5 @0c7b33a: Reviewer: names `Reviewer3`, which is not in the review-policy roster'])
})

test('#911: @Reviewer2 is not read as @Reviewer, and the body lines are matched whole', () => {
  assert.deepEqual(mentionsIn('@Reviewer2 please judge', new Set(['Reviewer', 'Reviewer2'])), ['Reviewer2'])
  assert.deepEqual(mentionsIn('cite @Reviewer.example in text', new Set(['Reviewer'])), [])
  assert.deepEqual(parseDeclarations('Owner: Dev2\nReviewer: Reviewer2'), { owner: 'Dev2', reviewer: 'Reviewer2' })
  // Prose that quotes the requirement does not satisfy it.
  assert.deepEqual(parseDeclarations('Write `Owner: Dev2` and `Reviewer: Reviewer2` in the body'), { owner: undefined, reviewer: undefined })
  assert.deepEqual(parseDeclarations('Owner: Dev2 and Reviewer: Reviewer2 on one line'), { owner: undefined, reviewer: undefined })
})

test('#911: the roster is the policy file, not a second list', () => {
  const roster = rosterOf(policy)
  for (const name of ['Chief', 'Dev2', 'Reviewer2', 'Birfy']) assert.ok(roster.has(name), name)
  assert.equal(roster.has('Reviewer3'), false)
})

// A fake `gh` over recorded API answers, the way label-hygiene.mjs is tested.
const fakeGh = (answers) => {
  const calls = []
  const gh = (...args) => {
    calls.push(args.join(' '))
    const path = args[args.length - 1]
    const key = Object.keys(answers).find(prefix => path.startsWith(prefix))
    if (!key) throw new Error(`unexpected gh call: ${args.join(' ')}`)
    const value = answers[key]
    return typeof value === 'function' ? value(args) : value
  }
  gh.calls = calls
  return gh
}

test('#911: the run prints one line per finding and exits success by design', () => {
  const gh = fakeGh({
    'repos/x/y/pulls/907': JSON.stringify({ number: 907, body: BODY_907, head: { sha: TIP } }),
    'repos/x/y/issues/907/comments': callsTo907.map(c => JSON.stringify({ id: c.id, body: c.body, created_at: c.createdAt })).join('\n'),
    'repos/x/y/commits/': `${TIP_AT}\n`,
  })
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    const result = main({ gh, env: {}, repo: 'x/y', pr: '907', policy })
    assert.equal(result.ok, true)
    assert.equal(result.reports.length, 2)
  } finally {
    console.log = original
  }
  assert.match(lines[0], /^#907 @0c7b33a: /)
  assert.match(lines.at(-1), /2 finding\(s\) on 1 pull request\(s\); report only/)
})

// #912: this check passed on its own pull request while reading nothing. The workflow checked the
// script out of `main`, where it does not exist yet, `node` could not load it, and `continue-on-error`
// turned that crash into a green check -- a check that passes without reading is the failure this job
// exists to report. It now reads the script from the base commit (a pull request must not swap the
// checker that audits it) and falls back to the pull request for the run that introduces it. Either
// half disappearing turns this red, so the guard names both.
test('#911: the workflow cannot pass without having read the checker', () => {
  const yml = readFileSync(new URL('../workflows/agent-audience.yml', import.meta.url), 'utf8')
  assert.match(yml, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/)
  assert.match(yml, /if: hashFiles\('base\/\.github\/scripts\/agent-audience\.mjs'\) == ''/)
  assert.match(yml, /dir="pr"/)
  assert.match(yml, /node "\$dir\/\.github\/scripts\/agent-audience\.mjs"/)
  assert.doesNotMatch(yml, /node \.github\/scripts\/agent-audience\.mjs/)
  assert.doesNotMatch(yml, /^\s+ref: main$/m)
})

// The T0/T1 queue trigger (#3248): a T0/T1 pull request needs no verdict, so no `pass` label ever
// appears and nothing starts its queue entry — every one of them waits for a person to press the
// button. These tests pin the decision function only: fixtures in, one decision out, no network and
// no `gh`. One test per refusal, because each refusal is a promise that this trigger will not press
// the button in that shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SELF_PATHS, decidePull, guardMode, renderSummary, resolveMode } from './auto-queue-t1.mjs'

const REPO = 'ThinkFlowLab/FlyBot'
const HEAD = '4a1c2d3e4f5061728394a5b6c7d8e9f001122334'

const pr = (over = {}) => ({
  number: 4001,
  draft: false,
  labels: ['agent-pr'],
  base: { ref: 'main' },
  head: { sha: HEAD, repo: { full_name: REPO } },
  user: { login: 'HugoXK' },
  ...over,
})

const checks = (over = {}) => [
  { name: 'tests-ok', conclusion: 'success', head_sha: HEAD },
  { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
  { name: 'enqueue-guard', conclusion: 'success', head_sha: HEAD },
  ...over.extra ?? [],
]

const files = (...names) => names.map((filename) => ({ filename, additions: 3, deletions: 0, patch: '+ a\n' }))

// The command this trigger is allowed to run, and the only one: no `--admin`, no force, pinned tip.
const COMMAND = `gh pr merge 4001 --auto --squash --match-head-commit ${HEAD}`

const decide = (over = {}) => decidePull({
  repo: REPO,
  pr: pr(),
  files: files('docs/subsystems/team.md'),
  tier: 'T0',
  checks: checks(),
  queued: false,
  gateFiles: ['.github/scripts/merge-gate.mjs', 'policy/'],
  ...over,
})

test('#3248: a T0 pull request with green checks is enqueued, with the runbook command', () => {
  const r = decide()
  assert.equal(r.action, 'enqueue')
  assert.equal(r.command, COMMAND, 'the command is the runbook one: --auto --squash, pinned to the tip')
  assert.equal(r.sha, HEAD)
  assert.equal(r.tier, 'T0')
})

test('#3248: a T1 pull request (changelog fragment) is enqueued the same way', () => {
  const r = decide({ pr: pr({ number: 4002 }), files: files('changelog.d/3248.added.md'), tier: 'T1' })
  assert.equal(r.action, 'enqueue')
  assert.equal(r.command, COMMAND.replace('4001', '4002'))
})

test('#3248: a T2 change is refused — a reviewer judges it, not this trigger', () => {
  const r = decide({ tier: 'T2', files: files('plugins/timeline/client.js') })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /T2/)
  assert.match(r.reason, /reviewer/)
  assert.equal(r.command, undefined, 'a refusal carries no command')
})

test('#3248: a T3 change is refused for the same reason', () => {
  const r = decide({ tier: 'T3', files: files('.github/scripts/enqueue-rules.mjs') })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /T3/)
  assert.equal(r.command, undefined)
})

test('#3248: a draft is refused', () => {
  const r = decide({ pr: pr({ draft: true }) })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'the pull request is a draft')
})

test('#3248: the hold label is refused, and it is refused before any other reason is read', () => {
  const r = decide({ pr: pr({ labels: ['agent-pr', 'hold'] }), tier: 'T3' })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'the hold label is set')
})

// The trusted head is the conjunction the owner asked for: `head repo == HugoXK/FlyBot` AND
// `author == HugoXK`. Three directions, because each single half alone is a head this trigger must not
// start: our own fork is started, a stranger's fork is refused, and our fork's name under another
// author is refused.
test("#3248: the team's own fork is started when the head repository and the author both match", () => {
  const r = decide({
    pr: pr({ head: { sha: HEAD, repo: { full_name: 'HugoXK/FlyBot' } }, user: { login: 'HugoXK' } }),
  })
  assert.equal(r.action, 'enqueue')
  assert.equal(r.command, COMMAND)
})

test("#3248: a stranger's fork is refused, naming the repository and its author", () => {
  const r = decide({ pr: pr({ head: { sha: HEAD, repo: { full_name: 'someone/FlyBot' } }, user: { login: 'someone' } }) })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /fork/)
  assert.match(r.reason, /someone\/FlyBot/)
  assert.equal(r.command, undefined)
})

test('#3248: the trusted fork repository name under another author is refused, and the reason names both halves', () => {
  const r = decide({
    pr: pr({ head: { sha: HEAD, repo: { full_name: 'HugoXK/FlyBot' } }, user: { login: 'elsewhere' } }),
  })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /not HugoXK/)
  assert.match(r.reason, /both match/)
  assert.equal(r.command, undefined)
})

test('#3248: a pull request whose head repository is gone is refused, not assumed local', () => {
  const r = decide({ pr: pr({ head: { sha: HEAD, repo: null } }) })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /fork/)
})

test('#3248: a base other than main is refused', () => {
  const r = decide({ pr: pr({ base: { ref: 'dev/integration' } }) })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'the base is not main (dev/integration)')
})

test('#3248: tests-ok missing at the head is refused, naming the sha', () => {
  const r = decide({ checks: checks().filter((c) => c.name !== 'tests-ok') })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /tests-ok has not reported at 4a1c2d3e/)
})

test('#3248: tests-ok green on another head does not count', () => {
  const r = decide({
    checks: [
      { name: 'tests-ok', conclusion: 'success', head_sha: 'ffffffffffffffffffffffffffffffffffffffff' },
      { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
    ],
  })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /tests-ok has not reported at 4a1c2d3e/)
})

test('#3248: a red tests-ok is refused, naming the conclusion', () => {
  const r = decide({
    checks: [
      { name: 'tests-ok', conclusion: 'failure', head_sha: HEAD },
      { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
    ],
  })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'tests-ok is failure at 4a1c2d3e')
})

test('#3248: a pending tests-ok is refused', () => {
  const r = decide({
    checks: [
      { name: 'tests-ok', conclusion: null, status: 'in_progress', head_sha: HEAD },
      { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
    ],
  })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'tests-ok is in progress at 4a1c2d3e')
})

test('#3248: merge-gate has to be green at the head too', () => {
  const r = decide({ checks: checks().filter((c) => c.name !== 'merge-gate') })
  assert.equal(r.action, 'refuse')
  assert.match(r.reason, /merge-gate has not reported/)

  const red = decide({
    checks: [
      { name: 'tests-ok', conclusion: 'success', head_sha: HEAD },
      { name: 'merge-gate', conclusion: 'failure', head_sha: HEAD },
    ],
  })
  assert.equal(red.reason, 'merge-gate is failure at 4a1c2d3e')
})

test('#3248: enqueue-guard, when it exists at the head, must be green', () => {
  const r = decide({
    checks: [...checks().filter((c) => c.name !== 'enqueue-guard'), { name: 'enqueue-guard', conclusion: 'failure', head_sha: HEAD }],
  })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'enqueue-guard is failure at 4a1c2d3e')
})

test('#3248: a newer re-run decides — a stale failure does not outvote the run that fixed it', () => {
  const r = decide({
    checks: [
      { name: 'tests-ok', conclusion: 'failure', head_sha: HEAD, started_at: '2026-11-20T01:00:00Z', id: 11 },
      { name: 'tests-ok', conclusion: 'success', head_sha: HEAD, started_at: '2026-11-20T02:00:00Z', id: 12 },
      { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
    ],
  })
  assert.equal(r.action, 'enqueue')
})

test('#3248: and a newer failure outvotes an older success at the same head', () => {
  const r = decide({
    checks: [
      { name: 'tests-ok', conclusion: 'success', head_sha: HEAD, started_at: '2026-11-20T01:00:00Z', id: 12 },
      { name: 'tests-ok', conclusion: 'failure', head_sha: HEAD, started_at: '2026-11-20T02:00:00Z', id: 11 },
      { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
    ],
  })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'tests-ok is failure at 4a1c2d3e')
})

test('#3248: enqueue-guard absent is not a refusal — the body is judged at the queue entry', () => {
  const r = decide({ checks: checks().filter((c) => c.name !== 'enqueue-guard') })
  assert.equal(r.action, 'enqueue')
})

test('#3248: a changed gate file is refused, even when the tier says T0', () => {
  const r = decide({ files: files('policy/gates.json'), tier: 'T0' })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'changed file is a gate file: policy/gates.json')
})

test('#3248: a change to this trigger script is refused', () => {
  const r = decide({ files: files('.github/scripts/auto-queue-t1.mjs'), tier: 'T0' })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'changed file is this trigger: .github/scripts/auto-queue-t1.mjs')
})

test('#3248: a change to this workflow is refused', () => {
  const r = decide({ files: files('.github/workflows/auto-queue-t1.yml'), tier: 'T0' })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'changed file is this trigger: .github/workflows/auto-queue-t1.yml')
})

test('#3248: a pull request already in the merge queue is left alone', () => {
  const r = decide({ queued: true })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'already in the merge queue')
  assert.equal(r.command, undefined)
})

test('#3248: no decision can carry an admin or force flag', () => {
  const all = [
    decide(),
    decide({ tier: 'T2' }),
    decide({ queued: true }),
    decide({ files: files('core/client.js'), tier: 'T1' }),
  ]
  for (const r of all) {
    assert.equal(r.command === undefined ? 'none' : r.command.replace(/\s+/g, ' '), r.command === undefined ? 'none' : r.command)
    if (r.command !== undefined) {
      assert.doesNotMatch(r.command, /admin/, 'no admin flag, ever')
      assert.doesNotMatch(r.command, /force|--no-verify/, 'no force flag, ever')
      assert.match(r.command, /^gh pr merge \d+ --auto --squash --match-head-commit [0-9a-f]{40}$/)
    }
  }
  assert.deepEqual(SELF_PATHS, ['.github/scripts/auto-queue-t1.mjs', '.github/workflows/auto-queue-t1.yml'])
})

test('#3248: mode is report unless the switch says execute', () => {
  assert.equal(resolveMode({}), 'report', 'a checkout with no switch presses nothing')
  assert.equal(resolveMode({ variable: 'execute' }), 'execute')
  assert.equal(resolveMode({ variable: ' EXECUTE ' }), 'execute')
  assert.equal(resolveMode({ variable: 'yes' }), 'report', 'an unknown value fails closed')
  assert.equal(resolveMode({ input: 'execute' }), 'execute', 'a dispatch may ask for one executing run')
  assert.equal(resolveMode({ input: 'report', variable: 'execute' }), 'report', 'the dispatch input wins')
  assert.equal(resolveMode({ input: '', variable: 'execute' }), 'execute')
})

test('#3248: the summary says would enqueue in report mode and enqueued in execute mode', () => {
  const allow = decide({ pr: pr({ number: 4001 }) })
  const refuse = decide({ pr: pr({ number: 4002 }), tier: 'T2', files: files('plugins/timeline/client.js') })
  const rows = [allow, refuse]

  const report = renderSummary({ mode: 'report', rows })
  assert.match(report, /auto-queue-t1 — report mode/)
  assert.match(report, /- #4001 \(T0, 4a1c2d3e\): would enqueue — `gh pr merge 4001 --auto --squash --match-head-commit 4a1c2d3e4f5061728394a5b6c7d8e9f001122334`/)
  assert.match(report, /- #4002 \(T2, 4a1c2d3e\): refused — tier T2 is judged by a reviewer/)
  assert.match(report, /auto-queue-t1: mode=report would-enqueue=1 refused=1/)

  const execute = renderSummary({ mode: 'execute', rows })
  assert.match(execute, /- #4001 \(T0, 4a1c2d3e\): enqueued — `gh pr merge 4001/)
  assert.match(execute, /auto-queue-t1: mode=execute enqueued=1 refused=1/)
})

test('#3248: a round that decided nothing still writes one line a reader can grep', () => {
  const text = renderSummary({ mode: 'report', rows: [] })
  assert.match(text, /auto-queue-t1: mode=report would-enqueue=0 refused=0/)
})

test('#3248: a snapshot can be reported on but never acted from', () => {
  assert.equal(guardMode({}), 'report')
  assert.equal(guardMode({ mode: 'report', snapshot: true }), 'report')
  assert.equal(guardMode({ mode: 'execute', snapshot: false }), 'execute')
  assert.throws(() => guardMode({ mode: 'execute', snapshot: true }), /report-only/)
})

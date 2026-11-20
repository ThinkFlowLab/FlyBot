// The T0/T1 queue trigger (#3248): a T0/T1 pull request needs no verdict, so no `pass` label ever
// appears and nothing starts its queue entry — every one of them waits for a person to press the
// button. These tests pin the decision function only: fixtures in, one decision out, no network and
// no `gh`. One test per refusal, because each refusal is a promise that this trigger will not press
// the button in that shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  // The whole command, in order: the two enqueues carry the runbook line and the two refusals carry
  // nothing. Comparing the string itself is what makes the `doesNotMatch` checks below mean something —
  // a command that arrived reformatted, or a refusal that arrived with a command, fails here (#3253).
  assert.deepEqual(all.map((r) => r.command), [COMMAND, undefined, undefined, COMMAND])
  for (const r of all) {
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
// The write path (#3253)
//
// `act()` is the only code here that presses anything, and until this section nothing exercised it. The
// CLI is driven end to end with a stand-in `gh` first on PATH: it answers the reads from the environment
// and records every argv, so these tests spawn a process but never reach GitHub, never need a token and
// never write into the checkout. Execute mode is the live path — a snapshot is refused there by design —
// so the pull request, its files and its checks are fixtures served by the same stand-in.
const script = fileURLToPath(new URL('./auto-queue-t1.mjs', import.meta.url))

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1" in
  api)
    case "$*" in
      *graphql*) printf '%s\\n' "$GH_QUEUE"; exit 0 ;;
      *"/pulls?state=open"*) printf '%s\\n' "$GH_PULLS"; exit 0 ;;
      *"/files"*) printf '%s\\n' "$GH_FILES"; exit 0 ;;
      *"/check-runs"*) printf '%s\\n' "$GH_CHECKS"; exit 0 ;;
      *"/pulls/"*) printf '%s\\n' "$GH_HEAD"; exit 0 ;;
    esac
    exit 0 ;;
  pr) [ -n "$GH_MERGE_ERR" ] && { printf '%s\\n' "$GH_MERGE_ERR" >&2; exit 1; }; exit 0 ;;
  workflow) [ -n "$GH_DISPATCH_ERR" ] && { printf '%s\\n' "$GH_DISPATCH_ERR" >&2; exit 1; }; exit 0 ;;
esac
exit 0
`

const pullJson = () => JSON.stringify({
  number: 4001,
  draft: false,
  labels: [{ name: 'agent-pr' }],
  base: { ref: 'main' },
  head: { sha: HEAD, repo: { full_name: REPO } },
  user: { login: 'HugoXK' },
})

const CHECKS = [
  { name: 'tests-ok', conclusion: 'success', head_sha: HEAD },
  { name: 'merge-gate', conclusion: 'success', head_sha: HEAD },
  { name: 'enqueue-guard', conclusion: 'success', head_sha: HEAD },
]

// One call to the real CLI with a stand-in `gh` on PATH. `writes()` is the only part of the argv record
// a decision may act on; the reads above it are served from the environment.
function roundWith({ head = HEAD, mergeErr = '', dispatchErr = '' } = {}, { mode = 'execute' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-queue-t1-gh-'))
  const log = join(dir, 'calls.log')
  const summary = join(dir, 'summary.md')
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(log, '')
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    GH_LOG: log,
    GH_HEAD: head,
    GH_PULLS: pullJson(),
    GH_FILES: JSON.stringify({ filename: 'changelog.d/3248.added.md', additions: 3, deletions: 0 }),
    GH_CHECKS: JSON.stringify(CHECKS[0]) + '\n' + JSON.stringify(CHECKS[1]) + '\n' + JSON.stringify(CHECKS[2]),
    GH_QUEUE: '{"data":{"repository":{"pullRequest":{"mergeQueueEntry":null}}}}',
    GITHUB_STEP_SUMMARY: '',
  }
  if (mergeErr) env.GH_MERGE_ERR = mergeErr
  if (dispatchErr) env.GH_DISPATCH_ERR = dispatchErr
  const run = spawnSync(process.execPath, [script, '--mode', mode, '--repo', REPO, '--summary', summary], { encoding: 'utf8', env })
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  const writes = () => calls().filter((line) => line.startsWith('pr merge') || line.startsWith('workflow run'))
  return { run, dir, summary, calls, writes, text: run.stdout }
}

test('#3253: execute mode writes one merge and one dispatch, and the argv is verbatim', () => {
  const { run, dir, calls, writes, text } = roundWith()
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(writes(), [
      `pr merge 4001 --auto --squash --match-head-commit ${HEAD}`,
      'workflow run test.yml --ref main',
    ], 'exactly two writes: the merge, then the dispatch')
    assert.match(writes()[0], /--match-head-commit [0-9a-f]{40}$/, 'the tip is pinned, whole')
    assert.doesNotMatch(writes()[0], /--admin|--force|--no-verify/, 'no admin flag and no force flag, ever')
    assert.ok(calls().includes(`api repos/${REPO}/pulls/4001 --jq .head.sha`), 'the head is re-read before the merge')
    assert.match(text, /- #4001 \(T1, 4a1c2d3e\): enqueued/)
    assert.match(text, /auto-queue-t1: mode=execute enqueued=1 refused=0/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3253: a head that moved after the decision writes nothing and is dropped, not chased', () => {
  const later = 'ffffffffffffffffffffffffffffffffffffffff'
  const { run, dir, writes, text } = roundWith({ head: later })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(writes(), [], 'the head is re-read, the merge is not sent')
    assert.match(text, /: moved — the head moved to ffffffff after the decision; the next round decides again/)
    assert.match(text, /auto-queue-t1: mode=execute enqueued=0 refused=0 moved=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3253: "already queued to merge" is success, and the round neither retries nor dispatches twice', () => {
  const { run, dir, writes, text } = roundWith({ mergeErr: 'GraphQL: This pull request is already queued to merge.' })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.equal(writes().filter((line) => line.startsWith('pr merge')).length, 1, 'one attempt, no retry')
    assert.equal(writes().filter((line) => line.startsWith('workflow run')).length, 1, 'one dispatch for one enqueue')
    assert.match(text, /: enqueued/)
    assert.match(text, /auto-queue-t1: mode=execute enqueued=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3253: a failed dispatch is reported in the summary, and the merge still counts', () => {
  const { run, dir, writes, text } = roundWith({ dispatchErr: 'HTTP 403: Resource not accessible by integration' })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.match(text, /: enqueued/, 'the merge landed')
    assert.match(text, /Could not dispatch `Test` on main \(HTTP 403: Resource not accessible by integration\)/)
    assert.equal(writes().filter((line) => line.startsWith('workflow run')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3253: report mode presses nothing, not even the head re-read or a dispatch', () => {
  const { run, dir, writes, text } = roundWith({}, { mode: 'report' })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(writes(), [], 'no write of any kind')
    assert.match(text, /- #4001 \(T1, 4a1c2d3e\): would enqueue/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3253: the round prints the summary to stdout, byte for byte what it writes to the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-queue-t1-out-'))
  const snapshot = join(dir, 'snapshot.json')
  const file = join(dir, 'summary.md')
  const step = join(dir, 'step-summary.md')
  const pull = {
    pr: { number: 4002, draft: false, labels: ['agent-pr'], base: { ref: 'main' }, head: { sha: HEAD, repo: { full_name: REPO } }, user: { login: 'HugoXK' } },
    files: [{ filename: 'plugins/timeline/client.js', additions: 3, deletions: 0 }],
    checks: [],
    queued: false,
  }
  writeFileSync(snapshot, JSON.stringify({ repo: REPO, pulls: [pull] }))
  try {
    // A read-only round: the snapshot path presses nothing, so no `gh` is needed and nothing is touched.
    const run = spawnSync(process.execPath, [
      script, '--snapshot', snapshot, '--mode', 'report', '--repo', REPO, '--summary', file,
    ], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: step } })
    assert.equal(run.status, 0, run.stderr)
    const written = readFileSync(file, 'utf8')
    assert.equal(run.stdout, written, 'the log line is the file line')
    assert.equal(readFileSync(step, 'utf8'), written, 'the step summary is the same text')
    assert.match(run.stdout, /auto-queue-t1: mode=report would-enqueue=0 refused=1/)
    assert.match(run.stdout, /#4002 \(T2, 4a1c2d3e\): refused — tier T2 is judged by a reviewer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A failed press (#3257)
//
// A press that fails leaves the round with nothing else to say: `enqueued=0`, so no dispatch follows,
// and the summary is the only record. Until this section it printed the command it had just sent —
// answering "why did this fail?" with "here is what I sent" — while the reason `act()` already held in
// `row.reason` never reached the page. Slice B on `#3254` measured it as byte-identical on the base and
// on the tip, so it is pinned here in both readers: the pure renderer and the CLI's real stdout.
test('#3257: a failed row prints the reason even when it also carries the command', () => {
  const row = {
    number: 4001,
    tier: 'T1',
    sha: HEAD,
    action: 'failed',
    reason: 'HTTP 500: Internal Server Error',
    command: COMMAND,
  }
  const text = renderSummary({ mode: 'execute', rows: [row] })
  assert.match(text, /- #4001 \(T1, 4a1c2d3e\): failed — HTTP 500: Internal Server Error/)
  assert.doesNotMatch(
    text,
    /failed — `gh pr merge/,
    'a failed row that answers with the command it sent tells the reader nothing about the failure',
  )
  assert.match(text, /auto-queue-t1: mode=execute enqueued=0 refused=0 failed=1/)
})

test('#3257: the other four row shapes keep their exact text', () => {
  const rows = [
    { number: 4001, tier: 'T0', sha: HEAD, action: 'enqueue', command: COMMAND },
    { number: 4002, tier: 'T2', sha: HEAD, action: 'refuse', reason: 'tier T2 is judged by a reviewer' },
    {
      number: 4003,
      tier: 'T0',
      sha: HEAD,
      action: 'moved',
      reason: 'the head moved to ffffffff after the decision; the next round decides again',
    },
  ]
  const text = renderSummary({ mode: 'execute', rows })
  assert.ok(
    text.includes(`- #4001 (T0, 4a1c2d3e): enqueued — \`${COMMAND}\``),
    'an enqueued row still carries the command it ran',
  )
  assert.ok(text.includes('- #4002 (T2, 4a1c2d3e): refused — tier T2 is judged by a reviewer'))
  assert.ok(
    text.includes(
      '- #4003 (T0, 4a1c2d3e): moved — the head moved to ffffffff after the decision; the next round decides again',
    ),
  )
  const report = renderSummary({ mode: 'report', rows })
  assert.ok(report.includes(`- #4001 (T0, 4a1c2d3e): would enqueue — \`${COMMAND}\``))
})

test('#3257: a merge the API refused reaches stdout and the summary file with its reason', () => {
  const { run, dir, writes, summary, text } = roundWith({ mergeErr: 'HTTP 500: Internal Server Error' })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(
      writes(),
      [`pr merge 4001 --auto --squash --match-head-commit ${HEAD}`],
      'one attempt, and no dispatch: nothing was enqueued',
    )
    assert.match(text, /- #4001 \(T1, 4a1c2d3e\): failed — HTTP 500: Internal Server Error/)
    assert.doesNotMatch(text, /failed — `gh pr merge/, 'the log line is the reason, not the command it sent')
    assert.match(text, /auto-queue-t1: mode=execute enqueued=0 refused=0 failed=1/)
    assert.equal(readFileSync(summary, 'utf8'), text, 'the file a reader opens says the same thing as the log')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

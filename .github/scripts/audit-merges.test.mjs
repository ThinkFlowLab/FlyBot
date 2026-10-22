// audit-merges: a merge counts as a queue merge only when the gate itself passed on the commit that
// landed (#689). The fixtures carry one commit/PR/run set per shape; the walk is driven from them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { audit, auditCommit, classify, exitCodeFor, main, queueRun, sinceDate } from './audit-merges.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/audit-merges/${name}.json`, import.meta.url), 'utf8'))
const one = (name) => {
  const f = fixture(name)
  return auditCommit({ sha: f.sha, pulls: f.pulls, runs: f.runs })
}

test('a green Merge gate run on the landed commit is a queue merge, and prints nothing', () => {
  const finding = one('queued')
  assert.equal(finding.ok, true)
  assert.equal(finding.pr, 674)
  assert.equal(exitCodeFor([]), 0)
})

// The whole check exists because of this shape: #680 landed as 6b9820bb while the gate refused that
// entry, and the entry's `Test` run was still green. Reading "some merge_group run succeeded" would
// call the bypass a queue merge, which is why the run is matched by workflow.
test('a failed Merge gate run on the landed commit is a bypass, even when Test of the same entry is green', () => {
  const f = fixture('bypassed')
  assert.equal(queueRun(f.sha, f.runs), null, 'the green Test run of the same entry is not the gate passing')
  const finding = auditCommit({ sha: f.sha, pulls: f.pulls, runs: f.runs })
  assert.equal(finding.ok, false)
  assert.equal(finding.line, `bypassed queue: #680 ${f.sha.slice(0, 12)} (merge_group: failure)`)
  assert.equal(exitCodeFor([finding]), 1)
})

test('a merge the gate never judged says absent, not failure', () => {
  const finding = one('absent')
  assert.equal(finding.line, `bypassed queue: #622 ${fixture('absent').sha.slice(0, 12)} (merge_group: absent)`)
})

test('a push that came from no pull request is its own defect, not a bypass', () => {
  const f = fixture('direct')
  const finding = auditCommit({ sha: f.sha, pulls: f.pulls, runs: f.runs })
  assert.equal(finding.line, `direct commit: ${f.sha}`)
  assert.doesNotMatch(finding.line, /bypassed queue/)
})

test('a green gate run on a different commit says nothing about this one', () => {
  const f = fixture('queued')
  const other = { ...f.runs[0], head_sha: 'ab'.repeat(20) }
  const finding = auditCommit({ sha: f.sha, pulls: f.pulls, runs: [other] })
  assert.equal(finding.line, `bypassed queue: #674 ${f.sha.slice(0, 12)} (merge_group: absent)`)
})

test('a gate run that did not conclude success (cancelled) is a failure', () => {
  const f = fixture('queued')
  const cancelled = { ...f.runs[0], conclusion: 'cancelled' }
  const finding = auditCommit({ sha: f.sha, pulls: f.pulls, runs: [cancelled] })
  assert.equal(finding.line, `bypassed queue: #674 ${f.sha.slice(0, 12)} (merge_group: failure)`)
})

test('the walk prints one line per merge that did not go through the queue, in commit order', () => {
  const queued = fixture('queued')
  const bypassed = fixture('bypassed')
  const direct = fixture('direct')
  const bySha = new Map([queued, bypassed, direct].map((f) => [f.sha, f]))
  const paths = []
  const api = (path) => {
    paths.push(path)
    if (path === 'repos/o/r/commits?sha=main&per_page=50') return [queued, bypassed, direct].map((f) => ({ sha: f.sha }))
    const pulls = /^repos\/o\/r\/commits\/([0-9a-f]+)\/pulls\?per_page=100$/.exec(path)
    if (pulls) return bySha.get(pulls[1]).pulls
    const runs = /^repos\/o\/r\/actions\/runs\?event=merge_group&head_sha=([0-9a-f]+)&per_page=100$/.exec(path)
    if (runs) return { total_count: bySha.get(runs[1]).runs.length, workflow_runs: bySha.get(runs[1]).runs }
    throw new Error(`unexpected path ${path}`)
  }
  const lines = []
  const errors = []
  const [log, error] = [console.log, console.error]
  console.log = (line) => lines.push(line)
  console.error = (line) => errors.push(line)
  let result
  try {
    result = main({ api, repo: 'o/r' })
  } finally {
    console.log = log
    console.error = error
  }
  assert.deepEqual(lines, [
    `bypassed queue: #680 ${bypassed.sha.slice(0, 12)} (merge_group: failure)`,
    `direct commit: ${direct.sha}`,
  ])
  assert.equal(result.bypassed, 1)
  assert.equal(result.direct, 1)
  assert.equal(exitCodeFor(result.findings), 1)
  assert.match(errors.join('\n'), /3 commits on main, 1 bypassed the queue, 1 direct/)
  assert.ok(paths.some((p) => p.includes(`head_sha=${queued.sha}`)), 'the queued commit is audited too, it just finds nothing')
})

test('the walk is clean when every merge went through the queue', () => {
  const queued = fixture('queued')
  const api = (path) => {
    if (path === 'repos/o/r/commits?sha=main&per_page=50') return [{ sha: queued.sha }]
    if (path === `repos/o/r/commits/${queued.sha}/pulls?per_page=100`) return queued.pulls
    if (path === `repos/o/r/actions/runs?event=merge_group&head_sha=${queued.sha}&per_page=100`) return { workflow_runs: queued.runs }
    throw new Error(`unexpected path ${path}`)
  }
  const logs = []
  const [log, error] = [console.log, console.error]
  console.log = (line) => logs.push(line)
  console.error = () => {}
  let result
  try {
    result = main({ api, repo: 'o/r' })
  } finally {
    console.log = log
    console.error = error
  }
  assert.deepEqual(logs, [])
  assert.deepEqual(result.findings, [])
  assert.equal(exitCodeFor(result.findings), 0)
})

test('audit() keeps commit order and skips a commit with no sha', () => {
  const queued = fixture('queued')
  const bypassed = fixture('bypassed')
  const findings = audit({
    commits: [{ sha: bypassed.sha }, { sha: queued.sha }, {}],
    pullsFor: (sha) => (sha === queued.sha ? queued.pulls : bypassed.pulls),
    runsFor: (sha) => (sha === queued.sha ? queued.runs : bypassed.runs),
  })
  assert.deepEqual(findings.map((f) => f.pr), [680])
})

// #697: the watermark. A check that is red on every historical bypass is a check nobody reads, so a
// finding at or before the watermark prints as `earlier bypass:` and does not fail the run; only a
// finding after it fails. `--baseline` is the first-run case: everything is earlier, the run is green.
const sinceSet = () => fixture('since')

// The API the watermark cases walk: commits carry their committer date, so the same shape the real
// endpoint sends drives both the 50-commit list and the single-commit lookup `--since <sha>` needs.
const apiFor = (set) => (path) => {
  const list = /^repos\/o\/r\/commits\?sha=main&per_page=(\d+)$/.exec(path)
  if (list) return set.commits.map((c) => ({ sha: c.sha, commit: { committer: { date: c.date }, author: { date: c.date } } }))
  const pulls = /^repos\/o\/r\/commits\/([0-9a-f]+)\/pulls\?per_page=100$/.exec(path)
  if (pulls) return set.bySha[pulls[1]]?.pulls ?? []
  const runs = /^repos\/o\/r\/actions\/runs\?event=merge_group&head_sha=([0-9a-f]+)&per_page=100$/.exec(path)
  if (runs) return { total_count: 0, workflow_runs: set.bySha[runs[1]]?.runs ?? [] }
  const commit = /^repos\/o\/r\/commits\/([0-9a-f]+)$/.exec(path)
  if (commit) {
    const found = set.commits.find((c) => c.sha === commit[1])
    if (found) return { sha: found.sha, commit: { committer: { date: found.date } } }
  }
  throw new Error(`unexpected path ${path}`)
}

const runMain = (overrides) => {
  const lines = []
  const errors = []
  const [log, error] = [console.log, console.error]
  console.log = (line) => lines.push(line)
  console.error = (line) => errors.push(line)
  try {
    return { result: main({ api: apiFor(sinceSet()), repo: 'o/r', ...overrides }), lines, errors }
  } finally {
    console.log = log
    console.error = error
  }
}

test('#697: a watermark after every finding prints them as earlier bypass and exits 0', () => {
  const set = sinceSet()
  const { result, lines } = runMain({ since: set.watermarks.afterBoth })
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line, /^earlier bypass: #\d{3} [0-9a-f]{12} \(merge_group: failure\)$/)
  assert.deepEqual(lines.map((l) => l.split(' ')[2]), ['#680', '#650'], 'commit order, newest first, is kept')
  assert.equal(result.earlier, 2)
  assert.equal(result.failing.length, 0)
  assert.equal(exitCodeFor(result.findings), 0, 'nothing newer than the watermark, so the run is green')
})

test('#697: one finding after the watermark alone fails the run, the other stays earlier', () => {
  const set = sinceSet()
  const { result, lines } = runMain({ since: set.watermarks.betweenThem })
  assert.deepEqual(lines, [
    `bypassed queue: #680 ${set.commits[0].sha.slice(0, 12)} (merge_group: failure)`,
    `earlier bypass: #650 ${set.commits[1].sha.slice(0, 12)} (merge_group: failure)`,
  ])
  assert.equal(result.bypassed, 1)
  assert.equal(result.earlier, 1)
  assert.equal(exitCodeFor(result.findings), 1)
})

test('#697: a sha watermark is resolved through its own committer date, and is itself older', () => {
  const set = sinceSet()
  const { result, lines } = runMain({ since: set.commits[0].sha })
  assert.equal(result.since, '2026-10-22T05:56:53.000Z', 'a sha becomes its committer date')
  assert.equal(result.failing.length, 0, 'the commit the watermark names is at the watermark, so it is earlier')
  assert.equal(lines.filter((l) => l.startsWith('earlier bypass:')).length, 2)
  assert.equal(exitCodeFor(result.findings), 0)
})

test('#697: --baseline is the first run: every finding is earlier and nothing fails', () => {
  const { result, lines } = runMain({ baseline: true })
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line, /^earlier bypass:/)
  assert.equal(exitCodeFor(result.findings), 0)
  assert.equal(result.ok, true)
})

test('#697: without --since or --baseline every finding still fails the run, as before', () => {
  const { result, lines } = runMain({})
  assert.deepEqual(lines, [
    'bypassed queue: #680 6b9820bbd753 (merge_group: failure)',
    'bypassed queue: #650 6438cb2b63ec (merge_group: failure)',
  ])
  assert.equal(result.since, null)
  assert.equal(result.earlier, 0)
  assert.equal(exitCodeFor(result.findings), 1)
})

test('#697: an ISO date is read as a watermark without asking the API for a commit', () => {
  const set = sinceSet()
  const seen = []
  const { result } = runMain({
    since: set.watermarks.betweenThem,
    api: (path) => {
      seen.push(path)
      return apiFor(set)(path)
    },
  })
  assert.equal(result.since, '2026-10-21T20:00:00.000Z')
  assert.ok(!seen.some((p) => /^repos\/o\/r\/commits\/[^/?]+$/.test(p)), 'a date needs no single-commit lookup')
})

test('#697: a --since that is neither a sha nor a date refuses instead of guessing', () => {
  assert.throws(() => classify([{ line: 'x', date: '2026-10-22T00:00:00Z' }], { since: 'not-a-date' }), /--since is not a date/)
  assert.throws(() => sinceDate({ value: '0123abcd', repo: 'o/r', fetchJson: () => ({ sha: '0123abcd' }) }), /no committer date/)
})

test('#697: a finding with no commit date is not assumed to be older than the watermark', () => {
  const finding = { line: 'bypassed queue: #1 abcdefabcdef (merge_group: failure)', pr: 1 }
  const [kept] = classify([finding], { since: '2026-10-22T00:00:00Z' })
  assert.equal(kept.earlier, undefined)
  assert.equal(exitCodeFor([kept]), 1)
})

// #697: the patrol. The workflow is text-checked like `test-workflow.test.mjs` checks `test.yml`; what
// matters is that it can never write, and that its watermark comes from its own previous green run.
test('#697: the patrol is read-only, runs daily, and takes its own previous run as the watermark', () => {
  const text = readFileSync(new URL('../workflows/audit-merges.yml', import.meta.url), 'utf8')
  const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\nconcurrency:'))
  assert.match(triggers, /^ {2}workflow_dispatch: {0}$/m)
  assert.match(triggers, /^ {2}schedule:\n {4}- cron: '[^']+'$/m, 'a daily run, scheduled rather than triggered by a push')
  const permissions = text.slice(text.indexOf('\npermissions:\n'), text.indexOf('\njobs:\n'))
  for (const scope of ['contents', 'actions', 'pull-requests']) assert.match(permissions, new RegExp(`^ {2}${scope}: read$`, 'm'))
  assert.doesNotMatch(permissions, /: write$/m, 'the patrol writes nothing, so it may hold no write permission')
  assert.match(text, /status=success&per_page=1/, 'the watermark is the last successful run of this workflow')
  assert.match(text, /\.workflow_runs\[0\]\.head_sha/)
  assert.match(text, /--since "\$SINCE"/)
  assert.match(text, /--baseline/, 'the first run has no watermark, so it is the baseline')
  assert.match(text, /ref: main/, 'it audits main, never a pull request head')
  assert.match(text, /uses: actions\/checkout@[0-9a-f]{40}/, 'actions stay pinned to a commit')
  assert.match(text, /uses: actions\/setup-node@[0-9a-f]{40}/)
  assert.doesNotMatch(text, /permissions: write-all|contents: write/, 'no write path into the repository')
})

// audit-merges: a merge counts as a queue merge only when the gate itself passed on the commit that
// landed (#689). The fixtures carry one commit/PR/run set per shape; the walk is driven from them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { audit, auditCommit, exitCodeFor, main, queueRun } from './audit-merges.mjs'

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

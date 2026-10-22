// Audit that every merge on main went through the merge queue (#689).
//
//   GH_REPO=owner/repo GH_TOKEN=... node audit-merges.mjs [--limit 50] [--repo owner/repo]
//
// The merge gate judges a queue entry, and only the queue can turn that entry into a commit on
// `main`. That second half was a convention, and it has been broken: `#650` (`6438cb2b`) and `#680`
// (`6b9820bb`) are build commits whose `Merge gate` run failed, and `main` was nevertheless pushed
// to them (both carry `merged_by: Birfy`). A real queue merge — `#672` (`93e52347`), `#674`
// (`9393d558`) — leaves a **successful** `Merge gate` run whose `head_sha` is the commit that landed.
//
// So the difference is machine-checkable. This script walks the last `--limit` commits on `main`,
// asks which pull request each came from, and asks for the `merge_group` runs on that commit:
//   - a commit with a successful `Merge gate` run on it went through the queue: no output;
//   - a commit whose only `Merge gate` run on it failed (or which has none) prints
//     `bypassed queue: #<pr> <commit> (merge_group: failure|absent)` and the run exits 1;
//   - a commit that came from no pull request prints `direct commit: <commit>` and also exits 1:
//     a direct push to `main` did not go through the queue either. It is a separate defect, so it
//     gets a separate line rather than being counted as a bypass.
//
// The gate run is identified by its workflow, not by "some `merge_group` run succeeded": one queue
// entry runs several workflows (`Test`, `Merge gate`, …), and on `#680` the `Test` run of the very
// entry the gate refused is green. Matching a green `Test` run would call that bypass a queue merge.
//
// Read-only: it reads commits, pull requests and workflow runs, and writes nothing — no comment, no
// label, no merge, no ref push. Token scope: `contents:read`, `pulls:read`, `actions:read`.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SHORT = 12
// The gate workflow that a queue entry has to pass. `path` is what the runs API carries for the
// workflow; `name` is the fallback for fixtures and for API versions that omit it.
export const GATE_PATH = '.github/workflows/merge-gate.yml'
export const GATE_NAME = 'Merge gate'

export const short = (sha) => String(sha ?? '').slice(0, SHORT)
export const isGateRun = (run) => run?.path === GATE_PATH || run?.name === GATE_NAME

// The successful gate run for this exact commit, or null. `head_sha` is the entry's built commit —
// the commit the queue would fast-forward `main` to — so an entry built on top of an older `main`
// says nothing about this commit.
export function queueRun(sha, runs) {
  const target = String(sha ?? '').toLowerCase()
  return (runs ?? []).find((run) => String(run?.head_sha ?? '').toLowerCase() === target && isGateRun(run) && run?.conclusion === 'success') ?? null
}

// Whether the gate ran on this commit at all: it separates "the gate said no" from "nobody built a
// queue entry this commit could have come from".
export const gateRan = (sha, runs) => {
  const target = String(sha ?? '').toLowerCase()
  return (runs ?? []).some((run) => String(run?.head_sha ?? '').toLowerCase() === target && isGateRun(run))
}

// The pull request a commit came from. A merge commit names its own pull request; a squash merge
// carries one too. Prefer the pull request whose `merge_commit_sha` is this commit, because a
// cherry-pick can list more than one.
export function pullOf(sha, pulls) {
  const list = (pulls ?? []).filter((p) => p?.number)
  return list.find((p) => String(p.merge_commit_sha ?? '').toLowerCase() === String(sha).toLowerCase()) ?? list[0] ?? null
}

// One finding for one commit, or null when the commit went through the queue. The line is the whole
// interface: the Maintainer patrol and a hand run both read it, so its shape is fixed.
export function auditCommit({ sha, pulls = [], runs = [] }) {
  const pull = pullOf(sha, pulls)
  if (!pull) return { sha, ok: false, line: `direct commit: ${sha}` }
  if (queueRun(sha, runs)) return { sha, ok: true, pr: pull.number }
  const state = gateRan(sha, runs) ? 'failure' : 'absent'
  return { sha, ok: false, pr: pull.number, line: `bypassed queue: #${pull.number} ${short(sha)} (merge_group: ${state})` }
}

// The walk, over data already fetched. `pullsFor(sha)` and `runsFor(sha)` are the two calls per
// commit; keeping them injected is what lets a test drive the whole audit from fixtures.
export function audit({ commits, pullsFor, runsFor }) {
  const findings = []
  for (const commit of commits) {
    const sha = String(typeof commit === 'string' ? commit : commit?.sha ?? '')
    if (!sha) continue
    const finding = auditCommit({ sha, pulls: pullsFor(sha) ?? [], runs: runsFor(sha) ?? [] })
    if (!finding.ok) findings.push(finding)
  }
  return findings
}

export const exitCodeFor = (findings) => (findings.length ? 1 : 0)

const realGh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 })

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

// The entry point a workflow or a hand run calls. `api`, `env` and `out` are injectable so a test
// drives the whole walk from fixtures without the network.
export function main({ api, gh = realGh, env = process.env, repo: repoOption, limit: limitOption } = {}) {
  const fetchJson = api ?? ((path) => JSON.parse(gh('api', path)))
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const limit = Number(limitOption ?? arg('--limit') ?? env.LIMIT ?? 50)
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit is not a positive integer: ${limit}`)

  const base = `repos/${repo}`
  const commits = fetchJson(`${base}/commits?sha=main&per_page=${limit}`)
  if (!Array.isArray(commits)) throw new Error('the commits API did not return a list')
  const findings = audit({
    commits,
    pullsFor: (sha) => fetchJson(`${base}/commits/${sha}/pulls?per_page=100`) ?? [],
    // The runs endpoint answers `{ total_count, workflow_runs }`; only the runs matter here.
    runsFor: (sha) => fetchJson(`${base}/actions/runs?event=merge_group&head_sha=${sha}&per_page=100`)?.workflow_runs ?? [],
  })
  for (const finding of findings) console.log(finding.line)
  const bypassed = findings.filter((f) => f.pr).length
  console.error(`audit-merges: ${commits.length} commits on main, ${bypassed} bypassed the queue, ${findings.length - bypassed} direct`)
  return { findings, bypassed, direct: findings.length - bypassed, commits: commits.length, ok: findings.length === 0 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = main()
    process.exit(exitCodeFor(result.findings))
  } catch (e) {
    console.error(`audit-merges: ${e.message}`)
    process.exit(1)
  }
}

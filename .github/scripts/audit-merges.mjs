// Audit that every merge on main went through the merge queue (#689).
//
//   GH_REPO=owner/repo GH_TOKEN=... node audit-merges.mjs [--limit 50] [--repo owner/repo]
//                                                     [--since <sha|ISO date>] [--baseline]
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
//
// A watermark, so that red means "new" (#697). Run over the whole history, this script is red on its
// first run and stays red — 21 of the last 40 commits on `main` are gate failures — and a check that is
// always red is a check nobody reads. `--since <sha|ISO date>` takes a sha (resolved to its committer
// date) or a date; a finding whose commit is at or before it prints as `earlier bypass: …` and does not
// fail the run, and only a finding after it prints as `bypassed queue: …` and exits 1. `--baseline`
// treats every finding as earlier: that is what a first run uses when there is no previous run to point
// at, so the first green run is the baseline. With neither flag the behaviour is unchanged — every
// finding fails the run, which keeps a hand run as strict as it was.
//
// The walk is not narrowed by `--since`: findings at or before the watermark are printed, not skipped,
// because that is what makes the first red run readable ("these 21 are old, this one is new").
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
// commit; keeping them injected is what lets a test drive the whole audit from fixtures. Each finding
// keeps the commit's committer date so the watermark can be applied without a second walk.
export function audit({ commits, pullsFor, runsFor }) {
  const findings = []
  for (const commit of commits) {
    const sha = String(typeof commit === 'string' ? commit : commit?.sha ?? '')
    if (!sha) continue
    const date = typeof commit === 'string' ? undefined : commit?.commit?.committer?.date ?? commit?.commit?.author?.date
    const finding = auditCommit({ sha, pulls: pullsFor(sha) ?? [], runs: runsFor(sha) ?? [] })
    if (!finding.ok) findings.push({ ...finding, date })
  }
  return findings
}

// A finding at or before the watermark, or every finding with `--baseline`. The line changes, the
// reason does not: `earlier bypass: #680 6b9820bbd753 (merge_group: failure)` still says which merge
// skipped the queue and what the gate did on it.
const earlierLine = (line) =>
  line.startsWith('bypassed queue:') ? line.replace('bypassed queue:', 'earlier bypass:') : line.replace('direct commit:', 'earlier direct commit:')

export function classify(findings, { since, baseline } = {}) {
  if (!since && !baseline) return findings
  const watermark = since ? Date.parse(since) : NaN
  if (since && Number.isNaN(watermark)) throw new Error(`--since is not a date: ${since}`)
  return findings.map((finding) => {
    const at = Date.parse(finding.date ?? '')
    // A commit the API sent without a date is not assumed to be old: it stays a failure.
    const older = !Number.isNaN(at) && at <= watermark
    if (!baseline && !older) return finding
    return { ...finding, earlier: true, line: earlierLine(finding.line) }
  })
}

// `--since` takes a sha or an ISO date. A sha means "the commit I last passed on", so it is resolved
// through the API to that commit's committer date before anything is compared.
export function sinceDate({ value, repo, fetchJson } = {}) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) throw new Error(`--since is not a sha or an ISO date: ${value}`)
    return new Date(parsed).toISOString()
  }
  const commit = fetchJson(`repos/${repo}/commits/${value}`)
  const date = commit?.commit?.committer?.date ?? commit?.commit?.author?.date
  const parsed = Date.parse(date ?? '')
  if (Number.isNaN(parsed)) throw new Error(`--since ${value} has no committer date`)
  return new Date(parsed).toISOString()
}

export const exitCodeFor = (findings) => (findings.some((finding) => !finding.earlier) ? 1 : 0)


const realGh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 })

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

// The entry point a workflow or a hand run calls. `api`, `env` and the options are injectable so a
// test drives the whole walk from fixtures without the network.
export function main({ api, gh = realGh, env = process.env, repo: repoOption, limit: limitOption, since: sinceOption, baseline: baselineOption } = {}) {
  const fetchJson = api ?? ((path) => JSON.parse(gh('api', path)))
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const limit = Number(limitOption ?? arg('--limit') ?? env.LIMIT ?? 50)
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit is not a positive integer: ${limit}`)
  const sinceValue = sinceOption ?? arg('--since') ?? env.SINCE
  const baseline = Boolean(baselineOption ?? (process.argv.includes('--baseline') || env.BASELINE))

  const base = `repos/${repo}`
  const since = sinceDate({ value: sinceValue, repo, fetchJson })
  const commits = fetchJson(`${base}/commits?sha=main&per_page=${limit}`)
  if (!Array.isArray(commits)) throw new Error('the commits API did not return a list')
  const findings = classify(audit({
    commits,
    pullsFor: (sha) => fetchJson(`${base}/commits/${sha}/pulls?per_page=100`) ?? [],
    // The runs endpoint answers `{ total_count, workflow_runs }`; only the runs matter here.
    runsFor: (sha) => fetchJson(`${base}/actions/runs?event=merge_group&head_sha=${sha}&per_page=100`)?.workflow_runs ?? [],
  }), { since, baseline })
  for (const finding of findings) console.log(finding.line)
  const failing = findings.filter((finding) => !finding.earlier)
  const bypassed = failing.filter((f) => f.pr).length
  const direct = failing.length - bypassed
  const earlier = findings.length - failing.length
  const summary = [`${commits.length} commits on main`, `${bypassed} bypassed the queue`, `${direct} direct`]
  if (earlier) summary.push(`${earlier} at or before the watermark`)
  console.error(`audit-merges: ${summary.join(', ')}`)
  if (since) console.error(`audit-merges: watermark ${since}${sinceValue && sinceValue !== since ? ` (from ${sinceValue})` : ''}`)
  else if (baseline) console.error('audit-merges: baseline run, every finding is earlier and nothing fails this run')
  return { findings, failing, bypassed, direct, earlier, commits: commits.length, since, baseline, ok: failing.length === 0 }
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

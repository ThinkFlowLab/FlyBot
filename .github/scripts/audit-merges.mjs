// Audit that every merge on main went through the merge queue (#689, #697).
//
//   GH_REPO=owner/repo GH_TOKEN=... node audit-merges.mjs [--limit 50] [--since <sha|ISO date> | --baseline] [--repo owner/repo]
//
// The merge gate judges a queue entry, and only the queue should turn that entry into a commit on
// `main`. That second half is still a convention, and it has been broken: `#650` (`6438cb2b`) and
// `#680` (`6b9820bb`) are commits that a pull request names as its merge commit, while the
// `Merge gate` run of the queue entry it built failed. A real queue merge — `#672` (`93e52347`),
// `#674` (`9393d558`) — leaves a **successful** `Merge gate` run whose `head_sha` is that commit.
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
// **The watermark (#697).** This history contains bypasses from before `merge-gate` became a
// required check, so a check that reports all of them is red on its first run and stays red until
// they slide out of the window — a check nobody reads. `--since <sha|ISO date>` moves the start of
// the walk: a sha is resolved to its committer date, the commits list is fetched from that date, and
// a finding at or before the watermark prints as `earlier bypass: …` / `earlier direct commit: …`
// and does not affect the exit code. Only a finding newer than the watermark fails the run, so red
// means "new". With no `--since` everything is a finding, which is what a hand run wants.
//
// `--baseline` is the first run of a patrol that has no previous run: it walks the window unfiltered
// and marks every finding `earlier`, so the history it finds becomes the watermark instead of a red
// first run. `--since` and `--baseline` are exclusive — one starts at a point, the other sets one.
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
// interface: the patrol workflow and a hand run both read it, so its shape is fixed.
export function auditCommit({ sha, pulls = [], runs = [] }) {
  const pull = pullOf(sha, pulls)
  if (!pull) return { sha, ok: false, line: `direct commit: ${sha}` }
  if (queueRun(sha, runs)) return { sha, ok: true, pr: pull.number }
  const state = gateRan(sha, runs) ? 'failure' : 'absent'
  return { sha, ok: false, pr: pull.number, state, line: `bypassed queue: #${pull.number} ${short(sha)} (merge_group: ${state})` }
}

// The committer date of a commit in the shape `GET /commits` returns it, in milliseconds, or null
// when the object carries no readable date (a test may pass a bare `{ sha }`).
export const commitMs = (commit) => {
  const raw = commit?.commit?.committer?.date ?? commit?.commit?.author?.date
  if (raw === undefined || raw === null) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

// A finding at or before the watermark. It stays in the report — the history is the record — but it
// never fails the run, so `exit 1` always means "something merged after the watermark bypassed".
const earlierLine = (finding) =>
  finding.pr
    ? `earlier bypass: #${finding.pr} ${short(finding.sha)} (merge_group: ${finding.state})`
    : `earlier direct commit: ${finding.sha}`

// The walk, over data already fetched. `pullsFor(sha)` and `runsFor(sha)` are the two calls per
// commit; keeping them injected is what lets a test drive the whole audit from fixtures. `since` is
// an ISO timestamp (or milliseconds): findings at or before it are marked `earlier` and never fail.
export function audit({ commits, pullsFor, runsFor, since, baseline = false }) {
  const sinceMs =
    since === undefined || since === null || since === '' ? null : typeof since === 'number' ? since : Date.parse(since)
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`--since is not an ISO date: ${since}`)
  const findings = []
  for (const commit of commits) {
    const sha = String(typeof commit === 'string' ? commit : commit?.sha ?? '')
    if (!sha) continue
    const finding = auditCommit({ sha, pulls: pullsFor(sha) ?? [], runs: runsFor(sha) ?? [] })
    if (finding.ok) continue
    const ms = typeof commit === 'string' ? null : commitMs(commit)
    if (baseline || (sinceMs !== null && ms !== null && ms <= sinceMs)) {
      finding.earlier = true
      finding.line = earlierLine(finding)
    }
    findings.push(finding)
  }
  return findings
}

// Only a finding newer than the watermark fails: an all-earlier report is the baseline, not a defect.
export const exitCodeFor = (findings) => ((findings ?? []).some((f) => !f.earlier) ? 1 : 0)

const realGh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 })

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

// `--since` takes either a sha (resolved to that commit's committer date) or an ISO date. Resolving
// it here keeps the walk one request with `since=`, and lets the patrol pass the `head_sha` of its
// own previous successful run without a file having to be committed.
export function resolveSince(fetchJson, base, raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const value = String(raw).trim()
  if (/^[0-9a-f]{4,40}$/i.test(value)) {
    const commit = fetchJson(`${base}/commits/${value}`)
    const iso = commit?.commit?.committer?.date ?? commit?.commit?.author?.date
    if (!iso) throw new Error(`--since sha ${value} has no committer date`)
    return new Date(iso).toISOString()
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new Error(`--since is not a sha or an ISO date: ${value}`)
  return new Date(ms).toISOString()
}

// The entry point a workflow or a hand run calls. `api`, `gh`, `env` and the explicit options are
// injectable so a test drives the whole walk from fixtures without the network.
export function main({ api, gh = realGh, env = process.env, repo: repoOption, limit: limitOption, since: sinceOption, baseline: baselineOption } = {}) {
  const fetchJson = api ?? ((path) => JSON.parse(gh('api', path)))
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const limit = Number(limitOption ?? arg('--limit') ?? env.LIMIT ?? 50)
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit is not a positive integer: ${limit}`)

  const base = `repos/${repo}`
  const baseline = baselineOption ?? (arg('--baseline') !== undefined || env.BASELINE === '1')
  if (baseline && (sinceOption ?? arg('--since') ?? env.SINCE)) throw new Error('--baseline and --since are exclusive')
  const since = baseline ? null : resolveSince(fetchJson, base, sinceOption ?? arg('--since') ?? env.SINCE)
  const commits = fetchJson(`${base}/commits?sha=main&per_page=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`)
  if (!Array.isArray(commits)) throw new Error('the commits API did not return a list')
  const findings = audit({
    commits,
    since,
    baseline: baseline === true,
    pullsFor: (sha) => fetchJson(`${base}/commits/${sha}/pulls?per_page=100`) ?? [],
    // The runs endpoint answers `{ total_count, workflow_runs }`; only the runs matter here.
    runsFor: (sha) => fetchJson(`${base}/actions/runs?event=merge_group&head_sha=${sha}&per_page=100`)?.workflow_runs ?? [],
  })
  for (const finding of findings) console.log(finding.line)
  const fresh = (f) => !f.earlier
  const bypassed = findings.filter((f) => f.pr && fresh(f)).length
  const direct = findings.filter((f) => !f.pr && fresh(f)).length
  const earlier = findings.filter((f) => f.earlier).length
  console.error(
    `audit-merges: ${commits.length} commits on main, ${bypassed} bypassed the queue, ${direct} direct, ${earlier} earlier than the watermark${baseline ? ' (baseline)' : since ? ` (${since})` : ''}`,
  )
  return { findings, bypassed, direct, earlier, since, baseline: baseline === true, commits: commits.length, ok: exitCodeFor(findings) === 0 }
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

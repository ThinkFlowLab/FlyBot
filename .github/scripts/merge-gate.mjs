// Can this pull request be merged? (report only; issue #3401)
//
//   node .github/scripts/merge-gate.mjs --pr 12                 # anonymous read: no token needed
//   GH_TOKEN=... node .github/scripts/merge-gate.mjs --pr 12     # same, spares the shared quota
//   node .github/scripts/merge-gate.mjs --self-test              # no network: the five cases below
//   node .github/scripts/merge-gate.mjs --pr 12 --json           # the same result, as data
//
// Four gates, in order; any failure exits 1:
//
//   1. head and state      open, not a draft, mergeable, base main, a 40-character head sha
//   2. required checks     every name in REQUIRED_CHECKS completed success on that head, and the
//                          rollup `FlyBot required checks` present and success
//   3. evidence            a PR comment with this head and the QA marker, and one with this head
//                          and the review marker - so a new commit voids both by itself
//   4. risk (advisory)     exactly one risk:T0..T3 label, printed as information. The tier never
//                          blocks a merge (the merge is the Lead's call, user, 2026-11-26); a missing
//                          or doubled label does fail, because that is the record, not the tier
//
// The script never writes: it does not merge, label or comment. It also never parses tests.yml: the
// check list is a constant, because a gate that read the workflow would pass silently whenever that
// workflow lost a job - exactly the failure it exists to catch.
//
// This file is the CLI and the REST half. The gates themselves are pure and live in
// merge-gate-core.mjs, their fixtures in merge-gate-self-test.mjs; the three files are re-exported
// here so `import ... from './merge-gate.mjs'` keeps working.
import { fileURLToPath } from 'node:url'
import { evaluate, render } from './merge-gate-core.mjs'
import { selfTest } from './merge-gate-self-test.mjs'

export * from './merge-gate-core.mjs'
export { SELF_TEST_CASES } from './merge-gate-self-test.mjs'

export const DEFAULT_REPO = 'ThinkFlowLab/FlyBot'

// ---- GitHub REST (read only) ---------------------------------------------------------------

const MAX_PAGES = 100
const apiBase = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const authToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

function nextLink(link) {
  for (const part of String(link || '').split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
    if (m) return m[1]
  }
  return undefined
}

export async function request(path) {
  const url = /^https?:/.test(path) ? path : apiBase() + path
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'flybot-merge-gate' }
  const token = authToken()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const left = res.headers.get('x-ratelimit-remaining')
    const hint = left === '0'
      ? ` (anonymous API quota spent; resets at ${new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000).toISOString()} - set GH_TOKEN to use your own)`
      : ''
    const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}${hint}${body ? `: ${body}` : ''}`)
  }
  return { body: await res.json(), next: nextLink(res.headers.get('link')) }
}

// `pick` exists because /commits/{sha}/check-runs answers with an object ({total_count, check_runs}),
// while comments answer with a bare array; a wrong shape must fail loudly, not iterate as empty.
export async function list(path, pick = (body) => body) {
  const out = []
  let next = path
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = await request(next)
    const items = pick(r.body)
    if (!Array.isArray(items)) throw new Error(`GET ${path}: expected a list, got ${Array.isArray(r.body) ? 'array' : typeof r.body}`)
    out.push(...items)
    next = r.next
  }
  return out
}

export async function readPull(repo, n) {
  const { body: pr } = await request(`/repos/${repo}/pulls/${n}`)
  const comments = await list(`/repos/${repo}/issues/${n}/comments?per_page=100`)
  // filter=latest asks for one line per check name; latestByName() makes that a guarantee, not a hope.
  const checkRuns = await list(
    `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100&filter=latest`,
    (body) => body.check_runs,
  )
  return evaluate({ number: Number(n), pr, checkRuns, comments })
}

// ---- CLI ------------------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1)
  }
  const repo = arg('--repo') || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || DEFAULT_REPO
  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('pass --pr N (or --self-test)')
  const result = await readPull(repo, pr)
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else console.log(render(result))
  process.exit(result.pass ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`merge-gate: ${e.message}`); process.exit(1) })
}

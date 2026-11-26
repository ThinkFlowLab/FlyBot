// Risk tier of a pull request (report only; rules: .github/agent/risk-rules.json, issue #3393).
//
//   node .github/scripts/risk-gate.mjs --pr 12                  # anonymous read: no token needed
//   GH_TOKEN=... node .github/scripts/risk-gate.mjs --pr 12      # same, with a token (spares the shared quota)
//   node .github/scripts/risk-gate.mjs --replay 30               # tiers of the last N merged PRs
//   PR=12 GITHUB_REPOSITORY=owner/repo node .github/scripts/risk-gate.mjs   # what a workflow passes
//
// The PR is read only through the GitHub REST API (the list of changed files and their patches); no
// PR code is checked out or run. The rules engine (paths, tiers, report) is risk-tier.mjs; this file
// reads the PR and prints. It exits 0 with a tier and 1 only when it could not compute one.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORDER, createGate, loadRules, render } from './risk-tier.mjs'

// Re-exported so the engine and the command can be imported from one place.
export * from './risk-tier.mjs'

export const DEFAULT_REPO = 'ThinkFlowLab/FlyBot' // so `--pr N` works with no other set-up
const MAX_PAGES = 100 // a runaway Link header must not spin forever

// `fetch` is global since node 18, so no dependency and no `gh` binary is needed. A token is used
// when the environment has one (fewer failures on a shared anonymous quota), never required.
const apiBase = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const authToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

// `[link]` header -> the next absolute URL, or undefined.
function nextLink(link) {
  for (const part of String(link || '').split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
    if (m) return m[1]
  }
  return undefined
}

export async function request(path) {
  const url = /^https?:/.test(path) ? path : apiBase() + path
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'flybot-risk-gate' }
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

export async function list(path) {
  const out = []
  let next = path
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = await request(next)
    out.push(...r.body)
    next = r.next
  }
  return out
}

export const prFiles = (repo, n) => list(`/repos/${repo}/pulls/${n}/files?per_page=100`)

// The last N merged PRs: closed PRs by recency, filtered on merged_at (a closed-but-unmerged PR is
// not a replay sample). `gh pr list --state merged` is gone with the gh dependency.
export async function mergedPrs(repo, n) {
  const out = []
  let next = `/repos/${repo}/pulls?state=closed&per_page=100&sort=updated&direction=desc`
  for (let page = 0; next && page < MAX_PAGES && out.length < n; page++) {
    const r = await request(next)
    for (const pr of r.body) if (pr.merged_at) out.push({ number: pr.number, title: pr.title || '' })
    next = r.next
  }
  return out.slice(0, n)
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const rulesPath = arg('--rules') || process.env.RISK_RULES || fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
  const rules = loadRules(rulesPath)
  const gate = createGate(rules)
  const meaning = Object.fromEntries(Object.entries(rules.tiers).map(([t, d]) => [t, d.meaning]))
  const repo = arg('--repo') || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || DEFAULT_REPO

  if (arg('--replay')) {
    const n = Number(arg('--replay'))
    const prs = await mergedPrs(repo, n)
    const dist = Object.fromEntries(ORDER.map((t) => [t, 0]))
    for (const pr of prs.sort((a, b) => a.number - b.number)) {
      const r = gate.judge(await prFiles(repo, pr.number))
      dist[r.tier]++
      console.log(`#${pr.number}\t${r.tier}\t${r.lines}L/${r.files}F\t${pr.title.slice(0, 60)}\n\t${r.why.slice(0, 4).join(' | ')}`)
    }
    console.log(`\nDistribution over ${prs.length} merged PRs: ` + ORDER.map((t) => `${t} ${dist[t]}`).join(', '))
    return
  }

  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N (or --replay N)')
  const r = gate.judge(await prFiles(repo, pr))
  const text = render(r, meaning)
  // The console line keeps the reason even when no T3 rule fired, so a T1/T2 verdict is quotable.
  const why = r.why.length ? r.why : r.basis.filter((b) => b.tier === r.tier).slice(0, 5).map((b) => `${b.path}=${b.tier}`)
  console.log(`risk-gate (report only): PR #${pr} tier ${r.tier}${why.length ? '; ' + why.join('; ') : ''}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`risk-gate: ${e.message}`); process.exit(1) })
}

// Applies the tier of risk-gate.mjs to a pull request as its one risk:T* label (issue #3393).
//
//   node .github/scripts/risk-gate-label.mjs --pr 12               # dry run: print the change, write nothing
//   GH_TOKEN=... node .github/scripts/risk-gate-label.mjs --pr 12 --apply
//   PR=12 GITHUB_REPOSITORY=owner/repo node .github/scripts/risk-gate-label.mjs --apply   # what the workflow passes
//
// The label is the record merge-gate reads (RISK_LABEL in merge-gate-core.mjs): exactly one risk:T0..T3
// per pull request, written only by the risk-gate workflow. A run converges instead of stacking: labels
// for other tiers are removed, the target is added, and a run that already finds the target alone sends
// no write at all - so a re-run, or the leftovers of a cancelled run, leave one label and nothing else.
//
// No comment is posted. The tier and its reasons go to the run summary through risk-gate.mjs, so there
// is no second copy on the pull request to keep in sync.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_REPO, createGate, loadRules, prFiles } from './risk-gate.mjs'
import { RISK_LABEL } from './merge-gate-core.mjs'

// Writes need a token; a dry run does not, and the read in risk-gate.mjs stays anonymous without one.
const apiBase = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const authToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

async function call(method, path, body) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'flybot-risk-gate-label' }
  const token = authToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(apiBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) {
    const body = text.slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
  }
  return text ? JSON.parse(text) : undefined
}

// What the labels of one pull request must become for this tier. Kept pure so the only write rule is
// testable without a network: the target is the single risk:T* label, every other label is left alone.
export function labelPlan(tier, labels) {
  const target = `risk:${tier}`
  const risk = labels.filter((n) => RISK_LABEL.test(n))
  return { target, add: risk.includes(target) ? null : target, remove: risk.filter((n) => n !== target) }
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const rulesPath = arg('--rules') || process.env.RISK_RULES || fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
  const gate = createGate(loadRules(rulesPath))
  const repo = arg('--repo') || process.env.GH_REPO || process.env.GITHUB_REPOSITORY || DEFAULT_REPO
  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N')
  const apply = process.argv.includes('--apply')

  const tier = gate.judge(await prFiles(repo, pr)).tier
  const labels = (await call('GET', `/repos/${repo}/issues/${pr}/labels?per_page=100`)).map((l) => l.name)
  const plan = labelPlan(tier, labels)

  let verdict
  if (!apply) {
    verdict = `dry run: would ${plan.add ? `add ${plan.add}` : `keep ${plan.target}`}${plan.remove.length ? `, removing ${plan.remove.join(' ')}` : ''}`
  } else {
    for (const name of plan.remove) await call('DELETE', `/repos/${repo}/issues/${pr}/labels/${encodeURIComponent(name)}`)
    if (plan.add) await call('POST', `/repos/${repo}/issues/${pr}/labels`, { labels: [plan.add] })
    const changed = plan.remove.length > 0 || plan.add !== null
    verdict = changed
      ? `applied ${plan.target}${plan.remove.length ? `, removed ${plan.remove.join(' ')}` : ''}`
      : `unchanged, ${plan.target} was already the only risk label`
  }

  const line = `risk-gate-label: PR #${pr} tier ${tier}; ${verdict}`
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`risk-gate-label: ${e.message}`); process.exit(1) })
}

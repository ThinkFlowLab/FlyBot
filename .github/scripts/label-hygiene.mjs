// Label hygiene: which agent-* labels on an object no longer describe anything.
// `agent-working` means work is live; `agent-pr` means an open PR carries it. When the work or the
// PR is gone the label is an orphan and should be removed. Report only: nothing here writes.
import { readFileSync } from 'node:fs'

export const GUARDED = ['agent-working', 'agent-pr']

const labelNames = (item) => (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
const kindOf = (item) => item.kind ?? (item.pull_request ? 'pr' : 'issue')
const prFact = (facts, n) => (facts && n != null ? facts[String(n)] ?? facts[n] : null)

// A label is an orphan when the thing it announces is gone. Every verdict carries the fact it rests
// on, so a dry run can be checked line by line instead of trusted.
export function auditLabels(items, prs = {}) {
  const rows = []
  for (const item of items ?? []) {
    const labels = labelNames(item)
    const kind = kindOf(item)
    const state = item.state ?? 'open'
    if (labels.includes('agent-working')) {
      let reason = null
      if (state === 'closed') reason = `the ${kind} is closed`
      else if (item.work_live === false) reason = 'no open PR and no branch references it'
      if (reason) rows.push({ number: item.number, kind, label: 'agent-working', state, verdict: 'orphan', reason })
    }
    if (labels.includes('agent-pr')) {
      const announced = item.announces_pr ?? null
      const fact = prFact(prs, announced)
      let reason = null
      if (announced != null || fact) {
        if (!fact) reason = `PR #${announced} is not in the facts given, so it cannot be confirmed open`
        else if (fact.state !== 'open') reason = `PR #${announced} is ${fact.state}${fact.merged ? ' and merged' : ' unmerged'}`
        else if (fact.branch_exists === false) reason = `PR #${announced} is open but its branch is gone`
      } else if (state === 'closed') reason = `the ${kind} is closed and no open PR is named`
      if (reason) rows.push({ number: item.number, kind, label: 'agent-pr', state, verdict: 'orphan', reason })
      else if (fact) rows.push({ number: item.number, kind, label: 'agent-pr', state, verdict: 'keep', reason: `PR #${announced} is open` })
    }
  }
  return rows
}

// Labels outside the guarded pair are never touched; say so instead of silently ignoring them.
export function untouched(items) {
  const seen = new Map()
  for (const item of items ?? []) {
    for (const name of labelNames(item)) {
      if (GUARDED.includes(name)) continue
      seen.set(name, (seen.get(name) ?? 0) + 1)
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }))
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

function main() {
  const issuesFile = arg('--issues')
  const prsFile = arg('--prs')
  const json = process.argv.includes('--json')
  if (!issuesFile) {
    console.error('report only, nothing is written. Usage:')
    console.error('  node .github/scripts/label-hygiene.mjs --issues <issues.json> [--prs <prs.json>] [--json]')
    console.error('  items: [{number, kind, state, labels: [], announces_pr, work_live}]')
    console.error('  prs:   {"3067": {"state": "closed", "merged": false, "branch_exists": false}}')
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(issuesFile, 'utf8'))
  const items = Array.isArray(raw) ? raw : raw.items ?? []
  const prs = prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : {}
  const rows = auditLabels(items, prs)

  if (json) console.log(JSON.stringify({ scanned: items.length, rows, untouched: untouched(items) }, null, 2))
  else {
    for (const r of rows) console.log(`#${String(r.number).padEnd(6)} ${r.label.padEnd(13)} ${r.verdict.padEnd(6)} ${r.reason}`)
    const orphans = rows.filter((r) => r.verdict === 'orphan')
    console.log(`\nScanned ${items.length} objects; ${orphans.length} orphan label(s) to strip, ${rows.length - orphans.length} still describe live work.`)
    console.log(`Not touched: ${untouched(items).map((u) => `${u.label}×${u.count}`).join(' ') || 'nothing else is labelled'}`)
  }
  // Exit 1 only when something is orphaned, so a scheduled dry run can fail loudly on drift.
  process.exit(rows.some((r) => r.verdict === 'orphan') ? 1 : 0)
}

if (process.argv[1] && process.argv[1].endsWith('label-hygiene.mjs')) main()

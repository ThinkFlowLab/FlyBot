// Label hygiene: which agent-* labels no longer describe anything. `agent-working` claims work is
// live, `agent-pr` an open PR; the payload has neither fact, so both come from what we wrote plus the
// listings the caller passes in. Writes nothing.
import { readFileSync } from 'node:fs'

export const GUARDED = ['agent-working', 'agent-pr']
const names = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
const kindOf = (i) => i.kind ?? (i.pull_request ? 'pr' : 'issue')

// --prs takes a saved /pulls list (any state) or a {number: fact} map. The list also says which
// branch each PR came from, so an issue that only names a branch still reaches its PR.
const asList = (prs) => (Array.isArray(prs) ? prs.map((p) => ({
  number: p.number, state: p.state ?? 'open', merged: !!p.merged,
  branch: p.branch ?? p.head?.ref ?? null, branch_exists: p.branch_exists,
})) : null)
const prFact = (prs, n) => {
  if (!prs || n == null) return null
  const list = asList(prs)
  return list ? list.find((p) => p.number === n) ?? null : prs[String(n)] ?? prs[n] ?? null
}
const prOnBranch = (prs, branch) => {
  const list = asList(prs)
  if (!list || !branch) return null
  const hits = list.filter((p) => p.branch === branch)
  return hits.find((p) => p.state === 'open') ?? hits[0] ?? null
}

// The conventions our own comments use, and the only way an object payload can name its PR.
export function announcedPr(item) {
  if (kindOf(item) === 'pr') return item.number ?? null
  const body = String(item.body ?? '')
  const m = body.match(/(?:related|refs?|pr|pull request)\s*:?\s*#(\d+)/i) ?? body.match(/pull\/(\d+)/)
  return m ? Number(m[1]) : null
}

// `Branch: dev/x` is written on pickup: the only trace of the work before a PR exists.
export function claimedBranch(item) {
  const m = String(item.body ?? '').match(/^\s*Branch:\s*(\S+)\s*$/m)
  return m ? m[1] : null
}

const work = (item, kind, { branches }) => {
  const state = item.state ?? 'open'
  const branch = claimedBranch(item)
  if (state === 'closed') return ['orphan', `the ${kind} is closed`]
  if (!branch) return ['unknown', 'open, with no Branch: line and no work_live fact: liveness is not in the payload']
  if (!branches) return ['unknown', `claims branch ${branch}; pass --refs to check whether it still exists`]
  return branches.has(branch) ? ['keep', `branch ${branch} exists`] : ['orphan', `branch ${branch} is gone`]
}

const carrier = (item, kind, { prs, branches }) => {
  const state = item.state ?? 'open'
  const branch = claimedBranch(item)
  const n = announcedPr(item) ?? prOnBranch(prs, branch)?.number ?? null
  if (n == null) {
    if (state === 'closed') return ['orphan', `the ${kind} is closed and no open PR is named`]
    if (branch && branches && !branches.has(branch)) {
      return ['orphan', `claims branch ${branch}, which is gone, so no open PR carries it`]
    }
    if (branch && (branches || prs)) return ['unknown', `names no PR; claims branch ${branch}: pass --prs (head.ref) or --refs`]
    return ['unknown', 'open, but the body names no PR and no PR list was given']
  }
  if (kind === 'pr' && n === item.number) return [state === 'open' ? 'keep' : 'orphan', `PR #${n} is ${state}`]
  if (!prs) return ['unknown', `announces PR #${n}; pass --prs with the saved PR list to check it`]
  const f = prFact(prs, n)
  if (!f) return ['orphan', `PR #${n} is not in the list given, so it is not open`]
  if (f.state !== 'open') return ['orphan', `PR #${n} is ${f.state}${f.merged ? ' and merged' : ' unmerged'}`]
  if (f.branch_exists === false) return ['orphan', `PR #${n} is open but its branch is gone`]
  return ['keep', `PR #${n} is open`]
}

// Every verdict names the fact it rests on. `unknown` is not a pass: the caller did not supply the
// fact, so the run reports it instead of calling the board clean.
export function auditLabels(items, { prs = null, refs = null } = {}) {
  const branches = refs == null ? null : new Set(Array.isArray(refs) ? refs : refs.refs ?? [])
  const rows = []
  for (const item of items ?? []) {
    const labels = names(item)
    const kind = kindOf(item)
    const state = item.state ?? 'open'
    for (const [label, decide] of [['agent-working', work], ['agent-pr', carrier]]) {
      if (!labels.includes(label)) continue
      const [verdict, reason] = decide(item, kind, { prs, branches })
      rows.push({ number: item.number ?? null, kind, label, state, verdict, reason })
    }
  }
  return rows
}

// Labels outside the guarded pair are never touched; say so instead of silently ignoring them.
export function untouched(items) {
  const seen = new Map()
  for (const item of items ?? []) for (const name of names(item)) {
    if (!GUARDED.includes(name)) seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }))
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

function main() {
  const issuesFile = arg('--issues')
  if (!issuesFile) {
    console.error('report only, nothing is written. Usage:')
    console.error('  label-hygiene.mjs --issues <saved /issues?state=open> [--prs <saved /pulls>] [--refs <branches>]')
    console.error('  prs: [{"number": 3067, "state": "closed", "merged": false, "head": {"ref": "dev/x"}}] or {number: fact}')
    console.error('  refs: ["dev/x", "main"] - every branch that exists (git ls-remote)')
    process.exit(1)
  }
  const raw = JSON.parse(readFileSync(issuesFile, 'utf8'))
  const items = Array.isArray(raw) ? raw : raw.items ?? []
  const prsFile = arg('--prs')
  const refsFile = arg('--refs')
  const prs = prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : null
  const refs = refsFile ? JSON.parse(readFileSync(refsFile, 'utf8')) : null
  const rows = auditLabels(items, { prs, refs })
  const orphans = rows.filter((r) => r.verdict === 'orphan')
  const unknown = rows.filter((r) => r.verdict === 'unknown')

  for (const r of rows) console.log(`#${String(r.number).padEnd(6)} ${r.label.padEnd(13)} ${r.verdict.padEnd(7)} ${r.reason}`)
  console.log(`\nScanned ${items.length} objects; ${orphans.length} orphan(s) to strip, ${rows.length - orphans.length - unknown.length} live, ${unknown.length} unjudged.`)
  console.log(`Not touched: ${untouched(items).map((u) => `${u.label}\u00d7${u.count}`).join(' ') || 'nothing else is labelled'}`)
  if (unknown.length) console.error(`\n${unknown.length} label(s) need a fact this run did not have: pass --prs and --refs.`)
  // 1 = strip, 2 = could not judge, 0 = clean. An unknown is never 0: a scheduled run that cannot
  // see the fact must be red, not quiet.
  process.exit(orphans.length ? 1 : unknown.length ? 2 : 0)
}

if (process.argv[1] && process.argv[1].endsWith('label-hygiene.mjs')) main()

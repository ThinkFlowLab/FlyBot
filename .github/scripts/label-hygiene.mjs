// Which agent-* labels no longer describe anything. Neither fact is in the payload, so both come from
// what we wrote and what the caller passes in. Writes nothing.
import { readFileSync } from 'node:fs'

export const GUARDED = ['agent-working', 'agent-pr']
const names = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
const kindOf = (i) => i.kind ?? (i.pull_request ? 'pr' : 'issue')

// --prs: a saved /pulls list (any state) or a {number: fact} map; the list also says each PR's branch.
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
  if (!branch) return ['unknown', 'open, with no Branch: line: nothing in the payload says the work is live']
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
    // Name only the fact that is missing: a caller who already passed --refs is not sent back for it.
    if (branch && branches) {
      return ['unknown', prs
        ? `names no PR; branch ${branch} exists and no open PR in the list came from it: the body has to name its PR`
        : `names no PR; branch ${branch} exists, but a live branch cannot show a PR still carries it: pass --prs`]
    }
    if (branch && prs) return ['unknown', `names no PR and no open PR in the list came from branch ${branch}: pass --refs to see whether the branch is gone`]
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
  // An empty listing is not a fact: a flaked `git ls-remote` gives exactly that, and reading it as
  // gone strips a live label. Only a non-empty list may decide anything.
  const refList = Array.isArray(refs) ? refs : refs?.refs ?? []
  const branches = refList.length ? new Set(refList) : null
  prs = (Array.isArray(prs) ? prs : Object.keys(prs ?? {})).length ? prs : null
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
  return i === -1 ? fallback : process.argv[i + 1] ?? null
}

// `git ls-remote` prints `<sha>\trefs/heads/<name>` and that is the normal input; JSON is the exception.
const readRefs = (file) => {
  const text = readFileSync(file, 'utf8')
  if (/^\s*[\[{]/.test(text)) { const j = JSON.parse(text); return Array.isArray(j) ? j : j.refs ?? [] }
  const heads = text.split('\n').map((l) => l.split(/\s+/).filter(Boolean).pop())
    .filter((n) => n?.startsWith('refs/heads/'))
  return heads.map((n) => n.slice('refs/heads/'.length))
}

function main() {
  const issuesFile = arg('--issues')
  if (!issuesFile) {
    console.error('report only, nothing is written. Usage: label-hygiene.mjs --issues <saved /issues?state=open> [--prs <saved /pulls>] [--refs <ls-remote lines or JSON array>]')
    return 3
  }
  const raw = JSON.parse(readFileSync(issuesFile, 'utf8'))
  const items = Array.isArray(raw) ? raw : raw.items ?? []
  const prsFile = arg('--prs')
  const refsFile = arg('--refs')
  const prs = prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : null
  const refs = refsFile ? readRefs(refsFile) : null
  const rows = auditLabels(items, { prs, refs })
  const orphans = rows.filter((r) => r.verdict === 'orphan')
  const unknown = rows.filter((r) => r.verdict === 'unknown')

  for (const r of rows) console.log(`#${String(r.number).padEnd(6)} ${r.label.padEnd(13)} ${r.verdict.padEnd(7)} ${r.reason}`)
  console.log(`\nScanned ${items.length} objects; ${orphans.length} orphan(s) to strip, ${rows.length - orphans.length - unknown.length} live, ${unknown.length} unjudged.`)
  console.log(`Not touched: ${untouched(items).map((u) => `${u.label}\u00d7${u.count}`).join(' ') || 'nothing else is labelled'}`)
  // Same rule as the per-row reasons: point only at what is missing, so nobody is sent to re-pass a
  // flag that was already given. When both were given, the payload itself is what has to say it.
  const prsGiven = (Array.isArray(prs) ? prs.length : Object.keys(prs ?? {}).length) > 0
  const refsGiven = (refs ?? []).length > 0
  const need = [!prsGiven && '--prs', !refsGiven && '--refs'].filter(Boolean)
  if (unknown.length) {
    console.error(need.length
      ? `\n${unknown.length} label(s) need a fact this run did not have: pass ${need.join(' and ')}.`
      : `\n${unknown.length} label(s) stayed unjudged: every fact a run can be given was given, so the payload has to name it.`)
  }
  // 0 clean / 1 orphan / 2 unjudged / 3 input error: whoever wires this up reads 1 as "strip", so a
  // mistyped path must never land there.
  return orphans.length ? 1 : unknown.length ? 2 : 0
}

if (process.argv[1] && process.argv[1].endsWith('label-hygiene.mjs')) {
  try {
    process.exit(main())
  } catch (e) {
    console.error(`label-hygiene: input error: ${e.code === 'ENOENT' ? `no such file: ${e.path}` : e.message}`)
    process.exit(3)
  }
}

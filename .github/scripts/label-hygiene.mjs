// Strip status labels from items that are no longer open (#738).
//
//   node .github/scripts/label-hygiene.mjs --repo ThinkFlowLab/FlyBot            # dry run: prints the work
//   node .github/scripts/label-hygiene.mjs --repo ThinkFlowLab/FlyBot --apply    # removes the labels
//
// A status label answers "what is happening to this item right now", so it must not outlive the item:
// on 2026-10-22 the board counted 11 closed issues and 43 closed pull requests as in flight because
// nothing removed `agent-working`/`agent-pr` when they closed. Only the status labels in
// `STALE_LABELS` are ever removed; `bug`, `area:*`, `risk:*`, `hold`, `needs-*` and `status:done` are
// records and this script never touches them. `hold` stays human-only in both directions.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const STALE_LABELS = ['agent-working', 'agent-pr', 'agent-ready', 'agent-task', 'awaiting-approval']

// Labels may arrive as `["bug"]` or as objects; GitHub's REST API returns objects.
export const labelNames = item => (item.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean)

// What this item needs: it must be closed, and only the stale labels among its labels are removed.
export function planItem(item) {
  const labels = labelNames(item)
  const stale = labels.filter(name => STALE_LABELS.includes(String(name).toLowerCase()))
  return { number: item.number, title: item.title ?? '', state: item.state, stale, closed: item.state !== 'open' }
}

// [{ number, title, stale }] for the items that are closed and still carry a status label, deduped by
// number (one list call per status label, so an item with two stale labels is seen twice).
export function plan(pages) {
  const byNumber = new Map()
  for (const item of pages) {
    const entry = planItem(item)
    if (!entry.closed || entry.stale.length === 0) continue
    const seen = byNumber.get(entry.number)
    if (!seen) byNumber.set(entry.number, { number: entry.number, title: entry.title, stale: [...entry.stale] })
    else for (const name of entry.stale) if (!seen.stale.includes(name)) seen.stale.push(name)
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number)
}

const realGh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 16 << 20 })

// `gh` and `env` are injectable so the whole run can be driven without the network, the way
// merge-gate.mjs is tested.
export function main({ gh = realGh, env = process.env, repo: repoOption, apply: applyOption } = {}) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const apply = applyOption ?? process.argv.includes('--apply')
  const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map(line => JSON.parse(line))

  // One list call per status label: GitHub's `labels=` filter is an AND, so asking for all five at once
  // would only find items that carry all five.
  const pages = STALE_LABELS.flatMap(name => list(`repos/${repo}/issues?state=closed&labels=${encodeURIComponent(name)}&per_page=100`))
  const items = plan(pages)
  const labels = items.reduce((n, item) => n + item.stale.length, 0)
  console.log(`label-hygiene: before: ${items.length} item(s) / ${labels} label(s) not open`)
  for (const item of items) {
    for (const name of item.stale) console.log(`#${item.number} ${item.title} -${name}`)
    if (!apply) continue
    for (const name of item.stale) gh('api', '-X', 'DELETE', `repos/${repo}/issues/${item.number}/labels/${encodeURIComponent(name)}`)
  }
  if (!apply) {
    console.log('label-hygiene: dry run; add --apply to remove these labels')
    return { ok: items.length === 0 || !apply, items, applied: false }
  }
  // Read back rather than assume: the run reports its own result so the cleanup is verified, not trusted.
  const after = plan(STALE_LABELS.flatMap(name => list(`repos/${repo}/issues?state=closed&labels=${encodeURIComponent(name)}&per_page=100`)))
  console.log(`label-hygiene: after: ${after.length} item(s)`)
  if (after.length) {
    console.log(`label-hygiene: STILL STALE: ${after.map(item => `#${item.number} (${item.stale.join(', ')})`).join(', ')}`)
    return { ok: false, items, after, applied: true }
  }
  return { ok: true, items, after, applied: true }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const r = main(); process.exit(r.ok ? 0 : 1) } catch (e) { console.error(`label-hygiene: ${e.message}`); process.exit(1) }
}

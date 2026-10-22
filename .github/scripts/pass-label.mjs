// The `pass` label: a pull request that carried a PASS verdict while it merged keeps a visible trace
// of it (#739). The verdict itself lives only in a comment thread, and `agent-pr` says nothing about
// whether anything was reviewed.
//
//   node .github/scripts/pass-label.mjs --comment     # one new comment: label the PR when it is a PASS
//   node .github/scripts/pass-label.mjs --backfill    # merged pull requests whose head carried a PASS
//
// Both paths read the verdict with `parseReport`, the parser `review-gate.mjs` and `merge-gate.mjs`
// already use, so the fixed format (`Verdict: PASS at <sha>` first line, `Written-by:` second) is read
// the same way everywhere. Three rules keep this a record and not a gate:
//   - only a conclusion from someone GitHub ties to this repository counts (`OWNER`, `MEMBER`,
//     `COLLABORATOR`), and only when its `Written-by:` names someone in the policy's `writers` (#676);
//   - a `Correction from …` comment never labels, because it is text about a conclusion, not one —
//     `parseReport` would happily find the `Verdict:` it quotes;
//   - the label is only ever added. A later INC or a moved tip does not remove it: it records that a
//     PASS was given, and `hold` stays the one manual stop.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReport, loadPolicy } from './review-gate.mjs'

export const PASS_LABEL = 'pass'
export const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const POLICY = '.github/agent/review-policy.json'
const SHORT = 12

const firstLine = (body) => String(body ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''

// Does this body decide that the tip was PASSed? `Correction from …` never does, whatever it quotes.
export function verdictOf(body, { writers = [], association } = {}) {
  if (!ASSOCIATIONS.has(String(association ?? '').toUpperCase())) return null
  if (/^Correction\b/i.test(firstLine(body))) return null
  const report = parseReport(body)
  if (report.verdict !== 'PASS') return null
  if (!report.writer || !writers.includes(report.writer)) return null
  return report
}

// A report and the head it names: the tip may be a prefix (a 12-character sha is the usual form).
export function namesHead(tip, head) {
  if (!tip || !head) return false
  const t = String(tip).toLowerCase()
  const h = String(head).toLowerCase()
  return h.startsWith(t) || t.startsWith(h.slice(0, t.length))
}

// One comment (a comment event's payload) decides for one pull request.
export function planComment({ pr, body, association, writers, labels = [] }) {
  const report = verdictOf(body, { writers, association })
  if (!report) return { add: false, reason: 'not a PASS by a writer the policy lists' }
  if (labels.map((l) => String(l.name ?? l).toLowerCase()).includes(PASS_LABEL)) return { add: false, reason: `already labelled ${PASS_LABEL}` }
  return { add: true, pr, tip: report.tip }
}

// Merged pull requests whose history carries a PASS at the head that merged, and which do not have the
// label yet. `pages` is the raw API data so the whole decision is testable without the network.
export function planBackfill({ pulls, historyOf, writers }) {
  const items = []
  for (const pull of pulls) {
    if (!pull.merged_at) continue
    const labels = (pull.labels ?? []).map((l) => String(l.name ?? l).toLowerCase())
    if (labels.includes(PASS_LABEL)) continue
    const head = pull.head?.sha
    if (!head) continue
    const history = historyOf(pull.number) ?? []
    const pass = history
      .filter((entry) => entry.body && (entry.association ? ASSOCIATIONS.has(String(entry.association).toUpperCase()) : true))
      .map((entry) => ({ at: entry.at ?? '', report: verdictOf(entry.body, { writers, association: entry.association ?? 'MEMBER' }) }))
      .filter((entry) => entry.report && namesHead(entry.report.tip, head))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .pop()
    if (pass) items.push({ number: pull.number, title: pull.title ?? '', tip: pass.report.tip })
  }
  return items.sort((a, b) => a.number - b.number)
}

const realGh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 16 << 20 })
const list = (gh, path) => {
  const out = gh('api', '--paginate', '--jq', '.[]', path)
  return String(out ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// The history of one pull request: its comments and its review bodies, oldest first. A conclusion the
// reviewer wrote as a review counts the same as a comment.
export function historyFrom({ comments = [], reviews = [] }) {
  const rows = [
    ...comments.map((c) => ({ body: c.body, association: c.author_association, at: c.created_at })),
    ...reviews.filter((r) => r.body).map((r) => ({ body: r.body, association: r.author_association, at: r.submitted_at })),
  ]
  return rows.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
}

export function main({ gh = realGh, env = process.env } = {}) {
  const repo = env.GH_REPO
  if (!repo) throw new Error('set GH_REPO')
  const writers = loadPolicy(POLICY).writers ?? []
  const add = (pr) => gh('api', '-X', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=${PASS_LABEL}`)

  if (process.argv.includes('--comment')) {
    const pr = Number(env.PR)
    if (!pr) throw new Error('set PR')
    const plan = planComment({ pr, body: env.COMMENT_BODY ?? '', association: env.ASSOCIATION, writers })
    if (!plan.add) {
      console.log(`pass-label: #${pr} not labelled — ${plan.reason}`)
      return { ok: true, added: [] }
    }
    add(pr)
    console.log(`pass-label: #${pr} labelled ${PASS_LABEL} (PASS at ${plan.tip})`)
    return { ok: true, added: [pr] }
  }

  if (process.argv.includes('--backfill')) {
    const pulls = list(gh, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)
    const historyOf = (number) => historyFrom({
      comments: list(gh, `repos/${repo}/issues/${number}/comments?per_page=100`),
      reviews: list(gh, `repos/${repo}/pulls/${number}/reviews?per_page=100`),
    })
    const items = planBackfill({ pulls, historyOf, writers })
    console.log(`pass-label: backfill: ${items.length} merged pull request(s) carry a PASS at their head and no ${PASS_LABEL}`)
    for (const item of items) {
      console.log(`#${item.number} ${item.title} (PASS at ${String(item.tip).slice(0, SHORT)})`)
      add(item.number)
    }
    return { ok: true, added: items.map((item) => item.number) }
  }

  throw new Error('pass --comment or --backfill')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(`pass-label: ${error.message}`); process.exit(1) }
}

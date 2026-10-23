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
//
// And one rule that keeps the refusal from being silent (#767): a PASS whose `Written-by:` names someone
// the policy does not list is not a conclusion — `review-gate` and `merge-gate` both refuse it — but the
// author who wrote it is told nothing, so the pull request simply never reaches the queue. This job knows
// that answer (it is the same `writers` check the gates make) and throws it away, so it now leaves ONE
// comment naming the author, the tip and the file to fix, and adds no label. The comment carries a marker
// per tip, so a second run adds nothing and a moved tip may speak once about the new one.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReport, loadPolicy } from './review-gate.mjs'

export const PASS_LABEL = 'pass'
export const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
// The marker that makes the note idempotent: one per tip, so a second run on the same tip adds nothing.
export const STRANGER_MARK = '<!-- pass-label: writer-not-listed -->'
const STRANGER_NOTE = /<!-- pass-label: writer-not-listed -->\s+tip:([0-9a-f]{7,40})/i
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

// The gates' refusal seen from the other side: a PASS at a tip whose `Written-by:` names someone the
// policy does not list. `verdictOf` answers `null` for it — that is right for a label and useless for the
// author — so this keeps the stranger's PASS as a value of its own. A missing `Written-by:` line is not
// this case: nothing names a Bot to tell, and the gates' message already covers it.
export function strangerPassOf(body, { writers = [], association } = {}) {
  if (!ASSOCIATIONS.has(String(association ?? '').toUpperCase())) return null
  if (/^Correction\b/i.test(firstLine(body))) return null
  const report = parseReport(body)
  if (report.verdict !== 'PASS' || !report.tip || !report.writer) return null
  const listed = new Set(writers.map((w) => String(w).toLowerCase()))
  if (listed.has(String(report.writer).toLowerCase())) return null
  return { writer: report.writer, tip: report.tip }
}

// The note for one stranger's PASS: who wrote it, which tip it names, and the one edit that makes the
// next one count. It never claims the pull request is unmergeable — a listed writer's PASS still is.
export function strangerCommentBody({ writer, tip }) {
  return `${STRANGER_MARK} tip:${tip}
A PASS at \`${tip}\` was posted with \`Written-by: ${writer}\`, and **${writer} is not in the \`writers\` list** of \`.github/agent/review-policy.json\`, so this conclusion does not count: \`review-gate\` and \`merge-gate\` both refuse it, and a T2/T3 pull request waits for a PASS that cannot arrive while every other check is green.

What makes the next one count: add the name to \`writers\` in \`.github/agent/review-policy.json\`. That file is T3 — the edit goes with the roster test and the owner's approval, not into the reviewing pull request.

This note is left once per tip by the \`pass\` label job, which only records verdicts: it adds no label here and never turns this pull request red.
`
}

// One note per tip, and no note at all unless this really is a stranger's PASS.
export function planStrangerComment({ pr, body, association, writers, comments = [] }) {
  const stranger = strangerPassOf(body, { writers, association })
  if (!stranger) return { add: false, reason: 'not a PASS from a writer the policy does not list' }
  // The same commit may be named by a 12-character tip in one run and by 40 in the next: compare the
  // tips the way `namesHead` compares a report's tip with a head, not as whole strings.
  const noted = comments.some((comment) => {
    const match = STRANGER_NOTE.exec(String(comment?.body ?? comment ?? ''))
    return match !== null && namesHead(match[1], stranger.tip)
  })
  if (noted) return { add: false, reason: `already noted at ${stranger.tip}` }
  return { add: true, pr, tip: stranger.tip, writer: stranger.writer, body: strangerCommentBody(stranger) }
}

// What one `--comment` run does, before any write: the label, else the note, else nothing. `comments`
// is a thunk so the thread is read only when a stranger's PASS actually needs it.
export function planCommentRun({ pr, body, association, writers, labels = [], comments = () => [] }) {
  const label = planComment({ pr, body, association, writers, labels })
  if (label.add) return { write: 'label', pr, tip: label.tip }
  if (!strangerPassOf(body, { writers, association })) return { write: 'none', reason: label.reason }
  const note = planStrangerComment({ pr, body, association, writers, comments: comments() })
  if (note.add) return { write: 'comment', pr, tip: note.tip, writer: note.writer, body: note.body }
  return { write: 'none', reason: `${label.reason}; ${note.reason}` }
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
  const comment = (pr, text) => gh('api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${text}`)

  if (process.argv.includes('--comment')) {
    const pr = Number(env.PR)
    if (!pr) throw new Error('set PR')
    const plan = planCommentRun({
      pr,
      body: env.COMMENT_BODY ?? '',
      association: env.ASSOCIATION,
      writers,
      comments: () => list(gh, `repos/${repo}/issues/${pr}/comments?per_page=100`),
    })
    if (plan.write === 'comment') {
      // The one refusal worth a comment (#767): the gates refuse a stranger's PASS too, and until now
      // only a log line said so. It is left once per tip, and no label is ever added for it.
      comment(pr, plan.body)
      console.log(`pass-label: #${pr} told that ${plan.writer} is not in writers (PASS at ${plan.tip})`)
      return { ok: true, added: [], noted: [pr] }
    }
    if (plan.write === 'none') {
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

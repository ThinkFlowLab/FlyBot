// The reviewed tip of a pull request (Phase 1: report only; see docs/autonomous-dev.md).
//
//   PR=12 GH_REPO=owner/repo GH_TOKEN=... node review-gate.mjs    # what the workflow runs
//   node review-gate.mjs --pr 12 [--repo owner/repo]              # by hand
//   node review-gate.mjs --pr 12 --sha <head>                     # judge another tip
//
// It answers one question: does this pull request's current head carry a Verifier PASS?
// `decide` is the whole rule:
//   - the report is a pull request comment or a review body by a login listed in
//     .github/agent/review-policy.json's `reviewers` (the file the base branch holds);
//   - it is not the pull request author's own report, unless the author is listed in the policy's
//     `selfReview` (owner decision 2026-10-19: the owner's Bot/agent, acting as Birfy, may PASS
//     its own pull requests; any other author still needs someone else);
//   - it carries the Verifier block review-pr already writes, with a `Tip SHA:` that is the
//     head being judged and a `Verdict:`;
//   - the verdict is PASS, the report lists a command it `Ran:`, and it says what was
//     `Not run:` (a report that was not run is not evidence).
// The newest qualifying report that names this tip decides, so a later FAIL at the same tip
// vetoes an earlier PASS. A tip that moves past the report is not reviewed: the old tip is
// not a prefix of the new head and stops counting.
//
// The pull request is read only through the GitHub API; no PR code is checked out or run.
import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SHORT = 12

// The last Verifier block in one body: a comment may hold an earlier review that a later
// one replaced, and only the last block is the verdict the reviewer stands behind.
export function parseReport(body) {
  const lines = String(body ?? '').replace(/[*`]/g, '').split('\n')
  const out = { tip: null, verdict: null, ran: [], hasNotRun: false }
  // The fixed format (#637): the first non-empty line is the whole conclusion,
  // `Verdict: PASS at <sha>` (or INC / REQUEST_CHANGES). The attribution line and the evidence go
  // below it, so a verdict Chief posts for a Reviewer with no write channel parses the same way.
  const firstLine = lines.find((line) => line.trim() !== '') ?? ''
  const first = /^Verdict\s*:\s*(PASS|INC|REQUEST_CHANGES|FAIL)\s+(?:at\s+)?([0-9a-f]{7,40})\s*$/i.exec(firstLine.trim())
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^Tip SHA\s*:/i.test(lines[i].trim())) start = i
  }
  if (first) {
    out.verdict = first[1].toUpperCase()
    out.tip = first[2].toLowerCase()
  }
  // #643, #640: once the first line is the conclusion, the loop below must write neither field again.
  // A body quotes older reports (a `Tip SHA: <sha>` block with an older `Verdict: PASS`), and letting
  // either field through turned an INC at this tip into a PASS, or into a conclusion about some other
  // tip that `decide` then dropped while the PASS it refused came back to life. Both fail open.
  let ranSeen = false
  const firstIsVerdict = first !== null
  // With the first line as the conclusion the evidence is below it, so scan from the top; a
  // legacy body is judged by its last block.
  const from = firstIsVerdict || start < 0 ? 0 : start
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim()
    const tipLine = /^Tip SHA\s*:\s*(.+)$/i.exec(line)
    if (tipLine && !firstIsVerdict) {
      const hex = /[0-9a-f]{7,40}/i.exec(tipLine[1])
      out.tip = hex ? hex[0].toLowerCase() : null
    }
    const verdictLine = /^Verdict\s*:\s*(PASS|FAIL|INC|REQUEST_CHANGES)\b/i.exec(line)
    if (verdictLine && !firstIsVerdict) out.verdict = verdictLine[1].toUpperCase()
    const ranLine = /^Ran\s*:\s*(.*)$/i.exec(line)
    // With the first line as the conclusion, its own `Ran:` is the evidence; a quoted block's
    // `Ran:` below it must not replace it. Without one, the last block wins as it always has.
    if (ranLine && !(firstIsVerdict && ranSeen)) {
      ranSeen = true
      out.ran = []
      if (ranLine[1].trim() && ranLine[1].trim() !== '-') out.ran.push(ranLine[1].trim())
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim()
        if (/^[-•]\s*\S/.test(next)) out.ran.push(next)
        else if (next === '' && out.ran.length) break
        else if (next !== '') break
      }
    }
    if (/^Not run\s*:/i.test(line)) out.hasNotRun = true
  }
  return out
}

const login = (r) => String(r.login ?? '').toLowerCase()
const where = (r) => `${r.kind === 'review' ? 'review' : 'comment'} by ${r.login}`

// reports: [{ login, body, at, kind, id }] from the comments and review bodies of one PR.
export function decide({ head, author, reports, policy }) {
  const headSha = String(head ?? '').toLowerCase()
  const authorLogin = String(author ?? '').toLowerCase()
  const reviewers = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
  const selfReview = new Set((policy?.selfReview ?? []).map((l) => String(l).toLowerCase()))
  const reasons = []
  const judged = []

  for (const r of reports ?? []) {
    const parsed = parseReport(r.body)
    if (!parsed.tip && !parsed.verdict) continue // not a Verifier report
    const entry = { login: r.login, verdict: parsed.verdict, tip: parsed.tip, at: r.at, kind: r.kind, parsed, counts: false }
    judged.push(entry)
    if (!parsed.tip) { reasons.push(`${where(r)}: no Tip SHA`); continue }
    if (!headSha.startsWith(parsed.tip)) {
      reasons.push(`${where(r)}: names ${parsed.tip.slice(0, SHORT)}, not the tip ${headSha.slice(0, SHORT)}`)
      continue
    }
    if (login(r) === authorLogin && !selfReview.has(authorLogin)) { reasons.push(`${where(r)}: the pull request's own author is not a reviewer (not in selfReview)`); continue }
    if (!reviewers.has(login(r))) { reasons.push(`${where(r)}: not a reviewer listed in .github/agent/review-policy.json`); continue }
    entry.counts = true
  }

  const counting = judged.filter((e) => e.counts)
  if (!counting.length) {
    const reason = reviewers.size
      ? reasons.length ? reasons.join('; ') : `no Verifier report names the tip ${headSha.slice(0, SHORT)}`
      : 'no reviewer is listed in .github/agent/review-policy.json'
    return { ok: false, verdict: null, by: null, tip: null, reason, judged }
  }

  // Newest first: the reviewer's latest word at this tip decides. Equal timestamps fall back to
  // the order the API returned them in (oldest first), so the later comment still wins.
  const last = counting
    .map((e, i) => ({ e, i, t: Date.parse(e.at ?? 0) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .at(-1).e
  const { parsed } = last
  if (last.verdict === 'PASS' && !parsed.ran.length) {
    return { ok: false, verdict: 'PASS', by: last.login, tip: last.tip, reason: `${last.login}'s PASS lists no command it ran`, judged }
  }
  if (last.verdict === 'PASS' && !parsed.hasNotRun) {
    return { ok: false, verdict: 'PASS', by: last.login, tip: last.tip, reason: `${last.login}'s PASS has no "Not run:" line`, judged }
  }
  if (last.verdict !== 'PASS') {
    return { ok: false, verdict: last.verdict, by: last.login, tip: last.tip, reason: `${last.login} says ${last.verdict ?? 'nothing'} at this tip`, judged }
  }
  return { ok: true, verdict: 'PASS', by: last.login, tip: last.tip, reason: `${last.login}'s PASS names this tip`, judged }
}

export function render(result, { pr, head, author } = {}) {
  const out = [
    `### Reviewed tip: ${result.ok ? `PASS at ${head.slice(0, SHORT)}` : 'not reviewed'}`,
    '',
    result.ok
      ? `${result.by} passed this tip.`
      : `No PASS names this tip: ${result.reason}.`,
    '',
    `Pull request #${pr}, author ${author}, head \`${String(head).slice(0, SHORT)}\`.`,
  ]
  const seen = result.judged.filter((e) => e.counts || e.verdict)
  if (seen.length) out.push('', 'Verifier reports read:', ...seen.slice(0, 10).map((e) => `- ${e.login} (${e.kind}): ${e.verdict ?? 'no verdict'} at ${(e.tip ?? 'no tip').slice(0, SHORT)}${e.counts ? '' : ' (not counted)'}`))
  out.push('', '_Report only (Phase 1): this does not block, label, approve or merge anything. Rules: `.github/agent/review-policy.json`; see [`docs/autonomous-dev.md`](../../docs/autonomous-dev.md)._')
  return out.join('\n')
}

export function loadPolicy(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })
const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((l) => JSON.parse(l))

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function main() {
  const policyPath = arg('--policy') || process.env.REVIEW_POLICY || fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))
  const repo = arg('--repo') || process.env.GH_REPO
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N')

  const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const head = arg('--sha') || pull.head?.sha
  const author = pull.user?.login
  if (!head) throw new Error(`pull request ${pr} has no head sha`)

  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, body: c.body, at: c.created_at, url: c.html_url })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, body: v.body, at: v.submitted_at, url: v.html_url })),
  ]

  const result = decide({ head, author, reports, policy: loadPolicy(policyPath) })
  console.log(`review-gate (report only): PR #${pr} tip ${String(head).slice(0, SHORT)} — ${result.ok ? `PASS by ${result.by}` : result.reason}`)
  const text = render(result, { pr, head, author })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(`review-gate: ${e.message}`); process.exit(1) }
}

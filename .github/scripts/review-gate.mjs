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
//   - it names its writer in the header: `Written-by: <Bot>` (the older prose `Written by: …` reads
//     the same way) with a name from the policy's `writers`, or it refuses — a missing line and an
//     unknown name are separate refusals (#627);
//   - the verdict is PASS and the report lists a command it `Ran:` (a `- ` bullet, or a `$ ` line in a
//     fenced block under a `Ran …:` heading): a report that ran nothing is not evidence.
//   - `Not run:` is recommended but not checked (owner decision 2026-10-22 09:57 Asia/Shanghai, #667):
//     `hasNotRun` is still parsed for the summary, and a PASS without it is not refused.
// The newest qualifying report that names this tip decides, so a later FAIL at the same tip
// vetoes an earlier PASS. A tip that moves past the report is not reviewed: the old tip is
// not a prefix of the new head and stops counting.
//
// The pull request is read only through the GitHub API; no PR code is checked out or run.
import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SHORT = 12
// #676: a conclusion is read only from someone GitHub ties to this repository. The fail-closed rule
// above makes any newest conclusion refuse, so without this an outside comment saying `Verdict: INC`
// could hold a merge. A comment from anyone else is not a conclusion: it can neither pass nor block.
const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// The last Verifier block in one body: a comment may hold an earlier review that a later
// one replaced, and only the last block is the verdict the reviewer stands behind.
export function parseReport(body) {
  // `raw` keeps the backticks so a fenced block can be found; `lines` is the same text without the
  // markdown emphasis, line for line, for everything else.
  const raw = String(body ?? '').split('\n')
  const lines = raw.map((line) => line.replace(/[*`]/g, ''))
  const out = { tip: null, verdict: null, ran: [], hasNotRun: false, writer: null }
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
    // `Ran: <command>`, or a heading such as `Ran at this tip (tarball of the tip):` — the shape the
    // reviewer actually writes (#660-#663: every one of those PASSes refused as "lists no command"
    // because only a bare `Ran:` was read). A longer heading is only a heading: words after its colon
    // are not a command, so prose like "Ran into a problem: …" proves nothing.
    const ranLine = /^Ran\b([^:\n]*):\s*(.*)$/i.exec(line)
    // With the first line as the conclusion, its own `Ran:` is the evidence; a quoted block's
    // `Ran:` below it must not replace it. Without one, the last block wins as it always has.
    if (ranLine && !(firstIsVerdict && ranSeen)) {
      ranSeen = true
      out.ran = ranCommands(raw, lines, i, ranLine[1].trim() === '' ? ranLine[2].trim() : '')
    }
    if (/^Not run\b[^:\n]*:/i.test(line)) out.hasNotRun = true
  }
  out.writer = parseWriter(lines)
  return out
}

// #627: the attribution line, `Written-by: <Bot>` (the older prose `Written by: Reviewer. Posted by:
// …` reads the same way). Only the header is read — the first few non-empty lines — so a report that
// arrives without one does not borrow a writer from a block it quotes further down.
const HEADER_LINES = 3
function parseWriter(lines) {
  let seen = 0
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    if (++seen > HEADER_LINES) break
    const written = /^Written[- ]by\s*:\s*(.+)$/i.exec(text)
    // The first clause is the name: `Reviewer. Posted by: Chief (proxy…)` names Reviewer.
    if (written) return written[1].split(/[.,(;]/)[0].trim() || null
  }
  return null
}

// The commands under a `Ran` heading at line `at`: the inline text of a bare `Ran: <command>` (never
// an empty one or `-`), then either the `- ` bullets that follow, or the `$ ` lines of the fenced
// block that follows. Output lines in the block are not commands, so a block with no `$ ` line, or
// `$` alone, lists nothing and the PASS refuses as before.
function ranCommands(raw, lines, at, inline) {
  const ran = inline && inline !== '-' ? [inline] : []
  let j = at + 1
  // Blank in the raw text: a bare ``` fence line is empty once the backticks are stripped.
  while (j < raw.length && raw[j].trim() === '') j++
  if (j < raw.length && /^\s*(```|~~~)/.test(raw[j])) {
    const fence = /^\s*(```|~~~)/.exec(raw[j])[1]
    for (j += 1; j < raw.length && !raw[j].trim().startsWith(fence); j++) {
      const cmd = /^\$\s+(\S.*)$/.exec(raw[j].trim())
      if (cmd) ran.push(cmd[1].trim())
    }
    return ran
  }
  for (; j < lines.length; j++) {
    const next = lines[j].trim()
    if (/^[-•]\s*\S/.test(next) && next !== '-') ran.push(next)
    else break
  }
  return ran
}

const login = (r) => String(r.login ?? '').toLowerCase()
const where = (r) => `${r.kind === 'review' ? 'review' : 'comment'} by ${r.login}`

// reports: [{ login, body, at, kind, id }] from the comments and review bodies of one PR.
export function decide({ head, author, reports, policy }) {
  const headSha = String(head ?? '').toLowerCase()
  const authorLogin = String(author ?? '').toLowerCase()
  const reviewers = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
  const selfReview = new Set((policy?.selfReview ?? []).map((l) => String(l).toLowerCase()))
  const writers = new Set((policy?.writers ?? []).map((w) => String(w).toLowerCase()))
  const reasons = [] // reports that do not name this tip at all
  const judged = []
  const atTip = [] // conclusions that name this tip, valid or not, in the order the API returned them

  for (const r of reports ?? []) {
    const parsed = parseReport(r.body)
    if (!parsed.tip && !parsed.verdict) continue // not a Verifier report
    const entry = { login: r.login, verdict: parsed.verdict, tip: parsed.tip, at: r.at, kind: r.kind, writer: parsed.writer, parsed, counts: false, why: null }
    judged.push(entry)
    if (!parsed.tip) { reasons.push(`${where(r)}: no Tip SHA`); continue }
    if (!headSha.startsWith(parsed.tip)) {
      reasons.push(`${where(r)}: names ${parsed.tip.slice(0, SHORT)}, not the tip ${headSha.slice(0, SHORT)}`)
      continue
    }
    if (!parsed.verdict) continue // a `Tip SHA` block with no verdict is not a conclusion
    const association = String(r.association ?? '').toUpperCase()
    if (!ASSOCIATIONS.has(association)) {
      reasons.push(`${where(r)}: author association ${association || 'missing'} is not OWNER, MEMBER or COLLABORATOR, so it is not a conclusion`)
      continue
    }
    // #676: a conclusion at this tip belongs to the newest-word question even when it fails a check
    // below, so it joins `atTip` carrying its reason instead of being dropped. Dropping it made a
    // newer refusal invisible: an INC with no `Written-by:` line left an older PASS in force, and a
    // human REQUEST_CHANGES from an unlisted login did the same.
    atTip.push(entry)
    // #627: a *conclusion* has to say who wrote it, refused on two separate grounds — a report with no
    // attribution line and one that names a writer the policy does not list are different defects, and
    // the log has to say which one fired. Both fail closed. An ordinary comment is not a conclusion, so
    // a missing line is not held against it. With one shared GitHub identity the line is a self-report,
    // so this buys presence and a name from a closed list, not proof (#633).
    if (!parsed.writer) { entry.why = `${where(r)}: no Written-by line naming its writer`; continue }
    if (!writers.has(parsed.writer.toLowerCase())) { entry.why = `${where(r)}: Written-by names "${parsed.writer}", who is not in the writers list of .github/agent/review-policy.json`; continue }
    if (login(r) === authorLogin && !selfReview.has(authorLogin)) { entry.why = `${where(r)}: the pull request's own author is not a reviewer (not in selfReview)`; continue }
    if (!reviewers.has(login(r))) { entry.why = `${where(r)}: not a reviewer listed in .github/agent/review-policy.json`; continue }
    entry.counts = true
  }

  if (!reviewers.size) return { ok: false, verdict: null, by: null, tip: null, reason: 'no reviewer is listed in .github/agent/review-policy.json', judged }
  if (!atTip.length) {
    const reason = reasons.length ? reasons.join('; ') : `no Verifier report names the tip ${headSha.slice(0, SHORT)}`
    return { ok: false, verdict: null, by: null, tip: null, reason, judged }
  }

  // The newest word at this tip decides, and that includes a conclusion the checks refused: an invalid
  // PASS is not evidence, and an invalid INC is still someone saying not to merge (#676). Equal
  // timestamps fall back to the order the API returned them in (oldest first), so the later one wins.
  const last = atTip
    .map((e, i) => ({ e, i, t: Date.parse(e.at ?? 0) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .at(-1).e
  if (!last.counts) return { ok: false, verdict: last.verdict, by: null, tip: last.tip, reason: last.why, judged }
  const { parsed } = last
  if (last.verdict !== 'PASS') {
    return { ok: false, verdict: last.verdict, by: last.login, tip: last.tip, reason: `${last.login} says ${last.verdict ?? 'nothing'} at this tip`, judged }
  }
  if (!parsed.ran.length) {
    return { ok: false, verdict: 'PASS', by: last.login, tip: last.tip, reason: `${last.login}'s PASS lists no command it ran`, judged }
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
  if (seen.length) out.push('', 'Verifier reports read:', ...seen.slice(0, 10).map((e) => `- ${e.login} (${e.kind}): ${e.verdict ?? 'no verdict'} at ${(e.tip ?? 'no tip').slice(0, SHORT)}, written-by ${e.writer ?? 'nothing'}${e.counts ? '' : ' (not counted)'}`))
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
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, body: c.body, at: c.created_at, association: c.author_association, url: c.html_url })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, body: v.body, at: v.submitted_at, association: v.author_association, url: v.html_url })),
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

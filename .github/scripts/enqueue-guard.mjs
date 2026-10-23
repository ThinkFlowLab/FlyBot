// The enqueue guard (#602; the rules are AGENTS.md → Merge gates).
//
//   node .github/scripts/enqueue-guard.mjs --pr 566 [--repo owner/repo] [--sha <head>]
//
// Nothing under `.github/scripts/` enqueues anything today: the queue call is an instruction to the
// gating agent (AGENTS.md step 6, `.claude/skills/fix-issue` → Merge, `docs/autonomous-dev.md` → How
// to merge): `gh pr merge <n> --auto --squash --match-head-commit <sha>`. That gap is #602: #566 was
// enqueued 10 s after its PASS while the standing instruction was "parked — do not merge", and the
// only check for `hold` ran on the queue entry, after it was already in the queue (merge-gate.yml;
// #639 tracks making that check required).
//
// So this is the step immediately before that call. It refuses — exit 1, the reason printed — when
// the pull request carries `hold`, when the newest conclusion at its head is not a PASS, or when that
// conclusion is itself marked "record only — do not merge". It also refuses a pull request that names
// no issue in its body or carries no `agent-pr` label (#718; a mechanical release PR and a fork are
// exempt), so
// "one issue, one pull request" is checked rather than remembered. It reuses `judge({ mode: 'queue' })`, so
// "may this enter the queue" keeps one definition: a rule added to the merge gate is enforced here
// without being restated, unless someone deliberately changes both.
//
// It never enqueues and never merges: on success it prints the exact command and exits 0, and the
// agent that gated the pull request runs it. `hold` is a label and a label carries no signature
// (#627), so this guard is not a security boundary — it is the routine's own check, kept in the
// routine's path rather than left to a check that reports after the queue is reached.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isMechanicalRelease, judge } from './merge-gate.mjs'
import { loadPolicy, parseReport } from './review-gate.mjs'

const SHORT = 12
// AGENTS.md → Merge gates rule 2: the `hold` label is paired with a comment saying
// "Record only — do not merge / 仅记录、禁止入队". The label can be removed or forgotten; the record
// must still keep the pull request out of the queue.
//
// The marker is a whole line, not a phrase somewhere in the text: a PASS that explains the rule — the
// first real one wrote `- \`RECORD_ONLY\` matches … a record written only in Chinese would not keep the
// pull request out` — must not freeze itself (#687). A bullet or a quote line is allowed, but nothing
// may follow the marker on it except its other language half.
const RECORD_ONLY = /^[\s>*+-]*(?:record only\s*[—–-]+\s*do not (?:merge|queue)(?:\s*[/／]\s*仅记录[、,，]?\s*禁止入队)?|仅记录[、,，]?\s*禁止入队)\s*[.。]?\s*$/im
// AGENTS.md → Claim: a pull request says `Fixes #N` in its body, and one issue carries one pull request.
// #718: a pull request with no issue behind it, or with no `agent-pr` label, is not the routine's work at
// all — #711/#712/#713 arrived with neither and nothing refused them, because the guard only looked at
// `hold`, the conclusions and the diff. The reference is a line of its own, so prose about "fixes" does
// not pass; the spellings accepted are exactly `Fixes #<n>` and `Closes #<n>`, behind any `#`, `>` or `-`.
// The rules only hold where the branch is ours: a fork is exempt, because we cannot push to its head
// and the owner keeps their own workflow there (#711/#713).
const ISSUE_REF = /^[\s>#-]*(?:fixes|closes)\s*#\d+/im
const short = (s) => String(s ?? '').slice(0, SHORT)
const labelNames = (labels) => (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())

// The newest conclusion that names this head, if it carries the record-only marker. Only a body that
// parses as a conclusion counts, so ordinary prose quoting the phrase is no marker; only the newest
// one counts, so a fresh PASS at the same head supersedes an older parked report.
export function recordOnlyAt(reports, head) {
  const target = String(head ?? '').toLowerCase()
  if (!target) return null
  const at = (reports ?? [])
    .map((r, i) => ({ r, i, parsed: parseReport(r.body) }))
    .filter(({ parsed }) => parsed.verdict && parsed.tip && target.startsWith(parsed.tip))
    .map((x) => ({ ...x, t: Date.parse(x.r.at ?? 0) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
  const last = at.at(-1)
  return last && RECORD_ONLY.test(String(last.r.body ?? '')) ? last.r : null
}

// The decision, without the network: `result` is merge-gate's `judge` output for this head.
export function guard({ pr, head, labels, body, mechanicalRelease, fork, result, reports }) {
  const quiet = recordOnlyAt(reports, result.head ?? head)
  const reasons = [...result.reasons]
  if (quiet) reasons.push('the newest conclusion at this head says "record only — do not merge"')
  // Two exemptions, both about what the pull request is rather than how risky it is. A mechanical release
  // PR carries neither an issue nor the label by design — it is the routine's own daily output under the
  // standing approval (AGENTS.md 6). A fork is not ours: its head cannot be pushed by us, and the owner runs
  // their own workflow there (#711/#713). `result.exempt` cannot stand in for either: it is true for T0/T1
  // as well, and routine work still names its issue.
  if (!mechanicalRelease && !fork) {
    if (!ISSUE_REF.test(String(body ?? ''))) reasons.push('no issue reference in the pull request body: add "Fixes #<n>"')
    if (!labelNames(labels).includes('agent-pr')) reasons.push('missing label: agent-pr')
  }
  const ok = result.ok && !quiet && reasons.length === 0
  return {
    ...result,
    ok,
    reasons,
    recordOnly: Boolean(quiet),
    mechanicalRelease: Boolean(mechanicalRelease),
    fork: Boolean(fork),
    labels: labels ?? [],
    // One loud sentence: a refusal says what to do ("do not enqueue") and why, so it cannot be read
    // as a warning that some other step may override.
    message: ok
      ? `enqueue #${pr}: no \`hold\` and the gate passes`
      : `do not enqueue #${pr}: ${reasons.join('; ')}`,
    command: `gh pr merge ${pr} --auto --squash --match-head-commit ${result.head ?? head}`,
  }
}

const realGh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

// `gh` and `env` are injectable so a test drives the whole check without the network, the way
// merge-gate.mjs does.
export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption } = {}) {
  const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const pr = prOption || arg('--pr') || env.PR
  if (!pr) throw new Error('set PR or pass --pr N')
  const policyPath = arg('--policy') || env.REVIEW_POLICY || fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))

  const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const head = pull.head?.sha
  if (!head) throw new Error(`pull request ${pr} has no head sha`)
  const labels = (pull.labels ?? []).map((l) => l.name)
  // #676: the association travels with the report, the way review-gate.mjs reads the same two APIs. Without
  // it every conclusion is refused as "not tied to this repository", so a PASS could never clear the guard.
  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, body: c.body, at: c.created_at, association: c.author_association })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, body: v.body, at: v.submitted_at, association: v.author_association })),
  ]
  const files = list(`repos/${repo}/pulls/${pr}/files?per_page=100`)

  // The live head is judged, never a cached one: a push that moved the tip voids the PASS the caller
  // believes it has, and `--sha` lets a caller insist on the head it read a moment ago.
  const result = judge({ labels, files, head, author: pull.user?.login, reports, policy: loadPolicy(policyPath), expectedHead: arg('--sha'), mode: 'queue' })
  const mechanicalRelease = isMechanicalRelease(files.map((f) => f.filename))
  // The branch this repository owns, not a contributor's: `head.repo` is null when the fork was deleted,
  // which is not ours either. Both sides are lower-cased because the repository name in the API paths is
  // case-insensitive: `--repo thinkflowlab/flybot` used to read our own branch as a fork and print ALLOW.
  const fork = String(pull.head?.repo?.full_name ?? '').toLowerCase() !== String(repo).toLowerCase()
  const decision = guard({ pr, head, labels, body: pull.body, mechanicalRelease, fork, result, reports })

  console.log(`enqueue-guard: PR #${pr} head ${short(decision.head)}, labels [${labels.join(', ')}]`)
  console.log(decision.ok
    ? `enqueue-guard: ALLOW — ${decision.message}; ${decision.exempt ? `a ${decision.tier ?? 'T0/T1'} tier or a mechanical release PR (AGENTS.md 6)` : `${decision.verdict?.by}'s PASS names this tip`}`
    : `enqueue-guard: REFUSE — ${decision.message}`)
  if (decision.ok) {
    console.log('enqueue-guard: this guard never enqueues; run the command yourself, now:')
    console.log(`  ${decision.command}`)
  }
  return decision
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const decision = main(); process.exit(decision.ok ? 0 : 1) } catch (e) { console.error(`enqueue-guard: ${e.message}`); process.exit(1) }
}

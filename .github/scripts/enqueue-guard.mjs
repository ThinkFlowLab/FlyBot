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
// The issue is not always in this repository: a pull request opened in the code fork names the upstream
// one in full (`Fixes ThinkFlowLab/FlyBot#801`), and a bare `#801` there points at a number the fork does
// not have. Both spellings are accepted, and the repository part is not compared with anything — the guard
// asks "does this pull request name an issue at all"; one issue carrying one pull request is the gate's
// report, not this regex's job.
// The rules only hold where the branch is ours: a fork is exempt, because we cannot push to its head
// and the owner keeps their own workflow there (#711/#713).
const ISSUE_REF = /^[\s>#-]*(?:fixes|closes)\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+/im
// #943: the body says who owns the pull request and who reviews it. `Owner:`/`Reviewer:` were a
// sentence in AGENTS.md that nothing read: #940 went from opened to merged in about seven minutes with
// the largest diff of the day, and its body carried neither line.
//
// The first 20 lines, not the first two: an agent's body opens with its own HTML comment (the open #941
// carries `Owner:` on line 4), and a check that only read the top would refuse every one of them.
const HEADER_LINES = 20
const OWNER_LINE = /^\s*Owner:/i
const REVIEWER_LINE = /^\s*Reviewer:/i
const short = (s) => String(s ?? '').slice(0, SHORT)
const labelNames = (labels) => (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())

// The refusal names the line, not just the defect, so the fix is "add this line" rather than "something
// about the body". A `Reviewer:` line with no value names nobody, which is the same defect as a missing
// line: the queue is meant to know who reviews, not to see the word.
//
// #947: `Reviewer:` names a workstation, so it speaks the vocabulary of `Written-by:` — the policy's
// `writers` Bot names, which is the only thing our pull requests ever wrote there — and the `reviewers`
// logins stay accepted, because the shared account is a login too. Checking the login list alone refused
// every pull request we open, #941 among them: `Reviewer: Reviewer2` came back "not in reviewers" while
// `reviewers` holds accounts, not workstations. A value is one name from either list, with or without a
// leading `@`, compared case-insensitively.
//
// Being listed is not the same as being able to review, and the line has to name at least one of the
// second kind, or "a Bot name" becomes a way around the list. A login in `reviewers` can record a PASS.
// A Bot name can only through the one identity every Bot writes as, `Birfy`, so it names a reviewer only
// while that account is in `reviewers`; with it gone the name is vocabulary and the line is refused.
const SHARED_WRITE_LOGIN = 'Birfy'
// One line's names: split on commas, strip a leading `@`, compare case-insensitively. Both header lines
// read their values this way so `@Dev`, `dev` and `DEV` are one name wherever they appear (#951).
const headerNames = (line, pattern) => line.replace(pattern, '').split(',').map((value) => value.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
function headerReasons(body, policy) {
  const lines = String(body ?? '').split(/\r?\n/).slice(0, HEADER_LINES)
  const reasons = []
  const owner = lines.find((line) => OWNER_LINE.test(line))
  if (!owner) reasons.push('missing line: Owner:')
  const owners = new Set(owner ? headerNames(owner, OWNER_LINE) : [])
  const reviewer = lines.find((line) => REVIEWER_LINE.test(line))
  if (!reviewer) reasons.push('missing line: Reviewer:')
  else {
    const names = headerNames(reviewer, REVIEWER_LINE)
    if (!names.length) reasons.push('missing line: Reviewer:')
    const logins = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
    const bots = new Set((policy?.writers ?? []).map((w) => String(w).toLowerCase()))
    const sharedLogin = logins.has(SHARED_WRITE_LOGIN.toLowerCase())
    let passable = false
    for (const name of names) {
      if (logins.has(name)) {
        passable = true
        continue
      }
      if (bots.has(name)) {
        if (sharedLogin) passable = true
        continue
      }
      // Neither list: say both, so the reader knows which two vocabularies were tried rather than
      // being sent to fix a spelling that was never the problem.
      reasons.push(`Reviewer names "${name}", who is not a reviewers login`)
      reasons.push(`Reviewer names "${name}", who is not a writers Bot name`)
    }
    // #951: the two lines are two roles. Reading them separately let one Bot own and review the same pull
    // request — `Reviewer: Dev` passed on `Dev` being a `writers` name — which is the shape #940 had with
    // no lines at all. The comparison is per name, so a list that overlaps in either direction refuses.
    for (const name of names) {
      if (owners.has(name)) reasons.push(`Reviewer names "${name}", who is also the Owner of this pull request`)
    }
    // Every name is a known Bot name and none of them can pass: refused, because the line would
    // otherwise read as reviewed.
    if (names.length && !passable && !reasons.length) {
      const named = names.map((name) => `"${name}"`).join(', ')
      reasons.push(`Reviewer names ${named}, who ${names.length === 1 ? 'is a writers Bot name but cannot record a Verdict here' : 'are writers Bot names but cannot record a Verdict here'}: every Bot writes as "${SHARED_WRITE_LOGIN}", which is not in reviewers`)
    }
  }
  return reasons
}

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
export function guard({ pr, head, labels, body, mechanicalRelease, fork, draft, merged, result, reports, policy }) {
  const quiet = recordOnlyAt(reports, result.head ?? head)
  const reasons = [...result.reasons]
  if (quiet) reasons.push('the newest conclusion at this head says "record only — do not merge"')
  // Two exemptions, both about what the pull request is rather than how risky it is. A mechanical release
  // PR carries neither an issue nor the label by design — it is the routine's own daily output under the
  // standing approval (AGENTS.md 6). A fork is not ours: its head cannot be pushed by us, and the owner runs
  // their own workflow there (#711/#713). `result.exempt` cannot stand in for either: it is true for T0/T1
  // as well, and routine work still names its issue.
  if (!mechanicalRelease && !fork) {
    if (!ISSUE_REF.test(String(body ?? ''))) reasons.push('no issue reference in the pull request body: add "Fixes #<n>" or "Fixes owner/repo#<n>"')
    if (!labelNames(labels).includes('agent-pr')) reasons.push('missing label: agent-pr')
    // #943: only a request to enter the queue. A draft is not entering it, and a merged pull request is
    // never re-judged: this check runs again on every comment (enqueue-guard.yml), so without the second
    // half a sentence on an old merged pull request would turn its check red over a body nobody can edit
    // any more (#926, #925, #908 and others merged without these lines).
    if (!draft && !merged) reasons.push(...headerReasons(body, policy))
  }
  const ok = result.ok && !quiet && reasons.length === 0
  return {
    ...result,
    ok,
    reasons,
    recordOnly: Boolean(quiet),
    mechanicalRelease: Boolean(mechanicalRelease),
    fork: Boolean(fork),
    draft: Boolean(draft),
    merged: Boolean(merged),
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

// The decision for one pull request, read live: the single place that reads the pull request, its
// conclusions and its diff, and calls `judge` + `guard`. `main` below prints it (the command an agent
// runs); `gate-check.mjs` turns the same object into the `enqueue-guard` check run the ruleset requires
// (#812). One function with two readers, so the check and the printed command cannot disagree — #812's
// kill condition is a second copy of these rules, and there is none.
export function decidePull({ gh = realGh, env = process.env, repo: repoOption, pr: prOption, expectedHead } = {}) {
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
  // #943: the account type travels too, for the same reason — a bot account writes no conclusion.
  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, type: c.user?.type, body: c.body, at: c.created_at, association: c.author_association })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, type: v.user?.type, body: v.body, at: v.submitted_at, association: v.author_association })),
  ]
  const files = list(`repos/${repo}/pulls/${pr}/files?per_page=100`)

  // The live head is judged, never a cached one: a push that moved the tip voids the PASS the caller
  // believes it has, and `--sha` lets a caller insist on the head it read a moment ago.
  // `judge` asks `adminsFor` when this tier needs a PASS.
  const policy = loadPolicy(policyPath)
  const result = judge({ labels, files, head, author: pull.user?.login, reports, policy, gh, repo, expectedHead: expectedHead ?? arg('--sha'), mode: 'queue' })
  const mechanicalRelease = isMechanicalRelease(files.map((f) => f.filename))
  // The branch this repository owns, not a contributor's: `head.repo` is null when the fork was deleted,
  // which is not ours either. Both sides are lower-cased because the repository name in the API paths is
  // case-insensitive: `--repo thinkflowlab/flybot` used to read our own branch as a fork and print ALLOW.
  const fork = String(pull.head?.repo?.full_name ?? '').toLowerCase() !== String(repo).toLowerCase()
  const decision = guard({ pr, head, labels, body: pull.body, mechanicalRelease, fork, draft: pull.draft, merged: pull.merged, result, reports, policy })
  return { decision, pull, repo, pr }
}

// The printed form: the guard's own ALLOW/REFUSE line, then the command to run.
export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption } = {}) {
  const { decision, pull, pr } = decidePull({ gh, env, repo: repoOption, pr: prOption })
  const labels = (pull.labels ?? []).map((l) => l.name)
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

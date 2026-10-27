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
// conclusion is itself marked "record only — do not merge". A PASS whose GitHub login is the pull
// request author counts only with an `Attestation:` line (#644); `judge` reads that from `decide`.
// It also refuses a pull request that names
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
import { loadPolicy } from './review-gate.mjs'
import { loadSigners } from './verdict-signature.mjs'
import { guard, recordOnlyAt, short } from './enqueue-rules.mjs'

// The rule bodies moved to enqueue-rules.mjs (#960); re-exported here because this is the module the
// scripts and tests already import.
export { guard, recordOnlyAt }

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
// #1344 (owner decision 2026-10-27): a branch an external agent owns is frozen while its write access is
// unresolved, and the list of what that means is a file on the base branch, not code: the owner peels the
// seal off by editing or deleting one JSON document, with no release of this script. The list is read at the
// pull request's BASE commit, never its head — a branch that carries its own copy could empty the list and
// un-freeze itself (#1346's shape) — and a pull request that edits the document is refused outright, so
// "edit the seal from inside" is closed too. This is a queue-entry seal, not a permission boundary: a direct
// push or an admin merge is unaffected, and the shared `Birfy` token can edit the file on `main`.
const FROZEN_PATH = '.github/agent/frozen-branches.json'
const FROZEN_REASON = 'frozen: external agent branch; owner decision pending'
const FROZEN_EDIT_REASON = 'frozen: .github/agent/frozen-branches.json is not editable by a pull request'

// Missing file, unreadable file, empty arrays: nothing is frozen. A broken read must not stop the whole
// queue, and the seal is meant to be removable — both point the same way here.
function frozenList({ gh, repo, base }) {
  const out = { branches: [], markers: [] }
  if (!base) return out
  try {
    const body = JSON.parse(gh('api', `repos/${repo}/contents/${FROZEN_PATH}?ref=${base}`))
    const config = JSON.parse(Buffer.from(String(body?.content ?? ''), 'base64').toString('utf8'))
    for (const key of ['branches', 'markers']) {
      if (Array.isArray(config?.[key])) out[key] = config[key].map((v) => String(v).toLowerCase()).filter(Boolean)
    }
  } catch {
    // no list, no seal
  }
  return out
}

// The refusal this file exists for, or `null`: the head branch starts with a listed prefix, the body carries
// a listed marker, or the diff edits the list itself. `merged` is history and is never re-judged (#943).
function frozenRefusal({ gh, repo, pull, files }) {
  // #1350: `merged` is answered before the list is read, and before the edit check below — the guard runs
  // again on every event (`labeled` above all), and a merged pull request that edited this file has already
  // made its edit. Judged after it, that run goes red on a merge nobody can undo, which is the opposite of
  // what "never re-judged" means. The edit check still refuses every unmerged pull request.
  if (pull?.merged) return null
  const touched = (files ?? []).find((f) => f && f.filename === FROZEN_PATH)
  // An ADD is how the seal first arrives (this very pull request). A modify or a delete is the self-unlock
  // this rule closes, whatever the branch is.
  if (touched && touched.status !== 'added') return FROZEN_EDIT_REASON
  const list = frozenList({ gh, repo, base: pull?.base?.sha })
  const branch = String(pull?.head?.ref ?? '').toLowerCase()
  const body = String(pull?.body ?? '').toLowerCase()
  if (list.branches.some((prefix) => branch.startsWith(prefix))) return FROZEN_REASON
  if (list.markers.some((marker) => body.includes(marker))) return FROZEN_REASON
  return null
}

export function decidePull({ gh = realGh, env = process.env, repo: repoOption, pr: prOption, expectedHead, sameChangeSet } = {}) {
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
  // #1112: each report carries the id GitHub gave it, so the summary can name the one the decision used.
  // With one shared account the id is the only handle on a conclusion that is not a person or a word.
  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ id: c.id, kind: 'comment', login: c.user?.login, type: c.user?.type, body: c.body, at: c.created_at, association: c.author_association })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ id: v.id, kind: 'review', login: v.user?.login, type: v.user?.type, body: v.body, at: v.submitted_at, association: v.author_association })),
  ]
  const files = list(`repos/${repo}/pulls/${pr}/files?per_page=100`)
  // #1112: the head is read again after the comments and the diff. A push in the middle of this run
  // would otherwise let the decision judge one head and print another — the shape in which a pull
  // request that was PASSed once is pushed again and merges with no conclusion at the new tip. A
  // moved head is refused rather than resolved: both reads are stale by the time the second lands.
  const again = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const moved = again.head?.sha
  if (moved && moved !== head) throw new Error(`the head moved during this run (${short(head)} to ${short(moved)}); run it again and judge the head it prints`)

  // The live head is judged, never a cached one: a push that moved the tip voids the PASS the caller
  // believes it has, and `--sha` lets a caller insist on the head it read a moment ago.
  // `judge` asks `adminsFor` when this tier needs a PASS.
  const policy = loadPolicy(policyPath)
  // #1110: the same keys `merge-gate` reads, so the check and the printed command cannot disagree.
  const signers = loadSigners({ policy, path: arg('--signers') || env.VERDICT_SIGNERS || fileURLToPath(new URL('../agent/signers.json', import.meta.url)) })
  const result = judge({ labels, files, head, author: pull.user?.login, reports, policy, gh, repo, pr, signers, expectedHead: expectedHead ?? arg('--sha'), mode: 'queue', body: pull.body, sameChangeSet })
  const mechanicalRelease = isMechanicalRelease(files.map((f) => f.filename))
  // The branch this repository owns, not a contributor's: `head.repo` is null when the fork was deleted,
  // which is not ours either. Both sides are lower-cased because the repository name in the API paths is
  // case-insensitive: `--repo thinkflowlab/flybot` used to read our own branch as a fork and print ALLOW.
  const fork = String(pull.head?.repo?.full_name ?? '').toLowerCase() !== String(repo).toLowerCase()
  const decision = guard({ pr, head, labels, body: pull.body, files: files.map((f) => f.filename), mechanicalRelease, fork, draft: pull.draft, merged: pull.merged, result, reports, policy })
  // #1344: the seal answers before anything else can allow the entry — a well-formed PASS at the tip, an
  // `agent-pr` label and a clean body change nothing here.
  const frozen = frozenRefusal({ gh, repo, pull, files })
  if (frozen) {
    return {
      decision: { ...decision, ok: false, reasons: [frozen], reason: frozen, message: `do not enqueue #${pr}: ${frozen}` },
      pull,
      repo,
      pr,
    }
  }
  return { decision, pull, repo, pr }
}

// The printed form: the guard's own ALLOW/REFUSE line, then the command to run.
export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption } = {}) {
  const { decision, pull, pr } = decidePull({ gh, env, repo: repoOption, pr: prOption })
  const labels = (pull.labels ?? []).map((l) => l.name)
  // #1112: the full 40-character sha, from the value the decision consumed. The short form let a reader
  // compare it against a summary that named a different head and still look right.
  console.log(`enqueue-guard: PR #${pr} head ${decision.head}, labels [${labels.join(', ')}]`)
  const used = decision.verdict?.id ? `${decision.verdict.kind ?? 'comment'} ${decision.verdict.id}` : 'no conclusion'
  console.log(`enqueue-guard: conclusion used: ${used}${decision.verdict?.by ? ` by ${decision.verdict.by}` : ''}${decision.verdict?.tip ? ` naming ${decision.verdict.tip}` : ''}`)
  console.log(decision.ok
    ? `enqueue-guard: ALLOW — ${decision.message}; ${decision.exempt ? `a ${decision.tier ?? 'T0/T1'} tier or a mechanical release PR (AGENTS.md 6)` : decision.verdict?.carried ? 'the change set is the one that PASS names, so the tip moved without changing it' : `${decision.verdict?.by}'s PASS names this tip`}`
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

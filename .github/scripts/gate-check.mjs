// The merge gate GitHub enforces, not just a script (#812).
//
// `enqueue-guard.mjs` decides whether a pull request may merge and prints the command; nothing ran it
// before a person merged, and on the code fork `Birfy/FlyBot`, where every routine pull request lands,
// `main` had no ruleset and no branch protection — so a PASS was advisory and #30 merged without
// `agent-pr`. This script writes that same decision onto the pull request head as a check run named
// `enqueue-guard`, the context the ruleset on `main` requires; with no bypass actor, an unreviewed
// pull request cannot be squash-merged through the API at all.
//
// It decides nothing itself: `decidePull` in enqueue-guard.mjs is called, and inside it the merge
// gate's `judge`. A second copy of the rules is #812's kill condition, so there is none — the check and
// the command the guard prints come from one function.
//
// The check is written through the API instead of being the job's own result because it has to flip on
// events no `pull_request` run follows: a verdict arrives as a comment (`issue_comment`), a label is
// added or removed (`labeled`/`unlabeled`), and neither starts a run for the head being judged (#639).
// `external_id` is the head, so a re-judgement PATCHes that one run instead of piling runs up, and a
// check written for an older head is never reused: a stale green must not answer for a new tip.
//
// `enqueue-guard.yml` decides when this runs, and takes the code it runs from `main`
// (`pull_request_target` + `issue_comment` + `workflow_dispatch`); a `pull_request` job from a fork is
// read-only and could not write the check, which is why that trigger is not used. Nothing here
// checks out or runs pull request code: the head is read through the API only.
//
// Exit code: 0 whenever the judgement was written, whatever it concluded — a red `enqueue-guard` check
// is the refusal, and a red job on top of it would report the same thing twice. 1 only when the head
// could not be judged or the check could not be written. `--dry-run` (or `DRY_RUN=1`) judges the live
// head, prints the payload and writes nothing: it is how a person checks the decision against a real
// pull request before the workflow exists on `main`, and it cannot leave a context behind.
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decidePull } from './enqueue-guard.mjs'
import { prFromHeadRef } from './merge-gate.mjs'

export const CHECK_NAME = 'enqueue-guard'
// `output.title` is capped by the API at 255 characters; a refusal that names several defects is
// longer than that, and the full text is in the summary either way.
const TITLE_MAX = 250
const SHORT = 12
const short = (s) => String(s ?? '').slice(0, SHORT)

// The check run's body, for `POST /check-runs` and for the fields `PATCH` may change. `conclusion` is
// the decision: `success` only when the guard allows the merge, so every refusal — a `hold`, a tip with
// no PASS, a missing `agent-pr`, a PASS that lists no `Ran:` — is one red required check.
export function payloadFor({ decision, head, entry }) {
  const refused = !decision?.ok
  const message = decision?.message ?? (refused ? 'the guard refused this head' : 'the guard allows this head')
  return {
    name: CHECK_NAME,
    head_sha: String(head ?? ''),
    status: 'completed',
    conclusion: refused ? 'failure' : 'success',
    external_id: String(head ?? ''),
    output: {
      title: message.length > TITLE_MAX ? message.slice(0, TITLE_MAX - 1) + '…' : message,
      summary: summaryOf({ decision, head, entry }),
    },
  }
}

// The check run this head already carries, if any. One per head, by `external_id`: a label or a comment
// re-judges the same head, and a second run for one context on one commit is a state nobody can read.
export function planCheck({ runs, head } = {}) {
  const target = String(head ?? '')
  const mine = (runs ?? []).find((run) =>
    run?.name === CHECK_NAME &&
    String(run?.external_id ?? '') === target &&
    String(run?.app?.slug ?? 'github-actions') === 'github-actions')
  return mine?.id != null ? { action: 'update', id: mine.id } : { action: 'create' }
}

// The evidence under the check: same decision, same words, one place to read why it is red.
export function summaryOf({ decision, head, pr, entry } = {}) {
  const ok = Boolean(decision?.ok)
  const labels = (decision?.labels ?? []).map((l) => `\`${l}\``).join(', ') || '(none)'
  const lines = [
    `### \`${CHECK_NAME}\`: ${ok ? 'this head may merge' : 'this head must not merge'}`,
    '',
    `Pull request${pr ? ` #${pr}` : ''}, head \`${decision?.head ?? head ?? ''}\`.${entry && entry !== (decision?.head ?? head) ? ` The queue entry built on it is \`${entry}\`.` : ''} ${ok
      ? 'The ruleset on `main` lets this merge once `tests-ok` is green here too.'
      : 'While this check is red, a merge of this head through the API is refused.'}`,
    '',
    `- decision: \`${decision?.message ?? 'no decision'}\``,
    `- labels: ${labels}`,
  ]
  if (decision?.exempt) lines.push(`- no PASS needed: ${decision.tier ? `computed tier ${decision.tier}` : 'a T0/T1 tier or a mechanical release pull request'} (AGENTS.md → Merge gates)`)
  if (decision?.mechanicalRelease) lines.push('- a mechanical release pull request: it carries no issue and no `agent-pr` by design')
  if (decision?.fork) lines.push('- the head lives in a fork: the issue reference and `agent-pr` rules are not asked of it')
  if (decision?.verdict?.by) lines.push(`- newest conclusion at this tip: ${decision.verdict.verdict ?? 'PASS'} by ${decision.verdict.by}`)
  if (decision?.recordOnly) lines.push('- the newest conclusion at this head says "record only — do not merge"')
  if (!ok) lines.push('', 'What refuses it:', ...(decision?.reasons?.length ? decision.reasons.map((r) => `- ${r}`) : ['- no reason was recorded — treat this as a bug in the gate itself']))
  lines.push('', '_One decision, two readers: this check and `node .github/scripts/enqueue-guard.mjs --pr <n>` call the same function. Rules: [`AGENTS.md` → Merge gates](../../AGENTS.md#merge-gates). This check reads the repository and writes this one run; it never merges, labels or comments._')
  return lines.join('\n')
}

// One CLI shape for both callers: the guard's reads are `gh('api', …, path)`, and a write has to carry a
// JSON body, so it is `gh([args], JSON.stringify(body))` (the way controller.mjs calls `ghRaw`). Both
// arrive here, and getting this wrong is invisible to a fake that accepts either shape — a live
// `--dry-run` is what caught it once, which is why that run is part of the verification of this file.
const realGh = (...a) => {
  const [args, input] = Array.isArray(a[0]) ? [a[0], a[1]] : [a.filter((x) => x !== undefined), undefined]
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20, input, stdio: ['pipe', 'pipe', 'pipe'] })
}

// `gh` is injectable so a test drives the whole write path without the network: it is called as
// `gh(args, input)`, the way controller.mjs calls `ghRaw`, because the checks API takes a JSON body.
export function applyCheck({ gh = realGh, repo, head, decision, entry } = {}) {
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const runs = gh(['api', '--paginate', '--jq', '.check_runs[]', `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100`])
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const plan = planCheck({ runs, head })
  const body = payloadFor({ decision, head, entry })
  if (plan.action === 'update') {
    // `status` goes with `conclusion`: the API rejects a conclusion that is not paired with a completed
    // run, and this run always is one.
    const patch = { status: 'completed', conclusion: body.conclusion, output: body.output }
    gh(['api', '-X', 'PATCH', `repos/${repo}/check-runs/${plan.id}`, '--input', '-'], JSON.stringify(patch))
    return { action: 'update', id: plan.id, conclusion: body.conclusion }
  }
  const created = gh(['api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'], JSON.stringify(body))
  let id = null
  try { id = JSON.parse(created)?.id ?? null } catch { /* the write succeeded; the id is only for the log */ }
  return { action: 'create', id, conclusion: body.conclusion }
}

export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption, dryRun, headRef: headRefOption, entry: entryOption } = {}) {
  const repo = repoOption || env.GH_REPO
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  // #960 (A'): a `merge_group` run has no pull request number, only the queue branch, and the check has to
  // sit on the entry commit the queue merges. Both are optional so every existing caller is unchanged.
  const headRef = headRefOption ?? env.HEAD_REF
  const fromRef = headRef ? prFromHeadRef(headRef) : null
  if (headRef && !fromRef) throw new Error(`cannot read a pull request from head_ref "${headRef}" (expected gh-readonly-queue/<base>/pr-<N>-<sha>)`)
  const entry = entryOption ?? env.ENTRY_SHA ?? (fromRef ? env.GITHUB_SHA : undefined)
  const pr = prOption || env.PR || fromRef?.pr
  if (!pr) throw new Error('set PR or pass --pr N')
  const dry = dryRun ?? (Boolean(env.DRY_RUN) || process.argv.includes('--dry-run'))
  let decided
  try {
    decided = decidePull({ gh, env, repo, pr })
  } catch (error) {
    // `issue_comment` fires for a plain issue too, and the workflow filters those out; a pull request
    // that no longer exists is not a head to judge. Leave no check behind: a context nothing will ever
    // complete would hold a merge that cannot happen anyway, and hide the real reason.
    if (/404|Not Found/.test(String(error?.message ?? ''))) {
      console.log(`gate-check: pull request ${pr} is gone; nothing to judge`)
      return { ok: true, skipped: true }
    }
    throw error
  }
  const { decision, pull } = decided
  const liveHead = pull.head?.sha
  if (!liveHead) throw new Error(`pull request ${pr} has no head sha`)
  // The decision is always about the pull request's live head; the check goes on the entry commit when
  // this run came from `merge_group`, so the required context exists where the queue looks for it.
  const head = fromRef ? String(entry ?? '') : liveHead
  if (!head) throw new Error('a merge_group run must carry the entry commit (ENTRY_SHA)')
  const applied = dry ? { action: 'dry-run', id: null, conclusion: payloadFor({ decision, head, entry }).conclusion } : applyCheck({ gh, repo, head, decision, entry })
  const summary = summaryOf({ decision, head, pr, entry })
  console.log(`gate-check: PR #${pr} head ${short(head)} — ${CHECK_NAME}: ${applied.conclusion} (${applied.action}${applied.id != null ? ` run ${applied.id}` : ''})`)
  console.log(`gate-check: ${decision.message}`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n')
  else console.log('\n' + summary)
  return { ...decision, applied }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); process.exit(0) } catch (e) { console.error(`gate-check: ${e.message}`); process.exit(1) }
}

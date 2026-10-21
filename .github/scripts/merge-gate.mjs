// The merge gate (`.github/workflows/merge-gate.yml`; the rules are AGENTS.md → Merge gates).
//
//   GH_REPO=owner/repo GH_TOKEN=... HEAD_REF=gh-readonly-queue/main/pr-566-<sha> node merge-gate.mjs
//   node merge-gate.mjs --pr 566 [--sha <head>] [--repo owner/repo]     # by hand
//
// It answers one question at the only moment that is audited: may this queue entry merge?
//   - `hold` on the pull request refuses the entry;
//   - the newest conclusive text at the head being merged must be a PASS. That judgement is
//     review-gate.mjs's `decide`, reused rather than rewritten, so "what counts as a review" has one
//     definition: a `Verdict:` in a review body or a comment, the newest one at that tip wins, INC
//     or REQUEST_CHANGES refuses, and no conclusion refuses too.
// A `pull_request`-time result is never reused: on #610 the tip report ran at 10:31:08Z and the INC
// landed at 11:24:37Z, 54 minutes later, so the verdict is re-read here, live, for this head.
//
// A review's `state` is deliberately not read. The account cannot approve its own pull requests, so
// its reviews stay `COMMENTED` even when it says INC, and the INC on #610 was a comment, not a review.
// A body that carries only a `## Review —` heading and no `Verdict:` line is "no conclusion", which
// refuses: the refusal direction never depends on reading more of the text than `decide` does.
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decide, loadPolicy } from './review-gate.mjs'

const SHORT = 12
const HOLD = 'hold'

// A `merge_group` event carries no pull request, no labels and no reviews. The only pointer to them
// is `merge_group.head_ref`, the queue branch the entry was built on:
// `gh-readonly-queue/<base>/pr-<N>-<sha>`, where <sha> is the head the queue is about to merge.
export function prFromHeadRef(ref) {
  const m = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-([0-9a-f]{7,40})$/i.exec(String(ref ?? '').trim())
  return m ? { pr: Number(m[1]), sha: m[2].toLowerCase() } : null
}

const names = (labels) => (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
const short = (s) => String(s ?? '').slice(0, SHORT)

// labels: the pull request's labels. head: its current head sha. queuedSha: the sha in head_ref, the
// one the queue merges. reports: its comments and review bodies, oldest first (review-gate main()).
export function judge({ labels, head, author, reports, policy, queuedSha }) {
  const reasons = []
  const target = String(queuedSha ?? head ?? '').toLowerCase()
  if (!target) return { ok: false, head: '', verdict: null, reasons: ['no head sha to judge'] }
  const held = names(labels).includes(HOLD)
  if (held) reasons.push('the pull request carries the `hold` label')
  // A head that moved after the entry was built is not what was reviewed: the queue drops such an
  // entry itself, and until it does this must not pass it on the strength of an older tip.
  if (queuedSha && head && !String(head).toLowerCase().startsWith(target)) {
    reasons.push(`the pull request head moved to ${short(head)} after this entry was built at ${short(target)}`)
  }
  const verdict = decide({ head: target, author, reports, policy })
  if (!verdict.ok) reasons.push(verdict.reason)
  return { ok: reasons.length === 0, head: target, held, verdict, reasons }
}

export function render(result, { pr, labels } = {}) {
  const out = [
    `### Merge gate: ${result.ok ? `PASS at ${short(result.head)}` : 'REFUSE'}`,
    '',
    result.ok
      ? `Queue entry for #${pr} may merge: no \`hold\`, ${result.verdict?.by}'s PASS names ${short(result.head)}.`
      : `Queue entry for #${pr} must not merge: ${result.reasons.join('; ')}.`,
    '',
    `Pull request #${pr}, head \`${result.head}\`, labels: ${(labels ?? []).join(', ') || '(none)'}.`,
  ]
  const seen = (result.verdict?.judged ?? []).filter((e) => e.counts || e.verdict)
  if (seen.length) out.push('', 'Conclusive texts read (newest last):', ...seen.slice(-5).map((e) => `- ${e.login} (${e.kind}): ${e.verdict ?? 'no verdict'} at ${short(e.tip ?? 'no tip')}${e.counts ? '' : ' (not counted)'}`))
  out.push('', '_Rules: [`AGENTS.md` → Merge gates](../../AGENTS.md#merge-gates). This check refuses the entry; it never labels, comments, approves or merges._')
  return out.join('\n')
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })
const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((l) => JSON.parse(l))

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function main() {
  const repo = process.env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const headRef = arg('--head-ref') || process.env.HEAD_REF
  const fromRef = headRef ? prFromHeadRef(headRef) : null
  if (headRef && !fromRef) throw new Error(`cannot read a pull request from head_ref "${headRef}" (expected gh-readonly-queue/<base>/pr-<N>-<sha>)`)
  const pr = arg('--pr') || process.env.PR || fromRef?.pr
  if (!pr) throw new Error('set HEAD_REF, PR or pass --pr N')

  const policyPath = arg('--policy') || process.env.REVIEW_POLICY || fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))
  const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const head = pull.head?.sha
  const author = pull.user?.login
  const labels = (pull.labels ?? []).map((l) => l.name)
  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, body: c.body, at: c.created_at })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, body: v.body, at: v.submitted_at })),
  ]

  const result = judge({ labels, head, author, reports, policy: loadPolicy(policyPath), queuedSha: fromRef?.sha || arg('--sha') })
  console.log(`merge-gate: PR #${pr} head ${short(head)}${fromRef ? `, queue entry ${short(fromRef.sha)}` : ''}, labels [${labels.join(', ')}]`)
  console.log(`merge-gate: newest conclusion at ${short(result.head)} — ${result.verdict?.verdict ?? 'none'}${result.verdict?.by ? ` by ${result.verdict.by}` : ''}`)
  console.log(`merge-gate: ${result.ok ? 'PASS' : `REFUSE — ${result.reasons.join('; ')}`}`)
  const text = render(result, { pr, labels })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(`merge-gate: ${e.message}`); process.exit(1) }
}

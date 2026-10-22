// The merge gate (`.github/workflows/merge-gate.yml`; the rules are AGENTS.md → Merge gates).
//
//   GH_REPO=owner/repo GH_TOKEN=... HEAD_REF=gh-readonly-queue/main/pr-566-<sha> node merge-gate.mjs
//   node merge-gate.mjs --pr 566 [--sha <head>] [--repo owner/repo]     # by hand
//
// It runs twice, and the two runs answer different questions. On `merge_group` — the only moment at
// which a merge is audited — it asks "may this entry merge?" and fails the job when the answer is no.
// On `pull_request` it reports: a required check must produce a result on the pull request head too,
// or every pull request reads "Expected — waiting for status" and cannot even enter the queue (#639).
// That run never fails, because a verdict arrives as a comment, which starts no `pull_request` run:
// a failure there would outlive its own reason until the next push.
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
import { createGate, loadRules } from './risk-gate.mjs'

const SHORT = 12
const HOLD = 'hold'

// A `merge_group` event carries no pull request, no labels and no reviews. The only pointer to them
// is `merge_group.head_ref`, the queue branch the entry was built on:
// `gh-readonly-queue/<base>/pr-<N>-<sha>`, where <sha> is the BASE the entry was built on — the tip of
// <base> (or of the entry ahead of it) — not the pull request head. Run 39701316520 (#654) carried
// `pr-654-d105f222…`: d105f22 was main's tip (#640's merge), the pull request head was ad0c4716… and
// the entry's own commit (GITHUB_SHA, `merge_group.head_sha`) was ee1739ef…. Reading that sha as the
// head refused every entry: "the head moved" to its real head, and "no Verifier report names" the base.
// So the sha is returned as `base`, and the head is judged the way the `pull_request` run judges it:
// the pull request's own head sha, read live from the API.
//
// It arrives fully qualified: every real queue entry so far passed `refs/heads/gh-readonly-queue/...`
// (runs 39602546475, 39602806953, 39653640861, 39694988559, 39696278650 — all five failed with
// "cannot read a pull request from head_ref" before this prefix was accepted, so the gate never once
// judged a queue entry). Accept both spellings rather than depend on which one the event carries.
export function prFromHeadRef(ref) {
  const branch = String(ref ?? '').trim().replace(/^refs\/heads\//i, '')
  const m = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-([0-9a-f]{7,40})$/i.exec(branch)
  return m ? { pr: Number(m[1]), base: m[2].toLowerCase() } : null
}

const names = (labels) => (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())

// The changed files as `GET /pulls/{n}/files` returns them; a bare name is enough for the path rules,
// which is what a hand run and the tests pass.
const fileList = (files) => (files ?? []).map((f) => (typeof f === 'string' ? { filename: f } : f)).filter((f) => f?.filename)
const fileNames = (files) => fileList(files).map((f) => f.filename)

// A pull request that may merge without a PASS (AGENTS.md 6): T0/T1, and a mechanical release PR,
// whose standing approval is limited to these files.
//
// The tier is computed from the diff by the base copy of `risk-gate.mjs` and
// `.github/agent/risk-rules.json` (the workflow checks this script out from the base commit, so a pull
// request cannot change the rules that judge it). It is deliberately not read from `risk:t0`/`risk:t1`
// labels: every Bot shares one account and a label carries no signature (#627), so whoever can label
// could turn a T3 into "no review needed" — which is the whole gate.
const NO_PASS_TIERS = new Set(['T0', 'T1'])
const RELEASE_FILES = [
  /^CHANGELOG\.md$/,
  /^changelog\.d\//,
  /^core\/package\.json$/,
  /^core\/package-lock\.json$/,
  /^patches\/ds-bot\/0007-version-and-tooling\.patch$/,
]
export const isMechanicalRelease = (files) => (files ?? []).length > 0 && files.every((f) => RELEASE_FILES.some((re) => re.test(String(f))))
const RISK_RULES = fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
let riskGate = null
export const computedTier = (files) => {
  riskGate ??= createGate(loadRules(RISK_RULES))
  return riskGate.judge(fileList(files)).tier
}
// No files is not an exemption: an empty list would otherwise compute T0 and let anything through.
export const exemptFromPass = ({ tier, files }) => {
  const list = fileList(files)
  if (!list.length) return false
  return NO_PASS_TIERS.has(tier ?? computedTier(list)) || isMechanicalRelease(fileNames(list))
}
const short = (s) => String(s ?? '').slice(0, SHORT)

// labels: the pull request's labels. head: its current head sha, the one judged in both modes.
// expectedHead: optional, a head the caller insists on (`--sha` on a hand run); a different live head
// refuses. The queue's base sha is never a head: a merge_group entry passes none here (see
// prFromHeadRef). reports: its comments and review bodies, oldest first (review-gate main()).
export function judge({ labels, files, head, author, reports, policy, expectedHead, mode = 'queue' }) {
  const reasons = []
  const target = String(head ?? '').toLowerCase()
  if (!target) return { ok: false, head: '', verdict: null, reasons: ['no head sha to judge'] }
  const held = names(labels).includes(HOLD)
  if (held) reasons.push('the pull request carries the `hold` label')
  // A head other than the one the caller named is not what was asked about. On a queue entry the
  // live head is the one the entry was built from: a push to the pull request removes it from the
  // queue, and the new head then needs its own PASS anyway.
  const expected = String(expectedHead ?? '').toLowerCase()
  if (expected && !target.startsWith(expected)) {
    reasons.push(`the pull request head is ${short(target)}, not the expected ${short(expected)}`)
  }
  // T0/T1 and the daily release PR need no PASS, so the gate must not refuse them for lacking one
  // (#640, INC point 2): a refusal here would stop every routine fix and every release.
  const tier = fileList(files).length ? computedTier(files) : null
  const exempt = exemptFromPass({ tier, files })
  const verdict = exempt ? { ok: true, verdict: null, by: null, exempt: true } : decide({ head: target, author, reports, policy })
  if (!verdict.ok) reasons.push(verdict.reason)
  // A report says what the queue entry would refuse; only the queue entry refuses. Fail a
  // `pull_request` run and it keeps failing after the INC it names is answered by a PASS, because a
  // comment starts no run of its own (#639).
  const report = mode === 'report'
  return { ok: report ? true : reasons.length === 0, head: target, held, verdict, exempt, tier, reasons, mode }
}

export function render(result, { pr, labels } = {}) {
  const report = result.mode === 'report'
  const out = [
    report
      ? `### Merge gate: report for #${pr} at ${short(result.head)} — ${result.reasons.length ? 'the queue entry would refuse' : 'the queue entry would pass'}`
      : `### Merge gate: ${result.ok ? `PASS at ${short(result.head)}` : 'REFUSE'}`,
    '',
    report
      ? result.reasons.length
        ? `A queue entry for this head would be refused: ${result.reasons.join('; ')}. This report never fails.`
        : result.exempt
          ? `A queue entry for this head would pass without a PASS: ${result.tier ? 'a ' + result.tier : 'a T0/T1'} tier or a mechanical release PR (AGENTS.md 6), computed from the changed files.`
          : `A queue entry for this head would pass: ${result.verdict?.by}'s PASS names ${short(result.head)}.`
      : result.ok && result.exempt
        ? `Queue entry for #${pr} may merge without a PASS: ${result.reasons.length ? 'no \`hold\`' : `${result.tier ? 'a ' + result.tier : 'a T0/T1'} tier or a mechanical release PR (AGENTS.md 6), computed from the changed files`}.`
      : result.ok
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

const realGh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

// The entry point the workflow runs. `gh` and `env` are injectable so a test can drive the whole
// judgement without the network (and without a PATH shim): the rules above are exercised end to end.
export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption, headRef: headRefOption } = {}) {
  const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const headRef = headRefOption ?? (arg('--head-ref') || env.HEAD_REF)
  const fromRef = headRef ? prFromHeadRef(headRef) : null
  if (headRef && !fromRef) throw new Error(`cannot read a pull request from head_ref "${headRef}" (expected gh-readonly-queue/<base>/pr-<N>-<sha>)`)
  const pr = prOption || arg('--pr') || env.PR || fromRef?.pr
  if (!pr) throw new Error('set HEAD_REF, PR or pass --pr N')

  const policyPath = arg('--policy') || env.REVIEW_POLICY || fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))
  const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const head = pull.head?.sha
  const author = pull.user?.login
  const labels = (pull.labels ?? []).map((l) => l.name)
  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, body: c.body, at: c.created_at, association: c.author_association })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, body: v.body, at: v.submitted_at, association: v.author_association })),
  ]

  // The workflow passes both events through this same entry point: `merge_group` judges, `pull_request`
  // reports (#639). MODE (or `--report`) is there for a hand run and for the tests.
  const mode = (env.MODE || (process.argv.includes('--report') ? 'report' : 'queue')) === 'report' ? 'report' : 'queue'
  // The whole file record, not just the name: the T0/T1 exemption is computed from the diff by the
  // base copy of risk-gate.mjs (see exemptFromPass).
  const files = list(`repos/${repo}/pulls/${pr}/files?per_page=100`)
  const result = judge({ labels, files, head, author, reports, policy: loadPolicy(policyPath), expectedHead: arg('--sha'), mode })
  // The entry's own commit and its base are logged, never judged: neither is a head a Verifier names.
  const base = env.BASE_SHA || fromRef?.base
  const entry = env.ENTRY_SHA || (fromRef ? env.GITHUB_SHA : '')
  console.log(`merge-gate: PR #${pr} head ${short(head)}${base ? `, queue base ${short(base)}` : ''}${entry ? `, entry ${short(entry)}` : ''}, labels [${labels.join(', ')}], mode ${mode}`)
  console.log(`merge-gate: newest conclusion at ${short(result.head)} — ${result.verdict?.verdict ?? 'none'}${result.verdict?.by ? ` by ${result.verdict.by}` : ''}`)
  console.log(mode === 'report'
    ? `merge-gate: report — ${result.reasons.length ? `the queue entry would refuse: ${result.reasons.join('; ')}` : 'the queue entry would pass'}`
    : `merge-gate: ${result.ok ? 'PASS' : `REFUSE — ${result.reasons.join('; ')}`}`)
  const text = render(result, { pr, labels })
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const result = main(); process.exit(result.ok ? 0 : 1) } catch (e) { console.error(`merge-gate: ${e.message}`); process.exit(1) }
}

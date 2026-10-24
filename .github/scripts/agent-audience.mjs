// agent-audience (#911): a pull request names its owner and its reviewer in the body, and the review
// round calls that reviewer. When a round calls somebody else, the named reviewer is never asked and
// the pull request sits with no verdict while everyone believes review is in flight — #907 did that
// for four tips. This is a report, not a gate: it reads the two body lines and the comments written
// after the current tip, and says where they disagree. Silence is not detectable here (the repository
// has no "who read this" field); a comment that calls nobody is invisible to this check.
//
//   node .github/scripts/agent-audience.mjs --repo ThinkFlowLab/FlyBot --pr 907
//   node .github/scripts/agent-audience.mjs --repo ThinkFlowLab/FlyBot        # every open PR
//
// Report only: the process exits 0 whatever it finds. Every line has the shape
// `#<n> @<sha7>: <sentence>` so a round can read it without opening the pull request.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const POLICY_PATH = new URL('../agent/review-policy.json', import.meta.url)
// The Chief escalates a stalled review; its call is not a wrong call.
export const ALWAYS_ALLOWED = ['Chief']

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function loadPolicy(path = POLICY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// The roster the review policy already carries. A declared name outside it is a typo or a member who
// cannot write a verdict at all, and either way the round calls nobody who can answer.
export function rosterOf(policy = {}) {
  const names = new Set()
  for (const key of ['writers', 'reviewers', 'maintainers']) {
    for (const name of policy[key] ?? []) if (typeof name === 'string' && name) names.add(name)
  }
  for (const name of policy.selfReview ?? []) if (typeof name === 'string' && name) names.add(name)
  return names
}

// `Owner: Dev2` / `Reviewer: Reviewer2` on their own line. Deliberately not a search anywhere in the
// body: quoting the requirement in prose must not satisfy it.
export function parseDeclarations(body = '') {
  const line = name => {
    const match = new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(String(body ?? ''))
    return match ? match[1] : undefined
  }
  return { owner: line('Owner'), reviewer: line('Reviewer') }
}

// The policy names a member's `@` handle exactly, so a mention is matched whole: `@Reviewer` must not
// match inside `@Reviewer2`, and a handle longer than a roster name is not that member.
export function mentionsIn(text = '', names) {
  const found = []
  for (const name of names) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])@${escape(name)}(?![A-Za-z0-9_.-])`, 'g')
    if (pattern.test(String(text ?? ''))) found.push(name)
  }
  return found.sort()
}

const sha7 = sha => String(sha ?? '').slice(0, 7)
const report = (pr, sentence) => `#${pr.number} @${sha7(pr.headSha)}: ${sentence}`

// One report per defect, not per comment: three calls to the wrong member are one disagreement.
export function evaluate({ pr, comments = [], policy = {}, tipCommittedAt, allow = ALWAYS_ALLOWED } = {}) {
  const { owner, reviewer } = parseDeclarations(pr.body)
  const roster = rosterOf(policy)
  const out = []
  const missing = []
  if (!owner) missing.push('`Owner:`')
  if (!reviewer) missing.push('`Reviewer:`')
  if (missing.length) out.push(report(pr, `pull request body has no ${missing.join(' and ')} line`))
  for (const [label, name] of [['Owner', owner], ['Reviewer', reviewer]]) {
    if (!name || roster.has(name)) continue
    out.push(report(pr, `${label}: names \`${name}\`, which is not in the review-policy roster`))
  }
  // Only calls written after the tip can be about this review round; an earlier call belongs to the
  // tip it was written for, and its tip is already void.
  const since = tipCommittedAt ? Date.parse(tipCommittedAt) : 0
  const calls = new Map()
  for (const comment of comments) {
    const at = Date.parse(comment.createdAt ?? '')
    if (!Number.isFinite(at) || (Number.isFinite(since) && since > 0 && at <= since)) continue
    for (const name of mentionsIn(comment.body, roster)) {
      if (name === reviewer || allow.includes(name)) continue
      const entry = calls.get(name) ?? { count: 0, ids: [] }
      entry.count += 1
      if (comment.id !== undefined) entry.ids.push(comment.id)
      calls.set(name, entry)
    }
  }
  for (const [name, call] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
    const where = call.ids.length ? ` (comment ${call.ids.join(', ')})` : ''
    const named = reviewer ? `the body names \`Reviewer: ${reviewer}\`` : 'the body names no `Reviewer:`'
    out.push(report(pr, `${call.count} call${call.count === 1 ? '' : 's'} to @${name} after this tip${where}, but ${named}`))
  }
  return out
}

const realGh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 << 20 })

// `gh` and `env` are injectable so the run can be driven from fixtures, the way label-hygiene.mjs is.
export function main({ gh = realGh, env = process.env, repo: repoOption, pr: prOption, policy = loadPolicy() } = {}) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const repo = repoOption || env.GH_REPO || arg('--repo')
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const single = prOption ?? arg('--pr')
  const page = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map(line => JSON.parse(line))

  const numbers = single
    ? [Number(single)]
    : page(`repos/${repo}/pulls?state=open&per_page=100`).map(pull => pull.number)
  const reports = []
  for (const number of numbers) {
    const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${number}`))
    const comments = page(`repos/${repo}/issues/${number}/comments?per_page=100`).map(c => ({ id: c.id, body: c.body, createdAt: c.created_at }))
    const tipCommittedAt = gh('api', '--jq', '.commit.committer.date', `repos/${repo}/commits/${pull.head.sha}`).trim()
    reports.push(...evaluate({
      pr: { number, body: pull.body, headSha: pull.head.sha },
      comments,
      policy,
      tipCommittedAt,
    }))
  }
  for (const line of reports) console.log(line)
  console.log(`agent-audience: ${reports.length} finding(s) on ${numbers.length} pull request(s); report only`)
  const summary = env.GITHUB_STEP_SUMMARY
  if (summary) {
    const body = reports.length ? `${reports.join('\n')}\n` : 'agent-audience: no findings\n'
    // Best effort: a missing summary must not change the check's result.
    try { execFileSync('sh', ['-c', `cat >> "$1"`, 'sh', summary], { input: `## agent-audience\n\n${body}`, encoding: 'utf8' }) } catch {}
  }
  return { ok: true, reports, numbers }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(`agent-audience: ${error.message}`); process.exit(1) }
}

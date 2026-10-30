// One conclusion per tip (#1798): a review node that is entered twice at an unchanged tip must not
// write a second `Verdict:`. AGENTS.md says a tip carries at most one conclusion; until this the rule
// was a convention the gates only encoded as newest-wins, so #1772 took two `Verdict: PASS` comments at
// `5ea9acbb…` and merged on the second one. The gate is not relaxed here — the fix is to not write the
// second conclusion.
//
//   node .github/scripts/review-once.mjs --pr 12 --tip <40-char sha> --body-file verdict.md
//   pbpaste | node .github/scripts/review-once.mjs --pr 12 --tip <40-char sha>
//
// It reads the pull request's comments with the token in `$DSH_SECRET_GITHUB_TOKEN` (never printed).
// When the newest conclusion at this whole tip is a PASS and the body being posted is a PASS too, it
// prints one line `reused conclusion at <tip>` and posts nothing; otherwise it posts the body and says
// so. The exceptions are the two bodies AGENTS.md still allows at a tip: a replacement PASS
// (`Replaces: the PASS at <sha> merge-gate rejected for having no Ran: line`) always posts, and a PASS
// posted after `Correction from <Bot>: the PASS at <sha> is withdrawn` posts because a withdrawal is
// what voided the old one. A body that is not a PASS always posts: a later INC / REQUEST_CHANGES
// supersedes a PASS under newest-wins, and dropping it would let the old PASS stand.
//
// The parse is `parseReport` from `review-gate.mjs` — the parser `review-gate` and `merge-gate` read,
// so a comment this refuses to duplicate is exactly the comment the gates already count. A verdict
// naming a *different* tip is not this tip's conclusion and does not block the post: a new commit is
// a new conclusion.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReport } from './review-gate.mjs'

const API = 'https://api.github.com'
const REPO = 'ThinkFlowLab/FlyBot'
export const FULL_SHA = /^[0-9a-f]{40}$/

// A `Verdict:` GitHub did not write as a user is never a conclusion (#943, #1344), so it must not
// silence a real one. Anything that is not clearly a user account is skipped and the post goes ahead.
const isSeparateAccount = (user) => {
  if (!user || typeof user !== 'object') return true
  const login = String(user.login ?? '')
  return user.type !== 'User' || /\[bot\]$/i.test(login)
}

// GitHub orders comments oldest-first by default; this asks for the newest first (the one exception
// the reviewer asked for) so the conclusion that decides is on the first page even on a long pull
// request. `alreadyConcluded` does not trust that order: it compares stamps itself.
const COMMENTS = (pr) => `/repos/${REPO}/issues/${pr}/comments?per_page=100&sort=created&direction=desc`

// The comment's own position in the history: its creation time, else its id (both monotonic on a
// repository), else the array index the caller handed in — a test fixture in posted order.
function stampOf(comment, index) {
  const at = Date.parse(String(comment?.created_at ?? ''))
  if (Number.isFinite(at)) return at
  if (Number.isFinite(Number(comment?.id))) return Number(comment.id)
  return index
}

// The newest conclusion this history carries at `tip`, or `null`. Only the full 40-character tip
// counts: a `Verdict: PASS at 5ea9acbb` is a prefix that names every head starting that way (#1112).
// "Newest" is what `merge-gate` reads too (AGENTS.md, newest-wins), so the one this returns is the
// one that decides the tip, and a PASS followed by a withdrawal is not a PASS any more.
export function alreadyConcluded({ comments = [], tip } = {}) {
  const wanted = String(tip ?? '').toLowerCase()
  if (!FULL_SHA.test(wanted)) return null
  let newest = null
  let newestAt = -Infinity
  const list = Array.isArray(comments) ? comments : []
  for (let index = 0; index < list.length; index++) {
    const comment = list[index]
    if (isSeparateAccount(comment?.user)) continue
    const report = parseReport(comment?.body)
    if (!report.verdict && !report.unknownVerdict && !report.withdraw) continue
    if (String(report.tip ?? '').toLowerCase() !== wanted) continue
    const at = stampOf(comment, index)
    if (at >= newestAt) {
      newestAt = at
      newest = { comment, report }
    }
  }
  return newest
}

// The two shapes AGENTS.md allows at a tip whose conclusion already exists: a replacement PASS for a
// report `merge-gate` rejected for having no `Ran:` (#681), and a PASS that supersedes a withdrawn one
// (#1335). Everything else that is not another PASS is a later word that must reach the pull request.
const REPLACES = /^\s*Replaces\s*:/im
export function postDecision({ comments, tip, body } = {}) {
  const newest = alreadyConcluded({ comments, tip })
  const report = parseReport(body)
  const isPass = report.verdict === 'PASS'
  const isReplacement = REPLACES.test(String(body ?? ''))
  if (!newest) return { post: true, reason: 'no conclusion at this tip' }
  if (newest.report.withdraw) return { post: true, reason: 'the newest conclusion at this tip withdrew its PASS' }
  if (newest.report.verdict !== 'PASS') return { post: true, reason: 'the newest conclusion at this tip is not a PASS' }
  if (!isPass) return { post: true, reason: 'the body being posted is not a PASS and supersedes the PASS here' }
  if (isReplacement) return { post: true, reason: 'a replacement PASS for a verdict merge-gate rejected' }
  return { post: false, reason: 'a PASS already names this tip' }
}

async function realRequest({ method, url, body, token }) {
  if (!token) throw new Error('DSH_SECRET_GITHUB_TOKEN is not set')
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'flybot-review-once',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json }
}

// Post `body` on `pr` unless a PASS already names `tip` and this body adds no second conclusion.
// Returns what it did; the caller turns that into an exit code and a summary line. Every failure
// throws, so the node goes red rather than a review passing silently because the POST failed.
export async function postOnce({ pr, tip, body, token = process.env.DSH_SECRET_GITHUB_TOKEN, request = realRequest, log = console.log } = {}) {
  const sha = String(tip ?? '').toLowerCase()
  if (!FULL_SHA.test(sha)) throw new Error(`--tip must be the whole 40-character sha, got ${JSON.stringify(tip ?? null)}`)
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) throw new Error(`--pr must be a pull request number, got ${JSON.stringify(pr ?? null)}`)
  if (typeof body !== 'string' || body.trim() === '') throw new Error('the conclusion body is empty')

  const call = (method, path, payload) => request({ method, url: `${API}${path}`, body: payload, token })
  const listed = await call('GET', COMMENTS(pr))
  if (listed.status !== 200) throw new Error(`GET the comments on #${pr} answered ${listed.status}`)
  const comments = Array.isArray(listed.json) ? listed.json : []

  const decision = postDecision({ comments, tip: sha, body })
  if (!decision.post) {
    log(`reused conclusion at ${sha}`)
    return { posted: false, reused: true, tip: sha, reason: decision.reason, comment: null }
  }

  const created = await call('POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
  if (created.status !== 201) throw new Error(`POST the conclusion on #${pr} answered ${created.status}`)
  log(`posted conclusion at ${sha}`)
  return { posted: true, reused: false, tip: sha, reason: decision.reason, comment: created.json?.id ?? null }
}

// The process exit code: 0 for a post and 0 for a reuse. A reuse is the good outcome here, not a
// refusal — it is the second entry at an unchanged tip doing the right thing.
export async function main({ argv = process.argv.slice(2), body, request, token, log = console.log } = {}) {
  const option = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at < 0 ? null : (argv[at + 1] ?? null)
  }
  const pr = Number(option('pr'))
  const tip = option('tip')
  const file = option('body-file')
  const text = body ?? (file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'))
  await postOnce({ pr, tip, body: text, request, token, log })
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`review-once: ${error.message}`)
      process.exit(1)
    })
}

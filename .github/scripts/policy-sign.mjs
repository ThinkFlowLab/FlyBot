// A pull request that edits an acceptance gate needs another person's signature (#2054).
//
// The gates that judge this repository — `merge-gate.mjs`, `review-gate.mjs`, `pass-label.mjs`,
// `risk-gate.mjs`, `enqueue-guard.mjs`, `enqueue-rules.mjs` and `scripts/self-test-catalog.mjs` — live
// in the same repository they judge, so a pull request can change what "pass" means and every gate
// downstream will read the new rule. This
// is the smallest structural step against that: `policy/gates.json` names the files, and a pull
// request touching one of them must carry `Policy-sign: <comment id or url>` in its body, naming a
// comment written by someone other than the pull request's author. A person cannot sign their own
// gate change; anyone else with comment access can. The comment must also name the tip it signs: a
// signature that outlived a push would let the author sign one change set and merge another.
//
//   node .github/scripts/policy-sign.mjs                 # in CI: reads the event and the pull request
//   node .github/scripts/policy-sign.mjs --pr 2054       # by hand
//
// The rule is `judge` below and is pure: the CLI reads the pull request and its comments with `gh`
// and hands them over, so the tests never touch the network. Failing closed is deliberate — a check
// that could not run is not a licence, the same rule the host's own reads follow.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prFromHeadRef } from './pr-ref.mjs'

export const POLICY_PATH = fileURLToPath(new URL('../../policy/gates.json', import.meta.url))

export function loadPolicy(path = POLICY_PATH) {
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  const files = policy?.gateFiles
  if (!Array.isArray(files) || files.length === 0) throw new Error(`${path}: gateFiles must be a non-empty list`)
  return policy
}

// The changed files that are gate files. An entry ending in `/` is a directory: anything under it
// counts, so a new file in `policy/` needs no second list to be covered.
export function gateFiles(changed = [], policy = loadPolicy()) {
  const entries = policy.gateFiles.map(String)
  return changed
    .map(String)
    .filter(file => entries.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

// The id a `Policy-sign:` line names. An id is taken as it is; a url is read as its trailing comment
// number, so the line can quote the comment a person actually posted. A value that is neither is
// returned unchanged and then refused as "not on this pull request" — one refusal, not two.
export function parseSignature(body = '') {
  const match = /^Policy-sign:\s*(\S+)\s*$/m.exec(String(body ?? ''))
  if (match === null) return undefined
  const value = match[1]
  if (/^\d+$/.test(value)) return value
  const url = /(?:#issuecomment-|\/comments\/)(\d+)\s*$/.exec(value)
  return url === null ? value : url[1]
}

// A comment signs a tip when it names it. Twelve characters are enough: the comment quotes a sha a
// person pasted, and the comparison is a prefix of the tip, the way the gate reads a verdict.
function namesTip(comment, tip) {
  const tokens = String(comment?.body ?? '').toLowerCase().match(/[0-9a-f]{12,40}/g) ?? []
  return tokens.some(value => tip.startsWith(value))
}

// The three signability criteria, in one place: the refusal refuses with them, and lists the comments
// that would satisfy them (#2314). A gate change needs another person, not the author and not a bot,
// and the comment has to name the tip it signs.
function canSign(comment, { author, tip }) {
  if (tip === '') return false
  const login = String(comment?.user?.login ?? '')
  if (login !== '' && login === String(author)) return false
  if (comment?.user?.type !== 'User') return false
  return namesTip(comment, tip)
}

// At most three: a refusal is a remedy, not a list of every comment on the pull request.
export function signable(comments = [], { author = '', tip = '', limit = 3 } = {}) {
  return comments
    .filter(comment => canSign(comment, { author, tip }))
    .slice(0, limit)
    .map(comment => ({ id: comment.id, login: String(comment.user?.login ?? '') }))
}

export function judge({ files = [], body = '', author = '', comments = [], head = '', policy = loadPolicy() }) {
  const touched = gateFiles(files, policy)
  if (touched.length === 0) return { ok: true, reason: 'no gate file changed, so no signature is needed' }

  const named = touched.length === 1 ? touched[0] : `${touched.length} gate files (${touched.join(', ')})`
  const tip = String(head ?? '').trim().toLowerCase()
  const candidates = signable(comments, { author, tip })
  const token = parseSignature(body)
  if (token === undefined) {
    return { ok: false, reason: `a gate file changed (${named}), and the body carries no \`Policy-sign:\` line naming a comment`, signable: candidates }
  }
  const comment = comments.find(entry => String(entry?.id ?? '') === String(token))
  if (comment === undefined) {
    return { ok: false, reason: `\`Policy-sign:\` names comment ${token}, which is not on this pull request` }
  }
  const login = String(comment.user?.login ?? '')
  if (login !== '' && login === String(author)) {
    return { ok: false, reason: `\`Policy-sign:\` names comment ${token}, written by the pull request's own author — a gate change needs another person` }
  }
  if (comment.user?.type !== 'User') {
    return { ok: false, reason: `\`Policy-sign:\` names comment ${token}, written by a bot account (${login === '' ? 'unknown login' : login})` }
  }
  // The comment has to name the tip it signs. A comment reviewed one change set; without this, the
  // author can sign a harmless tip and then push the change the signature was supposed to cover.
  if (tip === '') {
    return { ok: false, reason: `\`Policy-sign:\` names comment ${token}, but this run carries no head sha to bind it to — the check fails closed` }
  }
  if (!namesTip(comment, tip)) {
    return { ok: false, reason: `\`Policy-sign:\` names comment ${token}, which does not name this tip ${String(head).trim()} — a signature binds the tip it was written for, so a new tip needs a new signature`, signable: candidates }
  }
  return { ok: true, reason: `signed by ${login} in comment ${token}`, signer: login }
}

const API = 'https://api.github.com'

function readEvent(env) {
  try { return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) } catch { return undefined }
}

// The pull request this run is about: its own event, the queue branch for a merge-group entry, or
// `--pr` by hand. Anything else (a push to main, a manual run) carries no pull request to judge.
// The queue ref is read by `pr-ref.mjs`, the same parser `merge-gate` uses (#2671): a base branch may
// contain slashes, and a tail that is not a sha names no pull request on either side.
export function pullRequestNumber(argv = process.argv.slice(2), env = process.env) {
  const at = argv.indexOf('--pr')
  if (at !== -1 && argv[at + 1] !== undefined) return Number(argv[at + 1])
  const event = readEvent(env)
  if (event === undefined) return undefined
  if (event.pull_request?.number !== undefined) return event.pull_request.number
  return prFromHeadRef(event.merge_group?.head_ref ?? '')?.pr
}

// GitHub's own REST API, with the job's token: the workflow already has `pull-requests: read`, and
// the runner is not assumed to carry `gh` (the shared box the Bots work on does not).
//
// A single-object answer (the pull request itself) is returned as it is: only a list is paged, and
// only a list may be flattened. Flattening the object wrapped it in a one-element array, so every
// read of `pull.body`, `pull.user` and `pull.head` came back empty and every gate change was
// refused with "carries no `Policy-sign:` line" (#2060).
async function api(path, token) {
  const pages = []
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} on ${path}`)
    const body = await response.json()
    if (!Array.isArray(body)) return body
    pages.push(body)
    if (body.length < 100) return pages.flat()
  }
}

export async function readPull(repo, number, token) {
  const pull = await api(`/repos/${repo}/pulls/${number}`, token)
  const files = (await api(`/repos/${repo}/pulls/${number}/files`, token)).map(file => file.filename)
  const comments = await api(`/repos/${repo}/issues/${number}/comments`, token)
  return { files, body: pull.body ?? '', author: pull.user?.login ?? '', head: pull.head?.sha ?? '', comments }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repo = env.GITHUB_REPOSITORY ?? (() => {
    const at = argv.indexOf('--repo')
    return at === -1 ? '' : argv[at + 1]
  })()
  const number = pullRequestNumber(argv, env)
  if (number === undefined) {
    // A merge-group entry always points at a pull request, so a queue ref this script cannot read is
    // a failure, not "nothing to sign": the gate would otherwise pass an entry it never judged while
    // `merge-gate` judged the same payload (#2671). A push or a manual run really carries no pull
    // request to sign.
    const event = readEvent(env)
    if (event?.merge_group !== undefined) {
      const ref = event.merge_group?.head_ref ?? ''
      process.stdout.write(`::error::policy-sign cannot read a pull request from this queue ref: ${ref}\n`)
      return 1
    }
    process.stdout.write('policy-sign: this run carries no pull request, so there is nothing to sign\n')
    return 0
  }
  let pull
  try {
    pull = await readPull(repo, number, env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '')
  } catch (error) {
    const why = String(error?.message ?? error).trim().split('\n')[0]
    process.stdout.write(`::error::policy-sign cannot read pull request #${number}: ${why}\n`)
    return 1
  }
  const verdict = judge({ files: pull.files, body: pull.body, author: pull.author, head: pull.head, comments: pull.comments })
  if (verdict.ok) {
    process.stdout.write(`policy-sign ok (#${number}): ${verdict.reason}\n`)
    return 0
  }
  process.stdout.write(`policy-sign refused (#${number}): ${verdict.reason}\n`)
  for (const candidate of verdict.signable ?? []) {
    process.stdout.write(`policy-sign: comment ${candidate.id} by ${candidate.login} signs this tip — add \`Policy-sign: ${candidate.id}\` to the body\n`)
  }
  process.stdout.write(`::error::${verdict.reason}\n`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main())

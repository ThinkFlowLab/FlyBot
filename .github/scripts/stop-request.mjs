// The stop-request dequeue (#3280). `merge-gate` and `enqueue-guard` both read a stop request — but both
// have already run when one arrives after the required checks: on #3279 `Test` went green at 04:47:33Z,
// the author's "Stop request for this tip: do not merge `8bbd01ba…`" landed at 04:47:43Z, and the queue
// merged the entry at 04:47:58Z. The 25 s in between belong to no check, so nothing could refuse. This
// module closes that window from the other side: an `issue_comment` event whose body names the live tip
// takes the queued entry out through GitHub's `dequeuePullRequest`, and the pull request stays open at
// that head.
//
// It is not a second verdict reader, deliberately. The two gates decide whether the tip may merge; this
// only answers "does a person ask not to merge this exact tip, and is it still queued" — the sentence is
// the marker `Stop request for this tip: <sha>`, so a hold with no sha, a request naming an older tip
// and a merged pull request all change nothing. `enqueue-guard.mjs`/`enqueue-rules.mjs` carry the
// "do not merge" vocabulary but no sha marker (their stop request names no tip), so there is one
// implementation of this marker and it lives here; the other module is imported by nobody and edited by
// nobody from here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHORT = 12
const STOP_MARKER = /stop\s+request\s+for\s+this\s+tip\b/i
// A sha is the run of hex characters nobody longer; the lookarounds keep a 12-character prefix inside a
// longer word from being read as a tip. Parsing accepts 7 (the shortest GitHub shows), `sameSha` is what
// insists on 12 — a tip a person can name unambiguously.
const SHA = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/i
const ALREADY_OUT = /not (?:in|currently in) the (?:merge )?queue|not currently queued|no longer in the queue|already been merged|already merged/i

export function parseStopRequest(body) {
  const text = String(body ?? '')
  const marker = STOP_MARKER.exec(text)
  if (!marker) return null
  const rest = text.slice(marker.index + marker[0].length)
  const sha = SHA.exec(rest)
  return sha ? { sha: sha[0].toLowerCase() } : null
}

// A short sha names a tip only when it is long enough to be one on its own, and either side may be the
// short form: a person writes 12 characters, the REST/GraphQL API returns 40.
export function sameSha(a, b) {
  const x = String(a ?? '').toLowerCase()
  const y = String(b ?? '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y)) return false
  if (x.length < SHORT || y.length < SHORT) return false
  return x.startsWith(y) || y.startsWith(x)
}

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

// The injectable client: the tests hand in a fake, the CLI builds this one. A GraphQL refusal arrives as
// HTTP 200 with an `errors` array, so the status alone cannot tell "already out of the queue" from a real
// failure — `message` is what `dequeue` reads.
export function graphqlClient(token, endpoint = GITHUB_GRAPHQL) {
  return async function graphql(query, variables = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'flybot-stop-request',
      },
      body: JSON.stringify({ query, variables }),
    })
    const text = await response.text()
    if (response.status === 404 || response.status === 422) {
      throw Object.assign(new Error(`GraphQL HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status })
    }
    if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}: ${text.slice(0, 300)}`)
    let payload = null
    try { payload = JSON.parse(text) } catch { /* the status above already refused a bad body */ }
    if (payload?.errors?.length) {
      throw Object.assign(new Error(payload.errors.map((error) => error.message).join('; ')), { status: response.status })
    }
    return payload?.data
  }
}

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id number headRefOid baseRefName merged state }
  }
}`

const DEQUEUE_MUTATION = `mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { pullRequest { number headRefOid } }
}`

async function readPull(graphql, repo, number) {
  const [owner, name] = String(repo ?? '').split('/')
  if (!owner || !name) throw new Error('set GITHUB_REPOSITORY or pass repo owner/name')
  const data = await graphql(PULL_QUERY, { owner, name, number: Number(number) })
  return data?.repository?.pullRequest ?? null
}

// Take the entry out, but only while the tip is still the one the caller judged: the head is read again
// here, so a push in the middle of `handleStopRequest` cannot dequeue a different commit than the one the
// stop request named. An entry that is already out (404/422, or the queue's own "not in the queue"
// refusal) is `skipped`, not an error: two comments in a row race the same queue and neither is a defect.
export async function dequeue(prNumber, expectedHeadOid, { graphql = graphqlClient(process.env.GITHUB_TOKEN), repo = process.env.GITHUB_REPOSITORY, pull = null } = {}) {
  const target = pull ?? await readPull(graphql, repo, prNumber)
  if (!target?.id) return 'skipped'
  if (!sameSha(expectedHeadOid, target.headRefOid)) return 'skipped'
  try {
    await graphql(DEQUEUE_MUTATION, { id: target.id })
    return true
  } catch (error) {
    if (error?.status === 404 || error?.status === 422 || ALREADY_OUT.test(String(error?.message ?? ''))) return 'skipped'
    throw error
  }
}

// The note the dequeue leaves on the pull request. `Dequeued by: Chief` is the line an operator looks for;
// the tip and the stop comment make the record checkable without a second API read.
export function dequeueNote({ head, stop }) {
  const link = stop?.html_url ? `\n\nStop request: ${stop.html_url}` : ''
  return [
    'Written-by: Chief',
    '',
    'Dequeued by: Chief',
    '',
    `The merge-queue entry at \`${head}\` was taken out of the queue after a stop request. The pull request stays open at this head.${link}`,
  ].join('\n')
}

async function commentOnPull({ prNumber, repo, body, token = process.env.GITHUB_TOKEN }) {
  const [owner, name] = String(repo ?? '').split('/')
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'flybot-stop-request',
    },
    body: JSON.stringify({ body }),
  })
  if (!response.ok) throw new Error(`could not comment on #${prNumber}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  return response.json()
}

// One `issue_comment` event in, one outcome out. Nothing is written for a body that is not the marker, and
// the live head is compared before the queue is touched, so the one GraphQL route this module owns is
// reached only for a stop request that names the tip the pull request is at.
export async function handleStopRequest({ event, graphql = graphqlClient(process.env.GITHUB_TOKEN), repo = process.env.GITHUB_REPOSITORY, dequeue: dequeueImpl = dequeue, postComment = commentOnPull } = {}) {
  const issue = event?.issue
  const comment = event?.comment
  const parsed = parseStopRequest(comment?.body)
  if (!parsed) return { action: 'none', reason: 'not a stop request for a tip' }
  if (!issue?.pull_request) return { action: 'none', reason: 'a comment on an issue, not a pull request' }
  const prNumber = Number(issue.number)
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { action: 'none', reason: 'no pull request number' }

  const pull = await readPull(graphql, repo, prNumber)
  if (!pull) return { action: 'skipped', reason: 'the pull request is gone', parsed }
  if (pull.merged) return { action: 'ignored', reason: 'already merged', parsed, pull }
  if (String(pull.baseRefName) !== 'main') return { action: 'ignored', reason: `base is ${pull.baseRefName}, not main`, parsed, pull }
  if (!sameSha(parsed.sha, pull.headRefOid)) return { action: 'ignored', reason: 'the request names another tip', parsed, head: pull.headRefOid, pull }

  const outcome = await dequeueImpl(prNumber, pull.headRefOid, { graphql, repo })
  if (outcome !== true) return { action: 'skipped', reason: 'the entry is no longer in the queue', parsed, head: pull.headRefOid, pull }

  const body = dequeueNote({ head: pull.headRefOid, stop: comment })
  await postComment({ prNumber, repo, body })
  return { action: 'dequeued', parsed, head: pull.headRefOid, expectedHeadOid: pull.headRefOid, body, pull }
}

export async function main({ eventPath = process.env.GITHUB_EVENT_PATH, env = process.env } = {}) {
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const result = await handleStopRequest({
    event,
    repo: env.GITHUB_REPOSITORY,
    graphql: graphqlClient(env.GITHUB_TOKEN),
  })
  const at = result.head ? ` at ${result.head}` : ''
  console.log(`stop-request: ${result.action}${result.reason ? ` — ${result.reason}` : ''}${at}`)
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`stop-request: ${error.message}`)
    process.exit(1)
  })
}

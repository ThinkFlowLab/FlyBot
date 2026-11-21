// The stop-request dequeue (#3280). A stop request that arrives after a queue entry's required checks
// have run and before the queue merges it is read by no check: on #3279 `Test` went green at 04:47:33Z,
// the author's request landed at 04:47:43Z, and the queue merged at 04:47:58Z. These tests pin the one
// decision that closes that window — dequeue the entry, and only when the request names the live tip —
// and they pin it offline: the GraphQL client is injected, so no test touches GitHub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dequeue, handleStopRequest, parseStopRequest, sameSha } from './stop-request.mjs'

const TIP = '202fcc6711ac1e8af0877a7ab6865f05088487ae'
const OTHER = '8bbd01baeefa413a7dfbb4accc5f9d5ddf46f6fa'
const STOP_URL = 'https://github.com/ThinkFlowLab/FlyBot/pull/3280#issuecomment-7057486591'

const pull = (over = {}) => ({
  id: 'PR_kwDOA-node-3280',
  number: 3280,
  headRefOid: TIP,
  baseRefName: 'main',
  merged: false,
  state: 'OPEN',
  ...over,
})

const comment = (over = {}) => ({
  id: 7057486591,
  body: `Stop request for this tip: do not merge \`${TIP}\``,
  html_url: STOP_URL,
  user: { login: 'HugoXK', type: 'User' },
  ...over,
})

const event = (over = {}) => ({
  action: 'created',
  issue: { number: 3280, pull_request: { url: 'https://api.github.com/repos/ThinkFlowLab/FlyBot/pulls/3280' } },
  comment: comment(),
  ...over,
})

// A fake GraphQL client: it records every call, answers the pull-request read, and answers the dequeue
// mutation — or throws the error a real entry outside the queue would produce.
function fakeGraphql({ pr = pull(), dequeueError = null } = {}) {
  const calls = []
  const client = async (query, variables) => {
    calls.push({ query, variables })
    if (query.includes('dequeuePullRequest')) {
      if (dequeueError) throw dequeueError
      return { dequeuePullRequest: { pullRequest: { number: pr.number } } }
    }
    return { repository: { pullRequest: pr } }
  }
  return { client, calls, mutations: () => calls.filter((call) => call.query.includes('dequeuePullRequest')) }
}

const graphqlError = (message, status) => Object.assign(new Error(message), { status })

test('#3280: parseStopRequest reads the tip request, its short sha and backticks, and nothing else', () => {
  assert.deepEqual(parseStopRequest(`Stop request for this tip: \`${TIP}\``), { sha: TIP })
  assert.deepEqual(parseStopRequest(`stop REQUEST for this tip: ${TIP.slice(0, 12)}`), { sha: TIP.slice(0, 12) })
  // The request usually carries a sentence between the marker and the sha, and the sha may sit on the
  // next line inside backticks — the shape #3279's comment used.
  assert.deepEqual(parseStopRequest(`Stop request for this tip: do not merge\n\`${TIP}\``), { sha: TIP })
  assert.equal(parseStopRequest('please do not merge this tip'), null, 'a hold without a tip is not this marker')
  assert.equal(parseStopRequest(`Stop request for this tip: nothing to name`), null, 'the marker names no sha')
  assert.equal(parseStopRequest(''), null)
})

test('#3280: sameSha accepts a 12-character short sha either way and refuses another tip', () => {
  assert.equal(sameSha(TIP, TIP), true)
  assert.equal(sameSha(TIP, TIP.slice(0, 12)), true, 'a full sha matches the short form a person writes')
  assert.equal(sameSha(TIP.slice(0, 12), TIP), true, 'a short sha matches the full form the API returns')
  assert.equal(sameSha(TIP, OTHER), false)
  assert.equal(sameSha(TIP, TIP.slice(0, 7)), false, 'under 12 characters names no tip on its own')
  assert.equal(sameSha('', TIP), false)
})

test('#3280: dequeue takes the entry out through dequeuePullRequest at the tip it read', async () => {
  const g = fakeGraphql()
  const out = await dequeue(3280, TIP, { graphql: g.client, repo: 'ThinkFlowLab/FlyBot' })

  assert.equal(out, true)
  assert.equal(g.mutations().length, 1, 'one dequeuePullRequest mutation')
  assert.deepEqual(g.mutations()[0].variables, { id: 'PR_kwDOA-node-3280' }, 'the mutation names the pull request node id')
})

test('#3280: dequeue is skipped, not failed, when the entry is no longer in the queue', async () => {
  for (const status of [404, 422]) {
    const g = fakeGraphql({ dequeueError: graphqlError('not in the queue', status) })
    assert.equal(await dequeue(3280, TIP, { graphql: g.client, repo: 'ThinkFlowLab/FlyBot' }), 'skipped', `HTTP ${status} means already out`)
  }
  // A GraphQL refusal arrives as a 200 body with an `errors` array; the message is what says "already out".
  const body = fakeGraphql({ dequeueError: graphqlError('Pull request #3280 is not in the merge queue', 200) })
  assert.equal(await dequeue(3280, TIP, { graphql: body.client, repo: 'ThinkFlowLab/FlyBot' }), 'skipped')
})

test('#3280: dequeue never takes out an entry whose head already moved', async () => {
  const g = fakeGraphql({ pr: pull({ headRefOid: OTHER }) })
  assert.equal(await dequeue(3280, TIP, { graphql: g.client, repo: 'ThinkFlowLab/FlyBot' }), 'skipped')
  assert.equal(g.mutations().length, 0, 'the request names a tip that is no longer the head')
})

test('#3280: a stop request naming the live tip is dequeued and leaves Dequeued by: Chief', async () => {
  const g = fakeGraphql()
  const seen = []
  const posted = []
  const r = await handleStopRequest({
    event: event({ comment: comment({ body: `Stop request for this tip: do not merge\n\`${TIP.slice(0, 12)}\`` }) }),
    graphql: g.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async (prNumber, expectedHeadOid) => { seen.push([prNumber, expectedHeadOid]); return true },
    postComment: async (payload) => { posted.push(payload) },
  })

  assert.equal(r.action, 'dequeued')
  assert.deepEqual(r.parsed, { sha: TIP.slice(0, 12) }, 'the short sha the person wrote is what the request parsed')
  assert.deepEqual(seen, [[3280, TIP]], 'dequeue got the pull request and the full live head it must still match')
  assert.equal(posted.length, 1)
  assert.match(posted[0].body, /Dequeued by: Chief/)
  assert.ok(posted[0].body.includes(TIP), 'the note names the tip')
  assert.ok(posted[0].body.includes(STOP_URL), 'the note links the stop request it answered')
})

test('#3280: a stop request naming another tip changes nothing', async () => {
  const g = fakeGraphql()
  let called = false
  const r = await handleStopRequest({
    event: event({ comment: comment({ body: `Stop request for this tip: do not merge \`${OTHER}\`` }) }),
    graphql: g.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async () => { called = true; return true },
    postComment: async () => {},
  })

  assert.equal(r.action, 'ignored')
  assert.equal(called, false)
  assert.equal(g.mutations().length, 0)
})

test('#3280: a comment that is not a stop request never calls GraphQL at all', async () => {
  const g = fakeGraphql()
  const r = await handleStopRequest({
    event: event({ comment: comment({ body: 'Looks good to me — thanks for the fix.' }) }),
    graphql: g.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async () => assert.fail('no dequeue for a comment that names no tip'),
    postComment: async () => assert.fail('no note for a comment that names no tip'),
  })

  assert.equal(r.action, 'none')
  assert.equal(g.calls.length, 0, 'not one request, so a stray stop request cannot touch the queue')
})

test('#3280: only a pull request based on main is read, and a merged one is never re-judged', async () => {
  const notMain = fakeGraphql({ pr: pull({ baseRefName: 'release/v0.2.39' }) })
  const a = await handleStopRequest({
    event: event(),
    graphql: notMain.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async () => assert.fail('a release branch has no main queue entry'),
    postComment: async () => {},
  })
  assert.equal(a.action, 'ignored')
  assert.match(a.reason, /not main/)

  const merged = fakeGraphql({ pr: pull({ merged: true, state: 'MERGED' }) })
  const b = await handleStopRequest({
    event: event(),
    graphql: merged.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async () => assert.fail('a merged pull request is history, not a request'),
    postComment: async () => {},
  })
  assert.equal(b.action, 'ignored')
  assert.match(b.reason, /merged/)
})

test('#3280: a comment on a plain issue names no pull request and changes nothing', async () => {
  const g = fakeGraphql()
  const r = await handleStopRequest({
    event: { action: 'created', issue: { number: 12 }, comment: comment() },
    graphql: g.client,
    repo: 'ThinkFlowLab/FlyBot',
    dequeue: async () => assert.fail('an issue has no queue entry'),
    postComment: async () => {},
  })
  assert.equal(r.action, 'none')
  assert.equal(g.calls.length, 0)
})

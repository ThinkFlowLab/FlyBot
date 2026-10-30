// One conclusion per tip (#1798). Three cases, and the middle one is the defect: a review node
// entered twice at an unchanged tip must reuse the conclusion already there instead of writing a
// second `Verdict:` — #1772 took two `Verdict: PASS` comments at `5ea9acbb…`. The other two protect
// the normal path, so the guard cannot pass by never posting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alreadyConcluded, postOnce, main } from './review-once.mjs'

const tip = '5ea9acbb023a3e119c353437cfb87d021cf5765e'
const other = '6a6f22bbb6e89beb19e475fc8fc7eb528bb9ad84'

const conclusion = (sha = tip) => `Verdict: PASS at ${sha}
Written-by: Reviewer

## What I ran
- \`node --test .github/scripts/review-once.test.mjs\` → 3/3

## Risk
T1.`

const comment = (body) => ({ id: 6515589279, user: { login: 'Birfy', type: 'User' }, body })

// A stand-in for the GitHub API: it answers the comment list and records every write.
function api(comments = [], { failGet = false } = {}) {
  const calls = []
  const request = async ({ method, url, body }) => {
    calls.push({ method, url, body })
    if (method === 'GET') return { status: failGet ? 500 : 200, json: comments }
    return { status: 201, json: { id: 1234 } }
  }
  return { calls, request, posts: () => calls.filter((c) => c.method === 'POST') }
}

test('#1798: no conclusion at the tip posts exactly once', async () => {
  const seen = api([{ id: 1, user: { login: 'Birfy', type: 'User' }, body: 'LGTM, running the gate now.' }])
  const lines = []
  const result = await postOnce({ pr: 1772, tip, body: conclusion(), request: seen.request, token: 'stub', log: (line) => lines.push(line) })
  assert.equal(result.posted, true)
  assert.equal(result.reused, false)
  assert.equal(seen.posts().length, 1)
  assert.equal(seen.posts()[0].body.body, conclusion())
  assert.deepEqual(lines, [`posted conclusion at ${tip}`])
})

test('#1798: a conclusion already naming this tip posts nothing and reports one reused line', async () => {
  const seen = api([comment(conclusion()), { id: 2, user: { login: 'Birfy', type: 'User' }, body: 'unrelated' }])
  const lines = []
  const code = await main({ argv: ['--pr', '1772', '--tip', tip], body: conclusion(), request: seen.request, token: 'stub', log: (line) => lines.push(line) })
  assert.equal(code, 0, 'a reuse is the good outcome, so the node exits 0')
  assert.equal(seen.posts().length, 0, 'no second conclusion at an unchanged tip')
  assert.deepEqual(lines, [`reused conclusion at ${tip}`], 'exactly one line says the conclusion was reused')
})

test('#1798: a conclusion naming another tip does not block the post', async () => {
  const seen = api([comment(conclusion(other))])
  const lines = []
  const result = await postOnce({ pr: 1772, tip, body: conclusion(), request: seen.request, token: 'stub', log: (line) => lines.push(line) })
  assert.equal(result.posted, true)
  assert.equal(seen.posts().length, 1, 'a new commit is a new conclusion')
  assert.equal(seen.posts()[0].body.body, conclusion())
})

test('#1798: a prefix of the tip is not the tip', () => {
  assert.equal(alreadyConcluded({ comments: [comment(conclusion(tip.slice(0, 12)))], tip }), null, 'a 12-character prefix names every head that starts that way (#1112)')
  assert.ok(alreadyConcluded({ comments: [comment(conclusion())], tip }))
  assert.equal(alreadyConcluded({ comments: [comment(conclusion())], tip: other }), null)
})

test('#1798: a bot account or an untyped account is not a conclusion', () => {
  const bot = { id: 3, user: { login: 'cursor[bot]', type: 'Bot' }, body: conclusion() }
  const untyped = { id: 4, user: {}, body: conclusion() }
  assert.equal(alreadyConcluded({ comments: [bot], tip }), null, 'a bot account is never a conclusion (#943, #1344)')
  assert.equal(alreadyConcluded({ comments: [untyped], tip }), null)
})

test('#1798: an API failure is loud, never a silent non-post', async () => {
  const seen = api([], { failGet: true })
  await assert.rejects(postOnce({ pr: 1772, tip, body: conclusion(), request: seen.request, token: 'stub', log: () => {} }), /answered 500/)
  assert.equal(seen.posts().length, 0)
})

// The reviewer's three probes (#1851): the guard must not swallow the bodies AGENTS.md still allows at
// one tip. Each asserts a real POST, because "reused" here would kill the only remedy the gate has.

const replacement = `${conclusion()}

Replaces: the PASS at ${tip} merge-gate rejected for having no Ran: line`

const withdrawal = (sha = tip) => `Correction from Reviewer: the PASS at ${sha} is withdrawn
Written-by: Reviewer`

const request = (sha = tip) => `Verdict: REQUEST_CHANGES at ${sha}
Written-by: Reviewer
Attestation: ${sha} role=Reviewer

Ran: \`node --test .github/scripts/review-once.test.mjs\`
Blocked: the replacement PASS would be swallowed.`

test('#1851: a replacement PASS at the same tip is posted, not reused', async () => {
  const seen = api([comment(conclusion())])
  const lines = []
  const result = await postOnce({ pr: 1581, tip, body: replacement, request: seen.request, token: 'stub', log: (line) => lines.push(line) })
  assert.equal(result.posted, true, 'a PASS merge-gate rejected for having no Ran: line must be replaceable at its tip')
  assert.equal(seen.posts().length, 1)
  assert.deepEqual(lines, [`posted conclusion at ${tip}`])
})

test('#1851: a PASS after a withdrawal at the same tip is posted', async () => {
  const seen = api([comment(conclusion()), comment(withdrawal()), { id: 9, user: { login: 'Birfy', type: 'User' }, body: 'unrelated' }])
  const result = await postOnce({ pr: 1335, tip, body: conclusion(), request: seen.request, token: 'stub', log: () => {} })
  assert.equal(result.posted, true, 'the withdrawal voided the old PASS, so a new one is not a second conclusion (#1335)')
  assert.equal(seen.posts().length, 1)
})

test('#1851: a non-PASS body at a tip that already carries a PASS is posted', async () => {
  const seen = api([comment(conclusion())])
  const result = await postOnce({ pr: 610, tip, body: request(), request: seen.request, token: 'stub', log: () => {} })
  assert.equal(result.posted, true, 'a later INC / REQUEST_CHANGES supersedes the PASS under newest-wins; dropping it leaves the veto unwritten')
  assert.equal(seen.posts().length, 1)
})

test('#1851: the newest conclusion at the tip decides, not the first in the list', async () => {
  const older = { id: 10, created_at: '2026-10-30T05:17:27Z', user: { login: 'Birfy', type: 'User' }, body: conclusion() }
  const newer = { id: 11, created_at: '2026-10-30T05:21:24Z', user: { login: 'Birfy', type: 'User' }, body: withdrawal() }
  assert.equal(alreadyConcluded({ comments: [newer, older], tip })?.comment?.id, 11, 'a withdrawal newer than the PASS is the newest conclusion')
  const seen = api([newer, older])
  const result = await postOnce({ pr: 1335, tip, body: conclusion(), request: seen.request, token: 'stub', log: () => {} })
  assert.equal(result.posted, true)
  assert.equal(seen.posts().length, 1)
})

test('#1851: the same refusal already at the tip is reused, not posted a second time', async () => {
  const seen = api([comment(request())])
  const lines = []
  const code = await main({ argv: ['--pr', '610', '--tip', tip], body: request(), request: seen.request, token: 'stub', log: (line) => lines.push(line) })
  assert.equal(code, 0, 'a reuse is the good outcome, so the node exits 0')
  assert.equal(seen.posts().length, 0, 'a second Verdict: at an unchanged tip is the incident #1798 exists to stop')
  assert.deepEqual(lines, [`reused conclusion at ${tip}`], 'exactly one line says the conclusion was reused')
})

test('#1851: a flipped verdict at the tip still posts', async () => {
  const seen = api([comment(request())])
  const result = await postOnce({ pr: 610, tip, body: conclusion(), request: seen.request, token: 'stub', log: () => {} })
  assert.equal(result.posted, true, 'a PASS over a refusal is a different verdict, not a duplicate')
  assert.equal(seen.posts().length, 1)
})

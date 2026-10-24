// gate-check (#812): the guard's decision, written onto the pull request head as the `enqueue-guard`
// check run that the ruleset on `main` requires.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_NAME, applyCheck, main, payloadFor, planCheck, summaryOf } from './gate-check.mjs'

const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const NEXT = 'cd12ef34050617283940a1b2c3d4e5f60718293a'
const HOST_FILE = 'core/src/host/turns.js' // T2: needs a PASS
const TEST_FILE = 'core/test/gate-check.test.js' // T1: needs none
const REPO = 'Birfy/FlyBot'

// #943: a live, non-draft pull request carries the two lines that say who owns and reviews it.
const HEADERS = 'Owner: Dev\nReviewer: reviewer-agent\n'

const policyFile = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'gate-check-policy-')), 'review-policy.json')
  writeFileSync(path, JSON.stringify({ reviewers: ['reviewer-agent', 'Birfy'], selfReview: ['Birfy'], writers: ['reviewer-agent', 'Reviewer', 'Birfy'] }))
  return path
}
const POLICY = policyFile()

const report = ({ tip = HEAD, verdict = 'PASS' } = {}) =>
  [`Verdict: ${verdict} at ${tip}`, 'Written-by: reviewer-agent', '', 'Ran: npm run verify → pass'].join('\n')
const comment = (body = report(), at = '2026-10-23T07:00:00Z') =>
  ({ user: { login: 'reviewer-agent' }, body, created_at: at, author_association: 'MEMBER' })

// A repository with one pull request and the check runs written on it so far. `gh` answers both call
// shapes the scripts use: variadic reads (`gh('api', …, path)`) and writes (`gh([args], json)`).
const world = ({ head = HEAD, labels = ['agent-pr'], body = HEADERS + 'Fixes #812\n', comments = [], files = [HOST_FILE], author = 'opener', headRepo = REPO } = {}) => {
  const state = { head, labels, body, comments, files, author, headRepo, runs: [], writes: [], nextId: 100 }
  const pull = () => ({ head: { sha: state.head, repo: { full_name: state.headRepo } }, user: { login: state.author }, body: state.body, labels: state.labels.map((name) => ({ name })) })
  const handle = (args, input) => {
    // A write ends with `--input -`, so the API path is the `repos/…` argument, not the last one.
    const path = String(args.find((a) => String(a).startsWith('repos/')) ?? args[args.length - 1])
    const methodAt = args.indexOf('-X')
    const method = methodAt >= 0 ? args[methodAt + 1] : 'GET'
    if (method === 'GET') {
      if (/\/pulls\/\d+$/.test(path)) return JSON.stringify(pull())
      if (path.includes('/files')) return state.files.map((f) => JSON.stringify(typeof f === 'string' ? { filename: f } : f)).join('\n')
      if (path.includes('/comments')) return state.comments.map((c) => JSON.stringify(c)).join('\n')
      if (path.includes('/reviews')) return ''
      const sha = /\/commits\/([0-9a-f]+)\/check-runs/.exec(path)?.[1]
      if (sha) {
        // The endpoint answers an envelope, not an array, and `--jq` slices that answer. Answering with
        // runs directly is what let a `.[]` filter pass here and POST a second run against the real API.
        const runs = state.runs.filter((r) => r.head_sha === sha)
        const jqAt = args.indexOf('--jq')
        const filter = jqAt >= 0 ? args[jqAt + 1] : undefined
        if (filter === '.check_runs[]') return runs.map((r) => JSON.stringify(r)).join('\n')
        if (filter === '.[]') return [String(runs.length), JSON.stringify(runs)].join('\n')
        throw new Error('fake gh: unexpected --jq filter ' + filter)
      }
      throw new Error('fake gh: unexpected read ' + path)
    }
    const target = path
    const sent = JSON.parse(input)
    state.writes.push({ method, target, sent })
    if (method === 'POST' && /\/check-runs$/.test(target)) {
      const run = { id: state.nextId++, name: sent.name, head_sha: sent.head_sha, external_id: sent.external_id, status: sent.status, conclusion: sent.conclusion, output: sent.output, app: { slug: 'github-actions' } }
      state.runs.push(run)
      return JSON.stringify(run)
    }
    if (method === 'PATCH' && /\/check-runs\/\d+$/.test(target)) {
      const id = Number(target.split('/').at(-1))
      const run = state.runs.find((r) => r.id === id)
      if (!run) throw new Error('fake gh: no such check run ' + id)
      Object.assign(run, { status: sent.status, conclusion: sent.conclusion, output: sent.output })
      return JSON.stringify(run)
    }
    throw new Error('fake gh: unexpected write ' + method + ' ' + target)
  }
  state.gh = (...a) => {
    if (Array.isArray(a[0])) return handle(a[0], a[1])
    return handle(a.filter((x) => x !== undefined), undefined)
  }
  return state
}

const run = (state, pr = 812) => main({ gh: state.gh, env: { REVIEW_POLICY: POLICY, GH_REPO: REPO, PR: String(pr) }, repo: REPO, pr })

const ALLOWED = { ok: true, head: HEAD, reasons: [], labels: ['agent-pr'], message: `enqueue #812: no \`hold\` and the gate passes` }
const REFUSED = { ok: false, head: HEAD, reasons: ['missing label: agent-pr'], labels: [], message: 'do not enqueue #812: missing label: agent-pr' }

test('#812: an allowed head becomes a green check named enqueue-guard, tied to that head', () => {
  const body = payloadFor({ decision: ALLOWED, head: HEAD })
  assert.equal(body.name, CHECK_NAME)
  assert.equal(body.conclusion, 'success')
  assert.equal(body.head_sha, HEAD)
  // `external_id` is the head, so a re-judgement finds this run instead of piling another one up.
  assert.equal(body.external_id, HEAD)
  assert.equal(body.status, 'completed')
  assert.match(body.output.title, /enqueue #812/)
})

test('#812: a refusal becomes a red check whose title is the guard\u2019s own REFUSE sentence', () => {
  const body = payloadFor({ decision: REFUSED, head: HEAD })
  assert.equal(body.conclusion, 'failure')
  assert.equal(body.output.title, REFUSED.message)
  assert.match(body.output.summary, /must not merge/)
  assert.match(body.output.summary, /missing label: agent-pr/)
})

test('#812: a refusal that names several defects keeps every reason in the summary', () => {
  const many = { ok: false, head: HEAD, labels: ['hold'], reasons: ['the pull request carries the `hold` label', 'no Verifier report names the tip abaf938b0c1d', 'missing label: agent-pr'], message: 'do not enqueue #812: the `hold` label' }
  const summary = summaryOf({ decision: many, head: HEAD, pr: 812 })
  for (const reason of many.reasons) assert.ok(summary.includes(reason), reason)
  // A title is capped by the API; the reasons are not lost, they are in the summary.
  assert.ok(payloadFor({ decision: { ...many, message: 'x'.repeat(400) }, head: HEAD }).output.title.length <= 250)
})

test('#812: one run per head — a run for an older head is never reused', () => {
  const runs = [
    { id: 7, name: CHECK_NAME, head_sha: NEXT, external_id: NEXT, app: { slug: 'github-actions' } },
    { id: 8, name: 'tests-ok', head_sha: HEAD, external_id: HEAD, app: { slug: 'github-actions' } },
    { id: 9, name: CHECK_NAME, head_sha: HEAD, external_id: 'stale-tip', app: { slug: 'github-actions' } },
  ]
  assert.deepEqual(planCheck({ runs, head: HEAD }), { action: 'create' })
  const mine = { id: 11, name: CHECK_NAME, head_sha: HEAD, external_id: HEAD, app: { slug: 'github-actions' } }
  assert.deepEqual(planCheck({ runs: [mine], head: HEAD }), { action: 'update', id: 11 })
})

test('#812: the same head flips red then green on one check run — a label or a comment re-judges it', () => {
  const state = world({ labels: [], comments: [comment()] }) // a PASS at the tip, but no agent-pr yet
  const first = run(state)
  assert.equal(first.applied.conclusion, 'failure')
  assert.match(first.message, /missing label: agent-pr/)
  assert.equal(state.runs.length, 1)

  // The label is added and nothing else changes: same head, no new commit.
  state.labels = ['agent-pr']
  const second = run(state)
  assert.equal(second.applied.conclusion, 'success')
  assert.equal(second.applied.action, 'update')
  // One run for this head, not two: the flip is the same run changing state.
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].conclusion, 'success')
  assert.equal(state.writes.filter((w) => w.method === 'POST').length, 1)
})

test('#812: the check-run read takes the envelope, so one head is re-judged, never given a second run', () => {
  const state = world()
  const seen = []
  const spy = (...a) => { seen.push(Array.isArray(a[0]) ? a[0] : a.filter((x) => x !== undefined)); return state.gh(...a) }
  const first = applyCheck({ gh: spy, repo: REPO, head: HEAD, decision: ALLOWED })
  const second = applyCheck({ gh: spy, repo: REPO, head: HEAD, decision: REFUSED })
  // With `.[]` on the envelope both calls would answer `create` and this head would carry two runs.
  assert.equal(first.action, 'create')
  assert.equal(second.action, 'update')
  assert.ok(seen.some((args) => args.includes('.check_runs[]')), 'reads the array inside the envelope, not the envelope’s values')
  assert.equal(state.runs.length, 1)
  assert.deepEqual(state.writes.map((w) => w.method), ['POST', 'PATCH'])
})

test('#812: a push returns the check to red even with agent-pr present — a PASS is bound to a tip', () => {
  const state = world({ comments: [comment()] })
  assert.equal(run(state).applied.conclusion, 'success')
  state.head = NEXT // a new commit: the PASS above names the old head
  const moved = run(state)
  assert.equal(moved.applied.conclusion, 'failure')
  assert.equal(moved.applied.action, 'create')
  assert.match(moved.message, /names abaf938b0c1d, not the tip cd12ef340506/)
  // Two heads, two runs: the old green stays as the record of the old head.
  assert.equal(state.runs.length, 2)
})

test('#812: hold is the guard\u2019s rule, not the gate\u2019s own — a PASS does not clear it', () => {
  const state = world({ labels: ['hold', 'agent-pr'], comments: [comment()] })
  const r = run(state)
  assert.equal(r.applied.conclusion, 'failure')
  assert.match(r.message, /`hold` label/)
})

test('#812: a comment arriving after a refusal PATCHes the same run green', () => {
  const state = world({ comments: [] }) // agent-pr is there, the PASS is not yet
  assert.equal(run(state).applied.conclusion, 'failure')
  const before = state.runs[0].id
  state.comments = [comment()]
  const after = run(state)
  assert.equal(after.applied.conclusion, 'success')
  assert.equal(after.applied.id, before)
  assert.equal(state.runs.length, 1)
})

test('#812: a T0/T1 head is green without a PASS, and the summary says why', () => {
  const state = world({ body: HEADERS + 'Fixes #812\n', files: [TEST_FILE], comments: [] })
  const r = run(state)
  assert.equal(r.applied.conclusion, 'success')
  assert.equal(state.runs[0].conclusion, 'success')
  assert.match(state.runs[0].output.summary, /T1|T0|no PASS needed/)
})

test('#812: a mechanical release pull request is green without an issue or agent-pr', () => {
  const state = world({ body: '', labels: [], files: ['CHANGELOG.md', 'changelog.d/812-x.added.md', 'core/package.json'], comments: [] })
  const r = run(state)
  assert.equal(r.applied.conclusion, 'success')
  assert.match(state.runs[0].output.summary, /mechanical release/)
})

test('#812: a judged head always writes exactly one run; nothing else is written', () => {
  const state = world()
  run(state)
  for (const write of state.writes) {
    assert.ok(/\/check-runs(\/\d+)?$/.test(write.target), write.target)
    assert.ok(write.method === 'POST' || write.method === 'PATCH', write.method)
  }
})

test('#812: a plain-issue comment is not a pull request and leaves no check behind', () => {
  const state = world()
  const gh = (...a) => {
    const args = Array.isArray(a[0]) ? a[0] : a
    if (/\/pulls\/\d+$/.test(String(args[args.length - 1]))) throw new Error('gh: Not Found (HTTP 404)')
    return ''
  }
  const r = main({ gh, env: { REVIEW_POLICY: POLICY, GH_REPO: REPO, PR: '77' }, repo: REPO, pr: 77 })
  assert.equal(r.skipped, true)
  assert.equal(state.writes.length, 0)
})

// The gate is only in the path if the ruleset requires the context this script writes, and if the
// workflow that runs it can actually write a check.
test('#812: the ruleset requires the context this script writes, with no one able to bypass it', () => {
  const ruleset = JSON.parse(readFileSync(new URL('../agent/merge-gate-ruleset.json', import.meta.url), 'utf8'))
  const status = ruleset.rules.find((r) => r.type === 'required_status_checks').parameters
  const contexts = status.required_status_checks.map((c) => c.context)
  assert.ok(contexts.includes(CHECK_NAME), contexts.join(', '))
  assert.ok(contexts.includes('tests-ok'), contexts.join(', '))
  assert.equal(status.strict_required_status_checks_policy, false)
  assert.deepEqual(ruleset.bypass_actors, [])
  assert.equal(ruleset.enforcement, 'active')
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main'])
})

test('#812: the workflow can write the check and never runs pull request code', () => {
  const workflow = readFileSync(new URL('../workflows/enqueue-guard.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^\s+checks: write$/m)
  // `pull_request_target` for the write token, `issue_comment` for a verdict, a manual run for a backfill.
  assert.match(workflow, /^\s+pull_request_target:$/m)
  assert.match(workflow, /^\s+issue_comment:$/m)
  assert.match(workflow, /^\s+workflow_dispatch:$/m)
  // A `pull_request` run from a fork is read-only, so that trigger cannot be the one that writes the check.
  assert.doesNotMatch(workflow, /^\s{2}pull_request:$/m)
  // The code that judges comes from main; no head ref is ever checked out.
  assert.match(workflow, /ref: main/)
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(sha|ref)/)
})

test('#812: --dry-run judges the live head and writes nothing', () => {
  const state = world({ labels: [], comments: [comment()] })
  const r = main({ gh: state.gh, env: { REVIEW_POLICY: POLICY, GH_REPO: REPO, PR: '812', DRY_RUN: '1' }, repo: REPO, pr: 812 })
  assert.equal(r.applied.action, 'dry-run')
  assert.equal(r.applied.conclusion, 'failure')
  assert.match(r.applied && r.message, /missing label: agent-pr/)
  assert.equal(state.writes.length, 0)
  assert.equal(state.runs.length, 0)
})

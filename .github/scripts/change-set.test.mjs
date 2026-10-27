// #1317: a tip that moved without changing the reviewed change set must not void the PASS.
//
// The identity is `(path → blob sha)` over the pull request's changed paths, compared at the reviewed
// tip and at the head — content a reviewer actually judged, not the commits that carried it. Everything
// here drives the comparison through injected readers, so the rules run without the network:
// `sameChangeSet` takes `gh`, `decide` takes the helper, and the three-reader test drives `decidePull`
// over a fake repository built from `.github/scripts/fixtures/workflow-cases.json`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sameChangeSet } from './change-set.mjs'
import { decide, loadPolicy } from './review-gate.mjs'
import { judge } from './merge-gate.mjs'
import { decidePull } from './enqueue-guard.mjs'
import { payloadFor } from './gate-check.mjs'

const OLD = '175328d0c1b2a3d4e5f60718293a4b5c6d7e8f90'
const HEAD = 'abaf938b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'
const OLDER = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736'
const PATHS = ['core/src/host/turns.js', 'core/test/gate-check.test.js']
const REPO = 'ThinkFlowLab/FlyBot'
const PR = 1317

// A `gh` that answers trees only, by sha: `trees[sha]` is `{path: blob}`. A sha missing from the map is
// the 404 the real API gives for a rebased-away tip; `bad` marks a tree the API cut short.
const treeGh = (trees, { truncatedAt = null, fail = null } = {}) => (...args) => {
  const path = String(args[args.length - 1])
  const sha = /\/git\/trees\/([0-9a-f]+)/.exec(path)?.[1]
  if (!sha) throw new Error(`fake gh: unexpected read ${path}`)
  if (sha === fail) {
    const error = new Error('Command failed: gh api')
    error.stderr = 'gh: Not Found (HTTP 404)'
    throw error
  }
  if (!trees[sha]) throw new Error(`fake gh: no tree for ${sha}`)
  if (sha === truncatedAt) return JSON.stringify({ truncated: true, tree: [] })
  return JSON.stringify({ truncated: false, tree: Object.entries(trees[sha]).map(([path_, blob]) => ({ path: path_, type: 'blob', sha: blob })) })
}

const identicalTrees = () => ({
  [OLD]: { 'core/src/host/turns.js': 'blob-host', 'core/test/gate-check.test.js': 'blob-test' },
  [HEAD]: { 'core/src/host/turns.js': 'blob-host', 'core/test/gate-check.test.js': 'blob-test' },
})

const say = (txt) => (txt)

const report = ({ tip = OLD, verdict = 'PASS', ran = 'Ran: npm run verify → pass', writtenBy = 'Reviewer', at = '2026-10-25T10:00:00Z' } = {}) => ({
  kind: 'comment',
  login: 'reviewer-agent',
  type: 'User',
  association: 'MEMBER',
  at,
  body: [`Verdict: ${verdict} at ${tip}`, `Written-by: ${writtenBy}`, '', ran].filter((line) => line !== undefined).join('\n'),
})

const policy = { reviewers: ['reviewer-agent'], selfReview: [], writers: ['Reviewer', 'reviewer-agent', 'Dev3'] }
const matching = () => ({ ok: true, paths: PATHS.length })

// --- the helper itself ---------------------------------------------------------------------------

test('#1317: every changed path carrying the same blob is one change set, whatever the commits', () => {
  assert.deepEqual(sameChangeSet({ gh: treeGh(identicalTrees()), repo: REPO, reviewed: OLD, head: HEAD, paths: PATHS }), { ok: true, paths: 2 })
})

test('#1317: one changed blob is a different change set, and the refusal names the first path', () => {
  const trees = identicalTrees()
  trees[HEAD]['core/src/host/turns.js'] = 'blob-host-edited'
  assert.deepEqual(sameChangeSet({ gh: treeGh(trees), repo: REPO, reviewed: OLD, head: HEAD, paths: PATHS }), { ok: false, path: 'core/src/host/turns.js' })
})

test('#1317: a path the tree does not carry on one side is a difference, not a pass', () => {
  const trees = identicalTrees()
  delete trees[HEAD]['core/test/gate-check.test.js']
  assert.deepEqual(sameChangeSet({ gh: treeGh(trees), repo: REPO, reviewed: OLD, head: HEAD, paths: PATHS }), { ok: false, path: 'core/test/gate-check.test.js' })
})

test('#1317: a truncated tree reads as neither equal nor different — it refuses with the read', () => {
  assert.deepEqual(sameChangeSet({ gh: treeGh(identicalTrees(), { truncatedAt: HEAD }), repo: REPO, reviewed: OLD, head: HEAD, paths: PATHS }), { ok: false, read: `git tree of ${HEAD.slice(0, 12)}: truncated` })
})

test('#1317: a tree that 404s refuses and names the read, never "assume unchanged"', () => {
  assert.deepEqual(sameChangeSet({ gh: treeGh(identicalTrees(), { fail: OLD }), repo: REPO, reviewed: OLD, head: HEAD, paths: PATHS }), { ok: false, read: `git tree of ${OLD.slice(0, 12)}: 404` })
})

test('#1317: no changed-path list is nothing to compare, so it refuses', () => {
  assert.equal(sameChangeSet({ gh: treeGh(identicalTrees()), repo: REPO, reviewed: OLD, head: HEAD, paths: [] }).ok, false)
})

test('#1317: a changed-file list that fills the 100-entry page refuses as cut short, never as identical', () => {
  const trees = identicalTrees()
  const paths = Array.from({ length: 100 }, (_, i) => `core/src/host/file-${i}.js`)
  for (const path of paths) { trees[OLD][path] = 'blob-same'; trees[HEAD][path] = 'blob-same' }
  // Every path it was given is identical, so only the page limit can refuse this — which is the point:
  // file 101 is the one that could have moved, and the answer is "could not be read", not "unchanged".
  assert.deepEqual(sameChangeSet({ gh: treeGh(trees), repo: REPO, reviewed: OLD, head: HEAD, paths }), { ok: false, read: 'the changed-file list stops at 100 entries, so it may be cut short' })
  const shortList = paths.slice(0, 99)
  assert.deepEqual(sameChangeSet({ gh: treeGh(trees), repo: REPO, reviewed: OLD, head: HEAD, paths: shortList }), { ok: true, paths: 99 })
})

// --- acceptance 1-5, through `decide` -----------------------------------------------------------

test('#1317 acceptance 1: a repaired tip passes, and the allow sentence names both full shas', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report()], policy, changedPaths: PATHS, sameChangeSet: matching })
  assert.equal(r.ok, true)
  assert.equal(r.carried, true)
  assert.equal(r.reason, `reviewer-agent's PASS at ${OLD} still describes this head ${HEAD}: the change set is identical (every changed path carries the same blob at both tips)`)
})

test('#1317 acceptance 1 knife: deleting the comparison puts the refusal back', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report()], policy, changedPaths: PATHS, sameChangeSet: () => ({ ok: false, read: 'the changed files of this pull request were not read' }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /names 175328d0c1b2, not the tip abaf938b0c1d — the change set could not be read/)
})

test('#1317 acceptance 2: one changed blob refuses, and the refusal names the path', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report()], policy, changedPaths: PATHS, sameChangeSet: () => ({ ok: false, path: 'core/package.json' }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /names 175328d0c1b2, not the tip abaf938b0c1d/)
  assert.match(r.reason, /the change set differs at core\/package\.json, so that conclusion does not describe this head/)
})

test('#1317 acceptance 3: an unreadable tree refuses with the read that failed', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report()], policy, changedPaths: PATHS, sameChangeSet: () => ({ ok: false, read: `git tree of ${OLD.slice(0, 12)}: 404` }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /the change set could not be read \(git tree of 175328d0c1b2: 404\)/)
})

test('#1317 acceptance 4: an INC at the head vetoes, even when the head carries a matching old PASS', () => {
  const r = decide({
    head: HEAD,
    author: 'opener',
    reports: [report(), report({ tip: HEAD, verdict: 'INC', at: '2026-10-25T11:00:00Z' })],
    policy,
    changedPaths: PATHS,
    sameChangeSet: matching,
  })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'INC')
  assert.match(r.reason, /reviewer-agent says INC at this tip/)
})

test('#1317 acceptance 5: the newest matching conclusion wins — an older PASS never outranks a newer INC', () => {
  const newerInc = decide({
    head: HEAD,
    author: 'opener',
    reports: [report({ tip: OLDER, at: '2026-10-25T09:00:00Z' }), report({ tip: OLD, verdict: 'INC', at: '2026-10-25T12:00:00Z' })],
    policy,
    changedPaths: PATHS,
    sameChangeSet: matching,
  })
  assert.equal(newerInc.ok, false)
  assert.equal(newerInc.verdict, 'INC')
  // …and the other way round: the newer of two carried conclusions is the one read.
  const newerPass = decide({
    head: HEAD,
    author: 'opener',
    reports: [report({ tip: OLD, verdict: 'INC', at: '2026-10-25T09:00:00Z' }), report({ tip: OLDER, at: '2026-10-25T12:00:00Z' })],
    policy,
    changedPaths: PATHS,
    sameChangeSet: matching,
  })
  assert.equal(newerPass.ok, true)
  assert.equal(newerPass.tip, OLDER)
})

test('#1317 acceptance 7: nothing else was loosened — a carried PASS with no Ran: still refuses', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report({ ran: '' })], policy, changedPaths: PATHS, sameChangeSet: matching })
  assert.equal(r.ok, false)
  assert.match(r.reason, /lists no command it ran/)
})

test('#1317: a short tip names no head, so it is refused before any comparison', () => {
  let called = false
  const r = decide({ head: HEAD, author: 'opener', reports: [report({ tip: '175328d' })], policy, changedPaths: PATHS, sameChangeSet: () => { called = true; return { ok: true } } })
  assert.equal(r.ok, false)
  assert.equal(called, false)
  assert.match(r.reason, /7 characters/)
})

test('#1317: a caller that read no changed files gets the old refusal, never a pass', () => {
  const r = decide({ head: HEAD, author: 'opener', reports: [report()], policy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not the tip abaf938b0c1d/)
})

// --- acceptance 6: three readers, one answer, from the shared fixture ---------------------------

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/workflow-cases.json', import.meta.url)), 'utf8'))
const policyFile = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'change-set-policy-')), 'review-policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}
const POLICY_PATH = policyFile()
const loaded = loadPolicy(POLICY_PATH)

// One repository built from a fixture entry: the pull request, its changed files, its PASS, and the two
// trees. The guard also reads the body rules and the checkpoint, so the body carries both.
const world = (entry) => {
  const state = { head: entry.head, files: entry.paths, trees: entry.trees }
  // The guard reads the API shapes, so the comment is one: `user.login`, `author_association`,
  // `created_at`. `reports` is that same comment as `decide` reads it, for the third reader.
  const comments = [{ id: 9001, user: { login: 'reviewer-agent', type: 'User' }, author_association: 'MEMBER', created_at: '2026-10-25T10:00:00Z', body: `Verdict: PASS at ${entry.reviewed}\nWritten-by: Reviewer\n\nRan: npm run verify → pass` }]
  const reports = comments.map((c) => ({ id: c.id, kind: 'comment', login: c.user.login, type: c.user.type, body: c.body, at: c.created_at, association: c.author_association }))
  const body = [
    'Owner: Dev3',
    'Reviewer: reviewer-agent',
    `Fixes #${PR}`,
    '',
    '<!-- flybot:checkpoint -->',
    '```json',
    JSON.stringify({
      pr: PR,
      claim: 'Dev3',
      issue: PR,
      summary: 'The guard reads the change set before it voids a PASS. A repaired tip keeps the conclusion it was given. Everything else refuses exactly as before.',
      files: [entry.paths[0]],
      checks: { ran: 'node --test .github/scripts/*.test.mjs', result: 'green', at: entry.head },
      next: 'none — ready for review',
    }, null, 2),
    '```',
    '<!-- /flybot:checkpoint -->',
  ].join('\n')
  const pull = { head: { sha: state.head, repo: { full_name: REPO } }, user: { login: 'opener' }, body, labels: [{ name: 'agent-pr' }], draft: false, merged: false }
  const gh = (...args) => {
    const listArgs = Array.isArray(args[0])
    const argv = listArgs ? args[0] : args.filter((x) => x !== undefined)
    const path = String(argv.find((a) => String(a).startsWith('repos/')) ?? argv[argv.length - 1])
    const jq = argv.indexOf('--jq') >= 0 ? argv[argv.indexOf('--jq') + 1] : undefined
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify(pull)
    if (path.includes('/files')) return state.files.map((f) => JSON.stringify({ filename: f })).join('\n')
    if (path.includes('/comments')) return comments.map((c) => JSON.stringify(c)).join('\n')
    if (path.includes('/reviews')) return ''
    const tree = /\/git\/trees\/([0-9a-f]+)/.exec(path)
    if (tree) {
      const sha = tree[1]
      if (entry.unreadable === sha) {
        const error = new Error('Command failed: gh api')
        error.stderr = 'gh: Not Found (HTTP 404)'
        throw error
      }
      const blobs = state.trees[sha] ?? {}
      return JSON.stringify({ truncated: false, tree: Object.entries(blobs).map(([p, sha_]) => ({ path: p, type: 'blob', sha: sha_ })) })
    }
    if (jq === '.[]') return ''
    throw new Error(`fake gh: unexpected read ${path}`)
  }
  return { gh, pull, reports }
}

const cases = (fixture.changeSetCases ?? []).filter((entry) => entry.readers === true)

test('#1317 acceptance 6: the fixture carries the three-reader cases', () => {
  assert.ok(cases.length >= 3, 'expected the allow, the changed-blob and the unreadable case in workflow-cases.json')
})

for (const entry of cases) {
  test(`#1317 acceptance 6: decidePull, the enqueue-guard check and judge agree — ${entry.id}`, () => {
    const { gh, reports } = world(entry)
    const env = { GH_REPO: REPO, REVIEW_POLICY: POLICY_PATH }
    // Reader 1: the guard's own decision (the printed command's source).
    const decided = decidePull({ gh, env, repo: REPO, pr: PR })
    assert.equal(decided.decision.ok, entry.expect === 'allow')
    assert.ok(decided.decision.message.includes(entry.sentence), `decidePull said ${decided.decision.message}`)
    // Reader 2: the check run the ruleset sees — same decision object, same words.
    const check = payloadFor({ decision: decided.decision, head: entry.head })
    assert.equal(check.conclusion, entry.expect === 'allow' ? 'success' : 'failure')
    assert.ok(check.output.title.includes(entry.sentence), `check title said ${check.output.title}`)
    // Reader 3: `judge`, called on its own the way merge-gate's queue entry calls it.
    const judged = judge({
      labels: ['agent-pr'],
      files: entry.paths,
      head: entry.head,
      author: 'opener',
      reports,
      policy: loaded,
      gh,
      repo: REPO,
      pr: PR,
      body: decided.pull.body,
    })
    const words = judged.ok ? judged.verdict.reason : judged.reasons.join('; ')
    assert.equal(judged.ok, entry.expect === 'allow')
    assert.ok(words.includes(entry.sentence), `judge said ${words}`)
  })
}

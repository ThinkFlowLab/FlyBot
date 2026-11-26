import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditLabels, untouched, GUARDED, announcedPr, claimedBranch } from './label-hygiene.mjs'

// Spawn by absolute path: a relative one only works when cwd is the repo root, and elsewhere node
// exits 1 on every case, which reads as "strip" for the closed-object assertion below.
const SCRIPT = fileURLToPath(new URL('./label-hygiene.mjs', import.meta.url))

const obj = (over = {}) => ({ number: 1, kind: 'issue', state: 'open', labels: [], ...over })
// #3066: no PR number anywhere, only the branch the pickup wrote.
const CLAIM = 'Claim-Id: dfddd1297c094b41a8dfc70778143d10\nBranch: dev/5-missing-changelog-fragment\nBase: 36efafb822fc\n'
const rows = auditLabels
const only = (r) => r.map((x) => [x.verdict, x.reason])[0]

test('agent-working on a closed object is an orphan: nothing is being worked on', () => {
  assert.deepEqual(rows([obj({ number: 9, state: 'closed', labels: ['agent-working'] })]), [
    { number: 9, kind: 'issue', label: 'agent-working', state: 'closed', verdict: 'orphan', reason: 'the issue is closed' }])
})

test('agent-working is decided by the branch it claims, once the branch list is given', () => {
  assert.equal(claimedBranch({ body: CLAIM }), 'dev/5-missing-changelog-fragment')
  const open = obj({ labels: ['agent-working'], body: CLAIM })
  assert.deepEqual(only(rows([open], { refs: ['main', 'dev/5-missing-changelog-fragment'] })), ['keep', 'branch dev/5-missing-changelog-fragment exists'])
  assert.deepEqual(only(rows([open], { refs: ['main'] })), ['orphan', 'branch dev/5-missing-changelog-fragment is gone'])
  assert.deepEqual(only(rows([open])), ['unknown', 'claims branch dev/5-missing-changelog-fragment; pass --refs to check whether it still exists'])
})

test('agent-pr: on a PR its own state decides; on an issue it dies with the PR the body names', () => {
  assert.deepEqual(only(rows([{ number: 7, state: 'open', pull_request: {}, labels: ['agent-pr'] }])), ['keep', 'PR #7 is open'])
  assert.deepEqual(only(rows([{ number: 7, state: 'closed', pull_request: {}, labels: ['agent-pr'] }])), ['orphan', 'PR #7 is closed'])
  const issue = (body = 'Related #3067') => obj({ labels: ['agent-pr'], body })
  assert.deepEqual(only(rows([issue()], { prs: { 3067: { state: 'open' } } })), ['keep', 'PR #3067 is open'])
  assert.deepEqual(only(rows([issue()], { prs: { 3067: { state: 'closed', merged: false } } })), ['orphan', 'PR #3067 is closed unmerged'])
  assert.deepEqual(only(rows([issue()], { prs: { 3067: { state: 'open', branch_exists: false } } })), ['orphan', 'PR #3067 is open but its branch is gone'])
  assert.deepEqual(only(rows([issue()], { prs: {} })), ['orphan', 'PR #3067 is not in the list given, so it is not open'])
})

// One saved /pulls list decides #3066, because each PR says which branch it came from.
test('a branch the body claims finds its PR in a saved /pulls list', () => {
  assert.equal(announcedPr({ number: 3066, body: CLAIM }), null)
  const at = (state, ref) => ({ number: 3067, state, merged: false, head: { ref } })
  const mine = obj({ number: 3066, labels: ['agent-pr'], body: CLAIM })
  assert.deepEqual(only(rows([mine], { prs: [at('closed', 'dev/5-missing-changelog-fragment')] })), ['orphan', 'PR #3067 is closed unmerged'])
  assert.deepEqual(only(rows([mine], { prs: [at('open', 'dev/5-missing-changelog-fragment')] })), ['keep', 'PR #3067 is open'])
  assert.deepEqual(only(rows([mine], { refs: ['main'] })),
    ['orphan', 'claims branch dev/5-missing-changelog-fragment, which is gone, so no open PR carries it'])
})

// The v1 bug: on a raw payload it printed "0 orphan" and exited 0 - a gate that can never fail.
test('a label the payload cannot decide is reported, never counted as clean', () => {
  assert.deepEqual(only(rows([obj({ labels: ['agent-pr'], body: CLAIM })])), ['unknown', 'open, but the body names no PR and no PR list was given'])
  assert.deepEqual(only(rows([obj({ labels: ['agent-working'] })])), ['unknown', 'open, with no Branch: line and no work_live fact: liveness is not in the payload'])
})

test('only the two agent labels are in scope, and the rest is listed instead of ignored', () => {
  const items = [obj({ number: 1, labels: ['agent-working', 'hold', 'needs-human'], state: 'closed' }),
    obj({ number: 2, labels: [{ name: 'risk:T3' }, 'area:security', 'hold'] })]
  assert.deepEqual(rows(items).map((r) => r.label), ['agent-working'], 'hold and needs-human are never stripped here')
  assert.deepEqual(GUARDED, ['agent-working', 'agent-pr'])
  assert.deepEqual(untouched(items), [{ label: 'hold', count: 2 }, { label: 'area:security', count: 1 },
    { label: 'needs-human', count: 1 }, { label: 'risk:T3', count: 1 }])
})

// QA payload only; the cases above cover CI.
const snapshot = '/data/workspace/.qa-triage/raw/open.json'
test('fixture: the raw open snapshot cannot come out clean while #3066 says a PR carries it',
  { skip: existsSync(snapshot) ? false : 'QA payload is not on this machine; CI covers the same cases above' }, () => {
    const raw = readFileSync(snapshot)
    assert.equal(createHash('sha256').update(raw).digest('hex'),
      'b93ccd34cd3a3aad2082103bed7c192fccfd9adfcfc582ced7b5b82a863b8290', 'a changed fixture voids these numbers')
    const items = JSON.parse(raw).map((i) => ({ number: i.number, kind: i.pull_request ? 'pr' : 'issue', state: i.state, body: i.body, labels: i.labels }))
    assert.deepEqual(only(rows(items.filter((i) => i.number === 3066))), ['unknown', 'open, but the body names no PR and no PR list was given'])
    assert.equal(items.filter((i) => (i.labels ?? []).some((l) => (l.name ?? l) === 'agent-working')).length, 0, 'agent-working is on no open object')
  })

test('exit status separates strip / cannot judge / clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyg-'))
  const save = (name, data) => {
    const path = join(dir, `${name}.json`)
    writeFileSync(path, JSON.stringify(data))
    return path
  }
  const status = (items, extra = []) => spawnSync(process.execPath,
    [SCRIPT, '--issues', save(Math.random().toString(36).slice(2), { items }), ...extra],
    { encoding: 'utf8' }).status
  const refs = ['--refs', save('refs', ['dev/5-missing-changelog-fragment'])]
  assert.equal(status([obj({ number: 1, state: 'closed', labels: ['agent-pr'] })]), 1, 'a closed object is a strip')
  assert.equal(status([obj({ number: 2, labels: ['agent-working'], body: CLAIM })]), 2, 'no --refs, nobody can judge it')
  assert.equal(status([obj({ number: 3, labels: ['hold'] })]), 0, 'a label outside the pair is clean')
  assert.equal(status([obj({ number: 4, labels: ['agent-working'], body: CLAIM })], refs), 0, 'the branch exists')
})

test('label hygiene cannot write either', () => {
  const src = readFileSync(new URL('./label-hygiene.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process/)
  assert.doesNotMatch(src, /method:\s*['"](POST|PATCH|DELETE)['"]|fetch\(/)
})

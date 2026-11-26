import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { auditLabels, untouched, GUARDED } from './label-hygiene.mjs'

const item = (over = {}) => ({ number: 1, kind: 'issue', state: 'open', labels: [], ...over })

test('agent-working on a closed object is an orphan: nothing is being worked on', () => {
  const rows = auditLabels([item({ number: 9, state: 'closed', labels: ['agent-working'] })])
  assert.deepEqual(rows, [{ number: 9, kind: 'issue', label: 'agent-working', state: 'closed', verdict: 'orphan', reason: 'the issue is closed' }])
})

test('agent-working on an open object survives only while the work is live', () => {
  assert.deepEqual(auditLabels([item({ labels: ['agent-working'], work_live: true })]), [])
  const rows = auditLabels([item({ labels: ['agent-working'], work_live: false })])
  assert.equal(rows[0].verdict, 'orphan')
  assert.match(rows[0].reason, /no open PR and no branch/)
})

test('agent-pr survives while its PR is open, and dies with the PR', () => {
  const open = auditLabels([item({ labels: ['agent-pr'], announces_pr: 3067 })], { 3067: { state: 'open' } })
  assert.deepEqual(open.map((r) => [r.label, r.verdict]), [['agent-pr', 'keep']])
  const closed = auditLabels([item({ labels: ['agent-pr'], announces_pr: 3067 })], { 3067: { state: 'closed', merged: false } })
  assert.equal(closed[0].verdict, 'orphan')
  assert.match(closed[0].reason, /closed unmerged/)
  const merged = auditLabels([item({ labels: ['agent-pr'], announces_pr: 3067 })], { 3067: { state: 'closed', merged: true } })
  assert.match(merged[0].reason, /merged/)
  const branchGone = auditLabels([item({ labels: ['agent-pr'], announces_pr: 3067 })], { 3067: { state: 'open', branch_exists: false } })
  assert.equal(branchGone[0].verdict, 'orphan')
  assert.match(branchGone[0].reason, /branch is gone/)
})

test('a fact we were not given is not a verdict: an unknown PR is reported, not assumed open', () => {
  const rows = auditLabels([item({ labels: ['agent-pr'], announces_pr: 999 })], {})
  assert.equal(rows[0].verdict, 'orphan')
  assert.match(rows[0].reason, /not in the facts given/)
  assert.deepEqual(auditLabels([item({ labels: ['agent-pr'], state: 'open' })]), [], 'no PR named and the object is open: nothing to judge')
})

test('only the two agent labels are in scope, and the rest is listed instead of ignored', () => {
  const items = [
    item({ number: 1, labels: ['agent-working', 'hold', 'needs-human'], state: 'closed' }),
    item({ number: 2, labels: ['risk:T3', 'area:security', 'hold'] }),
  ]
  const rows = auditLabels(items)
  assert.deepEqual(rows.map((r) => r.label), ['agent-working'], 'hold and needs-human are never stripped here')
  assert.deepEqual(GUARDED, ['agent-working', 'agent-pr'])
  assert.deepEqual(untouched(items), [
    { label: 'hold', count: 2 },
    { label: 'area:security', count: 1 },
    { label: 'needs-human', count: 1 },
    { label: 'risk:T3', count: 1 },
  ])
})

test('labels arrive either as names or as API objects', () => {
  const rows = auditLabels([{ number: 5, state: 'closed', labels: [{ name: 'agent-pr' }], pull_request: {} }])
  assert.equal(rows[0].kind, 'pr')
  assert.equal(rows[0].label, 'agent-pr')
})

// A dry run is only worth something if it can be diffed against a second opinion.
const snapshot = '/data/workspace/.qa-triage/raw/open.json'
test('dry run on the QA open snapshot names exactly one orphan and leaves the rest alone',
  { skip: existsSync(snapshot) ? false : 'QA snapshot not on this machine' }, () => {
    const raw = JSON.parse(readFileSync(snapshot, 'utf8'))
    const items = (raw.items ?? raw).map((i) => ({
      number: i.number, kind: i.pull_request ? 'pr' : 'issue', state: i.state,
      labels: (i.labels ?? []).map((l) => l.name ?? l),
      ...(i.number === 3066 ? { announces_pr: 3067 } : {}),
    }))
    const rows = auditLabels(items, { 3067: { state: 'closed', merged: false, branch_exists: false } })
    assert.deepEqual(rows.map((r) => [r.number, r.label, r.verdict]), [[3066, 'agent-pr', 'orphan']])
    assert.equal(items.filter((i) => i.labels.includes('agent-working')).length, 0, 'agent-working is on no open object')
  })

test('label hygiene cannot write either', () => {
  const src = readFileSync(new URL('./label-hygiene.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process/)
  assert.doesNotMatch(src, /method:\s*['"](POST|PATCH|DELETE)['"]/)
  assert.doesNotMatch(src, /fetch\(/)
})

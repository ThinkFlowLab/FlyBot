// #3401: the merge gate. Four gates a pull request must pass before anyone merges it: head and
// state, every required check green on that exact head, both pieces of evidence bound to that exact
// head, and the risk label - whose tier is advisory only since the merge is the Lead's call (user,
// 2026-11-26), while a missing or doubled label still fails as a matter of record. The list of
// required checks is a constant in merge-gate.mjs on purpose; these tests pin that behaviour, the
// head binding, and the exit codes the five --self-test fixtures claim.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QA_MARKER,
  REQUIRED_CHECKS,
  REVIEW_MARKER,
  ROLLUP_CHECK,
  SELF_TEST_CASES,
  evaluate,
  render,
} from './merge-gate.mjs'

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OLD = 'ffffffffffffffffffffffffffffffffffffffff'

const runs = (over = {}) => [
  ...REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success', started_at: '2026-11-26T09:00:00Z', ...over })),
  { name: ROLLUP_CHECK, status: 'completed', conclusion: 'success', started_at: '2026-11-26T09:00:00Z', ...over },
]

const pr = (over = {}) => ({
  state: 'open',
  draft: false,
  mergeable: true,
  base: { ref: 'main' },
  head: { sha: HEAD },
  labels: [{ name: 'risk:T1' }],
  ...over,
})

const comments = () => [
  { id: 1, body: `**Head** \`${HEAD}\`\n\n${QA_MARKER}\n` },
  { id: 2, body: `## Lead 评审记录\n\nhead \`${HEAD}\`\n` },
]

const detail = (result) => result.gates.flatMap((g) => g.detail).join('\n')

test('all green passes, and the five --self-test cases behave as they claim', () => {
  const ok = evaluate({ number: 1, pr: pr(), checkRuns: runs(), comments: comments() })
  assert.equal(ok.pass, true)
  assert.equal(ok.gates.length, 4)
  assert.deepEqual(ok.gates.map((g) => g.pass), [true, true, true, true])

  for (const c of SELF_TEST_CASES) {
    const result = evaluate(c.fixture)
    assert.equal(result.pass, c.expect, `${c.name}: exit ${result.pass ? 0 : 1}`)
    if (c.expectDetail) assert.ok(detail(result).includes(c.expectDetail), `${c.name}: ${detail(result)}`)
  }
})

test('a missing check name fails and is named, never silently skipped', () => {
  const gone = REQUIRED_CHECKS[3]
  const result = evaluate({ number: 2, pr: pr(), checkRuns: runs().filter((r) => r.name !== gone), comments: comments() })
  assert.equal(result.pass, false)
  assert.match(detail(result), new RegExp(`missing: ${gone.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`))
  // And the count is the constant's, not the API's: dropping a run cannot shrink the requirement.
  assert.equal(REQUIRED_CHECKS.length, 15)
})

test('in_progress, failure and cancelled all fail, with the state in the output', () => {
  for (const [status, conclusion] of [['in_progress', null], ['completed', 'failure'], ['completed', 'cancelled']]) {
    const bad = runs().map((r) => (r.name === 'browser / screenshots' ? { ...r, status, conclusion } : r))
    const result = evaluate({ number: 3, pr: pr(), checkRuns: bad, comments: comments() })
    assert.equal(result.pass, false, `${status}|${conclusion}`)
    assert.match(detail(result), /browser \/ screenshots/)
  }
})

test('a re-run cannot hide behind an earlier green attempt of the same name', () => {
  const rerun = [
    ...runs(),
    { name: 'Web and compose planner', status: 'completed', conclusion: 'failure', started_at: '2026-11-26T09:30:00Z' },
  ]
  const result = evaluate({ number: 4, pr: pr(), checkRuns: rerun, comments: comments() })
  assert.equal(result.pass, false)
  assert.match(detail(result), /not green: Web and compose planner/)
})

test('gate 1: draft, closed, unmergeable, wrong base and a non-sha head each fail', () => {
  const cases = [
    [{ draft: true }, /draft/],
    [{ state: 'closed' }, /state is closed/],
    [{ mergeable: false }, /mergeable is false/],
    [{ mergeable: null }, /not computed yet/],
    [{ base: { ref: 'dev/x' } }, /base is dev\/x/],
    [{ head: { sha: 'abc123' } }, /not a 40-character sha/],
  ]
  for (const [over, expected] of cases) {
    const result = evaluate({ number: 5, pr: pr(over), checkRuns: runs(), comments: comments() })
    assert.equal(result.pass, false, JSON.stringify(over))
    assert.match(detail(result), expected)
  }
})

test('gate 3: evidence binds the exact head, so a new commit voids both pieces at once', () => {
  const stale = [
    { id: 1, body: `**Head** \`${OLD}\`\n\n${QA_MARKER}\n` },
    { id: 2, body: `## Lead 评审记录\n\nhead \`${OLD}\`\n` },
  ]
  const result = evaluate({ number: 6, pr: pr(), checkRuns: runs(), comments: stale })
  assert.equal(result.pass, false)
  assert.match(detail(result), new RegExp(`no comment carries ${HEAD.slice(0, 10)}`))

  // A comment that names the head but not the marker is not evidence.
  const noMarker = [
    { id: 1, body: `Head \`${HEAD}\` - looks good to me` },
    { id: 2, body: `## Lead 评审记录\n\nhead \`${HEAD}\`\n` },
  ]
  assert.equal(evaluate({ number: 7, pr: pr(), checkRuns: runs(), comments: noMarker }).pass, false)

  // One comment carrying both markers satisfies both gates; that is a process smell, not a blocker.
  const both = [{ id: 9, body: `## Lead 评审记录\n\nhead \`${HEAD}\`\n\n${QA_MARKER}\n` }]
  assert.equal(evaluate({ number: 8, pr: pr(), checkRuns: runs(), comments: both }).pass, true)
})

test('gate 4: a missing or doubled label fails as a matter of record; every tier passes as a tier', () => {
  const run = (labels) => evaluate({ number: 9, pr: pr({ labels }), checkRuns: runs(), comments: comments() })
  // Missing and doubled labels are facts about the record, not tier judgements, so they still fail.
  assert.equal(run([]).pass, false)
  assert.match(detail(run([])), /no risk:T0\.\.T3 label/)
  assert.equal(run([{ name: 'risk:T1' }, { name: 'risk:T2' }]).pass, false)
  assert.match(detail(run([{ name: 'risk:T1' }, { name: 'risk:T2' }])), /more than one risk label/)
  // The tier itself never holds a merge back, T3 included.
  for (const label of ['risk:T0', 'risk:T1', 'risk:T2', 'risk:T3']) {
    const result = run([{ name: label }])
    assert.equal(result.pass, true, label)
    assert.match(detail(result), new RegExp(`${label} - advisory only, merge is Lead's call`))
  }
  // No approval label exists any more: the branch that used to wait for one is gone, not unreachable.
  assert.equal(run([{ name: 'risk:T3' }, { name: 'risk-approved:t3' }]).pass, true)
})

test('render names every gate and its verdict, and a failure is visible in the first line', () => {
  const ok = evaluate({ number: 10, pr: pr(), checkRuns: runs(), comments: comments() })
  assert.match(render(ok), /PR #10 head .* -> PASS \(4\/4 gates\)/)
  assert.match(render(ok), /1\. head and state +PASS/)
  assert.match(render(ok), /4\. risk \(advisory\) +PASS/)

  const bad = evaluate({ number: 11, pr: pr({ draft: true }), checkRuns: runs(), comments: comments() })
  assert.match(render(bad), /-> FAIL \(3\/4 gates\)/)
  assert.match(render(bad), /draft is true/)
})

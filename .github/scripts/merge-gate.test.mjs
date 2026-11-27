// #3401: the merge gate. Four gates a pull request must pass before anyone merges it: head and
// state, every required check green on that exact head, both pieces of evidence bound to that exact
// head, and the risk label - whose tier is advisory only since the merge is the Lead's call (user,
// 2026-11-26), while a missing or doubled label still fails as a matter of record. The list of
// required checks is a constant in merge-gate.mjs on purpose; these tests pin that behaviour, the
// head binding, and the exit codes the five --self-test fixtures claim.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LEGACY_QA_MARKER,
  LEGACY_REVIEW_MARKER,
  QA_MARKER,
  QA_MARKERS,
  REQUIRED_CHECKS,
  REVIEW_MARKER,
  REVIEW_MARKERS,
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
  { id: 2, body: `## ${REVIEW_MARKER}\n\nhead \`${HEAD}\`\n` },
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
    { id: 2, body: `## ${REVIEW_MARKER}\n\nhead \`${OLD}\`\n` },
  ]
  const result = evaluate({ number: 6, pr: pr(), checkRuns: runs(), comments: stale })
  assert.equal(result.pass, false)
  assert.match(detail(result), new RegExp(`no comment carries ${HEAD.slice(0, 10)}`))

  // A comment that names the head but not the marker is not evidence.
  const noMarker = [
    { id: 1, body: `Head \`${HEAD}\` - looks good to me` },
    { id: 2, body: `## ${REVIEW_MARKER}\n\nhead \`${HEAD}\`\n` },
  ]
  assert.equal(evaluate({ number: 7, pr: pr(), checkRuns: runs(), comments: noMarker }).pass, false)

  // One comment carrying both markers satisfies both gates; that is a process smell, not a blocker.
  const both = [{ id: 9, body: `## ${REVIEW_MARKER}\n\nhead \`${HEAD}\`\n\n${QA_MARKER}\n` }]
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

// The markers are English since 2026-11-27, when the repository switched to English for everything
// it writes; the Chinese sentences were required until then and are still on real pull requests, so
// they keep counting as evidence instead of turning every older PR into a gate-3 failure.
test('gate 3: the English markers pass', () => {
  const english = [
    { id: 31, body: `**Head** \`${HEAD}\`\n\n${QA_MARKER}\n` },
    { id: 32, body: `## ${REVIEW_MARKER}\n\nhead \`${HEAD}\`\n` },
  ]
  const result = evaluate({ number: 20, pr: pr(), checkRuns: runs(), comments: english })
  assert.equal(result.pass, true)
  assert.match(detail(result), /QA #31; review #32/)
})

test('gate 3: only the legacy sentences still pass', () => {
  const legacy = [
    { id: 33, body: `**Head** \`${HEAD}\`\n\n${LEGACY_QA_MARKER}\n` },
    { id: 34, body: `## ${LEGACY_REVIEW_MARKER}\n\nhead \`${HEAD}\`\n` },
  ]
  const result = evaluate({ number: 21, pr: pr(), checkRuns: runs(), comments: legacy })
  assert.equal(result.pass, true)
  assert.match(detail(result), /QA #33; review #34/)

  // The legacy strings must be the exact old sentences, not lookalikes: their code points are pinned
  // here, so a typo in the \u escapes cannot silently stop matching comments that already exist.
  assert.equal(LEGACY_QA_MARKER, Buffer.from('e69cace8af81e68daee4b88de69e84e68890e9aa8ce694b6e9809ae8bf87', 'hex').toString('utf8'))
  assert.equal(LEGACY_REVIEW_MARKER, Buffer.from('4c65616420e8af84e5aea1e8aeb0e5bd95', 'hex').toString('utf8'))
  assert.deepEqual(QA_MARKERS, [QA_MARKER, LEGACY_QA_MARKER])
  assert.deepEqual(REVIEW_MARKERS, [REVIEW_MARKER, LEGACY_REVIEW_MARKER])
})

test('gate 3: a head with neither marker fails', () => {
  const neither = [
    { id: 41, body: `Head \`${HEAD}\` - looks good to me` },
    { id: 42, body: `Head \`${HEAD}\` - reviewed` },
  ]
  const result = evaluate({ number: 22, pr: pr(), checkRuns: runs(), comments: neither })
  assert.equal(result.pass, false)
  assert.equal(result.gates[2].pass, false)
  assert.match(detail(result), /no comment carries a1b2c3d4e5 and /)
})

test('gate 3: the failure names every accepted literal, so the author knows what to paste', () => {
  const neither = [
    { id: 43, body: `Head \`${HEAD}\` - looks good to me` },
    { id: 44, body: `Head \`${HEAD}\` - reviewed` },
  ]
  const text = detail(evaluate({ number: 23, pr: pr(), checkRuns: runs(), comments: neither }))
  for (const marker of [...QA_MARKERS, ...REVIEW_MARKERS]) {
    assert.ok(text.includes(`"${marker}"`), `failure detail must name "${marker}", got: ${text}`)
  }
})

// The template is what authors copy, so its section 5 heading has to be the current QA marker word for
// word: a comment pasted from it then passes gate 3 without anyone remembering a second sentence.
test('the QA evidence template is English and its section 5 heading is the current QA marker', () => {
  const template = readFileSync(new URL('../../docs/qa-evidence-template.md', import.meta.url), 'utf8')
  assert.equal((template.match(/[\u4e00-\u9fff]/g) || []).length, 0, 'the template must have no Chinese left')
  const escaped = QA_MARKER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  assert.match(template, new RegExp(`^### 5\\. ${escaped}$`, 'm'))
})

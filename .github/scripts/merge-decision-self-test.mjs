// The fixtures behind `--self-test`: no network, no files. Issue #3407.
//
// The first fixture is PR #3406 (head 5072d22d, merged as 60e80980): the failed-then-green attempts
// are the real ones, read from the check-runs endpoint with filter=all on 2026-11-27. The gate block
// is the merge-gate result as it stood at merge time - the PR is closed now, so gate 1 cannot be
// re-read.
import { REQUIRED, decide, render } from './merge-decision-core.mjs'
import { REQUIRED_CHECKS, ROLLUP_CHECK } from './merge-gate-core.mjs'

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const HEAD_3406 = '5072d22dbda12a31b15c4a50071fbcf1ee3fdad7'
const OLD = '0000000000000000000000000000000000000000'

const greenHistory = () => REQUIRED.map((name) => ({ name, attempts: [{ conclusion: 'success', started_at: '2026-11-27T04:40:00Z' }] }))

export function gatesFor(head, over = {}) {
  const detail = over.detail ?? {}
  const flag = (n) => detail[n] === undefined || detail[n] === true
  const gates = [
    { n: 1, name: 'head and state', pass: flag(1), detail: [over.g1 ?? `open, not a draft, mergeable, base main, head ${head}`] },
    { n: 2, name: 'required checks', pass: flag(2), detail: [over.g2 ?? `${REQUIRED_CHECKS.length} required checks and FlyBot required checks completed success on ${head.slice(0, 10)}`] },
    { n: 3, name: 'evidence on this head', pass: flag(3), detail: [over.g3 ?? `QA #11; review #12 - both name ${head.slice(0, 10)}`] },
    { n: 4, name: 'risk (advisory)', pass: flag(4), detail: [over.g4 ?? 'risk:T1 - advisory only, merge is Lead\'s call'] },
  ]
  return { number: over.number ?? 1, head, pass: over.pass ?? gates.every((g) => g.pass), gates }
}

const input = (over = {}) => ({ head: HEAD, gate: gatesFor(HEAD), checks: greenHistory(), ...over })

// PR #3406 as it stood at merge time: same head, TWO failed attempts that were green on the re-run -
// the rollup gate and one runtime-image job. Their runs and timestamps are the real ones from the
// check-runs endpoint (filter=all, read 2026-11-27). The other fourteen checks are represented by one
// success each: they also ran twice and were green twice, which changes nothing for the verdict. The
// full sixteen-check history is in fixtures/merge-decision-3406.json, and merge-decision.test.mjs
// fails if that file and this snapshot disagree.
const RUNTIME_IMAGE = 'runtime-image / Build and smoke under the manager contract'

export const SNAPSHOT_3406 = {
  head: HEAD_3406,
  gate: gatesFor(HEAD_3406, {
    number: 3406,
    g3: 'QA #7210114758; review #7210116921 - both name 5072d22d',
    g4: 'risk:T3 - advisory only, merge is Lead\'s call',
  }),
  checks: [
    ...greenHistory().filter((c) => c.name !== ROLLUP_CHECK && c.name !== RUNTIME_IMAGE),
    {
      name: RUNTIME_IMAGE,
      attempts: [
        { run: 140310751457, conclusion: 'failure', started_at: '2026-11-27T04:23:24Z', completed_at: '2026-11-27T04:23:34Z' },
        { run: 140314992429, conclusion: 'success', started_at: '2026-11-27T04:37:06Z', completed_at: '2026-11-27T04:37:16Z' },
      ],
    },
    {
      name: ROLLUP_CHECK,
      attempts: [
        { run: 140312199514, conclusion: 'failure', started_at: '2026-11-27T04:28:04Z', completed_at: '2026-11-27T04:28:08Z' },
        { run: 140316751442, conclusion: 'success', started_at: '2026-11-27T04:42:58Z', completed_at: '2026-11-27T04:43:03Z' },
      ],
    },
  ],
  tier: 'T3',
}

export const SELF_TEST_CASES = [
  {
    name: 'PR #3406 replay: two failed-then-green checks on one head -> merge, recorded as flakes',
    fixture: SNAPSHOT_3406,
    expect: 'merge',
    expectText: ['flake', '140312199514', '140316751442', '140310751457', '140314992429', 'not clean green'],
    notText: ['clean green on this head'],
  },
  {
    name: 'all sixteen checks one success on a fresh head -> merge, no caveat',
    fixture: input(),
    expect: 'merge',
    expectText: ['Merging', 'Tier risk:T1 is advisory'],
    notText: ['flake'],
  },
  {
    name: 'T0 and T3 decide the same -> the tier never changes the verdict',
    fixture: input({ tier: 'T0' }),
    expect: 'merge',
    expectText: ['risk:T0', 'advisory'],
  },
  {
    name: 'gate 2 fails -> hold, and the tier is not the reason',
    fixture: input({ gate: gatesFor(HEAD, { number: 7, detail: { 2: false }, g2: 'not green: Web and compose planner completed|failure' }) }),
    expect: 'hold',
    expectText: ['gate 2 (required checks) failed', 'not green: Web and compose planner'],
  },
  {
    name: 'gate 3 fails (evidence binds an older head) -> hold',
    fixture: input({ gate: gatesFor(HEAD, { number: 8, detail: { 3: false }, g3: `no comment carries ${HEAD.slice(0, 10)} and the QA marker` }) }),
    expect: 'hold',
    expectText: ['gate 3 (evidence on this head) failed'],
  },
  {
    name: 'two risk labels -> hold: the record is incomplete, not the tier',
    fixture: input({ gate: gatesFor(HEAD, { number: 9, detail: { 4: false }, g4: 'more than one risk label: risk:T1 risk:T2' }) }),
    expect: 'hold',
    expectText: ['the record is incomplete, not the tier'],
  },
  {
    name: 'gate result belongs to an older head -> invalid, no verdict',
    fixture: input({ head: HEAD, gate: gatesFor(OLD) }),
    expect: 'invalid',
    expectText: ['stale gate result proves nothing'],
  },
  {
    name: 'no run history at all -> invalid, refused instead of assumed clean',
    fixture: (() => { const f = input(); delete f.checks; return f })(),
    expect: 'invalid',
    expectText: ['cannot tell a clean run from a flake'],
  },
  {
    name: 'gate 2 passes but the newest attempt of a check failed -> hold',
    fixture: (() => {
      const f = input()
      f.checks = f.checks.map((c) => (c.name === ROLLUP_CHECK ? { name: c.name, attempts: [{ run: 5, conclusion: 'failure', started_at: '2026-11-27T04:30:00Z' }] } : c))
      return f
    })(),
    expect: 'hold',
    expectText: ['gate 2 says this check is success, but the newest attempt'],
  },
  {
    name: 'history covers 15 of 16 required checks -> merge, coverage stated, uncovered not called clean',
    fixture: input({ checks: greenHistory().filter((c) => c.name !== ROLLUP_CHECK) }),
    expect: 'merge',
    expectText: ['run history covers 15 of 16 required checks'],
  },
]

export function selfTest() {
  let bad = 0
  for (const c of SELF_TEST_CASES) {
    const result = decide(c.fixture)
    const text = render(result)
    const ok = result.verdict === c.expect
      && (c.expectText || []).every((t) => text.includes(t))
      && (c.notText || []).every((t) => !text.includes(t))
    if (!ok) bad++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: verdict ${result.verdict}, exit ${result.code}${c.expect !== result.verdict ? `, expected ${c.expect}` : ''}`)
    if (!ok || process.env.VERBOSE) console.log(text.replace(/^/gm, '     '))
  }
  console.log(`self-test: ${SELF_TEST_CASES.length - bad}/${SELF_TEST_CASES.length} cases as expected`)
  return bad === 0
}

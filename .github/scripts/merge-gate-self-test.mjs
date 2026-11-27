// The fixtures behind `--self-test`: five cases, no network. Kept apart from the gate itself so the
// gate file stays small enough to write through the connector, and so the fixtures can be read
// without the REST half in the way. Issue #3401.
import { QA_MARKER, REQUIRED_CHECKS, ROLLUP_CHECK, evaluate, render } from './merge-gate-core.mjs'

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OLD = '0000000000000000000000000000000000000000'

const greenRuns = () => [
  ...REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  { name: ROLLUP_CHECK, status: 'completed', conclusion: 'success' },
]

const basePr = (over = {}) => ({
  state: 'open',
  draft: false,
  mergeable: true,
  base: { ref: 'main' },
  head: { sha: HEAD },
  labels: [{ name: 'risk:T1' }],
  ...over,
})

const goodComments = () => [
  { id: 11, body: `## QA 证据（exact head）\n\n**Head** \`${HEAD}\`\n\n${QA_MARKER}\n` },
  { id: 12, body: `## Lead 评审记录\n\nhead \`${HEAD}\`\n` },
]

export const SELF_TEST_CASES = [
  {
    name: 'everything green',
    expect: true,
    fixture: { number: 1, pr: basePr(), checkRuns: greenRuns(), comments: goodComments() },
  },
  {
    name: 'rollup check missing',
    expect: false,
    expectDetail: `missing: ${ROLLUP_CHECK}`,
    fixture: { number: 2, pr: basePr(), checkRuns: greenRuns().filter((r) => r.name !== ROLLUP_CHECK), comments: goodComments() },
  },
  {
    name: 'QA evidence binds an older head',
    expect: false,
    expectDetail: 'no comment carries',
    fixture: {
      number: 3,
      pr: basePr(),
      checkRuns: greenRuns(),
      comments: [
        { id: 21, body: `**Head** \`${OLD}\`\n\n${QA_MARKER}\n` },
        { id: 22, body: `## Lead 评审记录\n\nhead \`${HEAD}\`\n` },
      ],
    },
  },
  {
    name: 'risk:T3 is advisory, not a blocker',
    expect: true,
    expectDetail: "risk:T3 - advisory only, merge is Lead's call",
    fixture: { number: 4, pr: basePr({ labels: [{ name: 'risk:T3' }] }), checkRuns: greenRuns(), comments: goodComments() },
  },
  {
    name: 'two risk labels',
    expect: false,
    expectDetail: 'more than one risk label: risk:T1 risk:T2',
    fixture: { number: 5, pr: basePr({ labels: [{ name: 'risk:T1' }, { name: 'risk:T2' }] }), checkRuns: greenRuns(), comments: goodComments() },
  },
]

export function selfTest() {
  let bad = 0
  for (const c of SELF_TEST_CASES) {
    const result = evaluate(c.fixture)
    const detail = result.gates.flatMap((g) => g.detail).join('\n')
    const ok = result.pass === c.expect && (!c.expectDetail || detail.includes(c.expectDetail))
    if (!ok) bad++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: exit ${result.pass ? 0 : 1}${c.expectDetail ? `, expects "${c.expectDetail}"` : ''}`)
    if (!ok || process.env.VERBOSE) console.log(render(result).replace(/^/gm, '     '))
  }
  console.log(`self-test: ${SELF_TEST_CASES.length - bad}/${SELF_TEST_CASES.length} cases as expected`)
  return bad === 0
}

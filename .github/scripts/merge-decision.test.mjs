// Unit tests for the merge decision (issue #3407). No network.
//   node --test .github/scripts/merge-decision.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { decide, REQUIRED, render, tierOf, validate, VERDICT } from './merge-decision-core.mjs'
import { gatesFor, SELF_TEST_CASES, SNAPSHOT_3406 } from './merge-decision-self-test.mjs'
import { ROLLUP_CHECK } from './merge-gate-core.mjs'

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const green = () => REQUIRED.map((name) => ({ name, attempts: [{ conclusion: 'success', started_at: '2026-11-27T04:40:00Z' }] }))
const input = (over = {}) => ({ head: HEAD, gate: gatesFor(HEAD), checks: green(), ...over })

test('PR #3406 replay: merge, both real failed-then-green pairs named', () => {
  const result = decide(SNAPSHOT_3406)
  assert.equal(result.verdict, VERDICT.merge)
  assert.equal(result.code, 0)
  assert.equal(result.flakes.length, 2)
  for (const run of [140312199514, 140316751442, 140310751457, 140314992429]) {
    assert.match(result.record, new RegExp(String(run)))
  }
  assert.match(result.record, /flake/)
  assert.match(result.record, /not clean green/)
  assert.doesNotMatch(result.record, /clean green on this head/)
  assert.equal(result.tier, 'T3')
})

test('the fixture file matches the snapshot: same head, same two flakes', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/merge-decision-3406.json', import.meta.url), 'utf8'))
  const result = decide(fixture)
  assert.equal(fixture.head, SNAPSHOT_3406.head)
  assert.equal(result.verdict, VERDICT.merge)
  assert.deepEqual(result.flakes.map((f) => f.name).sort(), ['FlyBot required checks', 'runtime-image / Build and smoke under the manager contract'])
  const ids = (r) => r.flakes.flatMap((f) => f.attempts.filter((a) => a.conclusion !== 'success').map((a) => a.run)).sort((a, b) => a - b)
  assert.deepEqual(ids(result), ids(decide(SNAPSHOT_3406)))
})

test('the tier never decides: T0 and T3 produce the same verdict and code', () => {
  const verdicts = ['T0', 'T1', 'T2', 'T3'].map((tier) => decide(input({ tier })))
  assert.deepEqual(verdicts.map((r) => r.verdict), ['merge', 'merge', 'merge', 'merge'])
  assert.deepEqual(verdicts.map((r) => r.code), [0, 0, 0, 0])
  for (const r of verdicts) assert.match(r.record, /advisory/)
})

test('tier is read from input.tier, else from the gate 4 detail', () => {
  assert.equal(tierOf({ tier: 'T2' }), 'T2')
  assert.equal(tierOf({ gate: gatesFor(HEAD, { g4: 'risk:T3 - advisory only, merge is Lead\'s call' }) }), 'T3')
  assert.equal(tierOf({ gate: gatesFor(HEAD) }), 'T1')
  assert.equal(tierOf({}), null)
})

test('a stale gate result is invalid input, exit 2, and no merge record', () => {
  const result = decide(input({ gate: gatesFor('0000000000000000000000000000000000000000') }))
  assert.equal(result.verdict, VERDICT.invalid)
  assert.equal(result.code, 2)
  assert.equal(result.record, undefined)
  assert.match(result.blockers.join('\n'), /stale gate result/)
  assert.match(render(result), /INVALID INPUT/)
})

test('a head that is not a 40-character sha is invalid input', () => {
  assert.equal(validate(input({ head: '5072d22d' })).ok, false)
  assert.equal(decide(input({ head: '5072d22d' })).code, 2)
})

test('gate.gates must be exactly four numbered entries', () => {
  const three = input()
  three.gate.gates = three.gate.gates.slice(0, 3)
  three.gate.pass = true
  assert.match(validate(three).errors.join('\n'), /exactly 4 entries/)

  const renumbered = input()
  renumbered.gate.gates[2] = { ...renumbered.gate.gates[2], n: 9 }
  assert.match(validate(renumbered).errors.join('\n'), /numbered 9/)
})

test('gate.pass disagreeing with its four entries is invalid input', () => {
  const lying = input()
  lying.gate.pass = false
  assert.match(validate(lying).errors.join('\n'), /inconsistent result/)
})

test('each of gates 1-3 failing is a hold that names that gate', () => {
  for (const n of [1, 2, 3]) {
    const gate = gatesFor(HEAD, { number: 10 + n, detail: { [n]: false } })
    const result = decide(input({ gate }))
    assert.equal(result.verdict, VERDICT.hold, `gate ${n}`)
    assert.equal(result.code, 1)
    assert.match(result.blockers.join('\n'), new RegExp(`gate ${n} \\(`))
    assert.match(result.record, /^Not merging/)
  }
})

test('missing or doubled risk label holds, and the tier is not the reason', () => {
  const gate = gatesFor(HEAD, { number: 20, detail: { 4: false }, g4: 'no risk:T0..T3 label' })
  const result = decide(input({ gate, tier: 'T3' }))
  assert.equal(result.verdict, VERDICT.hold)
  assert.match(result.record, /record is incomplete, not the tier/)
  assert.match(result.record, /Tier risk:T3 is advisory: it is not why this is on hold/)
})

test('gate 2 passing while the newest run failed is a contradiction', () => {
  const checks = green().map((c) => (c.name === ROLLUP_CHECK
    ? { name: c.name, attempts: [{ run: 9, conclusion: 'cancelled', started_at: '2026-11-27T04:50:00Z' }] }
    : c))
  const result = decide(input({ checks }))
  assert.equal(result.verdict, VERDICT.hold)
  assert.match(result.blockers.join('\n'), /newest attempt of "FlyBot required checks" is run 9 cancelled/)
})

test('partial run history still decides, states coverage, and never calls the missing names clean', () => {
  const checks = green().filter((c) => c.name !== ROLLUP_CHECK)
  const result = decide(input({ checks }))
  assert.equal(result.verdict, VERDICT.merge)
  assert.equal(result.coverage.supplied, REQUIRED.length - 1)
  assert.deepEqual(result.coverage.missing, [ROLLUP_CHECK])
  assert.match(result.record, /run history covers 15 of 16 required checks/)
  assert.doesNotMatch(result.record, /clean green on this head/)
})

test('clean history is the only case that says clean green', () => {
  const result = decide(input())
  assert.match(result.record, /four merge-gate gates pass/)
  assert.doesNotMatch(result.record, /flake|not clean green/)
  assert.deepEqual(result.coverage.missing, [])
})

test('an all-success re-run is not a flake', () => {
  const checks = green().map((c) => (c.name === ROLLUP_CHECK
    ? { name: c.name, attempts: [
      { run: 1, conclusion: 'success', started_at: '2026-11-27T04:10:00Z' },
      { run: 2, conclusion: 'success', started_at: '2026-11-27T04:40:00Z' },
    ] }
    : c))
  const result = decide(input({ checks }))
  assert.equal(result.verdict, VERDICT.merge)
  assert.equal(result.flakes.length, 0)
})

test('attempts are read in start order, not in the order they are listed', () => {
  const checks = green().map((c) => (c.name === ROLLUP_CHECK
    ? { name: c.name, attempts: [
      { run: 2, conclusion: 'success', started_at: '2026-11-27T04:40:00Z' },
      { run: 1, conclusion: 'failure', started_at: '2026-11-27T04:10:00Z' },
    ] }
    : c))
  const result = decide(input({ checks }))
  assert.equal(result.flakes.length, 1)
  assert.match(result.record, /run 1 failure at 2026-11-27T04:10:00Z then run 2 success/)
})

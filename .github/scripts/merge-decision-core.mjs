// The decision itself (issue #3407): read the four merge-gate results plus the run history of this
// head, and say whether to merge, with the reasons and a paste-ready merge record. Pure: no network,
// no process.argv, no writes.
//
// The four gates come from merge-gate.mjs: (1) head and state, (2) required checks, (3) QA evidence
// and Lead review on this head, (4) exactly one risk:T* label. Gates 1-3 are the evidence the merge
// rests on; gate 4 is the record, not the tier. The tier is read into an advisory line only: since
// 2026-11-26 the merge is the FlyBot Lead's call and no tier blocks or authorises it.
//
// Two facts about the run history are treated as first class, because "green" alone hides them:
//
//   flake         a failed attempt followed by a success on the identical head -> merge, recorded
//                 as a flake, never as clean green
//   contradiction gate 2 says success but the newest attempt is not a success -> hold
//
// Required checks whose history was not supplied are not called clean: the verdict states the
// coverage instead.
import { EXIT, REQUIRED, VERDICT, attemptText, byStart, detailLines, tierOf, validate } from './merge-decision-input.mjs'
import { mergeRecord } from './merge-decision-record.mjs'
import { render } from './merge-decision-render.mjs'

// The module other files import: the decision, its input checks, and its two renderers.
export { EXIT, REQUIRED, VERDICT, attemptText, byStart, detailLines, tierOf, validate, render }

export function decide(input) {
  const { ok, errors } = validate(input)
  if (!ok) {
    return { verdict: VERDICT.invalid, code: EXIT.invalid, head: input?.head, pr: input?.gate?.number ?? null, blockers: errors, caveats: [], flakes: [], coverage: null, tier: tierOf(input || {}), record: undefined }
  }

  const gates = input.gate.gates
  const tier = tierOf(input)
  const blockers = []
  const caveats = []
  const flakes = []

  // Gates 1-3 are the evidence the merge rests on: any failure is a hold.
  for (const gate of gates.slice(0, 3)) {
    if (!gate.pass) blockers.push(`gate ${gate.n} (${gate.name}) failed: ${detailLines(gate.detail).join('; ') || 'no detail'}`)
  }
  // Gate 4 is the record, not the tier: a missing or doubled label means the record is incomplete.
  if (!gates[3].pass) blockers.push(`gate 4 (${gates[3].name}) failed: ${detailLines(gates[3].detail).join('; ') || 'no detail'} - the record is incomplete, not the tier`)
  if (gates[3].pass && !tier) blockers.push('gate 4 passes but the tier is not stated (input.tier or a risk:T* line in gate 4 detail)')

  const history = new Map()
  for (const check of input.checks) {
    const attempts = [...check.attempts].sort(byStart)
    history.set(check.name, [...(history.get(check.name) || []), ...attempts].sort(byStart))
  }

  // A gate-2 pass and a newest attempt that is not a success are two statements about one fact.
  if (gates[1].pass) {
    for (const name of REQUIRED) {
      const attempts = history.get(name)
      if (!attempts) continue
      const newest = attempts[attempts.length - 1]
      if (newest.conclusion !== 'success') blockers.push(`gate 2 says this check is success, but the newest attempt of "${name}" is ${attemptText(newest)}`)
    }
  }

  // A failed attempt followed by a success on the identical head is a flake. It does not block the
  // merge, and it must never be reported as green.
  for (const [name, attempts] of history) {
    if (attempts.length < 2) continue
    const bad = attempts.filter((a) => a.conclusion !== 'success')
    const good = attempts.filter((a) => a.conclusion === 'success')
    if (bad.length === 0 || good.length === 0) continue
    if (attempts[attempts.length - 1].conclusion !== 'success') continue
    flakes.push({ name, attempts })
  }
  for (const flake of flakes) {
    const first = flake.attempts.find((a) => a.conclusion !== 'success')
    const last = flake.attempts[flake.attempts.length - 1]
    caveats.push(`flake: "${flake.name}" ${attemptText(first)} then ${attemptText(last)} on the identical head - one red and one green run on the same bytes. Recorded as a flake, not clean green; it does not prove the first failure was a false alarm.`)
  }

  // Coverage: which required names the history actually holds. Uncovered names are not called clean.
  const supplied = REQUIRED.filter((name) => history.has(name))
  const missing = REQUIRED.filter((name) => !history.has(name))
  const coverage = { required: REQUIRED.length, supplied: supplied.length, missing }
  if (gates[1].pass && missing.length > 0) {
    caveats.push(`run history covers ${supplied.length} of ${REQUIRED.length} required checks; ${missing.length} not read here, so this verdict does not call them clean (no flake evidence either way)`)
  }

  const verdict = blockers.length === 0 ? VERDICT.merge : VERDICT.hold
  const result = { verdict, code: EXIT[verdict], head: input.head, pr: input.gate.number ?? null, gates, tier, blockers, caveats, flakes, coverage }
  result.record = mergeRecord(result, input.note)
  return result
}

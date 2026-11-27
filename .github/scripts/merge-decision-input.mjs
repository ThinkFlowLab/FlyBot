// The input side of the merge decision (issue #3407): the shape, the validation, the tier lookup.
// Pure: no network, no process.argv, no files.
//
//   {
//     "head": "<40-hex>",
//     "gate": { "number": 3406, "head": "<the same 40-hex>", "pass": true,
//               "gates": [ { "n": 1, "name": "...", "pass": true, "detail": ["..."] }, ... x4 ] },
//     "checks": [ { "name": "FlyBot required checks",
//                   "attempts": [ { "run": 45939643553, "conclusion": "failure",
//                                   "started_at": "2026-11-27T04:28:04Z" }, ... ] } ],
//     "tier": "T3",
//     "note": "optional, at most 200 characters, copied into the merge record"
//   }
//
// `gate` is the result of merge-gate.mjs (--json) for this head. `checks` is the per-check run
// history of the same head (the check-runs endpoint with filter=all, not filter=latest): without it
// a verdict cannot tell a clean run from a flake, so an input with no history at all is refused
// rather than assumed clean. History that covers only some required names is accepted, and the
// verdict then states the coverage - it does not call the uncovered names clean.
import { REQUIRED_CHECKS, ROLLUP_CHECK } from './merge-gate-core.mjs'

export const REQUIRED = [...REQUIRED_CHECKS, ROLLUP_CHECK]
export const VERDICT = { merge: 'merge', hold: 'hold', invalid: 'invalid' }
export const EXIT = { merge: 0, hold: 1, invalid: 2 }

const SHA = /^[0-9a-f]{40}$/
const TIER = /^T[0-3]$/
const LABEL = /risk:(T[0-3])/

export const detailLines = (detail) => (Array.isArray(detail) ? detail : [detail]).filter((d) => typeof d === 'string' && d.length > 0)

// Attempts in the order they started; a missing started_at keeps the order as given.
export const byStart = (a, b) => (Date.parse(a.started_at || 0) || 0) - (Date.parse(b.started_at || 0) || 0)
export const attemptText = (a) => `${a.run ? `run ${a.run}` : 'an attempt'} ${a.conclusion}${a.started_at ? ` at ${a.started_at}` : ''}`

export function tierOf(input) {
  if (input && TIER.test(String(input.tier ?? ''))) return String(input.tier)
  const gate4 = input?.gate?.gates?.[3]
  if (!gate4) return null
  for (const line of detailLines(gate4.detail)) {
    const m = line.match(LABEL)
    if (m) return m[1]
  }
  return null
}

export function validate(input) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['input is not an object'] }
  const head = input.head
  if (!SHA.test(String(head ?? ''))) errors.push(`head is ${JSON.stringify(head)}, not a 40-character lowercase sha`)

  const gate = input.gate
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    errors.push('gate is missing: pass the merge-gate result for this head (merge-gate.mjs --pr N --json)')
  } else {
    if (!SHA.test(String(gate.head ?? ''))) errors.push(`gate.head is ${JSON.stringify(gate.head)}, not a 40-character sha`)
    else if (SHA.test(String(head ?? '')) && gate.head !== head) {
      errors.push(`gate result was produced for ${gate.head}, not for head ${head}: a stale gate result proves nothing about this head`)
    }
    if (gate.number !== undefined && (!Number.isInteger(gate.number) || gate.number <= 0)) errors.push(`gate.number is ${JSON.stringify(gate.number)}, not a pull request number`)
    const gates = gate.gates
    if (!Array.isArray(gates) || gates.length !== 4) {
      errors.push(`gate.gates must hold exactly 4 entries, found ${Array.isArray(gates) ? gates.length : typeof gates}`)
    } else {
      gates.forEach((g, i) => {
        if (!g || typeof g !== 'object') { errors.push(`gate entry ${i + 1} is not an object`); return }
        if (g.n !== i + 1) errors.push(`gate entry ${i + 1} is numbered ${JSON.stringify(g.n)}, expected ${i + 1}`)
        if (typeof g.pass !== 'boolean') errors.push(`gate ${i + 1} has no boolean pass`)
        if (typeof g.name !== 'string' || !g.name) errors.push(`gate entry ${i + 1} has no name`)
      })
      if (typeof gate.pass === 'boolean' && gates.length === 4 && gates.every((g) => g && typeof g.pass === 'boolean')) {
        const all = gates.every((g) => g.pass === true)
        if (gate.pass !== all) errors.push(`gate.pass is ${gate.pass} but the four entries say ${all ? 'all pass' : 'not all pass'}: inconsistent result`)
      }
    }
  }

  if (!Array.isArray(input.checks)) {
    errors.push('checks is missing: pass the per-check run history for this head (filter=all); a verdict without it cannot tell a clean run from a flake')
  } else {
    input.checks.forEach((c, i) => {
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name) { errors.push(`checks[${i}] has no name`); return }
      if (!Array.isArray(c.attempts) || c.attempts.length === 0) { errors.push(`checks[${i}] ("${c.name}") has no attempts`); return }
      c.attempts.forEach((a, j) => {
        if (!a || typeof a !== 'object') { errors.push(`checks[${i}].attempts[${j}] is not an object`); return }
        if (typeof a.conclusion !== 'string' || !a.conclusion) errors.push(`checks[${i}].attempts[${j}] has no conclusion`)
        if (a.started_at !== undefined && Number.isNaN(Date.parse(a.started_at))) errors.push(`checks[${i}].attempts[${j}] has an unreadable started_at ${JSON.stringify(a.started_at)}`)
      })
    })
  }

  if (input.tier !== undefined && !TIER.test(String(input.tier))) errors.push(`tier is ${JSON.stringify(input.tier)}, not T0..T3`)
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 200)) errors.push('note must be a string of at most 200 characters')
  return { ok: errors.length === 0, errors }
}

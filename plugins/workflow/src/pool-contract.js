// The handoff contract of #1550 Stage 3 P0 (#1853): the seven validations of a handoff, in one
// order, as a pure decision. Nothing in the plugin imports this file yet — no endpoint, tool, run
// or dispatch path calls it — so loading the plugin behaves exactly as it did before. P1 wires it
// into dispatch; this module keeps the policy out of `service.js` until then.
import { createHash } from 'node:crypto'

const DEFAULT_CYCLE_MAX = 3
const QUOTA_UNITS = ['steps', 'ms', 'tokens']
const ESCALATING = ['cycle-budget', 'quota']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (value === undefined || value === null ? '' : String(value))

// The key is derived from four named facts and never from the object's shape, so re-ordering the
// handoff's keys cannot mint a second card, while a new `attempt` is a new handoff on purpose.
export function handoffKey(handoff = {}) {
  const parts = [handoff.card, handoff.fromRole, handoff.toRole, handoff.attempt].map(text)
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

const roleNames = (roles) => {
  const list = roles instanceof Set ? [...roles] : Array.isArray(roles) ? roles : []
  return list.map((role) => (typeof role === 'string' ? role : role?.role ?? role?.name ?? role?.id)).filter((name) => typeof name === 'string' && name !== '')
}

const hasPool = (pools, role) => {
  if (pools instanceof Map) return pools.has(role)
  if (Array.isArray(pools)) return pools.some((pool) => pool === role || pool?.role === role)
  return isObject(pools) && Object.prototype.hasOwnProperty.call(pools, role) && pools[role] !== undefined && pools[role] !== null
}

const seenBefore = (seen, key) => {
  if (seen instanceof Set) return seen.has(key)
  if (seen instanceof Map) return seen.has(key)
  if (Array.isArray(seen)) return seen.includes(key)
  return isObject(seen) && Object.prototype.hasOwnProperty.call(seen, key)
}

const recordKey = (seen, key) => {
  if (seen instanceof Set) seen.add(key)
  else if (seen instanceof Map) seen.set(key, true)
  else if (isObject(seen)) seen[key] = true
}

const passOf = (entry) => {
  if (!isObject(entry)) return undefined
  if (isObject(entry.pass)) return entry.pass
  if (entry.kind === 'pass' || (entry.tip !== undefined && entry.pr === undefined)) return entry
  return undefined
}

const ranLines = (value) => {
  const list = Array.isArray(value) ? value : [value]
  return list.map((line) => text(line).trim()).filter((line) => line !== '')
}

// Check 3: every item `acceptance.requires` names is backed by evidence, and a held PR never
// enters the merge pool. The refusal names the missing item, so the producer knows what to add.
function missingEvidence(handoff) {
  const requires = Array.isArray(handoff.acceptance?.requires) ? handoff.acceptance.requires : []
  if (requires.length === 0) return undefined
  const evidence = Array.isArray(handoff.evidence) ? handoff.evidence : []
  const passes = evidence.map(passOf).filter(Boolean)
  const prs = evidence.filter((entry) => isObject(entry) && entry.pr !== undefined && entry.pr !== null)
  for (const requirement of requires) {
    if (!isObject(requirement)) return `acceptance.requires carries an item the contract cannot read: ${text(requirement)}`
    if (isObject(requirement.pass)) {
      const tip = text(requirement.pass.tip)
      const found = passes.find((entry) => text(entry.tip) === tip)
      if (found === undefined) return `no PASS names the tip ${tip || '(none)'}`
      if (ranLines(found.ran).length === 0) return `the PASS at ${tip || '(none)'} carries no Ran: line`
      continue
    }
    if (requirement.pr === undefined || requirement.pr === null) return `acceptance.requires carries an item the contract cannot read: ${JSON.stringify(requirement)}`
    const wanted = Number(requirement.pr)
    const found = prs.find((entry) => Number(entry.pr) === wanted)
    if (found === undefined) return `no PR ${wanted}`
    if (found.hold === true) return `PR ${wanted} carries hold, so it may not enter the merge pool`
    if (text(requirement.checks) === 'tests-ok' && text(found.checks) !== 'tests-ok') return `PR ${wanted} carries no green tests-ok`
  }
  return undefined
}

const refusal = (code, reason) => ({ ok: false, code, reason, ...(ESCALATING.includes(code) ? { escalate: true } : {}) })

// The seven checks, in this order, each refusing before the next one reads: target, owner,
// evidence, concurrency, idempotency, cycle, quota.
export function validateHandoff(handoff = {}, ctx = {}) {
  const card = handoff.card
  const fromRole = text(handoff.fromRole)
  const toRole = text(handoff.toRole).trim()

  // 1. target — the workflow declares the role and the role has a pool.
  if (!roleNames(ctx.roles).includes(toRole)) return refusal('unknown-role', `toRole "${toRole}" is not a role the workflow declares`)
  if (!hasPool(ctx.pools, toRole)) return refusal('no-pool', `the role "${toRole}" has no pool`)

  // 2. owner — the exec writes for exactly one owner.
  const execOwner = text(ctx.execOwner).trim()
  if (execOwner === '') return refusal('not-owner', 'the exec names no owner, so no handoff can be written on its behalf')
  const statedOwner = handoff.owner ?? ctx.owner
  if (statedOwner !== undefined && statedOwner !== null && text(statedOwner) !== execOwner) return refusal('not-owner', `the handoff is written on behalf of "${text(statedOwner)}", but the exec belongs to "${execOwner}"`)

  // 3. evidence — the acceptance gate and the hold rule.
  const missing = missingEvidence(handoff)
  if (missing !== undefined) return refusal('missing-evidence', missing)

  // 4. concurrency — one card per worker, and the pool must have room.
  const wip = ctx.worker?.wip
  if (wip !== undefined && wip !== null && Number.isFinite(Number(wip)) && Number(wip) > 1) return refusal('wip-limit', `the worker already holds ${Number(wip)} cards; a handoff may add one only when it holds at most one`)
  const inflight = ctx.pool?.inflight
  const workers = ctx.pool?.workers
  if (Number.isFinite(Number(inflight)) && Number.isFinite(Number(workers)) && Number(inflight) >= Number(workers)) return refusal('pool-full', `the pool for "${toRole}" has ${Number(inflight)} of ${Number(workers)} in flight`)

  // 5. idempotency — one key, accepted once. A duplicate is a success that records nothing.
  const key = text(handoff.idempotencyKey) !== '' ? text(handoff.idempotencyKey) : handoffKey({ card, fromRole, toRole, attempt: handoff.attempt })
  if (seenBefore(ctx.seen, key)) return { ok: true, duplicate: true, key }

  // 6. cycle — the per-edge attempt budget, and a used-up budget asks the Chief.
  const cycleMax = ctx.cycleMax === undefined || ctx.cycleMax === null ? DEFAULT_CYCLE_MAX : Number(ctx.cycleMax)
  if (Number.isFinite(cycleMax) && Number(handoff.attempt ?? 0) > cycleMax) return refusal('cycle-budget', `attempt ${Number(handoff.attempt ?? 0)} is over the edge budget of ${cycleMax}`)

  // 7. quota — a spent limit is a refusal the Chief decides on, never a silent stop.
  const quota = ctx.quota ?? {}
  const used = ctx.used ?? {}
  for (const unit of QUOTA_UNITS) {
    const limit = quota[unit]
    if (limit === undefined || limit === null || !Number.isFinite(Number(limit))) continue
    if (Number(used[unit] ?? 0) > Number(limit)) return refusal('quota', `${unit} used ${Number(used[unit] ?? 0)} of ${Number(limit)}`)
  }

  recordKey(ctx.seen, key)
  return { ok: true, key }
}

// Only the two escalating refusals ask the Chief, and only the Chief decides whether a meeting
// opens: nothing auto-escalates to a meeting (owner decision, #1550 Stage 3).
export function escalationTarget(action) {
  const code = typeof action === 'string' ? action : action?.code
  return ESCALATING.includes(code) ? 'chief' : null
}

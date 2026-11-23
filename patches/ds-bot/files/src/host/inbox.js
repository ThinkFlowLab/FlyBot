// The inbound claim (#2308): one message event, one holder, one result.
//
// An inbound event used to be marked `seen` the moment it was handed to this host's
// executor, so a second poll loop over the same server inbox — or a restart between the
// delivery and the settings write — could answer it again, and a delivery that failed
// after the mark left no fact behind. This module is the state machine that fixes that:
// a caller takes a lease before it delivers, submits the result when the turn was handed
// off, and records a failure instead of only moving the cursor. The record is plain JSON
// the caller owns and persists; this module does no I/O, reads no clock (`now` is passed
// in), and knows nothing about the transport, a Bot Social server or `settings`.
//
// The shape follows `claimQueued` / `expireLeases` in tasks.js on purpose: one holder, a
// lease with an expiry, compare-and-set by lease id, and a transition that cannot run
// twice. A settled record never hands out a lease again, so a late submit from a holder
// whose lease expired is refused rather than rewriting a terminal result.
//
//   pending → claimed → replied | failed | needs-human
//                ↑          |
//                └── expired (attempts + 1, or `failed` at ATTEMPTS_MAX)
//
// `replied`, `failed` and `needs-human` are terminal. The first slice keeps the claim on
// one host: cross-host claiming (the server cursor) is the second slice, and the caller's
// record is the seam it will use.

import { randomUUID } from 'node:crypto'

// A delivery that keeps failing stops being retried after this many attempts; the record
// then says `failed`, a fact an operator can read, instead of a cursor that silently moved.
export const ATTEMPTS_MAX = 3
// Long enough for a slow executor hand-off, short enough that a host that died mid-delivery
// offers the event again on its next poll.
export const LEASE_TTL_MS = 5 * 60 * 1000

const TERMINAL = new Set(['replied', 'failed', 'needs-human'])
const ERROR_MAX = 300

const invalid = message => Object.assign(new Error(message), { code: 'inbox/invalid' })
const at = value => (Number.isFinite(value) ? value : Date.now())
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
const bounded = (value, max = ERROR_MAX) => oneLine(value).slice(0, max)

export const isTerminal = record => TERMINAL.has(record?.status)

// A fresh record for one event id. `eventId` is the caller's key (Bot Social's `event_id`);
// the module only requires it to be a non-empty string so `view()` and errors can name it.
export function createRecord(eventId, { now = Date.now() } = {}) {
  const id = oneLine(eventId)
  if (id === '') throw invalid('a record needs an event id')
  const stamp = at(now)
  return {
    eventId: id,
    status: 'pending',
    attempts: 0,
    lease: null,
    resultKey: undefined,
    result: undefined,
    error: undefined,
    reason: undefined,
    settled: undefined,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

// Take the event for `holder`. The read of the lease and the write of the new one happen in
// one synchronous call, so two callers over the same record cannot both see `pending`:
// the first gets `claimed`, the second `held` (the caller persists the record and the next
// caller reads the lease). `outcome` is one of:
//   claimed   — the lease is yours; deliver, then submit or fail
//   held      — a live lease belongs to someone else; do not deliver, do not move a cursor
//   exhausted — the attempt budget was already spent; the record is `failed`
//   settled   — a terminal record; never deliver again
export function claim(record, { holder, now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) {
  const who = oneLine(holder)
  if (who === '') throw invalid('claim needs a holder')
  const stamp = at(now)
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : LEASE_TTL_MS
  if (TERMINAL.has(record.status)) return { outcome: 'settled', status: record.status, record }
  if (record.status === 'claimed') {
    const lease = record.lease
    if (lease !== null && typeof lease === 'object' && Number.isFinite(lease.expiresAt) && lease.expiresAt > stamp) {
      return { outcome: 'held', heldBy: lease.holder, until: lease.expiresAt, lease, record }
    }
    // The holder is gone or stalled: count the attempt before offering the event again.
    // This is the one place the count moves on expiry, so a read cannot both requeue and
    // hand out two leases (the shape of tasks.js `expireLeases`).
    retire(record, stamp, 'the lease expired before the delivery reported a result')
    if (record.status === 'failed') return { outcome: 'exhausted', status: record.status, record }
  }
  if ((record.attempts ?? 0) >= ATTEMPTS_MAX) {
    record.status = 'failed'
    record.error ??= 'the delivery used every attempt'
    record.updatedAt = stamp
    return { outcome: 'exhausted', status: record.status, record }
  }
  const lease = { id: randomUUID(), holder: who, takenAt: stamp, expiresAt: stamp + ttl }
  record.status = 'claimed'
  record.lease = lease
  record.updatedAt = stamp
  return { outcome: 'claimed', lease, record }
}

// Push a live lease's expiry out. A holder that is still working renews rather than letting
// the event be offered to a second poll loop. A stale lease id, another holder or an expired
// lease is refused; it never resurrects the claim.
export function renew(record, { holder, leaseId, now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) {
  const who = oneLine(holder)
  const stamp = at(now)
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : LEASE_TTL_MS
  if (record.status !== 'claimed') return { ok: false, reason: record.status === 'pending' ? 'not-claimed' : 'settled', record }
  const lease = record.lease
  if (lease === null || typeof lease !== 'object' || lease.id !== leaseId || lease.holder !== who) {
    return { ok: false, reason: 'stale-holder', record }
  }
  if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= stamp) return { ok: false, reason: 'expired', record }
  lease.expiresAt = stamp + ttl
  record.updatedAt = stamp
  return { ok: true, lease, record }
}

// The turn was handed off: the event is answered. The first submit wins; the same holder
// submitting the same result key again is a duplicate answer, not a second write. A submit
// under a lease that is no longer current is refused and leaves the record alone, so a
// holder that lost its lease cannot overwrite the new holder's result.
export function submit(record, { holder, leaseId, resultKey, result, now = Date.now() } = {}) {
  const who = oneLine(holder)
  const stamp = at(now)
  if (record.status === 'replied' && record.settled?.leaseId === leaseId && record.resultKey === resultKey) {
    return { ok: true, duplicate: true, record }
  }
  if (TERMINAL.has(record.status)) return { ok: false, reason: 'settled', record }
  if (record.status !== 'claimed') return { ok: false, reason: 'not-claimed', record }
  const lease = record.lease
  if (lease === null || typeof lease !== 'object' || lease.id !== leaseId || lease.holder !== who) {
    return { ok: false, reason: 'stale-holder', record }
  }
  if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= stamp) return { ok: false, reason: 'expired', record }
  record.status = 'replied'
  record.resultKey = resultKey
  record.result = result
  record.error = undefined
  record.settled = { leaseId: lease.id, holder: who, at: stamp }
  record.lease = null
  record.updatedAt = stamp
  return { ok: true, duplicate: false, record }
}

// The delivery failed while the lease was ours. The attempt is spent; at the budget the
// record turns terminal instead of being retried forever. The holder is named in the error
// only in the caller's text — the record carries the reason, not a stack.
export function fail(record, { holder, leaseId, error, now = Date.now() } = {}) {
  const who = oneLine(holder)
  const stamp = at(now)
  if (TERMINAL.has(record.status)) return { ok: false, reason: 'settled', record }
  if (record.status === 'claimed') {
    const lease = record.lease
    if (lease === null || typeof lease !== 'object' || lease.id !== leaseId || lease.holder !== who) {
      return { ok: false, reason: 'stale-holder', record }
    }
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= stamp) return { ok: false, reason: 'expired', record }
  }
  record.attempts = (record.attempts ?? 0) + 1
  record.lease = null
  record.error = bounded(error?.message ?? error)
  record.status = record.attempts >= ATTEMPTS_MAX ? 'failed' : 'pending'
  record.updatedAt = stamp
  return { ok: true, status: record.status, attempts: record.attempts, record }
}

// A person has to decide: no further attempt is spent automatically, and the reason is kept
// for the surface that reads it. Terminal, like `failed`.
export function needsHuman(record, { reason, now = Date.now() } = {}) {
  const stamp = at(now)
  if (TERMINAL.has(record.status)) return { ok: false, reason: 'settled', record }
  record.reason = bounded(reason)
  record.error = undefined
  record.lease = null
  record.status = 'needs-human'
  record.updatedAt = stamp
  return { ok: true, record }
}

// A poll that finds a lease past its expiry offers the event again (or ends it at the budget).
// Idempotent: a second call at the same time sees `pending`, not a second attempt.
export function expire(record, { now = Date.now() } = {}) {
  const stamp = at(now)
  if (record.status !== 'claimed') return { expired: false, record }
  const lease = record.lease
  if (lease !== null && typeof lease === 'object' && Number.isFinite(lease.expiresAt) && lease.expiresAt > stamp) {
    return { expired: false, record }
  }
  retire(record, stamp, 'the lease expired before the delivery reported a result')
  return { expired: true, status: record.status, attempts: record.attempts, record }
}

// The read-only shape a surface (or a test) gets: no lease ids to guess with, the holder and
// the deadline named, and the terminal facts (`resultKey`, `result`, `error`, `reason`).
export function view(record, { now = Date.now() } = {}) {
  if (record === undefined || record === null) return undefined
  const stamp = at(now)
  const lease = record.lease !== null && typeof record.lease === 'object' ? record.lease : undefined
  const live = lease !== undefined && Number.isFinite(lease.expiresAt) && lease.expiresAt > stamp
  return {
    id: record.eventId,
    status: record.status,
    attempts: record.attempts ?? 0,
    ...(live ? { heldBy: lease.holder, until: lease.expiresAt } : {}),
    ...(record.resultKey === undefined ? {} : { resultKey: record.resultKey }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.settled === undefined ? {} : { settled: record.settled }),
    updatedAt: record.updatedAt,
  }
}

// One attempt spent on an expiry: clear the lease, count it, and end the record at the budget.
function retire(record, stamp, why) {
  record.lease = null
  record.attempts = (record.attempts ?? 0) + 1
  record.error = record.error ?? bounded(why)
  record.status = record.attempts >= ATTEMPTS_MAX ? 'failed' : 'pending'
  record.updatedAt = stamp
}

// The inbound claim (#2308). The six cases the slice named: one lease at a time, an expired
// lease is reclaimed and the old holder cannot submit, a duplicate submit is one result, a
// delivery that keeps failing becomes terminal, `needs-human` is terminal, and a settled
// record is never resurrected by an expiry. `now` is passed in, so no test waits on a clock.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ATTEMPTS_MAX, LEASE_TTL_MS, claim, createRecord, expire, fail, needsHuman, renew, submit, view } from '../src/host/inbox.js'

const T0 = 1_800_000_000_000
const HOLDER = 'host-a'

test('#2308: two claims, one message — the second is held', () => {
  const record = createRecord('ev1', { now: T0 })
  const first = claim(record, { holder: HOLDER, now: T0 })
  assert.equal(first.outcome, 'claimed')
  assert.equal(record.status, 'claimed')

  const second = claim(record, { holder: 'host-b', now: T0 + 1000 })
  assert.equal(second.outcome, 'held')
  assert.equal(second.heldBy, HOLDER)
  assert.equal(second.until, T0 + LEASE_TTL_MS)
  assert.equal(record.lease.id, first.lease.id, 'the held claim does not replace the lease')
  assert.equal(record.attempts, 0)
})

test('#2308: an expired lease is claimable and the old holder’s submit is refused', () => {
  const record = createRecord('ev2', { now: T0 })
  const first = claim(record, { holder: HOLDER, now: T0 })
  const later = T0 + LEASE_TTL_MS + 1

  const second = claim(record, { holder: 'host-b', now: later })
  assert.equal(second.outcome, 'claimed')
  assert.notEqual(second.lease.id, first.lease.id)
  assert.equal(record.attempts, 1, 'the expiry spent one attempt')

  const stale = submit(record, { holder: HOLDER, leaseId: first.lease.id, resultKey: 'ev2', result: { ok: true }, now: later + 1 })
  assert.deepEqual(stale, { ok: false, reason: 'stale-holder', record })
  assert.equal(record.status, 'claimed')
  assert.equal(record.lease.id, second.lease.id)

  const ok = submit(record, { holder: 'host-b', leaseId: second.lease.id, resultKey: 'ev2', result: { ok: true }, now: later + 2 })
  assert.equal(ok.ok, true)
  assert.equal(record.status, 'replied')
})

test('#2308: the same submit twice is one result', () => {
  const record = createRecord('ev3', { now: T0 })
  const held = claim(record, { holder: HOLDER, now: T0 })
  const args = { holder: HOLDER, leaseId: held.lease.id, resultKey: 'ev3', result: { turn: 't1' }, now: T0 + 10 }
  assert.equal(submit(record, args).ok, true)
  const afterFirst = { status: record.status, attempts: record.attempts, updatedAt: record.updatedAt, result: record.result }

  const again = submit(record, { ...args, now: T0 + 1000 })
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)
  assert.deepEqual({ status: record.status, attempts: record.attempts, updatedAt: record.updatedAt, result: record.result }, afterFirst)
})

test('#2308: a message that keeps failing becomes terminal', () => {
  const record = createRecord('ev4', { now: T0 })
  for (let attempt = 1; attempt <= ATTEMPTS_MAX; attempt += 1) {
    const held = claim(record, { holder: HOLDER, now: T0 + attempt * 1000 })
    assert.equal(held.outcome, 'claimed')
    const failed = fail(record, { holder: HOLDER, leaseId: held.lease.id, error: new Error(`down ${attempt}`), now: T0 + attempt * 1000 + 1 })
    assert.equal(failed.ok, true)
    assert.equal(failed.attempts, attempt)
    assert.equal(record.status, attempt < ATTEMPTS_MAX ? 'pending' : 'failed')
  }
  assert.equal(record.error, `down ${ATTEMPTS_MAX}`)

  const after = claim(record, { holder: 'host-b', now: T0 + 60_000 })
  assert.equal(after.outcome, 'settled')
  assert.equal(after.lease, undefined)
  assert.equal(record.status, 'failed')
  assert.equal(record.attempts, ATTEMPTS_MAX)
})

test('#2308: needs-human is a terminal state', () => {
  const record = createRecord('ev5', { now: T0 })
  claim(record, { holder: HOLDER, now: T0 })
  const marked = needsHuman(record, { reason: 'the owner must decide whether to answer', now: T0 + 5 })
  assert.equal(marked.ok, true)
  assert.equal(record.status, 'needs-human')
  assert.equal(record.lease, null)

  const after = claim(record, { holder: 'host-b', now: T0 + LEASE_TTL_MS + 1 })
  assert.equal(after.outcome, 'settled')
  assert.equal(view(record).reason, 'the owner must decide whether to answer')
})

test('#2308: an expired lease does not resurrect a settled message', () => {
  const record = createRecord('ev6', { now: T0 })
  const held = claim(record, { holder: HOLDER, now: T0 })
  submit(record, { holder: HOLDER, leaseId: held.lease.id, resultKey: 'ev6', result: { turn: 't6' }, now: T0 + 5 })

  const answered = expire(record, { now: T0 + LEASE_TTL_MS + 1 })
  assert.equal(answered.expired, false)
  assert.equal(record.status, 'replied')

  const after = claim(record, { holder: 'host-b', now: T0 + LEASE_TTL_MS + 2 })
  assert.equal(after.outcome, 'settled')
  assert.equal(record.attempts, 0, 'a settled answer is not an attempt')
  assert.equal(record.result.turn, 't6')
  // renew is refused on a settled record, and on a lease that was replaced.
  assert.equal(renew(record, { holder: HOLDER, leaseId: held.lease.id, now: T0 + 6 }).reason, 'settled')
})

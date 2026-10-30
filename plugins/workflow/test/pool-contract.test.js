// The contract's own tests (#1853): one case per refusal code, in the order the checks run, plus
// the idempotency key's two rules — stable across the handoff object's key order, different for a
// different attempt. The module is not wired into the plugin yet; these tests are the only caller.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escalationTarget, handoffKey, validateHandoff } from '../src/pool-contract.js'

const ctx = (over = {}) => ({
  roles: ['Lead', 'Dev', 'Reviewer'],
  pools: { Lead: { workers: 1 }, Dev: { workers: 2 }, Reviewer: { workers: 1 } },
  execOwner: 'owner-1',
  worker: { wip: 0 },
  pool: { inflight: 0, workers: 2 },
  seen: new Set(),
  cycleMax: 3,
  quota: { steps: 10, ms: 1_000, tokens: 100 },
  used: { steps: 0, ms: 0, tokens: 0 },
  ...over,
})

const handoff = (over = {}) => ({
  card: 'task-1',
  fromRole: 'Lead',
  toRole: 'Dev',
  reason: 'next slice',
  evidence: [],
  acceptance: { requires: [] },
  attempt: 0,
  ...over,
})

test('a valid handoff is accepted and answers the key it recorded', () => {
  const context = ctx()
  const verdict = validateHandoff(handoff(), context)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.duplicate, undefined)
  assert.equal(verdict.key, handoffKey(handoff()))
  assert.equal(context.seen.has(verdict.key), true, 'an accepted handoff is recorded once')
})

test('check 1 target: a role the workflow does not declare is unknown-role', () => {
  const verdict = validateHandoff(handoff({ toRole: 'Ghost' }), ctx())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'unknown-role')
  assert.match(verdict.reason, /Ghost/)
  assert.equal(verdict.escalate, undefined)
})

test('check 1 target: a declared role with no pool is no-pool', () => {
  const context = ctx({ roles: ['Lead', 'Dev', 'Reviewer', 'Deployer'], pools: { Lead: {}, Dev: {}, Reviewer: {} } })
  const verdict = validateHandoff(handoff({ toRole: 'Deployer' }), context)
  assert.equal(verdict.code, 'no-pool')
  assert.match(verdict.reason, /Deployer/)
})

test('check 2 owner: a handoff written for another owner is not-owner', () => {
  const verdict = validateHandoff(handoff({ owner: 'owner-2' }), ctx())
  assert.equal(verdict.code, 'not-owner')
  assert.match(verdict.reason, /owner-2/)
  assert.equal(validateHandoff(handoff({ owner: 'owner-1' }), ctx()).ok, true, 'the exec owner itself is accepted')
  assert.equal(validateHandoff(handoff(), ctx({ execOwner: '' })).code, 'not-owner', 'an exec with no owner writes for nobody')
})

test('check 3 evidence: a PASS requirement needs that tip and a Ran: line', () => {
  const requires = [{ pass: { tip: 'a'.repeat(40) } }]
  assert.equal(validateHandoff(handoff({ acceptance: { requires } }), ctx()).code, 'missing-evidence')
  assert.equal(validateHandoff(handoff({ acceptance: { requires }, evidence: [{ pass: { tip: 'b'.repeat(40), ran: ['npm test'] } }] }), ctx()).code, 'missing-evidence')

  const bare = validateHandoff(handoff({ acceptance: { requires }, evidence: [{ pass: { tip: 'a'.repeat(40) } }] }), ctx())
  assert.equal(bare.code, 'missing-evidence')
  assert.match(bare.reason, /Ran:/, 'the reason names the missing item')

  assert.equal(validateHandoff(handoff({ acceptance: { requires }, evidence: [{ pass: { tip: 'a'.repeat(40), ran: ['npm test'] } }] }), ctx()).ok, true)
})

test('check 3 evidence: a tests-ok requirement needs the PR and a green check, and a held PR never enters', () => {
  const requires = [{ pr: 42, checks: 'tests-ok' }]
  const withPr = (entry) => validateHandoff(handoff({ acceptance: { requires }, evidence: [entry] }), ctx())
  assert.equal(withPr({ pr: 42, checks: 'red' }).code, 'missing-evidence')
  assert.equal(withPr({ pr: 41, checks: 'tests-ok' }).code, 'missing-evidence')
  const held = withPr({ pr: 42, checks: 'tests-ok', hold: true })
  assert.equal(held.code, 'missing-evidence')
  assert.match(held.reason, /hold/)
  assert.equal(withPr({ pr: 42, checks: 'tests-ok' }).ok, true)
})

test('check 4 concurrency: a worker over its wip limit is wip-limit, a full pool is pool-full', () => {
  assert.equal(validateHandoff(handoff(), ctx({ worker: { wip: 1 } })).ok, true, 'one card in flight still takes the handoff')
  assert.equal(validateHandoff(handoff(), ctx({ worker: { wip: 2 } })).code, 'wip-limit')
  assert.equal(validateHandoff(handoff(), ctx({ pool: { inflight: 1, workers: 2 } })).ok, true)
  const full = validateHandoff(handoff(), ctx({ pool: { inflight: 2, workers: 2 } }))
  assert.equal(full.code, 'pool-full')
  assert.match(full.reason, /Dev/)
})

test('check 5 idempotency: a duplicate key is accepted exactly once and records nothing', () => {
  const context = ctx()
  const first = validateHandoff(handoff(), context)
  assert.equal(first.ok, true)
  assert.equal(context.seen.size, 1)

  const again = validateHandoff(handoff(), context)
  assert.equal(again.ok, true)
  assert.equal(again.duplicate, true)
  assert.equal(again.key, first.key)
  assert.equal(context.seen.size, 1, 'the duplicate recorded nothing')

  const explicit = handoff({ idempotencyKey: 'handoff-1' })
  assert.equal(validateHandoff(explicit, context).key, 'handoff-1', 'a caller-supplied key is the key')
  assert.equal(validateHandoff(explicit, context).duplicate, true)
})

test('check 6 cycle: an attempt over the edge budget escalates, the budget itself does not', () => {
  assert.equal(validateHandoff(handoff({ attempt: 3 }), ctx()).ok, true, 'the budget allows three attempts')
  const over = validateHandoff(handoff({ attempt: 4 }), ctx())
  assert.equal(over.code, 'cycle-budget')
  assert.equal(over.escalate, true)
  assert.equal(validateHandoff(handoff({ attempt: 3 }), ctx({ cycleMax: 2 })).code, 'cycle-budget', 'a declared budget is the one used')
})

test('check 7 quota: spending any unit past its limit escalates, spending the limit itself does not', () => {
  assert.equal(validateHandoff(handoff(), ctx({ used: { steps: 10, ms: 1_000, tokens: 100 } })).ok, true)
  for (const over of [{ steps: 11 }, { ms: 1_001 }, { tokens: 101 }]) {
    const verdict = validateHandoff(handoff(), ctx({ used: { steps: 0, ms: 0, tokens: 0, ...over } }))
    assert.equal(verdict.code, 'quota', JSON.stringify(over))
    assert.equal(verdict.escalate, true)
  }
})

test('the four non-escalating refusals record nothing and do not ask for escalation', () => {
  const cases = [
    [handoff({ toRole: 'Ghost' }), ctx()],
    [handoff({ owner: 'owner-2' }), ctx()],
    [handoff({ acceptance: { requires: [{ pr: 42, checks: 'tests-ok' }] } }), ctx()],
    [handoff(), ctx({ worker: { wip: 2 } })],
  ]
  for (const [value, context] of cases) {
    const verdict = validateHandoff(value, context)
    assert.equal(verdict.ok, false)
    assert.notEqual(verdict.code, 'cycle-budget')
    assert.notEqual(verdict.code, 'quota')
    assert.equal(verdict.escalate, undefined)
    assert.equal(context.seen.size, 0, verdict.code)
    assert.equal(escalationTarget(verdict), null, verdict.code)
  }
})

test('the key is stable across the handoff object key order and changes with attempt', () => {
  const value = handoff()
  const reordered = { attempt: value.attempt, toRole: value.toRole, reason: value.reason, card: value.card, fromRole: value.fromRole }
  assert.equal(handoffKey(reordered), handoffKey(value))
  assert.equal(handoffKey(handoff({ attempt: 1 })), handoffKey(handoff({ attempt: 1 })))
  assert.notEqual(handoffKey(handoff({ attempt: 1 })), handoffKey(value), 'a retry is a new handoff, not a duplicate')
  assert.notEqual(handoffKey(handoff({ toRole: 'Reviewer' })), handoffKey(value))
})

test('escalationTarget sends only the two escalating refusals to the Chief', () => {
  assert.equal(escalationTarget({ ok: false, code: 'cycle-budget', reason: 'x' }), 'chief')
  assert.equal(escalationTarget({ ok: false, code: 'quota', reason: 'x' }), 'chief')
  assert.equal(escalationTarget('cycle-budget'), 'chief')
  assert.equal(escalationTarget({ ok: false, code: 'wip-limit', reason: 'x' }), null)
  assert.equal(escalationTarget({ ok: true, key: 'k' }), null)
  assert.equal(escalationTarget(undefined), null)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildHealth } from '../src/health.js'

const make = (extra = {}) => ({
  version: 1, now: 1000, windowMs: 1000, live: true,
  lanes: [{ id: 'user', kind: 'user', name: 'You' }, { id: 'a', kind: 'bot', name: 'Chief', main: true }, { id: 'b', kind: 'bot', name: 'Writer' }],
  utilization: [], edges: [], ...extra,
})

test('health: a Bot with many failed turns is flagged, and the team is unhealthy', () => {
  const health = buildHealth(make({
    utilization: [
      { lane: 'a', windowMs: 1000, busyMs: 900, turns: 4, errors: 3, running: false },
      { lane: 'b', windowMs: 1000, busyMs: 100, turns: 2, errors: 0, running: true },
    ],
    edges: [{ from: 'b', to: 'a', requests: 1, replies: 0, unanswered: 1 }],
  }))
  const a = health.bots.find(bot => bot.id === 'a')
  assert.deepEqual(a.flags.map(flag => flag.code), ['errors', 'busy'])
  assert.equal(a.errorRate, 0.75)
  assert.equal(a.name, 'Chief')
  assert.equal(a.main, true)
  const b = health.bots.find(bot => bot.id === 'b')
  assert.deepEqual(b.flags.map(flag => flag.code), ['waiting'])
  assert.equal(b.waiting, 1)
  assert.equal(b.running, true)
  assert.equal(health.ok, false)
  assert.deepEqual(health.unhealthy, ['a', 'b'])
})

test('health: an idle Bot is flagged but does not make the team unhealthy', () => {
  const health = buildHealth(make({ utilization: [{ lane: 'b', windowMs: 1000, busyMs: 0, turns: 0, errors: 0, running: false }] }))
  const b = health.bots.find(bot => bot.id === 'b')
  assert.deepEqual(b.flags, [{ code: 'idle', detail: 'no turns in the window' }])
  assert.equal(health.ok, true)
  assert.deepEqual(health.unhealthy, [])
})

test('health: an empty window is ok and has no Bots', () => {
  assert.deepEqual(buildHealth({}), { version: 1, now: null, windowMs: null, live: false, bots: [], unhealthy: [], ok: true })
})

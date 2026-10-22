import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAlertTracker, RESOLVED_KEPT_MS, STUCK_MS } from '../src/alerts.js'
import { ALERTS_ENDPOINT, createTimeline } from '../src/timeline.js'
import { mockAdapter } from './mock-adapter.js'

const WIN_MS = 900_000

// A window shaped like `timeline/window`'s answer: the health thresholds live in health.js, so a
// failing Bot needs 3 failed turns of at least 4 started, and `waiting` needs an unanswered edge.
const make = (now, extra = {}) => ({
  version: 1, now, windowMs: WIN_MS, live: true,
  lanes: [
    { id: 'user', kind: 'user', name: 'You' },
    { id: 'a', kind: 'bot', name: 'Chief', main: true },
    { id: 'b', kind: 'bot', name: 'Writer' },
  ],
  utilization: [], edges: [], stuck: [], ...extra,
})

const failing = { lane: 'a', windowMs: WIN_MS, busyMs: WIN_MS, turns: 4, errors: 3, running: false }
const healthy = { lane: 'a', windowMs: WIN_MS, busyMs: 0, turns: 2, errors: 0, running: false }

test('alerts: a failing Bot opens one alert, and polling again does not open a second', () => {
  const tracker = createAlertTracker()
  const first = tracker.fold(make(1000, { utilization: [failing] }))
  assert.equal(first.changed, true)
  assert.equal(first.stale, false)
  assert.deepEqual(first.open.map(alert => alert.id), ['errors:a'])
  const alert = first.open[0]
  assert.deepEqual(
    { code: alert.code, subject: alert.subject, name: alert.name, detail: alert.detail, since: alert.since, seenAt: alert.seenAt },
    { code: 'errors', subject: 'a', name: 'Chief', detail: '3 of 4 turns failed', since: 1000, seenAt: 1000 },
  )
  assert.deepEqual(first.resolved, [])
  // The same condition one poll later: still one alert, same `since`, and nothing changed.
  const second = tracker.fold(make(2000, { utilization: [failing] }))
  assert.equal(second.changed, false)
  assert.deepEqual(second.open.map(alert => [alert.id, alert.since, alert.seenAt]), [['errors:a', 1000, 2000]])
})

test('alerts: a condition that clears resolves once and stays readable until the grace window ends', () => {
  const tracker = createAlertTracker({ resolveMs: 1000 })
  tracker.fold(make(1000, { utilization: [failing] }))
  const cleared = tracker.fold(make(1010, { utilization: [healthy] }))
  assert.equal(cleared.changed, true)
  assert.deepEqual(cleared.open, [])
  assert.deepEqual(cleared.resolved.map(alert => [alert.id, alert.since, alert.resolvedAt]), [['errors:a', 1000, 1010]])
  // A poll inside the grace window sees the resolution again without reporting a new change.
  const again = tracker.fold(make(1500, { utilization: [healthy] }))
  assert.equal(again.changed, false)
  assert.deepEqual(again.resolved.map(alert => alert.id), ['errors:a'])
  // Past the grace window it is dropped, so `resolved` stays short.
  const later = tracker.fold(make(1010 + 1000, { utilization: [healthy] }))
  assert.deepEqual(later.resolved, [])
  assert.equal(later.changed, false)
})

test('alerts: errors and waiting are separate alerts, and idle or busy alone opens none', () => {
  const tracker = createAlertTracker()
  tracker.fold(make(1000, { utilization: [failing] }))
  const both = tracker.fold(make(2000, {
    utilization: [
      failing,
      { lane: 'b', windowMs: WIN_MS, busyMs: 0, turns: 0, errors: 0, running: false },
    ],
    edges: [{ from: 'a', to: 'b', requests: 2, replies: 1, unanswered: 1 }],
  }))
  assert.equal(both.changed, true)
  assert.deepEqual(both.open.map(alert => alert.id).sort(), ['errors:a', 'waiting:a'])
  assert.deepEqual(both.open.map(alert => alert.code).sort(), ['errors', 'waiting'])
  assert.equal(both.open.find(alert => alert.code === 'waiting').detail, '1 request(s) unanswered')
  // `idle:b` and `busy:a` are health flags, not alerts: the alert set stays at two.
  assert.equal(both.open.length, 2)
})

test('alerts: a stuck handoff opens only after the threshold, once per unanswered request', () => {
  const tracker = createAlertTracker()
  const early = tracker.fold(make(1000, { stuck: [{ id: 'x1', from: 'a', to: 'b', role: 'request', waitedMs: STUCK_MS - 60_000 }] }))
  assert.deepEqual(early.open, [])
  const stuck = tracker.fold(make(2000, { stuck: [{ id: 'x1', from: 'a', to: 'b', role: 'request', waitedMs: STUCK_MS }] }))
  assert.equal(stuck.changed, true)
  assert.deepEqual(stuck.open.map(alert => alert.id), ['stuck:x1'])
  const alert = stuck.open[0]
  assert.deepEqual(
    { code: alert.code, subject: alert.subject, from: alert.from, to: alert.to, detail: alert.detail },
    { code: 'stuck', subject: 'x1', from: 'a', to: 'b', detail: 'no reply for 15 min' },
  )
  // The same request still waiting: no second alert, only the wording and `seenAt` move on.
  const waiting = tracker.fold(make(3000, { stuck: [{ id: 'x1', from: 'a', to: 'b', role: 'request', waitedMs: STUCK_MS + 60_000 }] }))
  assert.equal(waiting.changed, false)
  assert.deepEqual(waiting.open.map(item => [item.id, item.since, item.detail]), [['stuck:x1', 2000, 'no reply for 16 min']])
  // The reply arrives: the alert resolves.
  const answered = tracker.fold(make(4000, {}))
  assert.equal(answered.changed, true)
  assert.deepEqual(answered.open, [])
  assert.deepEqual(answered.resolved.map(item => [item.id, item.resolvedAt]), [['stuck:x1', 4000]])
})

test('alerts: changed is true only on a transition, not when a holding alert reads differently', () => {
  const tracker = createAlertTracker()
  const first = tracker.fold(make(1000, { utilization: [failing] }))
  assert.equal(first.changed, true)
  // 4 of 5 failed is still the same `errors:a` condition, so it updates the detail, not the set.
  const worse = tracker.fold(make(2000, { utilization: [{ ...failing, turns: 5, errors: 4 }] }))
  assert.equal(worse.changed, false)
  assert.equal(worse.open[0].id, 'errors:a')
  assert.equal(worse.open[0].detail, '4 of 5 turns failed')
})

test('alerts: a window looking back does not resolve a live alert', () => {
  const tracker = createAlertTracker()
  tracker.fold(make(2000, { utilization: [failing] }))
  const old = tracker.fold(make(1000, {}))
  assert.equal(old.stale, true)
  assert.equal(old.changed, false)
  assert.deepEqual(old.open.map(alert => alert.id), ['errors:a'])
  assert.deepEqual(old.resolved, [])
  // A window at or after the last one is read normally again.
  const cleared = tracker.fold(make(2100, {}))
  assert.equal(cleared.stale, false)
  assert.equal(cleared.changed, true)
  assert.deepEqual(cleared.open, [])
})

test('alerts: a condition that comes back while its resolution is on display re-opens with a fresh since', () => {
  const tracker = createAlertTracker()
  tracker.fold(make(1000, { utilization: [failing] }))
  tracker.fold(make(1010, { utilization: [healthy] }))
  const back = tracker.fold(make(1020, { utilization: [failing] }))
  assert.equal(back.changed, true)
  assert.deepEqual(back.open.map(alert => [alert.id, alert.since]), [['errors:a', 1020]])
  assert.deepEqual(back.resolved, [], 'the old resolution is not reported beside the new open alert')
})

test('alerts: the endpoint is registered read-only, answers the empty tracker and goes away on dispose', () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false })
  try {
    assert.equal(ALERTS_ENDPOINT, 'timeline/alerts')
    assert.ok(adapter.endpoints.has(ALERTS_ENDPOINT), 'createTimeline registers timeline/alerts')
    const answer = adapter.endpoints.get(ALERTS_ENDPOINT)({ windowMs: 60_000 })
    assert.deepEqual(
      { version: answer.version, open: answer.open, resolved: answer.resolved, changed: answer.changed, stale: answer.stale },
      { version: 1, open: [], resolved: [], changed: false, stale: false },
    )
    assert.ok(Number.isFinite(answer.now))
    // The tracker behind it is the instance's own: folding it is visible to the next read.
    timeline.alerts.fold({ now: 5000, utilization: [{ lane: 'a', windowMs: WIN_MS, busyMs: 0, turns: 4, errors: 3 }], lanes: [{ id: 'a', kind: 'bot', name: 'Chief' }] })
    assert.deepEqual(timeline.alertView({}).open, [], 'the endpoint folds the current (empty) window, resolving what the tracker held')
    assert.equal(RESOLVED_KEPT_MS, 60_000)
  } finally {
    timeline.dispose()
  }
  assert.equal(adapter.endpoints.has(ALERTS_ENDPOINT), false, 'dispose removes the endpoint')
})

// A trace segment outlives the version that wrote it: the store keeps every record whose `t` is
// not provably older than the retention window, and `fold` in src/window.js checks
// `Number.isFinite(record.t)` before it trusts one. The OTLP mapping reads the same records, so it
// has to keep the same rule: an untimed turn or tool call is skipped, not converted to a span.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spansFrom } from '../src/otel.js'
import { createTimeline } from '../src/timeline.js'
import { mockAdapter } from './mock-adapter.js'

// The shape a segment written by an earlier version (or edited by hand) can carry: an ISO string
// for the end, nothing at all for the start.
const untimed = [
  { r: 'ts', id: 'old#1', pl: 'chat', bot: 'a' },
  { r: 'te', id: 'old#1', t: '2026-11-04T10:00:00.000Z', o: 'completed' },
]
const timed = [
  { r: 'ts', t: 1_000, id: 'new#1', pl: 'chat', bot: 'a' },
  { r: 'te', t: 1_600, id: 'new#1', o: 'completed' },
]

test('a turn or tool record with no usable time is skipped, never converted to a span', () => {
  assert.deepEqual(spansFrom(untimed), [])
  assert.deepEqual(spansFrom([
    { r: 'ks', t: 1_100, id: 'c1', tid: 'new#1', nm: 'web_search', bot: 'a' },
    { r: 'ke', t: '2026-11-04T10:00:01.000Z', id: 'c1', tid: 'new#1', ok: true },
  ]), [])
  const spans = spansFrom([...untimed, ...timed])
  assert.deepEqual(spans.map(span => span.name), ['invoke_agent'])
  assert.equal(spans[0].startTimeUnixNano, '1000000000')
})

test('timeline/export still answers OTLP JSON when the trace holds an untimed record', () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false, now: () => 5_000 })
  adapter.feed('turn.start', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_100 })
  adapter.feed('turn.end', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_900, outcome: 'completed' })
  for (const record of untimed) timeline.trace.append(record)
  // The store keeps the untimed records (their `t` cannot be proved older than the window); the
  // export is the reader that has to cope with them.
  const kept = timeline.trace.records()
  assert.ok(kept.some(record => record.r === 'ts' && record.id === 'old#1'))
  assert.ok(kept.some(record => record.r === 'te' && record.id === 'old#1'))
  const spans = timeline.exportWindow().resourceSpans[0].scopeSpans[0].spans
  assert.equal(spans.length, 1)
  assert.equal(spans[0].name, 'invoke_agent')
  timeline.dispose()
})

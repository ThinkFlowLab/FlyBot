// #1829: the board's seven metrics. The read is injected, so these cases spend no network and
// count their own source calls; the day boundary is the reader's zone, and a missing credential or
// a failed read answers `null` (painted `—`), never `0`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { METRICS_TTL_MS, dayKey, median, readMetrics, runningOf, summarizeMetrics } from '../src/host/project-metrics.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-10-30T12:00:00Z')

const pr = (created, merged) => ({ created_at: created, merged_at: merged })
const issue = (created, closed) => ({ created_at: created, closed_at: closed, pull_request: undefined })

test('the natural day is the reader zone, not UTC', () => {
  // 2026-10-30T16:30Z is still 10-30 in UTC and already 10-31 in Shanghai.
  const at = Date.parse('2026-10-30T16:30:00Z')
  assert.equal(dayKey(at, 'UTC'), '2026-10-30')
  assert.equal(dayKey(at, 'Asia/Shanghai'), '2026-10-31')
  // 10:00Z on 10-30 is that same day in both zones, but 20:00Z is already 10-31 in Shanghai.
  const source = { ok: true, pullRequests: [pr('2026-10-30T10:00:00Z', null)], issues: [] }
  const utc = summarizeMetrics({ now: Date.parse('2026-10-30T20:00:00Z'), timeZone: 'UTC', source })
  const shanghai = summarizeMetrics({ now: Date.parse('2026-10-30T20:00:00Z'), timeZone: 'Asia/Shanghai', source })
  assert.equal(utc.metrics.prsOpenedToday, 1)
  assert.equal(shanghai.metrics.prsOpenedToday, 0)
})

test('a day count compares the field it documents', () => {
  const source = {
    ok: true,
    pullRequests: [pr('2026-10-29T10:00:00Z', '2026-10-30T09:00:00Z'), pr('2026-10-30T08:00:00Z', null)],
    issues: [issue('2026-10-30T07:00:00Z', null), issue('2026-10-20T07:00:00Z', '2026-10-30T11:00:00Z')],
  }
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source })
  assert.equal(out.metrics.prsOpenedToday, 1)
  assert.equal(out.metrics.prsMergedToday, 1)
  assert.equal(out.metrics.issuesOpenedToday, 1)
  assert.equal(out.metrics.issuesClosedToday, 1)
})

test('an empty window is null, never zero, and median halves round', () => {
  assert.equal(median([]), null)
  assert.equal(median([10]), 10)
  assert.equal(median([10, 20]), 15)
  assert.equal(median([30, 10, 20]), 20)
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source: { ok: true, pullRequests: [], issues: [] } })
  assert.equal(out.metrics.prMergeMedianMs, null)
  assert.equal(out.metrics.issueCloseMedianMs, null)
  assert.equal(out.metrics.taskDoneMedianMs, null)
})

test('durations are the last seven days only', () => {
  const source = { ok: true, pullRequests: [pr('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'), pr('2026-10-30T06:00:00Z', '2026-10-30T08:00:00Z')], issues: [] }
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source })
  assert.equal(out.metrics.prMergeMedianMs, 2 * HOUR)
})

test('no credential answers unavailable without a request', async () => {
  let calls = 0
  const out = await readMetrics({ repo: 'a/b', token: '', fetchImpl: async () => { calls += 1; return { ok: true, json: async () => [] } }, now: NOW, cacheStore: new Map() })
  assert.equal(calls, 0)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-credentials')
  assert.equal(out.metrics.prsOpenedToday, null)
})

test('a failed read degrades and is not cached', async () => {
  const store = new Map()
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) })
  const out = await readMetrics({ repo: 'a/b', token: 't', fetchImpl: failing, now: NOW, cacheStore: store })
  assert.equal(out.ok, false)
  assert.match(out.reason, /read-failed/)
  assert.equal(out.metrics.issuesClosedToday, null)
  assert.equal(store.size, 0)
})

test('a cache hit spends the source once', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, json: async () => [{ created_at: '2026-10-30T06:00:00Z', merged_at: null }] }
  }
  const store = new Map()
  const first = await readMetrics({ repo: 'a/b', token: 't', fetchImpl, now: NOW, cacheStore: store })
  const second = await readMetrics({ repo: 'a/b', token: 't', fetchImpl, now: NOW + 1000, cacheStore: store })
  assert.equal(first.cache, 'miss')
  assert.equal(second.cache, 'hit')
  assert.equal(calls, 2) // one pulls read and one issues read, once
  assert.equal(second.metrics.prsOpenedToday, 1)
  // The window rolls: past the TTL the source is read again.
  await readMetrics({ repo: 'a/b', token: 't', fetchImpl, now: NOW + METRICS_TTL_MS + 1, cacheStore: store })
  assert.equal(calls, 4)
})

test('a running row carries who, how long and where from', () => {
  const row = runningOf({ id: 't1', title: 'Ship it', status: 'claimed', claimedBy: 'Dev', claimedAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, kind: 'group', origin: { roomId: 'r1' } }, NOW)
  assert.deepEqual(row, { id: 't1', title: 'Ship it', status: 'claimed', who: 'Dev', sinceMs: 2 * HOUR, source: 'group', lastActivityAt: NOW - HOUR })
  assert.equal(runningOf({ id: 't2', status: 'open' }, NOW), null)
  assert.equal(runningOf({ id: 't3', status: 'claimed' }, NOW), null)
})

test('the task median reads the store stamps only', () => {
  const tasks = {
    a: { status: 'done', createdAt: NOW - 10 * HOUR, completedAt: NOW - 8 * HOUR },
    b: { status: 'done', createdAt: NOW - 6 * HOUR, completedAt: NOW - 4 * HOUR },
    c: { status: 'done', createdAt: NOW - 6 * HOUR },
    d: { status: 'open', createdAt: NOW - 6 * HOUR },
  }
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source: { ok: true, pullRequests: [], issues: [] }, tasks })
  assert.equal(out.metrics.taskDoneMedianMs, 2 * HOUR)
})

// #1829: the board's seven metrics. The read is injected, so these cases spend no network and
// count their own source calls; the day boundary is the reader's zone, and a missing credential or
// a failed read answers `null` (painted `—`), never `0`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { METRIC_KEYS, METRICS_TTL_MS, dayKey, median, readMetrics, runningOf, summarizeMetrics } from '../src/host/project-metrics.js'

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

test('a card claimed after a cached read still shows as running', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] })
  const store = new Map()
  const before = { t1: { id: 't1', status: 'open', title: 'Wait' } }
  const first = await readMetrics({ repo: 'a/b', token: 't', fetchImpl, now: NOW, tasks: before, cacheStore: store })
  assert.equal(first.running.length, 0)
  // The claim lands a second later, still inside the five-minute window: the numbers are cached,
  // the rows are not, so the running table is not five minutes stale (#1829).
  const after = { ...before, t2: { id: 't2', status: 'claimed', claimedBy: 'Dev', claimedAt: NOW - HOUR, updatedAt: NOW, title: 'Ship it' } }
  const second = await readMetrics({ repo: 'a/b', token: 't', fetchImpl, now: NOW + 1000, tasks: after, cacheStore: store })
  assert.equal(second.cache, 'hit')
  assert.deepEqual(second.running.map(row => row.id), ['t2'])
  assert.equal(store.size, 1)
  assert.equal(Object.hasOwn([...store.values()][0].value, 'running'), false, 'the cache holds the numbers, not the rows')
})

test('a running row carries who, how long and where from', () => {
  const row = runningOf({ id: 't1', title: 'Ship it', status: 'claimed', claimedBy: 'Dev', claimedAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, kind: 'group', origin: { roomId: 'r1' } }, NOW)
  assert.deepEqual(row, { id: 't1', title: 'Ship it', status: 'claimed', who: 'Dev', sinceMs: 2 * HOUR, source: 'group', lastActivityAt: NOW - HOUR })
  assert.equal(runningOf({ id: 't2', status: 'open' }, NOW), null)
  assert.equal(runningOf({ id: 't3', status: 'claimed' }, NOW), null)
})

test('the task median reads the store stamps only', () => {
  const tasks = {
    a: { status: 'accepted', createdAt: NOW - 10 * HOUR, completedAt: NOW - 8 * HOUR },
    b: { status: 'accepted', createdAt: NOW - 6 * HOUR, completedAt: NOW - 4 * HOUR },
    c: { status: 'accepted', createdAt: NOW - 6 * HOUR },
    d: { status: 'open', createdAt: NOW - 6 * HOUR },
  }
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source: { ok: true, pullRequests: [], issues: [] }, tasks })
  assert.equal(out.metrics.taskDoneMedianMs, 2 * HOUR)
})

// #1849: a request body's `timeZone` reaches `Intl` unvalidated, so one unknown name used to throw
// out of the whole board read instead of costing the seven numbers. The zone is resolved once, and
// an unknown name answers the named `UTC` — on every path that answers, and in the cache key too.
const BAD_ZONE = 'Not/AZone'

test('#1849: an unknown zone answers the named UTC fallback on every path', async () => {
  const source = { ok: true, pullRequests: [pr('2026-10-30T10:00:00Z', null)], issues: [] }
  const direct = summarizeMetrics({ now: NOW, timeZone: BAD_ZONE, source })
  assert.equal(direct.timeZone, 'UTC')
  assert.equal(direct.metrics.prsOpenedToday, 1)
  assert.equal(summarizeMetrics({ now: NOW, timeZone: BAD_ZONE }).timeZone, 'UTC')
  assert.equal(summarizeMetrics({ now: NOW, timeZone: BAD_ZONE, source: { ok: false, reason: 'x' } }).timeZone, 'UTC')

  const noCredentials = await readMetrics({ repo: 'o/r', token: '', timeZone: BAD_ZONE, now: NOW })
  assert.equal(noCredentials.timeZone, 'UTC')
  assert.equal(noCredentials.ok, false)

  const noFetch = await readMetrics({ repo: 'o/r', token: 'tok', timeZone: BAD_ZONE, now: NOW })
  assert.equal(noFetch.timeZone, 'UTC')

  const readFailure = await readMetrics({
    repo: 'o/r', token: 'tok', timeZone: BAD_ZONE, now: NOW,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  })
  assert.equal(readFailure.timeZone, 'UTC')
  assert.equal(readFailure.ok, false)

  // The cache key carries the resolved zone: a bad name shares the UTC entry instead of making a
  // second one, and the hit still answers `UTC`.
  const cacheStore = new Map()
  const fetchImpl = async () => ({ ok: true, json: async () => [] })
  const miss = await readMetrics({ repo: 'o/r', token: 'tok', timeZone: 'UTC', now: NOW, fetchImpl, cacheStore })
  assert.equal(miss.cache, 'miss')
  const hit = await readMetrics({ repo: 'o/r', token: 'tok', timeZone: BAD_ZONE, now: NOW, fetchImpl, cacheStore })
  assert.equal(hit.cache, 'hit')
  assert.equal(hit.timeZone, 'UTC')
  assert.equal(cacheStore.size, 1)

  const success = await readMetrics({ repo: 'o/r', token: 'tok', timeZone: BAD_ZONE, now: NOW, fetchImpl, cacheStore: new Map() })
  assert.equal(success.timeZone, 'UTC')
  assert.equal(success.ok, true)
})

test('#1849: a valid zone keeps the day boundary and the answer it had', () => {
  const source = {
    ok: true,
    pullRequests: [pr('2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z')],
    issues: [issue('2026-10-30T09:00:00Z', null)],
  }
  const shanghai = summarizeMetrics({ now: NOW, timeZone: 'Asia/Shanghai', source })
  assert.equal(shanghai.timeZone, 'Asia/Shanghai')
  assert.equal(dayKey(NOW, 'Asia/Shanghai'), '2026-10-30')
  assert.deepEqual(shanghai.metrics, {
    prsOpenedToday: 1, prsMergedToday: 1, issuesOpenedToday: 1, issuesClosedToday: 0,
    prMergeMedianMs: HOUR, issueCloseMedianMs: null, taskDoneMedianMs: null,
  })
  // A zone `Intl` accepts but the host would never guess stays as sent, and UTC still reads one day.
  assert.equal(summarizeMetrics({ now: NOW, timeZone: 'UTC', source }).metrics.prsOpenedToday, 1)
})

// #1884: a card finishes by `transition(task, 'accepted')` (core/src/host/tasks.js:269-279), which
// writes `status`, `updatedAt` and one `actors[]` row — never `completedAt`. So the duration is
// `createdAt` → the last terminal `actors[].at` (9h here), not a field the store never writes.
const finished = (id, createdAt, acceptedAt) => ({
  id,
  title: id,
  status: 'accepted',
  createdAt,
  updatedAt: acceptedAt,
  actors: [
    { status: 'open', at: createdAt },
    { status: 'claimed', at: createdAt + HOUR },
    { status: 'accepted', at: acceptedAt },
  ],
})

test('a card that finished the way the host finishes cards is a done duration', () => {
  const tasks = [
    finished('t-9h', NOW - 10 * HOUR, NOW - 1 * HOUR),
    { id: 't-cancelled', status: 'cancelled', createdAt: NOW - 10 * HOUR, updatedAt: NOW - 2 * HOUR, actors: [{ status: 'cancelled', at: NOW - 2 * HOUR }] },
  ]
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source: { ok: true, pullRequests: [], issues: [] }, tasks })
  assert.equal(out.metrics.taskDoneMedianMs, 9 * HOUR)
  assert.deepEqual(Object.keys(out.metrics).sort(), [...METRIC_KEYS].sort())
})

// A board whose only finished cards were abandoned was never completed on: `—`, never `0`. This one
// passes on main today only because no card is counted at all, so it is the non-regression half of
// the pair — it starts guarding the `accepted`-only rule the moment the first test goes green.
test('only cancelled and failed cards is null, never zero', () => {
  const tasks = [
    { id: 't-cancelled', status: 'cancelled', createdAt: NOW - 10 * HOUR, updatedAt: NOW - 2 * HOUR, actors: [{ status: 'cancelled', at: NOW - 2 * HOUR }] },
    { id: 't-failed', status: 'failed', createdAt: NOW - 8 * HOUR, updatedAt: NOW - 3 * HOUR, actors: [{ status: 'failed', at: NOW - 3 * HOUR }] },
  ]
  const out = summarizeMetrics({ now: NOW, timeZone: 'UTC', source: { ok: true, pullRequests: [], issues: [] }, tasks })
  assert.equal(out.metrics.taskDoneMedianMs, null)
})

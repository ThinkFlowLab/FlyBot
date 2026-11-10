// #2806: the shared metrics cache is keyed by a five-minute window, so an entry can never be
// answered again once its window is over — a bucket that is done is dead weight, and the host kept
// every one of them for the life of the process (288 a day per repository and zone).
import test from 'node:test'
import assert from 'node:assert/strict'
import { METRICS_TTL_MS, readMetrics } from '../src/host/project-metrics.js'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const fetcher = async () => ({ ok: true, json: async () => [] })

test('a five-minute bucket that is over is dropped, not kept for the life of the host', async () => {
  const store = new Map()
  const read = now => readMetrics({ repo: 'o/r', token: 'tok', fetchImpl: fetcher, now, cacheStore: store })
  // Bucket 0 fills the cache, then 200 more windows pass: each one is a new key, and the read that
  // fills it is the only chance this table has to drop the windows it can no longer answer.
  assert.equal((await read(NOW)).cache, 'miss')
  for (let bucket = 1; bucket <= 200; bucket += 1) await read(NOW + bucket * METRICS_TTL_MS)
  // A bucket that is over is a miss, not a hit served out of a dead entry. Before #2806 this read
  // answered `hit` from bucket 0's entry, which had been carried across 200 later windows.
  assert.equal((await read(NOW)).cache, 'miss')
  assert.ok(store.size <= 2, `the store keeps the live window, not 201 dead ones (kept ${store.size})`)
})

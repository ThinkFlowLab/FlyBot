import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExporter } from '../src/otel.js'
import { createTimeline, HEALTH_ENDPOINT } from '../src/timeline.js'
import { buildHealth } from '../src/health.js'
import { mockAdapter } from './mock-adapter.js'

// One closed turn at `t`: enough for the cursor to build a span and call `send`. Each push uses a
// later turn, because the cursor keeps every span it sent and would skip a repeated one.
const records = (t = 1_000) => [
  { r: 'ts', t, id: `a#${t}`, pl: 'chat', bot: 'a' },
  { r: 'te', t: t + 600, id: `a#${t}`, o: 'completed' },
]

const collectorDown = async () => { throw new Error('HTTP 503') }

test('#P699 a failing export warns once per streak, not once per attempt', async () => {
  const warns = []
  const exporter = createExporter({ send: collectorDown, warn: (...args) => warns.push(args.join(' ')), now: () => 5_000 })
  for (let attempt = 0; attempt < 5; attempt++) await exporter.push(records())
  assert.equal(warns.length, 1, `a failing export warned ${warns.length} time(s) in 5 attempts, so the operator cannot tell one outage from five separate faults`)
  assert.match(warns[0], /export failed: HTTP 503/)
  assert.deepEqual(exporter.stats(), { failures: 5, lastOkAt: null, lastError: 'HTTP 503' })
})

test('#P699 a recovery warns once, and the next streak warns again', async () => {
  const warns = []
  let down = true
  const exporter = createExporter({ send: async () => { if (down) throw new Error('HTTP 503') }, warn: (...args) => warns.push(args.join(' ')), now: () => 5_000 })
  await exporter.push(records(1_000))
  await exporter.push(records(2_000))
  down = false
  await exporter.push(records(3_000))
  down = true
  await exporter.push(records(4_000))
  assert.equal(warns.length, 3, `a failure streak, its recovery and a second streak should read as three warnings; warnings were ${JSON.stringify(warns)}`)
  assert.match(warns[1], /recovered after 2 failed attempt\(s\) \(last error: HTTP 503\)/, 'the recovery must be one line naming the streak it ended')
  assert.match(warns[0], /export failed/)
  assert.match(warns[2], /export failed/)
  assert.deepEqual(exporter.stats(), { failures: 1, lastOkAt: 5_000, lastError: 'HTTP 503' })
})

test('#P699 the health answer carries the export state', () => {
  const window = { version: 1, now: 1_000, windowMs: 1_000, live: true, lanes: [], utilization: [], edges: [] }
  const health = buildHealth(window, { failures: 3, lastOkAt: 900, lastError: 'HTTP 503' })
  assert.deepEqual(health.export, { enabled: true, failing: true, failures: 3, lastOkAt: 900, lastError: 'HTTP 503' }, 'the health answer must carry the export section the operator reads')
})

test('#P699 a host with no exporter says export is off, and a healthy one says it is healthy', () => {
  const window = { version: 1, now: 1_000, windowMs: 1_000, live: true, lanes: [], utilization: [], edges: [] }
  assert.deepEqual(buildHealth(window, null).export, { enabled: false }, 'a host with no exporter must say export is off')
  assert.deepEqual(buildHealth(window, { failures: 0, lastOkAt: 1_000, lastError: null }).export, { enabled: true, failing: false, failures: 0, lastOkAt: 1_000, lastError: null }, 'a healthy exporter must say so')
})

test('#P699 three failed pushes behind the timer are one warning, and the endpoint names the streak', async () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false, now: () => 5_000, exporter: { send: collectorDown, intervalMs: 1e9 } })
  for (const record of records()) timeline.trace.append(record)
  for (let attempt = 0; attempt < 3; attempt++) await timeline.exportNow()
  const health = adapter.endpoints.get(HEALTH_ENDPOINT)({})
  timeline.dispose()
  const exportWarns = adapter.warnings.filter(warning => warning.includes('export failed'))
  assert.equal(exportWarns.length, 1, `a failing export warned ${exportWarns.length} time(s) in 3 pushes; a streak is one warning, not one per push`)
  assert.ok(health.export, 'the health answer must carry an export section; it has none')
  assert.deepEqual(health.export, { enabled: true, failing: true, failures: 3, lastOkAt: null, lastError: 'HTTP 503' })
})

test('#P699 a 100ms interval against a dead collector is one warning in 560ms, not five', async () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false, now: () => 5_000, exporter: { send: collectorDown, intervalMs: 100 } })
  for (const record of records()) timeline.trace.append(record)
  await new Promise(resolve => setTimeout(resolve, 560))
  const health = adapter.endpoints.get(HEALTH_ENDPOINT)({})
  timeline.dispose()
  const exportWarns = adapter.warnings.filter(warning => warning.includes('export failed'))
  assert.equal(exportWarns.length, 1, `a failing export warned ${exportWarns.length} time(s) in 560ms of a 100ms interval; a streak is one warning, not one per tick`)
  assert.ok(health.export, 'the health answer must carry an export section; it has none')
  assert.ok(health.export.failures >= 3, `the endpoint must count at least the 3 ticks that ran, counted ${health.export.failures}`)
  assert.equal(health.export.failing, true)
})

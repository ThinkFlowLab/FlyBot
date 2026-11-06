// The baseline numbers are only worth recording if the code that turns samples into p50/p95 and
// into a diffable row is itself tested, and the JSON shape two runs are compared by is fixed here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  benchCommit,
  buildReport,
  markdownTable,
  nearestRank,
  parseArgs,
  percentile,
  pluginLoadMs,
  round1,
  summarize,
  validateReport,
} from '../dev/perf-baseline.mjs'

test('nearest rank: one sample is its own p50 and p95', () => {
  assert.equal(nearestRank([7], 50), 7)
  assert.equal(nearestRank([7], 95), 7)
  assert.equal(percentile([42], 50), 42)
})

test('nearest rank: odd n picks a real sample, never an interpolated one', () => {
  const values = [10, 20, 30, 40, 50]
  assert.equal(nearestRank(values, 50), 30)
  assert.equal(nearestRank(values, 95), 50)
  assert.equal(nearestRank(values, 20), 10)
})

test('nearest rank: even n uses ceil(p/100 * n), the higher of the middle pair at p50', () => {
  const values = [10, 20, 30, 40]
  assert.equal(nearestRank(values, 50), 20)
  assert.equal(nearestRank(values, 75), 30)
  assert.equal(nearestRank(values, 95), 40)
  assert.equal(nearestRank(values, 100), 40)
})

test('percentile sorts its input and rejects an empty sample', () => {
  assert.equal(percentile([30, 10, 20], 50), 20)
  assert.throws(() => percentile([], 50), /no samples/)
  assert.throws(() => nearestRank([1, 2], 0), /out of range/)
  assert.throws(() => percentile([1, Number.NaN], 50), /non-finite/)
})

test('summarize keeps the agreed scenario shape, peak included', () => {
  const row = summarize('turn end-to-end', 'ms', [3, 1, 2, 4])
  assert.deepEqual(Object.keys(row), ['metric', 'unit', 'samples', 'p50', 'p95', 'peak'])
  assert.equal(row.metric, 'turn end-to-end')
  assert.equal(row.unit, 'ms')
  assert.equal(row.samples, 4)
  assert.equal(row.p50, 2)
  assert.equal(row.p95, 4)
  assert.equal(row.peak, 4)
  assert.deepEqual(summarize('plugin load time', 'ms', []), {
    metric: 'plugin load time', unit: 'ms', samples: 0, p50: null, p95: null, peak: null,
  })
})

test('round1 keeps one decimal so two runs diff instead of drifting', () => {
  assert.equal(round1(12.34), 12.3)
  assert.equal(round1(12.35), 12.4)
  assert.equal(round1(0), 0)
})

const sample = () => buildReport({
  machine: 'Linux 6.8; test CPU; 8 cores; 31.3 GB RAM',
  commit: 'a'.repeat(40),
  node: 'v22.23.3',
  date: '2026-11-06T16:20:00Z',
  scenarios: [
    summarize('turn end-to-end', 'ms', [500, 520, 480]),
    summarize('tool-call latency', 'ms', [120, 130]),
    summarize('resident RSS', 'MB', [512.5, 530]),
    summarize('plugin load time', 'ms', [4200]),
  ],
})

test('the report carries machine, commit, node and every scenario', () => {
  const report = sample()
  assert.deepEqual(validateReport(report), [])
  assert.deepEqual(Object.keys(report).filter((key) => key !== 'date'), ['machine', 'commit', 'node', 'scenarios'])
  assert.equal(report.scenarios.length, 4)
})

test('validateReport refuses what would make two runs incomparable', () => {
  const missing = sample()
  delete missing.commit
  assert.match(validateReport(missing).join(';'), /missing commit/)

  const shortSha = sample()
  shortSha.commit = 'abc123'
  assert.match(validateReport(shortSha).join(';'), /40-character sha/)

  const noScenarios = sample()
  noScenarios.scenarios = []
  assert.match(validateReport(noScenarios).join(';'), /scenarios is empty/)

  const unnamed = sample()
  delete unnamed.scenarios[0].unit
  assert.match(validateReport(unnamed).join(';'), /scenarios\[0\] missing unit/)
})

test('the markdown table is one header plus one row per scenario, pinned by commit', () => {
  const table = markdownTable(sample())
  const lines = table.split('\n')
  assert.match(lines[0], /a{40}/)
  assert.match(table, /\| metric \| unit \| samples \| p50 \| p95 \| peak \|/)
  assert.match(table, /\| turn end-to-end \| ms \| 3 \| 500 \| 520 \| 520 \|/)
  assert.match(table, /\| plugin load time \| ms \| 1 \| 4200 \| 4200 \| 4200 \|/)
  assert.equal(lines.filter((line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| metric')).length, 4)
})

test('arguments: bench name, port and --out are required; flags parse by name', () => {
  assert.throws(() => parseArgs([]), /required/)
  assert.throws(() => parseArgs(['perf', '3097']), /--out is required/)
  assert.throws(() => parseArgs(['perf', '3097', '--out', 'x', '--nope']), /unknown flag/)
  const flags = parseArgs(['perf', '3097', '--out', '/tmp/perf.json', '--turns', '5', '--warmup', '1', '--message', 'hi'])
  assert.equal(flags.name, 'perf')
  assert.equal(flags.port, 3097)
  assert.equal(flags.out, '/tmp/perf.json')
  assert.equal(flags.turns, 5)
  assert.equal(flags.warmup, 1)
  assert.equal(flags.message, 'hi')
  assert.equal(flags.timeout, 120_000)
})

test('plugin load time is null when the bench never logged a ready line', () => {
  assert.equal(pluginLoadMs('/nonexistent-bench-home'), null)
})

test('a report never records a placeholder commit', () => {
  const sha = 'b'.repeat(40)
  assert.equal(benchCommit('/nonexistent-checkout', { PERF_COMMIT: sha }), sha)
  assert.throws(() => benchCommit('/nonexistent-checkout', {}), /PERF_COMMIT=<40-character sha> is required/)
  assert.throws(() => benchCommit('/nonexistent-checkout', { PERF_COMMIT: 'abc123' }), /must be a 40-character sha/)
})

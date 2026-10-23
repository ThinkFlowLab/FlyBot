import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'core', 'dev', 'token-report.mjs')
const REPORT = join(ROOT, 'docs', 'reports', '2026-10-23-token-spend.md')

const at = minutes => Date.UTC(2026, 9, 20, 10, minutes)

// The ledger's schema as src/host/usage.js creates it. One Bot with a cache-read-heavy
// turn, a Bot with none, and a third Session with no owners row.
const calls = [
  // session-dev, owned by Dev: three turns, then a compaction shrinks the prompt.
  ['session-dev', at(0), 'turn', 100, 1000, 10, 5],
  ['session-dev', at(1), 'turn', 200, 1000, 0, 7],
  ['session-dev', at(2), 'turn', 50, 900, 0, 9],
  ['session-dev', at(3), 'turn', 5, 0, 0, 2],
  // session-reviewer, owned by Reviewer: no cache reads at all.
  ['session-reviewer', at(0), 'turn', 10, 0, 0, 3],
  // session-unowned: no owners row, so it must appear under its Session id.
  ['session-unowned', at(0), 'turn', 7, 30, 1, 2],
]
const owners = [
  ['session-dev', 'session-dev', 'Dev'],
  ['session-reviewer', 'session-reviewer', 'Reviewer'],
]

function fixture(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'token-report-'))
  const path = join(dir, 'usage.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
      CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);`)
    const put = db.prepare('INSERT INTO calls (key, session, time, provider, model, kind, live, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
    for (const [index, [session, time, kind, input, cacheRead, cacheWrite, output]] of [...calls, ...extra].entries()) {
      put.run(`${session}:${index}`, session, time, 'test', 'test-model', kind, input, cacheRead, cacheWrite, output)
    }
    const owner = db.prepare('INSERT INTO owners (session, owner, name) VALUES (?, ?, ?)')
    for (const row of owners) owner.run(...row)
  } finally {
    db.close()
  }
  return { path, dir }
}

function run(path, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, '--db', path, ...args], { encoding: 'utf8' })
  return result
}

test('the report matches hand-computed sums, with cache reads kept apart', () => {
  const { path, dir } = fixture()
  try {
    const result = run(path, '--json', '--tz', 'UTC')
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.calls, 6)
    assert.deepEqual(
      { input: report.input, cacheRead: report.cacheRead, cacheWrite: report.cacheWrite, output: report.output, prompt: report.prompt },
      { input: 372, cacheRead: 2930, cacheWrite: 11, output: 28, prompt: 3313 },
    )
    // 5, 10, 38, 950, 1110, 1200 — nearest rank.
    assert.deepEqual(report.promptPerCall, { p50: 38, p90: 1200, p99: 1200, max: 1200 })

    const dev = report.bots.find(row => row.bot === 'Dev')
    assert.deepEqual(
      { calls: dev.calls, input: dev.input, cacheRead: dev.cacheRead, cacheWrite: dev.cacheWrite, output: dev.output, prompt: dev.prompt },
      { calls: 4, input: 355, cacheRead: 2900, cacheWrite: 10, output: 23, prompt: 3265 },
    )
    // Cache reads are never folded into fresh input: the two columns stay the numbers above.
    assert.equal(dev.input, 355)
    assert.equal(dev.cacheRead, 2900)
    assert.equal(dev.input + dev.cacheRead + dev.cacheWrite, dev.prompt)

    // An unowned Session appears under its Session id, not dropped.
    const unowned = report.bots.find(row => row.bot === 'session-unowned')
    assert.deepEqual({ input: unowned.input, cacheRead: unowned.cacheRead, prompt: unowned.prompt }, { input: 7, cacheRead: 30, prompt: 38 })

    const day = report.days.find(row => row.day === '2026-10-20')
    assert.equal(day.calls, 6)

    // Growth is measured between comparable calls: the compaction (1110 → 5) starts a
    // new run instead of contributing a large negative delta.
    const session = report.sessions.find(row => row.session === 'session-dev')
    assert.deepEqual(session.growth, { count: 1, median: 90, p90: 90, resets: 2 })
    assert.equal(report.growthAll.resets, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the window, the Bot filter and a missing ledger', () => {
  const { path, dir } = fixture()
  try {
    const windowed = run(path, '--json', '--tz', 'UTC', '--from', '2026-10-20T10:01', '--to', '2026-10-20T10:02')
    assert.equal(windowed.status, 0, windowed.stderr)
    const window = JSON.parse(windowed.stdout)
    assert.equal(window.calls, 2)
    assert.equal(window.input, 250)

    const byName = JSON.parse(run(path, '--json', '--bot', 'dev').stdout)
    assert.equal(byName.calls, 4)
    const bySession = JSON.parse(run(path, '--json', '--bot', 'session-uno').stdout)
    assert.equal(bySession.calls, 1)

    const missing = join(dir, 'nope.sqlite')
    const absent = run(missing)
    assert.notEqual(absent.status, 0)
    assert.match(absent.stderr, new RegExp(`no ledger at ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    const badDate = run(path, '--from', 'yesterday')
    assert.notEqual(badDate.status, 0)
    assert.match(badDate.stderr, /cannot read "yesterday" as a date/)

    const backwards = run(path, '--from', '2026-10-21', '--to', '2026-10-20')
    assert.notEqual(backwards.status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an impossible date is an error, never an empty report', () => {
  const { path, dir } = fixture()
  try {
    // Each of these used to reach Date.parse or Date.UTC and come back NaN or normalised,
    // which printed "calls 0" and exited 0 — the one thing this report must never do.
    for (const [flag, value] of [
      ['--from', '2026-13-01Z'],
      ['--from', '2026-02-31'],
      ['--to', '2026-02-31'],
      ['--from', '2026-11-02T10:00+99:00'],
      ['--to', '2026-01-01T24:00'],
    ]) {
      const result = run(path, flag, value)
      assert.notEqual(result.status, 0, `${flag} ${value} exited 0`)
      assert.match(result.stderr, /cannot read .* as a date/, `${flag} ${value}: ${result.stderr}`)
      assert.equal(result.stdout, '', `${flag} ${value} printed a report`)
    }
    const valid = run(path, '--json', '--from', '2026-02-28', '--to', '2026-03-01')
    assert.equal(valid.status, 0, valid.stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a day a zone falls back is 25 hours, and --to covers all of it', () => {
  // 2025-11-02 in America/New_York is 25 hours: it starts at 04:00Z (EDT) and ends at
  // 05:00Z the next day (EST). 15:00Z is 10:00 EST, after the fall-back at 06:00Z.
  const { path, dir } = fixture([
    ['session-dst', Date.parse('2025-11-02T15:00:00Z'), 'turn', 10, 0, 0, 1],
    ['session-dst', Date.parse('2025-11-02T17:30:00Z'), 'turn', 10, 0, 0, 1],
  ])
  try {
    const day = JSON.parse(run(path, '--json', '--tz', 'America/New_York', '--from', '2025-11-02', '--to', '2025-11-02').stdout)
    // The bound itself, not just "the two values differ": local 23:59:59.999 on the 2nd.
    assert.equal(day.to, 1762145999999)
    assert.equal(new Date(day.to).toISOString(), '2025-11-03T04:59:59.999Z')
    assert.equal(day.calls, 2)
    assert.deepEqual(day.days.map(row => [row.day, row.calls]), [['2025-11-02', 2]])

    // The day before it ends 25 hours earlier, and holds none of them.
    const earlier = JSON.parse(run(path, '--json', '--tz', 'America/New_York', '--to', '2025-11-01').stdout)
    assert.equal(earlier.to, 1762055999999)
    assert.equal(earlier.to - day.to, -90_000_000)
    assert.equal(earlier.calls, 0)

    // And a bare --to on a normal day still ends at that day's last millisecond.
    const ordinary = JSON.parse(run(path, '--json', '--tz', 'UTC', '--from', '2026-10-20', '--to', '2026-10-20').stdout)
    assert.equal(ordinary.calls, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Every number in the committed report is a table row whose last cell names where it came
// from: the ledger, a formula over the ledger, or that it was not measured.
const PROVENANCE = /^(ledger|derived: .+|not measured)$/

test('every row of the committed report carries its provenance', () => {
  const lines = readFileSync(REPORT, 'utf8').split(/\r?\n/)
  const rows = []
  let header = null
  for (const line of lines) {
    const cells = line.startsWith('|') ? line.split('|').slice(1, -1).map(cell => cell.trim()) : null
    if (cells === null) { header = null; continue }
    if (header === null) { header = cells; continue }
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue
    assert.equal(header.at(-1), 'Source', `a table starting with ${header[0]} has no Source column`)
    rows.push({ header, cells })
  }
  assert.ok(rows.length > 0, 'the report has no tables')
  for (const row of rows) {
    assert.match(row.cells.at(-1), PROVENANCE, `no provenance: | ${row.cells.join(' | ')} |`)
    assert.equal(row.cells.length, row.header.length, `a row has ${row.cells.length} cells, its table ${row.header.length}: | ${row.cells.join(' | ')} |`)
  }
})

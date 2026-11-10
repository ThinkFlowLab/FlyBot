// Red-first for P-666: token-report's default --db path does not match where the host
// writes usage.sqlite (rt.home = join(DSH_HOME, 'bot'), see core/index.js:94 and
// src/host/usage.js:327). Meant to live at core/test/, so ROOT is two levels up.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'core', 'dev', 'token-report.mjs')
const at = Date.UTC(2026, 9, 20, 10, 0)

// The ledger exactly as src/host/usage.js creates it (v3), one Bot, one turn.
function ledger(path) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, harness TEXT NOT NULL, issue_pr TEXT NOT NULL, tool_calls INTEGER NOT NULL, wall_ms INTEGER NOT NULL);
      CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL);
      CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL);
      PRAGMA user_version = 3;`)
    db.prepare('INSERT INTO calls (key, session, time, provider, model, kind, live, input, cache_read, cache_write, output, harness, issue_pr, tool_calls, wall_ms) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('s1:1', 's1', at, 'test', 'test-model', 'turn', 100, 1000, 0, 5, 'default', '#799', 2, 900)
    db.prepare('INSERT INTO owners (session, owner, name) VALUES (?, ?, ?)').run('s1', 's1', 'Dev')
  } finally {
    db.close()
  }
}

const run = (env, args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('with no --db the tool reads $DSH_HOME/bot/usage.sqlite, where the host writes it', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'p666-'))
  try {
    mkdirSync(join(dshHome, 'bot'), { recursive: true })
    const path = join(dshHome, 'bot', 'usage.sqlite')
    ledger(path)
    const result = run({ DSH_HOME: dshHome }, ['--json'])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.db, path)
    assert.equal(report.days.length, 1)
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('an explicit --db still wins over the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p666-'))
  try {
    const path = join(dir, 'elsewhere.sqlite')
    ledger(path)
    const result = run({ DSH_HOME: join(dir, 'no-such-home') }, ['--db', path, '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).db, path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

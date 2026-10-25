// #398: the runner hashes its own grader before the first turn and again before the report. A
// difference fails the run, and a bench home inside the checkout never starts: the Bot under test
// holds the workspace it is given, so that workspace may not be the tree the run is judged from.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { benchHome, changedPaths, isInside, treeManifest } from '../integrity.mjs'
import { guardRun, integrityOutcome, OUTCOMES } from '../report.mjs'

const KEY = 'a'.repeat(32)

test('a tampered grader changes its manifest, and untouched files stay put', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-e2e-integrity-'))
  try {
    mkdirSync(join(root, 'dev/live-e2e/fixtures'), { recursive: true })
    writeFileSync(join(root, 'dev/live-e2e/scenarios.mjs'), 'expected total 400\n')
    writeFileSync(join(root, 'dev/live-e2e/fixtures/orders.csv'), 'A001,100\n')
    const before = treeManifest(root, ['dev/live-e2e'])
    assert.deepEqual(Object.keys(before), ['dev/live-e2e/fixtures/orders.csv', 'dev/live-e2e/scenarios.mjs'])
    assert.equal(changedPaths(before, treeManifest(root, ['dev/live-e2e'])).length, 0)

    // The grader's answer key is what a goal-driven Bot would rewrite: the manifest names it.
    writeFileSync(join(root, 'dev/live-e2e/scenarios.mjs'), 'expected total 100\n')
    const after = treeManifest(root, ['dev/live-e2e'])
    assert.deepEqual(changedPaths(before, after), ['dev/live-e2e/scenarios.mjs'])
    assert.notEqual(before['dev/live-e2e/scenarios.mjs'], after['dev/live-e2e/scenarios.mjs'])
    // A new file is a change too, and so is a deleted one.
    writeFileSync(join(root, 'dev/live-e2e/scores.json'), '{}\n')
    rmSync(join(root, 'dev/live-e2e/fixtures/orders.csv'))
    assert.deepEqual(changedPaths(before, treeManifest(root, ['dev/live-e2e'])),
      ['dev/live-e2e/fixtures/orders.csv', 'dev/live-e2e/scenarios.mjs', 'dev/live-e2e/scores.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bench home inside the checkout is refused, so the Bot cannot hold the grader (#398)', () => {
  const repo = '/home/me/FlyBot'
  const inside = guardRun({ apiKey: KEY, home: `${repo}/.dsh-test-live-e2e`, userHome: '/home/me', repoRoot: repo })
  assert.equal(inside.problems.length, 1)
  assert.match(inside.problems[0], /inside the checkout/)
  assert.equal(guardRun({ apiKey: KEY, home: repo, userHome: '/home/me', repoRoot: repo }).problems.length, 1)
  // Outside the checkout is the supported shape, and a path that merely shares a prefix is outside.
  assert.deepEqual(guardRun({ apiKey: KEY, home: '/home/me/benches/live-e2e', userHome: '/home/me', repoRoot: repo }).problems, [])
  assert.deepEqual(guardRun({ apiKey: KEY, home: `${repo}-other/bench`, userHome: '/home/me', repoRoot: repo }).problems, [])
  assert.equal(isInside(`${repo}/x`, repo), true)
  assert.equal(isInside(`${repo}-other`, repo), false)
})

test('the same home written as a relative path is refused too (#1171)', () => {
  const repo = '/home/me/FlyBot'
  const relative = guardRun({ apiKey: KEY, home: '.dsh-test-live-e2e', userHome: '/home/me', repoRoot: repo, cwd: repo })
  assert.equal(relative.problems.length, 1)
  assert.match(relative.problems[0], /inside the checkout/)
  // A relative path that walks out and back in is the same directory, and a `./` prefix changes nothing.
  for (const home of ['./.dsh-test-live-e2e', 'sub/../.dsh-test-live-e2e']) {
    assert.match(guardRun({ apiKey: KEY, home, userHome: '/home/me', repoRoot: repo, cwd: repo }).problems[0], /inside the checkout/)
  }
  // The documented shape — an absolute home outside the checkout — still passes.
  assert.deepEqual(guardRun({ apiKey: KEY, home: '/home/me/.cache/flybot-live-e2e/live-e2e', userHome: '/home/me', repoRoot: repo, cwd: repo }).problems, [])
})

test('the bench home defaults outside the checkout, and LIVE_E2E_HOME inside it is refused (#398)', () => {
  const repo = '/home/me/FlyBot'
  const outside = benchHome({ name: 'live-e2e', env: {}, userHome: '/home/me', root: repo, cwd: repo })
  assert.equal(outside.home, '/home/me/.cache/flybot-live-e2e/live-e2e')
  assert.equal(outside.problem, undefined)
  assert.deepEqual(guardRun({ apiKey: KEY, home: outside.home, userHome: '/home/me', repoRoot: repo, cwd: repo }).problems, [])
  // The shape README used to document — `<repo>/.dsh-test-<name>` — is refused, absolute or not.
  for (const value of [join(repo, '.dsh-test-live-e2e'), '.dsh-test-live-e2e', 'sub/../.dsh-test-live-e2e']) {
    assert.match(benchHome({ name: 'live-e2e', env: { LIVE_E2E_HOME: value }, userHome: '/home/me', root: repo, cwd: repo }).problem, /inside the checkout/)
  }
  assert.match(benchHome({ name: 'live-e2e', env: { LIVE_E2E_HOME: '/home/me/.dsh/bench' }, userHome: '/home/me', root: repo, cwd: repo }).problem, /DSH data/)
})

test('a symlinked path cannot read as outside the checkout (#398)', () => {
  const base = mkdtempSync(join(tmpdir(), 'live-e2e-symlink-'))
  try {
    const repo = join(base, 'FlyBot')
    mkdirSync(join(repo, 'dev/live-e2e'), { recursive: true })
    symlinkSync(repo, join(base, 'alias'), 'dir')
    // A home reached through a symlink is still inside the checkout.
    assert.equal(isInside(join(base, 'alias/.dsh-test-x'), repo), true)
    const guard = guardRun({ apiKey: KEY, home: join(base, 'alias/.dsh-test-x'), userHome: join(base, 'home'), repoRoot: repo })
    assert.match(guard.problems[0], /inside the checkout/)
    // A checkout reached through a symlink is still the same checkout.
    assert.equal(isInside(join(repo, 'x'), join(base, 'alias')), true)
    assert.equal(isInside(join(base, 'elsewhere'), join(base, 'alias')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an evidence directory inside the grader is refused, since it would record its own writes (#398)', () => {
  const repo = '/home/me/FlyBot'
  const inside = guardRun({ apiKey: KEY, evidence: `${repo}/dev/live-e2e/evidence`, userHome: '/home/me', repoRoot: repo, cwd: repo })
  assert.equal(inside.problems.length, 1)
  assert.match(inside.problems[0], /evidence directory/)
  assert.deepEqual(guardRun({ apiKey: KEY, evidence: `${repo}/evidence`, userHome: '/home/me', repoRoot: repo, cwd: repo }).problems, [])
})

test('a tampered run has its own outcome, never a pass (exit 5)', () => {
  const codes = Object.values(OUTCOMES)
  assert.deepEqual([...new Set(codes)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  assert.equal(OUTCOMES.tampered, 5)
})

test('the tamper rule has the last word over a pass and over the evidence scanner (#398)', () => {
  const clean = integrityOutcome({ outcome: 'pass', findings: [], changed: [] })
  assert.equal(clean.outcome, 'pass')
  assert.equal(clean.clean, true)
  const tampered = integrityOutcome({ outcome: 'pass', findings: [], changed: ['dev/live-e2e/scenarios.mjs'] })
  assert.equal(tampered.outcome, 'tampered')
  assert.equal(tampered.clean, false, 'a tampered run never carries the sanitized stamp')
  assert.match(tampered.stoppedBecause, /dev\/live-e2e\/scenarios\.mjs/)
  // Even a run that already failed is reported as tampered: the evidence is not trustworthy either way.
  assert.equal(integrityOutcome({ outcome: 'assertion_failed', findings: ['cookie material'], changed: ['x'] }).outcome, 'tampered')
  assert.equal(integrityOutcome({ outcome: 'assertion_failed', findings: ['cookie material'], changed: [] }).clean, false)
})

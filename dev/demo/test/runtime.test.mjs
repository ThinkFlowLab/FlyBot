import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

test('real DSH exercises code/test/cwd/member boundaries and removes disposable data', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-runtime-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs')], {
    encoding: 'utf8', timeout: 140_000,
    env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.dsh, '0.2.1-rc.2')
  assert.equal(report.transport, 'real DSH HTTP')
  assert.match(report.model, /deterministic mock/)
  assert.ok(report.checks.includes('independent code verification'))
  assert.ok(report.checks.includes('two distinct member sessions'))
  assert.ok(report.checks.includes('shared plugin write denied'))
  assert.ok(report.notRun.includes('real model'))
  assert.deepEqual(readdirSync(directory), [], 'No private runtime data may remain after success')
})

test('real DSH delivery uses isolated role cwd and refuses completion without a GitHub credential', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-delivery-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--delivery'], {
    encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.milestone, 'M3')
  assert.ok(report.checks.includes('independent configured tests'))
  assert.ok(report.checks.includes('missing GitHub credential blocks publication/acceptance'))
  assert.ok(report.notRun.includes('real model'))
  assert.deepEqual(readdirSync(directory), [])
})

test('real DSH Project agents keep private state separate and revoke old Session access', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-agents-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--agents'], {
    encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.milestone, 'M4')
  assert.ok(report.checks.includes('scoped context tool execution'))
  assert.ok(report.checks.includes('public Chief creates Task as requester'))
  assert.ok(report.checks.includes('removed member old Session denied'))
  assert.ok(report.notRun.includes('real model'))
  assert.deepEqual(readdirSync(directory), [])
})


test('real DSH delivery queue enforces quota before allocation and rechecks membership', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-queue-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--queue'], {
    encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.milestone, 'M5')
  assert.ok(report.checks.includes('Workflow release drains queue'))
  assert.ok(report.checks.includes('revoked member queued request cancelled'))
  assert.ok(report.checks.includes('confirmed worker release before workspace cleanup'))
  assert.deepEqual(readdirSync(directory), [])
})

test('real DSH resumes native Task-role context after a pool return and serializes a single resource', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-native-pool-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--native-pools'], {
    encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.milestone, '2184-native-pools')
  assert.equal(report.runtime, 'actual DSH')
  assert.ok(report.checks.includes('prior conversation present only in retained context'))
  assert.ok(report.checks.includes('native quiescence and single-resource release before downstream execution'))
  assert.ok(report.checks.includes('Chief arbitration inbox without fake closure'))
  assert.ok(report.notRun.includes('real model'))
  assert.deepEqual(readdirSync(directory), [], 'Disposable native workers, profiles and worktrees must be removed')
})

test('actual DSH native return persists Task-role activation, release and continuation through SQLite', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-native-sqlite-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--native-pools', '--sqlite'], {
    encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.storage, 'sqlite')
  assert.equal(report.runtime, 'actual DSH')
  assert.ok(report.checks.includes('actual Chief admission before native pool allocation'))
  assert.ok(report.checks.includes('same Task and original physical role Session'))
  assert.ok(report.checks.includes('native quiescence and single-resource release before downstream execution'))
  assert.ok(report.notRun.includes('real model'))
  assert.deepEqual(readdirSync(directory), [], 'Disposable SQLite state, workers and worktrees must be removed')
})

test('actual unmanaged DSH restart recovers native Chief and later original scheduled inspection', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-chief-restart-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--chief-restart'], { encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' } })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.runtime, 'actual DSH'); assert.equal(report.model, 'deterministic fixture')
  assert.ok(report.checks.includes('later original scheduled occurrence completed without manual inspect'))
  assert.ok(report.recoveryMs > 0); assert.ok(report.recoveryMs < 90000)
  assert.deepEqual(readdirSync(directory), [])
})


test('actual DSH Chief assistance uses native/external inboxes and recovers signed delivery across restart', { timeout: 150_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-assistance-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../run.mjs'), '--chief-assistance'], { encoding: 'utf8', timeout: 140_000, env: { ...process.env, TMPDIR: directory, M0_REPORT: '' } })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.runtime, 'actual DSH'); assert.equal(report.model, 'deterministic fixture')
  assert.ok(report.checks.includes('receiver offline failure and actual host restart recover the same inbox message'))
  assert.ok(report.checks.includes('native agent uses the same inbox contract'))
  assert.ok(report.checks.includes('duplicate signed notification adds no duplicate Task input'))
  assert.equal(report.tasks, 2)
  assert.deepEqual(readdirSync(directory), [])
})

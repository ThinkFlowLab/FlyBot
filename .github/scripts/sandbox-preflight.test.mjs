import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { describe, detect, EXIT_BLOCKED, EXIT_USAGE } from './sandbox-preflight.mjs'

const SCRIPT = new URL('./sandbox-preflight.mjs', import.meta.url).pathname

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('#607: with no bwrap on PATH and no Landlock the preflight reports blocked', (t) => {
  const dir = scratch(t)
  const result = detect({ platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') })
  assert.equal(result.usable, false)
  assert.deepEqual(result.backends, { bwrap: false, landlock: false })
  assert.ok(describe(result).includes('no usable sandbox backend'))
  assert.ok(describe(result).includes('danger-full-access'))
})

test('#607: a runnable bwrap makes workspace-write available', (t) => {
  const dir = scratch(t)
  const bwrap = join(dir, 'bwrap')
  writeFileSync(bwrap, '#!/bin/sh\nexit 0\n')
  chmodSync(bwrap, 0o755)
  // The host may mount /tmp noexec, so the resolver and runner are injected here; the CLI test
  // above covers the real PATH lookup and spawn on a host without bwrap.
  const run = () => ({ status: 0 })
  const resolve = () => '/usr/bin/bwrap'
  const result = detect({ platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm'), run, resolve })
  assert.equal(result.usable, true)
  assert.deepEqual(result.backends, { bwrap: true, landlock: false })
})

test('#607: the CLI exits 3 with one line naming the unlock, on a fake PATH without bwrap', (t) => {
  const dir = scratch(t)
  const env = { ...process.env, PATH: dir, FLYBOT_LSM_FILE: join(dir, 'no-lsm') }
  let failure
  try {
    execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' })
    assert.fail('the preflight should have exited non-zero')
  } catch (error) {
    failure = error
  }
  assert.equal(failure.status, EXIT_BLOCKED)
  assert.match(failure.stdout, /workspace-write is UNAVAILABLE: no usable sandbox backend/)
  assert.match(failure.stdout, /danger-full-access/)
})

test('#607: the CLI prints JSON it can hand to a report, and rejects unknown flags', (t) => {
  const dir = scratch(t)
  const env = { ...process.env, PATH: dir, FLYBOT_LSM_FILE: join(dir, 'no-lsm') }
  let failure
  try {
    execFileSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' })
  } catch (error) {
    failure = error
  }
  assert.equal(failure.status, EXIT_BLOCKED)
  const result = JSON.parse(failure.stdout)
  assert.equal(result.usable, false)
  assert.equal(result.mode, 'workspace-write')
  assert.ok(Array.isArray(result.unlock))
  let usage
  try {
    execFileSync(process.execPath, [SCRIPT, '--bogus'], { env, encoding: 'utf8' })
  } catch (error) {
    usage = error
  }
  assert.equal(usage.status, EXIT_USAGE)
})

test('#607: an enabled Landlock LSM counts as a usable backend', (t) => {
  const dir = scratch(t)
  const lsm = join(dir, 'lsm')
  writeFileSync(lsm, 'lockdown,capability,landlock,yama\n')
  const result = detect({ platform: 'linux', env: { PATH: dir }, lsmFile: lsm })
  assert.equal(result.usable, true)
  assert.deepEqual(result.backends, { bwrap: false, landlock: true })
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BLOCKED, describe, detect, EXIT_BLOCKED, EXIT_UNKNOWN, EXIT_USAGE, MODE_ENV, resolveMode, resolveOnPath, UNKNOWN } from './sandbox-preflight.mjs'

const SCRIPT = new URL('./sandbox-preflight.mjs', import.meta.url).pathname

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Runs the CLI and returns `{ status, stdout }`: the preflight signals its verdict in the exit
// code, so a non-zero exit is a result here, not a test failure.
function cli(t, args, env = {}) {
  const dir = scratch(t)
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, PATH: dir, FLYBOT_LSM_FILE: join(dir, 'no-lsm'), [MODE_ENV]: '', ...env }, encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (error) {
    return { status: error.status, stdout: error.stdout }
  }
}

test('#607: with no bwrap on PATH and no Landlock, workspace-write is blocked', (t) => {
  const dir = scratch(t)
  const result = detect({ mode: 'workspace-write', platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') })
  assert.equal(result.status, BLOCKED)
  assert.equal(result.usable, false)
  assert.deepEqual(result.backends, { bwrap: false, landlock: false })
  assert.ok(describe(result).includes('no usable sandbox backend'))
  assert.ok(describe(result).includes('danger-full-access'))
})

test('#607: read-only is confined too, so it is blocked on the same host', (t) => {
  const dir = scratch(t)
  const result = detect({ mode: 'read-only', platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') })
  assert.equal(result.status, BLOCKED)
})

test('#607: a runnable bwrap makes workspace-write available', (t) => {
  const dir = scratch(t)
  const bwrap = join(dir, 'bwrap')
  writeFileSync(bwrap, '#!/bin/sh\nexit 0\n')
  chmodSync(bwrap, 0o755)
  // The host may mount /tmp noexec, so the resolver and runner are injected here; the CLI test
  // below covers the real PATH lookup and spawn on a host without bwrap.
  const run = () => ({ status: 0 })
  const resolve = () => '/usr/bin/bwrap'
  const result = detect({ mode: 'workspace-write', platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm'), run, resolve })
  assert.equal(result.status, 'usable')
  assert.equal(result.usable, true)
  assert.deepEqual(result.backends, { bwrap: true, landlock: false })
})

test('#607: the CLI exits 3 with one line naming the unlock, on a fake PATH without bwrap', (t) => {
  const { status, stdout } = cli(t, ['--mode', 'workspace-write'])
  assert.equal(status, EXIT_BLOCKED)
  assert.match(stdout, /workspace-write is UNAVAILABLE: no usable sandbox backend/)
  assert.match(stdout, /danger-full-access/)
})

test('#607: the CLI prints JSON it can hand to a report, and rejects unknown flags', (t) => {
  const blocked = cli(t, ['--mode=workspace-write', '--json'])
  assert.equal(blocked.status, EXIT_BLOCKED)
  const result = JSON.parse(blocked.stdout)
  assert.equal(result.status, BLOCKED)
  assert.equal(result.usable, false)
  assert.equal(result.mode, 'workspace-write')
  assert.ok(Array.isArray(result.unlock))
  assert.equal(cli(t, ['--bogus']).status, EXIT_USAGE)
})

test('#607: an enabled Landlock LSM counts as a usable backend', (t) => {
  const dir = scratch(t)
  const lsm = join(dir, 'lsm')
  writeFileSync(lsm, 'lockdown,capability,landlock,yama\n')
  const result = detect({ mode: 'workspace-write', platform: 'linux', env: { PATH: dir }, lsmFile: lsm })
  assert.equal(result.status, 'usable')
  assert.equal(result.usable, true)
  assert.deepEqual(result.backends, { bwrap: false, landlock: true })
})

// #610: a danger-full-access session runs commands whatever the host probes say. Reporting it
// blocked made the preflight call off sessions that could shell out (this host, 2026-10-21).
test('#615: danger-full-access is never reported blocked, even with no backend at all', (t) => {
  const dir = scratch(t)
  const result = detect({ mode: 'danger-full-access', platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') })
  assert.equal(result.status, 'usable')
  assert.equal(result.usable, true)
  assert.equal(result.needsBackend, false)
  const line = describe(result)
  assert.match(line, /danger-full-access needs no sandbox backend/)
  assert.ok(!line.includes('is UNAVAILABLE'))
  assert.ok(!line.includes('will be refused'))
})

test('#615: the CLI exits 0 in a danger-full-access session on a host with no backend', (t) => {
  const { status, stdout } = cli(t, ['--mode', 'danger-full-access'])
  assert.equal(status, 0)
  assert.match(stdout, /needs no sandbox backend/)
})

test('#615: danger-full-access from the environment variable is honored like the flag', (t) => {
  const dir = scratch(t)
  const result = detect({ ...resolveMode([], { [MODE_ENV]: 'danger-full-access' }), platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') })
  assert.equal(result.mode, 'danger-full-access')
  assert.equal(result.status, 'usable')
  const { status } = cli(t, [], { [MODE_ENV]: 'danger-full-access' })
  assert.equal(status, 0)
})

test('#615: the flag wins over the environment variable, and a typo is a usage error', (t) => {
  assert.deepEqual(resolveMode(['--mode', 'danger-full-access'], { [MODE_ENV]: 'workspace-write' }), { mode: 'danger-full-access', source: 'flag' })
  assert.deepEqual(resolveMode([], { [MODE_ENV]: 'workspace-write' }), { mode: 'workspace-write', source: MODE_ENV })
  assert.equal(resolveMode([], {}).mode, undefined)
  assert.match(resolveMode(['--mode', 'full-access'], {}).error, /unknown file policy/)
  assert.equal(cli(t, ['--mode', 'full-access']).status, EXIT_USAGE)
})

// #610: the Windows ACL runner cannot be probed from a Bot shell. It reported false, which made
// every Windows session look blocked.
test('#615: the Windows ACL runner is unknown, so a Windows session is not called blocked', (t) => {
  const dir = scratch(t)
  const result = detect({ mode: 'workspace-write', platform: 'win32', env: { PATH: dir } })
  assert.deepEqual(result.backends, { 'acl-runner': UNKNOWN })
  assert.equal(result.status, UNKNOWN)
  assert.equal(result.unknown, true)
  assert.equal(result.usable, false)
  const line = describe(result)
  assert.match(line, /cannot tell/)
  assert.match(line, /not probeable from a Bot shell/)
  assert.ok(!line.includes('is UNAVAILABLE'))
})

test('#615: with no policy given the CLI says it cannot tell and exits 4', (t) => {
  const { status, stdout } = cli(t, [])
  assert.equal(status, EXIT_UNKNOWN)
  assert.match(stdout, /cannot tell/)
  assert.match(stdout, /--mode/)
  const json = cli(t, ['--json'])
  assert.equal(json.status, EXIT_UNKNOWN)
  const result = JSON.parse(json.stdout)
  assert.equal(result.status, UNKNOWN)
  assert.equal(result.unknown, true)
  assert.equal(result.mode, null)
})

test('#615: describe() prints the unlock list the result carries', () => {
  const result = { ...detect({ mode: 'workspace-write', platform: 'linux', env: { PATH: '/nonexistent' }, lsmFile: join(tmpdir(), 'flybot-preflight-no-lsm-file') }), unlock: ['ask the owner for danger-full-access'] }
  assert.equal(result.status, BLOCKED)
  assert.match(describe(result), /Unlock: ask the owner for danger-full-access\./)
})

test('#615: a directory named bwrap on PATH is not taken for the binary', (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, 'bwrap'))
  assert.equal(resolveOnPath('bwrap', { PATH: dir }), undefined)
  assert.deepEqual(detect({ mode: 'workspace-write', platform: 'linux', env: { PATH: dir }, lsmFile: join(dir, 'no-lsm') }).backends, { bwrap: false, landlock: false })
})

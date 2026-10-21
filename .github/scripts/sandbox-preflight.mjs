#!/usr/bin/env node
// Preflight for the DSH file policy this session runs under (#607). A new Bot session can start
// on `workspace-write` on a host whose sandbox backends are missing; every `bash` call is then
// refused with SANDBOX_UNAVAILABLE while the session only looks "stuck". Run this once at the
// start of a session (or on the first such refusal): it names the backend health and the one-line
// unlock. Exit 0 = usable, 3 = blocked, 2 = usage.
//
// Detection mirrors DSH's local runner chain (sandbox-local): Linux probes `bwrap` with the real
// read-only profile, then checks that Landlock is enabled in the kernel; macOS probes
// `sandbox-exec`; the Windows ACL restricted-token runner cannot be probed from here and reports
// unavailable. The Landlock check reads /sys/kernel/security/lsm because the in-kernel check is
// the only portable signal without the addon; FLYBOT_LSM_FILE overrides the path for tests.
import { spawnSync } from 'node:child_process'
import { constants, readFileSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const MODE = 'workspace-write'
export const EXIT_BLOCKED = 3
export const EXIT_USAGE = 2
const DEFAULT_LSM_FILE = '/sys/kernel/security/lsm'
// The read-only bwrap profile DSH's provider probes with before it trusts the runner.
const BWRAP_PROBE = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true']
const UNLOCK = [
  'approve danger-full-access for this turn (or the Bot)',
  'install bubblewrap on the host',
  'run a Landlock-enforcing kernel',
  'change the session file policy to danger-full-access',
]

export function resolveOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* keep looking */ }
  }
  return undefined
}

export function probeBwrap(env = process.env, run = spawnSync, resolve = resolveOnPath) {
  const bin = resolve('bwrap', env)
  if (bin === undefined) return false
  return run(bin, BWRAP_PROBE, { env, timeout: 10_000, stdio: 'ignore' }).status === 0
}

export function probeLandlock(lsmFile = process.env.FLYBOT_LSM_FILE || DEFAULT_LSM_FILE) {
  try { return readFileSync(lsmFile, 'utf8').split(',').map(part => part.trim()).includes('landlock') } catch { return false }
}

export function probeSeatbelt(env = process.env, run = spawnSync, resolve = resolveOnPath) {
  const bin = resolve('sandbox-exec', env)
  if (bin === undefined) return false
  return run(bin, ['-p', '(version 1)(allow default)', 'true'], { env, timeout: 10_000, stdio: 'ignore' }).status === 0
}

export function detect({ platform = process.platform, env = process.env, lsmFile = env.FLYBOT_LSM_FILE || DEFAULT_LSM_FILE, run = spawnSync, resolve = resolveOnPath } = {}) {
  const probes = {
    bwrap: () => probeBwrap(env, run, resolve),
    landlock: () => probeLandlock(lsmFile),
    seatbelt: () => probeSeatbelt(env, run, resolve),
    // The Windows ACL runner needs a restricted token this process cannot mint, so it cannot be
    // probed from inside a Bot shell: report it unknown, never falsely usable.
    'acl-runner': () => false,
  }
  const candidates = platform === 'linux' ? ['bwrap', 'landlock'] : platform === 'darwin' ? ['seatbelt'] : ['acl-runner']
  const backends = Object.fromEntries(candidates.map(name => [name, probes[name]()]))
  const usable = Object.values(backends).some(Boolean)
  return { mode: MODE, platform, usable, backends, unlock: usable ? [] : UNLOCK }
}

export function describe(result) {
  if (result.usable) {
    const names = Object.entries(result.backends).filter(([, ok]) => ok).map(([name]) => name)
    return `sandbox-preflight: ${result.mode} is available (${names.join(', ')}).`
  }
  const missing = Object.entries(result.backends).map(([name, ok]) => ok ? `${name} usable` : name === 'bwrap' ? 'bubblewrap missing or not runnable' : name === 'landlock' ? 'Landlock not enabled' : name === 'seatbelt' ? 'sandbox-exec not usable' : 'ACL runner not probeable').join('; ')
  return `sandbox-preflight: ${result.mode} is UNAVAILABLE: no usable sandbox backend (${missing}). Every shell call will be refused with SANDBOX_UNAVAILABLE. Unlock: ${UNLOCK.join('; ')}.`
}

if (process.argv[1] && process.argv[1].endsWith('sandbox-preflight.mjs')) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--json')) {
    console.error('usage: node .github/scripts/sandbox-preflight.mjs [--json]')
    process.exit(EXIT_USAGE)
  }
  const result = detect()
  if (args.includes('--json')) console.log(JSON.stringify(result))
  else console.log(describe(result))
  process.exit(result.usable ? 0 : EXIT_BLOCKED)
}

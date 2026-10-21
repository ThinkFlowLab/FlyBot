#!/usr/bin/env node
// Preflight for the DSH file policy this session runs under (#607, #615). A new Bot session can start
// on `workspace-write` on a host whose sandbox backends are missing; every `bash` call is then
// refused with SANDBOX_UNAVAILABLE while the session only looks "stuck". Run this once at the
// start of a session (or on the first such refusal): it names the backend health and the one-line
// unlock. Pass the session's real file policy with `--mode <tier>` or FLYBOT_SANDBOX_MODE so the
// answer is for that mode only; with no mode the wording is conditional. Exit 0 = usable,
// 3 = proven blocked, 4 = cannot probe (do not stop on unknown), 2 = usage.
//
// Detection mirrors DSH's local runner chain (sandbox-local): Linux probes `bwrap` with the real
// read-only profile, then checks that Landlock is enabled in the kernel; macOS probes
// `sandbox-exec`; the Windows ACL restricted-token runner cannot be probed from here and reports
// unknown — never blocked. The Landlock check reads /sys/kernel/security/lsm because the
// in-kernel check is the only portable signal without the addon; FLYBOT_LSM_FILE overrides the
// path for tests.
import { spawnSync } from 'node:child_process'
import { constants, readFileSync, statSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const EXIT_BLOCKED = 3
export const EXIT_UNKNOWN = 4
export const EXIT_USAGE = 2
const DEFAULT_LSM_FILE = '/sys/kernel/security/lsm'
const MODES = ['workspace-write', 'danger-full-access']
// The read-only bwrap profile DSH's provider probes with before it trusts the runner.
const BWRAP_PROBE = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true']
const UNLOCK = [
  'approve danger-full-access for this turn (or the Bot)',
  'install bubblewrap on the host',
  'run a Landlock-enforcing kernel',
  'change the session file policy to danger-full-access',
]
const NO_SANDBOX_TIERS = new Set(['danger-full-access'])

export function resolveOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    // A directory named like the binary (with an execute bit) is not a runnable one (#615).
    try {
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
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

export function detect({ platform = process.platform, env = process.env, lsmFile = env.FLYBOT_LSM_FILE || DEFAULT_LSM_FILE, run = spawnSync, resolve = resolveOnPath, mode = env.FLYBOT_SANDBOX_MODE } = {}) {
  // A session on danger-full-access needs no sandbox at all: never tell it to stop (#615).
  if (mode !== undefined && NO_SANDBOX_TIERS.has(mode)) {
    return { mode, platform, usable: true, unknown: false, backends: {}, unlock: [] }
  }
  const probes = {
    bwrap: () => probeBwrap(env, run, resolve),
    landlock: () => probeLandlock(lsmFile),
    seatbelt: () => probeSeatbelt(env, run, resolve),
    // The Windows ACL runner needs a restricted token this process cannot mint, so it cannot be
    // probed from inside a Bot shell: report it unknown, never falsely usable and never blocked.
    'acl-runner': () => 'unknown',
  }
  const candidates = platform === 'linux' ? ['bwrap', 'landlock'] : platform === 'darwin' ? ['seatbelt'] : ['acl-runner']
  const backends = Object.fromEntries(candidates.map(name => [name, probes[name]()]))
  const usable = Object.values(backends).some(ok => ok === true)
  const unknown = !usable && Object.values(backends).some(ok => ok === 'unknown')
  return { mode, platform, usable, unknown, backends, unlock: usable ? [] : UNLOCK }
}

const backendState = (name, ok) =>
  ok === true ? `${name} usable`
    : ok === 'unknown' ? `${name} cannot be probed from inside a Bot shell`
      : name === 'bwrap' ? 'bubblewrap missing or not runnable'
        : name === 'landlock' ? 'Landlock not enabled'
          : name === 'seatbelt' ? 'sandbox-exec not usable'
            : `${name} unavailable`

export function describe(result) {
  if (result.usable) {
    const names = Object.entries(result.backends).filter(([, ok]) => ok === true).map(([name]) => name)
    const how = names.length > 0 ? `(${names.join(', ')})` : '(no sandbox needed)'
    return `sandbox-preflight: ${result.mode} is available ${how}.`
  }
  const missing = Object.entries(result.backends).map(([name, ok]) => backendState(name, ok)).join('; ')
  if (result.unknown) {
    return `sandbox-preflight: ${result.mode} is UNKNOWN here (${missing}). Do not stop shell work on unknown: only a proven block means the sandbox is unavailable.`
  }
  const unlock = `Unlock: ${(result.unlock ?? []).join('; ')}.`
  if (result.mode === undefined) {
    return `sandbox-preflight: no mode given; the backends below were probed for workspace-write. If this session is on workspace-write, every shell call will be refused with SANDBOX_UNAVAILABLE (no usable sandbox backend: ${missing}). ${unlock} Pass the real tier with --mode (or FLYBOT_SANDBOX_MODE) to answer for it.`
  }
  return `sandbox-preflight: ${result.mode} is UNAVAILABLE: no usable sandbox backend (${missing}). Every shell call will be refused with SANDBOX_UNAVAILABLE. ${unlock}`
}

if (process.argv[1] && process.argv[1].endsWith('sandbox-preflight.mjs')) {
  const args = process.argv.slice(2)
  const usage = () => {
    console.error(`usage: node .github/scripts/sandbox-preflight.mjs [--json] [--mode ${MODES.join('|')}]`)
    process.exit(EXIT_USAGE)
  }
  let mode = process.env.FLYBOT_SANDBOX_MODE
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      mode = args[++i]
      if (mode === undefined || !MODES.includes(mode)) usage()
    } else if (args[i].startsWith('--mode=')) {
      mode = args[i].slice('--mode='.length)
      if (!MODES.includes(mode)) usage()
    } else if (args[i] !== '--json') {
      usage()
    }
  }
  const result = detect({ mode })
  if (args.includes('--json')) console.log(JSON.stringify(result))
  else console.log(describe(result))
  process.exit(result.usable ? 0 : result.unknown ? EXIT_UNKNOWN : EXIT_BLOCKED)
}

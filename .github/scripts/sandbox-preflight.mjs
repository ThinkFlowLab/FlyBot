#!/usr/bin/env node
// Preflight for the DSH file policy this session runs under (#607). A new Bot session can start
// on `workspace-write` on a host whose sandbox backends are missing; every `bash` call is then
// refused with SANDBOX_UNAVAILABLE while the session only looks "stuck". Run this once at the
// start of a session (or on the first such refusal): it names the backend health and the one-line
// unlock.
//
// The file policy is a session setting, so the preflight cannot read it back from the environment:
// it comes from `--mode <policy>` or FLYBOT_SANDBOX_MODE (the docs say to copy it from the
// session). That matters, because only two of the three tiers need a sandbox backend:
//
//   danger-full-access          no backend needed: a session on it runs commands whatever the
//                               probes say, so calling it blocked would call off working sessions
//   workspace-write, read-only  a backend is required: no usable one means blocked
//   not given                   the probes still run, but the policy is unknown, so the preflight
//                               says it cannot tell and exits 0; a bash refusal with
//                               SANDBOX_UNAVAILABLE is then the real signal
//
// Exit 0 = usable, 3 = proven blocked, 4 = cannot probe (do not stop on 4), 2 = usage.
//
// Detection mirrors DSH's local runner chain (sandbox-local): Linux probes `bwrap` with the real
// read-only profile, then checks that Landlock is enabled in the kernel; macOS probes
// `sandbox-exec`; the Windows ACL restricted-token runner cannot be probed from inside a Bot
// shell, so it reports `unknown` and never `false`. The Landlock check reads
// /sys/kernel/security/lsm because the in-kernel check is the only portable signal without the
// addon; FLYBOT_LSM_FILE overrides the path for tests.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const MODES = ['read-only', 'workspace-write', 'danger-full-access']
export const MODE_ENV = 'FLYBOT_SANDBOX_MODE'
export const USABLE = 'usable'
export const BLOCKED = 'blocked'
export const UNKNOWN = 'unknown'
export const EXIT_BLOCKED = 3
export const EXIT_UNKNOWN = 4
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
// The two tiers whose `bash` calls are confined, so they need a usable backend.
const NEEDS_BACKEND = ['read-only', 'workspace-write']

export function resolveOnPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    try {
      // A directory named `bwrap` is executable on Linux and would be spawned: require a file.
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  return undefined
}

// The policy comes from the flag, else the environment: `{ mode, source }` when one named it,
// `{ mode: undefined, source: 'unknown' }` when nothing did, `{ error }` when a caller passed
// something that is not one of the three policies (a typo must not read as "unknown, carry on").
export function resolveMode(argv = [], env = process.env) {
  let value
  let source
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      if (index + 1 >= argv.length) return { error: '--mode needs a value' }
      value = argv[index + 1]
      source = 'flag'
      index += 1
    } else if (arg.startsWith('--mode=')) {
      value = arg.slice('--mode='.length)
      source = 'flag'
    }
  }
  if (value === undefined && env[MODE_ENV]) {
    value = env[MODE_ENV]
    source = MODE_ENV
  }
  if (value === undefined) return { mode: undefined, source: 'unknown' }
  if (!MODES.includes(value)) return { error: `unknown file policy "${value}"; expected one of ${MODES.join(', ')}` }
  return { mode: value, source }
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

export function detect({ mode, platform = process.platform, env = process.env, lsmFile = env.FLYBOT_LSM_FILE || DEFAULT_LSM_FILE, run = spawnSync, resolve = resolveOnPath } = {}) {
  const probes = {
    bwrap: () => probeBwrap(env, run, resolve),
    landlock: () => probeLandlock(lsmFile),
    seatbelt: () => probeSeatbelt(env, run, resolve),
    // The Windows ACL runner needs a restricted token this process cannot mint, so it cannot be
    // probed from inside a Bot shell: report it `unknown`, never `false`. A Windows session must
    // not be called blocked on a probe that cannot run there.
    'acl-runner': () => UNKNOWN,
  }
  const candidates = platform === 'linux' ? ['bwrap', 'landlock'] : platform === 'darwin' ? ['seatbelt'] : ['acl-runner']
  const backends = Object.fromEntries(candidates.map(name => [name, probes[name]()]))
  const usableBackends = Object.keys(backends).filter(name => backends[name] === true)
  const unknownBackends = Object.keys(backends).filter(name => backends[name] === UNKNOWN)
  let status
  if (usableBackends.length > 0) status = USABLE
  else if (mode === 'danger-full-access') status = USABLE
  else if (NEEDS_BACKEND.includes(mode) && unknownBackends.length === 0) status = BLOCKED
  // Anything else cannot be confirmed either way: no policy was named, or a probe that would
  // decide it cannot run here.
  else status = UNKNOWN
  const usable = status === USABLE
  return {
    mode: mode ?? null,
    modeSource: mode === undefined ? 'unknown' : 'given',
    platform,
    status,
    unknown: status === UNKNOWN,
    usable,
    needsBackend: NEEDS_BACKEND.includes(mode),
    backends,
    unlock: usable ? [] : UNLOCK,
  }
}

function missingText(backends) {
  return Object.entries(backends).map(([name, ok]) => {
    if (ok === true) return `${name} usable`
    if (ok === UNKNOWN) return `${name} not probeable from a Bot shell`
    if (name === 'bwrap') return 'bubblewrap missing or not runnable'
    if (name === 'landlock') return 'Landlock not enabled'
    if (name === 'seatbelt') return 'sandbox-exec not usable'
    return `${name} unavailable`
  }).join('; ')
}

export function describe(result) {
  const names = Object.entries(result.backends).filter(([, ok]) => ok === true).map(([name]) => name)
  const missing = missingText(result.backends)
  if (result.usable) {
    if (result.mode === 'danger-full-access') return `sandbox-preflight: danger-full-access needs no sandbox backend, so this session can run commands (${names.length > 0 ? names.join(', ') : 'no backend'} known usable).`
    return `sandbox-preflight: ${result.mode} is available (${names.join(', ')}).`
  }
  if (result.status === UNKNOWN) {
    const why = result.mode == null
      ? `no file policy was given (pass --mode <${MODES.join('|')}> or set ${MODE_ENV})`
      : 'a backend that would decide it cannot be probed from a Bot shell'
    return `sandbox-preflight: cannot tell whether ${result.mode ?? 'this session'} is usable: ${missing}, and ${why}. Do not stop on this: a bash refusal with SANDBOX_UNAVAILABLE is the only proof, and if this session is on workspace-write, every shell call is refused with it. Unlock if blocked: ${(result.unlock ?? UNLOCK).join('; ')}.`
  }
  return `sandbox-preflight: ${result.mode} is UNAVAILABLE: no usable sandbox backend (${missing}). Every shell call will be refused with SANDBOX_UNAVAILABLE. Unlock: ${(result.unlock ?? UNLOCK).join('; ')}.`
}

if (process.argv[1] && process.argv[1].endsWith('sandbox-preflight.mjs')) {
  const argv = process.argv.slice(2)
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode') { index += 1; continue }
    if (argv[index] === '--json' || argv[index].startsWith('--mode=')) continue
    rest.push(argv[index])
  }
  if (rest.length > 0) {
    console.error(`usage: node .github/scripts/sandbox-preflight.mjs [--mode <${MODES.join('|')}>] [--json]`)
    process.exit(EXIT_USAGE)
  }
  const resolved = resolveMode(argv)
  if (resolved.error) {
    console.error(`sandbox-preflight: ${resolved.error}`)
    process.exit(EXIT_USAGE)
  }
  const result = detect({ mode: resolved.mode })
  if (argv.includes('--json')) console.log(JSON.stringify(result))
  else console.log(describe(result))
  process.exit(result.status === BLOCKED ? EXIT_BLOCKED : result.status === UNKNOWN ? EXIT_UNKNOWN : 0)
}

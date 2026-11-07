import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addonSubpath, checkBench, libcName, nativeAddonPath, problemLine } from '../dev/bench-preflight.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tree(base = tmpdir()) {
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'flybot-bench-preflight-'))
  roots.push(root)
  return { root, harness: join(root, 'harness') }
}

// A shell fixture has to execute `pnpm`, and a tmpdir can sit on a noexec mount (it does on
// the shared box). node_modules is inside the checkout, ignored by git, and always executable.
function execTree() {
  return tree(join(here, '..', 'node_modules', '.cache'))
}

function writeAddon(harness, { platform = 'linux', arch = 'arm64', libc = 'glibc' } = {}) {
  const file = nativeAddonPath(harness, { platform, arch, libc })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  return file
}

test('passes when pnpm and the addon the loader would require are there', () => {
  const { harness } = tree()
  const file = writeAddon(harness)
  const result = checkBench({ harnessDir: harness, platform: 'linux', arch: 'arm64', libc: 'glibc', hasPnpm: true })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'pass')
  assert.equal(result.addon, file)
})

test('refuses with missing-pnpm before it looks at the addon', () => {
  const { harness } = tree()
  const result = checkBench({ harnessDir: harness, platform: 'linux', arch: 'arm64', libc: 'glibc', hasPnpm: false })
  assert.equal(result.state, 'missing-pnpm')
  assert.match(problemLine(result), /corepack pnpm/)
})

test('refuses with missing-native-addon and names the exact path', () => {
  const { harness } = tree()
  mkdirSync(join(harness, 'native', 'system', 'packages'), { recursive: true })
  const file = nativeAddonPath(harness, { platform: 'linux', arch: 'arm64', libc: 'glibc' })
  const result = checkBench({ harnessDir: harness, platform: 'linux', arch: 'arm64', libc: 'glibc', hasPnpm: true })
  assert.equal(result.state, 'missing-native-addon')
  assert.equal(result.addon, file)
  const line = problemLine(result)
  assert.ok(line.includes(file), line)
  assert.match(line, /node-addon-system-linux-arm64/)
})

test('does not demand a source-tree addon from an installed harness', () => {
  const { harness } = tree()
  const result = checkBench({ harnessDir: harness, platform: 'linux', arch: 'arm64', libc: 'glibc', hasPnpm: true })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'pass')
})

test('follows the loader on libc and platform', () => {
  assert.equal(addonSubpath({ platform: 'linux', libc: 'glibc' }), join('bin', 'glibc', 'system.node'))
  assert.equal(addonSubpath({ platform: 'linux', libc: 'musl' }), join('bin', 'musl', 'system.node'))
  assert.equal(addonSubpath({ platform: 'darwin' }), join('bin', 'system.node'))
  assert.equal(libcName('darwin'), undefined)
})

test('bench.sh refuses before writing the profile when pnpm is missing', { skip: process.platform === 'win32' }, () => {
  const { root, harness, path, home } = benchTree()
  const result = runBench({ root, path, harness }, 'start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /pnpm is not on PATH/)
  assert.equal(existsSync(join(home, 'profiles')), false)
})

test('bench.sh shows a failed pnpm install and leaves no half-built profile', { skip: process.platform === 'win32' }, () => {
  const script = '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "install failed: boom" >&2\nexit 1\n'
  const { root, harness, path, home } = benchTree({ pnpm: script })
  const result = runBench({ root, path, harness }, 'start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /install failed: boom/)
  assert.equal(existsSync(join(home, 'profiles', 'web')), false)
})

// A checkout-shaped tree: core/dev/{bench.sh,bench-preflight.mjs}, a harness with the host's
// addon, and a bin directory that holds only what bench.sh needs before the preflight.
function benchTree({ pnpm } = {}) {
  const { root, harness } = execTree()
  const dev = join(root, 'core', 'dev')
  mkdirSync(dev, { recursive: true })
  copyFileSync(join(here, '../dev/bench.sh'), join(dev, 'bench.sh'))
  copyFileSync(join(here, '../dev/bench-preflight.mjs'), join(dev, 'bench-preflight.mjs'))
  writeAddon(harness, { platform: process.platform, arch: process.arch, libc: libcName() })
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  // bench.sh's only external tool before the preflight is `dirname "$0"`, and $0 here is an
  // absolute path; a shell-only stand-in keeps the fixture independent of the host's bin dirs.
  writeFileSync(join(bin, 'dirname'), '#!/bin/sh\nprintf "%s\\n" "${1%/*}"\n')
  chmodSync(join(bin, 'dirname'), 0o755)
  if (pnpm) {
    writeFileSync(join(bin, 'pnpm'), pnpm)
    chmodSync(join(bin, 'pnpm'), 0o755)
  }
  // The rest of the box, minus any directory that holds a real pnpm: these tests decide that
  // answer themselves, and a runner with pnpm installed must not leak one in.
  const rest = (process.env.PATH ?? '').split(':').filter((dir) => dir && !existsSync(join(dir, 'pnpm')))
  return { root, harness, bin, home: join(root, '.dsh-test-smoke'), path: [bin, ...rest].join(':') }
}

function runBench({ root, path, harness }, action) {
  const result = spawnSync('/bin/sh', [join(root, 'core', 'dev', 'bench.sh'), 'smoke', '3097', '8797', action], {
    encoding: 'utf8',
    env: { PATH: path, DSH_HARNESS: harness, HOME: root },
  })
  if (result.error) assert.fail(`could not run bench.sh: ${result.error.message}`)
  return result
}

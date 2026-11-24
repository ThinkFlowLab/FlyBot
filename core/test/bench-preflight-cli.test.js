// The preflight's CLI entry point, reached the way a symlinked checkout reaches it (#3363):
// `import.meta.url` is the resolved module path while argv[1] is the path the shell typed, so a
// symlinked path never matched the old guard and the process exited 0 without running a check.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// A shell fixture has to execute `node`, and a tmpdir can sit on a noexec mount (it does on the
// shared box). node_modules is inside the checkout, ignored by git, and always executable.
function tree() {
  const base = join(here, '..', 'node_modules', '.cache')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'flybot-bench-preflight-cli-'))
  roots.push(root)
  return root
}

// A checkout-shaped tree whose script is reached through a symlinked path, plus a bin of only
// what runs before the preflight: node, a `dirname` stand-in, and coreutils without pnpm.
function checkout({ linkedDir = false } = {}) {
  const root = tree()
  const dev = join(root, 'core', 'dev')
  mkdirSync(dev, { recursive: true })
  copyFileSync(join(here, '../dev/bench.sh'), join(dev, 'bench.sh'))
  copyFileSync(join(here, '../dev/bench-preflight.mjs'), join(dev, 'bench-preflight.mjs'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  writeFileSync(join(bin, 'dirname'), '#!/bin/sh\nprintf "%s\\n" "${1%/*}"\n')
  chmodSync(join(bin, 'dirname'), 0o755)
  for (const tool of ['mkdir', 'cat', 'grep', 'rm', 'sleep', 'setsid', 'tail']) {
    const found = ['/usr/bin', '/bin'].map((dir) => join(dir, tool)).find((file) => existsSync(file))
    if (found) symlinkSync(found, join(bin, tool))
  }
  const harness = join(root, 'harness')
  mkdirSync(harness)
  const linked = join(root, 'linked')
  symlinkSync(linkedDir ? root : dev, linked)
  return { root, bin, harness, linked }
}

test('refuses through a symlinked entry path instead of exiting 0', () => {
  const { root, bin, harness, linked } = checkout({ linkedDir: true })
  const entry = join(linked, 'linked-preflight.mjs')
  symlinkSync(join(linked, 'core', 'dev', 'bench-preflight.mjs'), entry)
  const result = spawnSync(process.execPath, [entry, harness], { encoding: 'utf8', env: { PATH: bin, HOME: root } })
  if (result.error) assert.fail(`could not run the preflight: ${result.error.message}`)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pnpm is not on PATH/)
})

test('bench.sh through a symlinked checkout refuses before making the bench home', { skip: process.platform === 'win32' }, () => {
  const { root, bin, harness, linked } = checkout({ linkedDir: true })
  const result = spawnSync('/bin/sh', [join(linked, 'core', 'dev', 'bench.sh'), 'smoke', '3097', '8797', 'start'], {
    encoding: 'utf8',
    env: { PATH: bin, DSH_HARNESS: harness, HOME: linked },
  })
  if (result.error) assert.fail(`could not run bench.sh: ${result.error.message}`)
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(join(root, '.dsh-test-smoke')), false)
})

// Tests for scripts/ds-bot-upstream.mjs: `check` accepts the committed vendor tree and refuses
// an edited, added or missing file. Runs offline on a throwaway copy of the repository index.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VENDOR = 'runtime/ds-bot-upstream'

// A scratch repository holding the script, the pin and the vendor tree as they are staged here.
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-upstream-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
  run('git', ['init', '-q'])
  run('git', ['config', 'user.email', 'test@example.invalid'])
  run('git', ['config', 'user.name', 'test'])
  const archive = execFileSync('git', ['archive', '--format=tar', execFileSync('git', ['write-tree'], { cwd: ROOT, encoding: 'utf8' }).trim(), '--', 'scripts/ds-bot-upstream.mjs', 'runtime/ds-bot-upstream.pin.json', VENDOR, '.gitattributes'], { cwd: ROOT, maxBuffer: 1 << 28 })
  execFileSync('tar', ['-x', '-C', dir], { input: archive })
  run('git', ['add', '-A'])
  const check = () => spawnSync(process.execPath, ['scripts/ds-bot-upstream.mjs', 'check'], { cwd: dir, encoding: 'utf8' })
  return { dir, run, check }
}

test('check accepts the vendor tree as pinned', (t) => {
  const { check } = scratch(t)
  const result = check()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ds-bot-upstream: ok \(Fei2411\/DS-Bot@[0-9a-f]{12}, ds-bot /)
})

test('check refuses an edited upstream file', (t) => {
  const { dir, run, check } = scratch(t)
  appendFileSync(join(dir, VENDOR, 'ds-bot/index.js'), '\n// local edit\n')
  run('git', ['add', '-A'])
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /runtime\/ds-bot-upstream\/ds-bot is tree [0-9a-f]+ .* the pin says tree /)
})

test('check refuses an unpinned file and a missing one', (t) => {
  const { dir, run, check } = scratch(t)
  writeFileSync(join(dir, VENDOR, 'extra.js'), 'export {}\n')
  run('git', ['rm', '-q', '-f', '--', `${VENDOR}/NOTICE`])
  run('git', ['add', '-A'])
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /runtime\/ds-bot-upstream\/extra\.js is not an upstream path in the pin/)
  assert.match(result.stderr, /runtime\/ds-bot-upstream\/NOTICE is missing/)
})

test('check refuses a changed file mode', (t) => {
  const { run, check } = scratch(t)
  run('git', ['update-index', '--chmod=+x', '--', `${VENDOR}/LICENSE`])
  const result = check()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /runtime\/ds-bot-upstream\/LICENSE is blob [0-9a-f]+ \(100755\)/)
})

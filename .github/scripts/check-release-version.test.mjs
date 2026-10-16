import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-release-version.mjs', import.meta.url))
const core = '0.1.5-flybot.1'
const section = (version, pin = core) => `## [${version}] - 2026-10-16\n\nCore package: ${pin}.\n`

function check(version, changelog = section(version)) {
  const root = mkdtempSync(join(tmpdir(), 'flybot-release-version-'))
  try {
    mkdirSync(join(root, 'core'))
    writeFileSync(join(root, 'core/package.json'), JSON.stringify({ version: core }))
    writeFileSync(join(root, 'CHANGELOG.md'), changelog)
    return spawnSync(process.execPath, [script, ...(version ? [version] : [])], { cwd: root, encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a normal release may match the core package version', () => {
  assert.equal(check(core, '').status, 0)
})

for (const version of ['0.1.0', '0.2.0']) {
  test(`product tag ${version} accepts its documented core pin`, () => {
    const result = check(version)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /core\/package.json unchanged/)
  })
}

test('an unlisted product tag is rejected even with a documented pin', () => {
  assert.equal(check('0.3.0').status, 1)
})

test('v0.2.0 needs its own changelog section', () => {
  assert.equal(check('0.2.0', section('0.1.0')).status, 1)
})

test('v0.2.0 rejects an omitted or different core pin', () => {
  for (const pin of ['', '0.1.5-flybot.2']) {
    assert.equal(check('0.2.0', section('0.2.0', pin)).status, 1)
  }
})

test('a core pin in another version section cannot satisfy v0.2.0', () => {
  assert.equal(check('0.2.0', section('0.2.0', '') + section('0.1.0')).status, 1)
})

test('a version argument is required', () => {
  const result = check(undefined, '')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /usage:/)
})

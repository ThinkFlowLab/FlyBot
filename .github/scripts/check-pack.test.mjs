// `check-pack.mjs` is the list a release and the Docker image are built from: it packs each
// directory named there and the tarballs it writes are what `release.yml` and the `Dockerfile`
// install. The list is hand-maintained and nothing compared it with the tree, so a plugin added to
// `plugins/` stayed out of every tarball while `npm run verify` (which runs the plugin's own
// tests) and the docs both said it shipped — `plugins/project` after #2829 was the case.
//
// The script is a top-level CLI, so the check here reads the one line that decides what ships and
// compares it with the plugin directories on disk: a plugin package that exists but is not packed
// is the defect, whichever plugin it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..', '..')

function packedPackages() {
  const source = readFileSync(join(repo, '.github', 'scripts', 'check-pack.mjs'), 'utf8')
  const match = /const packages = \[([^\]]*)\]/.exec(source)
  assert.ok(match, 'check-pack.mjs must declare what it packs in a `const packages = [...]` list')
  return match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function pluginPackages() {
  return readdirSync(join(repo, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repo, 'plugins', entry.name, 'package.json')))
    .map((entry) => `plugins/${entry.name}`)
    .sort()
}

test('check-pack packs every plugin package in plugins/, so no tarball ships without one', () => {
  const packed = packedPackages()
  const missing = pluginPackages().filter((dir) => !packed.includes(dir))
  assert.deepEqual(missing, [], `the release and the Docker image pack these plugin packages: ${missing.join(', ')} is not among them`)
})

test('check-pack names core and only directories that are packages', () => {
  const packed = packedPackages()
  assert.ok(packed.includes('core'), 'check-pack must pack core')
  const notPackages = packed.filter((dir) => !existsSync(join(repo, dir, 'package.json')))
  assert.deepEqual(notPackages, [], `check-pack names directories that are not packages: ${notPackages.join(', ')}`)
})

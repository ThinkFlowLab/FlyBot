import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const pluginsDir = join(root, 'plugins')

// `FEATURE_PLUGINS` is what the Settings page lists and what a plugin's `pluginEnabled(id)` reads;
// `plugins/<id>/` is what is installed. Nothing else ties the two halves together today, so a new
// plugin without a switch (or a switch without a package) is silent — this file is that tie.
// The list is read from its source literal because the constant is a host module export, not data.
function switchEntries() {
  const source = readFileSync(join(root, 'core', 'src', 'host', 'plugins.js'), 'utf8')
  const start = source.indexOf('export const FEATURE_PLUGINS = Object.freeze([')
  assert.ok(start >= 0, 'plugins.js still declares FEATURE_PLUGINS as a frozen literal list')
  const end = source.indexOf('\n])', start)
  assert.ok(end > start, 'the FEATURE_PLUGINS literal still ends with `])`')
  const entries = [...source.slice(start, end).matchAll(/\{ id: '([^']+)', name: '[^']*', package: '([^']+)'/g)]
    .map(match => ({ id: match[1], package: match[2] }))
  assert.ok(entries.length > 0, 'the list still has entries this test can read')
  return entries
}

test('the switch list and plugins/ agree about which packages ship', () => {
  const installed = new Map()
  for (const item of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const manifest = JSON.parse(readFileSync(join(pluginsDir, item.name, 'package.json'), 'utf8'))
    assert.ok(installed.get(manifest.name) === undefined, `two plugin folders claim ${manifest.name}`)
    installed.set(manifest.name, item.name)
  }

  const entries = switchEntries()
  assert.deepEqual(
    entries.map(entry => entry.package).sort(),
    [...installed.keys()].sort(),
    'the switch list and plugins/ disagree about which packages ship',
  )
  for (const entry of entries) {
    assert.equal(installed.get(entry.package), entry.id, `${entry.package} is plugins/${installed.get(entry.package)}, not plugins/${entry.id}`)
  }
})

test('every switch turns off the plugin that reads it', () => {
  for (const entry of switchEntries()) {
    const index = readFileSync(join(pluginsDir, entry.id, 'index.js'), 'utf8')
    const asks = new RegExp(`pluginEnabled\\??\\.?\\(\\s*'${entry.id}'\\s*\\)`).test(index)
    assert.ok(asks, `plugins/${entry.id}/index.js must ask pluginEnabled('${entry.id}') so the switch reaches it`)
  }
})

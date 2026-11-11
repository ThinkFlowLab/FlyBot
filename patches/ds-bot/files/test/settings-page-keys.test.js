import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', 'src', 'client')

// SETTINGS_PAGES is not exported on purpose: the dialog's page list is private to
// settings.js. Read its literal keys from the source so a call site that names a page
// which is not in the list fails here instead of opening a blank dialog at runtime.
function settingsPageKeys() {
  const source = readFileSync(join(clientRoot, 'settings.js'), 'utf8')
  const line = source.split('\n').find(text => text.startsWith('const SETTINGS_PAGES = ['))
  assert.ok(line, 'settings.js still declares SETTINGS_PAGES as a literal list')
  return [...line.matchAll(/\['([^']+)', '/g)].map(match => match[1])
}

function clientSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) clientSources(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('every openSettings() page key exists in SETTINGS_PAGES', () => {
  const keys = new Set(settingsPageKeys())
  assert.equal(keys.size, 13, 'the settings dialog lists thirteen pages')

  const unknown = []
  let seen = 0
  for (const file of clientSources(clientRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/openSettings\(\s*'([^']+)'/g)) {
        const key = match[1]
        // Plugin pages are contributed by plugins at runtime, not by SETTINGS_PAGES.
        if (key.startsWith('plugin:')) continue
        seen += 1
        if (!keys.has(key)) unknown.push(`${relative(here, file)}:${index + 1} openSettings('${key}') is not a settings page`)
      }
    })
  }

  assert.ok(seen > 0, 'the scan found openSettings() call sites in core/src/client')
  assert.deepEqual(unknown, [], `openSettings() calls with unknown page keys:\n${unknown.join('\n')}`)
})

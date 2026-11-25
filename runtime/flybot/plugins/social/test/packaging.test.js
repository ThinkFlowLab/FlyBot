import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'

// The plugin ships as its own package: an import that leaves plugins/social resolves in
// the monorepo checkout but breaks the installed bundle — face-rooms.js once reached
// into ../../../core/src/shared (see #155) and the whole plugin failed to activate.
// Every relative import in the shipped sources must stay inside the package.
test('shipped sources only import inside the plugin package', () => {
  const src = join(import.meta.dirname, '..', 'src')
  const packageRoot = resolve(src, '..')
  const offenders = []
  for (const file of readdirSync(src)) {
    if (!file.endsWith('.js')) continue
    for (const match of readFileSync(join(src, file), 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(src, file)), match[1])
      if (!target.startsWith(packageRoot + sep)) offenders.push(`${file}: ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

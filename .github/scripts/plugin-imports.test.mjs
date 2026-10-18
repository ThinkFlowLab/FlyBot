// Plugin packages must import only their own files (or declared deps) so a
// packed install (`plugin add github:…&path:/plugins/social`) can load (#153).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importPackedPlugin, outboundImports, specifiersOf } from '../../scripts/lint-plugins.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fake = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-imports-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-plugin', type: 'module', main: 'index.js', peerDependencies: { 'ds-bot': '>=0.1.0' } }))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

test('specifiersOf reads import, export-from, import() and require', () => {
  assert.deepEqual(specifiersOf(`
    import { a } from './a.js'
    import 'node:fs'
    export { b } from '../core/x.js'
    const m = await import('./m.js')
    const r = require('react')
  `).sort(), ['./a.js', '../core/x.js', './m.js', 'node:fs', 'react'].sort())
})

test('runtime sources cannot import outside the plugin package', () => {
  const dir = fake({
    'index.js': "import { formatFaceRoomTitle } from '../../../core/src/shared/face-title.js'\n",
    'src/ok.js': "import { join } from 'node:path'\nimport { x } from './ok.js'\nimport { apply } from 'ds-bot'\n",
    'client.js': "require('react')\n",
    'test/allowed.js': "import { encodeRoomShare } from '../../../core/src/shared/room-share.js'\n",
  })
  try {
    const leaks = outboundImports(dir)
    assert.deepEqual(leaks, [{ file: 'index.js', spec: '../../../core/src/shared/face-title.js' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('undeclared bare imports fail; declared deps and node builtins pass', () => {
  const dir = fake({
    'index.js': "import lodash from 'lodash'\nimport { apply } from 'ds-bot'\n",
  })
  try {
    assert.deepEqual(outboundImports(dir), [{ file: 'index.js', spec: 'lodash' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('social, tree and timeline runtime sources stay inside their package', () => {
  assert.deepEqual(outboundImports(join(repo, 'plugins/social')), [])
  assert.deepEqual(outboundImports(join(repo, 'plugins/tree')), [])
  assert.deepEqual(outboundImports(join(repo, 'plugins/timeline')), [])
})

test('packed @flybot/social, @flybot/tree and @flybot/timeline import', async () => {
  const social = await importPackedPlugin(join(repo, 'plugins/social'))
  assert.equal(social.name, 'flybot-social')
  assert.equal(typeof social.apply, 'function')
  const tree = await importPackedPlugin(join(repo, 'plugins/tree'))
  assert.equal(typeof tree.apply, 'function')
  const timeline = await importPackedPlugin(join(repo, 'plugins/timeline'))
  assert.equal(timeline.name, 'flybot-timeline')
  assert.equal(typeof timeline.apply, 'function')
})

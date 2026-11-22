// Plugin packages must import only their own files (or declared deps) so a
// packed install (`plugin add github:…&path:/plugins/social`) can load (#153).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPackedTarball, importPackedPlugin, outboundImports, specifiersOf } from '../../scripts/lint-plugins.mjs'

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

test('social, tree, timeline and workflow runtime sources stay inside their package', () => {
  assert.deepEqual(outboundImports(join(repo, 'plugins/social')), [])
  assert.deepEqual(outboundImports(join(repo, 'plugins/tree')), [])
  assert.deepEqual(outboundImports(join(repo, 'plugins/timeline')), [])
  assert.deepEqual(outboundImports(join(repo, 'plugins/workflow')), [])
})

test('a packed plugin extracts with the destination as cwd, so tar never receives a drive path (#3296)', () => {
  // GNU tar reads the `C:` of `C:\…` as a remote `host:path` and fails with "Cannot connect to C:
  // resolve failed" when the archive or `-C` carries a drive path (#3296). A POSIX path only has that
  // shape — a colon before the first slash — while it is cwd-relative, so the case builds one instead
  // of trusting the platform; on Windows every temp path already has it.
  const root = mkdtempSync(join(tmpdir(), 'plugin-pack-3296-'))
  const dest = process.platform === 'win32'
    ? join(root, 'flybot-pack-3296')
    : join('C:\\Users\\runneradmin\\AppData\\Local\\Temp', `flybot-pack-${basename(root)}`)
  const cwd = process.cwd()
  try {
    process.chdir(root)
    mkdirSync(dest, { recursive: true })
    const [info] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', resolve(dest)], {
      cwd: join(repo, 'plugins/project'),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }))
    const packed = extractPackedTarball(join(dest, info.filename), dest)
    assert.ok(existsSync(join(packed, 'package.json')), 'the packed package.json was extracted')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('packed @flybot/social, @flybot/tree, @flybot/timeline and @flybot/workflow import', async () => {
  const social = await importPackedPlugin(join(repo, 'plugins/social'))
  assert.equal(social.name, 'flybot-social')
  assert.equal(typeof social.apply, 'function')
  const tree = await importPackedPlugin(join(repo, 'plugins/tree'))
  assert.equal(typeof tree.apply, 'function')
  const timeline = await importPackedPlugin(join(repo, 'plugins/timeline'))
  assert.equal(timeline.name, 'flybot-timeline')
  assert.equal(typeof timeline.apply, 'function')
  const workflow = await importPackedPlugin(join(repo, 'plugins/workflow'))
  assert.equal(workflow.name, 'flybot-workflow')
  assert.equal(typeof workflow.apply, 'function')
})

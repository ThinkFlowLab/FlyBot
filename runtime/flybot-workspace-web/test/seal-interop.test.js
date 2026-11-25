import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSealKey, loadImportSealKey, unwrapLegacy, seal, unseal } from '../lib/b4/seal.js'

test('Python model_api.wrap is decoded byte-for-byte by JS (Unicode and multi-block)', () => {
  const cwd = fileURLToPath(new URL('../../../', import.meta.url))
  const raw = execFileSync('python3', ['-c', `import json
from flybot_workspace.model_api import wrap
value = 'test-only-秘密-' * 12
print(json.dumps({'blob':wrap(bytes.fromhex('11'*32), value),'value':value}))`], { cwd, encoding: 'utf8' })
  const fixture = JSON.parse(raw)
  assert.equal(unwrapLegacy(Buffer.alloc(32, 0x11), fixture.blob), fixture.value)
})

test('late manager mount never changes the local storage key; import uses manager only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-seal-'))
  try {
    const manager = join(dir, 'manager.key'), fallbackFile = join(dir, 'local.key')
    const env = { FLYBOT_WORKSPACE_SEAL_KEY_FILE: manager }
    const local = loadSealKey({ env, fallbackFile, preferFallback: true })
    const stored = seal(local, 'test', 'test-only-value')
    assert.equal(loadImportSealKey(env), null)
    writeFileSync(manager, Buffer.alloc(32, 0x22))
    assert.deepEqual(loadImportSealKey(env), Buffer.alloc(32, 0x22))
    assert.equal(unseal(loadSealKey({ env, fallbackFile, preferFallback: true }), 'test', stored), 'test-only-value')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

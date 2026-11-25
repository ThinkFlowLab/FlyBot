import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importPending } from '../src/pending-import.js'

test('boot imports only its feature; foreign targets retained; redelivery is idempotent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-import-')), db = new DatabaseSync(':memory:')
  try {
    const dir = join(dataDir, 'flybot-workspace', 'import'); mkdirSync(dir, { recursive: true })
    const host = { dataDir, name: 'agents', identity: { instanceId: 'a'.repeat(32), routingInstanceId: 'b'.repeat(32) }, log() {} }
    const file = join(dir, 'agents-v1.bundle'), other = join(dir, 'automations-v1.bundle')
    const text = JSON.stringify({ feature: 'agents', instance_id: host.identity.routingInstanceId })
    writeFileSync(file, text); writeFileSync(other, '{"feature":"automations"}')
    let calls = 0; const migrate = async () => { calls++ }
    await importPending({ host, db, migrate }); assert.equal(calls, 1); assert.equal(existsSync(file), false)
    writeFileSync(file, text); await importPending({ host, db, migrate }); assert.equal(calls, 1)
    assert.equal(existsSync(other), true)
    for (const instance_id of [host.identity.instanceId, undefined]) {
      writeFileSync(file, JSON.stringify({ feature: 'agents', instance_id }))
      const rejected = await importPending({ host, db, migrate })
      assert.deepEqual(rejected, [{ status: 'rejected' }])
      assert.equal(existsSync(file), true)
      assert.equal(calls, 1)
    }
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
})

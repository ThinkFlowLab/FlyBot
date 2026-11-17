import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane } from '../index.js'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken, redact, verifyControl, verifyOperator } from '../src/credentials.mjs'
import { handle } from '../src/server.mjs'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-cred-'))
  const store = openStore(dataDir)
  const plane = createPlane({ dataDir, store, backend: new MemoryBackend() })
  const tokenA = mintOperatorToken(store, 'acct-a')
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return { dataDir, store, plane, tokenA, cleanup }
}

test('a control token is not accepted on the operator API (401)', async () => {
  const { store, plane, tokenA, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    assert.match(tokenA, /^op_[0-9a-f]{32}$/)
    assert.match(created.controlToken, /^ctl_[0-9a-f]{32}$/)
    const res = await handle(
      { method: 'GET', path: `/api/instances/${created.id}`, headers: { authorization: `Bearer ${created.controlToken}` }, body: '' },
      { plane, store },
    )
    assert.equal(res.status, 401)
  } finally {
    cleanup()
  }
})

test('operator and control credentials do not verify as each other', async () => {
  const { store, plane, tokenA, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    assert.equal(verifyOperator(store, `Bearer ${created.controlToken}`), null)
    assert.equal(verifyControl(store.getInstance(created.id), `Bearer ${tokenA}`), null)
    assert.equal(verifyOperator(store, `Bearer ${tokenA}`).id, 'acct-a')
    assert.equal(verifyControl(store.getInstance(created.id), `Bearer ${created.controlToken}`).id, created.id)
  } finally {
    cleanup()
  }
})

test('plane.json stores token hashes, never the plaintext tokens', async () => {
  const { dataDir, plane, tokenA, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    const raw = readFileSync(join(dataDir, 'plane.json'), 'utf8')
    assert.ok(!raw.includes(tokenA), 'operator token must not be persisted in plaintext')
    assert.ok(!raw.includes(created.controlToken), 'control token must not be persisted in plaintext')
    assert.doesNotMatch(raw, /(?:op|ctl)_[0-9a-f]{32}/)
    assert.equal(JSON.parse(raw).version, 1)
  } finally {
    cleanup()
  }
})

test('two instances get different control tokens and redact() hides them', async () => {
  const { plane, cleanup } = setup()
  try {
    const a = await plane.createInstance({ workspaceId: 'ws-1', name: 'a', ownerId: 'acct-a' })
    const b = await plane.createInstance({ workspaceId: 'ws-1', name: 'b', ownerId: 'acct-a' })
    assert.notEqual(a.controlToken, b.controlToken)
    const redacted = redact(a.controlToken)
    assert.ok(!redacted.includes(a.controlToken.slice(3)))
    assert.match(redacted, /^ctl_/)
  } finally {
    cleanup()
  }
})

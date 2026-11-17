import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane, DuplicateInstanceError } from '../index.js'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { handle } from '../src/server.mjs'

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-create-'))
  const store = openStore(dataDir)
  const plane = createPlane({ dataDir, store, backend: new MemoryBackend() })
  const tokenA = mintOperatorToken(store, 'acct-a')
  const tokenB = mintOperatorToken(store, 'acct-b')
  const deps = { plane, store }
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return { dataDir, store, plane, tokenA, tokenB, deps, cleanup }
}

test('the same workspace and name twice is a DuplicateInstanceError and HTTP 409', async () => {
  const { plane, store, tokenA, cleanup } = setup()
  try {
    const first = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    assert.equal(first.workspaceId, 'ws-1')
    await assert.rejects(
      () => plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' }),
      { name: 'DuplicateInstanceError' },
    )
    assert.ok(new DuplicateInstanceError('ws-1', 'main') instanceof Error)
    const res = await handle(
      { method: 'POST', path: '/api/instances', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ workspaceId: 'ws-1', name: 'main' }) },
      { plane, store },
    )
    assert.equal(res.status, 409)
  } finally {
    cleanup()
  }
})

test('two owners may each use the same workspace and name (per-owner uniqueness)', async () => {
  const { plane, cleanup } = setup()
  try {
    const a = await plane.createInstance({ workspaceId: 'ws-shared', name: 'main', ownerId: 'acct-a' })
    const b = await plane.createInstance({ workspaceId: 'ws-shared', name: 'main', ownerId: 'acct-b' })
    assert.notEqual(a.id, b.id)
    assert.equal(plane.listInstances('acct-a').length, 1)
    assert.equal(plane.listInstances('acct-b').length, 1)
  } finally {
    cleanup()
  }
})

test('instance metadata survives reopening the store', async () => {
  const { dataDir, plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'durable', ownerId: 'acct-a' })
    const reopened = openStore(dataDir)
    const again = reopened.getInstance(created.id)
    assert.ok(again)
    assert.equal(again.name, 'durable')
    assert.equal(again.ownerId, 'acct-a')
    assert.equal(again.workspaceId, 'ws-1')
    assert.equal(again.state, 'stopped')
    assert.equal(reopened.getWorkspace('ws-1').ownerId, 'acct-a')
  } finally {
    cleanup()
  }
})

test('creating without a name or a workspaceId is HTTP 400', async () => {
  const { plane, store, tokenA, cleanup } = setup()
  try {
    const noName = await handle(
      { method: 'POST', path: '/api/instances', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ workspaceId: 'ws-1' }) },
      { plane, store },
    )
    assert.equal(noName.status, 400)
    const noWorkspace = await handle(
      { method: 'POST', path: '/api/instances', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ name: 'main' }) },
      { plane, store },
    )
    assert.equal(noWorkspace.status, 400)
  } finally {
    cleanup()
  }
})

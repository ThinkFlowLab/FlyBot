import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane, NotImplementedError } from '../index.js'
import { ComposeBackend, MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { handle } from '../src/server.mjs'

function setup(backend = new MemoryBackend()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-life-'))
  const store = openStore(dataDir)
  const plane = createPlane({ dataDir, store, backend })
  const token = mintOperatorToken(store, 'acct-a')
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return { dataDir, store, plane, token, backend, cleanup }
}

test('start makes the instance running and healthy', async () => {
  const { plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    assert.equal(created.state, 'stopped')
    const started = await plane.startInstance(created.id)
    assert.equal(started.state, 'running')
    assert.equal(started.health, 'ok')
    assert.equal(plane.getInstance(created.id).state, 'running')
  } finally {
    cleanup()
  }
})

test('stop records stopped, and a fresh store does not resurrect it as running', async () => {
  const { dataDir, plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    await plane.startInstance(created.id)
    const stopped = await plane.stopInstance(created.id)
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.health, 'unknown')

    const reopened = openStore(dataDir)
    const plane2 = createPlane({ dataDir, store: reopened, backend: new MemoryBackend() })
    assert.equal(plane2.getInstance(created.id).state, 'stopped')
  } finally {
    cleanup()
  }
})

test('stop then start again returns to running (the lifecycle loop)', async () => {
  const { plane, cleanup } = setup()
  try {
    const created = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
    await plane.startInstance(created.id)
    await plane.stopInstance(created.id)
    const again = await plane.startInstance(created.id)
    assert.equal(again.state, 'running')
    assert.equal(again.health, 'ok')
  } finally {
    cleanup()
  }
})

test('an unknown instance id is HTTP 404 for a valid operator', async () => {
  const { plane, store, token, cleanup } = setup()
  try {
    const res = await handle(
      { method: 'GET', path: '/api/instances/inst_missing', headers: { authorization: `Bearer ${token}` }, body: '' },
      { plane, store },
    )
    assert.equal(res.status, 404)
  } finally {
    cleanup()
  }
})

test('upgrade and recycle are explicit NotImplementedError in this slice', async () => {
  const composeDir = mkdtempSync(join(tmpdir(), 'plane-compose-'))
  try {
    for (const backend of [new MemoryBackend(), new ComposeBackend({ instancesDir: composeDir })]) {
      await assert.rejects(() => backend.upgrade({ id: 'inst_x' }), { name: 'NotImplementedError' })
      await assert.rejects(() => backend.recycle({ id: 'inst_x' }), { name: 'NotImplementedError' })
    }
    assert.ok(new NotImplementedError('upgrade') instanceof Error)
  } finally {
    rmSync(composeDir, { recursive: true, force: true })
  }
})

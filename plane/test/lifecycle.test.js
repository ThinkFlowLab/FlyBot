// #3113 red-first, lifecycle: create → start → query → stop → start again is the loop this slice
// exists for. State lives in the store, so a "process restart" (a fresh handle reading the same
// data dir) still sees `stopped` — nothing silently flips back to running. `upgrade` and
// `recycle` are part of the backend contract on purpose, and refusing them loudly beats a silent
// success that pretends the second slice already shipped.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryBackend, NotImplementedError } from '../src/lifecycle.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { openStore } from '../src/store.mjs'
import { handle } from '../src/server.mjs'
import { createPlane } from '../index.js'

const auth = token => ({ authorization: `Bearer ${token}` })

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'plane-life-'))
  const dataDir = join(dir, 'data')
  const store = openStore(dataDir)
  const account = store.createAccount({ name: 'alice' })
  const ws = store.createWorkspace({ accountId: account.id, name: 'w' })
  const { instance } = store.createInstance({ workspaceId: ws.id, name: 'main' })
  const token = mintOperatorToken(store, account.id).token
  return { dir, dataDir, store, account, instance, token }
}

test('start reports running and healthy, through the route and the plane face', async () => {
  const s = seeded()
  try {
    const res = handle({ method: 'POST', path: `/api/instances/${s.instance.id}/start`, headers: auth(s.token), body: {} }, { store: s.store, backend: new MemoryBackend() })
    assert.equal(res.status, 200)
    assert.equal(res.body.instance.state, 'running')
    assert.equal(res.body.instance.health, 'ok')
    const plane = createPlane({ dataDir: s.dataDir, backend: new MemoryBackend() })
    const started = await plane.startInstance(s.instance.id)
    assert.equal(started.state, 'running')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('stop persists: a fresh reader of the same data dir still sees stopped', async () => {
  const s = seeded()
  try {
    const plane = createPlane({ dataDir: s.dataDir, backend: new MemoryBackend() })
    await plane.startInstance(s.instance.id)
    await plane.stopInstance(s.instance.id)
    const reopened = handle({ method: 'GET', path: `/api/instances/${s.instance.id}`, headers: auth(s.token), body: {} }, { store: openStore(s.dataDir), backend: new MemoryBackend() })
    assert.equal(reopened.status, 200)
    assert.equal(reopened.body.instance.state, 'stopped')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('stop then start runs again — the core loop of this slice', async () => {
  const s = seeded()
  try {
    const plane = createPlane({ dataDir: s.dataDir, backend: new MemoryBackend() })
    await plane.startInstance(s.instance.id)
    const stopped = await plane.stopInstance(s.instance.id)
    assert.equal(stopped.state, 'stopped')
    const again = await plane.startInstance(s.instance.id)
    assert.equal(again.state, 'running')
    assert.equal(again.health, 'ok')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('an unknown instance id answers 404', async () => {
  const s = seeded()
  try {
    const res = handle({ method: 'GET', path: '/api/instances/in_ffffffffffffffffffffffff', headers: auth(s.token), body: {} }, { store: s.store, backend: new MemoryBackend() })
    assert.equal(res.status, 404)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('upgrade and recycle refuse with NotImplementedError — the contract exists, the work does not', async () => {
  const s = seeded()
  try {
    const backend = new MemoryBackend()
    assert.throws(() => backend.upgrade(s.instance), NotImplementedError)
    assert.throws(() => backend.recycle(s.instance), NotImplementedError)
    const plane = createPlane({ dataDir: s.dataDir, backend })
    await assert.rejects(() => plane.upgradeInstance(s.instance.id), NotImplementedError)
    await assert.rejects(() => plane.recycleInstance(s.instance.id), NotImplementedError)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

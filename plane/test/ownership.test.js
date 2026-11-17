import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane } from '../index.js'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { handle } from '../src/server.mjs'

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-owner-'))
  const store = openStore(dataDir)
  const plane = createPlane({
    dataDir,
    store,
    backend: new MemoryBackend(),
    clock: () => Date.parse('2026-11-17T00:00:00.000Z'),
  })
  const tokenA = mintOperatorToken(store, 'acct-a')
  const tokenB = mintOperatorToken(store, 'acct-b')
  const b = await plane.createInstance({ workspaceId: 'ws-b', name: 'b-main', ownerId: 'acct-b' })
  await plane.startInstance(b.id)
  const deps = { plane, store }
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return { dataDir, store, plane, tokenA, tokenB, deps, b, cleanup }
}

function request(method, path, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return { method, path, headers, body: '' }
}

test('A operator token cannot read B instance: 403 and B state unchanged', async () => {
  const { tokenA, deps, b, cleanup } = await setup()
  try {
    const res = await handle(request('GET', `/api/instances/${b.id}`, tokenA), deps)
    assert.equal(res.status, 403)
    assert.deepEqual(res.body, { error: 'forbidden' })
    assert.equal(deps.plane.getInstance(b.id).state, 'running')
  } finally {
    cleanup()
  }
})

test('A operator token cannot stop B instance: 403 and B stays running', async () => {
  const { tokenA, deps, b, cleanup } = await setup()
  try {
    const res = await handle(request('POST', `/api/instances/${b.id}/stop`, tokenA), deps)
    assert.equal(res.status, 403)
    assert.equal(deps.plane.getInstance(b.id).state, 'running')
  } finally {
    cleanup()
  }
})

test('missing Authorization is 401 and a forged op_ token is 401', async () => {
  const { deps, b, cleanup } = await setup()
  try {
    const noAuth = await handle(request('GET', `/api/instances/${b.id}`), deps)
    assert.equal(noAuth.status, 401)
    const forged = await handle(request('GET', `/api/instances/${b.id}`, `op_${'0'.repeat(32)}`), deps)
    assert.equal(forged.status, 401)
  } finally {
    cleanup()
  }
})

test('GET /api/instances lists only the caller own instances', async () => {
  const { tokenA, tokenB, deps, plane, cleanup } = await setup()
  try {
    const a = await plane.createInstance({ workspaceId: 'ws-a', name: 'a-main', ownerId: 'acct-a' })
    const listA = await handle(request('GET', '/api/instances', tokenA), deps)
    assert.equal(listA.status, 200)
    assert.deepEqual(listA.body.instances.map((i) => i.id), [a.id])
    const listB = await handle(request('GET', '/api/instances', tokenB), deps)
    assert.equal(listB.status, 200)
    assert.equal(listB.body.instances.length, 1)
    assert.equal(listB.body.instances[0].id, deps.plane.listInstances('acct-b')[0].id)
    assert.ok(listB.body.instances.every((i) => i.ownerId === 'acct-b'))
  } finally {
    cleanup()
  }
})

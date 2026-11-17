// #3113 red-first, creation: a name is unique inside one workspace, not on the whole plane, the
// record survives a reopen, and a request without `name` or `workspaceId` is a 400 rather than an
// instance with holes in it. Case 5 drives the same rule through the store (`DuplicateInstanceError`)
// and through the HTTP route (409), so the route cannot silently widen what the store refuses.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { DuplicateInstanceError, openStore } from '../src/store.mjs'
import { handle } from '../src/server.mjs'
import { createPlane } from '../index.js'

const auth = token => ({ authorization: `Bearer ${token}` })

function oneWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'plane-create-'))
  const dataDir = join(dir, 'data')
  const store = openStore(dataDir)
  const account = store.createAccount({ name: 'alice' })
  const ws = store.createWorkspace({ accountId: account.id, name: 'w' })
  return { dir, dataDir, store, account, ws, token: mintOperatorToken(store, account.id).token }
}

test('the same (workspaceId, name) is refused twice: DuplicateInstanceError from the store, 409 from the route', async () => {
  const s = oneWorkspace()
  try {
    store_first: {
      s.store.createInstance({ workspaceId: s.ws.id, name: 'dup' })
      assert.throws(() => s.store.createInstance({ workspaceId: s.ws.id, name: 'dup' }), DuplicateInstanceError)
    }
    route_second: {
      // The store-level pair above already exists, so the route sees a duplicate too.
      const res = handle({ method: 'POST', path: '/api/instances', headers: auth(s.token), body: { workspaceId: s.ws.id, name: 'dup' } }, { store: s.store, backend: new MemoryBackend() })
      assert.equal(res.status, 409)
    }
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('two owners may each use the same name — the uniqueness is per workspace, not global', async () => {
  const s = oneWorkspace()
  try {
    const other = s.store.createAccount({ name: 'bob' })
    const otherWs = s.store.createWorkspace({ accountId: other.id, name: 'w' })
    const mine = s.store.createInstance({ workspaceId: s.ws.id, name: 'same-name' })
    const theirs = s.store.createInstance({ workspaceId: otherWs.id, name: 'same-name' })
    assert.notEqual(mine.instance.id, theirs.instance.id)
    assert.equal(mine.instance.ownerId, s.account.id)
    assert.equal(theirs.instance.ownerId, other.id)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('a reopened store still reads the instance metadata — plane.json is the record, not the memory', async () => {
  const s = oneWorkspace()
  try {
    const { instance } = s.store.createInstance({ workspaceId: s.ws.id, name: 'kept' })
    s.store.updateInstance(instance.id, { state: 'running', health: 'ok' })
    const again = openStore(s.dataDir)
    const read = again.getInstance(instance.id)
    assert.equal(read.name, 'kept')
    assert.equal(read.state, 'running')
    assert.equal(read.health, 'ok')
    assert.ok(read.createdAt > 0)
    // and the same through the public plane face
    const plane = createPlane({ dataDir: s.dataDir, backend: new MemoryBackend() })
    const got = await plane.getInstance(instance.id)
    assert.equal(got.name, 'kept')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('a create without name or without workspaceId answers 400, and nothing is stored', async () => {
  const s = oneWorkspace()
  try {
    const noName = handle({ method: 'POST', path: '/api/instances', headers: auth(s.token), body: { workspaceId: s.ws.id } }, { store: s.store, backend: new MemoryBackend() })
    assert.equal(noName.status, 400)
    const noWs = handle({ method: 'POST', path: '/api/instances', headers: auth(s.token), body: { name: 'orphan' } }, { store: s.store, backend: new MemoryBackend() })
    assert.equal(noWs.status, 400)
    assert.equal(s.store.listInstances({ ownerId: s.account.id }).length, 0)
    assert.doesNotThrow(() => readFileSync(join(s.dataDir, 'plane.json'), 'utf8'))
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

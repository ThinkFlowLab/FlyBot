// #3113 red-first, ownership: an operator token only reaches its own instances. Every instance
// route asks `verifyOperator` first, then compares `instance.ownerId` with the token's account,
// so account A never reads or stops account B's instance, and a stranger without a token is
// refused before any route runs. The store persists to a real temp dir, so these cases read the
// very bytes the seeding wrote.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { openStore } from '../src/store.mjs'
import { handle } from '../src/server.mjs'

async function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'plane-own-'))
  const store = openStore(join(dir, 'data'))
  const backend = new MemoryBackend()
  const alice = store.createAccount({ name: 'alice' })
  const bob = store.createAccount({ name: 'bob' })
  const wsA = store.createWorkspace({ accountId: alice.id, name: 'w' })
  const wsB = store.createWorkspace({ accountId: bob.id, name: 'w' })
  const a = store.createInstance({ workspaceId: wsA.id, name: 'a' }).instance
  const b = store.createInstance({ workspaceId: wsB.id, name: 'b' }).instance
  const aliceToken = mintOperatorToken(store, alice.id).token
  const bobToken = mintOperatorToken(store, bob.id).token
  store.updateInstance(b.id, { state: 'running', health: 'ok' })
  return { dir, store, backend, alice, bob, a, b, aliceToken, bobToken }
}

const auth = token => ({ authorization: `Bearer ${token}` })

test('another operator token reads a foreign instance as 403, and the instance is untouched', async () => {
  const s = await seed()
  try {
    const res = handle({ method: 'GET', path: `/api/instances/${s.b.id}`, headers: auth(s.aliceToken), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(res.status, 403)
    const again = handle({ method: 'GET', path: `/api/instances/${s.b.id}`, headers: auth(s.bobToken), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(again.status, 200)
    assert.equal(again.body.instance.state, 'running')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('another operator token stops a foreign instance as 403, and it stays running', async () => {
  const s = await seed()
  try {
    const res = handle({ method: 'POST', path: `/api/instances/${s.b.id}/stop`, headers: auth(s.aliceToken), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(res.status, 403)
    const again = handle({ method: 'GET', path: `/api/instances/${s.b.id}`, headers: auth(s.bobToken), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(again.body.instance.state, 'running')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('no Authorization header is 401, and so is a forged op_ token', async () => {
  const s = await seed()
  try {
    const anon = handle({ method: 'GET', path: `/api/instances/${s.b.id}`, headers: {}, body: {} }, { store: s.store, backend: s.backend })
    assert.equal(anon.status, 401)
    const forged = handle({ method: 'GET', path: `/api/instances/${s.b.id}`, headers: auth('op_00000000000000000000000000000000'), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(forged.status, 401)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('GET /api/instances lists only the caller\'s own instances', async () => {
  const s = await seed()
  try {
    const res = handle({ method: 'GET', path: '/api/instances', headers: auth(s.aliceToken), body: {} }, { store: s.store, backend: s.backend })
    assert.equal(res.status, 200)
    assert.equal(res.body.instances.length, 1)
    assert.equal(res.body.instances[0].id, s.a.id)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

// #3113 red-first, credentials: two token families that must never open each other's door. The
// operator token speaks to `/api/*`; the control token is what a FlyBot instance would check on
// a management call. Only sha256 sums are persisted — the plaintext exists once, at mint time —
// and every instance gets its own control token, so one leaked key is one instance, not the fleet.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { mintControlToken, mintOperatorToken, verifyControl, verifyOperator } from '../src/credentials.mjs'
import { openStore } from '../src/store.mjs'
import { handle } from '../src/server.mjs'

const auth = token => ({ authorization: `Bearer ${token}` })

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'plane-cred-'))
  const dataDir = join(dir, 'data')
  const store = openStore(dataDir)
  const account = store.createAccount({ name: 'alice' })
  const ws = store.createWorkspace({ accountId: account.id, name: 'w' })
  const first = store.createInstance({ workspaceId: ws.id, name: 'one' })
  const second = store.createInstance({ workspaceId: ws.id, name: 'two' })
  const token = mintOperatorToken(store, account.id).token
  return { dir, dataDir, store, account, ws, first, second, token }
}

test('a control token does not open the operator door: /api/* answers 401', async () => {
  const s = seeded()
  try {
    const res = handle({ method: 'GET', path: '/api/instances', headers: auth(s.first.controlToken), body: {} }, { store: s.store, backend: new MemoryBackend() })
    assert.equal(res.status, 401)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('an operator token is not a control credential either — the door holds from both sides', async () => {
  const s = seeded()
  try {
    assert.equal(verifyControl(s.first.instance, `Bearer ${s.token}`), false)
    assert.equal(verifyControl(s.first.instance, `Bearer ${s.first.controlToken}`), true)
    assert.equal(verifyOperator(s.store, `Bearer ${s.first.controlToken}`), null)
    assert.equal(verifyOperator(s.store, `Bearer ${s.token}`).accountId, s.account.id)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('plane.json holds hashes, never plaintext: no op_ or ctl_ string survives the save', async () => {
  const s = seeded()
  try {
    const text = readFileSync(join(s.dataDir, 'plane.json'), 'utf8')
    assert.ok(!/op_[0-9a-f]{32}/.test(text), 'operator plaintext leaked into plane.json')
    assert.ok(!/ctl_[0-9a-f]{32}/.test(text), 'control plaintext leaked into plane.json')
    assert.ok(/[0-9a-f]{64}/.test(text), 'no sha256 hash stored at all')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('two instances carry different control tokens — one key is one instance, not the fleet', async () => {
  const s = seeded()
  try {
    assert.notEqual(s.first.controlToken, s.second.controlToken)
    assert.notEqual(s.first.instance.controlTokenHash, s.second.instance.controlTokenHash)
    assert.equal(verifyControl(s.first.instance, `Bearer ${s.second.controlToken}`), false)
    const fresh = mintControlToken()
    assert.match(fresh.token, /^ctl_[0-9a-f]{32}$/)
    assert.match(s.token, /^op_[0-9a-f]{32}$/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

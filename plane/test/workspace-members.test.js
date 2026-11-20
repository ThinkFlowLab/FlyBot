import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlane } from '../index.js'
import { MemoryBackend } from '../src/lifecycle.mjs'
import { openStore } from '../src/store.mjs'
import { mintOperatorToken } from '../src/credentials.mjs'
import { handle } from '../src/server.mjs'

const AT = '2026-11-18T00:00:00.000Z'
const PATH = '/api/workspaces/ws-1/members'
const MEMBERS = (res) => res.body.members.map((member) => member.accountId)

function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-members-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = openStore(dataDir)
  const plane = createPlane({ dataDir, store, backend: new MemoryBackend(), clock: () => Date.parse(AT) })
  const tokens = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((name) => [`acct-${name}`, mintOperatorToken(store, `acct-${name}`)]),
  )
  const req = (method, path, token, body) =>
    handle({ method, path, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? '' : JSON.stringify(body) }, { plane, store })
  return { plane, tokens, req }
}

test('a workspace member list has its creator as the only owner (#3117)', async (t) => {
  const { plane, tokens, req } = setup(t)
  await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
  const res = await req('GET', PATH, tokens['acct-a'])
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.members, [{ accountId: 'acct-a', role: 'owner', addedAt: AT }])
})

test('two owners with the same workspace id never read or write each others members (#3117)', async (t) => {
  const { plane, tokens, req } = setup(t)
  await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
  await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-b' })
  assert.equal((await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-c', role: 'member' })).status, 201)
  assert.deepEqual(MEMBERS(await req('GET', PATH, tokens['acct-a'])), ['acct-a', 'acct-c'])
  assert.deepEqual(MEMBERS(await req('GET', PATH, tokens['acct-b'])), ['acct-b'])
  assert.deepEqual(MEMBERS(await req('GET', PATH, tokens['acct-c'])), ['acct-a', 'acct-c'])
  const outsider = await req('GET', PATH, tokens['acct-d'])
  assert.deepEqual([outsider.status, outsider.body], [403, { error: 'forbidden' }])
  assert.equal((await req('POST', PATH, tokens['acct-b'], { accountId: 'acct-d', role: 'member' })).status, 201)
  assert.deepEqual(MEMBERS(await req('GET', PATH, tokens['acct-a'])), ['acct-a', 'acct-c'])
})

test('an owner adds a member, who can then read the list (#3117)', async (t) => {
  const { plane, tokens, req } = setup(t)
  await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
  const added = await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-b', role: 'member' })
  assert.equal(added.status, 201)
  assert.deepEqual(added.body.member, { accountId: 'acct-b', role: 'member', addedAt: AT })
  assert.deepEqual(MEMBERS(await req('GET', PATH, tokens['acct-b'])), ['acct-a', 'acct-b'])
  const again = await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-b', role: 'admin' })
  assert.deepEqual([again.status, again.body], [409, { error: 'member_exists' }])
  const noRole = await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-c', role: 'root' })
  assert.deepEqual([noRole.status, noRole.body], [400, { error: 'invalid_role' }])
  const noAccount = await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-zz', role: 'member' })
  assert.deepEqual([noAccount.status, noAccount.body], [404, { error: 'account_not_found' }])
  const noWorkspace = await req('GET', '/api/workspaces/ws-nope/members', tokens['acct-a'])
  assert.deepEqual([noWorkspace.status, noWorkspace.body], [404, { error: 'workspace_not_found' }])
})

test('an admin may add a member; a plain member may not (#3117)', async (t) => {
  const { plane, tokens, req } = setup(t)
  await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-a' })
  assert.equal((await req('POST', PATH, tokens['acct-a'], { accountId: 'acct-b', role: 'admin' })).status, 201)
  const asAdmin = await req('POST', PATH, tokens['acct-b'], { accountId: 'acct-c', role: 'member' })
  assert.deepEqual([asAdmin.status, asAdmin.body.member?.role], [201, 'member'])
  const asMember = await req('POST', PATH, tokens['acct-c'], { accountId: 'acct-d', role: 'member' })
  assert.deepEqual([asMember.status, asMember.body], [403, { error: 'forbidden' }])
})

test('a plane.json from before members loads with its owner as the only member (#3117)', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plane-old-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const old = { version: 1, accounts: [], workspaces: [{ id: 'ws-old', ownerId: 'acct-a', createdAt: AT }], instances: [] }
  writeFileSync(join(dataDir, 'plane.json'), JSON.stringify(old))
  assert.deepEqual(openStore(dataDir).getWorkspace('ws-old', 'acct-a').members, [
    { accountId: 'acct-a', role: 'owner', addedAt: AT },
  ])
})

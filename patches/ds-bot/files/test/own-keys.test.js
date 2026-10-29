// Host lookups that index a plain state table with a wire id (#1711). `table[id]` answers
// `Object.prototype` for `__proto__`, which a request can then write through — so an id that is
// not an own key must resolve as absent, and a refusal must not touch `Object.prototype`.
// The assertions read the prototype itself: `Object.hasOwn(Object.prototype, key)` and
// `key in {}`. `Object.hasOwn({}, key)` is false in the polluted state too, so it is no evidence.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'
import { install as installReach } from '../src/host/reach.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ownerId: 'owner-1' },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} } },
  agents: {},
  capabilities: {
    items: {
      echo: { name: 'echo', kind: 'mcp', description: 'Echo service', transport: 'stdio', command: 'node', args: [], env: {}, approved: true, createdAt: 1, updatedAt: 1 },
    },
  },
  tasks: {},
  projects: {},
  projectRuns: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  grants: {},
})

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-own-keys-'))) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  let route
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, saved, stop, home }
}

const value = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.value
}

// Reads the pollution a call left, then removes it so one red test cannot fail the next.
const leak = (key) => {
  const own = Object.hasOwn(Object.prototype, key)
  const written = Object.prototype[key]
  delete Object.prototype[key]
  return { own, written, inherited: key in {} }
}

const noLeak = (key, { own, written, inherited }) => {
  assert.equal(own, false, `Object.prototype has own '${key}' = ${JSON.stringify(written)} after the call`)
  assert.equal(inherited, false, `'${key}' in {} after the call`)
}

test('update-bot with a wire id writes nothing onto Object.prototype (#1711)', async () => {
  const { call, stop } = await start()
  try {
    const response = await call('update-bot', { id: '__proto__', role: 'Intruder' })
    noLeak('role', leak('role'))
    assert.equal(response.ok, false, `update-bot for '__proto__' must answer a refusal, got ${JSON.stringify(response)}`)
    assert.match(String(response.error?.message), /Unknown Bot/)

    // A real Bot still updates.
    assert.equal(value(await call('update-bot', { id: 'b', role: 'Editor' })).role, 'Editor')
  } finally { await stop() }
})

test('task-update with a wire id writes nothing onto Object.prototype (#1711)', async () => {
  const { call, stop } = await start()
  try {
    const response = await call('task-update', { id: '__proto__', title: 'Stolen title' })
    noLeak('title', leak('title'))
    assert.equal(response.ok, false, `task-update for '__proto__' must answer a refusal, got ${JSON.stringify(response)}`)

    // A real task still updates.
    const created = value(await call('task-create', { botId: 'b', title: 'Write it down' }))
    const updated = value(await call('task-update', { id: created.id, title: 'Write it down twice' }))
    assert.equal(updated.title, 'Write it down twice')
  } finally { await stop() }
})

test('capability-delete refuses a name that is not an own key (#1711)', async () => {
  const { call, stop } = await start()
  try {
    for (const name of ['__proto__', 'constructor']) {
      const response = await call('capability-delete', { name })
      assert.equal(response.ok, false, `capability-delete ${name} must answer a refusal, got ${JSON.stringify(response)}`)
      assert.match(String(response.error?.message), /No capability named/)
    }
    // A real capability still deletes.
    assert.equal(value(await call('capability-delete', { name: 'echo' })), true)
  } finally { await stop() }
})

test('set-main with a wire id is not a Main Bot and is not persisted (#1711)', async () => {
  const { call, saved, stop } = await start()
  try {
    const response = await call('set-main', { id: '__proto__', main: true })
    assert.equal(response.ok, false, `set-main for '__proto__' must answer a refusal, got ${JSON.stringify(response)}`)
    assert.match(String(response.error?.message), /Unknown Bot/)
    assert.deepEqual(saved().mainBotIds, ['a'], 'a wire id must not reach state.mainBotIds')

    // A real Bot still becomes a Main Bot.
    value(await call('set-main', { id: 'b', main: true }))
    assert.deepEqual(saved().mainBotIds, ['a', 'b'])
  } finally { await stop() }
})

test('set-flags with a wire id writes nothing onto Object.prototype (#1711)', async () => {
  const { call, stop } = await start()
  try {
    const response = await call('set-flags', { id: '__proto__', pinned: true })
    noLeak('pinned', leak('pinned'))
    assert.equal(response.ok, false, `set-flags for '__proto__' must answer a refusal, got ${JSON.stringify(response)}`)

    // A real conversation still takes its flags.
    assert.equal(value(await call('set-flags', { id: 'b', pinned: true })).pinned, true)
  } finally { await stop() }
})

// The member-auth and reach tables are written by the same wire ids (#1711, Security
// advisory follow-up): `state.invitations[id]` and `state.members[id]` answer
// `Object.prototype`, so a revoke lands `revokedAt` on the prototype and a remove answers
// `ok` for a member that does not exist; `state.grants[id]` writes the grants table.

const authHost = (members = { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } }) => {
  const state = { invitations: {}, authSessions: {}, members, bots: {} }
  const rt = { state, save: async () => {} }
  installMemberAuth(rt)
  return rt
}

test('auth-revoke-invite with a wire id writes nothing onto Object.prototype (#1711)', async () => {
  const rt = authHost()
  const response = await rt.revokeInvitation('__proto__')
  noLeak('revokedAt', leak('revokedAt'))
  assert.deepEqual(response, { ok: false, error: 'not_found' }, `revoke for '__proto__' must be not_found, got ${JSON.stringify(response)}`)

  // A real invitation still revokes.
  const invite = await rt.createInvitation()
  assert.deepEqual(await rt.revokeInvitation(invite.id), { ok: true })
})

test('auth-remove-member refuses a member id that is not an own key (#1711)', async () => {
  const rt = authHost({ 'owner-1': { id: 'owner-1' }, 'owner-2': { id: 'owner-2' } })
  const response = await rt.removeMember('__proto__')
  assert.deepEqual(response, { ok: false, error: 'not_found' }, `remove of '__proto__' must be not_found, got ${JSON.stringify(response)}`)
  assert.deepEqual(Object.keys(rt.state.members).sort(), ['owner-1', 'owner-2'])

  // A real member still removes.
  assert.deepEqual(await rt.removeMember('owner-2'), { ok: true })
})

test('setGrants with a wire id refuses instead of writing the grants table (#1711)', async () => {
  const state = { bots: { a: { id: 'a', name: 'Chief', ownerId: 'owner-1' } }, grants: {} }
  const rt = { state, save: async () => {}, reachChanged: async () => {}, refreshConnectorTools: () => {} }
  installReach(rt)
  let refused
  try { await rt.setGrants('__proto__', [{ grantee: '@friend.home' }]) } catch (error) { refused = error }
  assert.equal(refused?.code, 'bot/not-found', `grants for '__proto__' must be refused, got ${refused ? refused.message : 'a stored list'}`)
  assert.equal(Object.hasOwn(state.grants, '__proto__'), false)
  assert.equal(Object.getPrototypeOf(state.grants), Object.prototype, "the grants table must keep Object.prototype, not become the wire value")

  // A real Bot still stores its grants.
  assert.equal((await rt.setGrants('a', [{ grantee: '@friend.home' }])).length, 1)
})

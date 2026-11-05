// P-556: a save that replaces a linked `state.json` with a regular file does not move the team
// revision, so the count that tells a window about it has to ride every state answer — the
// `unchanged` one included. A window polling with `since` (the normal case) would otherwise never
// learn that its save left the linked file alone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installAuthz } from '../src/host/authz.js'
import { install } from '../src/host/channel.js'

function channel(stateLinkReplaced, { signedIn = false } = {}) {
  const routes = []
  const ctx = {
    effect: (execute) => {
      execute()
      return () => {}
    },
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    logger: { warn() {} },
  }
  const rt = {
    ctx,
    // A deployment that has seen a sign-in is the case that matters here: authz then narrows the live
    // part of the answer through its own `ownedLive` whitelist instead of passing everything on.
    state: {
      revision: 'r1',
      bots: {},
      rooms: {},
      members: signedIn ? { m1: { id: 'm1', displayName: 'Me' } } : {},
      authSessions: signedIn ? { token1: { memberId: 'm1' } } : {},
    },
    authenticate: async token => (signedIn && token === 'token1' ? { memberId: 'm1', displayName: 'Me' } : null),
    warn: () => {},
    noteFailure: () => {},
    refresh: async () => {},
    load: async () => {},
    bootstrap: async () => {},
    catalog: async () => {},
    loadSecrets: async () => {},
    readOnly: () => undefined,
    authorize: () => ({ ok: true }),
    activityView: () => ({}),
    busyAcksView: () => ({}),
    workView: () => ({}),
    roomWorkView: () => ({}),
    approvalsView: () => [],
    endedView: () => [],
    memoryNews: () => ({}),
    memoryReviews: () => [],
    connectorsView: () => [],
    capabilityStatusesView: () => ({}),
    ownedLive: (full) => full,
    pluginToolNames: () => [],
    stateLinkReplaced,
  }
  installAuthz(rt)
  install(rt)
  const call = async (endpoint, payload = {}) => (await routes[0].fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signedIn ? { 'x-flybot-member-session': 'token1' } : {}) },
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  return { call, rt }
}

test('P-556: an unchanged state answer still carries the count and the generation it belongs to', async () => {
  const { call } = channel(() => ({ gen: 'host-b', count: 2 }))
  const value = (await call('state', { since: 'r1' })).value
  assert.equal(value.unchanged, true, 'the same revision is answered as unchanged')
  assert.deepEqual(value.stateFileLinkReplaced, { gen: 'host-b', count: 2 },
    'the count rides the unchanged answer too, together with the process that made it')
})

test('P-556: a host that replaced no link answers 0 with its generation, never a missing field', async () => {
  const { call } = channel(() => ({ gen: 'host-a', count: 0 }))
  const value = (await call('state', { since: 'r1' })).value
  assert.deepEqual(value.stateFileLinkReplaced, { gen: 'host-a', count: 0 })
})

// A host that never installed the counter (an older build answered the same endpoint) must still
// answer a shape a client can read: no field at all would be a `undefined` the notice has to guess at.
test('P-556: a host with no counter answers the empty generation and zero', async () => {
  const { call } = channel(undefined)
  const value = (await call('state', { since: 'r1' })).value
  assert.deepEqual(value.stateFileLinkReplaced, { gen: '', count: 0 })
})

// Security, on review of the first tip: `channel.js` sends the live part through `rt.ownedLive(full,
// actor)`, and authz.js answers an explicit whitelist once anyone has signed in — a field it does not
// name never reaches the client, and the notice would silently never fire on any real deployment.
// This case drives that real whitelist: signed in, an actor resolved from the session header, and the
// count has to be in the answer with its generation.
test('P-556: a signed-in deployment still receives the count through the real ownedLive whitelist', async () => {
  const { call, rt } = channel(() => ({ gen: 'host-a', count: 3 }), { signedIn: true })
  assert.equal(rt.authzEnforced(), true, 'this case runs on a deployment where authz narrows the answer')
  const value = (await call('state', { since: 'r1' })).value
  assert.deepEqual(value.stateFileLinkReplaced, { gen: 'host-a', count: 3 },
    'the count and its generation survive the authz whitelist')
  assert.equal(value.unchanged, true, 'on the unchanged answer too, which is the one a poll gets')
})

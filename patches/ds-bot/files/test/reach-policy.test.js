// #90: per-Bot grants, the reach policy, and where it is enforced.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { hasAnyGrant, hasGrant, reach } from '../src/host/reach.js'

const bot = (id, ownerId, extra = {}) => ({ id, sessionId: id, name: id.toUpperCase(), instructions: '', createdAt: 1, ownerId, ...extra })

// Two owners, each with a Chief and a specialist. Reach-matrix tests that need a
// cross-owner hop add grants explicitly: the default is deny, Chief included (#90).
const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a', 'b'],
  members: {
    alice: { id: 'alice', createdAt: 1, designatedChiefId: 'a' },
    bob: { id: 'bob', createdAt: 1, designatedChiefId: 'b' },
  },
  bots: {
    a: bot('a', 'alice'),
    a2: bot('a2', 'alice'),
    b: bot('b', 'bob'),
    b2: bot('b2', 'bob'),
  },
  grants: {},
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

function grant(state, botId, grantee, extra = {}) {
  state.grants ??= {}
  state.grants[botId] = [...(state.grants[botId] ?? []), { id: `${botId}:${grantee}`, grantee, ...extra }]
}

async function start(t, { config = {}, state = team() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reach-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const calls = []
      agents.set(id, {
        session: { id, requestHeader: () => undefined }, id, calls, status: 'idle',
        followup(m) { calls.push(['followup', m]) }, steer(m) { calls.push(['steer', m]) },
        inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, ...config })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  const received = id => (agents.get(id)?.calls ?? []).map(([, m]) => m.content.map(b => b.text).join('\n'))
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, fb: rt.flybot, ctx, received, state: rt.state }
}

test('grants: false by default for every Bot, including the Chief; only an explicit grant opens access', () => {
  const s = team()
  assert.equal(hasAnyGrant(s, 'a'), false, 'the Chief has no grant until someone is invited')
  assert.equal(hasAnyGrant(s, 'a2'), false)
  grant(s, 'a', '@bob.home')
  grant(s, 'a2', '@bob.home')
  assert.equal(hasAnyGrant(s, 'a'), true)
  assert.equal(hasAnyGrant(s, 'a2'), true)
  assert.equal(hasGrant(s, 'a', '@coder.bob.home'), true, 'a home grant covers that home\'s Bots')
  assert.equal(hasGrant(s, 'a', '@eve.home'), false)
  s.grants.a = []
  delete s.grants.a2
  assert.equal(hasAnyGrant(s, 'a'), false)
  assert.equal(hasAnyGrant(s, 'a2'), false)
  assert.equal(hasAnyGrant(s, 'nobody'), false)
  grant(s, 'a', '@bob.home')
  delete s.members.alice
  assert.equal(hasAnyGrant(s, 'a'), false, 'a Bot whose owner left the team has no grants')
})

test('reach matrix: remote to local needs a grant on the target; local to remote needs a grant on the sender', () => {
  const s = team()
  const remote = { kind: 'remote', handle: '@coder.bob.home' }
  assert.equal(reach(s, { from: remote, to: 'a' }).action, 'deny', 'Chief is deny-by-default')
  grant(s, 'a', '@bob.home')
  assert.equal(reach(s, { from: remote, to: 'a' }).action, 'allow', 'a friend reaches a granted Chief directly')
  const denied = reach(s, { from: remote, to: 'a2' })
  assert.equal(denied.action, 'deny')
  assert.equal(denied.by, 'owner-policy')
  grant(s, 'a2', '@bob.home')
  assert.equal(reach(s, { from: remote, to: 'a2' }).action, 'allow', 'a granted specialist is reached without its Chief')
  assert.equal(reach(s, { from: 'a', to: remote }).action, 'allow')
  s.grants.a2 = []
  assert.equal(reach(s, { from: 'a2', to: remote }).action, 'deny')
  assert.equal(reach(s, { from: 'a2', to: '@coder.bob.home' }).action, 'deny', 'a plain handle is a remote address too')
  assert.equal(reach(s, { from: remote, to: remote }).action, 'deny')
  assert.equal(reach(s, { from: undefined, to: 'a2' }).action, 'allow', 'the owner and the system have no sender Bot')
  assert.equal(reach(s, { from: remote, to: 'nobody' }).action, 'allow', 'an unknown target is refused where it is resolved')
})

test('reach matrix: other owners reach only granted Bots, never through the Chief; same owner is free', () => {
  const s = team()
  grant(s, 'a', 'bob')
  grant(s, 'b', 'alice')
  assert.equal(reach(s, { from: 'a', to: 'b' }).action, 'allow')
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'deny')
  assert.equal(reach(s, { from: 'a2', to: 'b' }).action, 'deny', 'the sender must have a grant too')
  assert.equal(reach(s, { from: 'a2', to: 'a' }).action, 'allow', 'one owner\'s Bots talk freely')
  grant(s, 'b2', 'alice')
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'allow', 'a granted non-Chief is reached directly')
  assert.equal(reach(s, { from: 'a2', to: 'b2' }).action, 'deny')
  assert.equal(reach(s, { from: 'b2', to: 'a2' }).action, 'deny')
  s.grants.b2 = []
  s.members.bob.designatedChiefId = 'b2'
  assert.equal(reach(s, { from: 'a', to: 'b' }).action, 'allow', 'replacing the Chief does not move the grant')
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'deny', 'the new Chief has no grant')
  grant(s, 'b2', 'alice')
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'allow')
  delete s.members.bob
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'deny')
})

test('reach matrix: a room member may message a friend\'s Bot that already sits in that room', () => {
  const s = team()
  grant(s, 'a', '@carol.home')
  s.rooms.r = {
    id: 'r', members: ['a'], participants: [
      { kind: 'human', id: 'alice', role: 'admin', joinedSeq: 0 },
      { kind: 'bot', id: 'a', role: 'admin', joinedSeq: 0 },
      { kind: 'bot', remote: true, handle: '@coder.bob.home', joinedSeq: 0 },
    ],
  }
  const remote = { kind: 'remote', handle: '@coder.bob.home' }
  assert.equal(reach(s, { from: 'a', to: remote }).action, 'deny', 'outside the room it still needs a grant to that friend')
  assert.equal(reach(s, { from: 'a', to: remote, roomId: 'r' }).action, 'allow')
  assert.equal(reach(s, { from: 'a', to: { kind: 'remote', handle: '@eve.home' }, roomId: 'r' }).action, 'deny')
})

test('reach matrix: a code-joined Bot is reachable inside its room only, while a member', () => {
  const s = team()
  grant(s, 'a', 'bob')
  s.rooms.r = {
    id: 'r', members: ['a', 'b2'], participants: [
      { kind: 'human', id: 'alice', role: 'admin', joinedSeq: 0 },
      { kind: 'bot', id: 'a', role: 'admin', joinedSeq: 0 },
      { kind: 'bot', id: 'b2', role: 'member', joinedSeq: 0, viaCode: true },
    ],
  }
  assert.equal(reach(s, { from: 'a', to: 'b2' }).action, 'deny', 'outside the room it is unreachable')
  assert.equal(reach(s, { from: 'a', to: 'b2', roomId: 'r' }).action, 'allow')
  assert.equal(reach(s, { from: 'b2', to: 'a', roomId: 'r' }).action, 'allow')
  assert.equal(reach(s, { from: 'b2', to: 'a', roomId: 'other' }).action, 'deny')
  assert.equal(reach(s, { from: 'b2', to: { kind: 'remote', handle: '@coder.bob.home' }, roomId: 'r' }).action, 'allow')
  assert.equal(reach(s, { from: 'b2', to: { kind: 'remote', handle: '@coder.bob.home' } }).action, 'deny')
  s.rooms.r.participants[2].leftSeq = 3
  s.rooms.r.members = ['a']
  assert.equal(reach(s, { from: 'a', to: 'b2', roomId: 'r' }).action, 'deny', 'after it leaves it is unreachable again')
})

test('bot.send: the policy runs before the chain, and no allow or bypass verdict skips it', async (t) => {
  const state = team()
  grant(state, 'a', 'bob')
  grant(state, 'b', 'alice')
  const { fb, received } = await start(t, { state, config: { flybot: { bypass: { greedy: ['owner-policy', 'social'] } } } })
  const seen = []
  fb.bot.send.use({ name: 'greedy', priority: 100, handle: (m) => { seen.push(m.to); return { action: 'allow', bypass: ['owner-policy', 'social'] } } })
  const denied = await fb.bot.send({ from: 'a', to: 'b2', text: 'hello specialist' })
  assert.equal(denied.action, 'deny')
  assert.equal(denied.by, 'owner-policy')
  assert.deepEqual(seen, [], 'the chain never saw it')
  assert.deepEqual(received('b2'), [])
  const ok = await fb.bot.send({ from: 'a', to: 'b', text: 'hello chief' })
  assert.equal(ok.action, 'allow')
  assert.equal(seen.length, 1)
  assert.match(received('b')[0], /hello chief/)
})

test('message_bot of another owner\'s ungranted Bot is refused; a grant opens the way', async (t) => {
  const state = team()
  grant(state, 'a', 'bob')
  grant(state, 'b', 'alice')
  const { fb, rt, received } = await start(t, { state })
  assert.equal((await fb.bot.send({ from: 'a', to: 'b2', text: 'one' })).action, 'deny')
  await rt.setGrants('b2', [{ grantee: 'alice' }])
  assert.equal((await fb.bot.send({ from: 'a', to: 'b2', text: 'two' })).action, 'allow')
  assert.match(received('b2')[0], /two/)
  await rt.setGrants('b2', [])
  assert.equal((await fb.bot.send({ from: 'a', to: 'b2', text: 'three' })).action, 'deny')
  assert.equal(received('b2').length, 1)
})

test('remote senders reach granted Bots only', async (t) => {
  const state = team()
  grant(state, 'a', '@bob.home')
  const { fb, rt, received } = await start(t, { state })
  const friend = { kind: 'remote', handle: '@coder.bob.home', name: 'Coder' }
  assert.equal((await fb.bot.send({ from: friend, to: 'a2', text: 'hi spec' })).action, 'deny')
  assert.deepEqual(received('a2'), [])
  assert.equal((await fb.bot.send({ from: friend, to: 'a', text: 'hi chief' })).action, 'allow')
  await rt.setGrants('a2', [{ grantee: '@bob.home' }])
  assert.equal((await fb.bot.send({ from: friend, to: 'a2', text: 'hi again' })).action, 'allow')
  assert.match(received('a2')[0], /hi again/)
})

test('an ungranted Bot cannot message a friend\'s Bot; a granted one can', async (t) => {
  const { fb, rt } = await start(t)
  const out = []
  fb.transports.add('bot-social', { send: async msg => { out.push(msg.to.handle); return { exchangeId: `r${out.length}` } } })
  const remote = { kind: 'remote', handle: '@coder.bob.home' }
  assert.equal((await fb.bot.send({ from: 'a2', to: remote, text: 'x' })).action, 'deny')
  assert.deepEqual(out, [])
  assert.equal((await fb.bot.send({ from: 'a', to: remote, text: 'y' })).action, 'deny')
  await rt.setGrants('a', [{ grantee: '@bob.home' }])
  assert.equal((await fb.bot.send({ from: 'a', to: remote, text: 'y' })).action, 'allow')
  await rt.setGrants('a2', [{ grantee: '@bob.home' }])
  assert.equal((await fb.bot.send({ from: 'a2', to: remote, text: 'z' })).action, 'allow')
  assert.equal(out.length, 2)
})

test('a held message is judged again when it is approved: revoke while it waited means refused', async (t) => {
  const state = team()
  grant(state, 'a', 'bob')
  grant(state, 'b2', 'alice')
  const { fb, rt, received } = await start(t, { state })
  fb.bot.send.use({ name: 'hold-all', handle: () => ({ action: 'hold', reason: 'check' }) })
  const sent = await fb.bot.send({ from: 'a', to: 'b2', text: 'held plan' })
  assert.equal(sent.action, 'hold')
  await rt.setGrants('b2', [])
  const decided = await fb.approvals.decide(sent.approvalId, 'approve')
  assert.equal(decided.status, 'denied')
  assert.match(decided.error, /not been granted/)
  assert.deepEqual(received('b2'), [])
})

test('resumed, retried, deferred and re-sent deliveries are judged by what is true now', async (t) => {
  const state = team()
  grant(state, 'a', 'bob')
  const { rt, received } = await start(t, { state })
  const flags = [['resumed', 'x1'], ['retried', 'x2'], ['deferred', 'x3'], ['resent', 'x4']]
  for (const [flag, id] of flags) {
    await rt.deliver({ fromId: 'a', toId: 'b2', role: 'request', text: `${flag} while ungranted`, exchangeId: id, [flag]: true })
  }
  assert.deepEqual(received('b2'), [], 'none of the flagged paths gets around the policy')
  await rt.setGrants('b2', [{ grantee: 'alice' }])
  for (const [flag, id] of flags) {
    await rt.deliver({ fromId: 'a', toId: 'b2', role: 'request', text: `${flag} after granting`, exchangeId: `${id}-ok`, [flag]: true })
  }
  assert.equal(received('b2').length, 4)
  await rt.deliver({ fromId: 'a', toId: 'a2', role: 'request', text: 'same owner', resumed: true })
  assert.match(received('a2')[0], /same owner/)
})

test('a plain delivery from a remote sender to an ungranted Bot is refused', async (t) => {
  const state = team()
  grant(state, 'a', '@bob.home')
  const { rt, received } = await start(t, { state })
  await rt.deliver({ toId: 'a2', role: 'request', text: 'hi', remote: { handle: '@coder.bob.home', name: 'Coder' }, untrusted: true, resumed: true })
  assert.deepEqual(received('a2'), [])
  await rt.deliver({ toId: 'a', role: 'request', text: 'hi chief', remote: { handle: '@coder.bob.home', name: 'Coder' }, untrusted: true, resumed: true })
  assert.match(received('a')[0], /hi chief/)
})

test('setGrants: validates, empty list revokes, emits bot.grants, and is the owner\'s list', async (t) => {
  const { fb, rt } = await start(t)
  const events = []
  fb.on('bot.grants', bot => events.push([bot.id, bot.granted]))
  assert.equal(fb.bot.get('a').granted, false)
  assert.equal(fb.bot.get('a2').granted, false)
  assert.equal(fb.bot.hasAnyGrant('a'), false)
  assert.equal(fb.bot.hasGrant('a', '@x.y'), false)
  await rt.setGrants('a2', [{ grantee: '@bob.home', name: 'Bob' }])
  await rt.setGrants('a2', [{ grantee: '@bob.home', name: 'Bob' }])
  assert.equal(fb.bot.hasAnyGrant('a2'), true)
  assert.equal(fb.bot.hasGrant('a2', '@coder.bob.home'), true)
  await rt.setGrants('a2', [])
  assert.equal(fb.bot.hasAnyGrant('a2'), false)
  assert.deepEqual(events, [['a2', true], ['a2', false]])
  await assert.rejects(rt.setGrants('a2', 'yes'), /grants must be an array/)
  await assert.rejects(rt.setGrants('nobody', []), /Unknown Bot/)
  await assert.rejects(rt.setGrants('a2', [{ }]), /grantee/)
})

test('replacing the designated Chief does not grant the new one', async (t) => {
  const solo = team()
  delete solo.members.bob
  solo.bots.b.ownerId = 'alice'
  solo.bots.b2.ownerId = 'alice'
  solo.mainBotIds = ['a']
  const { fb, rt, state } = await start(t, { state: solo })
  const events = []
  fb.on('bot.grants', bot => events.push([bot.id, bot.granted]))
  assert.equal(fb.bot.hasAnyGrant('a'), false)
  state.mainBotIds = ['a2']
  assert.equal(rt.syncDesignatedChief(), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fb.bot.hasAnyGrant('a2'), false)
  assert.equal(fb.bot.hasAnyGrant('a'), false)
  assert.deepEqual(events, [])
})

// Context sharing (#53): private context crosses owners only through an explicit,
// owner-granted share. A member's group brief is its owner's own chat; another
// owner's chat lines, folders and chat references never ride into a shared room
// without that share. Alice and Bob are two signed-in members on the #48/#49
// foundation; team mode stays disabled.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: 'd' },
  },
  bots: {
    a: { id: 'a', name: 'ChiefA', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1', workDir: '/tmp/alice-private', instructions: 'Alice secret instructions' },
    d: { id: 'd', name: 'ChiefB', role: 'Boss', sessionId: 'd', createdAt: 2, ownerId: 'owner-2', workDir: '/tmp/bob-private', instructions: 'Bob secret instructions' },
    s: { id: 's', name: 'Writer', role: 'Write', sessionId: 's', createdAt: 3, ownerId: 'owner-1', createdBy: 'a', workDir: '/tmp/writer-private', instructions: 'Writer secret instructions' },
    r: { id: 'r', name: 'Researcher', role: 'Research', sessionId: 'r', createdAt: 4, ownerId: 'owner-1', createdBy: 'a', workDir: '/tmp/research-private', instructions: 'Research secret instructions' },
    e: { id: 'e', name: 'PrivateB', role: 'Hide', sessionId: 'e', createdAt: 5, ownerId: 'owner-2', workDir: '/tmp/bob-hidden', instructions: 'Bob hidden instructions' },
  },
  rooms: {
    war: {
      id: 'war', name: 'War', members: ['a', 'd'], admin: 'a', mode: 'everyone', named: true, sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'human', id: 'owner-2', role: 'member', displayName: 'Bob', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'd', role: 'member', displayName: 'ChiefB', joinedSeq: 0, joinedAt: 1 },
      ],
    },
    home: {
      id: 'home', name: 'Home', members: ['a'], admin: 'a', mode: 'everyone', named: true, sessions: {}, log: [], seq: 0, seen: {},
      participants: [
        { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
        { kind: 'bot', id: 'a', role: 'admin', displayName: 'ChiefA', joinedSeq: 0, joinedAt: 1 },
      ],
    },
  },
  grants: { a: [{ id: 'g1', grantee: 'owner-2' }], d: [{ id: 'g2', grantee: 'owner-1' }], s: [{ id: 'g3', grantee: 'owner-2' }] },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t, config = {}) {
  const home = config.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-context-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(config.state ?? team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls, status: 'idle',
        followup(m) { calls.push(m) }, steer(m) { calls.push(m) },
        inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${(++created).toString(36)}` }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let created = 0
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path.endsWith('bot')) route = options
    return register(options)
  }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload, token) => {
    const headers = token ? { 'x-flybot-member-session': token } : undefined
    return (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  const signIn = async (displayName, inviterToken) => {
    const invite = await call('auth-invite', {}, inviterToken)
    assert.equal(invite.ok, true, JSON.stringify(invite))
    const redeemed = await call('auth-redeem', { token: invite.value.token, displayName })
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed))
    return redeemed.value
  }
  // Drive the round's state machine: every member Session that has taken its first
  // message replies at once, so the next member is called until nobody is waiting.
  const roundTurns = new Map()
  const memberIds = () => [...agents.keys()].filter(id => id.startsWith('s'))
  const drive = (id) => {
    const message = agents.get(id).calls.at(-1)
    const turn = (roundTurns.get(id) ?? 0) + 1
    roundTurns.set(id, turn)
    emit(id, 'turn/start', { turn })
    emit(id, 'user/message', { content: message.content, source: message.source })
    emit(id, 'assistant/message', { message: { content: [{ type: 'text', text: 'noted' }] } })
    emit(id, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  const runRound = async (roomId, expected) => {
    emit(roomId, 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, roomId, { callId: 'c1', signal: stop.signal }).catch(() => {})
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const pending = memberIds().filter(id => agents.get(id).calls.length > 0 && !roundTurns.has(id))
      for (const id of pending) drive(id)
      if (memberIds().length >= expected && memberIds().every(id => roundTurns.has(id))) break
      await new Promise(resolve => setImmediate(resolve))
    }
    return memberIds().map(id => textOf(agents.get(id).calls[0]))
  }
  return { ctx, call, emit, tool, agentOf, signIn, home, runRound }
}

const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')

test('a member brings no private brief into a room where another owner sits', async (t) => {
  const { runRound, signIn } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const turns = await runRound('war', 2)
  assert.equal(turns.length, 2, 'both members took their first turn')
  for (const first of turns) {
    assert.ok(!first.includes('Your own chat with the user'), 'no own-chat brief rides into a cross-owner room')
    assert.ok(!first.includes('ALICES-PRIVATE'), 'no private marker')
  }
  void alice
})

test('the owner can share the brief with one room, and take it back', async (t) => {
  const { call, runRound, signIn, home } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const shared = await call('share-brief', { id: 'war', botId: 'a', share: true }, alice.sessionToken)
  assert.equal(shared.ok, true, JSON.stringify(shared))
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.war.participants.find(p => p.id === 'a').briefShared, true)

  const turns = await runRound('war', 2)
  const aliceBot = turns.find(first => first.includes('Members: the user, ChiefB'))
  const bobBot = turns.find(first => first.includes('Members: the user, ChiefA'))
  assert.ok(aliceBot, 'ChiefA took its turn')
  assert.ok(bobBot, 'ChiefB took its turn')
  assert.ok(aliceBot.includes('Your own chat with the user'), 'the owner shared the brief, so it rides along')
  assert.ok(!bobBot.includes('Your own chat with the user'), "Bob's brief still stays home")

  const revoked = await call('share-brief', { id: 'war', botId: 'a', share: false }, alice.sessionToken)
  assert.equal(revoked.ok, true, JSON.stringify(revoked))
  const after = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(after.rooms.war.participants.find(p => p.id === 'a').briefShared, undefined)
})

test('only the Bot\'s owner may share its brief', async (t) => {
  const { call, signIn } = await start(t)
  const alice = await signIn('Alice')
  const bob = await signIn('Bob', alice.sessionToken)
  const foreign = await call('share-brief', { id: 'war', botId: 'a', share: true }, bob.sessionToken)
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error.code, 'bot/forbidden', JSON.stringify(foreign))
  void alice
})

test('a single-owner room keeps the brief without any share', async (t) => {
  const { runRound, signIn } = await start(t)
  const alice = await signIn('Alice')
  void alice
  const turns = await runRound('home', 1)
  assert.ok(turns[0]?.includes('Your own chat with the user'), 'own room keeps the shipped brief')
})

test('list_bots hides another owner\'s folder and instructions', async (t) => {
  const { tool, signIn } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const seen = await tool('list_bots', {}, 'a')
  assert.ok(seen.includes('ChiefB'), 'a Bot granted to this owner is still listed')
  assert.ok(!seen.includes('PrivateB'), 'an ungranted Bot of another owner is hidden')
  assert.ok(!seen.includes('/tmp/bob-private'), 'no folder disclosure')
  assert.ok(!seen.includes('/tmp/bob-hidden'), 'no hidden-bot folder disclosure')
  assert.ok(!seen.includes('Bob secret instructions'), 'no instructions disclosure')
  assert.ok(!seen.includes('Bob hidden instructions'), 'no hidden-bot instructions disclosure')
  assert.ok(seen.includes('/tmp/alice-private'), 'own folder still shows')
  assert.ok(seen.includes('Alice secret instructions'), 'own instructions still show')
})

test('a granted child does not dump its owner\'s roster or siblings\' setup', async (t) => {
  const { tool, signIn } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const seen = await tool('list_bots', {}, 's')
  assert.ok(seen.includes('Writer'), 'the granted child lists itself')
  assert.ok(!seen.includes('Researcher'), 'a sibling outside the child\'s subtree stays off the list')
  assert.ok(!seen.includes('ChiefA'), 'the owner\'s Chief is not this child\'s to list')
  assert.ok(!seen.includes('/tmp/research-private'), 'sibling folder stays private')
  assert.ok(!seen.includes('Research secret instructions'), 'sibling instructions stay private')
  assert.ok(!seen.includes('/tmp/alice-private'), 'the Chief\'s folder stays private')
  assert.ok(seen.includes('/tmp/writer-private'), 'the child\'s own folder still shows')
  assert.ok(seen.includes('Writer secret instructions'), 'the child\'s own instructions still show')
  void alice
})

test('a chat reference chip must name a chat the author may read', async (t) => {
  const { call, signIn } = await start(t)
  const alice = await signIn('Alice')
  const bob = await signIn('Bob', alice.sessionToken)
  const foreign = await call('room-post', { id: 'war', text: 'look at @[that](dsh-session:d) please' }, alice.sessionToken)
  assert.equal(foreign.ok, false, JSON.stringify(foreign))
  assert.equal(foreign.error.code, 'bot/forbidden')
  const own = await call('room-post', { id: 'war', text: 'look at @[this](dsh-session:a) please' }, alice.sessionToken)
  assert.equal(own.ok, true, JSON.stringify(own))
  void bob
})

test('answer-question and schedule-create chips must name a chat the author may read', async (t) => {
  const state = team()
  state.questions.a = { id: 'q1', question: 'What next?', options: [{ label: 'Go' }], callId: 'c1' }
  const { call, signIn } = await start(t, { state })
  const alice = await signIn('Alice')
  const bob = await signIn('Bob', alice.sessionToken)
  const foreignAnswer = await call('answer-question', {
    sessionId: 'a', questionId: 'q1',
    answer: { custom: 'look at @[that](dsh-session:d) please' },
  }, alice.sessionToken)
  assert.equal(foreignAnswer.ok, false, JSON.stringify(foreignAnswer))
  assert.equal(foreignAnswer.error.code, 'bot/forbidden')
  const ownAnswer = await call('answer-question', {
    sessionId: 'a', questionId: 'q1',
    answer: { custom: 'look at @[this](dsh-session:a) please' },
  }, alice.sessionToken)
  assert.equal(ownAnswer.ok, true, JSON.stringify(ownAnswer))

  const foreignSchedule = await call('schedule-create', {
    target: 'a', title: 'Ping', prompt: 'look at @[that](dsh-session:d)',
    when: { kind: 'every', minutes: 30 },
  }, alice.sessionToken)
  assert.equal(foreignSchedule.ok, false, JSON.stringify(foreignSchedule))
  assert.equal(foreignSchedule.error.code, 'bot/forbidden')
  const ownSchedule = await call('schedule-create', {
    target: 'a', title: 'Ping', prompt: 'look at @[this](dsh-session:a)',
    when: { kind: 'every', minutes: 30 },
  }, alice.sessionToken)
  // Own chip is allowed through the author gate; automation may still be off in this host.
  if (ownSchedule.ok === false) assert.notEqual(ownSchedule.error.code, 'bot/forbidden', JSON.stringify(ownSchedule))
  void bob
})

test('answer-question and schedule-create accept menu-encoded session chips the author owns', async (t) => {
  // Menu chips encode JSON.stringify(sessionId) as base64url (`a` → ImEi).
  const ownEncoded = 'ImEi'
  const foreignEncoded = Buffer.from(JSON.stringify('d')).toString('base64url')
  const state = team()
  state.questions.a = { id: 'q1', question: 'What next?', options: [{ label: 'Go' }], callId: 'c1' }
  const { call, signIn } = await start(t, { state })
  const alice = await signIn('Alice')
  const ownAnswer = await call('answer-question', {
    sessionId: 'a', questionId: 'q1',
    answer: { custom: `look at @[this](dsh-session:${ownEncoded}) please` },
  }, alice.sessionToken)
  assert.equal(ownAnswer.ok, true, JSON.stringify(ownAnswer))
  const foreignSchedule = await call('schedule-create', {
    target: 'a', title: 'Ping', prompt: `look at @[that](dsh-session:${foreignEncoded})`,
    when: { kind: 'every', minutes: 30 },
  }, alice.sessionToken)
  assert.equal(foreignSchedule.ok, false, JSON.stringify(foreignSchedule))
  assert.equal(foreignSchedule.error.code, 'bot/forbidden')
  const ownSchedule = await call('schedule-create', {
    target: 'a', title: 'Ping', prompt: `look at @[this](dsh-session:${ownEncoded})`,
    when: { kind: 'every', minutes: 30 },
  }, alice.sessionToken)
  if (ownSchedule.ok === false) assert.notEqual(ownSchedule.error.code, 'bot/forbidden', JSON.stringify(ownSchedule))
})

test('a Bot-to-Bot send drops chat-reference chips in the other Bot\'s own chat, including cross-owner', async (t) => {
  const { tool, agentOf, signIn } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const sameOwner = await tool('message_bot', { to: 'Writer', message: 'see @[secret](dsh-session:a) please' }, 'a')
  assert.match(String(sameOwner), /Delivered/, String(sameOwner))
  const writer = agentOf('s').calls.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(writer.includes('see @secret'), 'the rest of the Bot-to-Bot text still lands')
  assert.ok(!writer.includes('dsh-session:'), 'chips do not enter the other Bot\'s own chat')
  const cross = await tool('message_bot', { to: 'ChiefB', message: 'peek @[notes](dsh-session:a) and dsh-session:e' }, 's')
  assert.match(String(cross), /Delivered/, String(cross))
  const bob = agentOf('d').calls.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(bob.includes('peek @notes'), 'cross-owner Bot-to-Bot keeps the label')
  assert.ok(!bob.includes('dsh-session:'), 'a granted Bot cannot tunnel a private chip into another owner\'s chat')
  const nested = await tool('message_bot', { to: 'Writer', message: 'nested @[secret](dsh-sessiondsh-session:x:ImEi) end' }, 'a')
  assert.match(String(nested), /Delivered/, String(nested))
  const again = agentOf('s').calls.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(!again.includes('dsh-session:'), 'nested chips do not reconstitute in own-chat followups')
  void alice
})

test('a Bot post into a group drops chat-reference chips so they cannot tunnel a private chat', async (t) => {
  const { tool, agentOf, signIn } = await start(t)
  const alice = await signIn('Alice')
  await signIn('Bob', alice.sessionToken)
  const posted = await tool('post_to_group', { group: 'War', message: 'see @[secret](dsh-session:a) and dsh-session:d' }, 'a')
  assert.match(String(posted), /Posted/, String(posted))
  const text = agentOf('war').calls.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(text.includes('see @secret'), 'the rest of the post still lands')
  assert.ok(!text.includes('dsh-session:'), 'chips do not enter the group Session as user text')
  // Nested marker must not reconstitute a valid chip after one strip pass.
  const nested = await tool('post_to_group', { group: 'War', message: 'nested @[secret](dsh-sessiondsh-session:x:ImQi) end' }, 'a')
  assert.match(String(nested), /Posted/, String(nested))
  const again = agentOf('war').calls.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(!again.includes('dsh-session:'), 'nested chips do not reconstitute')
  assert.ok(!/@\[secret\]\(dsh-session:/.test(again), 'no valid reconstituted chip')
  void alice
})



test('a granted remote Bot in the room counts as another owner for the brief', async (t) => {
  const state = team()
  state.rooms.home.participants.push({ kind: 'bot', remote: true, handle: '@coder.bob.home', displayName: 'Coder', ownerName: 'Bob', plugin: 'social', joinedSeq: 0, joinedAt: 2 })
  const { runRound, signIn } = await start(t, { state })
  const alice = await signIn('Alice')
  void alice
  const turns = await runRound('home', 1)
  assert.ok(turns[0], 'the member took its turn')
  assert.ok(!turns[0].includes('Your own chat with the user'), 'a remote participant is another owner: no brief without a share')
})

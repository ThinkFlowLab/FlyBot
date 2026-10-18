import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A fake team of two Bots in one group; member answers are played back through the
// session/event listener, so a round runs with no model. Prompts land in the
// Session's inbox the way DSH holds them while a turn runs: queued for the next turn,
// or steered into the next step.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-rounds-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // Session events arrive one at a time in DSH; awaiting each listener keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  // What the shell's composer does: prompt the group's Session directly.
  const compose = (sessionId, content, mode = 'queue') => ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  })
  const relay = (roomId, callId, signal = new AbortController().signal) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
  // The Bot's answer to its group turn: a delivery source plus the reply text.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent, ctx, home, rt }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))

test('a new group Session waits for capabilities before its first member prompt', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))

  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  rt.ensureCapabilities = async sessionId => {
    markStarted(sessionId)
    await gate
  }
  const running = relay(room.id, 'first-turn')
  const sessionId = await started
  assert.equal(sent.length, 0)
  release()

  const first = await turnFor(sent)
  assert.equal(first.sessionId, sessionId)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief ready.', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer ready.', 2)
  await running
})

async function team(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0
  return room
}

test('a message the composer queues mid-round joins the round and leaves the Session\'s queue', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  // The user's first message opens the round: the admin speaks first.
  await emit(room.id, userMessage('Tell me a long story'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the first turn')

  // While the admin is still answering, the user sends another message.
  await compose(room.id, '@Writer ping mid-round')

  // The admin answers; the Writer's turn prompt must already carry the new line.
  await answer(first.sessionId, first.message.source.exchangeId, 'Once upon a time...', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the Writer gets the next turn')
  assert.match(second.message.content[0].text, /@Writer ping mid-round/)
  assert.match(second.message.content[0].text, /the user mentioned you/)

  await answer(second.sessionId, second.message.source.exchangeId, 'Ping back!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Writer'])
  // Taken out of the queue, the message opens no second round after this one.
  assert.deepEqual(inboxOf(room.id).nextTurn, [])
})

test('#180: another member\'s line is a bubble from that person and starts no Bot turn', async (t) => {
  const { call, emit, relay, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'SelfA', quiet: true, notice: true, human: { authorId: '@chief.selfa.home', name: 'SelfA' } }, content: [{ type: 'text', text: '[Group post from SelfA]\nhello from A' }] } })
  const result = JSON.parse(await relay(room.id, 'relay'))
  assert.deepEqual(result.replies.map(({ kind, other, name, text, authorId }) => ({ kind, other, name, text, authorId })), [
    { kind: 'user', other: true, name: 'SelfA', text: 'hello from A', authorId: '@chief.selfa.home' },
  ])
  assert.equal(sent.length, 0, 'a person line asks no Bot to answer')
})

test('a plain message steered mid-round is answered by everyone, admin first, inside the round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'steer this way', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  // The admin already spoke, so it gets one more turn for the new message.
  const second = await turnFor(sent, first)
  assert.equal(second.sessionId, first.sessionId)
  assert.match(second.message.content[0].text, /steer this way/)
  assert.match(second.message.content[0].text, /new message from the user/)
  await answer(second.sessionId, second.message.source.exchangeId, 'one again', 2)
  const third = await turnFor(sent, first, second)
  assert.match(third.message.content[0].text, /steer this way/)
  await answer(third.sessionId, third.message.source.exchangeId, 'two', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Chief', 'Writer'])
  assert.deepEqual(inboxOf(room.id).nextStep, [])
})

test('a message sent during the last speaker\'s turn is still answered in the round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Kick it off'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief first', 1)
  const second = await turnFor(sent, first)

  // The last member is already answering when the message lands.
  assert.equal((await call('send', { sessionId: room.id, text: 'one more thing' })).ok, true)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer done', 2)

  const third = await turnFor(sent, first, second)
  assert.ok(third, 'the admin answers the late message')
  assert.match(third.message.content[0].text, /one more thing/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Back again', 3)
  const fourth = await turnFor(sent, first, second, third)
  assert.ok(fourth, 'and so does the Writer')
  await answer(fourth.sessionId, fourth.message.source.exchangeId, 'Me too', 4)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief', 'Writer'])
})

test('in admin mode a plain mid-round message goes to the admin', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  // The admin answers alone and calls the Writer.
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer your call', 1)
  const second = await turnFor(sent, first)
  assert.notEqual(second.sessionId, first.sessionId)
  await compose(room.id, 'what do you think?')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here', 2)
  const third = await turnFor(sent, first, second)
  assert.equal(third.sessionId, first.sessionId, 'the admin answers the user')
  assert.match(third.message.content[0].text, /what do you think\?/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Admin here', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief'])
})

test('a mid-round user line resets the room\'s bot-round budget', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent, ctx, home } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)

  // A Main Bot posts into the room while the last member is still answering:
  // that spends one bot-round budget.
  const posted = await ctx.registeredTools.get('post_to_group').execute({ group: 'R1', message: 'bot note' }, { agent: { id: first.sessionId } })
  const roomState = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(roomState().botRounds, 1, String(posted))

  // The user's mid-round message counts as the user speaking: the budget reopens.
  await compose(room.id, '@Writer user back mid-round')
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const third = await turnFor(sent, first, second)
  await answer(third.sessionId, third.message.source.exchangeId, 'three', 3)
  JSON.parse(await running)
  assert.equal(roomState().botRounds, 0)
})

test('a message with an image or a chat reference waits for its own round, and so does what follows it', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, [{ type: 'text', text: 'see this' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  await compose(room.id, 'after the image')
  await compose(room.id, 'about @[Notes](dsh-session:abc123)', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.doesNotMatch(second.message.content[0].text, /see this|after the image|about @/)
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
  assert.equal(inboxOf(room.id).nextTurn.length, 2)
  assert.equal(inboxOf(room.id).nextStep.length, 1)
})

test('the greeting round leaves a waiting message for its own round', async (t) => {
  const { call, emit, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'kickoff' }, content: [{ type: 'text', text: '[Group chat created]' }] } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'hello there')
  await answer(first.sessionId, first.message.source.exchangeId, 'Welcome!', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a stopped round leaves a waiting message for the next round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const controller = new AbortController()
  const running = relay(room.id, 'relay', controller.signal)
  await turnFor(sent)
  await compose(room.id, 'still there?')
  controller.abort()
  const result = JSON.parse(await running)
  assert.equal(result.replies.some(reply => reply.kind === 'user'), false)
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a face-to-face send posts the human line once and runs the opening Bot (#287)', async (t) => {
  const { call, stop, sent, ctx, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const prompts = []
  const orig = ctx.sessionController.prompt
  ctx.sessionController.prompt = async (request) => {
    prompts.push(request)
    return orig(request)
  }
  const chief = (await call('state', {})).value.mainBotId
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_send',
    localId: 'face-send',
    status: 'open',
    members: [{ handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false }],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }],
  })
  sent.length = 0
  const result = await call('send', { sessionId: hosted.id, text: 'hello from the owner' })
  assert.equal(result.ok, true)
  assert.equal(prompts.length, 1)
  const line = hosted.log.find(item => item.text === 'hello from the owner')
  assert.ok(line)
  assert.equal(line.authorKind, 'human')
  const named = await call('send', { sessionId: hosted.id, text: '@Chief ping' })
  assert.equal(named.ok, true)
  assert.equal(prompts.length, 2)
})

test('#167, #287: a plain face-to-face human line starts the opening Bot only; another person\'s line starts none', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_plain',
    localId: 'face-plain',
    status: 'open',
    members: [{ handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false }],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }],
  })
  assert.ok((hosted.members ?? []).includes(chief))
  sent.length = 0
  await emit(hosted.id, userMessage('hello from the owner'))
  const plain = relay(hosted.id, 'plain-face')
  const opener = await turnFor(sent)
  assert.ok(opener, 'a plain line from the owner starts a Bot turn without an @')
  assert.equal(opener.sessionId, hosted.sessions[chief])
  await answer(opener.sessionId, opener.message.source.exchangeId, 'Hi there', 1)
  const done = JSON.parse(await plain)
  assert.equal(done.replies.filter(reply => reply.botId === chief).length, 1)
  assert.equal(sent.filter(entry => entry.message?.source?.role === 'room' && entry.sessionId === opener.sessionId).length, 1, 'one speaker, one turn')

  // A quiet post (another person's line from the other home) never starts a turn.
  sent.length = 0
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'Bob', quiet: true, notice: true, human: { authorId: '@bob.friend.home', name: 'Bob' } }, content: [{ type: 'text', text: 'hi all' }] } })
  const silent = JSON.parse(await relay(hosted.id, 'quiet-face'))
  assert.equal((silent.replies ?? []).filter(reply => reply.botId !== undefined).length, 0)
  assert.equal(sent.some(entry => entry.message?.source?.role === 'room'), false)

  sent.length = 0
  await emit(hosted.id, userMessage('@Chief ping'))
  const running = relay(hosted.id, 'named-face')
  const first = await turnFor(sent)
  assert.ok(first, 'an @mention still starts that Bot\'s turn')
  await answer(first.sessionId, first.message.source.exchangeId, 'pong', 1)
  await running
})

test('#287: in a face room an @ to a friend\'s Bot starts no local turn, an @ to my Bot by its label does, and an @ to nobody says so', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_at',
    localId: 'face-at',
    status: 'open',
    members: [
      { handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false },
      { handle: '@chief.bob.home', displayName: 'Chief', ownerName: 'Bob', published: false },
    ],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }],
  })
  sent.length = 0
  await emit(hosted.id, userMessage("@Bob's Chief 你好，你是干嘛的"))
  const toFriend = JSON.parse(await relay(hosted.id, 'to-friend'))
  assert.equal((toFriend.replies ?? []).filter(reply => reply.botId !== undefined).length, 0)
  assert.equal(sent.some(entry => entry.message?.source?.role === 'room'), false, "the line is for Bob's Chief, so none of mine answers")

  sent.length = 0
  await emit(hosted.id, userMessage("@Me's Chief and you?"))
  const mine = relay(hosted.id, 'to-mine')
  const turn = await turnFor(sent)
  assert.ok(turn, 'my own Bot, called by the label the picker shows, answers')
  await answer(turn.sessionId, turn.message.source.exchangeId, 'here', 1)
  await mine

  sent.length = 0
  const result = await call('send', { sessionId: hosted.id, text: 'hello @Nobody there' })
  assert.equal(result.ok, true)
  const hint = sent.find(entry => /No one in this room is called @Nobody/.test(entry.message?.content?.[0]?.text ?? ''))
  assert.ok(hint, 'an @ that names nobody gets one quiet line')
  assert.equal(hint.message.source.quiet, true)
  const none = sent.length
  await call('send', { sessionId: hosted.id, text: "hello @Bob's Chief" })
  assert.equal(sent.slice(none).some(entry => /No one in this room/.test(entry.message?.content?.[0]?.text ?? '')), false)
})

test('#287: a face-room line the send path posted is logged and sent once, whether the round starts on it or drains it', async (t) => {
  const { call, emit, relay, inboxOf, answer, stop, sent, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const chief = (await call('state', {})).value.mainBotId
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_dup',
    localId: 'face-dup',
    status: 'open',
    members: [{ handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false }],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }],
  })
  const wire = []
  rt.faceRoomFanout = async (room, line) => { wire.push(line.text) }
  const count = text => [hosted.log.filter(line => line.text === text).length, wire.filter(item => item === text).length]
  // The round starts on the line: the Session event queues it, the relay must not append it again.
  await call('send', { sessionId: hosted.id, text: 'first line' })
  const queued = inboxOf(hosted.id).nextTurn.splice(0).at(-1)
  await emit(hosted.id, { type: 'user/message', data: { source: queued.source, content: queued.content } })
  sent.length = 0
  const running = relay(hosted.id, 'dup-1')
  const turn = await turnFor(sent)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'ok', 1)
  await running
  assert.deepEqual(count('first line'), [1, 1])
  // The line arrives while a round runs: it is drained into it, and still logged once.
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'opener' }] } })
  sent.length = 0
  const second = relay(hosted.id, 'dup-2')
  const first = await turnFor(sent)
  await call('send', { sessionId: hosted.id, text: 'second line' })
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 2)
  const next = await turnFor(sent, first)
  if (next) await answer(next.sessionId, next.message.source.exchangeId, 'two', 3)
  await second
  assert.deepEqual(count('second line'), [1, 1])
})

test('a message sent between rounds still opens a full round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Hello group'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first)
  await answer(first.sessionId, first.message.source.exchangeId, 'Hi!', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Hello!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

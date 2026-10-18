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

test('#295: a plain face-to-face line lets every local Bot answer in one pass, each after the earlier replies, with no follow-ups; @Name still targets one', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const state = (await call('state', {})).value
  const chief = state.mainBotId
  const writer = state.bots.find(bot => bot.name === 'Writer').id
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_all',
    localId: 'face-all',
    status: 'open',
    members: [
      { handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false },
      { handle: '@writer.me.home', displayName: 'Writer', ownerName: 'Me', published: false },
      { handle: '@chief.bob.home', displayName: 'Chief', ownerName: 'Bob', published: false },
    ],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }, { id: writer, handle: '@writer.me.home', name: 'Writer' }],
  })
  sent.length = 0
  // "你们都是干嘛的": no @, so both of my Bots answer, one at a time; the friend's Bot is not mine to start.
  await emit(hosted.id, userMessage('你们都是干嘛的'))
  const running = relay(hosted.id, 'plain-all')
  const first = await turnFor(sent)
  assert.ok(first, 'the first Bot answers')
  assert.equal(sent.filter(entry => entry.message?.source?.role === 'room').length, 1, 'one at a time')
  // Its reply @-names the other Bot, then also names itself back: no extra turn is queued from replies.
  await answer(first.sessionId, first.message.source.exchangeId, `I handle planning. @${first.sessionId === hosted.sessions[chief] ? 'Writer' : 'Chief'} what about you?`, 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the other Bot answers next')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.match(second.message.content[0].text, /I handle planning/, 'it sees the earlier reply')
  await answer(second.sessionId, second.message.source.exchangeId, `I write. @${second.sessionId === hosted.sessions[chief] ? 'Writer' : 'Chief'} thanks`, 2)
  const done = JSON.parse(await running)
  assert.deepEqual(done.replies.filter(reply => reply.botId !== undefined).map(reply => reply.botId).sort(), [chief, writer].sort())
  assert.equal(sent.filter(entry => entry.message?.source?.role === 'room').length, 2, 'the replies\' @s start no follow-up turns in a plain pass')

  // @Name still targets only that Bot.
  sent.length = 0
  await emit(hosted.id, userMessage('@Writer only you please'))
  const named = relay(hosted.id, 'named-one')
  const only = await turnFor(sent)
  assert.equal(only.sessionId, hosted.sessions[writer])
  await answer(only.sessionId, only.message.source.exchangeId, 'done', 3)
  await named
  assert.equal(sent.filter(entry => entry.message?.source?.role === 'room').length, 1)

  // A Bot's post without an @ starts nobody; a friend's plain line only counts when the server attested it.
  sent.length = 0
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: '@chief.bob.home', senderName: 'Bob Chief', remote: { handle: '@chief.bob.home' } }, content: [{ type: 'text', text: 'hello everyone' }] } })
  const botPost = JSON.parse(await relay(hosted.id, 'bot-post'))
  assert.equal((botPost.replies ?? []).filter(reply => reply.botId !== undefined).length, 0)
  assert.equal(sent.some(entry => entry.message?.source?.role === 'room'), false)
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'Bob', quiet: true, notice: true, human: { authorId: '@bob.home', name: 'Bob' } }, content: [{ type: 'text', text: 'unattested hello' }] } })
  await relay(hosted.id, 'quiet-human')
  assert.equal(sent.some(entry => entry.message?.source?.role === 'room'), false)
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'Bob', quiet: true, notice: true, plain: true, human: { authorId: '@bob.home', name: 'Bob' } }, content: [{ type: 'text', text: 'attested hello' }] } })
  const friend = relay(hosted.id, 'friend-plain')
  const theirs = await turnFor(sent)
  assert.ok(theirs, 'a friend\'s attested plain line starts my Bots too')
  await answer(theirs.sessionId, theirs.message.source.exchangeId, 'hi Bob', 4)
  const other = await turnFor(sent, theirs)
  assert.ok(other)
  await answer(other.sessionId, other.message.source.exchangeId, 'hi from me too', 5)
  await friend
})

test('#295: a plain line in a large face room is cut off at six speakers, the admin first', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  await team(call, sent)
  await rt.load()
  const state = (await call('state', {})).value
  const chief = state.mainBotId
  const ids = [chief]
  for (let at = 0; at < 7; at += 1) ids.push((await call('create-bot', { name: `Extra${at}` })).value.id)
  const hosted = await rt.upsertFaceRoom({
    roomId: 'frm_big',
    localId: 'face-big',
    status: 'open',
    members: ids.map((id, at) => ({ handle: `@b${at}.me.home`, displayName: `Bot${at}`, ownerName: 'Me', published: false })),
    localBots: ids.map((id, at) => ({ id, handle: `@b${at}.me.home`, name: at === 0 ? 'Chief' : `Extra${at - 1}` })),
  })
  sent.length = 0
  await emit(hosted.id, userMessage('who is here'))
  const running = relay(hosted.id, 'big')
  const spoke = []
  for (let at = 0; at < 8; at += 1) {
    const turn = await turnFor(sent, ...spoke)
    if (!turn) break
    spoke.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `reply ${at}`, at + 1)
  }
  await running
  assert.equal(spoke.length, 6)
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

// A face-to-face room with my Chief and Writer and a friend's Chief; `plain` helpers for #299.
async function routedRoom(ctxs, id) {
  const { call, rt, sent } = ctxs
  await team(call, sent)
  await rt.load()
  const state = (await call('state', {})).value
  const chief = state.mainBotId
  const writer = state.bots.find(bot => bot.name === 'Writer').id
  await call('update-bot', { id: writer, role: 'Writes docs and copy' })
  const hosted = await rt.upsertFaceRoom({
    roomId: `frm_${id}`,
    localId: `face-${id}`,
    status: 'open',
    members: [
      { handle: '@chief.me.home', displayName: 'Chief', ownerName: 'Me', published: false },
      { handle: '@writer.me.home', displayName: 'Writer', ownerName: 'Me', published: false },
      { handle: '@chief.bob.home', displayName: 'Chief', ownerName: 'Bob', published: false },
    ],
    localBots: [{ id: chief, handle: '@chief.me.home', name: 'Chief' }, { id: writer, handle: '@writer.me.home', name: 'Writer' }],
  })
  sent.length = 0
  return { hosted, chief, writer }
}
const roomTurns = sent => sent.filter(entry => entry.message?.source?.role === 'room')
const promptOf = turn => turn.message.content[0].text
const friendPlain = text => ({ type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'Bob', quiet: true, notice: true, plain: true, human: { authorId: '@bob.home', name: 'Bob' } }, content: [{ type: 'text', text }] } })

test('#299: a plain line lets the Bots decide who answers: the passes post nothing and one Bot answers a specific question', async (t) => {
  const env = start()
  const { emit, userMessage, relay, answer, stop, sent } = env
  t.after(stop)
  const { hosted, chief, writer } = await routedRoom(env, 'route')
  await emit(hosted.id, userMessage('帮我看看文档怎么写'))
  const running = relay(hosted.id, 'route-1')
  const first = await turnFor(sent)
  assert.match(promptOf(first), /names no Bot/, 'the line is routed: each Bot decides whether it is theirs')
  assert.match(promptOf(first), /\[PASS\]/)
  assert.match(promptOf(first), /Writer: Writes docs and copy/, 'members see what each does')
  assert.match(promptOf(first), /Bob's Chief|Chief/, 'friend\'s Bots are named as answering for themselves')
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Here is how I would write it.', 2)
  const done = JSON.parse(await running)
  assert.deepEqual(done.replies.filter(reply => reply.kind === undefined).map(reply => reply.text), ['Here is how I would write it.'])
  assert.deepEqual(done.replies.filter(reply => reply.kind !== undefined && reply.kind !== 'user'), [], 'a pass shows no line')
  assert.equal(done.passed.length, 1)
  assert.equal(hosted.log.filter(line => /PASS/.test(line.text ?? '')).length, 0, 'a pass is never logged')
  assert.equal(roomTurns(sent).length, 2)
  assert.ok(chief && writer)
})

test('#299: a line to everyone (introductions) is marked so each Bot may answer; @Name and @all are not routed', async (t) => {
  const env = start()
  const { emit, userMessage, relay, answer, stop, sent } = env
  t.after(stop)
  const { hosted, writer } = await routedRoom(env, 'every')
  await emit(hosted.id, userMessage('大家介绍一下自己'))
  const running = relay(hosted.id, 'every-1')
  const first = await turnFor(sent)
  assert.match(promptOf(first), /addressed to everyone/)
  await answer(first.sessionId, first.message.source.exchangeId, 'I am the Chief.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'I write docs.', 2)
  const done = JSON.parse(await running)
  assert.equal(done.replies.filter(reply => reply.kind === undefined).length, 2, 'an open call for everyone may get one answer from each')

  // "@Name" targets exactly that Bot and is not routed; the prompt carries no pass-by-intent note.
  sent.length = 0
  await emit(hosted.id, userMessage('@Writer 你是谁'))
  const named = relay(hosted.id, 'every-2')
  const only = await turnFor(sent)
  assert.equal(only.sessionId, hosted.sessions[writer])
  assert.doesNotMatch(promptOf(only), /names no Bot/)
  await answer(only.sessionId, only.message.source.exchangeId, 'Writer here', 3)
  await named
  assert.equal(roomTurns(sent).length, 1)

  // A friend's @all: everyone answers as before (one pass, no routing).
  sent.length = 0
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'face-notice', senderName: 'Bob', quiet: true, notice: true, plain: true, everyone: true, human: { authorId: '@bob.home', name: 'Bob' } }, content: [{ type: 'text', text: '@all hi' }] } })
  const all = relay(hosted.id, 'every-3')
  const a = await turnFor(sent)
  assert.doesNotMatch(promptOf(a), /names no Bot/)
  await answer(a.sessionId, a.message.source.exchangeId, 'hi 1', 4)
  const b = await turnFor(sent, a)
  await answer(b.sessionId, b.message.source.exchangeId, 'hi 2', 5)
  await all
})

test('#299: when every Bot passes on the owner\'s own line the first one answers; a friend\'s line is not forced', async (t) => {
  const env = start()
  const { emit, userMessage, relay, answer, stop, sent } = env
  t.after(stop)
  const { hosted } = await routedRoom(env, 'fall')
  await emit(hosted.id, userMessage('随便问一句'))
  const running = relay(hosted.id, 'fall-1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '(pass)', 2)
  const forced = await turnFor(sent, first, second)
  assert.ok(forced, 'nobody answered, so the first Bot is asked again')
  assert.equal(forced.sessionId, first.sessionId, 'admin first')
  assert.match(promptOf(forced), /nobody else answered/)
  assert.doesNotMatch(promptOf(forced), /Reply \[PASS\]/)
  // Its own @ starts nothing: no loop.
  await answer(forced.sessionId, forced.message.source.exchangeId, 'I will take it. @Writer ok?', 3)
  const done = JSON.parse(await running)
  assert.deepEqual(done.replies.filter(reply => reply.kind === undefined).map(reply => reply.text), ['I will take it. @Writer ok?'])
  assert.equal(roomTurns(sent).length, 3, 'no follow-up turns from the reply\'s @')

  // A friend's attested line: both Bots pass and nothing is forced (their own home answers it).
  sent.length = 0
  await emit(hosted.id, friendPlain('他们的问题'))
  const theirs = relay(hosted.id, 'fall-2')
  const a = await turnFor(sent)
  await answer(a.sessionId, a.message.source.exchangeId, '[PASS]', 4)
  const b = await turnFor(sent, a)
  await answer(b.sessionId, b.message.source.exchangeId, '[PASS]', 5)
  const result = JSON.parse(await theirs)
  assert.equal(roomTurns(sent).length, 2)
  assert.deepEqual(result.replies.filter(reply => reply.kind === undefined), [])
})

test('#299: a follow-up goes to the Bot that spoke last, who is asked first; one that follows a friend\'s Bot is not forced on mine', async (t) => {
  const env = start()
  const { emit, userMessage, relay, answer, stop, sent } = env
  t.after(stop)
  const { hosted, writer } = await routedRoom(env, 'follow')
  await emit(hosted.id, userMessage('文档怎么写'))
  const one = relay(hosted.id, 'follow-1')
  const a = await turnFor(sent)
  await answer(a.sessionId, a.message.source.exchangeId, '[PASS]', 1)
  const b = await turnFor(sent, a)
  assert.equal(b.sessionId, hosted.sessions[writer])
  await answer(b.sessionId, b.message.source.exchangeId, 'Start with an outline.', 2)
  await one

  // "then what did you say about it?" right after: the Writer is first, not the admin.
  sent.length = 0
  await emit(hosted.id, userMessage('那你刚才说的大纲具体怎么写'))
  const two = relay(hosted.id, 'follow-2')
  const c = await turnFor(sent)
  assert.equal(c.sessionId, hosted.sessions[writer], 'the last speaker is asked first')
  assert.match(promptOf(c), /Writer spoke last before this line/)
  await answer(c.sessionId, c.message.source.exchangeId, 'Three headings, then fill in.', 3)
  const d = await turnFor(sent, c)
  assert.ok(d, 'the other Bot is still asked and sees the answer, so it can pass')
  await answer(d.sessionId, d.message.source.exchangeId, '[PASS]', 4)
  const done = JSON.parse(await two)
  assert.deepEqual(done.replies.filter(reply => reply.kind === undefined).map(reply => reply.text), ['Three headings, then fill in.'])

  // The friend's Bot spoke last: my Bots may pass, and nothing is forced on the owner's home.
  await emit(hosted.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: '@chief.bob.home', senderName: "Bob's Chief", remote: { handle: '@chief.bob.home' } }, content: [{ type: 'text', text: 'I can see the whole room.' }] } })
  await relay(hosted.id, 'follow-3')
  sent.length = 0
  await emit(hosted.id, userMessage('那你说说群里都聊了啥'))
  const three = relay(hosted.id, 'follow-4')
  const e = await turnFor(sent)
  assert.match(promptOf(e), /Chief spoke last before this line/)
  await answer(e.sessionId, e.message.source.exchangeId, '[PASS]', 5)
  const f = await turnFor(sent, e)
  await answer(f.sessionId, f.message.source.exchangeId, '[PASS]', 6)
  await three
  assert.equal(roomTurns(sent).length, 2, 'no forced answer when the follow-up is to a friend\'s Bot')
})

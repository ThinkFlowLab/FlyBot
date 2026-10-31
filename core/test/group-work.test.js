import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_LATE_ROUNDS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { compactStatus, prepareRoomLine } from '../src/host/room-context.js'

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, history = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room)))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex(message => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, { session: { id: sessionId, seq: (history[sessionId]?.at(-1)?.seq ?? -1) + 1 }, calls, cancelled, inbox, followup: keep, steer: keep, cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      // What the durable log holds for a Session: `history` seeds it, oldest first.
      page: async ({ address, beforeSeq, maxMessages } = {}) => {
        const all = (history[address?.sessionId] ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records: records.map(event => ({ event })), hasMore: records.length < all.length }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    const read = () => result
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, rt, agentOf, emit, tool, call, begin, finish, round, say, takePost }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const plain = value => JSON.parse(JSON.stringify(value))
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

test('work past the grace lets the round go on, and the member that asked answers the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, 'a', '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
  // The call waits for the work before it.
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 1)
})

test('a quick team tool does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 谁在群里？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', 'Chief、Tester 和我。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const dispatch = (emit, sessionId, parentCallId, n, name) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {} })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {}, isError: false, content: [] })
}

test('a PTC program that runs only team tools does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 群里刚才说了什么？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{"code":"await read_group_chat({})"}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'list_bots')()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', '在讨论文档的结构。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

test('work inside a PTC program lets the round go on after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'write')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool]), [['b', 'write']])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
})

test('work the user asked for is left for the user to read, and the user\'s message resets the late limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { lateRounds: ROOM_LATE_ROUNDS - 1 })
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  // The user's message resets the limit.
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.lateRounds, 0)
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('the late round limit makes a late post quiet', async (t) => {
  const host = await start(t, { lateRounds: ROOM_LATE_ROUNDS })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0, askedBy: 'a' } })
  host.finish('gb', '做完了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(host.takePost().source.quiet, true)
})

test('a reply to a message a group Session sent comes back there, and its turn posts in the group', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Tester', message: '能跑通吗？' }, 'gb')
  assert.equal(host.begin('c').source.senderRoomId, 'r1')
  host.finish('c', 'ok')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(text(host.begin('gb')), /^\[Reply from Tester\]\nok/)
  host.finish('gb', 'Tester 说可以，我继续。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, text(post)], [true, '[Group post from Writer]\nTester 说可以，我继续。'])
})

test('the user stops a member\'s work in a group, and the group shows it', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.quiet], [true, true])
  const result = host.round('c1', post)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['stopped', 'Writer']])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => [line.who, line.kind]), [['Writer', 'stopped']])
})

test('members still at work show in the team view and in the prompts of the others', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.agentOf('gc').calls[0]), /Still at work on what they were asked; each posts here when done: Writer \(1 min\)\./)
  host.begin('gc')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.speaking]), [['b', 'pwsh', undefined], ['c', undefined, true]])
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
})

// #553: a group shows only its own work. An own-chat turn names the group it was handed out
// from, so the group can show it; the Bot's other own-chat work names none.
test('an own-chat turn handed out from a group names that group in the work view (#553)', async (t) => {
  const host = await start(t)
  const bots = async () => (await host.call('state', {})).value.work.bots
  await host.tool('message_bot', { to: 'Tester', message: '把测试跑一遍' }, 'gb')
  host.begin('c')
  host.emit('c', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) })
  assert.deepEqual(plain((await bots()).c), { since: (await bots()).c.since, tool: 'pwsh', step: 'npm test', calls: 1, fromRoomId: 'r1' })
  host.finish('c', 'ok')
  // The user's own line, and a hand-off answered to the user in the Bot's own chat, are the Bot's own.
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
  await host.tool('message_bot', { to: 'Writer', message: '跟用户打个招呼', reply_to: 'user' }, 'ga')
  host.begin('b')
  const view = await bots()
  assert.deepEqual([view.a?.fromRoomId, view.a?.roomId, view.b?.fromRoomId], [undefined, undefined, undefined])
  assert.notEqual(view.a, undefined)
  assert.notEqual(view.b, undefined)
})

// #550: work a group member hands a Bot with message_bot runs in a hidden turn of the Bot's own
// chat; a question there belongs to the group the work came from, and its answer goes back the same way.
const askBranch = (host, sessionId = 'c') => host.tool('ask_user', { question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }, sessionId, { callId: 'q1', concludeTurn() {} })

test('a question about work handed out from a group shows in that group, not in the Bot\'s own chat (#550)', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Tester', message: '把测试跑一遍' }, 'gb')
  host.begin('c')
  assert.match(await askBranch(host), /in the group "Ops"/)
  const { value } = await host.call('state', {})
  assert.equal(value.questions.c, undefined)
  assert.deepEqual([value.questions.r1?.question, value.questions.r1?.botId, value.questions.r1?.header], ['Which branch?', 'c', 'Tester'])
})

test('the answer given in the group reaches the asking Bot\'s waiting work and its reply returns to the group (#550)', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Tester', message: '把测试跑一遍' }, 'gb')
  host.begin('c')
  await askBranch(host)
  host.finish('c', 'Need to know the branch first.')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const asked = (await host.call('state', {})).value.questions.r1
  // A line typed in the group goes to the group's round; the card waits for its own answer.
  host.emit('r1', 'user/message', host.say('大家好'))
  assert.equal((await host.call('state', {})).value.questions.r1?.id, asked.id)
  const before = host.agentOf('c').calls.length
  const answered = await host.call('answer-question', { sessionId: 'r1', questionId: asked.id, answer: { selected: ['dev'] } })
  assert.equal(answered.ok, true)
  assert.equal((await host.call('state', {})).value.questions.r1, undefined)
  // Exactly one new message in Tester's own chat: a hidden request that carries the answer, not a user turn.
  const added = host.agentOf('c').calls.slice(before)
  assert.equal(added.length, 1)
  assert.deepEqual([added[0].source.kind, added[0].source.role, added[0].source.senderSessionId, added[0].source.senderRoomId], ['bot', 'request', 'b', 'r1'])
  assert.match(text(added[0]), /group "Ops"/)
  assert.match(text(added[0]), /Which branch\?\nAnswer: dev/)
  // The group sees the answer as a quiet notice.
  await settle(() => host.agentOf('r1').calls.some(call => call.source?.notice === true))
  const notice = host.agentOf('r1').calls.find(call => call.source?.notice === true)
  assert.equal(notice.source.quiet, true)
  assert.match(text(notice), /answered Tester: Which branch\? → dev/)
  // Tester's reply goes back to Writer's Session in the group, which posts it there.
  host.begin('c')
  host.finish('c', 'Ran it on dev: all green.')
  await settle(() => host.agentOf('gb').calls.length === 2)
  assert.match(text(host.agentOf('gb').calls.at(-1)), /^\[Reply from Tester\]\nRan it on dev: all green\./)
  assert.equal((await host.call('answer-question', { sessionId: 'r1', questionId: asked.id, answer: { selected: ['dev'] } })).error.code, 'bot/stale')
})

// #P282b: the answer echo is bounded at 300, and a cut inside an emoji left half a pair in the
// room line every member reads.
test('the answer echo in a group keeps whole characters at the 300 bound (#P282b)', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Tester', message: '把测试跑一遍' }, 'gb')
  host.begin('c')
  await askBranch(host)
  host.finish('c', 'Need to know the branch first.')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const asked = (await host.call('state', {})).value.questions.r1
  const custom = 'a'.repeat(299) + '😀tail'
  assert.equal((await host.call('answer-question', { sessionId: 'r1', questionId: asked.id, answer: { selected: [], custom } })).ok, true)
  await settle(() => host.agentOf('r1').calls.some(call => call.source?.notice === true))
  const notice = host.agentOf('r1').calls.find(call => call.source?.notice === true)
  const said = text(notice)
  assert.equal(said.isWellFormed(), true, `the answer echo is not well formed: ${JSON.stringify(said.slice(-8))}`)
  const values = said.split(' → ').at(-1)
  assert.equal(values, 'a'.repeat(299), `the answer echo keeps the 300 bound: ${JSON.stringify(values.slice(-4))}`)
  assert.ok(Buffer.from(values, 'utf8').equals(Buffer.from(custom, 'utf8').subarray(0, Buffer.byteLength(values))), 'the answer echo is a prefix of the answer, byte for byte')
})

test('a question in the Bot\'s own chat stays there, and a request answered to the user keeps its card there (#550)', async (t) => {
  const host = await start(t)
  host.emit('c', 'turn/start', { turn: 1 })
  host.emit('c', 'user/message', host.say('hi'))
  await askBranch(host)
  let { value } = await host.call('state', {})
  assert.deepEqual([value.questions.c?.question, value.questions.r1], ['Which branch?', undefined])
  host.finish('c', '')
  await host.call('dismiss-question', { sessionId: 'c' })
  await host.tool('message_bot', { to: 'Tester', message: '跟用户打个招呼', reply_to: 'user' }, 'gb')
  host.begin('c')
  await askBranch(host)
  ;({ value } = await host.call('state', {}))
  assert.deepEqual([value.questions.c?.question, value.questions.r1], ['Which branch?', undefined])
})

test('a face-to-face room asks and answers the same way (#550)', async (t) => {
  const host = await start(t, { origin: 'face-to-face' })
  await host.tool('message_bot', { to: 'Tester', message: 'check it' }, 'gb')
  host.begin('c')
  await askBranch(host)
  const asked = (await host.call('state', {})).value.questions.r1
  assert.equal(asked?.botId, 'c')
  host.finish('c', '')
  const before = host.agentOf('c').calls.length
  assert.equal((await host.call('answer-question', { sessionId: 'r1', questionId: asked.id, answer: { selected: [], custom: 'the release branch' } })).ok, true)
  const added = host.agentOf('c').calls.slice(before)
  assert.deepEqual(added.map(call => [call.source.role, call.source.senderRoomId]), [['request', 'r1']])
  assert.match(text(added[0]), /Answer: the release branch/)
})

// #1251: the room log accepted whatever a Bot posted, so the next speaker (and every later
// first look) paid for a 1-2k CI/merge essay until it aged out of the 60-line ring, even
// though #1204 already collapsed that essay when building the turn. The store now keeps the
// same stub the turn builder showed, so log and prompt agree by construction.
const STATUS_ESSAY = `CI on tip abcdef12 is green. tests-ok passed. enqueue when mergeable. merge_group is next. PASS at abcdef12. ${'detail '.repeat(200)}ESSAY_TAIL`

test('a Bot status essay is stored as the stub the next speaker sees (#1251)', async (t) => {
  const host = await start(t)
  const log = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  const result = host.round('c1', host.say('@Writer 汇报一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', STATUS_ESSAY)
  await settle(() => result() !== undefined)
  await settle(() => log().length === 2)
  const stored = log().at(-1)
  assert.equal(stored.botId, 'b')
  assert.equal(stored.text, compactStatus(STATUS_ESSAY))
  assert.ok(!stored.text.includes('ESSAY_TAIL'), 'the essay body is not in the store')
  assert.ok(stored.text.length < 220, `stored ${stored.text.length} chars`)
  // What the next member reads is the same text, because the turn builder prepares the stored line.
  const turn = await host.call('state', {})
  assert.equal(turn.ok, true)
})

test('a person\'s long line is stored whole, never stubbed (#1251)', async (t) => {
  const host = await start(t)
  const log = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  const person = `@Writer 这段是用户写的长文。${'word '.repeat(120)}PERSON_TAIL`
  const result = host.round('c1', host.say(person))
  await settle(() => log().length === 1)
  assert.equal(log()[0].text, person)
  assert.equal(log()[0].botId, undefined)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => result() !== undefined)
})

test('a short Bot handoff is stored verbatim, not collapsed (#1251)', async (t) => {
  const host = await start(t)
  const log = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  const handoff = '#1234 PASS @abcdef1 → @Writer'
  const result = host.round('c1', host.say('@Writer 报一句'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', handoff)
  await settle(() => result() !== undefined)
  await settle(() => log().at(-1)?.text === handoff)
  assert.equal(log().at(-1).text, handoff)
})

test('a kind-carrying room line stays verbatim in the store (#1251)', async (t) => {
  const host = await start(t)
  const log = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  const query = 'the merge queue and the review verdict on the last tip'
  await host.tool('read_own_chat', { query }, 'gb')
  await settle(() => log().length === 1)
  assert.deepEqual([log()[0].kind, log()[0].text], ['lookup', query])
  // A real post from this home cannot carry a long kind line (a lookup query is capped at 80 characters
  // and an event line carries ''); a peer-chosen kind arrives on a fenced line, and the fence is decided
  // before this exemption (room-context.js). So the exemption itself is pinned on the gate's own decision.
  const long = { who: 'Writer', botId: 'b', kind: 'notice', text: STATUS_ESSAY }
  assert.equal(prepareRoomLine(long), long)
})

// #1916: the lookup line goes into the room log and is also what the search matches, so a bound
// that lands inside an emoji would store an ill-formed string and make the character unsearchable.
const utf8Prefix = (whole, part) => Buffer.from(part, 'utf8').equals(Buffer.from(whole, 'utf8').subarray(0, Buffer.byteLength(part)))

test('a read_own_chat query or anchor cut at its bound never splits a surrogate pair (#1916)', async (t) => {
  const host = await start(t)
  const log = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  const query = `${'a'.repeat(79)}\u{1F600}permalink`
  await host.tool('read_own_chat', { query }, 'gb')
  await settle(() => log().length === 1)
  assert.equal(log()[0].text.isWellFormed(), true)
  assert.ok(log()[0].text.length <= 80, `query is ${log()[0].text.length} units`)
  assert.equal(utf8Prefix(query, log()[0].text), true, 'the stored query is a byte prefix of the input')
  const around = `${'b'.repeat(39)}\u{1F600}anchor`
  await host.tool('read_own_chat', { around }, 'gb')
  await settle(() => log().length === 2)
  assert.equal(log()[1].text.isWellFormed(), true)
  assert.ok(log()[1].text.length <= `around ${'b'.repeat(39)}`.length, `anchor is ${log()[1].text.length} units`)
  assert.equal(utf8Prefix(`around ${around}`, log()[1].text), true, 'the stored anchor is a byte prefix of the input')
})

// #1916: the task lead's name goes into every other member's system prompt, and a Bot name is the
// owner's to set, emoji included (#1182).
test('the task lead name in a member prompt never splits a surrogate pair (#1916)', async (t) => {
  const host = await start(t, { taskLead: 'a' })
  const name = `${'l'.repeat(79)}\u{1F600}tail`
  host.rt.state.bots.a.name = name
  const prompt = host.ctx.sections.get('bot-room').text({ agent: { id: 'gb' } })
  assert.equal(prompt.isWellFormed(), true, 'the room prompt is well formed')
  assert.equal(prompt.includes('\uFFFD'), false)
  assert.ok(prompt.includes('l'.repeat(79)), 'the whole-character prefix is kept')
})

// #1916: a group Session that cannot be opened reports its error into the room (#1253 notice path),
// so the 300-unit bound on that text must not land inside an emoji.
test('a failed group Session reports its error without splitting a surrogate pair (#1916)', async (t) => {
  const host = await start(t)
  // No Session for Writer yet: the next round has to open one, and opening it fails.
  delete host.rt.state.rooms.r1.sessions.b
  host.ctx.sessionController.create = async () => { throw new Error(`${'e'.repeat(299)}\u{1F600}tail`) }
  const result = host.round('c1', host.say('@Writer 汇报'))
  await settle(() => result() !== undefined)
  const failed = result().replies.find(reply => reply.kind === 'failed')
  assert.ok(failed, `no failed reply: ${JSON.stringify(result())}`)
  assert.equal(failed.text.isWellFormed(), true)
  assert.equal(failed.text.includes('\uFFFD'), false)
  assert.ok(failed.text.length <= 300, `text is ${failed.text.length} units`)
})

// #1906: a search shows its best 20 hits and a bare read the latest 12, and neither said
// how much it left out, so a user asking "didn't we decide X?" could think the deciding
// message was gone. The caps stay; the answer says what it did not show.
const chatLine = (seq, text) => ({ type: 'user/message', seq, time: 1_000 + seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const shownLines = out => out.split('\n').filter(line => line.startsWith('['))

test('a search that hits its cap says how many hits it did not show (#1906)', async (t) => {
  const many = { b: Array.from({ length: 25 }, (_, seq) => chatLine(seq, `message ${seq}: the merge queue slipped again`)) }
  const host = await start(t, undefined, many)
  const out = await host.tool('read_own_chat', { query: 'merge' }, 'b')
  assert.equal(shownLines(out).length, 20)
  assert.match(out, /5 more not shown/)

  // Exactly at the cap, nothing was left out: no extra clause.
  const exact = { b: Array.from({ length: 20 }, (_, seq) => chatLine(seq, `message ${seq}: the merge queue slipped again`)) }
  const atCap = await start(t, undefined, exact)
  const capOut = await atCap.tool('read_own_chat', { query: 'merge' }, 'b')
  assert.equal(shownLines(capOut).length, 20)
  assert.doesNotMatch(capOut, /more not shown/)
})

test('a bare read that hits its cap says newest 12 of 15 (#1906)', async (t) => {
  const history = { b: Array.from({ length: 15 }, (_, seq) => chatLine(seq, `message ${seq} in one part`)) }
  const host = await start(t, undefined, history)
  const out = await host.tool('read_own_chat', {}, 'b')
  assert.equal(shownLines(out).length, 12)
  assert.match(out, /newest 12 of 15/)

  // Exactly at the cap, the whole part was shown: no extra clause.
  const exact = { b: Array.from({ length: 12 }, (_, seq) => chatLine(seq, `message ${seq} in one part`)) }
  const atCap = await start(t, undefined, exact)
  const capOut = await atCap.tool('read_own_chat', {}, 'b')
  assert.equal(shownLines(capOut).length, 12)
  assert.doesNotMatch(capOut, /newest 12 of/)
})

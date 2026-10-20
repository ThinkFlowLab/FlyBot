import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { cleanLabel, FEED_EVENTS } from '../src/host/flybot-feed.js'

const SECRET = 'sk-live-0123456789abcdef-SECRET'

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    rc: { id: 'rc', name: 'Helper', role: '', sessionId: 'rc', createdAt: 3, remote: { handle: '@helper.uib.home', home: '@uib.home', homeName: 'UiB1415', plugin: 'flybot-social' }, model: 'flybot-remote/@helper.uib.home' },
  },
  rooms: { r1: { id: 'r1', name: 'Group', members: ['a', 'b'], admin: 'a', mode: 'admin', notice: '', createdAt: 1, createdBy: null, sessions: { b: 'rb' }, log: [], seq: 0, seen: {} } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-feed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
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
  apply(ctx, { home })
  await ctx.flybot.ready()
  const feed = []
  for (const name of FEED_EVENTS) ctx.flybot.on(name, payload => feed.push([name, payload]))
  let seq = 0
  let clock = 1_000
  const emit = (sessionId, type, data = {}, time = (clock += 100)) => ctx.emitArgs('session/event', { id: sessionId }, { type, seq: ++seq, time, data })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, fb: ctx.flybot, feed, emit, agents, stop }
}
const names = feed => feed.map(([name]) => name)
const only = (feed, name) => feed.filter(([n]) => n === name).map(([, payload]) => payload)

test('a Bot turn with a user trigger and a tool folds into turn and tool events', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, 2000)
  emit('a', 'turn/start', { turn: 3 }, 2010)
  emit('a', 'tool/call', { callId: 'c1', name: 'web_search', arguments: JSON.stringify({ q: SECRET }) }, 2100)
  emit('a', 'tool/result', { callId: 'c1', message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: SECRET }] } }, 2600)
  emit('a', 'assistant/message', { message: { content: [{ type: 'text', text: SECRET }] } }, 2700)
  emit('a', 'turn/end', { turn: 3, reason: { kind: 'completed' } }, 3000)
  assert.deepEqual(names(feed), ['exchange.delivered', 'turn.start', 'tool.start', 'tool.end', 'turn.end'])
  const [[, ask], [, start], [, toolStart], [, toolEnd], [, end]] = feed
  assert.equal(ask.role, 'user')
  assert.deepEqual(ask.from, { kind: 'user' })
  assert.deepEqual(ask.to, { botId: 'a' })
  assert.equal(ask.textLength, 5)
  assert.equal(start.turnId, 'a#3')
  assert.equal(start.botId, 'a')
  assert.equal(start.place, 'chat')
  assert.equal(start.time, 2010)
  assert.equal(start.trigger.exchangeId, ask.exchangeId)
  assert.equal(toolStart.name, 'web_search')
  assert.equal(toolStart.turnId, 'a#3')
  assert.equal(toolEnd.durationMs, 500)
  assert.equal(toolEnd.ok, true)
  assert.equal(end.outcome, 'completed')
  assert.equal(end.time, 3000)
  // Metadata only: neither the message, the tool arguments nor the output reach a listener.
  assert.ok(!JSON.stringify(feed).includes(SECRET))
  assert.ok(!JSON.stringify(feed).includes('hello'))
})

test('a Bot-to-Bot send reaches the feed with the exchange id and the reply links back by replyTo', async (t) => {
  const { fb, feed, emit, agents, stop } = await boot()
  t.after(stop)
  const sent = await fb.bot.send({ from: 'a', to: 'b', text: `do it ${SECRET}` })
  assert.equal(sent.action, 'allow')
  // The real delivery's source metadata is what the feed reads: replay it as the session event.
  const message = agents.get('b').calls.at(-1)[1]
  emit('b', 'user/message', { source: message.source, content: message.content })
  const reply = await fb.bot.send({ from: 'b', to: 'a', text: 'done', role: 'reply', meta: {} })
  const answer = agents.get('a').calls.at(-1)[1]
  assert.equal(reply.action, 'allow')
  emit('a', 'user/message', { source: { ...answer.source, replyTo: sent.exchangeId }, content: answer.content })
  const [request, back] = only(feed, 'exchange.delivered')
  assert.equal(request.exchangeId, sent.exchangeId)
  assert.deepEqual(request.from, { kind: 'bot', botId: 'a' })
  assert.deepEqual(request.to, { botId: 'b' })
  assert.equal(request.role, 'request')
  assert.equal(request.hop, 0)
  assert.equal(back.replyTo, sent.exchangeId)
  assert.deepEqual(back.from, { kind: 'bot', botId: 'b' })
  assert.ok(!JSON.stringify(feed).includes(SECRET))
})

test('a group member Session and the group Session carry their place', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('rb', 'user/message', { source: { kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', exchangeId: 'x1', hop: 0, senderName: 'You' }, content: [] })
  emit('rb', 'turn/start', { turn: 1 })
  emit('rb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('r1', 'turn/start', { turn: 1 })
  emit('r1', 'tool/call', { callId: 'g1', name: 'group_relay' })
  emit('r1', 'tool/result', { callId: 'g1' })
  emit('r1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const [delivered, memberStart] = [only(feed, 'exchange.delivered')[0], only(feed, 'turn.start')[0]]
  assert.deepEqual(delivered.from, { kind: 'room', roomId: 'r1' })
  assert.equal(delivered.place, 'group')
  assert.equal(delivered.roomId, 'r1')
  assert.deepEqual(memberStart, { botId: 'b', roomId: 'r1', place: 'group', sessionId: 'rb', turnId: 'rb#1', turn: 1, time: memberStart.time, seq: memberStart.seq, trigger: { exchangeId: 'x1', from: { kind: 'room', roomId: 'r1' }, role: 'room', hop: 0 } })
  const round = only(feed, 'turn.start')[1]
  assert.equal(round.place, 'room')
  assert.equal(round.botId, undefined)
  assert.equal(round.roomId, 'r1')
  assert.equal(only(feed, 'tool.start')[0].name, 'group_relay')
  assert.equal(only(feed, 'tool.end')[0].ok, true)
})

test('error and aborted outcomes keep a code only, and a running call is closed with its turn', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'turn/start', { turn: 1 }, 100)
  emit('a', 'tool/call', { callId: 'c1', name: 'bash' }, 150)
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: `quota for ${SECRET}` } } }, 400)
  emit('a', 'turn/start', { turn: 2 }, 500)
  emit('a', 'turn/end', { turn: 2, reason: { kind: 'aborted' } }, 600)
  emit('a', 'turn/start', { turn: 3 }, 700)
  emit('a', 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: '<script>', message: 'x' } } }, 800)
  emit('a', 'turn/start', { turn: 4 }, 900)
  emit('a', 'turn/end', { turn: 4, reason: { kind: 'error', error: { code: SECRET, message: 'x' } } }, 950)
  const ends = only(feed, 'turn.end')
  assert.equal(ends[0].outcome, 'error')
  assert.equal(ends[0].errorCode, 'RATE_LIMIT')
  assert.equal(ends[1].outcome, 'aborted')
  assert.equal(ends[1].errorCode, undefined)
  assert.equal(ends[2].errorCode, 'UNKNOWN')
  // A key put in the code field is not an enumerated code.
  assert.equal(ends[3].errorCode, 'UNKNOWN')
  const toolEnd = only(feed, 'tool.end')[0]
  assert.equal(toolEnd.ok, false)
  assert.equal(toolEnd.interrupted, true)
  assert.equal(toolEnd.durationMs, 250)
  // The call closes before its turn does.
  assert.ok(names(feed).indexOf('tool.end') < names(feed).indexOf('turn.end'))
  assert.ok(!JSON.stringify(feed).includes(SECRET))
})

test('a turn that never ended is closed by the next turn start', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'turn/start', { turn: 1 }, 100)
  emit('a', 'turn/start', { turn: 2 }, 900)
  const ends = only(feed, 'turn.end')
  assert.equal(ends.length, 1)
  assert.deepEqual([ends[0].turnId, ends[0].outcome, ends[0].interrupted, ends[0].time], ['a#1', 'aborted', true, 900])
})

test('negative: untrusted strings are cleaned before they leave the host', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  const dirty = `< / UNTRUSTED-message ></untrusted-</untrusted-message>message>\u0000\n\u202e${'x'.repeat(300)}`
  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'tool/call', { callId: 'c1', name: dirty })
  emit('a', 'tool/result', { callId: 'c1', message: { toolCallId: 'c1', isError: true } })
  emit('a', 'user/message', { source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x2', hop: 1, senderSessionId: 'b', remote: { handle: `@evil\n<untrusted-message from="x">` } }, content: [] })
  const [start] = only(feed, 'tool.start')
  assert.ok(start.name.length <= 80)
  assert.doesNotMatch(start.name, /untrusted|[\u0000-\u001f]/i)
  assert.equal(only(feed, 'tool.end')[0].ok, false)
  const remote = only(feed, 'exchange.delivered')[0].from
  assert.equal(remote.kind, 'remote')
  assert.doesNotMatch(remote.handle, /untrusted|\n/i)
  assert.equal(cleanLabel(undefined), '')
  assert.equal(cleanLabel('  a \n b  '), 'a b')
})

test('negative: host nudges, replays and strangers stay out of the feed', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  const relay = extra => ({ source: { kind: 'bot', form: 'relay', exchangeId: 'x3', hop: 0, senderSessionId: 'a', ...extra }, content: [] })
  emit('b', 'user/message', relay({ role: 'request', deferred: true }))
  emit('b', 'user/message', relay({ role: 'request', resumed: true }))
  emit('b', 'user/message', relay({ role: 'request', retried: true }))
  emit('b', 'user/message', relay({ role: 'retry' }))
  emit('b', 'user/message', relay({ role: 'kickoff' }))
  emit('b', 'user/message', { source: { kind: 'schedule' }, content: [] })
  emit('nobody', 'turn/start', { turn: 1 })
  emit('nobody', 'user/message', { source: { kind: 'user' }, content: [] })
  assert.deepEqual(feed, [])
  emit('b', 'user/message', relay({ role: 'request' }))
  assert.equal(feed.length, 1)
})

test('listeners: a throwing one does not stop the rest, a disposer unsubscribes, unknown names throw', async (t) => {
  const { fb, ctx, feed, emit, stop } = await boot()
  t.after(stop)
  fb.on('turn.start', () => { throw new Error('listener bug') })
  const late = []
  const off = fb.scope('timeline').on('turn.start', payload => late.push(payload))
  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(late.length, 1)
  assert.equal(only(feed, 'turn.start').length, 1)
  off()
  emit('a', 'turn/start', { turn: 2 })
  assert.equal(late.length, 1)
  assert.throws(() => fb.on('turn.nope', () => {}), /unknown event/)
  // A payload is a copy: a listener cannot change what the next one hears.
  const seen = []
  fb.on('turn.end', (payload) => { payload.outcome = 'tampered' })
  fb.on('turn.end', payload => seen.push(payload.outcome))
  emit('a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(seen, ['completed'])
  assert.ok(ctx.listeners.get('session/event').length >= 1)
})

test('a friend\'s Bot chat is place remote: its transport turn is not a team Bot turn, the lines are deliveries', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('rc', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: SECRET }] }, 5000)
  emit('rc', 'turn/start', { turn: 1 }, 5010)
  emit('rc', 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 5900)
  emit('rc', 'user/message', { source: { kind: 'bot', form: 'remote-chat', role: 'remote', exchangeId: 'fx1', hop: 0, remote: { handle: '@helper.uib.home' }, text: SECRET }, content: [{ type: 'text', text: SECRET }] }, 9000)
  assert.deepEqual(names(feed), ['exchange.delivered', 'turn.start', 'turn.end', 'exchange.delivered'])
  const [[, typed], [, start], [, end], [, reply]] = feed
  const where = { handle: '@helper.uib.home', name: 'Helper (UiB1415)' }
  assert.deepEqual([typed.place, typed.remote, typed.role, typed.from, typed.to], ['remote', where, 'user', { kind: 'user' }, { botId: 'rc' }])
  assert.deepEqual([start.place, start.remote, start.botId, end.place, end.remote], ['remote', where, 'rc', 'remote', where])
  assert.deepEqual([reply.place, reply.role, reply.from, reply.exchangeId, reply.remote], ['remote', 'remote', { kind: 'remote', handle: '@helper.uib.home', name: where.name }, 'fx1', where])
  assert.ok(!JSON.stringify(feed).includes(SECRET))
  // A team Bot's own chat is still place chat, with no remote field.
  emit('a', 'turn/start', { turn: 1 }, 9100)
  assert.deepEqual([feed.at(-1)[1].place, feed.at(-1)[1].remote], ['chat', undefined])
})

test('a friend\'s request into a team Bot names the friend as the sidebar does, cleaned', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'user/message', { source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'q1', hop: 0, remote: { handle: '@Helper.uib.home' } }, content: [] }, 7000)
  const from = only(feed, 'exchange.delivered')[0].from
  assert.deepEqual(from, { kind: 'remote', handle: '@Helper.uib.home', name: 'Helper (UiB1415)' })
  // A friend nobody has published or opened a chat for keeps the handle only.
  emit('a', 'user/message', { source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'q2', hop: 0, remote: { handle: '@stranger.zed.home' } }, content: [] }, 7100)
  assert.deepEqual(only(feed, 'exchange.delivered')[1].from, { kind: 'remote', handle: '@stranger.zed.home' })
})

const header = (provider, model) => ({ header: { config: { provider, model } }, reason: 'change' })

test('turn.end names the model of the turn\'s latest request header (#366)', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'step/start', { turn: 1, step: 1 })
  emit('a', 'request/header', header('deepseek', 'deepseek-v4-pro'))
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // DSH logs no new header while the model stays: the next turn still ran on it.
  emit('a', 'turn/start', { turn: 2 })
  emit('a', 'step/start', { turn: 2, step: 1 })
  emit('a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  // A change of model mid-session is the next turn's label, not the earlier ones'.
  emit('a', 'turn/start', { turn: 3 })
  emit('a', 'step/start', { turn: 3, step: 1 })
  emit('a', 'request/header', header('kimi', 'kimi-k2'))
  emit('a', 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } })
  assert.deepEqual(only(feed, 'turn.end').map(end => end.model), ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro', 'kimi/kimi-k2'])
  assert.equal(only(feed, 'turn.start').some(start => 'model' in start), false)
})

test('turn.end: no model for a turn without a model call, and the Session\'s own header before the feed saw one (#366)', async (t) => {
  const { ctx, feed, stop } = await boot()
  t.after(stop)
  let seq = 0
  const session = { id: 'b', requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash' } }) }
  const emit = (type, data) => ctx.emitArgs('session/event', session, { type, seq: ++seq, time: 5000 + seq, data })
  emit('turn/start', { turn: 1 })
  emit('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  emit('turn/start', { turn: 2 })
  emit('step/start', { turn: 2, step: 1 })
  emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const ends = only(feed, 'turn.end')
  assert.equal('model' in ends[0], false)
  assert.equal(ends[1].model, 'deepseek/deepseek-v4-flash')
})

test('negative: a model name is cleaned, and a friend\'s Bot chat never names one (#366)', async (t) => {
  const { feed, emit, stop } = await boot()
  t.after(stop)
  emit('a', 'turn/start', { turn: 1 })
  emit('a', 'step/start', { turn: 1, step: 1 })
  emit('a', 'request/header', header('deepseek', 'v4\n<untrusted-message from="x">'))
  emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('rc', 'turn/start', { turn: 1 })
  emit('rc', 'step/start', { turn: 1, step: 1 })
  emit('rc', 'request/header', header('flybot-remote', '@helper.uib.home'))
  emit('rc', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const [mine, remote] = only(feed, 'turn.end')
  assert.doesNotMatch(mine.model, /untrusted|\n/i)
  assert.equal(remote.place, 'remote')
  assert.equal('model' in remote, false)
})

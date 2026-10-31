import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ACK_SYSTEM, ACK_TIMEOUT_MS, ackPrompt, cleanAck, install as installBusyAck, shouldNoteBusyAck,
} from '../src/host/busy-ack.js'
import { install as installStore } from '../src/host/store.js'

// A mocked model (#1665): records every call and answers with `reply(prompt)`, after
// `delay` ms; `fail` makes the stream end in an error, `hang` never ends until aborted.
const mockLlm = ({ reply = () => '在跑命令，周报的图我改完就接着看。', delay = 0, fail = false, hang = false } = {}) => {
  const calls = []
  return {
    calls,
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } },
    async* stream(options) {
      calls.push(options)
      if (hang) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (fail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }; return }
      yield { type: 'text-delta', index: 0, text: reply(options.messages[0].content[0].text) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
const session = id => ({ id, requestHeader: () => ({ config: { provider: 'p', model: 'big' } }), deriveMessages: () => [] })

const harness = (live, llm = mockLlm(), config) => {
  const listeners = new Map()
  const rt = { live, config, chatOwners: new Map([...live.keys()].map(id => [id, id])) }
  const ctx = { llm, on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) } }
  return { rt: Object.assign(rt, { ctx }), llm, emit: (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) } }
}
const say = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

test('the template generator is gone: no quoted echo, no truncation helpers', () => {
  const source = readFileSync(new URL('../src/host/busy-ack.js', import.meta.url), 'utf8')
  for (const gone of ['TEMPLATES', 'topicOf', 'TOPIC_MAX', 'composeBusyAck', '记下了']) assert.ok(!source.includes(gone), gone)
})

test('shouldNoteBusyAck only for user messages during an own-chat running turn', () => {
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: true }), true)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: false, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: false }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'bot', turnRunning: true, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: undefined, turnRunning: true, ownChat: true }), false)
})

test('the prompt asks for the user\'s language, the real content, no quoting, no stock phrases', () => {
  assert.match(ACK_SYSTEM, /same language/)
  assert.match(ACK_SYSTEM, /Do not quote/)
  assert.match(ACK_SYSTEM, /stock phrases/)
  const prompt = ackPrompt({ message: '那些 needs-human 的 issue 帮我过一遍', tool: 'bash', working: '修 CI' })
  assert.match(prompt, /needs-human/)
  assert.match(prompt, /`bash`/)
  assert.match(prompt, /修 CI/)
  assert.doesNotMatch(ackPrompt({ message: 'x', tool: 'ask_user' }), /ask_user/)
})

test('cleanAck keeps one line, strips wrapping quotes, drops empty or overlong answers', () => {
  assert.equal(cleanAck('「好，我先把 CI 修完再看那些 issue。」\nextra'), '好，我先把 CI 修完再看那些 issue。')
  assert.equal(cleanAck('   '), '')
  assert.equal(cleanAck('x'.repeat(500)), '')
})

test('the ack is published pending at once, then filled by one short model call', async () => {
  const live = new Map([['a', { turn: 1, tool: 'bash' }]])
  const { rt, llm, emit } = harness(live)
  installBusyAck(rt)
  assert.deepEqual(rt.busyAcksView(), {})
  emit('session/event', session('a'), say('帮我把周报的数据图再改一下'))
  assert.equal(rt.busyAcksView().a.text, '', 'pending: the client draws dots')
  assert.equal(await settleAck(rt, 'a'), '在跑命令，周报的图我改完就接着看。')
  assert.equal(rt.busyAcksView().a.text, '在跑命令，周报的图我改完就接着看。')
  assert.equal(llm.calls.length, 1)
  const call = llm.calls[0]
  assert.equal(call.model, 'big')
  assert.equal(call.reasoningEffort, 'off')
  assert.equal(call.system, ACK_SYSTEM)
  assert.ok(call.maxTokens <= 100)
  assert.match(call.messages[0].content[0].text, /周报的数据图/)
  assert.match(call.messages[0].content[0].text, /`bash`/)

  // Coalesced: a second line inside the window keeps the one ack and makes no call.
  const at = rt.busyAcksView().a.at
  emit('session/event', session('a'), say('again'))
  assert.equal(llm.calls.length, 1)
  assert.ok(rt.busyAcksView().a.at >= at)

  emit('session/event', session('a'), { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '详细回复' }] } } })
  assert.deepEqual(rt.busyAcksView(), {})
})

test('a configured economy model is used for the ack', async () => {
  const live = new Map([['a', { turn: 1 }]])
  const { rt, llm, emit } = harness(live, mockLlm(), { flybot: { modelFor: { 'busy-ack': 'p/flash' } } })
  installBusyAck(rt)
  emit('session/event', session('a'), say('check the deploy logs'))
  await settleAck(rt, 'a')
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(llm.calls[0].model, 'flash')
})

test('an error, a timeout or a too-slow model sends no text; the pending ack clears with the turn', async () => {
  for (const llm of [mockLlm({ fail: true }), mockLlm({ hang: true }), mockLlm({ delay: ACK_TIMEOUT_MS + 500 })]) {
    const live = new Map([['a', { turn: 1 }]])
    const { rt, emit } = harness(live, llm)
    installBusyAck(rt)
    const started = Date.now()
    emit('session/event', session('a'), say('还在吗，顺便看下日志'))
    assert.equal(await settleAck(rt, 'a'), '')
    assert.ok(Date.now() - started < ACK_TIMEOUT_MS + 400, 'bounded by the hard timeout')
    assert.equal(rt.busyAcksView().a.text, '')
    emit('session/event', session('a'), { type: 'turn/end', data: { turn: 1 } })
    assert.deepEqual(rt.busyAcksView(), {})
  }
})

test('a late answer never revives a cleared ack', async () => {
  const live = new Map([['a', { turn: 2 }]])
  const { rt, emit } = harness(live, mockLlm({ delay: 50 }))
  installBusyAck(rt)
  emit('session/event', session('a'), say('one more'))
  const ready = rt.busyAckReady('a')
  emit('agent/status', { agent: { session: { id: 'a' } }, status: 'idle' })
  await ready
  assert.deepEqual(rt.busyAcksView(), {})
})

test('no model route means no call and no text', async () => {
  const live = new Map([['a', { turn: 1 }]])
  const { rt, llm, emit } = harness(live)
  installBusyAck(rt)
  emit('session/event', { id: 'a' }, say('hello there'))
  assert.equal(await settleAck(rt, 'a'), '')
  assert.equal(llm.calls.length, 0)
})

const settleAck = async (rt, id) => (await rt.busyAckReady(id)) ?? ''

// --- The room side (#1646) -------------------------------------------------
// A group's member speaks from a hidden Session (`room.sessions[botId]`), and the person's line
// reaches it as a relayed `role: 'room'` message, not as `source.kind === 'user'`. These tests
// run the real store beside the real busy-ack install, so `chatOwners` and `groupOwners` are the
// host's own indexes; only `live` is seeded, as turns.js would have recorded a running turn.
const roomHost = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-busy-ack-room-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify({
    version: 2,
    mainBotIds: ['a'],
    members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
    bots: {
      a: { id: 'a', name: 'Chief', sessionId: 'a', ownerId: 'owner-1', createdAt: 1 },
      b: { id: 'b', name: 'Writer', sessionId: 'b', ownerId: 'owner-1', createdAt: 2 },
    },
    rooms: {
      r1: {
        id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true,
        sessions: { b: 'gb' }, log: [], seq: 0, seen: {},
      },
    },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(execute) { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose) },
    llm: mockLlm({ reply: prompt => `ACK:${prompt.split('New message: ')[1]}` }),
    on(name, fn) { const list = listeners.get(name) ?? listeners.set(name, []).get(name); list.push(fn); return () => {} },
  }
  const rt = {
    ctx, home: dir, statePath,
    autoRoomName: () => 'Room', retitleRoom: async () => {}, dropGroupSession: () => {}, warn: () => {},
  }
  installStore(rt)
  await rt.load()
  rt.live = new Map()
  installBusyAck(rt)
  t.after(() => {
    for (const dispose of disposers.splice(0)) dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  const fire = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  const emit = (id, type, data) => fire('session/event', session(id), { type, seq: 1, data })
  return { rt, llm: ctx.llm, emit, fire, chatOwners: rt.chatOwners, groupOwners: rt.groupOwners }
}

// The relay a person's line takes into a member's group Session (delivery.js + groups.js).
const roomSay = text => ({
  type: 'user/message',
  data: {
    source: { kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', exchangeId: 'x1', senderName: 'You', hop: 0 },
    content: [{ type: 'text', text: `[Group chat "Ops" · new message from the user]\n${text}` }],
  },
})

test('the indexes the room case leans on are the store\'s own (#1646)', async (t) => {
  const host = await roomHost(t)
  assert.equal(host.chatOwners.get('b'), 'b')
  assert.equal(host.chatOwners.has('gb'), false)
  assert.deepEqual(host.groupOwners.get('gb'), { botId: 'b', roomId: 'r1' })
})

test('a room line steered into a running member\'s Session notes one ack for that Session (#1646)', async (t) => {
  const host = await roomHost(t)
  host.rt.live.set('gb', { turn: 1, tool: 'bash' })
  host.emit('gb', 'turn/start', { turn: 1 })
  // groups.js relays a mid-line as a steer, so the line reaches the running member as a
  // `next-step` splice: the arrival is the ack, and the claim at the next step adds nothing (#1698).
  const line = { ...roomSay('帮我把周报再改一下').data, id: 'm-1' }
  host.emit('gb', 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [line] })
  const acks = host.rt.busyAcksView()
  assert.deepEqual(Object.keys(acks), ['gb'])
  assert.equal(acks.gb.text, '')
  assert.equal(await settleAck(host.rt, 'gb'), 'ACK:帮我把周报再改一下')
  assert.doesNotMatch(host.llm.calls[0].messages[0].content[0].text, /Group chat/)
  // Coalesced: a second line inside the window keeps the one ack.
  const at = acks.gb.at
  host.emit('gb', 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ ...roomSay('again').data, id: 'm-2' }] })
  assert.deepEqual(Object.keys(host.rt.busyAcksView()), ['gb'])
  assert.equal(host.rt.busyAcksView().gb.text, 'ACK:帮我把周报再改一下')
  assert.ok(host.rt.busyAcksView().gb.at >= at)
  assert.equal(host.llm.calls.length, 1, 'two lines inside the window keep one call')
  // The claim of the line that opened the turn is not a second line.
  host.emit('gb', 'user/message', line)
  await settleAck(host.rt, 'gb')
  assert.equal(host.llm.calls.length, 1, 'the claim of an acked line adds no call')
  // No ack survives the turn.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(host.rt.busyAcksView(), {})
  host.rt.live.set('gb', { turn: 2 })
  host.emit('gb', 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ ...roomSay('还在吗').data, id: 'm-3' }] })
  assert.ok(host.rt.busyAcksView().gb)
  host.fire('agent/status', { agent: { session: { id: 'gb' } }, status: 'idle' })
  assert.deepEqual(host.rt.busyAcksView(), {})
})

test('a room line to an idle member, and a line another Bot relayed, note nothing (#1646)', async (t) => {
  const host = await roomHost(t)
  host.emit('gb', 'user/message', roomSay('没有 turn').data)
  assert.deepEqual(host.rt.busyAcksView(), {})
  host.rt.live.set('gb', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  const fromBot = roomSay('another Bot called you')
  fromBot.data.source.senderSessionId = 'a'
  fromBot.data.source.askedBy = 'a'
  host.emit('gb', 'user/message', fromBot.data)
  assert.deepEqual(host.rt.busyAcksView(), {})
})

test('the room view names a running member before its line lands, then carries the line (#1646)', async (t) => {
  const host = await roomHost(t)
  host.rt.live.set('gb', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  // The member's turn is already running while the person's line is still being composed:
  // an empty text, which the client draws as the pending blinking indicator, no sentence.
  assert.deepEqual(host.rt.roomBusyAcksView({ b: 'gb' }), { b: { text: '', at: 0 } })
  host.emit('gb', 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ ...roomSay('帮我把周报再改一下').data, id: 'm-1' }] })
  await settleAck(host.rt, 'gb')
  assert.equal(host.rt.roomBusyAcksView({ b: 'gb' }).b.text, 'ACK:帮我把周报再改一下')
  // No running turn, no entry; an empty member map stays empty.
  host.rt.live.delete('gb')
  assert.deepEqual(host.rt.roomBusyAcksView({ b: 'gb' }), {})
  assert.deepEqual(host.rt.roomBusyAcksView({}), {})
})

test('the own-chat ack is unchanged beside the room path (#1646)', async (t) => {
  const host = await roomHost(t)
  // A line that lands while the turn runs, at its arrival as DSH queues it (#1678).
  host.rt.live.set('b', { turn: 1, tool: 'bash' })
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ ...say('check the logs').data, id: 'm-own' }] })
  const acks = host.rt.busyAcksView()
  assert.deepEqual(Object.keys(acks), ['b'])
  assert.equal(await settleAck(host.rt, 'b'), 'ACK:check the logs')
  // The same Session id space: a room line in the member's group Session is its own key.
  host.rt.live.set('gb', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ ...roomSay('帮我看日志').data, id: 'm-room' }] })
  await settleAck(host.rt, 'gb')
  assert.deepEqual(Object.keys(host.rt.busyAcksView()).sort(), ['b', 'gb'])
})

test('the prompt bounds keep whole characters at 600 and 1,500 (#P282b)', () => {
  const sourceTask = 'w'.repeat(599) + '😀tail'
  const sourceMessage = 'a'.repeat(1_499) + '😀tail'
  const prompt = ackPrompt({ message: sourceMessage, tool: 'bash', working: sourceTask })
  assert.ok(prompt.isWellFormed(), `the prompt is not well formed: ${JSON.stringify(prompt.slice(-8))}`)
  const lines = prompt.split('\n')
  const keptTask = lines.find(line => line.startsWith('The request being worked on: ')).slice('The request being worked on: '.length)
  const keptMessage = lines[lines.length - 1].slice('New message: '.length)
  assert.equal(keptTask, 'w'.repeat(599))
  assert.equal(keptMessage, 'a'.repeat(1_499))
  assert.ok(keptTask.length <= 600)
  assert.ok(keptMessage.length <= 1_500)
  const bytesOf = value => Buffer.from(value, 'utf8')
  assert.ok(bytesOf(sourceTask).subarray(0, bytesOf(keptTask).length).equals(bytesOf(keptTask)))
  assert.ok(bytesOf(sourceMessage).subarray(0, bytesOf(keptMessage).length).equals(bytesOf(keptMessage)))
})

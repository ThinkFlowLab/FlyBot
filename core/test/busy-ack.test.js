import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ackLanguage, composeBusyAck, doingOf, install as installBusyAck, shouldNoteBusyAck, topicOf,
} from '../src/host/busy-ack.js'
import { install as installStore } from '../src/host/store.js'

// The pre-#1629 canned lines; an ack must never be either verbatim.
const OLD_ZH = '收到，我先记着，手头忙完再详细回你。'
const OLD_EN = 'Got it — I’ll answer properly once I finish what’s in progress.'

const harness = (live, uiLanguage = 'English') => {
  const listeners = new Map()
  const rt = { live, chatOwners: new Map([...live.keys()].map(id => [id, id])), uiLanguage: () => uiLanguage }
  const ctx = { on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) } }
  return { rt: Object.assign(rt, { ctx }), emit: (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) } }
}
const say = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

test('the ack language follows the message, then the UI language', () => {
  assert.equal(ackLanguage('帮我看下日志', 'English'), 'zh')
  assert.equal(ackLanguage('check the logs please', 'Chinese (简体中文)'), 'en')
  assert.equal(ackLanguage('👍', 'zh-CN'), 'zh')
  assert.equal(ackLanguage('', 'English'), 'en')
})

test('topicOf clips the first line and drops filler', () => {
  assert.equal(topicOf('帮我改周报\n第二行', 'zh'), '帮我改周报')
  assert.equal(topicOf('在吗', 'zh'), '')
  assert.equal(topicOf('hi', 'en'), '')
  const long = topicOf('Can you also check the deploy logs for the staging cluster?', 'en')
  assert.ok([...long].length <= 36 && long.endsWith('…'), long)
})

test('doingOf names the running tool in words', () => {
  assert.equal(doingOf('bash', 'zh'), '跑命令')
  assert.equal(doingOf('wait_job', 'en'), 'waiting on a job')
  assert.equal(doingOf('ask_user', 'en'), undefined)
  assert.equal(doingOf(undefined, 'en'), undefined)
  assert.equal(doingOf('frobnicate', 'en'), 'using frobnicate')
})

test('composeBusyAck reflects the message and the tool, one line, never the canned sentence', () => {
  const zh = composeBusyAck({ message: '帮我把周报的数据图再改一下', tool: 'bash' })
  assert.match(zh, /周报/)
  assert.match(zh, /跑命令/)
  const en = composeBusyAck({ message: 'Can you check the deploy logs?', tool: 'wait_job' })
  assert.match(en, /deploy logs/)
  assert.match(en, /waiting on a job/)
  for (const message of ['在吗', 'hello', '帮我查下天气', 'ship it', '']) {
    for (const tool of [undefined, 'bash', 'web_fetch']) {
      for (let seed = 0; seed < 6; seed += 1) {
        const text = composeBusyAck({ message, tool, seed, uiLanguage: 'Chinese' })
        assert.notEqual(text, OLD_ZH)
        assert.notEqual(text, OLD_EN)
        assert.ok(!text.includes('\n') && [...text].length <= 90, text)
      }
    }
  }
})

test('composeBusyAck never repeats the previous ack', () => {
  let previous
  for (let seed = 0; seed < 10; seed += 1) {
    const text = composeBusyAck({ message: '在吗', seed: 0, previous })
    assert.notEqual(text, previous)
    previous = text
  }
})

test('shouldNoteBusyAck only for a human line in an own chat while a turn runs', () => {
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: true }), true)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: false, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: false }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'bot', turnRunning: true, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: undefined, turnRunning: true, ownChat: true }), false)
})

test('install composes the ack from the message and the live tool, coalesces, clears on spoken text', async () => {
  const { install } = await import('../src/host/busy-ack.js')
  const live = new Map([['a', { turn: 1, tool: 'bash' }]])
  const { rt, emit } = harness(live, 'English')
  install(rt)
  assert.deepEqual(rt.busyAcksView(), {})

  emit('session/event', { id: 'a' }, say('帮我把周报再改一下'))
  const acks = rt.busyAcksView()
  assert.match(acks.a.text, /周报/)
  assert.match(acks.a.text, /跑命令/)
  assert.notEqual(acks.a.text, OLD_ZH)
  assert.ok(typeof acks.a.at === 'number')

  const at = acks.a.at
  emit('session/event', { id: 'a' }, say('again'))
  assert.equal(Object.keys(rt.busyAcksView()).length, 1)
  assert.equal(rt.busyAcksView().a.text, acks.a.text)
  assert.ok(rt.busyAcksView().a.at >= at)

  live.delete('a')
  emit('session/event', { id: 'a' }, say('idle'))
  assert.ok(rt.busyAcksView().a)

  live.set('a', { turn: 1 })
  emit('session/event', { id: 'a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '详细回复' }] } } })
  assert.deepEqual(rt.busyAcksView(), {})
})

test('consecutive acks in one chat differ, and clear on turn/end and agent idle', async () => {
  const { install } = await import('../src/host/busy-ack.js')
  const live = new Map([['a', { turn: 2 }]])
  const { rt, emit } = harness(live, 'English')
  install(rt)
  const seen = []
  for (let round = 0; round < 4; round += 1) {
    emit('session/event', { id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' } } })
    const text = rt.busyAcksView().a.text
    assert.notEqual(text, OLD_EN)
    if (seen.length) assert.notEqual(text, seen.at(-1))
    seen.push(text)
    emit('session/event', { id: 'a' }, { type: 'turn/end', data: { turn: 2 } })
    assert.deepEqual(rt.busyAcksView(), {})
  }
  emit('session/event', { id: 'a' }, say('one more'))
  assert.ok(rt.busyAcksView().a)
  emit('agent/status', { agent: { session: { id: 'a' } }, status: 'idle' })
  assert.deepEqual(rt.busyAcksView(), {})
})

// The quoted topic is the person's own text: a `{d}` / `{t}` they typed is not template
// markup and must be echoed unchanged. Messages stay short on purpose — topicOf() clips
// at TOPIC_MAX, and a long sentence would hide the rewrite behind the ellipsis.
test('a {d} typed in the message is quoted back verbatim, with and without a running tool', () => {
  for (const message of ['改 {d} 这行', 'fix "{d}" here']) {
    for (const tool of ['bash', undefined]) {
      for (let seed = 0; seed < 6; seed += 1) {
        const text = composeBusyAck({ message, tool, seed, uiLanguage: 'zh-CN' })
        assert.ok(text.includes('{d}'), `${message} / ${tool ?? 'no tool'} / seed ${seed}: ${text}`)
        assert.ok(text.includes(topicOf(message, ackLanguage(message, 'zh-CN'))), `${message} / seed ${seed}: ${text}`)
      }
    }
  }
})

test('a {t} typed in the message is quoted back verbatim, with and without a running tool', () => {
  for (const message of ['改 {t} 这行', 'fix "{t}" here']) {
    for (const tool of ['bash', undefined]) {
      for (let seed = 0; seed < 6; seed += 1) {
        const text = composeBusyAck({ message, tool, seed, uiLanguage: 'zh-CN' })
        assert.ok(text.includes('{t}'), `${message} / ${tool ?? 'no tool'} / seed ${seed}: ${text}`)
        assert.ok(text.includes(topicOf(message, ackLanguage(message, 'zh-CN'))), `${message} / seed ${seed}: ${text}`)
      }
    }
  }
})

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
  const emit = (id, type, data) => fire('session/event', { id }, { type, seq: 1, data })
  return { rt, emit, fire, chatOwners: rt.chatOwners, groupOwners: rt.groupOwners }
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
  host.emit('gb', 'user/message', roomSay('帮我把周报再改一下').data)
  const acks = host.rt.busyAcksView()
  assert.deepEqual(Object.keys(acks), ['gb'])
  assert.match(acks.gb.text, /周报/)
  assert.match(acks.gb.text, /跑命令/)
  assert.doesNotMatch(acks.gb.text, /Group chat/)
  // Coalesced: a second line inside the window keeps the one ack.
  const at = acks.gb.at
  host.emit('gb', 'user/message', roomSay('again').data)
  assert.deepEqual(Object.keys(host.rt.busyAcksView()), ['gb'])
  assert.equal(host.rt.busyAcksView().gb.text, acks.gb.text)
  assert.ok(host.rt.busyAcksView().gb.at >= at)
  // No ack survives the turn.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(host.rt.busyAcksView(), {})
  host.rt.live.set('gb', { turn: 2 })
  host.emit('gb', 'user/message', roomSay('还在吗').data)
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
  host.emit('gb', 'user/message', roomSay('帮我把周报再改一下').data)
  assert.match(host.rt.roomBusyAcksView({ b: 'gb' }).b.text, /周报/)
  assert.doesNotMatch(host.rt.roomBusyAcksView({ b: 'gb' }).b.text, /Group chat/)
  // No running turn, no entry; an empty member map stays empty.
  host.rt.live.delete('gb')
  assert.deepEqual(host.rt.roomBusyAcksView({ b: 'gb' }), {})
  assert.deepEqual(host.rt.roomBusyAcksView({}), {})
})

test('the own-chat ack is unchanged beside the room path (#1646)', async (t) => {
  const host = await roomHost(t)
  host.rt.live.set('b', { turn: 1, tool: 'bash' })
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', say('check the logs').data)
  const acks = host.rt.busyAcksView()
  assert.deepEqual(Object.keys(acks), ['b'])
  assert.match(acks.b.text, /check the logs/)
  // The same Session id space: a room line in the member's group Session is its own key.
  host.rt.live.set('gb', { turn: 1 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', roomSay('帮我看日志').data)
  assert.deepEqual(Object.keys(host.rt.busyAcksView()).sort(), ['b', 'gb'])
})

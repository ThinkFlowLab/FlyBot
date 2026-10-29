import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ackLanguage, composeBusyAck, doingOf, shouldNoteBusyAck, topicOf,
} from '../src/host/busy-ack.js'

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

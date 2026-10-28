import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUSY_ACK_EN, BUSY_ACK_ZH, busyAckText, shouldNoteBusyAck,
} from '../src/host/busy-ack.js'

test('busyAckText follows the UI language', () => {
  assert.equal(busyAckText('English'), BUSY_ACK_EN)
  assert.equal(busyAckText('Chinese (简体中文)'), BUSY_ACK_ZH)
  assert.equal(busyAckText('zh-CN'), BUSY_ACK_ZH)
})

test('shouldNoteBusyAck only for a human line in an own chat while a turn runs', () => {
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: true }), true)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: false, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'user', turnRunning: true, ownChat: false }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: 'bot', turnRunning: true, ownChat: true }), false)
  assert.equal(shouldNoteBusyAck({ sourceKind: undefined, turnRunning: true, ownChat: true }), false)
})

test('install notes a human message while a turn runs and clears on spoken assistant text', async () => {
  const { install } = await import('../src/host/busy-ack.js')
  const listeners = new Map()
  const live = new Map([['a', { turn: 1 }]])
  const chatOwners = new Map([['a', 'a']])
  const rt = {
    live,
    chatOwners,
    uiLanguage: () => 'Chinese (简体中文)',
  }
  const ctx = {
    on(name, fn) {
      (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn)
    },
  }
  install(Object.assign(rt, { ctx }))
  assert.deepEqual(rt.busyAcksView(), {})

  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } })
  }
  const acks = rt.busyAcksView()
  assert.equal(acks.a.text, BUSY_ACK_ZH)
  assert.ok(typeof acks.a.at === 'number')

  // A second burst within the coalesce window keeps one ack.
  const at = acks.a.at
  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } })
  }
  assert.equal(Object.keys(rt.busyAcksView()).length, 1)
  assert.ok(rt.busyAcksView().a.at >= at)

  // Idle agent with no turn does not note.
  live.delete('a')
  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'idle' }] } })
  }
  assert.ok(rt.busyAcksView().a)

  // Spoken assistant text clears the ack.
  live.set('a', { turn: 1 })
  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '详细回复' }] } } })
  }
  assert.deepEqual(rt.busyAcksView(), {})
})

test('install clears on turn/end and agent idle', async () => {
  const { install, BUSY_ACK_EN } = await import('../src/host/busy-ack.js')
  const listeners = new Map()
  const live = new Map([['a', { turn: 2 }]])
  const rt = {
    live,
    chatOwners: new Map([['a', 'a']]),
    uiLanguage: () => 'English',
  }
  const ctx = {
    on(name, fn) {
      (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn)
    },
  }
  install(Object.assign(rt, { ctx }))
  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  }
  assert.equal(rt.busyAcksView().a.text, BUSY_ACK_EN)

  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'turn/end', data: { turn: 2 } })
  }
  assert.deepEqual(rt.busyAcksView(), {})

  for (const fn of listeners.get('session/event')) {
    fn({ id: 'a' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  }
  assert.ok(rt.busyAcksView().a)
  for (const fn of listeners.get('agent/status')) {
    fn({ agent: { session: { id: 'a' } }, status: 'idle' })
  }
  assert.deepEqual(rt.busyAcksView(), {})
})

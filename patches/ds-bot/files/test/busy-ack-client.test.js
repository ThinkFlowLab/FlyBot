import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as logic from '../src/client/busy-ack-logic.js'

const { busyAckPending, busyAckText, busyAckVisible, pendingBusyPlacement } = logic

test('pendingBusyPlacement is true for queued or steering submissions', () => {
  assert.equal(pendingBusyPlacement([]), false)
  assert.equal(pendingBusyPlacement(undefined), false)
  assert.equal(pendingBusyPlacement([{ placement: 'transcript' }]), false)
  assert.equal(pendingBusyPlacement([{ placement: 'queued' }]), true)
  assert.equal(pendingBusyPlacement([{ placement: 'steering' }]), true)
  assert.equal(pendingBusyPlacement([{ placement: 'transcript' }, { placement: 'queued' }]), true)
})

test('busyAckVisible prefers host or pending ack and hides once spoken text streams', () => {
  assert.equal(busyAckVisible({ hostAck: null, pendingBusy: false, streamingText: false }), false)
  assert.equal(busyAckVisible({ hostAck: { text: '收到' }, pendingBusy: false, streamingText: false }), true)
  assert.equal(busyAckVisible({ hostAck: null, pendingBusy: true, streamingText: false }), true)
  assert.equal(busyAckVisible({ hostAck: { text: '收到' }, pendingBusy: true, streamingText: true }), false)
  assert.equal(busyAckVisible({ hostAck: { text: '   ' }, pendingBusy: false, streamingText: false }), false)
})

test('#1656: while the host ack is pending there is no text at all, and the host line shows when it lands', () => {
  assert.equal('BUSY_ACK_KEY' in logic, false, 'the canned fallback key is gone')
  assert.equal(busyAckText(null), '')
  assert.equal(busyAckText({ text: '' }), '')
  assert.equal(busyAckPending(null), true)
  assert.equal(busyAckPending({ at: 1 }), true)
  assert.equal(busyAckText({ text: '在改周报的图，bash 跑完就看你这条' }), '在改周报的图，bash 跑完就看你这条')
  assert.equal(busyAckPending({ text: '在改周报的图' }), false)
})

test('#1656: the canned sentence is not shipped anywhere in the client', () => {
  for (const file of ['../src/client/busy-ack.js', '../src/client/busy-ack-logic.js', '../src/client/i18n.js', '../client.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.equal(source.includes('这步做完就接着处理你这条'), false, `${file} still carries the canned zh line`)
    assert.equal(source.includes('right after the current step'), false, `${file} still carries the canned en line`)
  }
  const bubble = readFileSync(new URL('../src/client/busy-ack.js', import.meta.url), 'utf8')
  assert.match(bubble, /bt-busy-dots/, 'the pending state draws the blinking indicator')
  assert.match(bubble, /'aria-busy': text \? undefined : 'true'/)
  assert.match(bubble, /@keyframes bt-busy-blink/)
})

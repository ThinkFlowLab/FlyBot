import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUSY_ACK_KEY, busyAckVisible, pendingBusyPlacement,
} from '../src/client/busy-ack-logic.js'

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
  assert.equal(BUSY_ACK_KEY.includes('answer properly once I finish'), false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  INTERRUPT_AFTER_MS, install, shouldInterruptOnHumanSend,
} from '../src/host/steering-interrupt.js'

const T0 = 1_000_000

test('the line is 60s: 59s keeps the turn, past 60s interrupts it', () => {
  const at = (elapsed) => shouldInterruptOnHumanSend({
    sourceKind: 'user', turnRunning: true, ownChat: true, waitStartedAt: T0, now: T0 + elapsed,
  })
  assert.equal(INTERRUPT_AFTER_MS, 60_000)
  assert.equal(at(0), false)
  assert.equal(at(59_000), false)
  assert.equal(at(60_000), false)
  assert.equal(at(60_001), true)
  assert.equal(at(10 * 60_000), true)
})

test('only a human line in an own chat with a turn on an open wait may interrupt', () => {
  const base = { sourceKind: 'user', turnRunning: true, ownChat: true, waitStartedAt: T0, now: T0 + 61_000 }
  assert.equal(shouldInterruptOnHumanSend(base), true)
  assert.equal(shouldInterruptOnHumanSend({ ...base, sourceKind: 'bot' }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, sourceKind: 'schedule' }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, turnRunning: false }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, ownChat: false }), false)
  assert.equal(shouldInterruptOnHumanSend({ ...base, waitStartedAt: undefined }), false)
})

function bench() {
  const listeners = new Map()
  const cancels = []
  let clock = T0
  const rt = {
    live: new Map([['a', { turn: 1 }]]),
    chatOwners: new Map([['a', 'a']]),
    now: () => clock,
    resolveAgent: async () => ({ cancel: (cause, options) => cancels.push({ id: 'a', cause, options }) }),
  }
  rt.ctx = { on: (name, fn) => (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) }
  install(rt)
  const emit = (id, event) => { for (const fn of listeners.get('session/event') ?? []) fn({ id }, event) }
  return { emit, cancels, advance: ms => { clock += ms }, rt }
}

const toolCall = (callId, at) => ({ type: 'tool/call', time: at, data: { callId, name: 'bash' } })
// The host writes a result as `{ message: ToolResultMessage }`, so the call id arrives on
// the message and never at the top level of `data` (DSH's `tool/result` event map).
const toolResult = (callId, at) => ({ type: 'tool/result', time: at, data: { message: { role: 'tool', toolCallId: callId, isError: false, content: [] } } })
const toolResultTopLevelId = (callId, at) => ({ type: 'tool/result', time: at, data: { callId } })
const human = (at) => ({ type: 'user/message', time: at, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] } })

test('a human line 59s into a foreground wait does not abort the turn', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.advance(59_000)
  b.emit('a', human(T0 + 59_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

test('a human line past 60s aborts exactly once, keeping the inbox, and the message is not lost', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  b.emit('a', human(T0 + 61_100))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 1)
  assert.deepEqual(b.cancels[0].options, { keepInbox: true })
  assert.equal(b.cancels[0].cause.kind, 'hook')
})

test('a finished wait, a group Session and an idle Session never interrupt', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 1_000))
  b.advance(120_000)
  b.emit('a', human(T0 + 120_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)

  // A group room the Bot speaks in is not the human's own chat.
  b.rt.chatOwners.delete('a')
  b.emit('a', toolCall('c2', T0 + 120_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 181_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)

  // No turn in flight: the line starts a fresh turn by itself.
  b.rt.chatOwners.set('a', 'a')
  b.rt.live.delete('a')
  b.emit('a', toolCall('c3', T0 + 181_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 242_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

test("a landed tool result closes its wait, so a long turn is not read as a long wait (#1644)", async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 5_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

test('a closed wait does not age a later call in the same turn (#1644)', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResult('c1', T0 + 5_000))
  b.emit('a', toolCall('c2', T0 + 100_000))
  b.advance(130_000)
  b.emit('a', human(T0 + 130_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
  // The same call is still a wait once it has run past the line.
  b.advance(31_000)
  b.emit('a', human(T0 + 161_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 1)
})

test('a result that names its call id at the top of data still closes the wait', async () => {
  const b = bench()
  b.emit('a', toolCall('c1', T0))
  b.emit('a', toolResultTopLevelId('c1', T0 + 5_000))
  b.advance(61_000)
  b.emit('a', human(T0 + 61_000))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.cancels.length, 0)
})

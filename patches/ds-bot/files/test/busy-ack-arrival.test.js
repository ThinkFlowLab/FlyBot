// The arrival side of the busy ack (#1678). DSH queues a person's line as
// `agent/inbox/spliced` when it arrives and writes `user/message` only at the next step's
// start, when the line is claimed — production logs put that claim up to 768 s later. These
// tests drive the splice shape DSH actually appends, so a helper that hand-writes
// `user/message` as if it were arrival cannot make the case green (the shipped
// `busy-ack.test.js` helper does exactly that, which is why the defect was invisible there).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installBusyAck } from '../src/host/busy-ack.js'
import { install as installStore } from '../src/host/store.js'


const mockLlm = () => {
  const calls = []
  return {
    calls,
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } },
    async* stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: `ACK:${options.messages[0].content[0].text.split('New message: ')[1]}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

// The real store beside the real busy-ack install: `chatOwners` and `groupOwners` are the
// host's own indexes, and only `live` is seeded, as turns.js records a running turn.
const host = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-busy-ack-arrival-'))
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
  const listeners = new Map()
  const llm = mockLlm()
  const rt = {
    ctx: {
      llm,
      logger: { warn() {}, info() {} },
      effect(execute) { return execute() },
      on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn) },
    },
    home: dir, statePath,
    autoRoomName: () => 'Room', retitleRoom: async () => {}, dropGroupSession: () => {}, warn: () => {},
  }
  installStore(rt)
  await rt.load()
  rt.live = new Map()
  installBusyAck(rt)
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const emit = (id, type, data) => {
    for (const fn of listeners.get('session/event') ?? []) fn({ id, requestHeader: () => ({ config: { provider: 'p', model: 'big' } }), deriveMessages: () => [] }, { type, seq: 1, data })
  }
  return { rt, llm, emit, fire: (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }, chatOwners: rt.chatOwners, groupOwners: rt.groupOwners }
}

// A message the person sent, shaped as DSH builds it before it is spliced into an inbox.
const personLine = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', source, content: [{ type: 'text', text }] })

// What DSH appends when the line is queued: `inserted` holds the whole message, `target`
// says which inbox it went to (a follow-up waits in `next-turn`; a steer cuts into `next-step`).
const spliced = (messages, target = 'next-turn') => ({ type: 'agent/inbox/spliced', data: { target, start: 0, inserted: messages } })

// The same line at the claim, when the next step starts: the event data is the message.
const claim = message => ({ type: 'user/message', data: message })

test('own chat: a line spliced into a busy turn is acknowledged at arrival, one call (#1678)', async (t) => {
  const h = await host(t)
  h.rt.live.set('a', { turn: 1, tool: 'bash' })
  h.emit('a', 'turn/start', { turn: 1 })
  const line = personLine('m-1', '先把周报发我，然后改一下封面那张图')

  h.emit('a', 'agent/inbox/spliced', spliced([line]).data)
  // At arrival, before any claim: the dots exist at once, and the sentence is on its way.
  assert.deepEqual(Object.keys(h.rt.busyAcksView()), ['a'])
  assert.equal(h.rt.busyAcksView().a.text, '', 'the dots exist before the claim and before any model answer')
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:先把周报发我，然后改一下封面那张图')
  assert.equal(h.llm.calls.length, 1)
  assert.equal(h.rt.busyAcksView().a.text, 'ACK:先把周报发我，然后改一下封面那张图')
  assert.match(h.llm.calls[0].messages[0].content[0].text, /先把周报发我/)
  assert.match(h.llm.calls[0].messages[0].content[0].text, /`bash`/)
})

test('the claim of an already-acknowledged line makes no second ack or call (#1678)', async (t) => {
  const h = await host(t)
  h.rt.live.set('a', { turn: 1, tool: 'bash' })
  h.emit('a', 'turn/start', { turn: 1 })
  const line = personLine('m-1', '先把周报发我')
  h.emit('a', 'agent/inbox/spliced', spliced([line]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:先把周报发我')
  const at = h.rt.busyAcksView().a.at
  assert.equal(h.llm.calls.length, 1)

  // The claim can be minutes later than the arrival; the line, not the clock, is the key.
  t.mock.timers.enable({ apis: ['Date'], now: at })
  t.mock.timers.tick(768_000)
  h.emit('a', 'user/message', claim(line).data)
  assert.deepEqual(Object.keys(h.rt.busyAcksView()), ['a'])
  assert.equal(h.rt.busyAcksView().a.text, 'ACK:先把周报发我')
  assert.equal(h.rt.busyAcksView().a.at, at, 'the arrival time is the ack time')
  assert.equal(h.llm.calls.length, 1, 'no second model call')

  // A different line during the same turn is a new ack, as before.
  h.emit('a', 'agent/inbox/spliced', spliced([personLine('m-2', '还有那张封面')]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:还有那张封面')
  assert.equal(h.llm.calls.length, 2)
})

test('no turn, or a line steered into the running turn, notes nothing (#1678)', async (t) => {
  const h = await host(t)
  // Idle: no turn to acknowledge.
  h.emit('a', 'agent/inbox/spliced', spliced([personLine('m-1', 'hello')]).data)
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)

  // A steer is admitted at the running turn's next step, so nothing waits and nothing is acked;
  // only the `next-turn` queue is the silent path this fix covers.
  h.rt.live.set('a', { turn: 1, tool: 'bash' })
  h.emit('a', 'turn/start', { turn: 1 })
  h.emit('a', 'agent/inbox/spliced', spliced([personLine('m-2', 'steer this')], 'next-step').data)
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)
})

test('a room line reaches the member row at arrival, not only at the claim (#1678)', async (t) => {
  const h = await host(t)
  h.rt.live.set('gb', { turn: 1, tool: 'bash' })
  h.emit('gb', 'turn/start', { turn: 1 })
  const relay = { kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', exchangeId: 'x1', senderName: 'You', hop: 0 }
  const line = personLine('m-r1', '[Group chat "Ops" · new message from the user]\n帮我把周报再改一下', relay)

  h.emit('gb', 'agent/inbox/spliced', spliced([line]).data)
  const atArrival = h.rt.roomBusyAcksView({ b: 'gb' })
  assert.deepEqual(Object.keys(atArrival), ['b'])
  assert.equal(atArrival.b.text, '', 'the row shows the pending dots at arrival')
  assert.equal(await h.rt.busyAckReady('gb'), 'ACK:帮我把周报再改一下')
  assert.equal(h.llm.calls.length, 1)
  assert.doesNotMatch(h.llm.calls[0].messages[0].content[0].text, /Group chat/)

  h.emit('gb', 'user/message', claim(line).data)
  assert.equal(h.llm.calls.length, 1, 'the claim adds no second ack')
  assert.equal(h.rt.roomBusyAcksView({ b: 'gb' }).b.text, 'ACK:帮我把周报再改一下')
})

test('a splice from a Bot, a schedule or the time context notes nothing (#1678)', async (t) => {
  const h = await host(t)
  h.rt.live.set('a', { turn: 1, tool: 'bash' })
  h.emit('a', 'turn/start', { turn: 1 })
  for (const kind of ['bot', 'schedule', 'time-context']) {
    h.emit('a', 'agent/inbox/spliced', spliced([personLine(`m-${kind}`, `from ${kind}`, { kind })]).data)
  }
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)

  // The claim of such a line is not a person's line either.
  h.emit('a', 'user/message', claim(personLine('m-bot-claim', 'from a bot', { kind: 'bot' })).data)
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)
})

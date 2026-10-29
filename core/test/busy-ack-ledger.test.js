// The ledger side of the busy ack (#1684). Two shapes of the same gap:
//
// A. The ack entry dies at `turn/end` (`busyAck.js` `clear`), and the claim of a `next-turn`
//    line always lands after it (DSH appends it in the loop's `finally`), so the line's id was
//    forgotten exactly when it was needed and the same line spoke twice. These tests drive the
//    real order — splice, tool result, turn/end, turn/start, claim — and count the model calls.
// B. A room mid-line is relayed as a steer (`groups.js` `steer: true`), so it is spliced for
//    `next-step`; the member's row is the one that has to show an ack at arrival.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LEDGER_FILTER_REBUILD_AFTER, LEDGER_SESSIONS_KEPT, LINE_IDS_KEPT, install as installBusyAck } from '../src/host/busy-ack.js'
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

const host = async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-busy-ack-ledger-'))
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
  const running = (id, turn = 1) => { rt.live.set(id, { turn, tool: 'bash' }) }
  const fire = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  return { rt, llm, emit, fire, running }
}

// A message the person sent, shaped as DSH builds it before it is spliced into an inbox.
const personLine = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', source, content: [{ type: 'text', text }] })

// What DSH appends when the line is queued: a follow-up waits in `next-turn`, a steer cuts
// into `next-step` (the room mid-line relay of #1267 takes the steer path).
const spliced = (messages, target = 'next-turn') => ({ type: 'agent/inbox/spliced', data: { target, start: 0, inserted: messages } })

// The same line at the claim, when the next step starts: the event data is the message.
const claim = (message, type = 'user/message') => ({ type, data: message })

// A person's line relayed into a member's group Session (#1646), as delivery.js builds it.
const roomLine = (id, text) => personLine(id, `[Group chat "Ops" · new message from the user]\n${text}`, {
  kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', exchangeId: 'x1', senderName: 'You', hop: 0,
})

test('the claim of a next-turn line after turn/end adds no second call or sentence (#1684)', async (t) => {
  const h = await host(t)
  h.running('a')
  const line = personLine('c59bab75', '先把周报发我，然后改一下封面那张图')

  h.emit('a', 'agent/inbox/spliced', spliced([line]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:先把周报发我，然后改一下封面那张图')
  assert.equal(h.llm.calls.length, 1, 'one call at arrival')

  // The real order: the tool answers, the turn ends, the next turn starts, and only then is
  // the line claimed — the claim is written after `turn/end`, never before it.
  h.emit('a', 'tool/result', { result: 'ok' })
  h.emit('a', 'turn/end', { status: 'completed' })
  // The host may also idle the agent between the two: neither event may make the line new again.
  h.fire('agent/status', { agent: { session: { id: 'a' } }, status: 'idle' })
  assert.deepEqual(h.rt.busyAcksView(), {}, 'the dots clear with the turn, as before')
  h.running('a', 2)
  h.emit('a', 'turn/start', { turn: 2 })
  h.emit('a', 'user/message', claim(line).data)
  await h.rt.busyAckReady('a')

  assert.equal(h.llm.calls.length, 1, 'the line is acknowledged once, not once per event')
  const view = h.rt.busyAcksView()
  assert.deepEqual(Object.keys(view), [], 'a claim of an acked line does not reopen the ack it ended with the turn')
})

test('the line that opens a turn is not acknowledged as a busy arrival (#1698)', async (t) => {
  const h = await host(t)
  const opener = personLine('m-open', 'please read the AGENTS file')

  // The real order on an idle Session: the line is queued, the host opens the turn, and only then
  // is the line claimed. `turn/start` is appended before the step's `user/message` (agent-loop
  // `index.js:943` then `:1061`), so the line that started the turn is judged busy by the claim.
  h.emit('a', 'agent/inbox/spliced', spliced([opener]).data)
  h.running('a', 1)
  h.emit('a', 'turn/start', { turn: 1 })
  h.emit('a', 'user/message', claim(opener).data)
  await h.rt.busyAckReady('a')

  assert.equal(h.llm.calls.length, 0, 'the line that opened the turn costs no ack call')
  assert.deepEqual(h.rt.busyAcksView(), {}, 'and publishes no ack entry')
  assert.equal(h.rt.busyAckLedgerSize('a'), 0, 'the opening line is not remembered as acked')

  // A line that really lands while that turn runs is still acknowledged once, at its arrival.
  const busy = personLine('m-busy', 'and then the cover image')
  h.emit('a', 'agent/inbox/spliced', spliced([busy]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:and then the cover image')
  assert.equal(h.llm.calls.length, 1)

  // Its claim opens the next turn and adds no second call: the line keeps its one ack.
  h.emit('a', 'turn/end', { status: 'completed' })
  h.running('a', 2)
  h.emit('a', 'turn/start', { turn: 2 })
  h.emit('a', 'user/message', claim(busy).data)
  await h.rt.busyAckReady('a')
  assert.equal(h.llm.calls.length, 1, 'the claim of an acked line adds no call')
  assert.deepEqual(h.rt.busyAcksView(), {}, 'and does not reopen the entry the turn ended')
})

test('two lines interleaved across a turn boundary cost two calls, and their claims add none (#1684)', async (t) => {
  const h = await host(t)
  h.running('a')
  const first = personLine('m-x', '先把周报发我')
  const second = personLine('m-y', '还有那张封面')
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })

  // Both lines arrive while the same turn runs, each past the coalescing window.
  h.emit('a', 'agent/inbox/spliced', spliced([first]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:先把周报发我')
  t.mock.timers.tick(4_200)
  h.emit('a', 'agent/inbox/spliced', spliced([second]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:还有那张封面')
  assert.equal(h.llm.calls.length, 2)

  // Both claims land after the turn ended, so one entry cannot hold two ids for them.
  h.emit('a', 'turn/end', { status: 'completed' })
  assert.deepEqual(h.rt.busyAcksView(), {}, 'no ack lingers into the next turn')
  h.running('a', 2)
  h.emit('a', 'turn/start', { turn: 2 })
  for (const line of [first, second]) {
    h.emit('a', 'user/message', claim(line).data)
    await h.rt.busyAckReady('a')
    // The claims are minutes apart on the runtime, not inside the 3 s coalescing window.
    t.mock.timers.tick(4_200)
  }
  assert.equal(h.llm.calls.length, 2, 'two lines, two calls — not one id kept and the other re-acked')
  assert.deepEqual(h.rt.busyAcksView(), {}, 'neither claim reopened an ack entry')
})

test('a fresh line in the next turn is still acknowledged, exactly once (#1684)', async (t) => {
  const h = await host(t)
  h.running('a')
  const first = personLine('m-1', '先把周报发我')
  h.emit('a', 'agent/inbox/spliced', spliced([first]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:先把周报发我')
  h.emit('a', 'turn/end', { status: 'completed' })
  h.running('a', 2)
  h.emit('a', 'turn/start', { turn: 2 })
  h.emit('a', 'user/message', claim(first).data)
  await h.rt.busyAckReady('a')
  assert.equal(h.llm.calls.length, 1)

  // A line nobody has acked yet is a new line, whatever the ledger holds.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const fresh = personLine('m-2', '还有那张封面')
  h.emit('a', 'agent/inbox/spliced', spliced([fresh]).data)
  assert.equal(await h.rt.busyAckReady('a'), 'ACK:还有那张封面')
  assert.equal(h.llm.calls.length, 2, 'a new id is acknowledged once more')
  assert.equal(h.rt.busyAcksView().a.text, 'ACK:还有那张封面')
})

test('the ledger is bounded, and a pruned line id cannot resurrect its line (#1684)', async (t) => {
  const h = await host(t)
  h.running('a')
  const lines = Array.from({ length: LINE_IDS_KEPT + 4 }, (_, index) => personLine(`m-${index + 1}`, `line ${index + 1}`))

  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  for (const [index, line] of lines.entries()) {
    if (index > 0) t.mock.timers.tick(4_000)
    h.emit('a', 'agent/inbox/spliced', spliced([line]).data)
    assert.equal(await h.rt.busyAckReady('a'), `ACK:${line.content[0].text}`)
    h.emit('a', 'user/message', claim(line).data)
    await h.rt.busyAckReady('a')
  }
  assert.equal(h.llm.calls.length, lines.length, 'one call per line while the ledger is full')
  assert.ok(h.rt.busyAckLedgerSize('a') <= LINE_IDS_KEPT, 'the exact ledger stays bounded')

  // The oldest ids were pruned out of the exact set; the line memory survives the prune, so a
  // late claim of the first line is not a new line and earns nothing.
  t.mock.timers.tick(4_000)
  h.emit('a', 'user/message', claim(lines[0]).data)
  assert.equal(h.llm.calls.length, lines.length, 'a pruned id does not resurrect a line')
})

test('the filter is rebuilt from the exact set before it saturates (#1684)', async (t) => {
  const h = await host(t)
  h.running('a')
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const all = []
  const batch = (size) => {
    const lines = Array.from({ length: size }, (_, offset) => personLine(`m-${all.length + offset + 1}`, `line ${all.length + offset + 1}`))
    all.push(...lines)
    t.mock.timers.tick(4_000)
    h.emit('a', 'agent/inbox/spliced', spliced(lines).data)
  }

  // The exact set holds LINE_IDS_KEPT; every id after that is folded into the filter, and the
  // 513th fold rebuilds it — insert 16 + 513 = 529. Ending a batch there makes the freshly built
  // filter observable: it holds the exact set, so a rebuild that reset and added only the newest
  // line would leave it at zero bits.
  for (let index = 0; index < 8; index += 1) batch(60)
  batch(49)
  assert.equal(all.length, LINE_IDS_KEPT + LEDGER_FILTER_REBUILD_AFTER + 1)
  await h.rt.busyAckReady('a')
  assert.equal(h.rt.busyAckLedgerRebuilds('a'), 1, 'the filter is rebuilt once the fold count passes the threshold')
  const refilled = h.rt.busyAckLedgerFill('a')
  assert.ok(refilled > 0, 'the new filter is filled from the exact set, not from nothing')
  assert.ok(refilled <= LINE_IDS_KEPT * 3, 'a rebuilt filter holds the exact set and nothing older')

  // Well past a thousand lines: the filter is still rebuilt instead of saturating (at 12000 lines
  // an unrebuilt one answers "acked" for 97.9% of new lines, which is the ack falling silent).
  while (all.length < 1_200) batch(60)
  await h.rt.busyAckReady('a')
  assert.ok(h.rt.busyAckLedgerRebuilds('a') >= 2, 'the filter is rebuilt again as folds accumulate')
  assert.ok(h.rt.busyAckLedgerFill('a') <= (LEDGER_FILTER_REBUILD_AFTER + LINE_IDS_KEPT) * 3, 'the fill stays under the rebuild bound')

  // The lines the exact set still holds are never acked twice, whenever the claim comes.
  const calls = h.llm.calls.length
  for (const line of all.slice(-LINE_IDS_KEPT)) {
    t.mock.timers.tick(4_000)
    h.emit('a', 'user/message', claim(line).data)
    await h.rt.busyAckReady('a')
  }
  assert.equal(h.llm.calls.length, calls, 'a claim of a remembered line adds no call, rebuild or not')

  // A line nobody has seen is still acknowledged: the rebuild does not turn the ledger into a
  // one-way "everything is acked" switch.
  batch(1)
  const fresh = all[all.length - 1]
  assert.equal(await h.rt.busyAckReady('a'), `ACK:${fresh.content[0].text}`, 'a fresh line after 1200 lines still speaks')
  assert.equal(h.llm.calls.length, calls + 1)
})

test('the Session memories are bounded, and the least recently written goes first (#1684)', async (t) => {
  const h = await host(t)
  const session = { requestHeader: () => ({ config: { provider: 'p', model: 'big' } }) }
  const write = (id, lineId) => h.rt.noteBusyAck(id, 'hello', session, lineId)

  for (let index = 0; index < LEDGER_SESSIONS_KEPT + 44; index += 1) write(`s-${index}`, `m-${index}`)
  assert.equal(h.rt.busyAckLedgerSessions(), LEDGER_SESSIONS_KEPT, 'the Session map stays at its cap')
  assert.equal(h.rt.busyAckLedgerSize('s-0'), 0, 'the Session that wrote longest ago lost its memory')
  assert.equal(h.rt.busyAckLedgerSize(`s-${LEDGER_SESSIONS_KEPT + 43}`), 1, 'the newest Session is remembered')

  // Writing again is what keeps a Session in the map: the oldest survivor survives one more round.
  write(`s-${LEDGER_SESSIONS_KEPT - 1}`, 'm-again')
  write('s-later', 'm-later')
  assert.equal(h.rt.busyAckLedgerSize(`s-${LEDGER_SESSIONS_KEPT - 1}`), 2, 'a Session that writes again is not the next one dropped')
  assert.equal(h.rt.busyAckLedgerSize('s-later'), 1)
  assert.equal(h.rt.busyAckLedgerSessions(), LEDGER_SESSIONS_KEPT)
})

test('a room line steered into a speaking member is acknowledged at arrival (#1684)', async (t) => {
  const h = await host(t)
  h.running('gb')
  const line = roomLine('m-r1', '帮我把周报再改一下')
  t.mock.timers.enable({ apis: ['Date'], now: 4_836 })

  // groups.js relays a mid-line with `steer: true` (delivery.js `agent.steer`), so the splice
  // for a speaking member is a `next-step` one.
  h.emit('gb', 'agent/inbox/spliced', spliced([line], 'next-step').data)
  assert.deepEqual(Object.keys(h.rt.roomBusyAcksView({ b: 'gb' })), ['b'], 'the member row is speaking')
  assert.equal(h.rt.roomBusyAcksView({ b: 'gb' }).b.at, 4_836, 'the row is dated at the arrival, not at a claim')
  assert.equal(await h.rt.busyAckReady('gb'), 'ACK:帮我把周报再改一下', 'the row carries a sentence at arrival')
  assert.equal(h.llm.calls.length, 1)
  assert.doesNotMatch(h.llm.calls[0].messages[0].content[0].text, /Group chat/)

  // The admission of that same steered line is not a second line.
  h.emit('gb', 'user/message', claim(line).data)
  await h.rt.busyAckReady('gb')
  assert.equal(h.llm.calls.length, 1, 'the admission of a steered line adds no call')
  assert.equal(h.rt.roomBusyAcksView({ b: 'gb' }).b.text, 'ACK:帮我把周报再改一下')
})

test('a Bot line and a friend Bot line in a room stay silent at arrival (#1684)', async (t) => {
  const h = await host(t)
  h.running('gb')
  const own = personLine('m-bot1', '[Group chat "Ops"]\nmy own line', { kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', senderSessionId: 'a', senderName: 'Chief', hop: 0 })
  const friend = personLine('m-remote', '[Group chat "Ops"]\nhello', { kind: 'bot', form: 'relay', role: 'room', roomId: 'r1', senderName: 'Robin', hop: 0, remote: { handle: '@robin' } })
  for (const line of [own, friend]) h.emit('gb', 'agent/inbox/spliced', spliced([line], 'next-step').data)
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)
})

test('an idle Session and a steered own-chat line are still not acknowledged (#1684)', async (t) => {
  const h = await host(t)
  // Idle: nothing to acknowledge, even for a room member row.
  h.emit('a', 'agent/inbox/spliced', spliced([personLine('m-1', 'hello')]).data)
  h.emit('gb', 'agent/inbox/spliced', spliced([roomLine('m-2', 'room hello')], 'next-step').data)
  assert.equal(h.llm.calls.length, 0)

  // Own chat, steered into the running turn: admitted at its next step, so nothing waits.
  h.running('a')
  h.emit('a', 'agent/inbox/spliced', spliced([personLine('m-3', 'steer this')], 'next-step').data)
  assert.deepEqual(h.rt.busyAcksView(), {})
  assert.equal(h.llm.calls.length, 0)

  // Non-person sources are unchanged on both paths.
  for (const kind of ['bot', 'schedule', 'time-context']) {
    h.emit('a', 'agent/inbox/spliced', spliced([personLine(`m-${kind}`, `from ${kind}`, { kind })]).data)
  }
  assert.equal(h.llm.calls.length, 0)
})

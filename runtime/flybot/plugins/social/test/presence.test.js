import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPresence, CLAIM_MS, BEAT_MS, POLL_MS, WANTED_MS, MAX_BEATS, AFTER_MESSAGE_MS } from '../src/presence.js'

const norm = handle => { const body = String(handle ?? '').trim().replace(/^@+/, '').toLowerCase(); return body ? `@${body}` : '' }
const cleanName = (value, fallback) => String(value ?? '').replace(/[<>@]/g, '').trim() || fallback

// A clock and timers the test steers.
function clock() {
  let at = 1_000_000
  const timers = new Set()
  return {
    now: () => at,
    every: (fn, ms) => { const timer = { fn, ms, next: at + ms, unref() {} }; timers.add(timer); return timer },
    clear: timer => { timers.delete(timer) },
    count: () => timers.size,
    async advance(ms) {
      const end = at + ms
      for (;;) {
        const due = [...timers].filter(timer => timer.next <= end).sort((a, b) => a.next - b.next)[0]
        if (!due) break
        at = due.next
        due.next += due.ms
        due.fn()
        await new Promise(resolve => setImmediate(resolve))
      }
      at = end
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

function fixture({ supported = true, members = { a: 'm_a', b: 'm_b' }, rooms = [], readOnly = false, tools = {} } = {}) {
  const c = clock()
  const handlers = new Map()
  const calls = []
  const flybot = {
    readOnly: () => readOnly,
    rooms: { list: () => rooms },
    on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
  }
  const state = { supported, server: [], serverTime: new Date(c.now()).toISOString() }
  const api = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (tools[name]) return tools[name](args)
      if (name === 'list_presence') return { presence: state.server, server_time: new Date(c.now()).toISOString() }
      return { ok: true }
    },
  }
  const presence = createPresence({ flybot, api, supported: async () => state.supported, memberId: id => members[id], normHandle: norm, cleanName, now: c.now, every: c.every, clear: c.clear })
  const start = (event) => handlers.get('turn.start')?.(event)
  const end = (event) => handlers.get('turn.end')?.(event)
  const sent = () => calls.filter(call => call.name === 'set_presence').map(call => call.args)
  return { c, presence, calls, state, start, end, sent, handlers }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const friendTurn = (extra = {}) => ({ place: 'chat', botId: 'a', sessionId: 's', turnId: 's#1', turn: 1, trigger: { exchangeId: 'x', from: { kind: 'remote', handle: '@Coder.Bob.home' }, role: 'remote', hop: 0 }, ...extra })

test('send: a turn that answers a friend says thinking toward that Bot, repeats while it runs, and says idle when it ends', async (t) => {
  const f = fixture()
  t.after(() => f.presence.dispose())
  f.start(friendTurn())
  await settle()
  assert.deepEqual(f.sent(), [{ bot_id: 'm_a', state: 'thinking', to: '@coder.bob.home' }])
  await f.c.advance(BEAT_MS * 2 + 10)
  assert.equal(f.sent().length, 3)
  f.end({ turnId: 's#1' })
  await settle()
  assert.deepEqual(f.sent().at(-1), { bot_id: 'm_a', state: 'idle', to: '@coder.bob.home' })
  assert.equal(f.c.count(), 0, 'the heartbeat stops with the turn')
  await f.c.advance(BEAT_MS * 3)
  assert.equal(f.sent().length, 4)
  assert.equal(f.presence.sending(), 0)
})

test('send: a friend\'s line recorded after turn.start still announces the turn (#332: the feed gave that turn no trigger)', async (t) => {
  const f = fixture()
  t.after(() => f.presence.dispose())
  const delivered = (extra = {}) => f.handlers.get('exchange.delivered')?.({ exchangeId: 'x', from: { kind: 'remote', handle: '@Coder.Bob.home' }, to: { botId: 'a' }, sessionId: 's', place: 'chat', role: 'request', ...extra })
  f.start(friendTurn({ trigger: undefined }))
  await settle()
  assert.deepEqual(f.sent(), [], 'no target yet')
  delivered()
  await settle()
  assert.deepEqual(f.sent(), [{ bot_id: 'm_a', state: 'thinking', to: '@coder.bob.home' }])
  await f.c.advance(BEAT_MS + 10)
  assert.equal(f.sent().length, 2)
  f.end({ turnId: 's#1', sessionId: 's' })
  await settle()
  assert.deepEqual(f.sent().at(-1), { bot_id: 'm_a', state: 'idle', to: '@coder.bob.home' })
  // The same delivery twice, or one for another Session, starts nothing more.
  delivered()
  await settle()
  assert.equal(f.sent().length, 3)
  f.start(friendTurn({ trigger: undefined, turnId: 's#2', turn: 2 }))
  await settle()
  delivered({ sessionId: 'other' })
  delivered({ from: { kind: 'user' } })
  delivered({ place: 'group' })
  await settle()
  assert.equal(f.sent().length, 3)
  // A line recorded long after the turn began reached a Bot that was busy with something else: not claimed.
  f.start(friendTurn({ trigger: undefined, turnId: 's#2b', turn: 2, time: 5_000 }))
  await settle()
  delivered({ time: 5_000 + CLAIM_MS + 1 })
  await settle()
  assert.equal(f.sent().length, 3)
  f.start(friendTurn({ trigger: undefined, turnId: 's#2c', turn: 2, time: 9_000 }))
  await settle()
  delivered({ time: 9_000 + CLAIM_MS })
  await settle()
  assert.equal(f.sent().length, 4, 'inside the window it is claimed')
  f.end({ turnId: 's#2c', sessionId: 's' })
  await settle()
  assert.equal(f.sent().length, 5, 'idle follows')
  // A turn the user started is not claimed by a friend's line that arrives during it.
  f.start(friendTurn({ turnId: 's#3', turn: 3, trigger: { exchangeId: 'u', from: { kind: 'user' }, role: 'user', hop: 0 } }))
  await settle()
  delivered()
  await settle()
  assert.equal(f.sent().length, 5)
})

test('send: nothing leaves for a turn the user started, an unknown Bot, a Bot without an identity, or a turn in a local group', async (t) => {
  const f = fixture({ rooms: [{ id: 'g1', origin: 'local' }] })
  t.after(() => f.presence.dispose())
  f.start(friendTurn({ turnId: 'u#1', trigger: { exchangeId: 'u', from: { kind: 'user' }, role: 'user', hop: 0 } }))
  f.start(friendTurn({ turnId: 'n#1', trigger: undefined }))
  f.start(friendTurn({ turnId: 'z#1', botId: 'zzz' }))
  f.start({ place: 'group', botId: 'a', roomId: 'g1', turnId: 'g#1', trigger: { from: { kind: 'room', roomId: 'g1' } } })
  f.start({ place: 'remote', botId: 'a', turnId: 'r#1', remote: { handle: '@x.home' } })
  await settle()
  assert.deepEqual(f.sent(), [])
})

test('send: a face room turn is announced to that room, only while the room is open', async (t) => {
  const open = { id: 'g1', origin: 'face-to-face', face: { roomId: 'frm_1', status: 'open' } }
  const f = fixture({ rooms: [open, { id: 'g2', origin: 'face-to-face', face: { roomId: 'frm_2', status: 'candidate' } }, { id: 'g3', origin: 'face-to-face', face: { roomId: 'frm_3', status: 'left' } }] })
  t.after(() => f.presence.dispose())
  f.start({ place: 'group', botId: 'a', roomId: 'g1', turnId: 'g1#1' })
  f.start({ place: 'group', botId: 'b', roomId: 'g1', turnId: 'g1b#1' })
  f.start({ place: 'group', botId: 'a', roomId: 'g2', turnId: 'g2#1' })
  f.start({ place: 'group', botId: 'a', roomId: 'g3', turnId: 'g3#1' })
  await settle()
  assert.deepEqual(f.sent(), [{ bot_id: 'm_a', state: 'thinking', room_id: 'frm_1' }, { bot_id: 'm_b', state: 'thinking', room_id: 'frm_1' }])
  f.end({ turnId: 'g1#1' })
  await settle()
  assert.deepEqual(f.sent().at(-1), { bot_id: 'm_a', state: 'idle', room_id: 'frm_1' })
  assert.equal(f.presence.sending(), 1)
})

test('send: an older server (no presence feature) or a read-only host sends nothing', async (t) => {
  const old = fixture({ supported: false })
  t.after(() => old.presence.dispose())
  old.start(friendTurn())
  await settle()
  assert.deepEqual(old.sent(), [])
  assert.equal(old.c.count(), 0)
  const ro = fixture({ readOnly: true })
  t.after(() => ro.presence.dispose())
  ro.start(friendTurn())
  await settle()
  assert.deepEqual(ro.sent(), [])
})

test('send: a late probe does not announce a turn that already ended', async (t) => {
  const c = clock()
  const handlers = {}
  const calls = []
  let release
  const presence = createPresence({
    flybot: { rooms: { list: () => [] }, on: (name, fn) => { handlers[name] = fn; return () => {} } },
    api: { callTool: async (name, args) => { calls.push({ name, args }); return {} } },
    supported: () => new Promise(resolve => { release = resolve }),
    memberId: () => 'm_a', normHandle: norm, cleanName, now: c.now, every: c.every, clear: c.clear,
  })
  t.after(() => presence.dispose())
  handlers['turn.start'](friendTurn())
  await settle()
  handlers['turn.end']({ turnId: 's#1' })
  release(true)
  await settle()
  assert.deepEqual(calls, [])
  assert.equal(c.count(), 0)
})

test('send: a refused signal (no longer friends, left the room) stops the heartbeat; a rate limit does not end the turn; a runaway turn stops after a cap', async (t) => {
  const refused = fixture({ tools: { set_presence: () => { throw Object.assign(new Error('Bot Social set_presence: no active relationship'), { code: 'no_relationship' }) } } })
  t.after(() => refused.presence.dispose())
  refused.start(friendTurn())
  await settle()
  assert.equal(refused.c.count(), 0)
  assert.equal(refused.sent().length, 1)

  let limited = 0
  const busy = fixture({ tools: { set_presence: () => { limited += 1; throw Object.assign(new Error('rate'), { code: 'rate_limited' }) } } })
  t.after(() => busy.presence.dispose())
  busy.start(friendTurn())
  await settle()
  await busy.c.advance(BEAT_MS * 2 + 5)
  assert.equal(limited, 3)

  const runaway = fixture()
  t.after(() => runaway.presence.dispose())
  runaway.start(friendTurn())
  await settle()
  await runaway.c.advance(BEAT_MS * (MAX_BEATS + 5))
  assert.equal(runaway.sent().filter(entry => entry.state === 'thinking').length, MAX_BEATS)
  assert.equal(runaway.sent().at(-1).state, 'idle')
})

test('send: an unknown tool (an old server that still passed the probe) switches the signal off for a while', async (t) => {
  const f = fixture({ tools: { set_presence: () => { throw Object.assign(new Error('Bot Social set_presence: Tool set_presence not found'), { code: 'rpc' }) } } })
  t.after(() => f.presence.dispose())
  f.start(friendTurn())
  await settle()
  f.start(friendTurn({ turnId: 's#2' }))
  await settle()
  assert.equal(f.sent().length, 1)
  assert.equal(f.presence.view().supported, false)
})

test('receive: nothing is polled until a chat asks; asking polls and answers with who is thinking and for how long', async (t) => {
  const f = fixture()
  t.after(() => f.presence.dispose())
  await f.c.advance(POLL_MS * 4)
  assert.equal(f.calls.length, 0)
  f.state.server = [
    { scope: 'direct', bot: { handle: '@Coder.bob.home', display_name: 'Coder' }, to: '@chief.danyang.home', state: 'thinking', expires_at: new Date(f.c.now() + 12_000).toISOString() },
    { scope: 'face_room', room_id: 'frm_1', bot: { handle: '@chief.carol.home', display_name: 'Chief <b>' }, state: 'thinking', expires_at: new Date(f.c.now() + 5_000).toISOString() },
    { scope: 'direct', bot: { handle: '@gone.home', display_name: 'Gone' }, state: 'idle', expires_at: new Date(f.c.now() + 5_000).toISOString() },
  ]
  f.presence.touch()
  await settle()
  assert.deepEqual(f.presence.view().typing.map(item => [item.scope, item.handle, item.name, item.roomId, item.expiresIn]), [
    ['direct', '@coder.bob.home', 'Coder', undefined, 12_000],
    ['face_room', '@chief.carol.home', 'Chief b', 'frm_1', 5_000],
  ])
  // Entries end on their own (server TTL), judged on this host's clock.
  await f.c.advance(6_000)
  f.state.server = f.state.server.slice(0, 1)
  f.presence.touch()
  await settle()
  assert.deepEqual(f.presence.view().typing.map(item => item.handle), ['@coder.bob.home'])
  f.state.server = []
  await f.c.advance(POLL_MS + 5)
  assert.deepEqual(f.presence.view().typing, [])
})

test('receive: polling goes on only while the chat keeps asking, then stops', async (t) => {
  const f = fixture()
  t.after(() => f.presence.dispose())
  f.presence.touch()
  await settle()
  await f.c.advance(POLL_MS * 2 + 5)
  const polls = () => f.calls.filter(call => call.name === 'list_presence').length
  assert.ok(polls() >= 3)
  await f.c.advance(WANTED_MS + POLL_MS * 2)
  const after = polls()
  await f.c.advance(POLL_MS * 6)
  assert.equal(polls(), after)
  assert.equal(f.c.count(), 0)
})

test('receive: a Bot\'s message ends its line at once and the server\'s lagging entry does not bring it back', async (t) => {
  const f = fixture()
  t.after(() => f.presence.dispose())
  f.state.server = [
    { scope: 'direct', bot: { handle: '@coder.bob.home', display_name: 'Coder' }, state: 'thinking', expires_at: new Date(f.c.now() + 20_000).toISOString() },
    { scope: 'face_room', room_id: 'frm_1', bot: { handle: '@coder.bob.home', display_name: 'Coder' }, state: 'thinking', expires_at: new Date(f.c.now() + 20_000).toISOString() },
  ]
  f.presence.touch()
  await settle()
  assert.equal(f.presence.view().typing.length, 2)
  f.presence.arrived({ handle: '@Coder.bob.home' })
  assert.deepEqual(f.presence.view().typing.map(item => item.scope), ['face_room'], 'only the direct chat line ends')
  await f.c.advance(POLL_MS + 5)
  assert.deepEqual(f.presence.view().typing.map(item => item.scope), ['face_room'])
  f.presence.arrived({ handle: '@coder.bob.home', roomId: 'frm_1' })
  assert.deepEqual(f.presence.view().typing, [])
  await f.c.advance(AFTER_MESSAGE_MS + POLL_MS)
  assert.equal(f.presence.view().typing.length, 2, 'if it is still thinking after the quiet window, the line returns')
})

test('receive: an older server shows nothing and is not polled; an unknown tool switches polling off', async (t) => {
  const old = fixture({ supported: false })
  t.after(() => old.presence.dispose())
  old.presence.touch()
  await settle()
  await old.c.advance(POLL_MS * 3)
  assert.equal(old.calls.length, 0)
  assert.deepEqual(old.presence.view().typing, [])

  const unknown = fixture({ tools: { list_presence: () => { throw Object.assign(new Error('Bot Social list_presence: unknown tool'), { code: 'unknown' }) } } })
  t.after(() => unknown.presence.dispose())
  unknown.presence.touch()
  await settle()
  await unknown.c.advance(POLL_MS * 4)
  assert.equal(unknown.calls.length, 1)
  assert.equal(unknown.presence.view().supported, false)
})

test('a read-only host neither sends nor polls', async (t) => {
  const f = fixture({ readOnly: true })
  t.after(() => f.presence.dispose())
  f.presence.touch()
  await settle()
  assert.equal(f.calls.length, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWindow, clampWindow, WINDOW_LIMITS } from '../src/window.js'
import { at, bot, bots, NOW, records, rooms, u } from './fixture.js'

const build = (extra = {}, recs = records()) => buildWindow(recs, { now: NOW, bots, rooms, ...extra })

test('lanes: You, the Main Bot first, the other Bots, then groups with activity', () => {
  const win = build()
  assert.deepEqual(win.lanes.map(lane => [lane.id, lane.kind, lane.name]), [['user', 'user', 'You'], ['a', 'bot', 'Chief'], ['b', 'bot', 'Writer'], ['r1', 'room', 'Team Room']])
  assert.equal(win.lanes[1].main, true)
  assert.equal(win.version, 1)
  assert.equal(win.windowMs, WINDOW_LIMITS.default)
  assert.equal(win.live, true)
})

test('turns: per Bot lane, group turns tagged with their room, the running turn has no end', () => {
  const win = build()
  assert.deepEqual(win.turns.filter(turn => turn.lane === 'a').map(turn => [turn.id, turn.place, turn.t1, turn.running]), [
    ['a#1', 'chat', at(5800), false], ['a#2', 'chat', at(12000), false], ['ra#1', 'group', at(26000), false], ['a#3', 'chat', null, true],
  ])
  const group = win.turns.find(turn => turn.id === 'rb#1')
  assert.equal(group.room, 'r1')
  assert.equal(group.lane, 'b')
  assert.deepEqual(win.turns.find(turn => turn.id === 'a#1').trigger, { exchangeId: 'xu', from: 'user', role: 'user' })
  assert.deepEqual(win.turns.find(turn => turn.id === 'a#1').tools, [{ id: 'c1', name: 'web_search', t0: at(2000), t1: at(5000), ok: true }])
  assert.equal(win.turns.find(turn => turn.id === 'b#1').tools[0].ok, false)
  // A turn that has no tools says so, and nothing about the group's own round is in the Bot lanes.
  assert.deepEqual(win.turns.find(turn => turn.id === 'a#2').tools, [])
  assert.equal(win.turns.some(turn => turn.id === 'r1#1'), false)
})

test('rounds: the group turn is a bracket that lists the members it called', () => {
  const [round] = build().rounds
  assert.deepEqual([round.id, round.lane, round.t0, round.t1, round.running], ['r1#1', 'r1', at(20000), at(30000), false])
  assert.deepEqual(round.calls.map(call => [call.bot, call.turnId]), [['b', 'rb#1'], ['a', 'ra#1']])
})

test('exchanges: request to reply latency matches the delivery times; unanswered requests are waiting', () => {
  const win = build()
  const arrow = id => win.exchanges.find(item => item.id === id)
  assert.deepEqual(arrow('x1'), { id: 'x1', from: 'a', to: 'b', role: 'request', hop: 0, t: at(5500), replyAt: at(10000), latencyMs: 4500 })
  assert.deepEqual(arrow('x2'), { id: 'x2', from: 'b', to: 'a', role: 'reply', hop: 1, t: at(10000), replyTo: 'x1', latencyMs: 4500 })
  assert.equal(arrow('x3').waiting, true)
  assert.equal(arrow('x3').latencyMs, undefined)
  // The user's ask: how long the turn it started took (not a reply delivery the core cannot see).
  assert.deepEqual(arrow('xu'), { id: 'xu', from: 'user', to: 'a', role: 'user', hop: 0, t: at(1000), turnId: 'a#1', answerAt: at(5800), latencyMs: 4800 })
  assert.equal(arrow('xr1').from, 'r1')
  assert.equal(arrow('xr1').role, 'room')
  assert.equal(arrow('xr1').room, 'r1')
})

test('utilization: busy is the union of turns, tools the union of tool spans inside it, idle is no running turn', () => {
  const win = build()
  const a = win.utilization.find(item => item.lane === 'a')
  // a#1 4700 + a#2 1900 + ra#1 2900 + a#3 running 5000
  assert.equal(a.busyMs, 14_500)
  assert.equal(a.toolMs, 3_000)
  assert.equal(a.modelMs, 11_500)
  assert.equal(a.idleMs, WINDOW_LIMITS.default - 14_500)
  assert.equal(a.running, true)
  assert.equal(a.turns, 4)
  const b = win.utilization.find(item => item.lane === 'b')
  // b#1 4500 + rb#1 2500; the failed bash call is 3000 of tool time
  assert.equal(b.busyMs, 7_000)
  assert.equal(b.toolMs, 3_000)
  assert.equal(b.running, false)
  assert.deepEqual(win.utilization.map(item => item.lane), ['a', 'b'])
})

test('utilization: overlapping turns and parallel tools are not double counted', () => {
  const recs = [
    { r: 'boot', t: at(0) },
    { r: 'ts', t: at(1000), id: 'a#1', pl: 'chat', bot: 'a' },
    { r: 'ts', t: at(2000), id: 'ga#1', pl: 'group', bot: 'a', room: 'r1' },
    { r: 'ks', t: at(2100), id: 'p1', tid: 'a#1', nm: 'x', bot: 'a' },
    { r: 'ks', t: at(2200), id: 'p2', tid: 'ga#1', nm: 'y', bot: 'a' },
    { r: 'ke', t: at(4000), id: 'p1', tid: 'a#1', ok: true },
    { r: 'ke', t: at(5000), id: 'p2', tid: 'ga#1', ok: true },
    { r: 'te', t: at(6000), id: 'a#1', o: 'completed' },
    { r: 'te', t: at(7000), id: 'ga#1', o: 'completed' },
  ]
  const win = buildWindow(recs, { now: at(10000), bots, rooms })
  const a = win.utilization.find(item => item.lane === 'a')
  assert.equal(a.busyMs, 6_000)
  assert.equal(a.toolMs, 2_900)
  assert.equal(a.modelMs, 3_100)
  const rows = win.turns.filter(turn => turn.lane === 'a').map(turn => [turn.id, turn.row])
  assert.deepEqual(rows, [['a#1', 0], ['ga#1', 1]])
  assert.equal(win.lanes.find(lane => lane.id === 'a').rows, 2)
})

test('the window clips: a turn that straddles the edge counts only its part, and `to` looks back', () => {
  const win = build({ windowMs: 60_000, to: at(11_000) })
  assert.equal(win.live, false)
  assert.equal(win.to, at(11_000))
  assert.equal(win.windowMs, 60_000)
  // a#2 ran 10100..12000, only 900 ms inside the window; a#3 (40000..) is outside it.
  const a = win.utilization.find(item => item.lane === 'a')
  assert.equal(a.busyMs, 4_700 + 900)
  assert.equal(win.turns.some(turn => turn.id === 'a#3'), false)
  assert.equal(win.turns.find(turn => turn.id === 'a#3')?.running, undefined)
  // Looking back never makes a finished-later turn "running".
  assert.equal(win.turns.every(turn => turn.running === false), true)
  assert.equal(win.exchanges.some(item => item.id === 'x3'), false)
})

test('communication map: directed edges with counts and who waits on whom', () => {
  const win = build()
  const edge = (from, to) => win.edges.find(item => item.from === from && item.to === to)
  assert.deepEqual(edge('a', 'b'), { from: 'a', to: 'b', requests: 2, replies: 0, other: 0, answered: 1, unanswered: 1, medianMs: 4500, maxMs: 4500, totalWaitMs: 4500 })
  assert.deepEqual(edge('b', 'a'), { from: 'b', to: 'a', requests: 0, replies: 1, other: 0, answered: 0, unanswered: 0 })
  assert.equal(edge('user', 'a').requests, 1)
  assert.equal(edge('user', 'a').medianMs, 4800)
  assert.equal(edge('r1', 'b').other, 1)
})

test('a restart closes what it cut off at the last record before it, marked lost', () => {
  const recs = [
    { r: 'boot', t: at(0) },
    { r: 'ts', t: at(1000), id: 'a#1', pl: 'chat', bot: 'a' },
    { r: 'ks', t: at(2000), id: 'c1', tid: 'a#1', nm: 'bash', bot: 'a' },
    { r: 'm', t: at(3000), id: 'x1', f: u, to: bot('b'), ro: 'user', hop: 0 },
    { r: 'boot', t: at(60_000) },
    { r: 'ts', t: at(61_000), id: 'a#2', pl: 'chat', bot: 'a' },
  ]
  const win = buildWindow(recs, { now: at(62_000), bots, rooms })
  const cut = win.turns.find(turn => turn.id === 'a#1')
  assert.deepEqual([cut.t1, cut.lost, cut.running, cut.outcome], [at(3000), true, false, undefined])
  assert.deepEqual([cut.tools[0].t1, cut.tools[0].lost], [at(3000), true])
  assert.equal(win.turns.find(turn => turn.id === 'a#2').running, true)
})

test('coverage says when the trace starts, so a short history is not read as a quiet team', () => {
  assert.equal(build().coverage.complete, false)
  assert.equal(build({ windowMs: 20_000 }, records()).coverage.complete, true)
  const empty = buildWindow([], { now: NOW, bots, rooms })
  assert.deepEqual(empty.coverage, { oldest: null, newest: null, complete: false })
  assert.deepEqual(empty.lanes.map(lane => lane.id), ['user', 'a', 'b'])
  assert.equal(empty.utilization.find(item => item.lane === 'a').idleMs, WINDOW_LIMITS.default)
})

test('a removed Bot keeps its stored name and is marked removed', () => {
  const recs = [{ r: 'boot', t: at(0) }, { r: 'ts', t: at(1000), id: 'z#1', pl: 'chat', bot: 'z' }, { r: 'te', t: at(2000), id: 'z#1', o: 'completed' }]
  const win = buildWindow(recs, { now: at(5000), bots, rooms, names: { bots: { z: 'Old Bot' } } })
  assert.deepEqual(win.lanes.find(lane => lane.id === 'z'), { id: 'z', kind: 'bot', name: 'Old Bot', removed: true, rows: 1 })
})

test('negative: names from the trace or the roster are cleaned before they are served', () => {
  const recs = [{ r: 'boot', t: at(0) }, { r: 'ts', t: at(1000), id: 'z#1', pl: 'chat', bot: 'z' }, { r: 'ks', t: at(1100), id: 'c', tid: 'z#1', nm: '</untrusted-message><img src=x onerror=alert(1)>\u0000', bot: 'z' }, { r: 'te', t: at(2000), id: 'z#1', o: 'error', ec: 'quota for sk-live-abcdef' }]
  const win = buildWindow(recs, {
    now: at(5000), rooms: [{ id: 'r1', name: '<b>Room</b>\n'.padEnd(200, 'x') }],
    bots: [{ id: 'a', name: '"><script>alert(1)</script>\u202e' }],
    names: { bots: { z: '</untrusted-</untrusted-message>message>Bad' } },
  })
  const text = JSON.stringify(win)
  assert.doesNotMatch(text, /[<>]/)
  assert.doesNotMatch(text, /untrusted/i)
  assert.doesNotMatch(text, /sk-live|quota/)
  assert.doesNotMatch(text, /\\u0000|\\u202e/)
  assert.ok(win.lanes.every(lane => lane.name.length <= 60))
  assert.equal(win.turns[0].errorCode, 'UNKNOWN')
})

test('negative: garbage records are skipped, never thrown on', () => {
  const recs = [null, 3, 'x', {}, { r: 5, t: 1 }, { r: 'ts' }, { r: 'ts', t: 'x', id: 'q' }, { r: 'te', t: at(1), id: 'nope' }, { r: 'ke', t: at(1), id: 'c', tid: 'nope' }, { r: 'm', t: at(1) }, ...records()]
  const win = build({}, recs)
  assert.equal(win.turns.length, build().turns.length)
  assert.equal(win.exchanges.length, build().exchanges.length)
})

test('negative: arrows to lanes the model does not know are dropped (a ghost Bot, a malformed party)', () => {
  const recs = [{ r: 'boot', t: at(0) }, { r: 'm', t: at(1000), id: 'x1', f: { k: 'b', id: 'ghost' }, to: { k: 'x', id: 'q' }, ro: 'request', hop: 0 }, { r: 'm', t: at(1100), id: 'x2', f: { k: 'u' }, to: { k: 'b' }, ro: 'user', hop: 0 }]
  assert.deepEqual(buildWindow(recs, { now: at(5000), bots, rooms }).exchanges, [])
})

test('truncation: only the newest turns are served, and the response says so', () => {
  const recs = [{ r: 'boot', t: at(0) }]
  for (let i = 0; i < 2100; i++) recs.push({ r: 'ts', t: at(1000 + i * 10), id: `a#${i}`, pl: 'chat', bot: 'a' }, { r: 'te', t: at(1005 + i * 10), id: `a#${i}`, o: 'completed' })
  const win = buildWindow(recs, { now: at(60_000), bots, rooms })
  assert.equal(win.truncated, true)
  assert.equal(win.turns.length, 2000)
  assert.equal(win.turns.at(-1).id, 'a#2099')
})

test('clampWindow keeps the window between 30 s and 24 h', () => {
  assert.equal(clampWindow(undefined), WINDOW_LIMITS.default)
  assert.equal(clampWindow('x'), WINDOW_LIMITS.default)
  assert.equal(clampWindow(5), WINDOW_LIMITS.min)
  assert.equal(clampWindow(1e12), WINDOW_LIMITS.max)
  assert.equal(clampWindow(120_000.4), 120_000)
})

const friend = { k: 'f', id: 'f:helper.uib.home' }
const friendRecords = () => [
  { r: 'boot', t: at(0) },
  { r: 'm', t: at(1000), id: 'f1', f: u, to: friend, ro: 'user', hop: 0, n: 12 },
  { r: 'm', t: at(7000), id: 'f2', f: friend, to: u, ro: 'remote', hop: 0, n: 80 },
  { r: 'm', t: at(9000), id: 'f3', f: u, to: friend, ro: 'user', hop: 0, n: 5 },
]

test('a friend\'s Bot is a friend lane: its name, no turns, no utilization row', () => {
  const win = buildWindow(friendRecords(), { now: at(20_000), bots, rooms, names: { friends: { 'f:helper.uib.home': 'Helper' } } })
  assert.deepEqual(win.lanes.find(lane => lane.kind === 'friend'), { id: 'f:helper.uib.home', kind: 'friend', name: 'Helper' })
  assert.deepEqual(win.turns, [])
  assert.deepEqual(win.utilization.map(row => row.lane), ['a', 'b'])
  const nameless = buildWindow(friendRecords(), { now: at(20_000), bots, rooms })
  assert.equal(nameless.lanes.find(lane => lane.kind === 'friend').name, 'helper.uib.home')
})

test('friend exchanges: your line waits until the friend\'s next line, which is the answer', () => {
  const win = buildWindow(friendRecords(), { now: at(20_000), bots, rooms })
  const [first, answer, second] = win.exchanges
  assert.deepEqual([first.from, first.to, first.answerAt, first.latencyMs, first.waiting], ['user', 'f:helper.uib.home', at(7000), 6000, undefined])
  assert.deepEqual([answer.from, answer.to, answer.role, answer.latencyMs], ['f:helper.uib.home', 'user', 'remote', 6000])
  assert.deepEqual([second.waiting, second.latencyMs], [true, undefined])
  const edge = win.edges.find(item => item.from === 'user' && item.to === 'f:helper.uib.home')
  assert.deepEqual([edge.requests, edge.answered, edge.unanswered, edge.medianMs], [2, 1, 1, 6000])
  assert.equal(win.edges.find(item => item.from === 'f:helper.uib.home').replies, 1)
})

test('a friend\'s request into your Bot is answered by that Bot\'s turn', () => {
  const recs = [{ r: 'boot', t: at(0) }, { r: 'm', t: at(1000), id: 'q1', f: friend, to: { k: 'b', id: 'a' }, ro: 'request', hop: 0, n: 5 }, { r: 'ts', t: at(1100), id: 'a#1', pl: 'chat', bot: 'a', x: 'q1', f: friend, ro: 'request' }, { r: 'te', t: at(4100), id: 'a#1', o: 'completed' }]
  const win = buildWindow(recs, { now: at(20_000), bots, rooms })
  assert.deepEqual([win.exchanges[0].from, win.exchanges[0].answerAt, win.exchanges[0].latencyMs, win.exchanges[0].turnId], ['f:helper.uib.home', at(4100), 3100, 'a#1'])
  assert.equal(win.turns[0].trigger.from, 'f:helper.uib.home')
})

test('a gone Bot or group with no remembered name is "Removed Bot" / "Removed group", never a raw id', () => {
  const recs = [{ r: 'boot', t: at(0) }, { r: 'ts', t: at(1000), id: 'session-bb21#1', pl: 'chat', bot: 'session-bb21e111-aaaa' }, { r: 'te', t: at(2000), id: 'session-bb21#1', o: 'completed' }, { r: 'ts', t: at(1000), id: 'zz#1', pl: 'chat', bot: 'session-cc' }, { r: 'te', t: at(2000), id: 'zz#1', o: 'completed' }, { r: 'ts', t: at(1000), id: 'gr#1', pl: 'room', room: 'session-gone' }, { r: 'te', t: at(2000), id: 'gr#1', o: 'completed' }]
  const win = buildWindow(recs, { now: at(5000), bots, rooms })
  assert.deepEqual(win.lanes.filter(lane => lane.removed).map(lane => lane.name), ['Removed Bot', 'Removed Bot 2', 'Removed group'])
  assert.doesNotMatch(JSON.stringify(win.lanes), /"name":"session-/)
})

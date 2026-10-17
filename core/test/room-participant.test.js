import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import { createDshRoomParticipant } from '../src/host/room-participant.js'
import { ROOM_WORK_GRACE_MS } from '../src/host/constants.js'

function fixture(t) {
  const calls = []
  const member = { id: 'writer', name: 'Writer' }
  const room = { id: 'ops', name: 'Ops', seen: {}, seq: 4 }
  let count = 0
  const rt = {
    live: new Map(), groupOwners: new Map(), roomWaiters: new Map(),
    createSession: async (...args) => { calls.push(['create', ...args]); return `s${++count}` },
    workDirOf: ({ roomId, botId }) => `/fixture/${roomId}/${botId}`,
    desiredModel: async () => 'provider/model',
    selectSessionModel: async (...args) => { calls.push(['model', ...args]) },
    applyPermission: async (...args) => { calls.push(['permission', ...args]) },
    ensureCapabilities: async id => { calls.push(['capabilities', id]) },
    save: async () => { calls.push(['save']) }, warn: () => {},
    deliver: async value => { calls.push(['deliver', value]) },
    stopRoomTurn: async (...args) => { calls.push(['stop', ...args]) },
    resolveAgent: async id => ({ cancel: reason => calls.push(['cancel', id, reason]) }),
  }
  const driver = createDshRoomParticipant(rt)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const started = []
  const run = () => driver.runTurn({ room, member, sessionId: 's1', text: 'Selected room input', note: 'your turn', signal: controller.signal, started, by: 'chief' })
  const waiter = () => [...rt.roomWaiters.values()][0]
  return { rt, driver, room, member, calls, controller, started, run, waiter }
}

test('DSH participant opens isolated room sessions and reuses persisted links', async t => {
  const { rt, driver, room, member, calls } = fixture(t)
  assert.deepEqual(await driver.open({ room, member }), { id: 's1', created: true })
  assert.deepEqual(rt.groupOwners.get('s1'), { roomId: 'ops', botId: 'writer' })
  assert.deepEqual(calls, [
    ['create', 'Writer · Ops', { dir: '/fixture/ops/writer' }],
    ['model', 's1', { provider: 'provider', model: 'model' }],
    ['permission', member, 's1'], ['save'], ['capabilities', 's1'],
  ])
  calls.length = 0
  assert.deepEqual(await driver.open({ room, member }), { id: 's1', created: false })
  assert.deepEqual(calls, [['capabilities', 's1']])
  assert.equal((await driver.open({ room: { id: 'other', name: 'Other', seen: {} }, member })).id, 's2')
  assert.equal(room.sessions.writer, 's1')
})

test('DSH participant waits for capabilities before opening completes', async t => {
  const { driver, rt, room, member, calls } = fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  rt.ensureCapabilities = () => gate
  let opened = false
  const pending = driver.open({ room, member }).then(() => { opened = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls.some(call => call[0] === 'save'))
  assert.equal(opened, false)
  release()
  await pending
  assert.equal(opened, true)
})

test('a new DSH session invalidates its old room cursor even if setup fails', async t => {
  const { rt, driver, room, member } = fixture(t)
  room.seen.writer = 40
  rt.ensureCapabilities = async () => { throw new Error('unavailable') }
  await assert.rejects(driver.open({ room, member }), /unavailable/)
  assert.equal(room.seen.writer, undefined)
  assert.equal(room.sessions.writer, 's1')
  rt.ensureCapabilities = async () => {}
  assert.deepEqual(await driver.open({ room, member }), { id: 's1', created: false })
})

test('DSH participant preserves exchange attribution and releases completed waiters', async t => {
  const { run, waiter, calls, rt, started, controller } = fixture(t)
  const pending = run()
  const sent = calls.find(call => call[0] === 'deliver')[1]
  assert.equal(sent.askedBy, 'chief')
  assert.equal(sent.roomId, 'ops')
  assert.equal(sent.sessionId, 's1')
  assert.equal(sent.text, 'Selected room input')
  assert.equal(sent.exchangeId, started[0].exchangeId)
  waiter().resolve('Writer: raw result')
  assert.equal(await pending, 'Writer: raw result', 'room presentation owns name stripping')
  assert.equal(rt.roomWaiters.size, 0)
  assert.equal(started.length, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('DSH participant yields for approval or earlier work without losing stop targets', async t => {
  for (const approval of [false, true]) {
    const { rt, run, started, controller } = fixture(t)
    rt.live.set('s1', { turn: 1 })
    rt.waitsForApproval = () => approval
    assert.deepEqual(await run(), approval ? { approval: true } : { working: true })
    assert.equal(started.length, 1)
    assert.equal(rt.roomWaiters.size, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('DSH events follow context rollover and only slow tools yield the room', async t => {
  const { rt, run, driver, waiter } = fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = run()
  rt.groupOwners.set('replacement', { botId: 'writer', roomId: 'ops' })
  rt.live.set('replacement', { turn: 2, since: 123 })
  assert.deepEqual(driver.snapshot('replacement'), { working: true, since: 123 })
  assert.deepEqual(driver.snapshot('missing'), { working: false })
  rt.workRoomTurn('replacement', 'read_group_chat')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  assert.ok(waiter(), 'quick team tools retain the current speaker')
  rt.workRoomTurn('replacement', 'shell')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  assert.deepEqual(await pending, { working: true })
  const next = run()
  rt.yieldRoomTurn('replacement')
  assert.deepEqual(await next, { approval: true })
})

test('DSH failure, delivery failure and abort release the waiter without inventing success', async t => {
  for (const outcome of ['failure', 'delivery', 'abort', 'already-aborted']) {
    const { rt, run, waiter, started, controller, calls } = fixture(t)
    if (outcome === 'delivery') rt.deliver = async () => { throw new Error('offline') }
    if (outcome === 'already-aborted') controller.abort()
    const pending = run()
    if (outcome === 'failure') waiter().fail({ code: 'MODEL', message: 'offline' })
    if (outcome === 'abort') controller.abort()
    assert.deepEqual(await pending, outcome === 'failure' ? { failure: { code: 'MODEL', message: 'offline' } } : null)
    assert.equal(rt.roomWaiters.size, 0)
    if (outcome === 'already-aborted') assert.equal(calls.length, 0)
    if (outcome === 'failure') assert.equal(started.length, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('DSH cancellation distinguishes a round exchange from stopping member work', async t => {
  const { driver, rt, calls } = fixture(t)
  await driver.cancel({ sessionId: 's1', exchangeId: 'exchange' })
  assert.deepEqual(calls, [['stop', 's1', 'exchange']])
  assert.equal(await driver.cancel({ sessionId: 's1' }), false)
  rt.live.set('s1', { turn: 1 })
  assert.equal(await driver.cancel({ sessionId: 's1' }), true)
  assert.deepEqual(calls.at(-1), ['cancel', 's1', { kind: 'user' }])
})

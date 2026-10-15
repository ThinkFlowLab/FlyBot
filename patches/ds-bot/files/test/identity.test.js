import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Identity schema (#47, state version 2): member records, per-Bot owner binding, and the
// owner's designated Chief. Schema foundation only — team mode stays disabled, and no
// multi-human behavior is tested or claimed here.

// store.js on a temp home, with just enough of rt for load/save/refresh.
function runtime(t, saved, { home } = {}) {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'ds-bot-identity-'))
  const statePath = join(dir, 'state.json')
  if (saved !== undefined) writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, home: dir, statePath, warnings }
}

const LEGACY = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 4,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1, segments: [{ sessionId: 'm0', endedAt: 1 }] },
    w2: { id: 'w2', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Room', members: ['m1', 'w2'], admin: 'm1', mode: 'everyone', notice: '', sessions: { w2: 'g1' }, log: [{ who: 'Chief', text: 'do it' }] },
  },
  exchanges: [{ from: 'm1', to: 'w2', text: 'do it', at: 5 }],
  exchangeTurns: { w2: [6] },
  questions: { w2: { id: 'q1', text: 'ship it?' } },
  prefs: { theme: 'paper' },
}

test('a fresh team starts on the version-2 identity schema with one initial owner', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  assert.equal(rt.state.version, 2)
  assert.deepEqual(Object.keys(rt.state.members), ['owner-1'])
  assert.equal(rt.state.members['owner-1'].id, 'owner-1')
  assert.equal(rt.state.members['owner-1'].designatedChiefId, null)
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(Object.keys(saved.members), ['owner-1'])
})

test('a legacy version-1 team migrates to owner-bound version 2, ids and histories kept', async (t) => {
  const { rt, statePath, home } = runtime(t, LEGACY)
  const original = readFileSync(statePath, 'utf8')
  await rt.load()
  assert.equal(rt.state.version, 2)
  const owner = rt.state.members['owner-1']
  assert.equal(owner.id, 'owner-1')
  // Every Bot binds to the one initial owner; Bot ids, Session parts and histories stay.
  assert.equal(rt.state.bots.m1.ownerId, 'owner-1')
  assert.equal(rt.state.bots.w2.ownerId, 'owner-1')
  assert.equal(rt.state.bots.m1.sessionId, 'm1')
  assert.deepEqual(rt.state.bots.m1.segments, [{ sessionId: 'm0', endedAt: 1 }])
  assert.deepEqual(rt.state.exchanges, LEGACY.exchanges)
  assert.deepEqual(rt.state.exchangeTurns, LEGACY.exchangeTurns)
  assert.deepEqual(rt.state.questions, LEGACY.questions)
  // The designated Chief comes from the Main Bot role, never from a name.
  assert.equal(owner.designatedChiefId, 'm1')
  // The pre-migration bytes are backed up once, before the version-2 write.
  assert.equal(readFileSync(join(home, 'state.json.v1'), 'utf8'), original)
  assert.equal(JSON.parse(original).version, 1)
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.bots.m1.ownerId, 'owner-1')
  assert.deepEqual(Object.keys(saved.members), ['owner-1'])
})

test('the migration is idempotent: a restart loads the saved team without a second change', async (t) => {
  const first = runtime(t, LEGACY)
  await first.rt.load()
  const migrated = readFileSync(first.statePath, 'utf8')
  assert.equal(JSON.parse(migrated).version, 2)
  // A second host on the same folder (a restart) adopts the version-2 file as it is.
  const second = runtime(t, undefined, { home: first.home })
  await second.rt.load()
  assert.equal(readFileSync(second.statePath, 'utf8'), migrated)
  assert.deepEqual(Object.keys(second.rt.state.members), ['owner-1'])
  assert.equal(second.rt.state.members['owner-1'].designatedChiefId, 'm1')
  assert.equal(second.rt.state.bots.w2.ownerId, 'owner-1')
  // The one backup of the pre-migration bytes survives the restart untouched.
  assert.deepEqual(readdirSync(first.home).filter(name => name.endsWith('.v1')), ['state.json.v1'])
  assert.equal(JSON.parse(readFileSync(join(first.home, 'state.json.v1'), 'utf8')).version, 1)
})

test('re-reading a legacy file the host cannot save never duplicates or renames the owner', async (t) => {
  const { rt, home, statePath } = runtime(t, LEGACY)
  // Another dsh holds the team: the migration stays in memory and the file stays v1.
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  await rt.load()
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 1)
  for (let round = 0; round < 2; round += 1) {
    writeFileSync(statePath, JSON.stringify(LEGACY))
    await rt.refresh()
    assert.deepEqual(Object.keys(rt.state.members), ['owner-1'])
    assert.equal(rt.state.bots.m1.ownerId, 'owner-1')
    assert.equal(rt.state.bots.w2.ownerId, 'owner-1')
    assert.equal(rt.state.members['owner-1'].designatedChiefId, 'm1')
  }
})

test('migration refuses when state.json.v1 is a directory, keeping the legacy bytes', async (t) => {
  const { rt, home, statePath } = runtime(t, LEGACY)
  const original = readFileSync(statePath, 'utf8')
  mkdirSync(join(home, 'state.json.v1'))
  await rt.load()
  assert.match(rt.readOnly(), /could not be read/)
  assert.match(rt.readOnly(), /state\.json\.v1/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(readFileSync(statePath, 'utf8'), original)
  assert.equal(JSON.parse(original).version, 1)
})

test('migration refuses when the existing backup is a truncated, unusable copy', async (t) => {
  const { rt, home, statePath } = runtime(t, LEGACY)
  const original = readFileSync(statePath, 'utf8')
  // An interrupted write left a partial file where the backup belongs.
  writeFileSync(join(home, 'state.json.v1'), '{"version":1,"revision":')
  await rt.load()
  assert.match(rt.readOnly(), /could not be read/)
  assert.match(rt.readOnly(), /state\.json\.v1/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(readFileSync(statePath, 'utf8'), original)
})

test('names grant nothing: one owner is made, and no Bot becomes Chief by name', async (t) => {
  const { rt } = runtime(t, {
    version: 1,
    mainBotIds: [],
    revision: 2,
    bots: {
      a: { id: 'a', sessionId: 'a', name: 'You', instructions: '', createdAt: 1 },
      b: { id: 'b', sessionId: 'b', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 2 },
    },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  })
  await rt.load()
  assert.deepEqual(Object.keys(rt.state.members), ['owner-1'])
  assert.equal(rt.state.bots.a.ownerId, 'owner-1')
  assert.equal(rt.state.bots.b.ownerId, 'owner-1')
  // The Main Bot role decides the designated Chief; "You" and "Chief" decide nothing.
  assert.equal(rt.state.members['owner-1'].designatedChiefId, null)
})

const v2 = (partial) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['m1'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'm1' } },
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1' },
    w2: { id: 'w2', sessionId: 'w2', name: 'Writer', instructions: '', createdAt: 2, ownerId: 'owner-1' },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  ...partial,
})

const BAD_OWNERSHIP = [
  ['a Bot owned by an unknown member', v2({ bots: { ...v2({}).bots, w2: { id: 'w2', name: 'Writer', ownerId: 'ghost' } } }), /Bot w2 is not owned by a known member/],
  ['a Bot with no owner binding', v2({ bots: { ...v2({}).bots, w2: { id: 'w2', name: 'Writer' } } }), /Bot w2 is not owned by a known member/],
  ['duplicate member ids', v2({ members: { x: { id: 'owner-1', createdAt: 1 }, y: { id: 'owner-1', createdAt: 2 } }, bots: { m1: { id: 'm1', name: 'Chief', ownerId: 'owner-1' } } }), /duplicate member id owner-1/],
  ['a member id that does not match its record key', v2({ members: { x: { id: 'owner-1', createdAt: 1, designatedChiefId: null } } }), /member id owner-1 does not match its record key x/],
  ['a designated Chief that is not a Bot', v2({ members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'nope' } } }), /designates unknown Bot nope/],
  ['a designated Chief owned by another member', v2({ mainBotIds: [], members: { a: { id: 'a', createdAt: 1, designatedChiefId: 'w2' }, b: { id: 'b', createdAt: 2 } }, bots: { w2: { id: 'w2', name: 'Writer', ownerId: 'b' } } }), /designates a Chief owned by b/],
  ['member records that are not records', v2({ members: [] }), /member records are missing/],
  ['a version-1 state that carries member records', { version: 1, members: { 'owner-1': { id: 'owner-1' } }, bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, revision: 1 }, /version-1 state carries member records/],
  ['a version-1 Bot that carries an owner binding', { version: 1, bots: { w2: { id: 'w2', name: 'Writer', ownerId: 'owner-1' } }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, revision: 1 }, /version-1 Bot w2 carries an owner binding/],
]

for (const [name, saved, reason] of BAD_OWNERSHIP) {
  test(`malformed ownership fails closed: ${name}`, async (t) => {
    const { rt, statePath } = runtime(t, saved)
    const original = readFileSync(statePath, 'utf8')
    await rt.load()
    assert.match(rt.readOnly(), /could not be read/)
    assert.match(rt.readOnly(), reason)
    // Nothing is written: the file keeps its bytes until a human fixes it.
    rt.state.prefs.marker = 'not saved'
    await rt.save()
    assert.equal(readFileSync(statePath, 'utf8'), original)
  })
}

// The same schema through the real plugin: bootstrap and create-bot bind to the owner.
function open(saved) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-identity-open-'))
  if (saved !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => ({ id }),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home }
}

test('a fresh team and the Bots made in it carry the single owner binding end to end', async (t) => {
  const { call, stop, home } = open(undefined)
  t.after(stop)
  const team = (await call('state', {})).value
  const chief = team.bots.find(bot => bot.id === team.mainBotId)
  assert.equal(chief.ownerId, 'owner-1')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(Object.keys(saved.members), ['owner-1'])
  assert.equal(saved.members['owner-1'].designatedChiefId, chief.id)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  assert.equal(writer.ownerId, 'owner-1')
  const after = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(after.bots[writer.id].ownerId, 'owner-1')
  assert.equal(after.members['owner-1'].designatedChiefId, chief.id)
})

test('a legacy team opens with its Bots, ids and Main Bot roles bound to the one owner', async (t) => {
  const { call, stop, home } = open(LEGACY)
  t.after(stop)
  const team = (await call('state', {})).value
  assert.deepEqual(team.bots.map(bot => bot.id).sort(), ['m1', 'w2'])
  assert.equal(team.mainBotId, 'm1')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(Object.keys(saved.members), ['owner-1'])
  assert.equal(saved.members['owner-1'].designatedChiefId, 'm1')
  assert.equal(saved.bots.m1.ownerId, 'owner-1')
  assert.equal(saved.bots.w2.ownerId, 'owner-1')
  assert.equal(saved.bots.m1.sessionId, 'm1')
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json.v1'), 'utf8')).version, 1)
})

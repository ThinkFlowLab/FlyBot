import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const actor = { memberId: 'owner-1' }
const seed = () => ({ version: 2, revision: 1, members: { 'owner-1': { id: 'owner-1', designatedChiefId: 'a' } }, mainBotIds: ['a'],
  bots: { a: { id: 'a', ownerId: 'owner-1', sessionId: 'a', name: 'Chief', role: 'Chief' } },
  projects: { p: { id: 'p', name: 'Project', ownerUserId: 'owner-1', status: 'active', roles: { members: [], maintainers: [] } } },
  rooms: { g: { id: 'g', name: 'Group', admin: 'a', members: ['a'], sessions: {}, log: [], seq: 0, seen: {}, projectId: 'p' } },
  tasks: { old: { id: 'old', title: 'Existing work', projectId: 'p', ownerBotId: 'a', requesterId: 'owner-1', status: 'working', source: 'conversation', createdAt: 1, actors: [{ status: 'working', at: 1 }], origin: { roomId: 'g' } } } })
async function fixture(t, state = seed()) {
  const home = mkdtempSync(join(tmpdir(), 'flybot-compat-')), path = join(home, 'state.json')
  writeFileSync(path, JSON.stringify(state))
  const hosts = []
  async function start(config = {}) {
    const ctx = fakeContext()
    let route
    const register = ctx.connection.fetch.register
    ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
    Object.assign(ctx, { llm: { listProviders: () => [], listModels: async () => [] }, workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
      sessionController: { resolveAgent: async () => ({ agent: undefined }) }, sessions: { flush: async () => {} } })
    const rt = createRuntime(ctx, { home, projectWorkbench: true, ...config })
    let closed = false
    const close = async () => { if (!closed) { closed = true; await ctx.dispose() } }
    hosts.push(close); await rt.load()
    return { rt, ctx, close, route }
  }
  t.after(async () => { for (const close of hosts.reverse()) await close(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { home, path, start }
}

test('shared group dispatch cannot create an unadmitted legacy Project Task', async t => {
  const f = await fixture(t), { rt } = await f.start()
  await assert.rejects(rt.assignFromDispatch({ roomId: 'g', botId: 'a', title: 'Change code', note: 'Implement a change', issue: 8 }), /Chief|Task.*contract/)
  assert.deepEqual(Object.keys(rt.state.tasks), ['old'])
})

test('Bot tracking cannot create Project cards but personal tracking remains available', async t => {
  const f = await fixture(t), { rt } = await f.start()
  await assert.rejects(rt.trackBotTasks('a', { tasks: [{ title: 'Change code' }] }, { roomId: 'g' }), /Chief|Task.*contract/)
  const personal = await rt.trackBotTasks('a', { tasks: [{ title: 'My reminder' }] }, {})
  assert.ok(personal)
  const reminder = Object.values(rt.state.tasks).find(row => row.title === 'My reminder')
  assert.equal(reminder.projectId, null)
})

test('cutover preserves identities/history, reloads once and refuses unknown later legacy work', async t => {
  const f = await fixture(t), first = await f.start()
  const old = first.rt.state.tasks.old
  first.rt.projectTaskLifecycle.requireExecutable(old)
  const marker = structuredClone(old.legacyProject)
  assert.ok(marker?.cutoverId)
  assert.deepEqual(old.actors, seed().tasks.old.actors)
  first.rt.state.tasks.later = { ...structuredClone(old), id: 'later' }
  assert.throws(() => first.rt.projectTaskLifecycle.requireExecutable(first.rt.state.tasks.later), /cutover|legacy|Chief/)
  await first.rt.save(); await first.close()
  const second = await f.start()
  assert.deepEqual(second.rt.state.tasks.old.legacyProject, marker)
  second.rt.projectTaskLifecycle.requireExecutable(second.rt.state.tasks.old)
  assert.throws(() => second.rt.projectTaskLifecycle.requireExecutable(second.rt.state.tasks.later), /cutover|legacy|Chief/)
  assert.equal(second.rt.state.members['owner-1'].designatedChiefId, 'a')
  assert.equal(second.rt.state.bots.a.sessionId, 'a')
  assert.equal(second.rt.state.rooms.g.projectId, 'p')
  assert.equal(second.rt.state.tasks.old.requesterId, 'owner-1')
})

test('cutover state fences old JSON-only binaries while retaining logical Store version', async t => {
  const f = await fixture(t), { rt } = await f.start()
  await rt.save()
  const disk = JSON.parse(readFileSync(f.path, 'utf8'))
  assert.equal(disk.version, 4)
  assert.equal(disk.stateFormat, 'flybot-project-state/v1')
  assert.equal(rt.state.version, 2)
})

test('Project compatibility report is scoped, paginated and distinguishes unknown work without exposing content', async t => {
  const state = seed()
  state.tasks.child = { ...structuredClone(state.tasks.old), id: 'child', parentId: 'old', note: 'Private task material' }
  state.tasks.personal = { ...structuredClone(state.tasks.old), id: 'personal', projectId: null }
  const f = await fixture(t, state), { rt } = await f.start()
  rt.state.tasks.unknown = { ...structuredClone(rt.state.tasks.old), id: 'unknown' }
  const report = await rt.projectEndpoint('project-development', { version: 'project-development/v1', kind: 'query', name: 'compatibility', projectId: 'p', payload: { limit: 1 } }, actor)
  assert.equal(report.result.totals.legacy, 2)
  assert.equal(report.result.totals.held, 1)
  assert.equal(report.result.baseline.count, 2)
  assert.equal(report.result.committed, true)
  assert.equal(report.result.tasks[0].id, 'child')
  assert.equal(report.result.tasks[0].parentPresent, true)
  assert.equal(report.result.page.nextOffset, 1)
  assert.doesNotMatch(JSON.stringify(report), /Private task material|personal/)
  assert.throws(() => rt.projectCompatibility.report('p', {}, { memberId: 'outsider' }), /Project|permission/)
  assert.throws(() => rt.projectCompatibility.report('p', { limit: 101 }, actor), /page/)
})

test('an unconfirmed cutover cannot authorize legacy execution', async t => {
  const f = await fixture(t), { rt } = await f.start()
  const old = rt.state.tasks.old, proof = rt.state.projectCompatibility.projects.p
  const original = proof.effect
  proof.effect = { id: 'not-saved', generation: 1 }
  assert.throws(() => rt.projectTaskLifecycle.requireExecutable(old), /cutover|legacy|Chief/)
  proof.effect = original
  old.requesterId = 'another-user'
  assert.throws(() => rt.projectTaskLifecycle.requireExecutable(old), /cutover|legacy|Chief/)
})

test('cutover cannot be reopened by disabling shared authorization', async t => {
  for (const stateStorage of ['json', 'sqlite']) {
    const f = await fixture(t), first = await f.start({ stateStorage })
    await first.rt.save(); await first.close()
    const before = readFileSync(f.path, 'utf8')
    const next = await f.start({ projectWorkbench: false })
    assert.match(next.rt.readOnly(), /projectWorkbench|controlPlane/)
    await next.rt.save()
    assert.equal(readFileSync(f.path, 'utf8'), before)
  }
})

test('SQLite export and rollback retain the cutover fence and do not replay committed external actions', async t => {
  const { exportSqliteState, rollbackSqliteState } = await import('../src/host/project-state-migration.js')
  const f = await fixture(t), first = await f.start({ stateStorage: 'sqlite' }), actionPath = join(f.home, 'external-result.txt')
  let executions = 0
  first.rt.projectEffects.register('fixture.action', { run() { ++executions; writeFileSync(actionPath, 'Original committed result'); return { published: true } } })
  await first.rt.projectEffects.perform({ kind: 'fixture.action', key: 'one-action', projectId: 'p', taskId: 'old', payload: { reference: 'immutable' } })
  const migrationId = first.rt.stateStorage.status().migration.id
  await first.close()
  const output = join(f.home, 'export.json')
  exportSqliteState({ home: f.home, output, expectedMigrationId: migrationId })
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).version, 4)
  rollbackSqliteState({ home: f.home, expectedMigrationId: migrationId })
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).version, 4)
  const second = await f.start({ stateStorage: 'json' })
  second.rt.projectEffects.register('fixture.action', { run() { ++executions; throw new Error('Must never replay') } })
  second.rt.projectTaskLifecycle.requireExecutable(second.rt.state.tasks.old)
  await second.rt.projectEffects.drain()
  assert.equal(executions, 1)
  assert.equal(readFileSync(actionPath, 'utf8'), 'Original committed result')
  assert.equal(second.rt.state.tasks.old.id, 'old')
  assert.equal(second.rt.state.tasks.old.ownerBotId, 'a')
})

test('unknown state frames remain read-only without destroying existing records', async t => {
  for (const frame of [{ version: 5 }, { version: 4, stateFormat: 'unknown', logicalVersion: 2 }, { version: 4, stateFormat: 'flybot-project-state/v1', logicalVersion: 9 }]) {
    const f = await fixture(t, { ...seed(), ...frame }), before = readFileSync(f.path, 'utf8')
    const { rt } = await f.start()
    assert.match(rt.readOnly(), /newer FlyBot/)
    await rt.save()
    assert.equal(readFileSync(f.path, 'utf8'), before)
  }
})

test('a later group binding does not retroactively assign personal Tasks or their private history', async t => {
  const state = seed()
  delete state.rooms.g.projectId
  state.tasks.old.projectId = null
  const f = await fixture(t, state), { rt } = await f.start()
  await rt.projectEndpoint('project-bind', { kind: 'group', id: 'g', projectId: 'p' }, actor)
  assert.equal(rt.state.tasks.old.projectId, null)
  assert.equal(rt.state.tasks.old.legacyProject, undefined)
  assert.equal(rt.state.bots.a.projectId, undefined)
  assert.equal(rt.state.members['owner-1'].designatedChiefId, 'a')
  assert.equal(rt.state.projectCompatibility.projects.p.count, 0)
  assert.equal(rt.projectCompatibility.legacyAllowed(rt.state.tasks.old), true)
})

test('original Chief and Project-linked group use the authenticated original channel without manufacturing Tasks', async t => {
  const state = seed()
  state.members.bob = { id: 'bob' }; state.projects.p.roles.members.push('bob')
  state.rooms.g.participants = [{ id: 'owner-1', kind: 'human', role: 'admin', joinedSeq: 0, joinedAt: 1 }, { id: 'a', kind: 'bot', role: 'admin', joinedSeq: 0, joinedAt: 1 }]
  const f = await fixture(t, state), { rt, route, ctx } = await f.start()
  rt.authenticate = async token => token === 'owner' ? actor : { memberId: 'bob' }
  const messages = []
  rt.resolveAgent = async id => ({ session: { id }, status: 'idle', followup: message => messages.push(message), steer: message => messages.push(message) })
  rt.ensureCapabilities = async () => {}
  ctx.sessionController.prompt = async input => messages.push(input)
  rt.live.set('a', { turn: 1 })
  const call = async (operation, id, token = 'owner', extra = {}) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', headers: { 'x-flybot-member-session': token }, body: JSON.stringify({ endpoint: 'personal-space', payload: { operation, id, ...extra } }) }))).json()
  const before = Object.keys(rt.state.tasks)
  assert.equal((await call('list')).value.mainBotIds[0], 'a')
  assert.equal((await call('list')).value.rooms[0].projectId, 'p')
  assert.equal((await call('send', 'a', 'owner', { text: 'Explain the current plan' })).ok, true)
  assert.equal(messages.length, 1)
  await rt.postRoomMessage('g', { text: 'A group question', displayName: 'Owner' }, actor)
  assert.equal((await call('read', 'g')).value.messages.at(-1).text, 'A group question')
  assert.equal((await call('read', 'g', 'bob')).ok, false, 'Project membership cannot grant private group history')
  assert.deepEqual(Object.keys(rt.state.tasks), before)
  rt.memoryEndpoint = async () => ({ entries: [{ scope: 'own', text: 'Private Chief memory' }, { scope: 'team', text: 'Unrelated memory' }] })
  assert.deepEqual((await call('memory', 'a')).value.entries, [{ scope: 'own', text: 'Private Chief memory' }])
  assert.equal((await call('memory', 'a', 'bob')).ok, false)
  assert.equal(ctx.calls.includes('on llm/stream'), true)
})

test('legacy rework retains the same lineage and survives reload without admitting unrelated work', async t => {
  const state = seed()
  state.tasks.old.status = 'result-ready'
  const f = await fixture(t, state), first = await f.start()
  await first.rt.taskEndpoint('task-send-back', { id: 'old', note: 'Repair the original result' }, actor)
  const child = Object.values(first.rt.state.tasks).find(row => row.reworkOf === 'old')
  assert.ok(child)
  assert.equal(child.projectId, 'p')
  assert.equal(child.legacyProject.derivedFrom, 'old')
  first.rt.projectTaskLifecycle.requireExecutable(child)
  await first.close()
  const second = await f.start()
  second.rt.projectTaskLifecycle.requireExecutable(second.rt.state.tasks[child.id])
  assert.equal(second.rt.state.tasks[child.id].reworkOf, 'old')
  assert.equal(second.rt.state.projectCompatibility.projects.p.count, 1)
})

test('canonical Tasks cannot inject old card leases, Handoffs or plugin routing', async t => {
  const f = await fixture(t), { rt } = await f.start()
  await rt.projectEndpoint('project-bind', { kind: 'bot', id: 'a', projectId: 'p' }, actor)
  const task = await rt.taskEndpoint('task-create', { botId: 'a', projectId: 'p', title: 'Change the code', criteria: 'Regression passes', impact: 'Fix Project behavior' }, actor)
  const row = rt.state.tasks[task.id], before = structuredClone(row)
  for (const payload of [{ handoff: { from: 'Chief', to: 'Dev' } }, { lease: { holder: 'someone', takenAt: 1, expiresAt: 99999 } }, { evidence: [{ check: 'invented PASS' }] }]) {
    await assert.rejects(rt.taskEndpoint('task-update', { id: row.id, ...payload }, actor), /contracts/)
    assert.deepEqual(row, before)
  }
  let routing = 0
  rt.onTaskWrite = () => { ++routing; return { ownerBotId: 'someone' } }
  await rt.taskEndpoint('task-update', { id: row.id, note: 'Additional requirement detail' }, actor)
  assert.equal(routing, 0)
  assert.equal(row.ownerBotId, 'a')
})

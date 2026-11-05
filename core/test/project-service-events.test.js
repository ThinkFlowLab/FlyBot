import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectServiceEvents } from '../src/host/project-service-events.js'
const seed = () => ({ projects: { p: { id: 'p', status: 'active', goal: 'Agreed goal' }, other: { id: 'other', status: 'active' } }, tasks: { task: { id: 'task', projectId: 'p', title: 'Current work', status: 'open' } } })

test('only acknowledged snapshots expose events; scoped cursors reconnect across restart', () => {
  const bus = createProjectServiceEvents(), state = seed()
  bus.load(state)
  const start = bus.snapshot('p')
  const next = structuredClone(state); next.tasks.task.status = 'working'
  const pending = bus.prepare(next)
  assert.equal(bus.query('p', { after: start.cursor }).events.length, 0)
  bus.saved(pending)
  const page = bus.query('p', { after: start.cursor })
  assert.equal(page.events.length, 1); assert.equal(page.events[0].data.status, 'working')
  assert.equal(bus.query('p', { after: page.next }).events.length, 0)
  assert.equal(bus.query('other').events.length, 0)
  assert.throws(() => bus.query('other', { after: page.next }), /scope/)
  const restarted = createProjectServiceEvents(); restarted.load(pending.snapshot)
  assert.deepEqual(restarted.query('p', { after: start.cursor }), page)
})

test('uncommitted changes and private records cannot leak or perturb public Project event sequence', () => {
  const bus = createProjectServiceEvents(), state = seed(); bus.load(state)
  const initial = bus.snapshot('p')
  state.projectAgents = { private: { notes: ['private-secret'], ownerUserId: 'owner', projectId: 'p' } }
  state.projectConsultations = { private: { text: 'private-secret', projectId: 'p' } }
  state.authSessions = { sensitive: { token: 'secret-token' } }
  const privateSave = bus.prepare(structuredClone(state)); bus.saved(privateSave)
  assert.equal(bus.snapshot('p').cursor, initial.cursor)
  assert.equal(JSON.stringify(bus.query('p')).includes('private-secret'), false)
  const candidate = structuredClone(state); candidate.tasks.task.status = 'accepted'
  bus.prepare(candidate) // failed storage write; never acknowledged
  assert.equal(bus.snapshot('p').tasks[0].status, 'open')
  const recovered = bus.prepare(structuredClone(state)); bus.saved(recovered)
  assert.equal(bus.query('p').events.length, 0)
})

test('bounded retention expires old cursors and snapshots require a consistent revision for later pages', () => {
  let clock = 1000
  const bus = createProjectServiceEvents({ maxPerProject: 2, maxAgeMs: 1000, now: () => clock }), state = seed(); bus.load(state)
  const old = bus.snapshot('p').cursor
  for (let n = 0; n < 3; n++) { const next = structuredClone(state); next.tasks.task.status = 'step-' + n; bus.saved(bus.prepare(next)) }
  assert.equal(bus.query('p').events.length, 2)
  assert.throws(() => bus.query('p', { after: old }), error => error.code === 'bot/cursor-expired' && error.nextAction === 'project.snapshot')
  assert.throws(() => bus.snapshot('p', { expectedRevision: 0 }), /changed/)
  clock += 2000
  bus.saved(bus.prepare(structuredClone(state)))
  assert.equal(bus.query('p').events.length, 1, 'only the new changed state survives age retention')
  for (const options of [{ limit: 0 }, { limit: 101 }, { after: 'malformed' }]) assert.throws(() => bus.query('p', options))
})

test('clock rollback cannot create a retention hole; malformed persisted streams fail closed', () => {
  let clock = 5000
  const bus = createProjectServiceEvents({ maxPerProject: 3, maxAgeMs: 1000, now: () => clock }), state = seed(); bus.load(state)
  let prepared
  for (const [at, status] of [[5000, 'one'], [1000, 'two'], [5100, 'three']]) { clock = at; state.tasks.task.status = status; prepared = bus.prepare(structuredClone(state)); bus.saved(prepared) }
  assert.deepEqual(bus.query('p').events.map(row => row.at), [5000, 5000, 5100])
  const restarted = createProjectServiceEvents(); restarted.load(prepared.snapshot)
  const broken = structuredClone(prepared.snapshot), rows = Object.values(broken.projectServiceEvents)
  delete broken.projectServiceEvents[Object.keys(broken.projectServiceEvents)[0]]
  assert.throws(() => restarted.load(broken), /gap|duplicate/)
  const duplicate = structuredClone(prepared.snapshot)
  duplicate.projectServiceEvents.duplicate = rows[0]
  assert.throws(() => restarted.load(duplicate), /gap|duplicate/)
})

test('committed Project facts include current role revision and native activation/exit facts without host data', () => {
  const bus = createProjectServiceEvents(), state = seed()
  state.projectAgentDefinitions = { p: { revision: 1, roles: [] } }
  state.projectAttempts = { a: { id: 'a', projectId: 'p', taskId: 'task' } }
  bus.load(state)
  assert.equal(bus.snapshot('p').project.roleDefinitionRevision, 1)
  const cursor = bus.snapshot('p').cursor, next = structuredClone(state)
  next.projectAgentDefinitions.p.revision = 2
  next.projectNativeWorkers = { native: { id: 'native', projectId: 'p', taskId: 'task', attemptId: 'a', version: 'project-native-worker/v2', role: 'developer', status: 'bound', generation: 2, sessionKey: 'session', sessionId: 'physical', activationEffect: { id: 'activate' }, processScope: { unit: 'HIDDEN_HOST_DETAIL' } } }
  const pending = bus.prepare(next)
  assert.equal(bus.query('p', { after: cursor }).events.length, 0)
  bus.saved(pending)
  const events = bus.query('p', { after: cursor }).events
  assert.equal(events.find(row => row.entityType === 'project').data.roleDefinitionRevision, 2)
  assert.equal(events.find(row => row.entityType === 'execution').data.harness, 'flybot')
  assert.equal(events.find(row => row.entityType === 'execution').data.activationEffectId, 'activate')
  assert.equal(JSON.stringify(events).includes('HIDDEN_HOST_DETAIL'), false)
})

test('committed role approval proposals are public scoped facts without personal proposal contents', () => {
  const bus = createProjectServiceEvents(), state = seed(); bus.load(state)
  const cursor = bus.snapshot('p').cursor, next = structuredClone(state)
  next.projectRoleProposals = { proposal: { id: 'proposal', projectId: 'p', action: 'add', role: 'analyst', status: 'pending', baseRevision: 1, definition: { instructions: 'HIDDEN_DEFINITION' } } }
  next.projectAgentProposals = { personal: { id: 'personal', projectId: 'p', text: 'HIDDEN_PERSONAL_PROPOSAL' } }
  const pending = bus.prepare(next); bus.saved(pending)
  const events = bus.query('p', { after: cursor }).events
  assert.equal(events.length, 1)
  assert.equal(events[0].entityType, 'role-proposal')
  assert.equal(events[0].data.role, 'analyst')
  assert.equal(JSON.stringify(events).includes('HIDDEN_'), false)
  const snapshot = bus.snapshot('p', { entityType: 'role-proposal' })
  assert.deepEqual(snapshot.entities.map(row => row.id), ['proposal'])
  assert.throws(() => bus.snapshot('p', { entityType: 'private-agent' }), /Unknown public/)
})

test('human warning fallback uses committed scoped events and exposes metadata without private evidence', () => {
  const bus = createProjectServiceEvents(), state = seed(); bus.load(state)
  const start = bus.snapshot('p')
  state.projectWarnings = { w: { id: 'w', projectId: 'p', kind: 'chief-duration', at: 1, reason: 'Private diagnostic detail', reads: { owner: { secret: 'not public' } }, delivery: { kind: 'human-mailbox', memberId: 'owner' } } }
  const token = bus.prepare(state)
  assert.equal(bus.query('p', { after: start.cursor }).events.length, 0)
  bus.saved(token)
  const event = bus.query('p', { after: start.cursor }).events[0]
  assert.equal(event.type, 'warning.changed')
  assert(!JSON.stringify(event).includes('Private diagnostic'))
  assert(!JSON.stringify(event).includes('not public'))
  assert.equal(bus.snapshot('p', { entityType: 'warning' }).entities[0].id, 'w')
  assert.equal(bus.snapshot('other', { entityType: 'warning' }).entities.length, 0)
})

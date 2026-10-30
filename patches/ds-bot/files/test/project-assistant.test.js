// The Project Assistant (#1712): one hidden assistant per Project, memory that never crosses a
// Project id, a digest built only from the Project State reader and the board rows, and exactly one
// 09:00 Asia/Shanghai task on the assistant's own Session that goes away with the Project.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { MAX_ACTIONABLE, actionableFor, buildDigest, dayIn } from '../src/host/project-assistant.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  grants: {},
})

// DSH's schedule service, in memory: enough for the host's own create/delete path and its view.
function scheduleService() {
  const tasks = new Map()
  const created = []
  let next = 1
  return {
    tasks,
    created,
    async create(sessionId, request) {
      created.push({ sessionId, request })
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, timing: request[kind], kind, scheduledAt: '2030-01-01T01:00:00.000Z' }
      tasks.set(id, { sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    async delete({ sessionId, id }) {
      const task = tasks.get(id)
      if (task === undefined || task.sessionId !== sessionId) return { deleted: false }
      tasks.delete(id)
      return { deleted: true }
    },
  }
}

async function start({ github = 'Birfy' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-assistant-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const service = scheduleService()
  const ctx = fakeContext({ services: { schedule: service } })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${++sessions}` }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  rt.connectorsView = () => (github === null ? [] : [{ id: 'github', name: 'GitHub', state: 'ready', account: github }])
  const delivered = []
  rt.deliver = async message => { delivered.push(message) }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, service, delivered, stop }
}

const created = async (rt, body) => (await rt.projectEndpoint('project-create', body)).project

test('memory is private to one Project and an unknown id is refused', async () => {
  const { rt, stop } = await start()
  try {
    const one = await created(rt, { name: 'One', ownerUserId: 'owner-1' })
    const two = await created(rt, { name: 'Two', ownerUserId: 'owner-1' })
    await rt.projectEndpoint('project-memory-write', { id: one.id, kind: 'decision', text: 'Ship the memory store' })
    await rt.projectEndpoint('project-memory-write', { id: one.id, kind: 'question', text: 'Who reviews it?' })
    const mine = (await rt.projectEndpoint('project-memory', { id: one.id })).memory
    assert.deepEqual(mine.decisions.map(entry => entry.text), ['Ship the memory store'])
    assert.deepEqual(mine.questions.map(entry => entry.text), ['Who reviews it?'])
    const theirs = (await rt.projectEndpoint('project-memory', { id: two.id })).memory
    assert.deepEqual(theirs.decisions, [])
    assert.deepEqual(theirs.questions, [])
    await assert.rejects(() => rt.projectEndpoint('project-memory', { id: 'project-missing' }), /Unknown Project/)
    assert.throws(() => rt.projectAssistant.read('project-missing'), error => error.code === 'bot/not-found')
  } finally {
    await stop()
  }
})

test('the assistant refuses an unknown Project and an archived one', async () => {
  const { rt, stop } = await start()
  try {
    await assert.rejects(() => rt.projectAssistant.create('project-missing'), error => error.code === 'bot/not-found')
    const project = await created(rt, { name: 'Archived', ownerUserId: 'owner-1' })
    rt.readProject(project.id).status = 'archived'
    await assert.rejects(() => rt.projectAssistant.create(project.id), /is archived/)
  } finally {
    await stop()
  }
})

test('the digest names only the facts the rows carry, in the four-section order', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Digest', ownerUserId: 'owner-1' })
    const at = Date.parse('2026-10-29T01:00:00Z')
    rt.projectBoard = () => [
      { id: 't-merged', source: 'workflow', column: 'done', assignee: null, updatedAt: at - 60_000 },
      { id: 't-closed', source: 'bot', column: 'done', assignee: null, updatedAt: at - 30_000 },
      { id: 't-waiting', source: 'bot', column: 'in-progress', assignee: 'Writer', updatedAt: at - 10_000 },
      { id: 't-next', source: 'group', column: 'not-started', assignee: null, updatedAt: at - 5_000 },
    ]
    const result = await rt.projectAssistant.digest(project.id, { at })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, false)
    const text = result.text
    assert.match(text, /^Written-by: Project Assistant \(Digest\)\nPosted-for: Birfy\n/)
    for (const id of ['t-merged', 't-closed', 't-waiting', 't-next']) assert.match(text, new RegExp(id))
    assert.match(text, /waiting on:\n- t-waiting — Writer|In progress, waiting on:\n- t-waiting — Writer/)
    assert.doesNotMatch(text, /t-absent/, 'a row that does not exist is never named')
    const merged = text.indexOf('Merged since the previous digest:')
    const closed = text.indexOf('Closed:')
    const blocked = text.indexOf('In progress, waiting on:')
    const next = text.indexOf('Next slice:')
    assert.ok(merged > 0 && merged < closed && closed < blocked && blocked < next, text)
    assert.equal(delivered.length, 1)
  } finally {
    await stop()
  }
})

test('a day with no change is one line and the second build adds nothing', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Quiet', ownerUserId: 'owner-1' })
    const at = Date.parse('2026-10-29T01:00:00Z')
    rt.projectBoard = () => []
    const first = await rt.projectAssistant.digest(project.id, { at })
    assert.equal(first.changed, false)
    assert.match(first.text, /no change since the previous digest\.$/)
    const second = await rt.projectAssistant.digest(project.id, { at: at + 60_000 })
    assert.equal(second.skipped, true)
    assert.equal(second.reason, 'today already has a digest')
    assert.equal(delivered.length, 1, 'one delivery for one day')
    assert.equal(dayIn(at), dayIn(at + 60_000))
    const note = rt.projectMemoryOf(project.id).digest
    assert.equal(note.day, dayIn(at))
    assert.match(note.text, /no change/)
  } finally {
    await stop()
  }
})

// The 2.5 identity refusal stays on the GitHub write; it is not a delivery gate (#1733). A digest
// still reaches the owner's own Session, and the refusal is recorded on the digest's evidence.
test('the digest still reaches the owner in-app while the GitHub write refuses', async () => {
  const { rt, delivered, stop } = await start({ github: null })
  try {
    const project = await created(rt, { name: 'No Identity', ownerUserId: 'owner-1' })
    rt.projectBoard = () => []
    const result = await rt.projectAssistant.digest(project.id, { at: Date.parse('2026-10-29T01:00:00Z') })
    assert.equal(result.ok, true)
    assert.equal(result.identity.ok, false)
    assert.equal(result.identity.escalated, true)
    assert.match(result.identity.reason, /no GitHub connector is signed in/)
    assert.equal(result.delivered, 1, 'in-app delivery does not depend on the GitHub identity')
    assert.equal(delivered.length, 1)
    assert.doesNotMatch(delivered[0].text, /^Written-by:/, 'no GitHub attribution without an identity')
    assert.match(rt.projectMemoryFor(project.id, 'owner-1').digest.error, /GitHub write refused: no GitHub connector/)

    rt.connectorsView = () => [{ id: 'github', name: 'GitHub', state: 'ready', account: 'Birfy' }]
    rt.state.members['owner-2'] = { id: 'owner-2', createdAt: 2 }
    const other = await created(rt, { name: 'Somebody Else', ownerUserId: 'owner-2' })
    const second = await rt.projectAssistant.digest(other.id, { at: Date.parse('2026-10-29T01:00:00Z') })
    assert.equal(second.identity.ok, false)
    assert.match(second.identity.reason, /no per-user GitHub linkage/)
    assert.equal(second.delivered, 1, 'and the owner it cannot post for still gets their own digest')
  } finally {
    await stop()
  }
})

test('project-create makes exactly one 09:00 Asia/Shanghai task and project-delete takes it away', async () => {
  const { rt, service, stop } = await start()
  try {
    const project = await created(rt, { name: 'Scheduled', ownerUserId: 'owner-1' })
    assert.equal(service.created.length, 1)
    const request = service.created[0].request
    assert.equal(request.title, '09:00 Project digest')
    assert.deepEqual(request.daily, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
    assert.equal(project.assistant.scheduleId, 'schedule-1')
    const assistant = rt.botOf(project.assistant.botId)
    assert.equal(assistant.hidden, true)
    assert.equal(assistant.projectId, project.id)
    assert.equal(service.tasks.size, 1)

    await rt.projectEndpoint('project-delete', { id: project.id })
    assert.equal(rt.readProject(project.id), null)
    assert.equal(service.tasks.size, 0)
    assert.equal(rt.projectMemoryOf(project.id), null)
  } finally {
    await stop()
  }
})

test('buildDigest is pure: the same rows answer the same four sections', () => {
  const project = { id: 'project-1', name: 'Pure' }
  const rows = [
    { id: 'b', source: 'workflow', column: 'done', assignee: null, updatedAt: 20 },
    { id: 'a', source: 'bot', column: 'in-progress', assignee: 'Writer', updatedAt: 10 },
  ]
  const one = buildDigest({ project, rows, since: null, at: Date.parse('2026-10-29T01:00:00Z') })
  const two = buildDigest({ project, rows, since: null, at: Date.parse('2026-10-29T01:00:00Z') })
  assert.equal(one.text, two.text)
  assert.match(one.text, /Project Assistant \(Pure\) — 2026-10-29/)
  const after = buildDigest({ project, rows, since: 30, at: Date.parse('2026-10-29T01:00:00Z') })
  assert.doesNotMatch(after.text, /b \\(workflow\\)/, 'a finished card older than the previous digest is not reported again')
  assert.match(after.text, /waiting on/)
  const quiet = buildDigest({ project, rows: [], since: 30, at: Date.parse('2026-10-29T01:00:00Z') })
  assert.equal(quiet.changed, false)
  assert.match(quiet.text, /no change since the previous digest\.$/)
})

// --- #1733: per-owner digests, quiet windows that hold, opt-out and one owner's failure -------

// A second owner on the same host, with their own Session (a second chief Bot).
function secondOwner(rt) {
  rt.state.members['owner-2'] = { id: 'owner-2', createdAt: 2, designatedChiefId: 'b' }
  rt.state.bots.b = { id: 'b', name: 'Second Chief', role: 'Boss', sessionId: 'b', createdAt: 2, ownerId: 'owner-2' }
}

const AT = Date.parse('2026-10-29T01:00:00Z')

test('two owners of one Project get two digests from one read, with no memory bleed either way', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Shared', ownerUserId: 'owner-1', ownerUserIds: ['owner-2'] })
    secondOwner(rt)
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'Owner one keeps the deploy key', ownerId: 'owner-1' })
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'Owner two picks the release date', ownerId: 'owner-2' })
    let reads = 0
    rt.projectBoard = () => {
      reads += 1
      return [
        { id: 't-1', source: 'bot', column: 'in-progress', assignee: 'Owner One Bot', ownerId: 'owner-1', updatedAt: 1 },
        { id: 't-2', source: 'bot', column: 'in-progress', assignee: 'Owner Two Bot', ownerId: 'owner-2', updatedAt: 2 },
        { id: 't-3', source: 'bot', column: 'done', assignee: null, updatedAt: 3 },
      ]
    }
    const result = await rt.projectAssistant.digest(project.id, { at: AT })
    assert.equal(reads, 1, 'one board read serves every owner')
    assert.equal(result.owners.length, 2)
    assert.equal(result.delivered, 2)
    const [one, two] = result.owners
    assert.equal(one.owner, 'owner-1')
    assert.equal(two.owner, 'owner-2')
    assert.match(one.text, /Needs owner-1's decision:\n- t-1 /)
    assert.match(two.text, /Needs owner-2's decision:\n- t-2 /)
    assert.doesNotMatch(one.text, /Needs owner-1's decision:[\s\S]*t-2/, "one owner's decisions never list the other's card")
    assert.doesNotMatch(two.text, /Needs owner-2's decision:[\s\S]*t-1/)
    for (const digest of [one.text, two.text]) {
      assert.match(digest, /t-3 \(bot\)/, 'the shared facts are the same for both')
      assert.ok(digest.startsWith('Project Assistant (Shared)'), 'each digest names the Project its facts came from')
      assert.match(digest, /2026-10-29/)
    }
    assert.doesNotMatch(one.text, /release date/, "no line of the other owner's memory")
    assert.doesNotMatch(two.text, /deploy key/)
    assert.deepEqual(delivered.map(message => message.toId), ['a', 'b'], 'one message to each owner Session')
    assert.deepEqual(rt.projectMemoryFor(project.id, 'owner-1').decisions.map(entry => entry.text), ['Owner one keeps the deploy key'])
    assert.deepEqual(rt.projectMemoryFor(project.id, 'owner-2').decisions.map(entry => entry.text), ['Owner two picks the release date'])
  } finally {
    await stop()
  }
})

test('a cross-owner memory read is refused and names the boundary', async () => {
  const { rt, stop } = await start()
  try {
    const project = await created(rt, { name: 'Fenced', ownerUserId: 'owner-1', ownerUserIds: ['owner-2'] })
    secondOwner(rt)
    assert.throws(() => rt.projectAssistant.read(project.id, 'owner-3'), error => error.code === 'bot/refused' && /belongs only to owner-1, owner-2/.test(error.message) && /owner-3 is outside that boundary/.test(error.message))
    await assert.rejects(() => rt.projectAssistant.digest(project.id, { at: AT, ownerId: 'owner-3' }), /outside that boundary/)
    const mine = rt.projectAssistant.read(project.id, 'owner-2')
    assert.deepEqual(mine.memory.decisions, [])
  } finally {
    await stop()
  }
})

test('a quiet window holds the digest and delivers it once, labelled, when it ends', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Held', ownerUserId: 'owner-1' })
    rt.projectBoard = () => [{ id: 't-hold', source: 'bot', column: 'in-progress', assignee: 'Owner One Bot', ownerId: 'owner-1', updatedAt: 1 }]
    await rt.projectAssistant.setOwner(project.id, 'owner-1', { quiet: { on: true, from: '07:00', to: '08:30' }, zone: 'Asia/Shanghai' })
    const inside = Date.parse('2026-10-29T00:00:00Z') // 08:00 Asia/Shanghai
    const after = Date.parse('2026-10-29T00:45:00Z') // 08:45 Asia/Shanghai
    const held = await rt.projectAssistant.digest(project.id, { at: inside })
    assert.equal(held.skipped, false)
    assert.equal(held.delivered, 0)
    assert.equal(held.owners[0].held, true)
    assert.match(held.owners[0].reason, /held, and delivered once when they end/)
    assert.equal(delivered.length, 0, 'nothing is delivered inside the window')
    assert.match(rt.projectMemoryFor(project.id, 'owner-1').digest.text, /t-hold/, 'generation still happened')

    const once = await rt.projectAssistant.digest(project.id, { at: after })
    assert.equal(once.delivered, 1)
    assert.match(delivered[0].text, /held from 08:00 to 08:45 by quiet hours 07:00\u201308:30/)
    const twice = await rt.projectAssistant.digest(project.id, { at: after + 60_000 })
    assert.equal(twice.delivered, 0, 'delivered once, not again')
    assert.equal(delivered.length, 1)
  } finally {
    await stop()
  }
})

test('a quiet window that covers 09:00 delivers nothing, and that is the expected outcome', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Covered', ownerUserId: 'owner-1' })
    rt.projectBoard = () => []
    await rt.projectAssistant.setOwner(project.id, 'owner-1', { quiet: { on: true, from: '09:00', to: '11:00' }, zone: 'Asia/Shanghai' })
    const result = await rt.projectAssistant.digest(project.id, { at: AT })
    assert.equal(result.delivered, 0)
    assert.equal(result.owners[0].held, true)
    assert.equal(result.owners[0].dropped, true)
    assert.match(result.owners[0].reason, /cover 09:00, so nothing is delivered — the expected outcome/)
    assert.equal(delivered.length, 0)
    assert.match(rt.projectMemoryFor(project.id, 'owner-1').digest.text, /no change/, 'the digest was still built')
  } finally {
    await stop()
  }
})

// P-194: the due instant is 09:00 Asia/Shanghai; a quiet window is wall clock in the owner's own
// zone. Two different zones' wall clocks are not comparable, so the window is tested against the
// due instant read in the owner's zone. Red first drives this through setOwner directly: the
// `project-assistant-owner` endpoint has no channel case, so no product-level path exists today
// and the trigger arrives with P-198. Until then this is a latent defect: the digest would be
// dropped silently once a UTC owner's window is set.
test('#P-194: a quiet window in the owner\'s zone is compared with the due instant, not with 09:00', async () => {
  const { rt, stop } = await start()
  try {
    const project = await created(rt, { name: 'UtcWindow', ownerUserId: 'owner-1' })
    rt.projectBoard = () => [{ id: 't-utc', source: 'bot', column: 'in-progress', assignee: 'Owner One Bot', ownerId: 'owner-1', updatedAt: 1 }]
    // 08:00–10:00 UTC does not contain the due instant (01:00Z = 09:00 Asia/Shanghai).
    await rt.projectAssistant.setOwner(project.id, 'owner-1', { quiet: { on: true, from: '08:00', to: '10:00' }, zone: 'UTC' })
    const result = await rt.projectAssistant.digest(project.id, { at: AT }) // 01:00Z
    const owner = result.owners[0]
    assert.equal(result.delivered, 1, 'the window does not cover the due instant, so the digest goes out')
    assert.notEqual(owner.dropped, true, 'nothing was dropped')
    assert.doesNotMatch(String(owner.reason ?? ''), /cover/, 'no drop reason is recorded')
    assert.notEqual(owner.held, true, 'nothing was held either')
  } finally {
    await stop()
  }
})

test('#P-194: a window that really covers the due instant still drops the digest', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'UtcCovered', ownerUserId: 'owner-1' })
    rt.projectBoard = () => []
    await rt.projectAssistant.setOwner(project.id, 'owner-1', { quiet: { on: true, from: '00:30', to: '01:30' }, zone: 'UTC' })
    const result = await rt.projectAssistant.digest(project.id, { at: AT }) // 01:00Z is inside it
    const owner = result.owners[0]
    assert.equal(result.delivered, 0, 'a window covering the due instant delivers nothing')
    assert.equal(owner.dropped, true)
    assert.match(owner.reason, /cover 01:00, so nothing is delivered — the expected outcome/)
    assert.equal(delivered.length, 0)
  } finally {
    await stop()
  }
})

// P-197: the personal block stays five cards, and says how many are left over; five or fewer
// print exactly as they did before.
test('#P-197: more than five decisions say how many are still waiting', () => {
  const rows = Array.from({ length: MAX_ACTIONABLE + 2 }, (_, index) => ({ id: `t-${index}`, source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: index, title: `card ${index}`, status: 'blocked' }))
  const items = actionableFor(rows, 'owner-1')
  assert.equal(items.length, MAX_ACTIONABLE + 2, 'the helper keeps them all')
  const built = buildDigest({ project: { id: 'p', name: 'More' }, rows, owner: 'owner-1', actionable: items, at: AT })
  const personal = built.text.slice(built.text.indexOf("Needs owner-1's decision:"))
  const listed = personal.split('\n').filter(line => /^- t-\d/.test(line))
  assert.equal(listed.length, MAX_ACTIONABLE, 'the digest still lists at most MAX_ACTIONABLE cards')
  assert.match(built.text, /^- … and 2 more waiting on you$/m)
})

test('#P-197: five or fewer decisions print exactly as before', () => {
  const rows = Array.from({ length: MAX_ACTIONABLE }, (_, index) => ({ id: `t-${index}`, source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: index, title: `card ${index}`, status: 'blocked' }))
  const built = buildDigest({ project: { id: 'p', name: 'Five' }, rows, owner: 'owner-1', actionable: actionableFor(rows, 'owner-1'), at: AT })
  assert.doesNotMatch(built.text, /more waiting on you/)
  const personal = built.text.slice(built.text.indexOf("Needs owner-1's decision:"))
  const listed = personal.split('\n').filter(line => /^- t-\d/.test(line))
  assert.equal(listed.length, MAX_ACTIONABLE)
})

// P-195: the personal block is what waits on the reader, not the whole board: a card still being
// worked on is somebody's move, a blocked card needs this reader's call, and a finished result
// needs their acceptance.
test('#P-195: only the cards that wait on the reader reach the personal block', () => {
  const rows = [
    { id: 't-working', source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: 1, title: 'Still moving', status: 'working' },
    { id: 't-blocked', source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: 2, title: 'Stopped on a question', status: 'blocked' },
    { id: 't-ready', source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: 3, title: 'Back for acceptance', status: 'result-ready' },
  ]
  const items = actionableFor(rows, 'owner-1')
  assert.deepEqual(items.map(item => item.id), ['t-blocked', 't-ready'], 'a card that is still moving is nobody else\'s decision to make')
  const built = buildDigest({ project: { id: 'p', name: 'Waiting' }, rows, owner: 'owner-1', actionable: items, at: AT })
  const personal = built.text.slice(built.text.indexOf("Needs owner-1's decision:"))
  assert.match(personal, /Stopped on a question/)
  assert.match(personal, /needs your call/)
  assert.match(personal, /Back for acceptance/)
  assert.match(personal, /ready for your acceptance/)
  assert.doesNotMatch(personal, /Still moving/, 'a card still in progress is not a decision waiting on the reader')
  const shared = built.text.slice(0, built.text.indexOf("Needs owner-1's decision:"))
  assert.match(shared, /In progress, waiting on:/)
  assert.match(shared, /t-working — Worker/, 'the shared section still lists it')
})

test('opting out stops generation and pauses the 09:00 task, and re-enabling restores both', async () => {
  const { rt, service, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Off', ownerUserId: 'owner-1' })
    assert.equal(service.tasks.size, 1)
    const off = await rt.projectAssistant.setOwner(project.id, 'owner-1', { off: true })
    assert.equal(off.off, true)
    assert.equal(off.changed, true)
    assert.equal(off.schedule, 'paused')
    assert.equal(service.tasks.size, 0, 'the 09:00 task no longer wakes the assistant')
    const silent = await rt.projectAssistant.digest(project.id, { at: AT })
    assert.equal(silent.owners[0].optedOut, true)
    assert.equal(silent.delivered, 0)
    assert.equal(delivered.length, 0)
    assert.equal(rt.projectMemoryFor(project.id, 'owner-1').digest, null, 'no generation while off')

    const on = await rt.projectAssistant.setOwner(project.id, 'owner-1', { off: false })
    assert.equal(on.off, false)
    assert.equal(service.tasks.size, 1, 'the task is back')
    const back = await rt.projectAssistant.digest(project.id, { at: AT })
    assert.equal(back.delivered, 1)
    assert.equal(delivered.length, 1)
  } finally {
    await stop()
  }
})

test("one owner's render failing is recorded while the other owner's digest still goes out", async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Isolated', ownerUserId: 'owner-1', ownerUserIds: ['owner-2'] })
    secondOwner(rt)
    rt.projectBoard = () => [{ id: 't-9', source: 'bot', column: 'in-progress', assignee: null, updatedAt: 1 }]
    const realFor = rt.projectMemoryFor
    rt.projectMemoryFor = (id, owner) => {
      if (owner === 'owner-1') throw new Error('owner-1 memory is unreadable')
      return realFor(id, owner)
    }
    const result = await rt.projectAssistant.digest(project.id, { at: AT })
    const [one, two] = result.owners
    assert.equal(one.ok, false)
    assert.equal(one.recorded, true)
    assert.match(one.error, /owner-1 memory is unreadable/)
    assert.equal(two.ok, true)
    assert.equal(two.delivered, true, "B's digest still goes out")
    assert.equal(delivered.length, 1)
    rt.projectMemoryFor = realFor
    assert.match(rt.projectMemoryFor(project.id, 'owner-1').digest.text, /digest failed: owner-1 memory is unreadable/)
  } finally {
    await stop()
  }
})

test('actionable items are capped and only the owner\'s own cards appear', () => {
  const rows = Array.from({ length: MAX_ACTIONABLE + 3 }, (_, index) => ({ id: `t-${index}`, source: 'bot', column: 'in-progress', assignee: 'Worker', ownerId: 'owner-1', updatedAt: index, title: `card ${index}` }))
  rows.push({ id: 'theirs', source: 'bot', column: 'in-progress', assignee: 'Theirs', ownerId: 'owner-2', updatedAt: 99, title: 'not yours' })
  const items = actionableFor(rows, 'owner-1')
  assert.equal(items.length, MAX_ACTIONABLE + 3, 'the helper keeps them all…')
  assert.ok(items.every(item => item.id !== 'theirs'), '…but never another owner\'s card')
  const built = buildDigest({ project: { id: 'p', name: 'Cap' }, rows, owner: 'owner-1', actionable: items, at: AT })
  const personal = built.text.slice(built.text.indexOf("Needs owner-1's decision:"))
  const listed = personal.split('\n').filter(line2 => line2.startsWith('- t-'))
  assert.equal(listed.length, MAX_ACTIONABLE, 'the digest lists at most MAX_ACTIONABLE')
  assert.match(built.text, /- t-0 — decide what happens next — card 0 \(still in-progress\)/)
  assert.doesNotMatch(built.text, /not yours/)
})

test('a card lists for the owner of the Bot that owns it, through the real task and board path', async () => {
  const { rt, stop } = await start()
  try {
    const project = await created(rt, { name: 'Boarded', ownerUserId: 'owner-1', ownerUserIds: ['owner-2'] })
    secondOwner(rt)
    rt.state.bots.worker = { id: 'worker', name: 'Worker', role: 'Dev', sessionId: 'w', createdAt: 3, ownerId: 'owner-2' }
    await rt.projectEndpoint('project-bind', { kind: 'bot', id: 'a', projectId: project.id })
    await rt.projectEndpoint('project-bind', { kind: 'bot', id: 'worker', projectId: project.id })
    const pick = (await rt.taskEndpoint('task-create', { botId: 'worker', title: 'Pick the release date' }, null)).id
    const rotate = (await rt.taskEndpoint('task-create', { botId: 'a', title: 'Rotate the deploy key' }, null)).id
    const moving = (await rt.taskEndpoint('task-create', { botId: 'a', title: 'Still moving' }, null)).id
    // A card waits on its reader only once it has stopped: drive both to `blocked`, which the
    // digest reads from the task store itself, and leave one of the owner's cards `working`.
    for (const id of [pick, rotate]) {
      await rt.taskEndpoint('task-accept', { id }, null)
      await rt.taskEndpoint('task-start', { id }, null)
      await rt.taskEndpoint('task-wait-input', { id, question: 'Which one?' }, null)
    }
    await rt.taskEndpoint('task-accept', { id: moving }, null)
    await rt.taskEndpoint('task-start', { id: moving }, null)
    const rows = rt.projectBoard(project.id)
    assert.equal(rows.length, 3)
    assert.ok(rows.every(row => row.assignee === null), 'the board carries a Bot name or null, never a member id')
    assert.equal(actionableFor(rows, 'owner-1').length, 0, 'the raw helper sees no owner without a resolver')
    const result = await rt.projectAssistant.digest(project.id, { at: AT })
    const [one, two] = result.owners
    assert.match(one.text, /Rotate the deploy key/, 'the card of the primary owner\'s Bot is theirs')
    assert.doesNotMatch(one.text, /Pick the release date/, 'another owner\'s card never appears in this digest')
    assert.doesNotMatch(one.text, /Still moving/, 'a card the owner\'s Bot is still working on waits on nobody')
    assert.match(two.text, /Pick the release date/, 'the card of the second owner\'s Bot is theirs')
    assert.doesNotMatch(two.text, /Rotate the deploy key/)
  } finally {
    await stop()
  }
})

test('a memory record written before the owner dimension keeps its entries across the first write', async () => {
  const { rt, stop } = await start()
  try {
    const project = await created(rt, { name: 'Legacy', ownerUserId: 'owner-1' })
    rt.state.projectMemory[project.id] = {
      decisions: [{ text: 'the old call', at: 1 }],
      questions: [{ text: 'the old question', at: 1 }],
      digest: { day: '2026-10-27', at: 1000, text: 'the old note' },
    }
    assert.deepEqual(rt.projectMemoryFor(project.id, 'owner-1').decisions.map(entry => entry.text), ['the old call'], 'the pre-slice record reads back for its primary owner')
    assert.equal(rt.projectMemoryFor(project.id, 'owner-1').digest.text, 'the old note')
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'the new call', ownerId: 'owner-1' })
    const view = rt.projectMemoryFor(project.id, 'owner-1')
    assert.deepEqual(view.decisions.map(entry => entry.text), ['the old call', 'the new call'], 'the first write after the upgrade appends instead of replacing')
    assert.deepEqual(view.questions.map(entry => entry.text), ['the old question'], 'the old questions survive')
    assert.equal(view.digest.text, 'the old note', 'so does the last digest, so the next build is not re-based')
  } finally {
    await stop()
  }
})

test('an owner without a Session never receives another owner\'s digest', async () => {
  const { rt, delivered, stop } = await start()
  try {
    const project = await created(rt, { name: 'Unseated', ownerUserId: 'owner-1', ownerUserIds: ['owner-2'] })
    rt.state.members['owner-2'] = { id: 'owner-2', createdAt: 2 }
    const result = await rt.projectAssistant.digest(project.id, { at: AT })
    assert.equal(result.delivered, 1)
    assert.deepEqual(delivered.map(message => message.toId), ['a'], 'only the primary owner has a Session of their own')
    assert.equal(result.owners[1].owner, 'owner-2')
    assert.equal(result.owners[1].delivered, false)
    assert.match(result.owners[1].reason, /no Session of their own/)
    assert.match(rt.projectMemoryFor(project.id, 'owner-2').digest.error, /no Session of their own/, 'the reason is recorded on that owner\'s own note')
  } finally {
    await stop()
  }
})

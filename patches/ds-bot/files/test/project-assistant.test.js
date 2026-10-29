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
import { buildDigest, dayIn } from '../src/host/project-assistant.js'

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

test('identity refuses with no connector and on a multi-member host that is not the owner', async () => {
  const { rt, delivered, stop } = await start({ github: null })
  try {
    const project = await created(rt, { name: 'No Identity', ownerUserId: 'owner-1' })
    const refused = await rt.projectAssistant.digest(project.id, { at: Date.parse('2026-10-29T01:00:00Z') })
    assert.equal(refused.ok, false)
    assert.equal(refused.escalated, true)
    assert.match(refused.reason, /no GitHub connector is signed in/)
    assert.equal(delivered.length, 0, 'a refused identity posts nothing')
    assert.equal(rt.projectMemoryOf(project.id)?.digest ?? null, null, 'and leaves no note behind')

    rt.connectorsView = () => [{ id: 'github', name: 'GitHub', state: 'ready', account: 'Birfy' }]
    rt.state.members['owner-2'] = { id: 'owner-2', createdAt: 2 }
    const other = await created(rt, { name: 'Somebody Else', ownerUserId: 'owner-2' })
    const refusedToo = await rt.projectAssistant.digest(other.id, { at: Date.parse('2026-10-29T01:00:00Z') })
    assert.equal(refusedToo.ok, false)
    assert.equal(refusedToo.escalated, true)
    assert.match(refusedToo.reason, /no per-user GitHub linkage/)
    assert.equal(delivered.length, 0)
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

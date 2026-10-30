// #1846: the 09:00 Project digest read the board with no actor, so on any install where somebody
// had signed in the visibility rule filtered every card out and the digest answered "no change"
// every day — and that sentence was stored as the next run's `since`. The digest now asks the
// Project's own board through an explicit internal read; the channel path keeps the reader's rule.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// One member has signed in (#1846): that single line is what turns `authzEnforced()` on, and it is
// the only difference from `project-assistant.test.js`'s seed. `owner-1` and `owner-2` own the two
// Bots, `member-3` is a signed-in member who owns neither.
const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2 },
    'member-3': { id: 'member-3', createdAt: 3 },
  },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    worker: { id: 'worker', name: 'Worker', role: 'Dev', sessionId: 'w', createdAt: 2, ownerId: 'owner-2' },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  authSessions: { 's-3': { memberId: 'member-3', tokenHash: 't' } },
})

function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    async create(sessionId, request) {
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, title: request.title, prompt: request.prompt, timing: request[kind], kind, scheduledAt: '2030-01-01T01:00:00.000Z' }
      tasks.set(id, { sessionId, record, status: 'active' })
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

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-digest-authz-'))
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext({ services: { schedule: scheduleService() } })
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
  rt.connectorsView = () => [{ id: 'github', name: 'GitHub', state: 'ready', account: 'Birfy' }]
  rt.deliver = async () => {}
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, stop }
}

const created = async (rt, body) => (await rt.projectEndpoint('project-create', body)).project
const at = Date.parse('2026-10-30T01:00:00Z')

// A Project bound to the two Bots, and one card per Bot driven to `working`. The board row names the
// Bot a card is assigned to and a Bot-owned card carries no assignee of its own, so the fixture
// writes the field the row reads — the probe's own row was `["task-1","in-progress","Worker"]`.
async function projectWithCards(rt, titles = ['The card on the board'], { wait = false } = {}) {
  const project = await created(rt, { name: 'P1', ownerUserId: 'owner-1', ownerUserIds: ['owner-1', 'owner-2'] })
  const cards = []
  const seats = [['a', 'owner-1', 'Chief'], ['worker', 'owner-2', 'Worker']]
  for (const [index, [botId, owner, name]] of seats.slice(0, titles.length).entries()) {
    // Binding a Bot to a Project is the primary owner's write (#1740), whatever owner the Bot has.
    await rt.projectEndpoint('project-bind', { kind: 'bot', id: botId, projectId: project.id }, { memberId: 'owner-1' })
    const card = await rt.taskEndpoint('task-create', { botId, title: titles[index] }, { memberId: owner })
    await rt.taskEndpoint('task-accept', { id: card.id }, { memberId: owner })
    await rt.taskEndpoint('task-start', { id: card.id }, { memberId: owner })
    if (wait) await rt.taskEndpoint('task-wait-input', { id: card.id, question: 'Which one?' }, { memberId: owner })
    rt.state.tasks[card.id].assignee = name
    cards.push(card)
  }
  return { project, cards }
}

test('#1846: on a signed-in install the digest names the card in progress on the board', async () => {
  const { rt, stop } = await start()
  try {
    assert.equal(rt.authzEnforced(), true, 'the seed has a session, so the per-reader rule is live')
    const { project, cards } = await projectWithCards(rt)
    const result = await rt.projectAssistant.digest(project.id, { at })
    const owner = result.owners.find(entry => entry.owner === 'owner-1')
    assert.match(owner.text, new RegExp(cards[0].id), 'the digest names the card it can no longer read blind')
    assert.match(owner.text, /In progress, waiting on:\n- \S+ — Chief/)
    assert.doesNotMatch(owner.text, /no change since the previous digest/, 'a moving board is not "no change"')
  } finally { await stop() }
})

test('#1846: the digest stored for the next run is the same text, so the watermark is not empty', async () => {
  const { rt, stop } = await start()
  try {
    const { project, cards } = await projectWithCards(rt)
    const result = await rt.projectAssistant.digest(project.id, { at })
    const archived = rt.projectMemoryFor(project.id, 'owner-1').digest
    assert.ok(archived !== null && typeof archived === 'object', 'the run archives its note as the next `since`')
    assert.match(archived.text, new RegExp(cards[0].id), 'the archived text names the card too')
    const delivered = result.owners.find(entry => entry.owner === 'owner-1')
    assert.match(delivered.text, new RegExp(cards[0].id), 'and it is the text that was delivered')
  } finally { await stop() }
})

test('#1846: the internal read is opt-in — the channel and the plain call keep the reader rule', async () => {
  const { rt, stop } = await start()
  try {
    const { project, cards } = await projectWithCards(rt, ['First card', 'Second card'])
    // The shape the digest used to call: no actor, no options. A default stays a default.
    const plain = await rt.projectBoard(project.id)
    assert.deepEqual(plain.rows, [], 'a call without the flag still shows a reader-less caller nothing')
    // The channel path: the owner of the card's Bot still sees it, another signed-in member does not,
    // and `internal` in the request body is not a way in — the store never forwards it.
    const theirs = await rt.projectEndpoint('project-board', { id: project.id, internal: true }, { memberId: 'member-3' })
    assert.deepEqual(theirs.tasks, [], 'a body flag cannot widen the channel read')
    const owner = await rt.projectEndpoint('project-board', { id: project.id }, { memberId: 'owner-2' })
    assert.deepEqual(owner.tasks.map(row => row.id), [cards[1].id], 'the reading member sees their own card')
    // The digest's own read: explicit, and only explicit.
    const internal = await rt.projectBoard(project.id, null, { internal: true })
    assert.deepEqual(internal.rows.map(row => row.id).sort(), cards.map(card => card.id).sort(), 'the internal read sees the Project')
  } finally { await stop() }
})

test('#1846: both owners get the shared facts, and each personal block keeps its own cards', async () => {
  const { rt, stop } = await start()
  try {
    const { project, cards } = await projectWithCards(rt, ['Alpha card', 'Beta card'], { wait: true })
    const result = await rt.projectAssistant.digest(project.id, { at })
    const one = result.owners.find(entry => entry.owner === 'owner-1')
    const two = result.owners.find(entry => entry.owner === 'owner-2')
    for (const entry of [one, two]) {
      for (const card of cards) assert.match(entry.text, new RegExp(card.id), 'the shared sections name every card')
    }
    assert.match(one.text, /Alpha card/, 'the primary owner sees their own decision')
    assert.doesNotMatch(one.text, /Beta card/, 'and never the other owner\'s')
    assert.match(two.text, /Beta card/)
    assert.doesNotMatch(two.text, /Alpha card/)
  } finally { await stop() }
})

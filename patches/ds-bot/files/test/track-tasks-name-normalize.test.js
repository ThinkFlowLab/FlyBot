// #2637: the group board compared a Bot name and a group name raw, while every other door to
// the same objects normalises them (trim + lowercase, and `unquote` for a group). One name the
// rest of the host resolved was refused here with "No single Bot named …" / "No single group
// named …", so a lead recording a group plan lost the card. The refusal for a genuinely
// missing or ambiguous name stays as it was.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const bot = (id, name, role, createdAt) => ({ id, name, role, sessionId: id, createdAt, ownerId: 'owner-1', createdBy: 'a' })
const person = (id, role) => ({ kind: 'bot', id, role, displayName: id, joinedSeq: 0, joinedAt: 1 })

// One room, "Delivery Group", whose two members are the Chief and a Bot named "Dev". `extra`
// lets a test seat another Bot, or one outside the room, to keep the refusal paths alive.
const team = (extra = {}) => {
  const bots = {
    a: bot('a', 'Chief', 'Lead', 1),
    d1: bot('d1', 'Dev', 'Dev', 2),
    ...(extra.bots ?? {}),
  }
  const members = ['a', 'd1', ...(extra.members ?? [])]
  return {
    version: 2,
    revision: 1,
    mainBotIds: ['a'],
    members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
    bots,
    rooms: {
      'room-1': {
        id: 'room-1', name: 'Delivery Group', members, admin: 'a', mode: 'everyone', named: true,
        sessions: {}, log: [], seq: 0, seen: {},
        participants: [
          { kind: 'human', id: 'owner-1', role: 'admin', displayName: 'Alice', joinedSeq: 0, joinedAt: 1 },
          ...members.filter(id => bots[id]).map(id => person(id, id === 'a' ? 'admin' : 'member')),
        ],
      },
    },
    grants: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
  }
}

async function start(t, state) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-name-normalize-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {},
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'made-1' }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    try { await ctx.dispose() } catch {}
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const track = (sessionId, args) => ctx.registeredTools.get('track_tasks').execute(args, { agent: { id: sessionId } })
  const idOf = (body) => {
    const id = String(body).match(/task-[0-9a-f]+/)?.[0]
    assert.ok(id, String(body))
    return id
  }
  const overall = async (group) => idOf(await track('a', { tasks: [{ group, title: 'Ship 18', overall: true }] }))
  return { rt, ctx, track, idOf, overall }
}

test('a Bot name resolves on the board however it is typed (#2637)', async (t) => {
  const { rt, track, idOf, overall } = await start(t, team())
  const parent = await overall('Delivery Group')

  for (const typed of ['Dev', 'dev', ' DEV ']) {
    const created = await track('a', { tasks: [{ group: 'Delivery Group', title: `part ${typed}`, parent, assignee: typed }] })
    assert.doesNotMatch(String(created), /No single Bot named/, `assignee ${JSON.stringify(typed)} resolved`)
    const id = idOf(created)
    assert.equal(rt.state.tasks[id].ownerBotId, 'd1', `assignee ${JSON.stringify(typed)} lands on the one Bot named "Dev"`)
  }
})

test('a group name resolves on the board however it is typed (#2637)', async (t) => {
  const { rt, track, idOf } = await start(t, team())
  const parent = idOf(await track('a', { tasks: [{ group: 'delivery group', title: 'Ship 19', overall: true }] }))
  assert.equal(rt.state.tasks[parent].origin.roomId, 'room-1', 'the lowercase group name found "Delivery Group"')

  const created = await track('a', { tasks: [{ group: '"Delivery Group"', title: 'part quoted', parent, assignee: 'Dev' }] })
  assert.doesNotMatch(String(created), /No single group named/, 'a quoted group name resolved too')
})

test('a name that is not in the room still refuses (#2637)', async (t) => {
  const { track, overall } = await start(t, team({ bots: { d2: bot('d2', 'Tester', 'QA', 3) }, members: [] }))
  const parent = await overall('Delivery Group')
  const refused = await track('a', { tasks: [{ group: 'Delivery Group', title: 'part', parent, assignee: 'Tester' }] })
  assert.match(String(refused), /No single Bot named "Tester" in this group/)
})

test('a name that matches two Bots still refuses (#2637)', async (t) => {
  const { track, overall } = await start(t, team({ bots: { d3: bot('d3', 'DEV', 'Dev', 4) }, members: ['d3'] }))
  const parent = await overall('Delivery Group')
  const refused = await track('a', { tasks: [{ group: 'Delivery Group', title: 'part', parent, assignee: 'dev' }] })
  assert.match(String(refused), /No single Bot named "dev" in this group/)
})

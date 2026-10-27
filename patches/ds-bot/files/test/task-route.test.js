// A board write can hand an open card to another local Bot (#1318). The listener
// sees the saved view once; a second save for the move does not ask again.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev1', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    d2: { id: 'd2', name: 'Dev2', role: 'dev', sessionId: 'd2', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
    f1: { id: 'f1', name: 'Friend', sessionId: 'f1', createdAt: 4, ownerId: 'owner-1', remote: { handle: 'friend' } },
  },
  rooms: {},
  grants: {},
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-route-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId }, id: sessionId, calls: [], status: 'idle',
        inbox: { nextStep: [], nextTurn: [], remove() { return false } },
        followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'made' }),
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
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return rt
}

test('task-create and task-update apply a local owner and ignore a remote or a throw', async (t) => {
  const rt = await start(t)
  const seen = []
  rt.flybot.scope('flybot-workflow').tasks.onWrite((task, kind) => {
    seen.push({ title: task.title, kind, owner: task.ownerBotId })
    if (String(task.title).includes('route-me')) return { ownerBotId: 'd2' }
    if (String(task.title).includes('remote')) return { ownerBotId: 'f1' }
    if (String(task.title).includes('missing')) return { ownerBotId: 'nope' }
    if (String(task.title).includes('boom')) throw new Error('listener blew up')
    return null
  })

  const routed = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'please route-me' }, null)
  assert.equal(routed.ownerBotId, 'd2')
  assert.equal(seen.filter(item => item.title === 'please route-me').length, 1)

  const stayed = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'leave this card' }, null)
  assert.equal(stayed.ownerBotId, 'd1')

  const remote = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'remote hint' }, null)
  assert.equal(remote.ownerBotId, 'd1')

  const missing = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'missing bot' }, null)
  assert.equal(missing.ownerBotId, 'd1')

  const blown = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'boom' }, null)
  assert.equal(blown.ownerBotId, 'd1')

  const updated = await rt.taskEndpoint('task-update', { id: stayed.id, title: 'now route-me' }, null)
  assert.equal(updated.ownerBotId, 'd2')
  assert.equal(updated.ownerBotName, 'Dev2')
  assert.equal(seen.filter(item => item.kind === 'update').length, 1)
})

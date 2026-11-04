// #2468: the facts of a card live on the card, not on the run that picked it up.
// A `brief` written through the board is stored and read back whole, with its line
// breaks, so a re-dispatch can carry it without the caller passing it again.
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
  },
  rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-brief-'))
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

test('a card keeps its brief, and a later update changes only what it names', async (t) => {
  const rt = await start(t)
  const facts = 'Facts line one.\nFacts line two, with detail.\n  Indented detail stays.'
  const [card] = await rt.trackBotTasks('d1', { tasks: [{ title: 'Carry the facts', brief: facts }] })
  assert.equal(card.brief, facts)

  const updated = await rt.taskEndpoint('task-update', { id: card.id, title: 'Carry the facts' }, null)
  assert.equal(updated.brief, facts)

  const replaced = await rt.taskEndpoint('task-update', { id: card.id, brief: 'one new line' }, null)
  assert.equal(replaced.brief, 'one new line')

  const plain = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'No brief here' }, null)
  assert.equal(plain.brief, undefined)
})

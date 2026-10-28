// @flybot/workflow against the real ctx.flybot host (ds-bot's hooks.js), not the mock
// (ThinkFlowLab/FlyBot#34). #1475 removed the dead `workflow/say` surface: the bot route strips
// its `flybot/` prefix and asks the host for `workflow/say` (core/src/host/channel.js:701), and a
// name no plugin registered is answered by the host itself (core/src/host/hooks.js:1044). So the
// removed endpoint must come back as `Unknown FlyBot endpoint workflow/say` with code
// `bot/not-found` — never `{ ok: true }`, never an empty object.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from 'ds-bot'
import * as workflow from '../index.js'
import { fakeCordis } from './fake-cordis.js'

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'flybot-workflow-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeCordis()
  // A run Bot is dispatched to like any other Bot, so the host has to resolve one.
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      agents.set(id, {
        session: { id }, id, calls: [], status: 'idle',
        inbox: { nextStep: [], nextTurn: [], remove() { return false } },
        followup(message) { this.calls.push(message) },
        steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { if (options.path.endsWith('bot')) route = options; return register(options) }
  // A run Bot is granted a permission preset on creation; the fake profile offers one.
  ctx.set('permissionPresets', {
    catalog: () => ({ options: [{ value: 'danger-full-access' }], defaultPreset: 'danger-full-access' }),
    resolve: () => 'danger-full-access',
    set: () => {},
  })
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, call, stop }
}

test('workflow plugin on the real host: the removed say endpoint is unknown, not an empty answer', async (t) => {
  const h = await start()
  t.after(h.stop)
  h.ctx.plugin(workflow, { persist: false })
  const state = await h.call('flybot/workflow/state')
  assert.equal(state.ok, true, 'the plugin is loaded, so the name is the only thing missing')
  assert.ok(state.value.workflows.length > 0)
  assert.deepEqual(await h.call('flybot/workflow/say', { workflowId: 'delivery', text: 'hi' }), {
    ok: false,
    error: { code: 'bot/not-found', message: 'Unknown FlyBot endpoint workflow/say', details: {} },
  })
})

// The conversation path is a board write (#1462). A card a Bot records through the real
// `track_tasks` tool with `workflow:<id>` starts that run, and a repeat does not start a second.
test('a card written through track_tasks starts the workflow it names', async (t) => {
  const h = await start()
  t.after(h.stop)
  h.ctx.plugin(workflow, { persist: false })
  assert.equal((await h.call('flybot/workflow/state')).value.tasksWired, true)

  const track = h.ctx.registeredTools.get('track_tasks')
  assert.ok(track, 'the host registers track_tasks')
  const body = await track.execute({ tasks: [{ title: 'workflow:delivery', column: 'not-started' }] }, { agent: { id: 'b' } })
  const taskId = String(body).match(/task-[0-9a-f]+/)?.[0]
  assert.ok(taskId, body)

  const lane = async () => (await h.call('flybot/workflow/state')).value.workflows.find(item => item.id === 'delivery')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await lane()).activeCount === 0) await new Promise(r => setTimeout(r, 20))
  const started = await lane()
  assert.equal(started.activeCount, 1, 'the card a Bot recorded starts the run')
  assert.equal(started.run.task.id, taskId)

  await track.execute({ tasks: [{ id: taskId, title: 'workflow:delivery' }] }, { agent: { id: 'b' } })
  await new Promise(r => setTimeout(r, 30))
  const again = await lane()
  assert.equal(again.activeCount, 1, 'a second write of the same card starts nothing')
  assert.equal(again.run.task.id, taskId)
})

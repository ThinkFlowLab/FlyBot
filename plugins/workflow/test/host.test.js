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
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => undefined, selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { if (options.path.endsWith('bot')) route = options; return register(options) }
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

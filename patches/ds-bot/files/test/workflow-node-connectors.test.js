// #1521 (C): a Workflow node's `tools` selects connectors and nothing else. The node Bot keeps
// the file and shell rights a normal sidebar Bot has, and a connector is available only when the
// node named it — `github` for `mcp__github__*`, `composio` for `mcp__composio__*`. This is the
// end-to-end seam: the built-in delivery template really spawns through the plugin, the host really
// writes `stepTools`, and the host's own connector guard is what answers.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply as applyWorkflow } from '../../plugins/workflow/index.js'
import { DELIVERY_ID } from '../../plugins/workflow/src/template.js'
import { createRuntime, provideFlyBot } from '../index.js'
import { EPHEMERAL_REFUSAL } from '../src/host/tools.js'
import { fakeContext } from './fake-ctx.js'

const GITHUB = ['mcp__github__create_issue', 'mcp__github__get_me']
const COMPOSIO = ['mcp__composio__COMPOSIO_SEARCH_TOOLS']
// What a real profile serves: the connectors and a few ordinary tools.
const SERVED = [...GITHUB, ...COMPOSIO, 'read', 'edit', 'bash', 'message_bot', 'request_secret']

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'flybot-node-connectors-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext({
    services: {
      permissionPresets: {
        catalog: () => ({ options: [{ value: 'danger-full-access' }, { value: 'auto' }], defaultPreset: 'danger-full-access' }),
        resolve: () => {},
        set: () => {},
      },
    },
  })
  const agents = new Map()
  const masks = new Map()
  const agentOf = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      followup() {},
      steer() {},
      inbox: { nextStep: [], nextTurn: [] },
      session: { id, header: {} },
      ctx: {
        tools: {
          restrict: ({ deny }) => {
            const mask = new Set(deny)
            masks.set(id, [...(masks.get(id) ?? []), mask])
            ctx.emit('tools/change')
            return () => { masks.set(id, (masks.get(id) ?? []).filter(entry => entry !== mask)); ctx.emit('tools/change') }
          },
        },
        effect: execute => execute(),
      },
    }
    agents.set(id, agent)
    await Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
    return agent
  }
  const listed = id => new Set([...(masks.get(id) ?? [])].flatMap(mask => [...mask]))
  ctx.tools.schemas = agent => SERVED.filter(name => !listed(agent?.id).has(name)).map(name => ({ name }))
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `run${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentOf(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessions: { get: id => agents.get(id)?.session, flush: async () => {} },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, composio: false, diagnosticsFile: false })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  // DSH asks the guards before it dispatches, and a guard's answer ends the call.
  const guardFor = (id, name) => ctx.guards
    .map(check => check({ name, agent: id === undefined ? undefined : { id, session: agents.get(id)?.session } }))
    .find(reason => reason !== undefined)
  const hiddenFrom = id => [...listed(id)].filter(name => name.startsWith('mcp__'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, agents, agentOf, guardFor, hiddenFrom, stop }
}

// The run Bots a workflow spawned, keyed by the node that owns them.
const nodeBots = (rt) => {
  const byNode = new Map()
  for (const bot of rt.state?.bots ? Object.values(rt.state.bots) : []) {
    if (bot.ephemeral === undefined) continue
    byNode.set(bot.fields?.['flybot-workflow']?.nodeId ?? bot.fields?.nodeId, bot)
  }
  return byNode
}

test('the built-in delivery nodes make github available exactly where the node names it', async (t) => {
  const { rt, guardFor, hiddenFrom, stop } = await start()
  t.after(stop)
  const { enabled, service, dispose } = await applyWorkflow(rt.ctx, { persist: false })
  assert.equal(enabled, true)
  t.after(() => dispose?.())
  const assigned = await service.assign({ workflowId: DELIVERY_ID, taskId: 'task-1521', title: 'Ship it' })
  assert.equal(assigned.ok, true, assigned.error ?? '')
  // Each edge carries one output, so a step has to produce it for the next node to start.
  const outputs = { planner: { plan: 'the plan' }, writer: { copy: 'the copy' }, coder: { patch: 'the patch' }, reviewer: { review: 'lgtm' }, tester: { report: 'green' } }
  for (const nodeId of ['planner', 'writer', 'coder', 'reviewer', 'tester']) {
    const state = await service.advance({ workflowId: DELIVERY_ID, nodeId, outcome: 'done', outputs: outputs[nodeId] })
    assert.notEqual(state?.ok, false, `${nodeId} advanced: ${state?.error ?? ''}`)
  }
  const byNode = nodeBots(rt)
  for (const nodeId of ['planner', 'writer', 'coder', 'reviewer', 'tester', 'deployer']) {
    assert.ok(byNode.get(nodeId), `${nodeId} spawned a run Bot`)
  }

  for (const nodeId of ['coder', 'reviewer', 'deployer']) {
    const bot = byNode.get(nodeId)
    const refusal = guardFor(bot.id, GITHUB[1])
    assert.equal(refusal, undefined, `${nodeId} may call a github tool: ${refusal ?? ''}`)
    assert.ok(bot.stepTools?.includes('github'), `${nodeId} recorded github as a step tool`)
    assert.deepEqual(hiddenFrom(bot.id), COMPOSIO, `${nodeId} keeps github and hides composio`)
    assert.match(guardFor(bot.id, COMPOSIO[0]), /not granted to this run/, `${nodeId} may not call composio`)
  }

  // The tester names bash only, and planner/writer name nothing: no connector for either.
  const tester = byNode.get('tester')
  assert.deepEqual(tester.stepTools, ['bash'])
  assert.match(guardFor(tester.id, GITHUB[0]), /not granted to this run/)
  for (const nodeId of ['planner', 'writer']) {
    const bot = byNode.get(nodeId)
    assert.equal(bot.stepTools, undefined, `${nodeId} names no connector, so the host stores no step tools`)
    assert.match(guardFor(bot.id, GITHUB[0]), /not granted to this run/, `${nodeId} reaches no github tool`)
  }
})

test('a node Bot still keeps full file/shell rights and the team tools stay refused', async (t) => {
  const { ctx, rt, guardFor, stop } = await start()
  t.after(stop)
  const fb = rt.flybot.scope('flybot-workflow')
  const id = await fb.bot.create({
    name: 'Runner ab', role: 'Run', ephemeral: true, permission: 'danger-full-access',
    tools: ['github', 'bash', 'read', 'message_bot', 'request_secret'],
  })
  const record = rt.botOf(id)
  assert.deepEqual(record.stepTools, ['github', 'bash', 'read', 'message_bot', 'request_secret'], 'the declared list is the step tool list')
  assert.equal(record.permission, 'danger-full-access', 'file and shell rights are a normal Bot\'s')
  assert.equal(guardFor(id, GITHUB[0]), undefined, 'the connector the step named is allowed')
  // ② a connector the step did not name, and ④ a team tool even though the step named it
  assert.match(guardFor(id, COMPOSIO[0]), /not granted to this run/)
  assert.equal(guardFor(id, 'message_bot'), EPHEMERAL_REFUSAL)
  assert.equal(guardFor(id, 'request_secret'), EPHEMERAL_REFUSAL)
  // ③ the Bot's own switch still wins: a turned-off connector is refused, and hidden
  const agent = await ctx.sessionController.resolveAgent(id)
  const listedNow = () => ctx.tools.schemas(agent.agent).map(schema => schema.name).filter(name => name.startsWith('mcp__')).sort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(listedNow(), [...GITHUB].sort(), 'github is listed, composio is not')
  record.connectors = { github: false }
  ctx.emit('tools/change')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.match(guardFor(id, GITHUB[0]), /The github connector is turned off for Runner ab\./)
  assert.match(guardFor(id, GITHUB[0]), /cannot turn a connector back on/)
  assert.deepEqual(listedNow(), [], 'both connectors are hidden once the Bot switch is off')
})

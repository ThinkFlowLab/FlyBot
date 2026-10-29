import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
// A run Bot (ephemeral) is not a team member (#1445). Its node's `tools` decides connectors and
// the shell only, so the host refuses every tool whose effect reaches past its own Session — in the
// call guard, in the approval seam, and in its own tool list — and keeps only the read-only names
// plus its own memory. This file measures that the two seams agree and that nothing happened.

import { EPHEMERAL_ALLOWED_TOOLS, EPHEMERAL_DENIED_TOOLS, EPHEMERAL_REFUSAL } from '../src/host/tools.js'
import { SCHEDULE_TOOLS } from '../src/host/connector-access.js'
import { fakeContext } from './fake-ctx.js'

const DENIED = new Set(EPHEMERAL_DENIED_TOOLS)
const ALLOWED = new Set(EPHEMERAL_ALLOWED_TOOLS)
const sorted = names => [...names].sort()

// The harness-side write tools the run Bot is served in a real profile. `schedule_list` is the one
// harness name that stays; the other four are write or messaging tools.
const HARNESS_TOOLS = [...SCHEDULE_TOOLS, 'send_message']

// The tool a source registers is `name: '<tool>'` right inside a register()/registerTool() call.
// Reading the plugin source is what makes a rename fail here instead of failing open: the core
// constant names these tools, and the plugin is the only place that knows the current spelling.
const toolRegistration = /(?:registerTool|tools\.register)\(\s*(?:defineTool\(\s*)?\{[^{}]*?name:\s*'([a-z][a-z0-9_]*)'/g
const registeredNames = path => [...readFileSync(new URL(path, import.meta.url), 'utf8').matchAll(toolRegistration)].map(match => match[1])

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 3 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

async function start(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-run-tools-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const warns = []
  ctx.logger.warn = (...args) => warns.push(args.map(String).join(' '))
  const agents = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  apply(ctx, { home, ...config })
  // A fresh Session per run Bot, the way workflows.js gets one.
  let sessions = 0
  ctx.sessionController.create = async () => ({ sessionId: `run${++sessions}` })
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, { id, calls: [], followup(m) { this.calls.push(m) }, steer(m) { this.calls.push(m) }, inbox: { nextStep: [], nextTurn: [] }, session: { id } })
    return agents.get(id)
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  // DSH asks the guards before it dispatches, and a guard's answer ends the call: the tool never
  // runs. This helper is that contract, so a refusal below means no side effect happened.
  const refusalOf = (name, sessionId) => ctx.guards.map(check => check({ name, agent: sessionId === undefined ? undefined : { id: sessionId } })).find(reason => reason !== undefined)
  const callAsDsh = async (name, args, sessionId) => {
    const why = refusalOf(name, sessionId)
    if (why !== undefined) throw new Error(why)
    return tool(name, args, sessionId)
  }
  const ask = (toolName, sessionIdOrAgent, reason = '') => ctx.listeners.get('approval/request')[0](
    { agent: typeof sessionIdOrAgent === 'object' ? sessionIdOrAgent : { session: { id: sessionIdOrAgent } }, toolName, reason },
    () => 'from-dsh',
  )
  const received = id => (agents.get(id)?.calls ?? []).map(message => message.content.map(block => block.text).join('\n'))
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, fb: ctx.flybot, home, warns, tool, refusalOf, callAsDsh, ask, received, saved, stop, agentOf }
}

const runBot = async (fb, tools) => fb.scope('flybot-workflow').bot.create({ name: 'Runner ab', role: 'Run', ephemeral: true, tools })

test('the issue repro is refused: a tools:[] run Bot delivers nothing and asks nothing', async (t) => {
  const { fb, home, callAsDsh, ask, refusalOf, received, saved, stop } = await start()
  t.after(stop)
  const id = await runBot(fb, [])
  assert.deepEqual(saved().bots[id].stepTools, undefined, 'tools: [] is the case read as "nothing granted"')

  const before = readFileSync(join(home, 'state.json'), 'utf8')
  await assert.rejects(() => callAsDsh('message_bot', { to: 'Writer', message: 'hi' }, id), new RegExp(EPHEMERAL_REFUSAL))
  await assert.rejects(() => callAsDsh('message_bot', { to: 'Writer', message: 'hi', reply_to: 'user' }, id), new RegExp(EPHEMERAL_REFUSAL))
  assert.deepEqual(received('b'), [], 'nothing was delivered to Writer')
  assert.equal(await ask('message_bot', id), 'rejected', 'the approval seam agrees with the call guard')
  assert.equal(await ask('message_bot', id, 'why not'), 'rejected')
  // The harness's own question and secret tools are the same answer, so no card or request appears.
  assert.match(await refusalOf('ask_user', id), /not a team member/)
  assert.match(await refusalOf('request_secret', id), /not a team member/)
  const state = saved()
  assert.deepEqual(state.questions, {}, 'no question card was opened')
  assert.equal(state.secretRequests, undefined, 'no secret request was recorded')
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before, 'the whole attempt wrote nothing')
})

test('the constant refuses every name at the guard and the approval seam, with no side effect', async (t) => {
  const { fb, home, callAsDsh, ask, refusalOf, received, saved, stop } = await start()
  t.after(stop)
  const id = await runBot(fb, [])
  assert.equal(EPHEMERAL_DENIED_TOOLS.length, 30)
  assert.equal(new Set(EPHEMERAL_DENIED_TOOLS).size, 30, 'no duplicate name')
  assert.equal(new Set(EPHEMERAL_ALLOWED_TOOLS).size, EPHEMERAL_ALLOWED_TOOLS.length)
  assert.deepEqual(EPHEMERAL_DENIED_TOOLS.filter(name => ALLOWED.has(name)), [], 'a name is in one list only')

  const before = readFileSync(join(home, 'state.json'), 'utf8')
  const args = {
    message_bot: { to: 'Writer', message: 'hi' },
    stop_bot: { bot: 'Writer' },
    create_bot: { name: 'Made ab' },
    update_bot: { bot: 'Writer', role: 'New' },
    archive_bot: { bot: 'Writer' },
    create_group: { name: 'Desk', members: ['Chief'] },
    update_group: { group: 'Desk', notice: 'x' },
    delete_group: { group: 'Desk' },
    post_to_group: { group: 'Desk', message: 'hi' },
    ask_user: { question: 'Go?', options: [{ label: 'Yes' }] },
    request_secret: { name: 'TOKEN', purpose: 'x' },
    message_friend_bot: { to: '@bob.home', message: 'hi' },
    get_friend_file: { id: 'att_x' },
    define_workflow: { name: 'w', nodes: [], edges: [] },
    run_workflow: { workflow: 'w', brief: 'b' },
    schedule_create: { prompt: 'x', title: 't' },
  }
  for (const name of EPHEMERAL_DENIED_TOOLS) {
    await assert.rejects(() => callAsDsh(name, args[name] ?? {}, id), new RegExp(EPHEMERAL_REFUSAL), name)
    assert.equal(await ask(name, id), 'rejected', name)
  }
  assert.deepEqual(received('b'), [], 'no message ran')
  const state = saved()
  assert.deepEqual(state.questions, {}, 'no ask_user card')
  assert.equal(state.secretRequests, undefined, 'no request_secret entry')
  assert.deepEqual(Object.keys(state.rooms), [], 'no group was written')
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), before, 'the block wrote nothing')

  // Ordinary Bots keep the same tools, and a friend's Bot is unchanged too.
  for (const name of ['message_bot', 'create_group', 'request_secret', 'recall']) assert.equal(refusalOf(name, 'a'), undefined, name)
})

test('a subagent child of a run Bot answers rejected; an ordinary Bot\'s child still falls through', async (t) => {
  const { fb, ctx, ask, stop } = await start()
  t.after(stop)
  const id = await runBot(fb, [])
  const child = { id: 'child-run', session: { id: 'child-run', header: { parentSession: id } } }
  assert.equal(await ask('message_bot', child), 'rejected', 'the parent chain reaches the run Bot')
  assert.equal(await ask('create_group', child), 'rejected')
  assert.equal(await ask('read', child), 'allowed-once', 'a tool the run Bot keeps is still fine')
  // An ordinary Bot's child is not adopted: its request still goes to DSH's own answerer.
  const ordinary = { id: 'child-writer', session: { id: 'child-writer', header: { parentSession: 'b' } } }
  const seen = []
  const verdict = ctx.listeners.get('approval/request')[0]({ agent: ordinary, toolName: 'message_bot' }, () => { seen.push('next'); return 'from-dsh' })
  assert.equal(await verdict, 'from-dsh')
  assert.deepEqual(seen, ['next'])
})

test('the constant is a subset of the served names; served minus it is the documented allowlist', async (t) => {
  const { ctx, stop } = await start({ browser: true })
  t.after(stop)
  // The core half is measured, not listed: with the Desktop browser flag the registered tools are
  // exactly TEAM_TOOLS (agents.test.js holds the same equality), so a core tool added with no
  // classification shows up in `SERVED` and fails the equality below.
  assert.deepEqual(sorted(ctx.registeredTools.keys()), sorted(TEAM_TOOLS))
  // The plugin half is read from the source, so a rename there fails here instead of failing open.
  const social = registeredNames('../../plugins/social/src/social.js')
  const workflow = registeredNames('../../plugins/workflow/index.js')
  const tree = registeredNames('../../plugins/tree/src/tools.js')
  assert.deepEqual(sorted(social), ['get_friend_file', 'list_friend_bots', 'message_friend_bot'])
  assert.deepEqual(sorted(workflow), ['define_workflow', 'run_workflow'])
  assert.deepEqual(sorted(tree), ['create_child_bot', 'create_team', 'find_bots', 'list_children', 'move_bot'])
  // The tree's four other tools are behind `visibleTo: inTree` and reach no run Bot; create_child_bot
  // is in the constant anyway so its refusal reads like the rest.
  const SERVED = new Set([...ctx.registeredTools.keys(), ...HARNESS_TOOLS, ...social, ...workflow, 'create_child_bot'])
  assert.deepEqual(EPHEMERAL_DENIED_TOOLS.filter(name => !SERVED.has(name)), [], 'every refused name is served')
  assert.deepEqual(sorted([...SERVED].filter(name => !DENIED.has(name))), sorted(EPHEMERAL_ALLOWED_TOOLS), 'served minus refused is the allowlist')
  for (const gated of tree.filter(name => name !== 'create_child_bot')) assert.equal(DENIED.has(gated) || ALLOWED.has(gated), false, gated)
})

test('the run Bot\'s own tool list loses the refused names while a team Bot keeps message_bot', async (t) => {
  const { ctx, fb, stop } = await start({ browser: true })
  t.after(stop)
  const id = await runBot(fb, [])
  // What the profile serves globally, and what one Agent serves itself, as the real registry answers.
  const served = new Set([...ctx.registeredTools.keys(), ...HARNESS_TOOLS, ...registeredNames('../../plugins/social/src/social.js'), ...registeredNames('../../plugins/workflow/index.js'), 'create_child_bot'])
  const own = []
  const masks = new Map()
  const hiddenOf = sessionId => new Set((masks.get(sessionId) ?? []).flatMap(mask => [...mask]))
  ctx.tools.schemas = (agent) => {
    const base = agent === undefined ? [...served] : [...served, ...own]
    const hidden = agent === undefined ? new Set() : hiddenOf(agent.session?.id ?? agent.id)
    return base.filter(name => !hidden.has(name)).map(name => ({ name }))
  }
  const restrict = sessionId => ({ deny }) => {
    const unknown = deny.filter(name => !served.has(name))
    if (unknown.length > 0) throw new Error(`tools.restrict() names unknown tools ${unknown.join(', ')}`)
    const mask = new Set(deny)
    masks.set(sessionId, [...(masks.get(sessionId) ?? []), mask])
    return () => masks.set(sessionId, (masks.get(sessionId) ?? []).filter(entry => entry !== mask))
  }
  const runAgent = { id, session: { id }, ctx: { tools: { restrict: restrict(id) }, effect: execute => execute() } }
  const teamAgent = { id: 'b', session: { id: 'b' }, ctx: { tools: { restrict: restrict('b') }, effect: execute => execute() } }
  const until = async (ok) => { for (let i = 0; i < 400 && !ok(); i += 1) await delay(5); assert.ok(ok(), 'the mask landed') }
  ctx.emitArgs('agent/created', { agent: runAgent })
  await until(() => ctx.tools.schemas(runAgent).every(schema => !DENIED.has(schema.name)) && ctx.tools.schemas(runAgent).length > 0)
  ctx.emitArgs('agent/created', { agent: teamAgent })
  await delay(30)
  const runNames = new Set(ctx.tools.schemas(runAgent).map(schema => schema.name))
  assert.deepEqual([...runNames].filter(name => DENIED.has(name)), [], 'the run Bot\'s list carries no refused name')
  assert.equal(runNames.has('message_bot'), false)
  assert.deepEqual(sorted([...runNames]), sorted(EPHEMERAL_ALLOWED_TOOLS), 'and keeps exactly the allowlist')
  assert.equal(ctx.tools.schemas(teamAgent).some(schema => schema.name === 'message_bot'), true, 'a team Bot keeps message_bot')
})

test('a refused name the mask cannot enforce stays listed with a warning; the guard still refuses it', async (t) => {
  const { ctx, fb, warns, refusalOf, stop } = await start({ browser: true })
  t.after(stop)
  const id = await runBot(fb, [])
  // `list_secrets` is served to the Agent but not in the profile's global list, the one shape
  // restrict() cannot name (#1271). It stays listed; the warn line says so; the guard is the refusal.
  const served = new Set([...ctx.registeredTools.keys()].filter(name => name !== 'list_secrets'))
  const own = ['list_secrets']
  const masks = new Map()
  const hiddenOf = sessionId => new Set((masks.get(sessionId) ?? []).flatMap(mask => [...mask]))
  ctx.tools.schemas = (agent) => {
    const base = agent === undefined ? [...served] : [...served, ...own]
    const hidden = agent === undefined ? new Set() : hiddenOf(agent.session?.id ?? agent.id)
    return base.filter(name => !hidden.has(name)).map(name => ({ name }))
  }
  const runAgent = {
    id, session: { id },
    ctx: { tools: { restrict: ({ deny }) => { const mask = new Set(deny); masks.set(id, [...(masks.get(id) ?? []), mask]); return () => masks.set(id, (masks.get(id) ?? []).filter(entry => entry !== mask)) } }, effect: execute => execute() },
  }
  ctx.emitArgs('agent/created', { agent: runAgent })
  for (let i = 0; i < 400 && !warns.some(line => line.includes('list_secrets')); i += 1) await delay(5)
  assert.ok(warns.some(line => line.includes('list_secrets') && line.includes('stay listed')), 'the warn line names the name it could not remove')
  assert.equal(ctx.tools.schemas(runAgent).some(schema => schema.name === 'list_secrets'), true, 'it stays in the list')
  assert.match(await refusalOf('list_secrets', id), /not a team member/, 'the guard refuses it anyway')
})

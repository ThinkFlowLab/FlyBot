import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { expandCapabilityNames, validateCapabilityName } from '../src/host/capabilities.js'
import { fakeContext } from './fake-ctx.js'

const makeHome = state => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-capabilities-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', capabilities: [], createdAt: 3 },
  },
  rooms: { room: { id: 'room', members: ['chief'], sessions: { chief: 'room-chief' }, admin: 'chief', mode: 'everyone' } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})
const mcp = (name, command = 'node') => ({ name, kind: 'mcp', description: 'Echo service', transport: 'stdio', command, args: [], env: {} })
const created = env => env.ctx.listeners.get('agent/created').find(listener => listener.name === 'prepareCapabilities')

function testAgent(id, mounts, skillsBySession, { awaitMount = async () => {} } = {}) {
  const disposers = []
  const skills = new Map()
  skillsBySession.set(id, skills)
  const agentCtx = {
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    plugin(plugin, config) {
      const record = { plugin, config, sessionId: id, disposed: false }
      mounts.push(record)
      if (plugin.inject?.includes('skills')) {
        const c = {
          skills: { register(skill) { skills.set(skill.name, skill); return () => skills.delete(skill.name) } },
          effect: execute => { record.cleanup = execute() },
        }
        plugin.apply(c)
      }
      return {
        await: () => awaitMount(record),
        dispose: () => { record.disposed = true; record.cleanup?.() },
      }
    },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
  return { id, session: { id }, ctx: agentCtx }
}

async function setup({ state = team(), secret, beforeLoad } = {}) {
  const home = makeHome(state)
  if (secret) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets: [secret] }))
  const mounts = []
  const skills = new Map()
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  ctx.sessionTitle = { rename: async () => {} }
  rt.resolveAgent = async sessionId => ({ session: { id: sessionId } })
  beforeLoad?.({ ctx, rt, mounts, skills, mcpPlugin })
  await rt.load()
  return {
    home,
    ctx,
    rt,
    mounts,
    skills,
    mcpPlugin,
    async dispose() {
      ctx.dispose()
      await rt.scheduleCapabilitiesReconcile()
      await new Promise(resolve => setImmediate(resolve))
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

const NAME_REFUSAL = 'Use a capability name with lowercase letters, digits, and single hyphens; "github" and "composio" are reserved.'

test('capability names use the MCP and skill validator intersection', () => {
  assert.equal(validateCapabilityName('a'), 'a')
  assert.equal(validateCapabilityName('web-search-1'), 'web-search-1')
  for (const name of ['github', 'composio', 'with_underscore', 'with--dash', '1tool', 'A', 'a'.repeat(33)]) {
    assert.throws(() => validateCapabilityName(name))
    assert.throws(() => validateCapabilityName(name), { message: NAME_REFUSAL })
  }
})

test('packs expand only to MCP and skill items', () => {
  const items = { server: { kind: 'mcp' }, guide: { kind: 'skill' }, team: { kind: 'pack', items: ['server', 'guide'] } }
  assert.deepEqual(expandCapabilityNames(['team', 'server'], items), new Set(['server', 'guide']))
  assert.throws(() => expandCapabilityNames(['missing'], items), /No capability/)
  assert.throws(() => expandCapabilityNames(['bad'], { ...items, bad: { kind: 'pack', items: ['team'] } }), /unavailable capability/)
})

test('state migration adds an empty library and Bot attachment lists', async t => {
  const old = team()
  delete old.capabilities
  for (const bot of Object.values(old.bots)) delete bot.capabilities
  const env = await setup({ state: old })
  t.after(() => env.dispose())
  await env.rt.load()
  assert.deepEqual(env.rt.state.capabilities, { items: {} })
  assert.deepEqual(env.rt.state.bots.chief.capabilities, [])
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(env.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.capabilities, { items: {} })
  assert.deepEqual(saved.bots.chief.capabilities, [])
})

test('Bot saves enforce approval and ownership, and deletion cascades', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  const { state } = rt
  const created = await rt.capabilitySave(mcp('echo'), { botId: 'worker' })
  assert.equal(created.approved, false)
  const description = await rt.capabilitySave({ ...mcp('echo'), description: 'Updated' }, { botId: 'worker' })
  assert.equal(description.approved, false)
  await rt.capabilityEndpoint('capability-approve', { name: 'echo' })
  const approved = await rt.capabilitySave({ ...mcp('echo'), description: 'Another description' }, { botId: 'worker' })
  assert.equal(approved.approved, true)
  const changed = await rt.capabilitySave(mcp('echo', 'node-new'), { botId: 'worker' })
  assert.equal(changed.approved, false)
  await assert.rejects(
    rt.capabilitySave({ name: 'echo', kind: 'skill', description: 'Other kind', content: 'Instructions' }, { botId: 'worker' }),
    error => error.message === 'A capability cannot change its kind. Delete it and save a new one.',
  )
  await assert.rejects(rt.capabilitySave(mcp('echo'), { botId: 'helper' }), /creator or a Main Bot/)
  await assert.rejects(rt.capabilityDelete('echo', { botId: 'helper' }), /creator or a Main Bot/)
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { botId: 'worker' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'worker' })
  state.bots.worker.capabilities = ['echo', 'team']
  await rt.capabilityDelete('echo', { botId: 'worker' })
  assert.equal(state.capabilities.items.echo, undefined)
  assert.deepEqual(state.capabilities.items.team.items, ['guide'])
  assert.deepEqual(state.bots.worker.capabilities, ['team'])
})

test('capability Bot tools refuse DSH Agent sessions', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const list = env.ctx.registeredTools.get('list_capabilities')
  assert.ok(list)
  assert.match(await list.execute({}, { agent: { id: 'outside' } }), /Only Bots on the team/)
})

test('capability tool descriptions and attach results explain approval', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const parameters = env.ctx.registeredTools.get('save_capability').parameters.properties
  assert.deepEqual(
    Object.fromEntries(['transport', 'command', 'args', 'env', 'url', 'headers', 'content'].map(name => [name, parameters[name].description])),
    {
      transport: 'How to reach an MCP server: a local command or an HTTP URL',
      command: 'Program that starts a local MCP server',
      args: 'Arguments for command',
      env: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      url: 'MCP server URL',
      headers: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      content: 'Skill instructions',
    },
  )
  await env.rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  const attached = await env.ctx.registeredTools.get('attach_capability').execute(
    { name: 'blocked' },
    { agent: { id: 'worker' } },
  )
  assert.ok(attached.endsWith(' The user must allow blocked in FlyBot settings before it can work.'))
})

test('read-only secret reload does not requeue capability reconciliation', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  await env.rt.loadSecrets()
  await env.rt.scheduleCapabilitiesReconcile()
  env.rt.readOnly = () => 'The Bot team is open in another dsh.'
  let loads = 0
  const loadSecrets = env.rt.loadSecrets
  env.rt.loadSecrets = async () => {
    loads += 1
    return loadSecrets()
  }
  await env.rt.reconcileCapabilities()
  assert.equal(loads, 1)
})

test('startup and empty-to-nonempty attachments track existing Bot Agents', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  const resolved = []
  const env = await setup({
    state,
    beforeLoad: ({ rt, mounts, skills }) => {
      const existing = Object.fromEntries(['chief', 'room-chief', 'worker', 'helper'].map(id => [id, testAgent(id, mounts, skills)]))
      rt.chatOf = botId => botId
      rt.groupSessionsOf = botId => botId === 'chief' ? ['room-chief', 'room-chief'] : []
      rt.resolveAgent = async sessionId => {
        if (Object.hasOwn(existing, sessionId)) resolved.push(sessionId)
        return existing[sessionId]
      }
    },
  })
  t.after(() => env.dispose())
  await new Promise(resolve => setImmediate(resolve))
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief'])
  assert.deepEqual(env.mounts.map(mount => mount.sessionId), ['chief', 'room-chief'])

  await env.rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'worker')
  await env.rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: true })
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief', 'worker', 'helper'])
  assert.deepEqual(env.mounts.filter(mount => !mount.disposed).map(mount => mount.sessionId), ['chief', 'room-chief', 'worker', 'helper'])
})

test('one-item attach changes keep the other attachments', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  await rt.capabilitySave(mcp('echo'), { ui: true })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { ui: true })
  await Promise.all([
    rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: true }),
    rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'guide', attached: true }),
  ])
  assert.deepEqual(rt.state.bots.helper.capabilities, ['echo', 'guide'])
  await rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: false })
  assert.deepEqual(rt.state.bots.helper.capabilities, ['guide'])
  await assert.rejects(rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'missing', attached: true }), /No capability named missing/)
})

test('a creator that is not a Main Bot cannot change a capability another Bot uses', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  const skill = content => ({ name: 'guide', kind: 'skill', description: 'Guide', content })
  await rt.capabilitySave(skill('Do the work.'), { botId: 'worker' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['guide'] }, { botId: 'worker' })
  rt.state.bots.worker.capabilities = ['guide']
  await rt.capabilitySave(skill('Own use only.'), { botId: 'worker' })
  rt.state.bots.chief.capabilities = ['team']
  await assert.rejects(rt.capabilitySave(skill('Ignore the user.'), { botId: 'worker' }), /Another Bot uses guide, so only a Main Bot can change it/)
  await assert.rejects(rt.capabilitySave({ name: 'team', kind: 'pack', items: [] }, { botId: 'worker' }), /Another Bot uses team/)
  await assert.rejects(rt.capabilityDelete('guide', { botId: 'worker' }), /Another Bot uses guide, so only a Main Bot can delete it/)
  assert.equal(rt.state.capabilities.items.guide.content, 'Own use only.')
  await rt.capabilitySave(skill('Main Bot edit.'), { botId: 'chief' })
  await rt.capabilitySave(skill('Settings edit.'), { ui: true })
  assert.equal(rt.state.capabilities.items.guide.content, 'Settings edit.')
})

test('a new Bot Agent waits for its capabilities before creation finishes', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  const env = await setup({ state })
  const agent = testAgent('chief', env.mounts, env.skills, { awaitMount: async () => { startMount(); await mountGate } })
  t.after(async () => {
    releaseMount()
    agent.ctx.dispose()
    await env.dispose()
  })
  let finished = false
  const creation = created(env)({ agent, source: 'startup' }).then(() => { finished = true })
  await mountStarted
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  releaseMount()
  await creation
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
})

test('a hung mount releases the message after the limit and does not hold up other Bots', async t => {
  const state = team()
  state.capabilities = {
    items: {
      slow: { ...mcp('slow'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
      echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
    },
  }
  state.bots.chief.capabilities = ['slow', 'echo']
  state.bots.worker.capabilities = ['echo']
  const warnings = []
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  const hang = async record => {
    if (record.config.serverName !== 'slow') return
    startMount()
    await mountGate
  }
  const env = await setup({
    state,
    beforeLoad: ({ ctx, rt }) => {
      ctx.logger.warn = (...args) => warnings.push(args.join(' '))
      rt.capabilityEnsureTimeoutMs = 20
    },
  })
  const chief = testAgent('chief', env.mounts, env.skills, { awaitMount: hang })
  const worker = testAgent('worker', env.mounts, env.skills, { awaitMount: hang })
  env.rt.resolveAgent = async sessionId => ({ chief, worker })[sessionId]
  t.after(async () => {
    releaseMount()
    chief.ctx.dispose()
    worker.ctx.dispose()
    await env.dispose()
  })
  const timeouts = name => warnings.filter(line => line.includes(`capability mount for ${name} did not finish within 20ms; continuing`)).length
  await env.rt.ensureCapabilities('chief')
  await mountStarted
  assert.equal(timeouts('chief'), 1)
  assert.equal(env.rt.capabilityStatusesView().chief.slow.state, 'connecting')
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
  await env.rt.ensureCapabilities('chief')
  await env.rt.ensureCapabilities('worker')
  assert.equal(timeouts('chief'), 1)
  assert.equal(timeouts('worker'), 0)
  assert.equal(env.rt.capabilityStatusesView().worker.echo.state, 'ready')
  releaseMount()
  await env.rt.scheduleCapabilitiesReconcile()
  assert.equal(env.rt.capabilityStatusesView().chief.slow.state, 'ready')
})

test('unloading the plugin disposes every capability mount', async t => {
  const state = team()
  state.capabilities = {
    items: {
      echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
      guide: { name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.', createdBy: 'chief', createdAt: 1, updatedAt: 1 },
    },
  }
  state.bots.chief.capabilities = ['echo', 'guide']
  const env = await setup({ state })
  t.after(() => env.dispose())
  const chief = testAgent('chief', env.mounts, env.skills)
  await created(env)({ agent: chief, source: 'startup' })
  assert.equal(env.mounts.length, 2)
  assert.equal(env.skills.get('chief').has('guide'), true)
  env.ctx.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(env.mounts.map(mount => mount.disposed), [true, true])
  assert.equal(env.skills.get('chief').has('guide'), false)
  await env.rt.scheduleCapabilitiesReconcile()
  assert.equal(env.mounts.length, 2)
})

test('unset capability statuses are omitted from the view and tool listing', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt, ctx } = env
  await rt.capabilitySave({ ...mcp('echo'), approved: true }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Instructions' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  rt.state.bots.chief.capabilities = ['echo', 'team']
  await rt.save()
  assert.deepEqual(rt.capabilityStatusesView().chief, {})
  const listed = await ctx.registeredTools.get('list_capabilities').execute({}, { agent: { id: 'chief' } })
  assert.match(listed, /echo \(mcp\).*; attached to you(?:\n|$)/)
  assert.doesNotMatch(listed, /attached to you \(connecting\)/)
})

test('mounts agent-only MCP and skills, remounts changed config, resolves scoped secrets and reports missing secrets', async t => {
  const env = await setup({ secret: { name: 'TOKEN', value: 'fake-secret-value', purpose: '', scope: ['chief'], requestedBy: null, createdAt: 1, updatedAt: 1 } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills, mcpPlugin } = env
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_TOKEN' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Capability marker.' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  await rt.changeCapabilityAttachment('attach', { name: 'team' }, 'chief')
  await rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Worker' }, 'chief')
  await assert.rejects(rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await assert.rejects(rt.changeCapabilityAttachment('detach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'blocked' }, 'worker')
  const chief = testAgent('chief', mounts, skills)
  const room = testAgent('room-chief', mounts, skills)
  const worker = testAgent('worker', mounts, skills)
  const dsh = testAgent('outside', mounts, skills)
  for (const agent of [chief, room, worker, dsh]) ctx.emit('agent/created', { agent })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin).length, 2)
  assert.equal(mounts.find(mount => mount.config?.serverName === 'echo').config.headers.Authorization, 'Bearer fake-secret-value')
  assert.equal(skills.get('chief').has('guide'), true)
  assert.deepEqual(mounts.filter(mount => mount.plugin === mcpPlugin).map(mount => mount.sessionId), ['chief', 'room-chief'])
  assert.equal(JSON.stringify(rt.state.capabilities).includes('fake-secret-value'), false)
  assert.equal(JSON.stringify(rt.capabilityLibraryView()).includes('fake-secret-value'), false)
  assert.equal(rt.capabilityStatusesView().chief.team.state, 'ready')
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'error')
  assert.equal(rt.capabilityStatusesView().worker.blocked.state, 'needs-approval')
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked'), false)
  await rt.capabilityEndpoint('capability-approve', { name: 'blocked' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked' && mount.sessionId === 'worker'), true)
  const first = mounts.find(mount => mount.config?.serverName === 'echo')
  const firstSkill = mounts.find(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills'))
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer changed' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Changed capability marker.' }, { botId: 'chief' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(firstSkill.disposed, true)
  assert.equal(skills.get('chief').get('guide').content, 'Changed capability marker.')
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin && mount.config.serverName === 'echo').length, 5)
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'ready')
  await rt.capabilitySave({ ...mcp('missing-secret'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: '$DSH_SECRET_TOKEN' } }, { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'missing-secret' }, 'worker')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().worker['missing-secret'].state, 'error')
  assert.match(rt.capabilityStatusesView().worker['missing-secret'].error, /TOKEN/)
  await rt.changeCapabilityAttachment('detach', { name: 'team' }, 'chief')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(mounts.findLast(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills')).disposed, true)
  assert.equal(rt.capabilityStatusesView().chief.team, undefined)
})

// Owner decision 2026-10-22 (#601): the owner's keys reach every one of the owner's own Bots, a
// shared one too, so a capability on a Bot shared with a friend gets a key for all Bots. A key the
// owner scoped to chosen Bots still stays out of the Bots it does not name.
test('a key for all Bots reaches a shared Bot\'s capability; a key scoped to other Bots does not', async t => {
  const state = team()
  state.grants = { worker: [{ grantee: '@bob.home', name: 'Bob' }] }
  const env = await setup({ state, secret: { name: 'TOKEN', value: 'fake-secret-value', purpose: '', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 1 } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_TOKEN' } }, { ui: true })
  await rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'chief')
  await rt.changeCapabilityAttachment('attach', { name: 'echo', bot: 'Worker' }, 'chief')
  for (const id of ['chief', 'worker']) ctx.emit('agent/created', { agent: testAgent(id, mounts, skills) })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().chief.echo.state, 'ready')
  assert.equal(rt.capabilityStatusesView().worker.echo.state, 'ready')
  await rt.secretEndpoint('secret-update', { name: 'TOKEN', scope: ['chief'] })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().worker.echo.state, 'error')
  assert.equal(rt.capabilityStatusesView().chief.echo.state, 'ready')
})

// #1979: a capability description comes from a peer server, and its 2000-unit bound must not end
// on the first half of a surrogate pair.
test('a capability description is cut at 2000 without splitting an emoji', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const description = 'a'.repeat(1999) + '😀' + 'tail'
  await env.rt.capabilitySave({ name: 'echo', kind: 'skill', description, content: 'Do the work.' }, { ui: true })
  const kept = env.rt.state.capabilities.items.echo.description
  assert.equal(kept.isWellFormed(), true, 'the stored description is well formed, never a lone high surrogate')
  assert.equal(kept, 'a'.repeat(1999), 'the 2000th unit was the first half of the pair, so the pair is dropped, not split')
  assert.ok(description.startsWith(kept), 'a code-point prefix of the description the peer sent')
  assert.ok(kept.length <= 2000, 'the budget of 2000 UTF-16 units is unchanged')
})

// #3273, from the security read at 6b401ebb: an inline credential in a URL is a shape
// `redactSecrets` cannot know (it replaces saved key values), so the host refuses it on the way in
// and masks userinfo on the way out — the string never reaches a status line, and therefore never
// reaches the system prompt section that prints one.
const USERINFO_REFUSAL = 'Enter the URL without a username or password. Save the credential as a secret and reference it in a header.'

test('a capability URL that carries a username or password is refused, and nothing is stored', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  for (const url of ['https://alice:s3cr3t-pa55@host/mcp', 'https://alice@host/mcp']) {
    await assert.rejects(
      rt.capabilitySave({ ...mcp('inline'), transport: 'streamable-http', url }, { ui: true }),
      error => error.message === USERINFO_REFUSAL,
    )
  }
  assert.equal(rt.state.capabilities.items.inline, undefined, 'a refused save leaves no item')
  assert.equal(JSON.stringify(rt.state).includes('s3cr3t-pa55'), false)
})

test('an error that quotes a URL saved before this fix stores it with the userinfo masked', async t => {
  const state = team()
  state.capabilities = {
    items: {
      inline: {
        name: 'inline', kind: 'mcp', description: 'Saved before the refusal', transport: 'streamable-http',
        url: 'https://alice:s3cr3t-pa55@host/mcp', headers: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'inline' }, 'worker')
  const quoted = 'Request cannot be constructed from a URL that includes credentials: https://alice:s3cr3t-pa55@host/mcp'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new TypeError(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.inline
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Request cannot be constructed from a URL that includes credentials: https://host/mcp', 'the exact stored sentence: the scheme and host stay, the userinfo is gone')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('s3cr3t-pa55'), false)
})

test('a plain HTTPS URL still saves', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const saved = await env.rt.capabilitySave({ ...mcp('plain'), transport: 'streamable-http', url: 'https://host/mcp' }, { ui: true })
  assert.equal(saved.url, 'https://host/mcp')
  assert.equal(env.rt.state.capabilities.items.plain.url, 'https://host/mcp')
})

// #3275: a `streamable-http` transport builds its error from the server's own response body
// (`Error POSTing to endpoint: <body>`), and a server that echoes a request header writes a value
// the user configured into a stored reason that the system prompt prints on every turn.
// `redactSecrets` replaces saved keys only, so a literal header value is masked by the name that
// promises a credential — and only that name, so an ordinary header in the same body survives.
const quoting = (name, headers) => ({
  items: {
    [name]: {
      name, kind: 'mcp', description: 'Echo service', transport: 'streamable-http',
      url: 'https://host/mcp', headers, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
    },
  },
})

test('an error that echoes a configured header value stores it masked', async t => {
  const state = team()
  state.capabilities = quoting('echo', { 'X-Tenant-Key': 'abc123', Accept: 'application/json' })
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'worker')
  const quoted = 'Error POSTing to endpoint: {"error":"unauthorized","echoed":"X-Tenant-Key: abc123","accept":"application/json"}'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.echo
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Error POSTing to endpoint: {"error":"unauthorized","echoed":"X-Tenant-Key: [hidden]","accept":"application/json"}', 'the exact stored sentence: the header name and an ordinary header survive, the credential value is gone')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('abc123'), false)
})

test('an error that echoes a configured environment value stores it masked', async t => {
  const state = team()
  state.capabilities = {
    items: {
      stdio: {
        name: 'stdio', kind: 'mcp', description: 'Local server', transport: 'stdio', command: 'node', args: [],
        env: { SERVICE_TOKEN: 'tok-abcdef', PATH_KEEP: '/usr/bin' }, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'stdio' }, 'worker')
  const quoted = 'server exited with SERVICE_TOKEN=tok-abcdef'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.stdio
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'server exited with SERVICE_TOKEN=[hidden]', 'the exact stored sentence')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('tok-abcdef'), false)
})

// #3275, from the security read at `57bdaa6a`: a cookie is a whole session credential, and the names
// that promise one have to say so — a server that echoes `Cookie: sid=…` otherwise writes the session
// into the prompt every turn.
test('an error that echoes a cookie value stores the whole session credential masked', async t => {
  const state = team()
  state.capabilities = quoting('cookie-echo', { Cookie: 'sid=supersecretsession42', Accept: 'application/json' })
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'cookie-echo' }, 'worker')
  const quoted = 'Error POSTing to endpoint: {"error":"unauthorized","echoed":"Cookie: sid=supersecretsession42","accept":"application/json"}'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker['cookie-echo']
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Error POSTing to endpoint: {"error":"unauthorized","echoed":"Cookie: [hidden]","accept":"application/json"}', 'the whole cookie value is gone and the ordinary header survives')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('supersecretsession42'), false)
})

// #3275, same read: `X-Github-Pat` is a credential while `X-Patch-Id` and `X-Path-Id` are ordinary
// names that merely begin with those three letters — so `pat` counts as a whole segment, never as a
// prefix.
test('a PAT header name is masked while "patch" and "path" names are not', async t => {
  const state = team()
  state.capabilities = quoting('pat-echo', {
    'X-Github-Pat': 'ghp-abcdef123456', 'X-Patch-Id': 'patch-9000', 'X-Path-Id': 'path-9000', Accept: 'application/json',
  })
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'pat-echo' }, 'worker')
  const quoted = 'Error POSTing to endpoint: {"pat":"X-Github-Pat: ghp-abcdef123456","patch":"X-Patch-Id: patch-9000","path":"X-Path-Id: path-9000","accept":"application/json"}'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker['pat-echo']
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Error POSTing to endpoint: {"pat":"X-Github-Pat: [hidden]","patch":"X-Patch-Id: patch-9000","path":"X-Path-Id: path-9000","accept":"application/json"}', 'only the PAT value is masked; the two lookalike names keep their values')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('ghp-abcdef123456'), false)
})

// #3275, same read: one value can contain another (`Bearer abc123XYZ` carries the `abc123` of the key
// beside it), so the values are replaced longest first — the way `secrets.js` sorts its own — and the
// answer does not depend on the order the two entries were written in.
for (const [label, headers] of [
  ['the key first', { 'X-Api-Key': 'abc123', Authorization: 'Bearer abc123XYZ' }],
  ['the authorization first', { Authorization: 'Bearer abc123XYZ', 'X-Api-Key': 'abc123' }],
]) {
  test(`an error that echoes two credential values masks the longer one whole, ${label}`, async t => {
    const state = team()
    state.capabilities = quoting('pair-echo', headers)
    const env = await setup({ state })
    t.after(() => env.dispose())
    const { ctx, rt, mounts, skills } = env
    await rt.changeCapabilityAttachment('attach', { name: 'pair-echo' }, 'worker')
    const quoted = 'Error POSTing to endpoint: {"auth":"Bearer abc123XYZ"}'
    ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
    await rt.scheduleCapabilitiesReconcile()
    const status = rt.capabilityStatusesView().worker['pair-echo']
    assert.equal(status.state, 'error')
    assert.equal(status.error, 'Error POSTing to endpoint: {"auth":"[hidden]"}', 'the longer value is replaced whole, so no tail of it survives')
    assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('XYZ'), false)
  })
}

test('a plain reason is stored exactly as the transport gave it', async t => {
  const state = team()
  state.capabilities = quoting('plain-error', {})
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'plain-error' }, 'worker')
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error('401 bad credentials') } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker['plain-error']
  assert.equal(status.state, 'error')
  assert.equal(status.error, '401 bad credentials')
})

// #3278: a stdio server is started with the literal on its argv, and a failure to start quotes that
// argv back, so the mask reads the command and the args the way it reads a header: the token after a
// credential-looking flag is the literal, `--flag=value` is the same pair, and a `NAME=value` token is
// read as an assignment. An ordinary flag in the same argv keeps its value.
test('an error that quotes a stdio server argv stores the credential literal masked', async t => {
  const state = team()
  state.capabilities = {
    items: {
      stdio: {
        name: 'stdio', kind: 'mcp', description: 'Local server', transport: 'stdio', command: 'node',
        args: ['server.js', '--api-key', 'sk-live-abcdef123456', '-e', 'SERVICE_TOKEN=tok-abcdef123', '--password=hunter2-secret', '--verbose'],
        env: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'stdio' }, 'worker')
  const quoted = 'server exited: node server.js --api-key sk-live-abcdef123456 -e SERVICE_TOKEN=tok-abcdef123 --password=hunter2-secret --verbose'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.stdio
  assert.equal(status.state, 'error')
  assert.equal(
    status.error,
    'server exited: node server.js --api-key [hidden] -e SERVICE_TOKEN=[hidden] --password=[hidden] --verbose',
    'every argv literal is masked; the program and the ordinary flag survive',
  )
  const stored = JSON.stringify(rt.capabilityStatusesView())
  assert.equal(stored.includes('sk-live-abcdef123456'), false)
  assert.equal(stored.includes('tok-abcdef123'), false)
  assert.equal(stored.includes('hunter2-secret'), false)
})

// #3278, from the security read at `48f1eb43`: `sig`, `hmac` and `pass` were still missing from the
// name list, so a body echoing `X-Sig: …`, `X-Hmac: …` or `X-Pass: …` stored the value verbatim.
// `sig` and `pass` count as a whole segment the way `pat` does, so `assign`, `compass` and `bypass` are
// ordinary names that keep their values.
test('a sig, hmac or pass header name masks its value while assign, compass and bypass keep theirs', async t => {
  const state = team()
  state.capabilities = quoting('name-echo', {
    'X-Sig': 'sig-abcdef123', 'X-Hmac': 'hmac-abcdef123', 'X-Pass': 'pass-abcdef123',
    'X-Assign': 'assign-9000', 'X-Compass': 'compass-9000', 'X-Bypass': 'bypass-9000',
  })
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'name-echo' }, 'worker')
  const quoted = 'Error POSTing to endpoint: {"sig":"sig-abcdef123","hmac":"hmac-abcdef123","pass":"pass-abcdef123","assign":"assign-9000","compass":"compass-9000","bypass":"bypass-9000"}'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker['name-echo']
  assert.equal(status.state, 'error')
  assert.equal(
    status.error,
    'Error POSTing to endpoint: {"sig":"[hidden]","hmac":"[hidden]","pass":"[hidden]","assign":"assign-9000","compass":"compass-9000","bypass":"bypass-9000"}',
    'the three new names mask; the three lookalike names keep their values',
  )
  const stored = JSON.stringify(rt.capabilityStatusesView())
  assert.equal(stored.includes('sig-abcdef123'), false)
  assert.equal(stored.includes('hmac-abcdef123'), false)
  assert.equal(stored.includes('pass-abcdef123'), false)
})

// #3278: the two things #3275 fixed stay fixed — a value under six characters is left alone rather
// than eating the words around it, and the mask still runs before the 300-character cut, so a literal
// inside the kept part is gone and only the tail past the cut is dropped.
// #3281 test-quality item: the under-six value is pinned behind a credential-looking flag and is
// exactly five characters, so deleting `value.length >= 6` in `capabilities.js` turns this test red
// instead of passing because the flag name itself never matched a credential.
test('an argv literal under six characters stays and an argv literal is masked before the three-hundred cut', async t => {
  const state = team()
  state.capabilities = {
    items: {
      long: {
        name: 'long', kind: 'mcp', description: 'Local server', transport: 'stdio', command: 'node',
        args: ['server.js', '--api-key', 'abcde', '--api-key', 'sk-live-abcdef123456'],
        env: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'long' }, 'worker')
  const quoted = `server exited: --api-key abcde ${'x'.repeat(170)} --api-key sk-live-abcdef123456 ${'z'.repeat(200)}`
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.long
  assert.equal(status.state, 'error')
  assert.equal(status.error.length, 300, 'the stored reason is still cut at 300 characters')
  assert.equal(status.error.startsWith('server exited: --api-key abcde '), true, 'a five-character value behind a credential flag is left alone')
  assert.equal(status.error.includes('--api-key [hidden]'), true, 'the mask ran before the cut')
  assert.equal(status.error.includes('sk-live-abcdef123456'), false)
})

// #3278 acceptance 2: the entry that fails here may have been saved before this fix, so the tests
// start from a store written by the old version and make one new start failure. The literal must be
// gone from every surface a reader can see — the status answer, the `list_capabilities` text, the
// system-prompt line and the log — and the first three must repeat the same masked sentence, which
// is what proves they read one stored reason built at one place (`capabilities.js:370`) instead of
// masking it four times. The saved config keeps the literal: the Settings editor reads it back by
// design, and #3276 owns that question.
const surfacesFor = async (env, name, warnings) => {
  const status = env.rt.capabilityStatusesView().worker[name] ?? {}
  return {
    status: JSON.stringify(status),
    listed: await env.ctx.registeredTools.get('list_capabilities').execute({}, { agent: { id: 'worker' } }),
    prompt: env.ctx.sections.get('bot-capabilities').text({ agent: { id: 'worker' } }),
    warnings: warnings.join('\n'),
  }
}

test('a stdio capability saved before this fix shows no argv or env literal on any surface', async t => {
  const state = team()
  state.capabilities = {
    items: {
      legacy: {
        name: 'legacy', kind: 'mcp', description: 'Saved before this fix', transport: 'stdio',
        command: 'node', args: ['server.js', '--api-key', 'sk-live-abcdef123456'],
        env: { SERVICE_TOKEN: 'tok-abcdef123' }, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  state.bots.worker.capabilities = ['legacy']
  const warnings = []
  const env = await setup({ state, beforeLoad: ({ ctx }) => { ctx.logger.warn = (...args) => warnings.push(args.join(' ')) } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  const quoted = 'server exited: node server.js --api-key sk-live-abcdef123456 -e SERVICE_TOKEN=tok-abcdef123'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const masked = 'server exited: node server.js --api-key [hidden] -e SERVICE_TOKEN=[hidden]'
  const surfaces = await surfacesFor(env, 'legacy', warnings)
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const literal of ['sk-live-abcdef123456', 'tok-abcdef123']) {
      assert.equal(text.includes(literal), false, `${surface} carries no literal`)
    }
  }
  const status = rt.capabilityStatusesView().worker.legacy
  assert.equal(status.state, 'error')
  assert.equal(status.error, masked, 'one masked sentence, built once')
  assert.equal(surfaces.listed.includes(masked), true, 'the tool listing repeats the stored reason')
  assert.equal(surfaces.prompt.includes(masked), true, 'the prompt line repeats the stored reason')
  // The reason is not part of the team state, so nothing rewrites it at rest and no migration exists.
  await rt.save()
  const saved = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal(JSON.stringify(saved).includes('[hidden]'), false, 'the masked reason is memory-only')
  assert.deepEqual(saved.capabilities.items.legacy.args, ['server.js', '--api-key', 'sk-live-abcdef123456'], 'the config itself is unchanged')
  // Detaching the item empties every line, which is the proof that the store is their only source.
  await rt.changeCapabilityAttachment('detach', { name: 'legacy', bot: 'Worker' }, 'chief')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes(masked), false)
  assert.equal(ctx.sections.get('bot-capabilities').text({ agent: { id: 'worker' } }), '')
})

test('an http capability saved before this fix shows no header literal on any surface', async t => {
  const state = team()
  state.capabilities = {
    items: {
      legacy: {
        name: 'legacy', kind: 'mcp', description: 'Saved before this fix', transport: 'streamable-http',
        url: 'https://host/mcp', headers: { 'X-Sig': 'sig-abcdef123', Accept: 'application/json' },
        approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  state.bots.worker.capabilities = ['legacy']
  const warnings = []
  const env = await setup({ state, beforeLoad: ({ ctx }) => { ctx.logger.warn = (...args) => warnings.push(args.join(' ')) } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  const quoted = 'Error POSTing to endpoint: {"sig":"sig-abcdef123","accept":"application/json"}'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const masked = 'Error POSTing to endpoint: {"sig":"[hidden]","accept":"application/json"}'
  const surfaces = await surfacesFor(env, 'legacy', warnings)
  for (const [surface, text] of Object.entries(surfaces)) {
    assert.equal(text.includes('sig-abcdef123'), false, `${surface} carries no literal`)
  }
  const status = rt.capabilityStatusesView().worker.legacy
  assert.equal(status.state, 'error')
  assert.equal(status.error, masked, 'one masked sentence, built once; an ordinary header survives')
  assert.equal(surfaces.listed.includes(masked), true)
  assert.equal(surfaces.prompt.includes(masked), true)
})

// #3281: a stdio entry can be saved from a pasted line, so `command` itself may hold a whole command
// line (`node server.js --api-key …`). When it contains whitespace it is split into tokens and read
// with the same rules as `args`, so the literal after a credential-looking flag is masked in the
// stored reason. A command that is a single bare token stays unmasked: it cannot be told from a
// program name, the same documented limit as a bare `args` token.
test('an error that quotes a stdio command line stored in `command` masks the credential literal', async t => {
  const state = team()
  state.capabilities = {
    items: {
      inline: {
        name: 'inline', kind: 'mcp', description: 'Local server', transport: 'stdio',
        command: 'node server.js --api-key sk-live-abcdef123456 --password=hunter2-secret -e SERVICE_TOKEN=tok-abcdef123',
        args: [], env: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'inline' }, 'worker')
  const quoted = 'spawn node server.js --api-key sk-live-abcdef123456 --password=hunter2-secret -e SERVICE_TOKEN=tok-abcdef123 ENOENT'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.inline
  assert.equal(status.state, 'error')
  assert.equal(
    status.error,
    'spawn node server.js --api-key [hidden] --password=[hidden] -e SERVICE_TOKEN=[hidden] ENOENT',
    'the inline command line is read with the same flag, inline and assignment rules as args',
  )
  const stored = JSON.stringify(rt.capabilityStatusesView())
  assert.equal(stored.includes('sk-live-abcdef123456'), false)
  assert.equal(stored.includes('hunter2-secret'), false)
  assert.equal(stored.includes('tok-abcdef123'), false)
})

// #3281: a generated credential can begin with `-`, and the token after a credential-looking flag is
// that flag's value even then. The accepted cost is that `--api-key --verbose` stores `--api-key
// [hidden]`; it is recorded in `docs/subsystems/core-host.md`, the fragment and the pull request body.
test('a dash-prefixed credential value after a credential flag is masked', async t => {
  const state = team()
  state.capabilities = {
    items: {
      dash: {
        name: 'dash', kind: 'mcp', description: 'Local server', transport: 'stdio', command: 'node',
        args: ['server.js', '--api-key', '-s3cr3t-abcdef', '--verbose'],
        env: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'dash' }, 'worker')
  const quoted = 'spawn node ENOENT: node server.js --api-key -s3cr3t-abcdef --verbose'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.dash
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'spawn node ENOENT: node server.js --api-key [hidden] --verbose', 'a value beginning with - is still the flag value')
  assert.equal(JSON.stringify(rt.capabilityStatusesView()).includes('s3cr3t-abcdef'), false)
})

// #3281 accepted cost: a following flag is taken as the value and masked, so `--api-key --verbose`
// reads `--api-key [hidden]`. The test pins the cost exactly; the doc, the fragment and the pull
// request body say the same sentence.
test('a flag directly after a credential flag is masked as its value', async t => {
  const state = team()
  state.capabilities = {
    items: {
      bare: {
        name: 'bare', kind: 'mcp', description: 'Local server', transport: 'stdio', command: 'node',
        args: ['server.js', '--api-key', '--verbose'],
        env: {}, approved: true, createdBy: 'worker', createdAt: 1, updatedAt: 1,
      },
    },
  }
  const env = await setup({ state })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.changeCapabilityAttachment('attach', { name: 'bare' }, 'worker')
  const quoted = 'server exited: node server.js --api-key --verbose'
  ctx.emit('agent/created', { agent: testAgent('worker', mounts, skills, { awaitMount: async () => { throw new Error(quoted) } }) })
  await rt.scheduleCapabilitiesReconcile()
  const status = rt.capabilityStatusesView().worker.bare
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'server exited: node server.js --api-key [hidden]', 'the accepted cost: a following flag is masked')
})

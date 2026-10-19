// @flybot/tree against the real ctx.flybot host (ds-bot's hooks.js), not the mock (ThinkFlowLab/FlyBot#6).
// Boots ds-bot by its public entry (`ds-bot`, resolved by test/resolve.mjs) in a plugin-local fake
// Cordis context, loads tree with ctx.plugin and reaches the host only through ctx.flybot (#34).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from 'ds-bot'
import * as tree from '../index.js'
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

async function waitFor(check, ms = 2000) {
  for (const end = Date.now() + ms; !check(); await new Promise(r => setTimeout(r, 10))) {
    if (Date.now() > end) throw new Error('timed out')
  }
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tree-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeCordis()
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      agents.set(id, {
        session: { id, requestHeader: () => undefined }, id, calls: [], status: 'idle',
        followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(id)
  }
  let n = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: `s${++n}` }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { if (options.path.endsWith('bot')) route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, fb: ctx.flybot, tool, call, stop }
}

test('tree plugin on the real host: Chief adopted as root, create_child_bot, scoped fields, send policy, dispose', async () => {
  const h = await start()
  try {
    const fork = h.ctx.plugin(tree, {}) // autoRoot: Chief is adopted on the next tick
    await waitFor(() => h.fb.scope('flybot-tree').fields.get('b', 'parent') === 'a')
    assert.equal(h.fb.scope('flybot-tree').fields.get('a', 'treeRole'), 'root') // Chief is the root
    assert.equal(h.fb.scope('flybot-tree').fields.get('b', 'parent'), 'a') // Writer adopted under Chief
    assert.equal(h.fb.fields.get('b', 'parent'), undefined) // never under fields.shared
    const created = JSON.parse(await h.tool('create_child_bot', { name: 'Work', role_description: 'work stuff' }, 'a')).created
    assert.equal(typeof created.id, 'string'); assert.equal(created.depth, 2)
    const work = created.id
    const dev = JSON.parse(await h.tool('create_child_bot', { name: 'Dev', role_description: 'code' }, h.fb.bot.get(work).sessionId ?? work)).created?.id
    assert.ok(dev, 'child created under the calling bot')
    assert.equal(h.fb.scope('flybot-tree').fields.get(dev, 'parent'), work)
    assert.match(h.fb.bot.get('a').systemPrompt, /Work/)
    assert.match(JSON.parse(await h.tool('create_child_bot', { name: 'x'.repeat(41), role_description: 'r' }, 'a')).error, /at most 40/)
    const send = (from, to, role) => h.fb.bot.send({ from, to, text: 'hi', ...(role ? { role } : {}) })
    assert.equal((await send('a', dev)).action, 'deny') // grandchild
    assert.equal((await send('b', work)).action, 'deny') // sibling
    assert.notEqual((await send('a', work)).action, 'deny')
    assert.equal(h.fb.bot.send.list().find(m => m.name === 'tree')?.priority, h.fb.bot.send.priority.ROUTING) // ROUTING band, before social's APPROVAL
    fork.dispose()
    assert.equal(h.fb.bot.send.list().some(m => m.name === 'tree'), false)
  } finally {
    await h.stop()
  }
})

test('#16 Option B on the real host: a non-Main tree Bot creates a child that stays ungranted', async () => {
  const h = await start()
  try {
    const fork = h.ctx.plugin(tree, {})
    await waitFor(() => h.fb.scope('flybot-tree').fields.get('b', 'parent') === 'a')
    assert.equal(h.fb.bot.get('a').isMain, true)
    assert.equal(h.fb.bot.get('b').isMain, false)
    await h.fb.grants.set('b', [{ grantee: '@bob.home' }])
    const created = JSON.parse(await h.tool('create_child_bot', { name: 'Work', role_description: 'work' }, 'b')).created
    assert.ok(created.id)
    assert.equal(h.fb.scope('flybot-tree').fields.get(created.id, 'parent'), 'b')
    assert.equal(h.fb.bot.get(created.id).isMain, false)
    assert.equal(h.fb.bot.get(created.id).granted, false)
    assert.equal(h.fb.bot.hasAnyGrant(created.id), false)
    assert.deepEqual(h.fb.grants.of(created.id), [])
    fork.dispose()
  } finally {
    await h.stop()
  }
})

test('#90 on the real host: a friend reaches a granted tree Bot directly, never an ungranted one, and nothing goes through the root', async () => {
  const h = await start()
  try {
    const fork = h.ctx.plugin(tree, {})
    await waitFor(() => h.fb.scope('flybot-tree').fields.get('b', 'parent') === 'a')
    const friend = { kind: 'remote', handle: '@coder.bob.home', home: '@bob.home', name: 'Coder' }
    const send = to => h.fb.bot.send({ from: friend, to, text: 'hello from a friend' })
    const grant = id => h.fb.grants.set(id, [{ grantee: '@bob.home' }])
    assert.equal(h.fb.bot.get('a').granted, false, 'the Chief has no grant until someone is invited')
    assert.equal(h.fb.bot.get('b').granted, false, 'an adopted tree Bot is not')
    assert.equal((await send('a')).action, 'deny')
    await grant('a')
    assert.equal((await send('a')).action, 'allow')
    const denied = await send('b')
    assert.equal(denied.action, 'deny')
    assert.equal(denied.by, 'owner-policy')
    await grant('b')
    assert.equal(h.fb.bot.get('b').granted, true)
    const direct = await send('b')
    assert.equal(direct.action, 'allow', 'reached directly, not redirected to its parent')
    // A deep child created under the granted Bot stays ungranted.
    const work = JSON.parse(await h.tool('create_child_bot', { name: 'Work', role_description: 'work' }, 'b')).created.id
    assert.equal((await send(work)).action, 'deny')
    await h.fb.grants.set('b', [])
    assert.equal((await send('b')).action, 'deny')
    fork.dispose()
  } finally {
    await h.stop()
  }
})

test('#446 on the real host: core create_bot cannot get past maxChildren; a full level is regrouped by role, logged and undoable through the UI endpoints', async () => {
  const h = await start()
  try {
    const fork = h.ctx.plugin(tree, { maxChildren: 2 })
    const tf = h.fb.scope('flybot-tree').fields
    await waitFor(() => tf.get('b', 'parent') === 'a') // Writer joins Chief
    const travel = JSON.parse(await h.tool('create_child_bot', { name: 'Travel', role_description: 'trips' }, 'a')).created.id
    assert.match(JSON.parse(await h.tool('create_child_bot', { name: 'Editor', role_description: 'edit' }, 'a')).error, /limit reached: Chief already has 2 children \(maxChildren=2\)/)
    const answer = await h.tool('create_bot', { name: 'Editor', role: 'Edit', instructions: 'Edit texts' }, 'a')
    assert.match(String(answer), /Created Editor/)
    const editor = h.fb.bot.list().find(b => b.name === 'Editor')
    assert.ok(editor, 'create_bot made the Bot')
    // Writer and Editor share a role (writing): a new Writing Lead takes both; Travel stays. Never over the cap.
    await waitFor(() => tf.get(editor.id, 'parent') !== undefined)
    const lead = h.fb.bot.list().find(b => b.name === 'Writing Lead')
    assert.ok(lead, 'a lead with a clear role was created')
    assert.equal(tf.get(editor.id, 'parent'), lead.id)
    assert.equal(tf.get('b', 'parent'), lead.id)
    assert.equal(tf.get(travel, 'parent'), 'a')
    assert.equal(h.fb.bot.list().filter(b => tf.get(b.id, 'parent') === 'a').length, 2, 'Chief stays within maxChildren')
    assert.match(h.fb.bot.get(lead.id).systemPrompt, /COORDINATOR[\s\S]*- Writer[\s\S]*- Editor/)
    assert.match(h.fb.bot.get('a').systemPrompt, /Do not use create_bot to get around them/)
    assert.match(h.fb.bot.get('a').systemPrompt, /Last automatic tree reorganization .*created Writing Lead under Chief/)
    // The tree view reads the journal and undoes it through the UI endpoints.
    const overview = await h.call('flybot/tree/reorg', {})
    const [run] = overview.value?.runs ?? []
    assert.ok(run, JSON.stringify(overview).slice(0, 300))
    assert.deepEqual(run.summary.slice(0, 2), ['created Writing Lead under Chief to lead the Writing group', 'moved Writer from Chief to Writing Lead'])
    const undone = await h.call('flybot/tree/undo', { runId: run.id })
    const result = undone.value ?? {}
    // Chief is full again with Writer back: the new Editor stays under its lead, which therefore stays.
    assert.ok(Array.isArray(result.kept), JSON.stringify(undone).slice(0, 300))
    assert.ok(h.fb.bot.list().some(b => b.id === editor.id) && h.fb.bot.list().some(b => b.id === lead.id), 'nothing deleted')
    fork.dispose()
  } finally {
    await h.stop()
  }
})

test('#447 on the real host: find_bots, create_team (lead plus children) and create_child_bot(parent) register and work', async () => {
  const h = await start()
  try {
    const fork = h.ctx.plugin(tree, {})
    const tf = h.fb.scope('flybot-tree').fields
    await waitFor(() => tf.get('b', 'parent') === 'a')
    const team = JSON.parse(await h.tool('create_team', { team: 'FlyBot', members: ['Dev: writes the FlyBot code', 'Test: runs the FlyBot tests'] }, 'a'))
    assert.equal(team.error, undefined, JSON.stringify(team))
    const lead = team.team.lead.id
    assert.equal(tf.get(lead, 'parent'), 'a')
    assert.deepEqual(h.fb.bot.list().filter(b => tf.get(b.id, 'parent') === lead).map(b => b.name).sort(), ['Dev', 'Test'])
    const docs = JSON.parse(await h.tool('create_child_bot', { name: 'Docs', role_description: 'writes docs', parent: 'FlyBot Lead' }, 'a')).created
    assert.equal(tf.get(docs.id, 'parent'), lead)
    assert.match(JSON.parse(await h.tool('create_child_bot', { name: 'X', role_description: 'x', parent: lead }, 'b')).error, /parent must be you or one of your descendants/)
    const found = JSON.parse(await h.tool('find_bots', { query: 'test' }, 'a'))
    assert.deepEqual(found.bots.map(b => [b.name, b.depth, b.parent]).slice(0, 1), [['Test', 3, 'FlyBot Lead']])
    const reused = JSON.parse(await h.tool('create_child_bot', { name: 'Test', role_description: 'runs the FlyBot tests' }, 'a'))
    assert.equal(reused.reused?.path, 'Chief → FlyBot Lead → Test')
    fork.dispose()
  } finally {
    await h.stop()
  }
})

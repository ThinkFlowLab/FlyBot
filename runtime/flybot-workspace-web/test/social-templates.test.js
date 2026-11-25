// Stream C: team templates (#290), bulk invites / role copy (#281), unread divider (#358).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import teamTemplates, { TEMPLATES } from '../features/team-templates/index.js'
import invites from '../features/invites/index.js'
import members from '../features/members/index.js'
import messenger from '../features/messenger/index.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { bootMemory, key, WS } from './helpers.js'

const SERVER = 'https://social.example.test'
function setup(calls) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c6-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path, body })
    if (init.method === 'GET' && path === '/v1/ot/conversations') {
      return new Response(JSON.stringify({ unread: 1, conversations: [{ id: 'otc_1', unread: 1, read_seq: 3, last_seq: 5 }] }))
    }
    if (path.includes('/messages')) return new Response(JSON.stringify({ read_seq: 3, last_seq: 5, messages: [] }))
    if (path.includes('/invites') && init.method === 'POST') return new Response(JSON.stringify({ code: 'x'.repeat(32), invite: { role: body.role } }))
    return new Response('{}')
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  return {
    dataDir: dir,
    featureDir: () => dir,
  }
}

test('list exposes categorized public templates and the Discover create-team entry (#313)', async () => {
  const { templates, create_entry } = await teamTemplates(setup([])).endpoints.list()
  assert.deepEqual(templates.slice(0, 3).map(t => t.slug), ['product-squad', 'content-studio', 'research-desk'])
  assert.deepEqual(templates.map((t) => t.slug), TEMPLATES.map((t) => t.slug))
  assert.ok(templates.some(t => t.category === 'education'))
  for (const template of templates) {
    assert.ok(template.category)
    assert.equal(template.agents.length, 3)
    assert.ok(template.agents.every(agent => !Object.hasOwn(agent, 'instructions')))
  }
  assert.equal(create_entry, '/agents?tab=teams&new=1')
})

const TEAM_WORKSPACE = 'b'.repeat(32)

async function templateFixture(t) {
  const bot = await bootMemory()
  const { data, root } = bot.vol
  const credentialsPath = join(data, 'bot', 'flybot-social.json')
  mkdirSync(join(data, 'bot'))
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const bots = { main: { id: 'main', model: 'fixture-model', name: 'Main', capabilities: [] } }
  const rooms = {}
  const social = { role: 'admin', failures: 0, roomFailures: 0 }
  let nextBot = 0
  let nextRoom = 0
  attachRuntime({ ctx: {}, mainBot: async () => 'main', rt: {
    state: { bots, rooms }, botOf: id => bots[id], roomOf: id => rooms[id],
    createBot: async fields => {
      await social.beforeCreateBot?.(fields.name)
      const id = 'bot-' + ++nextBot
      return (bots[id] = { ...fields, id })
    },
    updateBot: async (id, patch) => Object.assign(bots[id], patch),
    setFlags: async (id, patch) => Object.assign(bots[id], patch),
    createSession: async () => {
      if (social.roomFailures > 0) { social.roomFailures--; throw new Error('fixture native room unavailable') }
      return 'room-' + ++nextRoom
    },
    mobileEndpoint() {},
    sendUser: () => assert.fail('creating a template group must not send a message'),
    updateRoom() {},
    deleteRoom() {},
    save: async () => {},
  } })
  t.after(() => { detachRuntime(); setSharedBotSocial(null); rmSync(root, { recursive: true, force: true }) })
  const creates = []
  const groups = new Map()
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/v1/ot/teams/by-workspace/' + TEAM_WORKSPACE) {
      return Response.json({ id: 'ott_fixture', role: social.role })
    }
    if (path === '/v1/ot/teams/ott_fixture/members') {
      return Response.json({ members: [{ platform_user_id: 'usr_fixture', handle: 'fixture-member' }] })
    }
    if (/^\/v1\/ot\/conversations\/otc_\d+\/announcement$/.test(path)) {
      return Response.json({ announcement: { body: '' } })
    }
    if (init.method === 'GET' && path === '/v1/ot/me') {
      return Response.json({ owner_id: 'fixture-owner', handle: 'fixture-member', display_name: 'Fixture Member' })
    }
    if (init.method === 'GET' && path.endsWith('/messages')) return Response.json({ messages: [] })
    const group = groups.get(path)
    if (init.method === 'GET' && group) return Response.json(group)
    assert.equal(path, '/v1/ot/conversations')
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    creates.push(body)
    if (social.failures > 0) { social.failures--; throw new Error('fixture transport loss') }
    const created = {
      id: 'otc_' + creates.length, kind: 'group', title: body.title, team_id: body.team_id, account_group: body.account_group,
      agents: body.agents.map(agent => ({ ...agent, mine: true })),
    }
    groups.set(path + '/' + created.id, created)
    return Response.json(created)
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath, fetch }))
  const apply = (slug, { workspace = WS, requestKey = key(), body = {} } = {}) =>
    bot.call('team-templates', 'POST', `/v1/workspaces/${workspace}/team-templates/${slug}`, body, requestKey)
  const createAgent = async (name, workspace = WS) => {
    const response = await bot.call('agents', 'POST', `/v1/workspaces/${workspace}/agents`, { name, instructions: 'Existing custom instructions' }, key())
    assert.equal(response.status, 201)
    return response.body.agent
  }
  return { bot, bots, rooms, creates, social, apply, createAgent }
}

test('the authenticated native route applies each Chinese template with the exact account-group roster', async t => {
  const { bot, bots, rooms, creates, apply, createAgent } = await templateFixture(t)
  const raw = await bot.endpoint('team-templates/apply', { slug: 'product-squad', workspace_id: WS })
  assert.equal(raw.ok, false)
  assert.equal(raw.error.code, 'not_found')
  assert.equal((await bot.endpoint('agents/templateRoles', { workspace_id: WS, names: ['产品经理助理'] })).ok, false)
  assert.equal((await bot.endpoint('agents/createTemplateRoles', { workspace_id: WS, roles: [] })).ok, false)
  for (let i = 0; i < 26; i++) await createAgent('Existing agent ' + i)
  const reused = await createAgent('产品经理助理')
  bots[reused.native_bot_id].instructions = 'Locally edited instructions'
  for (const template of TEMPLATES) {
    const requestKey = key()
    const before = creates.length
    const { status, body } = await apply(template.slug, { requestKey })
    assert.equal(status, 201)
    assert.equal(body.conversation.workspace_id, WS)
    assert.equal(new Set(body.created_agents).size, 3)
    assert.deepEqual(rooms[body.conversation.native_room_id].members.map(id => bots[id].flybotWorkspace.agent_id), body.created_agents)
    assert.deepEqual(creates.at(-1), {
      kind: 'group', title: template.name, account_group: true, members: [],
      agents: template.agents.map((agent, i) => ({ agent_ref: body.created_agents[i], name: agent.name })),
      idempotency_key: creates.at(-1).idempotency_key,
    })
    assert.match(creates.at(-1).idempotency_key, /^[0-9a-f]{64}$/)
    assert.deepEqual(await apply(template.slug, { requestKey }), { status: 200, body })
    assert.equal(creates.length, before + 1)
    if (template.slug === 'product-squad') assert.equal(body.created_agents[0], reused.id)
  }
  assert.equal(bots[reused.native_bot_id].instructions, 'Locally edited instructions')
})

test('cold template prepares independent native roles together and waits for recovery before another request', {timeout: 5000}, async t => {
  const { bots, creates, social, apply } = await templateFixture(t)
  const slug = 'product-squad'
  const names = TEMPLATES[0].agents.map(role => role.name)
  const requestKey = key()
  const started = []
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  social.beforeCreateBot = async name => {
    started.push(name)
    if (started.length === names.length) entered.resolve()
    if (started.length === 1) throw new Error('fixture native session temporarily unavailable')
    await finish.promise
  }
  const original = apply(slug, {requestKey})
  await entered.promise
  assert.deepEqual(started, names)
  assert.equal(creates.length, 0)
  const repair = apply(slug, {requestKey})
  const replay = apply(slug, {requestKey})
  const anotherGroup = apply(slug)
  finish.resolve()
  const [failed, repaired, repeated, another] = await Promise.all([original, repair, replay, anotherGroup])
  assert.equal(failed.status, 500)
  assert.equal(repaired.status, 201)
  assert.deepEqual(repeated, {status: 200, body: repaired.body})
  assert.equal(another.status, 201)
  assert.notEqual(another.body.conversation.id, repaired.body.conversation.id)
  assert.deepEqual(another.body.created_agents, repaired.body.created_agents)
  assert.deepEqual(creates.map(group => group.agents.map(role => role.name)), [names, names])
  assert.deepEqual(started, [...names, names[0]])
  assert.equal(Object.keys(bots).length, 4)
})

test('insufficient quota creates no partial template roster or role reservations', async t => {
  const { bots, creates, social, apply, createAgent } = await templateFixture(t)
  for (let i = 0; i < 198; i++) await createAgent('Existing agent ' + i)
  const names = TEMPLATES[0].agents.map(role => role.name)
  social.beforeCreateBot = name => assert.ok(!names.includes(name))
  const result = await apply('product-squad')
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, 'team_template_agent_quota')
  assert.equal(creates.length, 0)
  await createAgent('Remaining slot 1')
  await createAgent('Remaining slot 2')
  assert.equal(Object.keys(bots).length, 201)
})

test('partial retry reuses native template agents, handles archives and allows a new renamed role', async t => {
  const { bot, bots, creates, social, apply } = await templateFixture(t)
  const requestKey = key()
  const slug = 'product-squad'
  social.failures = 1
  const failed = await apply(slug, { requestKey })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error.code, 'service_unavailable')
  assert.equal(Object.keys(bots).length, 4)
  const finished = await apply(slug, { requestKey })
  assert.equal(finished.status, 201)
  assert.equal(Object.keys(bots).length, 4)
  assert.deepEqual(creates[0], creates[1])
  const agentPath = `/v1/workspaces/${WS}/agents/${finished.body.created_agents[0]}`
  const prior = (await bot.call('agents', 'GET', agentPath)).body.agent
  const archived = await bot.call('agents', 'POST', agentPath + '/archive', { archived: true, revision: prior.revision })
  assert.equal(archived.status, 200)
  const blocked = await apply(slug)
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.error.code, 'team_template_role_conflict')
  assert.equal(creates.length, 2)
  assert.equal(bots[prior.native_bot_id].hidden, true)
  assert.deepEqual(await apply(slug, { requestKey }), { status: 200, body: finished.body })
  const restored = await bot.call('agents', 'POST', agentPath + '/archive', { archived: false, revision: archived.body.agent.revision })
  assert.equal(restored.status, 200)
  const renamed = await bot.call('agents', 'POST', agentPath, { name: 'My product helper', revision: restored.body.agent.revision })
  assert.equal(renamed.status, 200)
  const fresh = await apply(slug)
  assert.equal(fresh.status, 201)
  assert.notEqual(fresh.body.created_agents[0], prior.id)
  assert.deepEqual(fresh.body.created_agents.slice(1), finished.body.created_agents.slice(1))
  delete bots[(await bot.call('agents', 'GET', `/v1/workspaces/${WS}/agents/${fresh.body.created_agents[0]}`)).body.agent.native_bot_id]
  const removed = await apply(slug)
  assert.equal(removed.status, 409)
  assert.equal(removed.body.error.code, 'team_template_role_conflict')
  assert.equal(creates.length, 3)
})

test('a committed template group survives a native room outage and reopens without duplicating its roster', async t => {
  const { bot, bots, creates, rooms, social, apply } = await templateFixture(t)
  const requestKey = key()
  social.roomFailures = 1
  const first = await apply('product-squad', { requestKey })
  assert.equal(first.status, 201)
  const {conversation, created_agents} = first.body
  assert.equal(conversation.id, 'otc_1')
  assert.equal(conversation.native_room_id, undefined)
  assert.equal(created_agents.length, 3)
  assert.deepEqual(conversation.agents.map(agent => agent.agent_ref), created_agents)
  assert.equal(Object.keys(rooms).length, 0)
  assert.deepEqual(await apply('product-squad', { requestKey }), {status: 200, body: first.body})
  assert.equal(creates.length, 1)
  assert.equal(Object.keys(bots).length, 4)

  const reopened = await bot.call('messenger', 'GET', `/v1/workspaces/${WS}/social/conversations/${conversation.id}`)
  assert.equal(reopened.status, 200)
  assert.equal(reopened.body.conversation.id, conversation.id)
  assert.deepEqual(reopened.body.conversation.agent_members.map(agent => agent.id), created_agents)
  const room = rooms[reopened.body.conversation.native_room_id]
  assert.equal(room.flybotWorkspace.conversation_id, conversation.id)
  assert.deepEqual(room.members.map(id => bots[id].flybotWorkspace.agent_id), created_agents)
  assert.equal(creates.length, 1)
})

test('only active team managers can create a template group with authorized team participants', async t => {
  const { bots, creates, social, apply } = await templateFixture(t)
  const args = { workspace: TEAM_WORKSPACE, body: { title: 'Team group', member_ids: ['usr_fixture'] } }
  social.role = 'member'
  const denied = await apply('content-studio', args)
  assert.equal(denied.status, 403)
  assert.equal(Object.keys(bots).length, 1)
  social.role = 'admin'
  const started = await apply('content-studio', args)
  assert.equal(started.status, 201)
  assert.equal(started.body.conversation.workspace_id, TEAM_WORKSPACE)
  assert.equal(creates.length, 1)
  assert.equal(creates[0].team_id, 'ott_fixture')
  assert.equal(creates[0].account_group, false)
  assert.deepEqual(creates[0].members, ['fixture-member'])
  assert.deepEqual(creates[0].agents.map(a => a.agent_ref), started.body.created_agents)
})

test('bulk invites, role copy, muted unread already excluded, and first_unread_seq (#281 #345 #358)', async () => {
  const calls = []
  const host = setup(calls)
  const many = await invites(host).endpoints.createMany({ team_id: 'ott_1', rows: [{ role: 'member' }, { role: 'admin' }] })
  assert.equal(many.invites.length, 2)
  assert.equal(calls.filter((c) => c.path === '/v1/ot/teams/ott_1/invites').length, 2)
  const roles = await members(host).endpoints.roles()
  assert.deepEqual(roles.roles.map((r) => r.role), ['owner', 'admin', 'member'])
  const list = await messenger(host).endpoints.list()
  assert.equal(list.conversations[0].first_unread_seq, 4)
  const page = await messenger(host).endpoints.messages({ conversation_id: 'otc_1' })
  assert.equal(page.first_unread_seq, 4)
})

// Stream C plugin features talk to Bot Social with this DS-Bot's own connector token.
// Fake Bot Social (fetch stub) and fixture credentials only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsFeature } from '../features/settings/settings.js'
import { createBotSocial, setSharedBotSocial, seg } from '../lib/c/bot-social.js'
import social from '../features/social/index.js'
import teams from '../features/teams/index.js'
import members from '../features/members/index.js'
import invites from '../features/invites/index.js'
import studio from '../features/studio/index.js'

const TOKEN = 'ot-fake-connector-token-for-tests'
const SERVER = 'https://social.example.test'

function creds(server = SERVER) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c-'))
  mkdirSync(join(dir, 'bot'))
  const path = join(dir, 'bot', 'flybot-social.json')
  writeFileSync(path, JSON.stringify({ token: TOKEN, server, home: { id: 'bot_1', handle: 'ann.home' } }), { mode: 0o600 })
  return path
}

function fakeFetch(answer = () => ({ ok: true })) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answer(url, init)
    const [status, body] = Array.isArray(a) ? a : [200, a]
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

test('personal workspace can include its native catalog and never reads a linked team catalog', async t => {
  const workspace = 'a'.repeat(32)
  const owner = 'c'.repeat(32)
  const previousOwner = process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
  process.env.FLYBOT_WORKSPACE_OWNER_USER_ID = owner
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
    else process.env.FLYBOT_WORKSPACE_OWNER_USER_ID = previousOwner
  })
  const catalog = { items: [{ id: 'd'.repeat(32) }], cursor: null, activity_version: 'version' }
  const reads = []
  let available = true
  const endpoint = teams({ call: async (endpoint, payload) => {
    if (endpoint === 'agents/personal-binding') return { workspace_id: workspace, agent_id: 'b'.repeat(32) }
    assert.equal(endpoint, 'artifacts/v1')
    reads.push(payload)
    if (!available) throw new Error('unavailable')
    return { status: 200, body: catalog }
  } }).endpoints.v1
  const get = (query, call) => endpoint({ method: 'GET', path: '/v1/workspaces?scope=personal' + query }, call)
  const normal = await get('')
  assert.equal(normal.status, 200)
  assert.equal(normal.body.items[0].owner_id, owner)
  assert.equal(normal.body.catalog, undefined)
  assert.deepEqual((await get('&include=artifacts&workspace=' + 'e'.repeat(32))).body, normal.body)
  assert.equal(reads.length, 0)
  for (const query of ['&include=artifacts', '&include=artifacts&workspace=' + workspace]) {
    const result = await get(query)
    assert.deepEqual(result.body, { ...normal.body, catalog })
  }
  assert.deepEqual(reads, Array(2).fill({ method: 'GET', path: '/v1/workspaces/' + workspace + '/artifacts' }))
  assert.deepEqual((await get('&include=artifacts&order=recent')).body.catalog, catalog)
  assert.equal(reads.at(-1).path, '/v1/workspaces/' + workspace + '/artifacts?order=recent')
  available = false
  assert.deepEqual((await get('&include=artifacts')).body, normal.body)
  available = true
  delete process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
  assert.equal((await get('&include=artifacts')).body.catalog, undefined)
  const request = { headers: new Headers({ 'x-ot-owner-username': 'personal-test' }) }
  const gateway = await get('&include=artifacts', { request })
  assert.equal(gateway.body.viewer_username, 'personal-test')
  assert.equal(gateway.body.items[0].owner_id, null)
  assert.deepEqual(gateway.body.catalog, catalog)
})

test('the automation snapshot reads the personal list for the authenticated gateway viewer', async () => {
  const workspace = 'a'.repeat(32)
  const calls = []
  let available = true
  const items = [{id: 'd'.repeat(32), workspace_id: workspace, title: '晨报'}]
  const endpoint = teams({ call: async (name, payload) => {
    if (name === 'agents/personal-binding') return {workspace_id: workspace, agent_id: 'b'.repeat(32)}
    assert.equal(name, 'automations/list')
    calls.push(payload)
    if (!available) throw new Error('unavailable')
    return {items}
  } }).endpoints.v1
  const request = {headers: new Headers({'x-ot-owner-username': 'account-test'})}
  const get = (suffix = '', call = {request}) => endpoint({method: 'GET',
    path: '/v1/workspaces?scope=personal&include=automations' + suffix}, call)
  for (const suffix of ['', '&workspace=' + workspace, '&username=other-owner']) {
    const result = await get(suffix)
    assert.equal(result.status, 200)
    assert.equal(result.body.viewer_username, 'account-test')
    assert.equal(result.body.items[0].id, workspace)
    assert.deepEqual(result.body.automations, {items})
  }
  assert.deepEqual(calls, Array(3).fill({workspace_id: workspace, category: 'mine', username: 'account-test'}))
  for (const suffix of ['&workspace=' + 'c'.repeat(32), '&workspace=' + workspace + '&workspace=' + workspace,
    '&include=automations']) {
    assert.equal((await get(suffix)).body.automations, undefined)
  }
  assert.equal((await get('', {})).body.automations, undefined)
  assert.equal(calls.length, 3)
  available = false
  const fallback = await get()
  assert.equal(fallback.status, 200)
  assert.equal(fallback.body.items[0].id, workspace)
  assert.equal(fallback.body.automations, undefined)
})

test('the personal agent snapshot serves the latest native look for the bound workspace', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-native-look-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const saved = {color: '葡萄紫', expression: '好奇', headwear: '贝雷帽', glasses: '圆框眼镜', hand: '魔法棒'}
  const settings = createSettingsFeature({dir}).endpoints
  const lookReads = []
  const endpoint = teams({call: async (name, payload) => {
    if (name === 'agents/personal-binding') return {workspace_id: workspace, agent_id: agent}
    assert.equal(name, 'settings/look')
    lookReads.push(payload)
    return settings.look()
  }}).endpoints.v1
  const request = {headers: new Headers({'x-ot-owner-username': 'account-test'})}
  const get = (suffix = '') => endpoint({method: 'GET',
    path: '/v1/workspaces?scope=personal&include=personal-agent' + suffix}, {request})

  const before = await get()
  assert.equal(before.status, 200)
  assert.equal(before.body.items[0].id, workspace)
  assert.equal(before.body.viewer_username, 'account-test')
  assert.equal(before.body.personal_agent_id, agent)
  assert.equal(before.body.personal_look, null)

  await settings.onboardingLook({look: saved})
  const updated = await get('&workspace=' + workspace)
  assert.equal(updated.body.personal_agent_id, agent)
  assert.deepEqual(updated.body.personal_look, saved)
  for (const suffix of ['&workspace=' + 'c'.repeat(32), '&workspace=' + workspace + '&workspace=' + workspace,
    '&include=personal-agent']) {
    const scoped = await get(suffix)
    assert.equal(scoped.body.personal_agent_id, undefined)
    assert.equal(scoped.body.personal_look, undefined)
  }
  assert.deepEqual(lookReads, [{}, {}])
})

test('the Chat snapshot reads only the local owner’s workspace and directory', async t => {
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const owner = 'c'.repeat(32)
  const previousOwner = process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
  process.env.FLYBOT_WORKSPACE_OWNER_USER_ID = owner
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
    else process.env.FLYBOT_WORKSPACE_OWNER_USER_ID = previousOwner
  })
  const directory = { items: [{id: agent}], conversations: [{id: 'd'.repeat(32), agent_id: agent}], cursor: null }
  const entry = {agent: {id: agent, workspace_id: workspace},
    conversation: {id: 'd'.repeat(32), agent_id: agent, workspace_id: workspace}, items: [], cursor: null, has_newer: false}
  const reads = []
  const entries = []
  let available = true
  let hasEntry = true
  const endpoint = teams({ call: async (endpoint, payload) => {
    if (endpoint === 'agents/personal-binding') return { workspace_id: workspace, agent_id: agent }
    if (endpoint === 'agents/startupEntry') {
      entries.push(payload)
      return hasEntry ? entry : null
    }
    assert.equal(endpoint, 'agents/v1')
    reads.push(payload)
    if (!available) throw new Error('unavailable')
    return {status: 200, body: directory}
  } }).endpoints.v1
  const get = (where = '', call) => endpoint({method: 'GET', path: '/v1/workspaces?scope=personal&include=chat' + where}, call)
  const result = await get('&workspace=' + workspace)
  assert.equal(result.status, 200)
  assert.equal(result.body.items[0].owner_id, owner)
  assert.equal(result.body.personal_agent_id, agent)
  assert.deepEqual(result.body.chat, directory)
  assert.deepEqual(reads, [{method: 'GET', path: `/v1/workspaces/${workspace}/agents?limit=100&include=conversations`}])
  const other = await get('&workspace=' + 'e'.repeat(32))
  assert.equal(other.body.personal_agent_id, agent)
  assert.equal(other.body.chat, undefined)
  assert.equal(reads.length, 1)
  const hint = '&entry_agent=' + agent
  const exact = hint + '&entry_conversation=' + entry.conversation.id + '&directory=0'
  assert.deepEqual((await get('&workspace=' + workspace + exact)).body, {
    items: result.body.items, cursor: null, personal_agent_id: agent, entry,
  })
  assert.deepEqual(entries, [{workspace_id: workspace, agent_id: agent, conversation_id: entry.conversation.id}])
  assert.equal(reads.length, 1, 'an exact transcript does not need the directory')
  assert.equal((await get('&workspace=' + 'e'.repeat(32) + exact)).body.entry, undefined)
  assert.equal((await get(exact)).body.entry, undefined)
  assert.equal((await get('&workspace=' + workspace + exact + hint)).body.entry, undefined)
  assert.equal(entries.length, 1, 'unscoped and ambiguous hints cannot read a transcript')
  hasEntry = false
  assert.equal((await get('&workspace=' + workspace + exact)).body.chat, undefined)
  const newAgent = await get('&workspace=' + workspace + hint + '&directory=0')
  assert.equal(newAgent.body.entry, null)
  assert.deepEqual(newAgent.body.chat, directory, 'an agent without a snapshot can still open an empty draft')
  const bindingOnly = await get('&workspace=' + workspace + '&directory=0')
  assert.equal(bindingOnly.body.personal_agent_id, agent)
  assert.equal(bindingOnly.body.chat, undefined)
  available = false
  assert.equal((await get()).body.personal_agent_id, agent)
  assert.equal((await get()).body.chat, undefined)
  available = true
  delete process.env.FLYBOT_WORKSPACE_OWNER_USER_ID
  assert.equal((await get()).body.personal_agent_id, undefined)
  assert.equal((await get()).body.chat, undefined)
  assert.equal((await get('&workspace=' + workspace + exact)).body.entry, undefined)
  const request = {headers: new Headers({'x-ot-owner-username': 'personal-test'})}
  const fromGateway = await get('', {request})
  assert.equal(fromGateway.body.viewer_username, 'personal-test')
  assert.deepEqual(fromGateway.body.chat, directory)
})

test('requests carry the saved connector token to exactly the configured server', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home', display_name: 'Ann' }))
  const bs = createBotSocial({ server: SERVER + '/', credentialsPath: creds(), fetch: f.fetch })
  const status = await bs.status()
  assert.equal(status.connected, true)
  assert.equal(status.handle, 'ann.home')
  assert.equal(f.calls[0].url, `${SERVER}/v1/ot/me`)
  assert.equal(f.calls[0].auth, `Bearer ${TOKEN}`)
  assert.ok(!JSON.stringify(status).includes(TOKEN), 'token never returned')
})

test('the same-site Bot Social sends authenticated requests over its private socket', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-soc-'))
  const socket = join(dir, 'social.sock')
  const requests = []
  const listener = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(req.url === '/v1/ot/redirect' ? 307 : 200, { 'content-type': 'application/json', location: 'https://other.test' })
    res.end(JSON.stringify({ ok: true }))
  })
  listener.listen(socket)
  await once(listener, 'listening')
  t.after(() => {
    listener.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const f = fakeFetch()
  const bs = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await bs.post('/v1/ot/teams', { name: '团队文档' }), { ok: true })
  assert.deepEqual([requests[0].method, requests[0].path, requests[0].headers.host, requests[0].headers.authorization],
    ['POST', '/v1/ot/teams', new URL(SERVER).host, `Bearer ${TOKEN}`])
  assert.deepEqual(JSON.parse(requests[0].body), { name: '团队文档' })
  const documentPath = '/v1/ot/teams/' + 'a'.repeat(32) + '/studio/documents/' + 'b'.repeat(32)
  assert.deepEqual(await bs.request('DELETE', documentPath, { revision: 2 }), { ok: true })
  assert.deepEqual([requests[1].method, requests[1].path], ['DELETE', documentPath])
  assert.deepEqual(JSON.parse(requests[1].body), { revision: 2 })
  await assert.rejects(bs.get('/v1/ot/redirect'), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 0)

  const remote = 'https://other.test'
  const other = createBotSocial({
    server: remote, credentialsPath: creds(remote), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await other.get('/v1/ot/teams'), { ok: true })
  assert.equal(f.calls[0].url, remote + '/v1/ot/teams')
  assert.equal(requests.length, 3)
  const unavailable = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: join(dir, 'missing.sock'), localServer: SERVER,
  })
  await assert.rejects(unavailable.post('/v1/ot/teams', { name: 'Studio' }), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 1)
})

test('no server, missing credentials or credentials for another server fail closed', async () => {
  const f = fakeFetch()
  const none = await createBotSocial({ server: async () => undefined, credentialsPath: creds(), fetch: f.fetch }).status()
  assert.deepEqual([none.connected, none.reason], [false, 'social/not-configured'])
  const other = await createBotSocial({ server: SERVER, credentialsPath: creds('https://other.test'), fetch: f.fetch }).status()
  assert.equal(other.reason, 'social/not-connected')
  const missing = await createBotSocial({ server: SERVER, credentialsPath: '/nonexistent/x.json', fetch: f.fetch }).status()
  assert.equal(missing.reason, 'social/not-connected')
  assert.equal(f.calls.length, 0, 'nothing is sent without a matching identity')
})

test('Bot Social errors map to typed codes without leaking the token', async () => {
  const f = fakeFetch(() => [404, { error: { code: 'team_not_found', message: 'no such team' } }])
  const bs = createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch })
  await assert.rejects(bs.get('/v1/ot/teams/x'), (e) => e.code === 'social/team_not_found' && !e.message.includes(TOKEN))
})

test('browser-supplied ids cannot reshape the Bot Social path', () => {
  assert.equal(seg('ott_01ABC'), 'ott_01ABC')
  for (const bad of ['../x', 'a/b', '', 'x?y', 'a b']) assert.throws(() => seg(bad), /invalid/)
})

test('teams, members, invites and social features map to the shared routes', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home' }))
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch }))
  const host = { dataDir: '/nonexistent' }
  const T = teams(host).endpoints, M = members(host).endpoints, I = invites(host).endpoints, S = social(host).endpoints
  await T.create({ name: 'Studio', slug: 'studio-a', summary: 's', extra: 'dropped' })
  await T.directory({ q: 'guild' })
  await T.setListing({ team_id: 'ott_1', listed: true })
  await M.setRole({ team_id: 'ott_1', handle: 'bea.home', role: 'admin' })
  await M.leave({ team_id: 'ott_1' })
  await I.create({ team_id: 'ott_1', requires_approval: true })
  await I.accept({ code: 'c'.repeat(32) })
  await I.decide({ team_id: 'ott_1', request_id: 'otjr_1', decision: 'approve' })
  await S.notifications({ after: 3 })
  const seen = f.calls.map((c) => `${c.method} ${c.url.slice(SERVER.length)}`)
  assert.deepEqual(seen, [
    'POST /v1/ot/teams',
    'GET /v1/ot/directory?q=guild',
    'PUT /v1/ot/teams/ott_1/listing',
    'PATCH /v1/ot/teams/ott_1/members/bea.home',
    'GET /v1/ot/me',
    'DELETE /v1/ot/teams/ott_1/members/ann.home',
    'POST /v1/ot/teams/ott_1/invites',
    'POST /v1/ot/invites/accept',
    'POST /v1/ot/teams/ott_1/join-requests/otjr_1',
    'GET /v1/ot/notifications?after=3',
  ])
  assert.deepEqual(f.calls[0].body, { name: 'Studio', slug: 'studio-a', summary: 's' })
  assert.equal(f.calls[6].body.requires_approval, true)
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`))
})

test('applicant join requests expose team names and only canonical workspace IDs', async () => {
  const workspace = 'a'.repeat(32)
  const common = {role:'member',member:{owner_id:'applicant',handle:'ann.home'},created_at:1795212000000}
  const f = fakeFetch(() => ({requests:[
    {...common,id:'otjr_valid',team_id:'ott_a',workspace_id:workspace,team_name:'Studio',status:'approved',decided_at:1795212001000},
    {...common,id:'otjr_unbound',team_id:'ott_b',workspace_id:null,team_name:'Old studio',status:'pending'},
  ]}))
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath: creds(), fetch: f.fetch}))
  const endpoint = invites({dataDir:'/nonexistent'}).endpoints.v1
  const result = await endpoint({method:'GET',path:'/v1/join-requests'})
  assert.equal(result.status,200)
  const [approved, pending] = result.body.items
  assert.deepEqual({id:approved.id,workspace_id:approved.workspace_id,team_name:approved.team_name,role:approved.role,
    status:approved.status,created:approved.created,decided:approved.decided},
  {id:'otjr_valid',workspace_id:workspace,team_name:'Studio',role:'member',status:'approved',created:1795212000,decided:1795212001})
  assert.equal(pending.workspace_id,null)
  assert.equal(pending.team_name,'Old studio')
  assert.deepEqual(f.calls.map(call => call.url), [SERVER + '/v1/ot/join-requests/mine'])
})

test('a legacy shared projection cannot make the bound personal workspace convertible', async () => {
  const personal = 'a'.repeat(32)
  const shared = 'b'.repeat(32)
  const row = (workspace_id, name) => ({workspace_id, name, role: 'owner'})
  const f = fakeFetch((url, init) => {
    const pathname = new URL(url).pathname
    if (pathname === '/v1/ot/me') return {handle: 'ann.home', owner_id: 'ann'}
    if (pathname === '/v1/ot/workspaces') return {workspaces: [
      row(personal, 'Existing personal name'), row(shared, 'Studio'),
      {...row('d'.repeat(32), 'Other workspace'), role: 'admin'},
      {...row('e'.repeat(32), 'Already a team'), slug: 'existing-team'},
    ]}
    assert.equal(pathname, '/v1/ot/workspaces/' + shared + '/convert')
    assert.equal(init.method, 'POST')
    return {...row(shared, 'Studio'), slug: 'studio-team'}
  })
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath: creds(), fetch: f.fetch}))
  const endpoint = teams({call: async () => ({workspace_id: personal, agent_id: 'c'.repeat(32)})}).endpoints.v1
  const listed = await endpoint({method: 'GET', path: '/v1/workspaces'})
  assert.deepEqual(listed.body.items.slice(0, 2).map(item => [item.id, item.kind, item.name]), [
    [personal, 'workspace', 'Existing personal name'], [shared, 'workspace', 'Studio'],
  ])
  const convertible = await endpoint({method: 'GET', path: '/v1/workspaces?scope=convertible'})
  assert.deepEqual(convertible.body.items.map(item => item.id), [shared])
  const convert = workspace_id => endpoint({
    method: 'POST', path: '/v1/teams', idempotency_key: 'native-convert-team',
    body: {mode: 'convert', name: 'Studio', slug: 'studio-team', workspace_id},
  })
  const before = f.calls.length
  const blocked = await convert(personal)
  assert.equal(blocked.status, 409)
  assert.equal(f.calls.length, before)
  const converted = await convert(shared)
  assert.equal(converted.status, 200)
  assert.equal(converted.body.workspace.id, shared)
})

test('the native inbox requests recent scoped notices and constructs safe meeting and Discover links', async t => {
  const personal = 'a'.repeat(32)
  const team = 'b'.repeat(32)
  const share = 'c'.repeat(32)
  const item = (kind,data,seq) => ({kind,data,seq,id:`notice-${seq}`,created_at:4000,read:false})
  const f = fakeFetch((url,init) => {
    const scope = new URL(url).searchParams
    if (init.method === 'POST') return {unread:1}
    const scoped = scope.get('workspace_id')
    if (scoped && scoped !== team) return [404,{error:{code:'not_found',message:'workspace not found'}}]
    return {unread:4,notifications:[
      item('meeting.shared',{share_id:share,title:'纪要',organizer:'Alice',...(scoped ? {workspace_id:scoped}:{}),path:'//outside.test'},7),
      item('meeting.shared',{share_id:share,workspace_id:'d'.repeat(32)},6),
      item('discover.published',{slug:'design-log',kind:'work',title:'设计',creator:{display_name:'Bob'},path:'//outside.test'},5),
      item('discover.published',{slug:'helper-1',listing_kind:'agent',creator:{handle:'bob.home'}},4),
      item('discover.published',{slug:'../x',kind:'work',path:'//outside.test'},3),
    ]}
  })
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call(name) {
    if (name === 'automations/notifications' || name === 'settings/notificationPrefs') {
      throw Object.assign(new Error('Unknown FlyBot endpoint'), {code:'flybot-workspace/not-found'})
    }
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }}).endpoints.v1
  const local = await endpoint({method:'GET',path:`/v1/workspaces/${personal}/notifications?filter=unread`})
  assert.equal(f.calls.at(-1).url,SERVER+'/v1/ot/notifications?limit=200&latest=1&personal=1&unread=1')
  assert.equal(local.status,200)
  assert.equal(local.body.unread_count,4)
  assert.deepEqual(local.body.items.map(row=>row.seq),[7,5,4,3])
  assert.equal(local.body.items[0].path,`/meetings#workspace=${personal}&shared=${share}`)
  assert.equal(local.body.items[0].workspace_id,personal)
  assert.equal(local.body.items[1].kind,'discover.published')
  assert.equal(local.body.items[1].listing_kind,'work')
  assert.equal(local.body.items[1].path,'/w/design-log')
  assert.equal(local.body.items[2].path,'/a/helper-1')
  assert.equal(local.body.items[3].path,undefined)
  const scoped = await endpoint({method:'GET',path:`/v1/workspaces/${team}/notifications`})
  assert.equal(f.calls.at(-1).url,SERVER+`/v1/ot/notifications?limit=200&latest=1&workspace_id=${team}`)
  assert.equal(scoped.body.items[0].path,`/meetings#workspace=${team}&shared=${share}`)
  const read = await endpoint({method:'POST',path:`/v1/workspaces/${team}/notifications/read`,body:{notification_id:'notice-7'}})
  assert.deepEqual(read,{status:200,body:{unread_count:1}})
  assert.deepEqual(f.calls.at(-1).body,{notification_id:'notice-7',workspace_id:team})
  assert.equal((await endpoint({method:'GET',path:`/v1/workspaces/${'e'.repeat(32)}/notifications`})).status,404)
  assert.equal(f.calls.length,4)
})

test('Space work notices map account messages to the recipient workspace and scope their read updates', async t => {
  const workspace = 'a'.repeat(32)
  const conversation = 'otc_' + 'B'.repeat(26)
  const message = 'otm_' + 'C'.repeat(26)
  const notice = {id:'fixture-notice',seq:8,kind:'artifact.shared',created_at:9500,read:false,
    data:{conversation_id:conversation,message_id:message,title:'排期表',actor_username:'Alice'}}
  const f = fakeFetch((url, init) => init.method === 'GET' ? {unread:3,notifications:[
    notice, {...notice,id:'malformed',data:{...notice.data,conversation_id:'../profile'}},
  ]} : {unread:0})
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call() { return {workspace_id:workspace} }}).endpoints.v1
  const base = `/v1/workspaces/${workspace}/notifications`
  const list = await endpoint({method:'GET',path:base+'?kind=work&limit=1'})
  assert.deepEqual(list, {status:200,body:{limit:1,unread_count:3,items:[{
    id:'fixture-notice',seq:8,kind:'artifact.shared',created:9,read:false,
    conversation_id:conversation,message_id:message,workspace_id:workspace,title:'排期表',actor_username:'Alice',
    path:`/chat#workspace=${workspace}&social=${conversation}&message=${message}`,
  }]}})
  assert.equal(f.calls[0].url,SERVER+'/v1/ot/notifications?limit=1&latest=1&personal=1&kind=work')
  const read = await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'work'}})
  assert.deepEqual(read,{status:200,body:{unread_count:0}})
  assert.deepEqual(f.calls[1].body,{all:true,personal:true,kind:'work'})
  assert.equal((await endpoint({method:'GET',path:base+'?kind=work&kind=work'})).status,400)
  assert.equal((await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'unknown'}})).status,400)
  assert.equal(f.calls.length,2)
})

test('Studio live requests forward only the authenticated watch and presence contracts', async () => {
  const wid = 'a'.repeat(32), id = 'b'.repeat(32)
  const path = '/v1/workspaces/' + wid + '/studio/documents/' + id + '/live'
  const upstream = SERVER + '/v1/ot/teams/' + wid + '/studio/documents/' + id + '/live'
  const editors = [{name: 'Member', editing: true}]
  const stub = fakeFetch((url, {method}) => method === 'GET'
    ? {unchanged:true, revision:2, editors} : {ok:true})
  setSharedBotSocial(createBotSocial({server:SERVER, credentialsPath:creds(), fetch:stub.fetch}))
  const {v1} = studio({}).endpoints
  const update = {session_id:'studio-fixture-session', active:true, editing:true}
  assert.deepEqual(await v1({method:'GET',path:path+'?revision=2'}),
    {status:200,body:{unchanged:true,revision:2,editors}})
  assert.deepEqual(await v1({method:'POST',path,body:update}), {status:200,body:{ok:true}})
  assert.deepEqual(stub.calls, [
    {url:upstream+'?revision=2', method:'GET', auth:'Bearer '+TOKEN, body:undefined},
    {url:upstream, method:'POST', auth:'Bearer '+TOKEN, body:update},
  ])
  for (const query of ['', '?revision=2&revision=3', '?revision=9999999999999999']) {
    assert.equal((await v1({method:'GET',path:path+query})).status,400)
  }
  for (const body of [undefined, {...update, body:'local draft'}, {...update, active:false}]) {
    assert.equal((await v1({method:'POST',path,body})).status,400)
  }
  const signed = new AbortController()
  signed.abort()
  let sawAbort
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:async (url, {signal})=>{
    sawAbort = url === upstream+'?revision=2' && signal.aborted
    signal.throwIfAborted()
  }}))
  assert.equal((await v1({method:'GET',path:path+'?revision=2'},{request:{signal:signed.signal}})).status,503)
  assert.equal(sawAbort,true)
})

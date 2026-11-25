// Stream C page-shim /v1 handlers return the Flask JSON shapes the existing pages expect.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import members from '../features/members/index.js'
import invites from '../features/invites/index.js'
import teams from '../features/teams/index.js'
import messenger from '../features/messenger/index.js'
import discover from '../features/discover/index.js'

const TOKEN = 'ot-fake-connector-token-for-tests'
const SERVER = 'https://social.example.test'
const WS = 'a'.repeat(32)
process.env.FLYBOT_WORKSPACE_SOCIAL_AGENTS = '0'
process.env.FLYBOT_WORKSPACE_OWNER_USER_ID = 'b'.repeat(32)

function creds() {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c7-'))
  mkdirSync(join(dir, 'bot'))
  const path = join(dir, 'bot', 'flybot-social.json')
  writeFileSync(path, JSON.stringify({ token: TOKEN, server: SERVER, home: { id: 'bot_1', handle: 'ann.home' } }), { mode: 0o600 })
  return path
}

function fakeSocial() {
  const calls = []
  const team = { id: 'ott_1', workspace_id: WS, name: 'Studio', listed: true, summary: 's', role: 'owner' }
  const me = { owner_id: 'own_ann', handle: 'ann.home', display_name: 'Ann', platform_user_id: 'b'.repeat(32) }
  const fetch = async (url, init) => {
    const path = String(url).slice(SERVER.length)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, method: init.method, body })
    const ok = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/v1/ot/profile' && init.method === 'PUT') return ok(200, { ...me, platform_user_id: body.platform_user_id || me.platform_user_id })
    if (path === '/v1/ot/me') return ok(200, me)
    if (path === '/v1/ot/workspaces') return ok(200, { workspaces: [team] })
    if (path === '/v1/ot/teams/by-workspace/' + WS) return ok(200, team)
    if (path === '/v1/ot/teams/ott_1/members' && init.method === 'GET') {
      return ok(200, { role: 'owner', members: [
        { owner_id: 'own_ann', handle: 'ann.home', display_name: 'Ann', platform_user_id: 'b'.repeat(32), role: 'owner', joined_at: 1_700_000_000_000 },
        { owner_id: 'own_bea', handle: 'bea.home', display_name: 'Bea', role: 'member', joined_at: 1_700_000_100_000 },
      ] })
    }
    if (path === '/v1/ot/teams/ott_1/invites' && init.method === 'POST') {
      return ok(201, { code: 'invite-code-once', invite: { id: 'oti_1', team_id: 'ott_1', role: 'member', expires_at: 1_700_086_400_000, max_uses: 10, use_count: 0, revoked: false, frozen: false, requires_approval: false, created_at: 1_700_000_000_000 } })
    }
    if (path === '/v1/ot/meeting-calls/join') {
      const code = body.code === 'full' ? 'call_full' : 'call_already_joined'
      return ok(409, { error: { code, message: code } })
    }
    if (path === '/v1/ot/invites/accept') return ok(200, { status: 'pending', team_id: 'ott_1', request_id: 'otjr_1' })
    if (path === '/v1/ot/invites/preview') return ok(200, { usable: !body.code.startsWith('expired-'),
      ...(body.code === 'expired-joined-invite' ? { membership: 'member', workspace_id: WS }
        : body.code === 'expired-pending-invite' ? { membership: 'pending' }
          : body.code === 'expired-suspended-invite' ? { membership: 'suspended', workspace_id: WS } : {}),
      team: { id: 'ott_1', name: 'Studio', owner: me, summary: 'Private team summary' }, role: 'member', requires_approval: true })
    if (path === '/v1/ot/directory' || path.startsWith('/v1/ot/directory?')) return ok(200, { teams: [
      { id: 'ott_1', workspace_id: WS, name: 'Studio', summary: 's', member_count: 2, membership: 'member' },
      { id: 'ott_2', name: 'New Studio', summary: 's', member_count: 2, membership: null },
    ] })
    if (path === '/v1/ot/directory/ott_1/join') return ok(200, {status: 'member', workspace_id: WS})
    if (path === '/v1/ot/directory/ott_2/join') return ok(200, {status: 'pending', request_id: 'otjr_2'})
    if (path === '/v1/ot/conversations?scope=member&team_id=ott_1' && init.method === 'GET') {
      return ok(200, { conversations: [{ id: 'otc_1', kind: 'dm', title: 'Bea', members: [{ handle: 'bea.home', display_name: 'Bea', owner_id: 'own_bea' }, { handle: 'ann.home', display_name: 'Ann', owner_id: 'own_ann', platform_user_id: 'b'.repeat(32) }], unread: 1, read_seq: 2, updated_at: 1_700_000_200_000, last_message: { body: 'hi', retracted: false } }] })
    }
    if (path === '/v1/ot/conversations' && init.method === 'POST') return ok(201, { id: 'otc_2', kind: 'dm', title: 'Bea', members: [{ handle: 'bea.home', display_name: 'Bea', owner_id: 'own_bea' }], unread: 0, updated_at: 1_700_000_200_000 })
    if (path.startsWith('/v1/ot/conversations/otc_1/messages') && init.method === 'GET') {
      return ok(200, { messages: [{ id: 'otm_1', author_id: 'own_bea', author_kind: 'member', author: { handle: 'bea.home', owner_id: 'own_bea', display_name: 'Bea' }, body: 'hi', created_at: 1_700_000_200_000, retracted: false }], read_seq: 2, last_seq: 3 })
    }
    if (path === '/v1/ot/conversations/otc_1') return ok(200, { id: 'otc_1', kind: 'dm', title: 'Bea', members: [{ handle: 'bea.home', display_name: 'Bea', owner_id: 'own_bea' }], unread: 0, updated_at: 1_700_000_200_000 })
    if (path === '/v1/ot/conversations/otc_group') return ok(200, { id: 'otc_group', kind: 'group', team_id: 'ott_1' })
    if (path === '/v1/ot/conversations/otc_other') return ok(200, { id: 'otc_other', kind: 'group', team_id: 'ott_other' })
    if (path === '/v1/ot/conversations/otc_group/members' && init.method === 'POST') return ok(200, {
      id: 'otc_group', kind: 'group', team_id: 'ott_1', members: [{ handle: 'bea.home', owner_id: 'own_bea' }],
    })
    if (path === '/v1/ot/discover?kind=work' || path.startsWith('/v1/ot/discover?')) {
      return ok(200, { items: [{ id: 'otl_1', slug: 'my-essay', kind: 'work', work_kind: 'document', title: 'Essay', creator: { handle: 'ann.home', display_name: 'Ann' }, updated_at: 1_700_000_000_000, path: '/w/my-essay', likes: 3, liked: false, collected: false, following: false, own: true }] })
    }
    return ok(404, { error: { code: 'not_found', message: path } })
  }
  return { fetch, calls }
}

function setup(binding = null) {
  const social = fakeSocial()
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: social.fetch }))
  const host = { dataDir: '/nonexistent', call: async (endpoint) => {
    assert.equal(endpoint, 'agents/personal-binding')
    return binding
  } }
  return { social, host }
}

test('members v1 lists Flask-shaped rows using verified workspace mappings', async () => {
  const { social, host } = setup()
  const result = await members(host).endpoints.v1({ method: 'GET', path: `/v1/workspaces/${WS}/members` })
  assert.equal(result.status, 200)
  assert.equal(result.body.items[0].user_id, 'b'.repeat(32))
  assert.equal(result.body.items[0].username, 'ann')
  assert.equal(result.body.items[0].role, 'owner')
  assert.equal(result.body.items[1].username, 'bea')
  assert.ok(social.calls.some((c) => c.path === '/v1/ot/teams/by-workspace/' + WS))
  assert.ok(!social.calls.some((c) => c.path === '/v1/ot/profile' || c.path === '/v1/ot/teams/ensure'))
})

test('invite create returns the one-time token; accept maps a pending request to 202', async () => {
  const { host } = setup()
  const created = await invites(host).endpoints.v1({ method: 'POST', path: `/v1/workspaces/${WS}/invites`, body: { role: 'member', expires_in: 604800 } })
  assert.equal(created.status, 201)
  assert.equal(created.body.token, 'invite-code-once')
  assert.equal(created.body.invite.role, 'member')
  assert.equal(created.body.invite.workspace_id, WS)
  const accepted = await invites(host).endpoints.v1({ method: 'POST', path: '/v1/invites/accept', body: { token: 'invite-code-once' } })
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.join_request.status, 'pending')
})

test('invite preview uses the signed-in connector and exposes only the name and join requirements', async () => {
  const { host, social } = setup()
  const endpoint = invites(host).endpoints.v1
  const preview = token => endpoint({ method: 'POST', path: '/v1/invites/preview', body: { token } })
  assert.deepEqual((await preview('another-invite-code')).body, {
    invitation: { team_name: 'Studio', role: 'member', requires_approval: true },
  })
  assert.equal((await preview('expired-invite-code')).status, 410)
  const joined = await preview('expired-joined-invite')
  assert.equal(joined.status, 200)
  assert.equal(joined.body.invitation.membership, 'member')
  assert.equal(joined.body.invitation.workspace_id, WS)
  const pending = await preview('expired-pending-invite')
  assert.equal(pending.status, 200)
  assert.equal(pending.body.invitation.membership, 'pending')
  assert.equal(pending.body.invitation.workspace_id, undefined)
  assert.equal((await preview('expired-suspended-invite')).status, 403)
  assert.equal((await preview('https://external.test/')).status, 400)
  assert.equal(social.calls.filter(row => row.path === '/v1/ot/invites/preview').length, 5)
  assert.ok(!social.calls.some(row => row.path === '/v1/ot/invites/accept'))
})

test('group invite sends one batch for the currently scoped workspace', async () => {
  const { social, host } = setup()
  const endpoint = messenger(host).endpoints.v1
  const path = id => `/v1/workspaces/${WS}/social/conversations/${id}/members`
  const payload = { method: 'POST', body: { member_ids: ['bea.home'] } }
  const wrongTeam = await endpoint({ ...payload, path: path('otc_other') })
  assert.equal(wrongTeam.status, 404)
  const result = await endpoint({ ...payload, path: path('otc_group') })
  assert.equal(result.status, 200)
  assert.equal(result.body.conversation.members[0].username, 'bea')
  assert.deepEqual(social.calls.filter(call => call.method === 'POST'),
    [{ method: 'POST', path: '/v1/ot/conversations/otc_group/members', body: { handles: ['bea.home'], team_id: 'ott_1' } }])
})

test('directory and messenger v1 keep workspace ids and unix-second timestamps', async () => {
  const { host } = setup()
  const directory = await teams(host).endpoints.v1({ method: 'GET', path: '/v1/team-directory', query: 'q=studio' })
  assert.equal(directory.status, 200)
  assert.equal(directory.body.items[0].team_id, 'ott_1')
  assert.equal(directory.body.items[0].workspace_id, WS)
  assert.equal(directory.body.items[1].workspace_id, 'ott_2')
  const join = path => teams(host).endpoints.v1({method: 'POST', path: '/v1/team-directory/' + path + '/join'})
  assert.deepEqual((await join('ott_1')).body, {status: 'member', workspace_id: WS})
  assert.deepEqual((await join('ott_2')).body, {join_request: {id: 'otjr_2', status: 'pending'}})
  const listed = await messenger(host).endpoints.v1({ method: 'GET', path: `/v1/workspaces/${WS}/social/conversations` })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items[0].id, 'otc_1')
  assert.equal(listed.body.items[0].updated, 1_700_000_200)
  const opened = await messenger(host).endpoints.v1({ method: 'GET', path: `/v1/workspaces/${WS}/social/conversations/otc_1` })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.items[0].body, 'hi')
  assert.equal(opened.body.items[0].created, 1_700_000_200)
})

test('discover v1 maps a work feed into the page card shape', async () => {
  const { host } = setup()
  const feed = await discover(host).endpoints.v1({ method: 'GET', path: '/v1/discover/works' })
  assert.equal(feed.status, 200)
  assert.equal(feed.body.items[0].slug, 'my-essay')
  assert.equal(feed.body.items[0].kind, 'document')
  assert.equal(feed.body.items[0].kind_label, '文档')
  assert.equal(feed.body.items[0].author, 'ann')
  assert.deepEqual(feed.body.items[0].creator, {handle: 'ann.home', name: 'Ann'})
  assert.equal(feed.body.items[0].own_work, true)
})

test('auth and single workspace paths stay outside the C v1 handlers', async () => {
  const { host } = setup()
  const missed = await members(host).endpoints.v1({ method: 'GET', path: '/v1/auth/session' })
  assert.equal(missed.status, 404)
  assert.equal(missed.body.error.code, 'not_moved')
  const workspaces = await teams(host).endpoints.v1({ method: 'GET', path: `/v1/workspaces/${WS}` })
  assert.equal(workspaces.status, 404)
  assert.equal(workspaces.body.error.code, 'not_moved')
})

test('workspace list includes the local personal binding alongside Social workspaces', async () => {
  const wid = 'c'.repeat(32)
  const { social, host } = setup({ workspace_id: wid, agent_id: 'd'.repeat(32) })
  const endpoint = teams(host).endpoints.v1
  const first = await endpoint({ method: 'GET', path: '/v1/workspaces?limit=1' })
  assert.equal(first.status, 200)
  assert.equal(first.body.cursor, wid)
  assert.deepEqual(first.body.items.map(row => [row.id, row.kind, row.owner_id]), [[wid, 'personal', 'b'.repeat(32)]])
  const second = await endpoint({ method: 'GET', path: '/v1/workspaces?limit=1&cursor=' + wid })
  assert.equal(second.body.cursor, null)
  assert.deepEqual(second.body.items.map(row => [row.id, row.name]), [[WS, 'Studio']])
  assert.ok(social.calls.every(call => call.method === 'GET'))
})

test('personal workspace scope reads only this DS-Bot binding', async () => {
  const wid = 'c'.repeat(32)
  const { social, host } = setup({ workspace_id: wid, agent_id: 'd'.repeat(32) })
  const result = await teams(host).endpoints.v1({ method: 'GET', path: '/v1/workspaces?scope=personal' })
  assert.equal(result.status, 200)
  assert.equal(result.body.cursor, null)
  assert.deepEqual(result.body.items.map(row => [row.id, row.kind]), [[wid, 'personal']])
  assert.deepEqual(social.calls, [])
})

test('workspace list keeps the Social row when it already maps the personal workspace', async () => {
  const { host } = setup({ workspace_id: WS, agent_id: 'd'.repeat(32) })
  const result = await teams(host).endpoints.v1({ method: 'GET', path: '/v1/workspaces' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.items.map(row => [row.id, row.name, row.kind]), [[WS, 'Studio', 'workspace']])
})


test('unknown workspace fails closed without creating membership or guessing an owner', async () => {
  const { social, host } = setup()
  const result = await members(host).endpoints.v1({ method: 'GET', path: `/v1/workspaces/${'f'.repeat(32)}/members` })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'membership_migration_required')
  assert.ok(social.calls.every(call => call.method === 'GET'))
})


test('browser-style embedded query reaches discover and writes reject query strings', async () => {
  const { social, host } = setup()
  const feed = await discover(host).endpoints.v1({ method: 'GET', path: '/v1/discover/works?q=essay&limit=5' })
  assert.equal(feed.status, 200)
  assert.ok(social.calls.some(c => c.path.includes('q=essay') && c.path.includes('limit=5')))
  const blocked = await invites(host).endpoints.v1({ method: 'POST', path: `/v1/workspaces/${WS}/invites?x=1`, body: {} })
  assert.equal(blocked.status, 400)
  assert.equal((await teams(host).endpoints.v1({ method: 'GET', path: '/v1/team-directory?q=x', query: 'q=y' })).status, 400)
})

test('video meeting conflicts retain the reason shown in the browser', async () => {
  const { social, host } = setup()
  const join = (code) => messenger(host).endpoints.v1({method: 'POST', path: '/v1/meeting-calls/join', body: {code}})
  for (const [input, reason] of [['full', 'call_full'], ['already', 'call_already_joined']]) {
    const response = await join(input)
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, reason)
  }
  assert.deepEqual(social.calls.map(call => call.path), Array(2).fill('/v1/ot/meeting-calls/join'))
})

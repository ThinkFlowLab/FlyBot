import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { cleanApps, composioAppStatus, composioDeleteSession, composioSearchApps, composioSession, composioSessionAlive, composioSessionFind, signIn } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `ghp_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, body, json: async () => body })

test('signIn asks GitHub who owns the token', async () => {
  const token = fresh()
  let seen
  const user = await signIn(token, { api: 'https://gh.test/', fetch: async (url, init) => { seen = { url, init }; return answer(200, { login: 'octo' }) } })
  assert.deepEqual(user, { login: 'octo' })
  assert.equal(seen.url, 'https://gh.test/user')
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`)
  await assert.rejects(signIn(token, { fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(signIn(token, { fetch: async () => answer(500, {}) }), /GitHub answered 500/)
  await assert.rejects(signIn(token, { fetch: async () => { throw new Error(`boom ${token}`) } }), /^Error: Could not reach GitHub$/)
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connectors-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

// A loader that hands out a fake MCP client and records each mount.
function setup({ fail = false, github = { api: 'https://gh.test' }, composio = { api: 'https://composio.test/api/v3.1' }, home = teamHome() } = {}) {
  const mounts = []
  const plugin = { name: 'mcp-client', apply() {} }
  const loader = {
    import: async name => { assert.equal(name, '@deepseek-ai/dsh-mcp-client'); return { default: plugin } },
    unwrapExports: exports => exports.default,
  }
  const ctx = fakeContext({ services: { loader } })
  ctx.plugin = (given, config) => {
    assert.equal(given, plugin)
    const mount = { config, disposed: false }
    mounts.push(mount)
    return {
      await: async () => {
        if (fail === 'url') throw new Error(`cannot reach ${config.url}`)
        if (fail) throw new Error(`refused ${config.headers.Authorization}`)
      },
      dispose: () => { mount.disposed = true },
    }
  }
  capture(ctx)
  apply(ctx, { home, github, composio })
  return { ctx, home, mounts }
}

function capture(ctx) {
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
}

// Calls the /api/bot route the way the client does.
async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

test('connecting saves the token for all of the owner\'s Bots (#545) and mounts GitHub MCP; disconnecting undoes both', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const token = fresh()

  const before = await call(ctx, 'state', {})
  assert.deepEqual(before.value.connectors[0], { id: 'github', name: 'GitHub', state: 'off', account: null })

  const connected = await call(ctx, 'connector-connect', { id: 'github', token: ` ${token} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(connected.value[0], { id: 'github', name: 'GitHub', state: 'ready', account: 'octo' })
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, {
    transport: 'streamable-http',
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' },
    failOnStartupError: true,
  })
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GITHUB_TOKEN', 'all']])
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const off = await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.deepEqual(off.value[0], { id: 'github', name: 'GitHub', state: 'off', account: null })
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a token GitHub refuses is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(401, {})
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not accept/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a failed MCP connection shows the error without the token, and Try again mounts again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup({ fail: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const token = fresh()
  const result = await call(ctx, 'connector-connect', { id: 'github', token })
  const github = result.value.find(entry => entry.id === 'github')
  assert.equal(github.state, 'error')
  assert.ok(!github.error.includes(token), github.error)
  assert.match(github.error, /\[secret:GITHUB_TOKEN\]/)
  await call(ctx, 'connector-retry', { id: 'github' })
  assert.equal(mounts.length, 2)
})

test('deleting GITHUB_TOKEN on the Secrets page unmounts GitHub', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'secret-delete', { name: 'GITHUB_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.equal(mounts[0].disposed, true)
  assert.equal(state.value.connectors[0].state, 'off')
})

test('github: false and composio: false hide the connectors', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  capture(ctx)
  apply(ctx, { home, github: false })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors.map(entry => entry.id), ['composio'])
  const other = teamHome()
  const second = fakeContext()
  capture(second)
  apply(second, { home: other, github: false, composio: false })
  t.after(async () => { await second.dispose(); rmSync(other, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call(second, 'state', {})).value.connectors, [])
})

test('a GitHub address without https refuses to send the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, { login: 'octo' }) }
  const { ctx, home, mounts } = setup({ github: { url: 'http://mcp.test/', api: 'https://gh.test' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const refused = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
})


// --- Composio: one API key, many apps, through the tool-router MCP gateway ---

const composioKey = () => `cmp_${randomBytes(16).toString('hex')}`
const SESSION = { session_id: 's1', mcp: { type: 'http', url: 'https://composio.test/tool_router/s1/mcp' } }

// Stands in for Composio. `reply` answers session creation (POST); a session that was made and
// not yet deleted answers GET 200, DELETE 200 once and then 404, like the real API. Every request is
// recorded in `requests`, the creations (with their parsed body) in `posts`.
function fakeComposio(reply = () => answer(201, SESSION)) {
  const requests = []
  const live = new Set()
  // The address Composio gives for each session it made, the way GET /tool_router/session/{id} answers it.
  const addresses = new Map()
  const fetch = async (url, init) => {
    const method = init.method ?? 'GET'
    const request = { url, init, method, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) }
    requests.push(request)
    if (method === 'POST') {
      const made = reply(init)
      if (made.ok && made.body?.session_id !== undefined) { live.add(made.body.session_id); addresses.set(made.body.session_id, made.body.mcp?.url) }
      return made
    }
    const id = decodeURIComponent(url.split('/').at(-1))
    if (!live.has(id)) return answer(404, { error: { message: 'gone' } })
    if (method === 'DELETE') live.delete(id)
    return answer(200, method === 'DELETE' ? { session_id: id, deleted: true } : { session_id: id, mcp: { type: 'http', url: addresses.get(id) } })
  }
  return { requests, live, addresses, fetch, get posts() { return requests.filter(request => request.method === 'POST') }, get deletes() { return requests.filter(request => request.method === 'DELETE') } }
}
// A new session id for every creation.
const numbered = () => { let count = 0; return () => { count += 1; return answer(201, { session_id: `trs_${count}`, mcp: { url: `https://composio.test/tool_router/trs_${count}/mcp` } }) } }

test('cleanApps takes a list or a text, lowercases, de-duplicates and refuses nothing or odd names', () => {
  assert.deepEqual(cleanApps(['Gmail', 'gmail', ' slack ']), ['gmail', 'slack'])
  assert.deepEqual(cleanApps('gmail, Slack  notion'), ['gmail', 'slack', 'notion'])
  assert.throws(() => cleanApps([]), /at least one app/)
  assert.throws(() => cleanApps(undefined), /at least one app/)
  assert.throws(() => cleanApps(['bad name!']), /lowercase letters/)
  assert.throws(() => cleanApps(['../x']), /lowercase letters/)
  assert.throws(() => cleanApps(Array.from({ length: 41 }, (_, index) => `app${index}`)), /up to 40/)
})

test('composioSession limits the session to the apps, proves the key, and keeps the key on Composio\'s own host', async () => {
  const key = composioKey()
  const sent = fakeComposio()
  const session = await composioSession(key, { api: 'https://composio.test/api/v3.1/', userId: 'flybot-1', apps: ['gmail', 'slack'], fetch: sent.fetch })
  assert.deepEqual(session, { url: 'https://composio.test/tool_router/s1/mcp', id: 's1' })
  const [request] = sent.requests
  assert.equal(request.url, 'https://composio.test/api/v3.1/tool_router/session')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers['x-api-key'], key)
  assert.equal(request.init.redirect, 'error')
  assert.deepEqual(request.body.toolkits, { enable: ['gmail', 'slack'] })
  assert.equal(request.body.user_id, 'flybot-1')
  assert.deepEqual(request.body.workbench, { enable: false })
  assert.ok(!JSON.stringify(request.body).includes(key))
  const options = { api: 'https://composio.test/api/v3.1', userId: 'u', apps: ['gmail'] }
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(401, {})).fetch }), /did not accept/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(403, {})).fetch }), /did not accept/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(400, { error: { message: 'Unknown toolkit nope' } })).fetch }), /answered 400: Unknown toolkit nope/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(500, {})).fetch }), /answered 500/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(201, {})).fetch }), /did not give an MCP address/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(201, { mcp: SESSION.mcp })).fetch }), /did not give a session id/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(201, { mcp: { url: 'https://evil.test/mcp' } })).fetch }), /another host/)
  await assert.rejects(composioSession(key, { ...options, fetch: fakeComposio(() => answer(201, { mcp: { url: 'http://composio.test/mcp' } })).fetch }), /another host/)
  await assert.rejects(composioSession(key, { ...options, fetch: async () => { throw new Error(`boom ${key}`) } }), /^Error: Could not reach Composio$/)
})

test('connecting Composio saves the key for all of the owner\'s Bots (#545), keeps it out of the profile, mounts mcp__composio__ tools, and disconnecting undoes it', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio()
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()

  const before = (await call(ctx, 'state', {})).value.connectors.find(entry => entry.id === 'composio')
  assert.deepEqual(before, { id: 'composio', name: 'Composio', state: 'off', account: null, apps: [] })

  const none = await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: [] })
  assert.equal(none.ok, false)
  assert.match(none.error.message, /at least one app/)
  assert.equal(sent.requests.length, 0)
  const empty = await call(ctx, 'connector-connect', { id: 'composio', token: '  ', apps: ['gmail'] })
  assert.equal(empty.ok, false)
  assert.match(empty.error.message, /Paste a key first/)

  const connected = await call(ctx, 'connector-connect', { id: 'composio', token: ` ${key} `, apps: ['Gmail', 'slack'] })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(connected.value.find(entry => entry.id === 'composio'), { id: 'composio', name: 'Composio', state: 'ready', account: null, apps: ['gmail', 'slack'] })
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, {
    transport: 'streamable-http',
    serverName: 'composio',
    url: 'https://composio.test/tool_router/s1/mcp',
    headers: { 'x-api-key': key },
    failOnStartupError: true,
  })
  const userIds = new Set(sent.posts.map(request => request.body.user_id))
  assert.equal(userIds.size, 1)
  assert.match([...userIds][0], /^flybot-[0-9a-f-]{36}$/)

  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['COMPOSIO_API_KEY', 'all']])
  assert.ok(!JSON.stringify(state).includes(key))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(key))
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio.apps, ['gmail', 'slack'])

  const off = await call(ctx, 'connector-disconnect', { id: 'composio' })
  assert.deepEqual(off.value.find(entry => entry.id === 'composio'), { id: 'composio', name: 'Composio', state: 'off', account: null, apps: [] })
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
  // The same FlyBot id comes back, so apps signed in earlier stay signed in.
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  assert.equal(new Set(sent.posts.map(request => request.body.user_id)).size, 1)
})

test('Choose apps mounts again with the new list and needs no key; an unknown app name is refused by Composio and keeps the old list', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let refuse = false
  const sent = fakeComposio(() => refuse ? answer(400, { error: { message: 'Unknown toolkit nope' } }) : answer(201, SESSION))
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const early = await call(ctx, 'connector-apps', { id: 'composio', apps: ['gmail'] })
  assert.equal(early.ok, false)
  assert.match(early.error.message, /Connect Composio first/)
  const key = composioKey()
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  const changed = await call(ctx, 'connector-apps', { id: 'composio', apps: ['gmail', 'notion'] })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.deepEqual(changed.value.find(entry => entry.id === 'composio').apps, ['gmail', 'notion'])
  assert.equal(mounts.length, 2)
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual(sent.posts.at(-1).body.toolkits, { enable: ['gmail', 'notion'] })
  refuse = true
  const refused = await call(ctx, 'connector-apps', { id: 'composio', apps: ['nope'] })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Unknown toolkit nope/)
  const view = (await call(ctx, 'state', {})).value.connectors.find(entry => entry.id === 'composio')
  assert.deepEqual(view.apps, ['gmail', 'notion'])
  assert.equal(view.state, 'ready')
  assert.equal(mounts.length, 2)
  const github = await call(ctx, 'connector-apps', { id: 'github', apps: ['gmail'] })
  assert.equal(github.ok, false)
})

test('a key Composio refuses is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = fakeComposio(() => answer(401, {})).fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not accept/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a failed Composio MCP connection shows an error without the key, and Try again mounts again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = fakeComposio().fetch
  const { ctx, home, mounts } = setup({ fail: true })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()
  const result = await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  const composio = result.value.find(entry => entry.id === 'composio')
  assert.equal(composio.state, 'error')
  assert.ok(!JSON.stringify(result).includes(key))
  await call(ctx, 'connector-retry', { id: 'composio' })
  assert.equal(mounts.length, 2)
})

test('deleting COMPOSIO_API_KEY on the Secrets page unmounts Composio, and GitHub is untouched', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async (url, init) => url.startsWith('https://gh.test') ? answer(200, { login: 'octo' }) : fakeComposio().fetch(url, init)
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  assert.deepEqual(mounts.map(mount => mount.config.serverName), ['github', 'composio'])
  await call(ctx, 'secret-delete', { name: 'COMPOSIO_API_KEY' })
  const view = (await call(ctx, 'state', {})).value.connectors
  assert.equal(mounts[1].disposed, true)
  assert.equal(mounts[0].disposed, false)
  assert.deepEqual(view.map(entry => [entry.id, entry.state]), [['github', 'ready'], ['composio', 'off']])
})

test('a Composio address without https refuses to send the key', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(201, SESSION) }
  const { ctx, home, mounts } = setup({ composio: { api: 'http://composio.test/api/v3.1' } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const refused = await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
})

// --- Composio sessions: made once, reused while valid, deleted when superseded (#323) ---

test('composioSessionAlive and composioDeleteSession use the session address, send the key only as a header, and never throw on delete', async () => {
  const key = composioKey()
  const api = 'https://composio.test/api/v3.1/'
  const sent = fakeComposio(() => answer(201, SESSION))
  await composioSession(key, { api, userId: 'u', apps: ['gmail'], fetch: sent.fetch })
  assert.equal(await composioSessionAlive(key, { api, id: 's1', fetch: sent.fetch }), true)
  const [, get] = sent.requests
  assert.equal(get.url, 'https://composio.test/api/v3.1/tool_router/session/s1')
  assert.equal(get.method, 'GET')
  assert.equal(get.init.headers['x-api-key'], key)
  assert.equal(get.init.redirect, 'error')
  assert.equal(await composioSessionAlive(key, { api, id: 'nope', fetch: sent.fetch }), false)
  await assert.rejects(composioSessionAlive(key, { api, id: 's1', fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(composioSessionAlive(key, { api, id: 's1', fetch: async () => answer(500, {}) }), /answered 500/)
  await assert.rejects(composioSessionAlive(key, { api, id: 's1', fetch: async () => { throw new Error(`boom ${key}`) } }), /^Error: Could not reach Composio$/)

  assert.equal(await composioDeleteSession(key, { api, id: 's1', fetch: sent.fetch }), true)
  const [del] = sent.deletes
  assert.equal(del.url, 'https://composio.test/api/v3.1/tool_router/session/s1')
  assert.equal(del.init.headers['x-api-key'], key)
  assert.equal(del.init.redirect, 'error')
  assert.equal(del.init.body, undefined)
  // Already gone counts as deleted; a refusal or an outage is false, not an error.
  assert.equal(await composioDeleteSession(key, { api, id: 's1', fetch: sent.fetch }), true)
  assert.equal(await composioDeleteSession(key, { api, id: 's1', fetch: async () => answer(500, {}) }), false)
  assert.equal(await composioDeleteSession(key, { api, id: 's1', fetch: async () => { throw new Error(`boom ${key}`) } }), false)
  // An id that is not a plain token never reaches the network.
  const before = sent.requests.length
  assert.equal(await composioDeleteSession(key, { api, id: '../../x', fetch: sent.fetch }), false)
  assert.equal(await composioDeleteSession(key, { api, id: undefined, fetch: sent.fetch }), false)
  assert.equal(sent.requests.length, before)
})

test('Composio makes one session per connect, keeps it (never the key) in state, and reuses it on Try again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  assert.equal(sent.posts.length, 1, 'the key check and the mount share one session')
  assert.equal(mounts[0].config.url, 'https://composio.test/tool_router/trs_1/mcp')
  const kept = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio
  // Only the id and the apps are kept: the address is not stored, it is asked for at each mount.
  assert.deepEqual(kept.session, { id: 'trs_1', apps: ['gmail'] })
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(key))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes('composio.test/tool_router'))

  await call(ctx, 'connector-retry', { id: 'composio' })
  await call(ctx, 'connector-retry', { id: 'composio' })
  assert.equal(mounts.length, 3)
  assert.equal(sent.posts.length, 1, 'Try again mounts the same session')
  assert.ok(mounts.every(mount => mount.config.url.endsWith('/trs_1/mcp')))
  // Each mount asked Composio for the address, with the key in the header only.
  assert.ok(sent.requests.filter(request => request.method === 'GET').length >= 3)
  assert.ok(sent.requests.filter(request => request.method === 'GET').every(request => request.init.headers['x-api-key'] === key && request.url.endsWith('/trs_1')))
  assert.equal(sent.deletes.length, 0)
  // Choosing the same apps again changes nothing on Composio.
  await call(ctx, 'connector-apps', { id: 'composio', apps: ['gmail'] })
  assert.equal(sent.posts.length, 1)
  assert.equal(sent.deletes.length, 0)
})

test('a session Composio no longer has is made again on Try again, and the new one is kept', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  sent.live.clear()
  const retried = await call(ctx, 'connector-retry', { id: 'composio' })
  assert.equal(retried.value.find(entry => entry.id === 'composio').state, 'ready')
  assert.equal(sent.posts.length, 2)
  assert.ok(mounts.at(-1).config.url.endsWith('/trs_2/mcp'))
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio.session.id, 'trs_2')
})

test('Choose apps deletes the superseded session after the new one is kept; a refused list leaves the old session alone', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let refuse = false
  const make = numbered()
  const sent = fakeComposio(() => refuse ? answer(400, { error: { message: 'Unknown toolkit nope' } }) : make())
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  const changed = await call(ctx, 'connector-apps', { id: 'composio', apps: ['gmail', 'notion'] })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.deepEqual(sent.deletes.map(request => request.url), ['https://composio.test/api/v3.1/tool_router/session/trs_1'])
  assert.equal(sent.deletes[0].init.headers['x-api-key'], key)
  assert.deepEqual([...sent.live], ['trs_2'])
  assert.ok(mounts.at(-1).config.url.endsWith('/trs_2/mcp'))
  assert.equal(sent.posts.length, 2)
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio.session.id, 'trs_2')

  refuse = true
  const refused = await call(ctx, 'connector-apps', { id: 'composio', apps: ['nope'] })
  assert.equal(refused.ok, false)
  assert.equal(sent.deletes.length, 1)
  assert.deepEqual([...sent.live], ['trs_2'])
})

test('Disconnect deletes the session with the key it was made with, drops it from state, and a failed delete is not an error', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  let breakDelete = false
  globalThis.fetch = (url, init) => breakDelete && init.method === 'DELETE' ? Promise.reject(new Error('boom')) : sent.fetch(url, init)
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  const userId = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio.userId
  const off = await call(ctx, 'connector-disconnect', { id: 'composio' })
  assert.equal(off.ok, true)
  assert.equal(sent.deletes.length, 1)
  assert.equal(sent.deletes[0].init.headers['x-api-key'], key)
  assert.deepEqual([...sent.live], [])
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio, { userId })

  // Connecting again makes a fresh session for the same FlyBot id; an outage on delete does not block Disconnect.
  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  assert.equal(sent.posts.length, 2)
  breakDelete = true
  const again = await call(ctx, 'connector-disconnect', { id: 'composio' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(again.value.find(entry => entry.id === 'composio').state, 'off')
  assert.ok(!JSON.stringify(again).includes(key))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(key))
})

test('a new key makes its own session and deletes the old key\'s session with the old key', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  globalThis.fetch = sent.fetch
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const first = composioKey()
  const second = composioKey()
  await call(ctx, 'connector-connect', { id: 'composio', token: first, apps: ['gmail'] })
  // The first session cannot be seen with the second key (another project): a new session is made.
  const get = sent.fetch
  globalThis.fetch = (url, init) => init.headers['x-api-key'] === second && init.method === 'GET' && url.endsWith('/trs_1') ? Promise.resolve(answer(404, {})) : get(url, init)
  await call(ctx, 'connector-connect', { id: 'composio', token: second, apps: ['gmail'] })
  assert.equal(sent.posts.length, 2)
  assert.deepEqual(sent.deletes.map(request => [request.url.split('/').at(-1), request.init.headers['x-api-key']]), [['trs_1', first]])
  assert.deepEqual([...sent.live], ['trs_2'])
})

// --- The session address is not kept in state.json (#335) ---

const untilMounted = async (mounts, count) => {
  const end = Date.now() + 3000
  while (mounts.length < count) {
    if (Date.now() > end) throw new Error('until: the mount did not happen within 3 s')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('composioSessionFind asks Composio for the address by id, with the key only in the header, and trusts only https on the API host', async () => {
  const key = composioKey()
  const api = 'https://composio.test/api/v3.1/'
  const sent = fakeComposio(() => answer(201, SESSION))
  await composioSession(key, { api, userId: 'u', apps: ['gmail'], fetch: sent.fetch })
  assert.equal(await composioSessionFind(key, { api, id: 's1', fetch: sent.fetch }), 'https://composio.test/tool_router/s1/mcp')
  const get = sent.requests.at(-1)
  assert.equal(get.url, 'https://composio.test/api/v3.1/tool_router/session/s1')
  assert.equal(get.init.headers['x-api-key'], key)
  assert.ok(!get.url.includes(key))
  assert.equal(await composioSessionFind(key, { api, id: 'nope', fetch: sent.fetch }), undefined)
  const says = body => async () => answer(200, body)
  assert.equal(await composioSessionFind(key, { api, id: 's1', fetch: says({ session_id: 's1' }) }), undefined)
  assert.equal(await composioSessionFind(key, { api, id: 's1', fetch: says({ mcp: { url: 'https://evil.test/mcp' } }) }), undefined)
  assert.equal(await composioSessionFind(key, { api, id: 's1', fetch: says({ mcp: { url: 'http://composio.test/mcp' } }) }), undefined)
  assert.equal(await composioSessionFind(key, { api, id: 's1', fetch: says({ mcp: { url: 'not a url' } }) }), undefined)
  await assert.rejects(composioSessionFind(key, { api, id: 's1', fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(composioSessionFind(key, { api, id: 's1', fetch: async () => answer(500, {}) }), /answered 500/)
})

test('an address saved by an older version is dropped from state.json at start, and the mount uses the one Composio gives for the id', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  globalThis.fetch = sent.fetch
  const first = setup()
  const { home } = first
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const key = composioKey()
  await call(first.ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail'] })
  await first.ctx.dispose()

  // What #323 wrote: the address next to the id (here with a made-up credential-looking tail).
  const file = join(home, 'state.json')
  const old = JSON.parse(readFileSync(file, 'utf8'))
  old.connectors.composio.session.url = 'https://composio.test/tool_router/trs_1/mcp?legacy=LEGACYCREDENTIAL'
  writeFileSync(file, JSON.stringify(old))

  const second = setup({ home })
  t.after(() => second.ctx.dispose())
  await untilMounted(second.mounts, 1)
  assert.equal(second.mounts[0].config.url, 'https://composio.test/tool_router/trs_1/mcp')
  assert.deepEqual(second.mounts[0].config.headers, { 'x-api-key': key })
  assert.equal(sent.posts.length, 1, 'the session is reused, not made again')
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('LEGACYCREDENTIAL'))
  assert.ok(!text.includes('composio.test/tool_router'))
  assert.deepEqual(JSON.parse(text).connectors.composio.session, { id: 'trs_1', apps: ['gmail'] })
})

test('a session whose answer names no address on Composio\'s host is made again, and the address it named is never mounted', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  globalThis.fetch = sent.fetch
  const { ctx, home, mounts } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  sent.addresses.set('trs_1', 'https://evil.test/mcp')
  const retried = await call(ctx, 'connector-retry', { id: 'composio' })
  assert.equal(retried.value.find(entry => entry.id === 'composio').state, 'ready')
  assert.equal(sent.posts.length, 2)
  assert.ok(mounts.every(mount => !mount.config.url.includes('evil.test')))
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).connectors.composio.session.id, 'trs_2')
})

test('a mount error that quotes the session address shows it as [session address]', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = fakeComposio(numbered()).fetch
  const { ctx, home } = setup({ fail: 'url' })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const result = await call(ctx, 'connector-connect', { id: 'composio', token: composioKey(), apps: ['gmail'] })
  const composio = result.value.find(entry => entry.id === 'composio')
  assert.equal(composio.state, 'error')
  assert.equal(composio.error, 'cannot reach [session address]')
})

// --- #359: search Composio's app list, and show whether each picked app is signed in ---

test('composioSearchApps asks Composio\'s app list with the key only in the header, and keeps only slugs a session can take', async () => {
  const key = composioKey()
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, init })
    return answer(200, { items: [
      { slug: 'gmail', name: 'Gmail' }, { slug: 'GMAIL', name: 'Gmail again' }, { slug: 'google sheets', name: 'Bad' },
      { slug: 'googlesheets', name: '  ' }, { name: 'No slug' }, null,
    ] })
  }
  const found = await composioSearchApps(key, { api: 'https://composio.test/api/v3.1/', query: '  g mail ', fetch })
  assert.deepEqual(found, [{ slug: 'gmail', name: 'Gmail' }, { slug: 'googlesheets', name: 'googlesheets' }])
  const url = new URL(requests[0].url)
  assert.equal(url.origin + url.pathname, 'https://composio.test/api/v3.1/toolkits')
  assert.equal(url.searchParams.get('search'), 'g mail')
  assert.equal(url.searchParams.get('sort_by'), 'usage')
  assert.equal(url.searchParams.get('limit'), '20')
  assert.ok(!requests[0].url.includes(key))
  assert.equal(requests[0].init.headers['x-api-key'], key)
  assert.equal(requests[0].init.redirect, 'error')
  await composioSearchApps(key, { api: 'https://composio.test/api/v3.1', query: 'x'.repeat(200), fetch })
  assert.equal(new URL(requests[1].url).searchParams.get('search').length, 64)
  await composioSearchApps(key, { api: 'https://composio.test/api/v3.1', fetch })
  assert.equal(new URL(requests[2].url).searchParams.has('search'), false)
  await assert.rejects(composioSearchApps(key, { fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(composioSearchApps(key, { fetch: async () => answer(500, {}) }), /answered 500/)
  await assert.rejects(composioSearchApps(key, { fetch: async () => { throw new Error(`boom ${key}`) } }), /^Error: Could not reach Composio$/)
  assert.deepEqual(await composioSearchApps(key, { fetch: async () => answer(200, {}) }), [])
})

test('composioAppStatus reads the session\'s apps: ready when signed in or no sign-in is needed, needs sign-in otherwise', async () => {
  const key = composioKey()
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, init })
    return answer(200, { items: [
      { slug: 'gmail', is_no_auth: false, connected_account: { id: 'ca_1', status: 'ACTIVE' } },
      { slug: 'slack', is_no_auth: false, connected_account: { id: 'ca_2', status: 'INITIATED' } },
      { slug: 'hackernews', is_no_auth: true, connected_account: null },
      { slug: 'notion', is_no_auth: false, connected_account: null },
    ] })
  }
  const status = await composioAppStatus(key, { api: 'https://composio.test/api/v3.1', id: 'trs_1', apps: ['gmail', 'slack', 'hackernews', 'notion', 'linear'], fetch })
  assert.deepEqual(status, { gmail: 'ready', slack: 'sign-in', hackernews: 'ready', notion: 'sign-in', linear: 'sign-in' })
  const url = new URL(requests[0].url)
  assert.equal(url.origin + url.pathname, 'https://composio.test/api/v3.1/tool_router/session/trs_1/toolkits')
  assert.equal(url.searchParams.get('toolkits'), 'gmail,slack,hackernews,notion,linear')
  assert.equal(requests[0].init.headers['x-api-key'], key)
  assert.ok(!requests[0].url.includes(key))
  await assert.rejects(composioAppStatus(key, { id: '../x', apps: ['gmail'], fetch }), /Connect Composio first/)
  assert.equal(requests.length, 1)
  await assert.rejects(composioAppStatus(key, { id: 'trs_1', apps: ['gmail'], fetch: async () => answer(403, {}) }), /did not accept/)
})

test('the Connectors page searches apps with the pasted key before connecting (never saving it) and with the saved key after, and shows each app\'s status', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const sent = fakeComposio(numbered())
  const searches = []
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/toolkits') && path.includes('/tool_router/session/')) {
      searches.push({ url, key: init.headers['x-api-key'] })
      return answer(200, { items: [{ slug: 'gmail', connected_account: { status: 'ACTIVE' } }, { slug: 'notion', connected_account: null }] })
    }
    if (path.endsWith('/toolkits')) {
      searches.push({ url, key: init.headers['x-api-key'] })
      return answer(200, { items: [{ slug: 'notion', name: 'Notion' }] })
    }
    return sent.fetch(url, init)
  }
  const { ctx, home } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const key = composioKey()

  const keyless = await call(ctx, 'connector-app-search', { id: 'composio', query: 'not' })
  assert.equal(keyless.ok, false)
  assert.match(keyless.error.message, /Paste a key first/)
  const early = await call(ctx, 'connector-app-status', { id: 'composio' })
  assert.equal(early.ok, false)
  assert.match(early.error.message, /Connect Composio first/)

  const pasted = await call(ctx, 'connector-app-search', { id: 'composio', query: 'not', token: ` ${key} ` })
  assert.equal(pasted.ok, true, JSON.stringify(pasted))
  assert.deepEqual(pasted.value, [{ slug: 'notion', name: 'Notion' }])
  assert.equal(searches.at(-1).key, key)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [], 'a search never saves the key')

  await call(ctx, 'connector-connect', { id: 'composio', token: key, apps: ['gmail', 'notion'] })
  const after = await call(ctx, 'connector-app-search', { id: 'composio', query: 'not' })
  assert.equal(after.ok, true)
  assert.equal(searches.at(-1).key, key)
  const status = await call(ctx, 'connector-app-status', { id: 'composio' })
  assert.equal(status.ok, true, JSON.stringify(status))
  assert.deepEqual(status.value, { gmail: 'ready', notion: 'sign-in' })
  assert.match(searches.at(-1).url, /\/tool_router\/session\/trs_1\/toolkits\?/)
  assert.ok(!JSON.stringify(status).includes(key))

  const github = await call(ctx, 'connector-app-search', { id: 'github', query: 'x' })
  assert.equal(github.ok, false)
  assert.match(github.error.message, /no apps to pick/)
})

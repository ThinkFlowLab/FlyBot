// B4: Composio, custom MCP and per-call owner approvals in the user's own DS-Bot.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { compatHandler } from '../lib/b4/compat.js'
import { createConnectors, scrub } from '../features/connectors/connectors.js'
import { endpoint, publicIp, pinnedTransport } from '../features/connectors/mcp.js'
import { createCapabilityPublisher, handleRpc, startToolServer, syncCapability, CAPABILITY } from '../features/connectors/tool-server.js'

const KEY = 'ck_test_' + 'z'.repeat(20)
const identity = { instanceId: 'a'.repeat(32) }
const USER = 'flybot-workspace-' + 'a'.repeat(32)

function fakeComposio({ githubTools = ['GITHUB_LIST_REPOS'] } = {}) {
  const calls = []
  const accounts = new Map()
  const transport = async (method, url, headers, body) => {
    const u = new URL(url)
    calls.push({ method, path: u.pathname, key: headers['x-api-key'], query: u.search, body: body ? JSON.parse(body) : undefined })
    if (headers['x-api-key'] !== KEY) return [401, Buffer.from('{}')]
    const reply = value => [200, Buffer.from(JSON.stringify(value))]
    const p = u.pathname.replace('/api/v3.1', '')
    if (p === '/toolkits') return reply({ items: [{ slug: 'GitHub', name: 'GitHub', meta: { description: 'Code' }, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], logo: 'x' }], next_cursor: null })
    if (p === '/tool_router/session') return reply({ session_id: 'sess_1' })
    if (p === '/tool_router/session/sess_1/link') { accounts.set('ca_1', { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'github' }, user_id: USER }); return reply({ redirect_url: 'https://connect.composio.dev/link/1', connected_account_id: 'ca_1' }) }
    if (p === '/connected_accounts' && method === 'GET') return reply({ items: [...accounts.values()] })
    if (p.startsWith('/connected_accounts/') && method === 'GET') { const a = accounts.get(decodeURIComponent(p.split('/').pop())); return a ? reply(a) : [404, Buffer.from('{}')] }
    if (p.startsWith('/connected_accounts/') && method === 'DELETE') { accounts.delete(decodeURIComponent(p.split('/').pop())); return reply({}) }
    if (p === '/tools') {
      const toolkit = u.searchParams.get('toolkit_slug')
      const tools = toolkit === 'slack' ? ['SLACK_LIST_CHANNELS'] : githubTools
      return reply({ items: [
        ...tools.map(slug => ({ slug, version: '1.0', toolkit: { slug: toolkit }, description: 'Read-only action',
          annotations: { readOnlyHint: true }, input_parameters: { type: 'object', properties: {} } })),
        { slug: 'COMPOSIO_SEARCH', version: '1', toolkit: { slug: toolkit }, input_parameters: {} },
      ] })
    }
    if (p.startsWith('/tools/execute/')) return reply({ successful: true, data: { repos: ['a'], echo: KEY } })
    return [404, Buffer.from('{}')]
  }
  return { transport, calls, accounts }
}

function fakeMcp() {
  const seen = []
  const send = async (url, headers, body) => {
    const msg = JSON.parse(body)
    seen.push({ url, auth: headers.Authorization, method: msg.method })
    const reply = result => [200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))]
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26' })
    if (msg.method === 'notifications/initialized') return [202, {}, Buffer.alloc(0)]
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'search_docs', description: 'Search', inputSchema: { type: 'object' } }] })
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'found ' + msg.params.name }], token: headers.Authorization })
    return [404, {}, Buffer.alloc(0)]
  }
  return { send, seen }
}

function make(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-b4-conn-'))
  const composio = fakeComposio()
  const mcp = fakeMcp()
  let t = 1000
  const api = createConnectors({ dir, sealKey: randomBytes(32), identity, env: { FLYBOT_WORKSPACE_PUBLIC_ORIGIN: 'https://flybot-workspace.example' }, clock: () => t, transport: composio.transport, mcpTransport: mcp.send, sleep: async () => { t += 1 }, ...extra })
  return { api, composio, mcp, dir, v1: (method, path, body, query = '') => compatHandler(api.legacy)({ method, path, body, query }), tick: s => { t += s } }
}

test('composio key: sealed, masked, per-user, removal clears records', async () => {
  const { api, v1, composio } = make()
  assert.deepEqual((await v1('GET', '/v1/composio')).body.composio, { configured: false, key_hint: null, revision: 0 })
  assert.equal((await v1('GET', '/v1/composio/toolkits')).status, 409, 'no key → no call, no fallback key')
  assert.equal(composio.calls.length, 0)
  assert.equal((await v1('POST', '/v1/composio/key', { api_key: 'has space x' })).status, 400)
  const saved = await v1('POST', '/v1/composio/key', { api_key: KEY })
  assert.deepEqual(saved.body.composio, { configured: true, key_hint: '••••' + KEY.slice(-4), revision: 1 })
  assert.ok(!readFileSync(api.store.file, 'utf8').includes(KEY))
  const kits = await v1('GET', '/v1/composio/toolkits', undefined, 'search=git')
  assert.equal(kits.body.items[0].slug, 'github')
  assert.equal(kits.body.items[0].logo, undefined)
  assert.equal((await v1('GET', '/v1/composio/toolkits', undefined, 'evil=1')).status, 400)
  assert.equal((await v1('POST', '/v1/composio/key', { api_key: null })).body.composio.configured, false)
})

test('composio connect → sync → refresh → disconnect with the Flask contract', async () => {
  const { v1, composio } = make()
  await v1('POST', '/v1/composio/key', { api_key: KEY })
  const linked = await v1('POST', '/v1/composio/connections', { toolkit: 'github' })
  assert.equal(linked.status, 201)
  assert.equal(linked.body.redirect_url, 'https://connect.composio.dev/link/1')
  assert.equal(composio.calls.find(c => c.path.endsWith('/link')).body.callback_url, 'https://flybot-workspace.example/v1/composio/callback')
  assert.equal(composio.calls.find(c => c.path.endsWith('/session')).body.user_id, USER)
  const id = linked.body.connection.id
  const synced = await v1('GET', '/v1/composio/connections')
  assert.equal(synced.body.sync, 'ok')
  assert.equal(synced.body.items[0].state, 'connected')
  assert.equal((await v1('GET', `/v1/composio/connections/${id}`)).body.connection.status, 'ACTIVE')
  assert.equal((await v1('GET', `/v1/composio/connections/${'f'.repeat(32)}`)).status, 404)
  assert.deepEqual((await v1('POST', `/v1/composio/connections/${id}/disconnect`, {})).body, { disconnected: true, id })
  assert.equal((await v1('GET', '/v1/composio/connections')).body.items.length, 0)
  assert.equal((await v1('POST', '/v1/composio/connections', { toolkit: 'Bad Slug' })).status, 400)
})

test('connect refuses without a configured public origin (no guessed callback)', async () => {
  const { v1 } = make({ env: {} })
  await v1('POST', '/v1/composio/key', { api_key: KEY })
  assert.equal((await v1('POST', '/v1/composio/connections', { toolkit: 'github' })).status, 503)
})

test('an OAuth transition refreshes a nonempty native catalog immediately, with no key or vendor identifiers exposed', async () => {
  const { api, composio } = make()
  let changes = 0
  api.onChange(() => { changes += 1 })
  assert.deepEqual(await api.connectedToolkits(), [])
  assert.equal(api.hasTools(), false)
  assert.equal(composio.calls.length, 0)
  api.saveKey({api_key: KEY})
  assert.equal(api.hasTools(), false)
  composio.accounts.set('ca_github', {id:'ca_github', status:'ACTIVE', toolkit:{slug:'github'}, user_id:USER})
  composio.accounts.set('ca_slack', {id:'ca_slack', status:'INITIATED', toolkit:{slug:'slack'}, user_id:USER})
  const pending = await api.syncConnections()
  assert.equal(api.hasTools(), true)
  assert.deepEqual(await api.connectedToolkits(), [{slug:'github',tools:['GITHUB_LIST_REPOS']}])
  await api.syncConnections()
  assert.equal(changes, 2, 'an unchanged poll does not invalidate the catalog')

  composio.accounts.get('ca_slack').status = 'ACTIVE'
  const slack = pending.items.find(row => row.toolkit === 'slack')
  await api.refreshConnection(slack.id)
  assert.equal(changes, 3)
  assert.deepEqual(await api.connectedToolkits(), [
    {slug:'github',tools:['GITHUB_LIST_REPOS']}, {slug:'slack',tools:['SLACK_LIST_CHANNELS']},
  ])
  await api.disconnect(slack.id,{})
  assert.deepEqual(await api.connectedToolkits(), [{slug:'github',tools:['GITHUB_LIST_REPOS']}])
})

test('the native roster still reports an authorized app during an empty catalog and republishes when tools recover', async () => {
  const upstream = fakeComposio()
  let unavailable = true
  const { api, tick } = make({transport: (...args) => {
    if (unavailable && new URL(args[1]).pathname.endsWith('/tools')) return [503, Buffer.from('{}')]
    return upstream.transport(...args)
  }})
  let changes = 0
  api.onChange(() => { changes += 1 })
  api.saveKey({api_key: KEY})
  upstream.accounts.set('ca_1', {id:'ca_1', status:'ACTIVE', toolkit:{slug:'github'}, user_id:USER})
  await api.syncConnections()
  assert.deepEqual(await api.connectedToolkits(), [{slug:'github',tools:[]}])
  assert.equal(changes, 2)
  unavailable = false
  tick(11)
  assert.deepEqual(await api.connectedToolkits(), [{slug:'github',tools:['GITHUB_LIST_REPOS']}])
  assert.equal(changes, 3)
})

test('Composio connection failures preserve the gateway status and never expose vendor details', async () => {
  let upstreamStatus = 409
  const vendorDetail = 'vendor-only diagnostic ' + KEY
  const { api, v1 } = make({transport: async (_method, url, headers) => {
    assert.equal(headers['x-api-key'], KEY)
    if (new URL(url).pathname.endsWith('/session')) return [201, Buffer.from('{"session_id":"fixture"}')]
    return [upstreamStatus, Buffer.from(JSON.stringify({error: {message: vendorDetail}}))]
  }})
  await v1('POST', '/v1/composio/key', {api_key: KEY})
  for (const [status, code] of [
    [400, 'composio_failed'],
    [401, 'composio_key_rejected'],
    [409, 'composio_conflict'],
    [429, 'composio_rate_limited'],
    [500, 'composio_upstream'],
    [503, 'composio_upstream'],
  ]) {
    upstreamStatus = status
    const result = await v1('POST', '/v1/composio/connections', {toolkit: 'github'})
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, code)
    assert.ok(!JSON.stringify(result).includes(vendorDetail))
    assert.ok(!JSON.stringify(result).includes(KEY))
    assert.deepEqual(api.store.read().connections, [])
  }
})

test('custom MCP servers: public HTTPS only, bearer sealed, endpoint change needs token, quota', async () => {
  const { api, v1 } = make()
  for (const url of ['http://mcp.example/x', 'https://127.0.0.1/mcp', 'https://10.1.2.3/mcp', 'https://mcp.local/x', 'https://mcp.example:8443/x', 'https://u:p@mcp.example/x', 'https://mcp.example/x?q=1', 'https://[::1]/mcp']) {
    assert.equal((await v1('POST', '/v1/mcp/servers', { name: 'x', url })).status, 400, url)
  }
  const saved = await v1('POST', '/v1/mcp/servers', { name: ' Docs ', url: 'https://mcp.example/mcp', bearer_token: 'tok_secret_123' })
  assert.equal(saved.body.server.name, 'Docs')
  assert.equal(saved.body.server.origin, 'https://mcp.example')
  assert.ok(!readFileSync(api.store.file, 'utf8').includes('tok_secret_123'))
  const id = saved.body.server.id
  assert.equal((await v1('POST', '/v1/mcp/servers', { id, name: 'Docs', url: 'https://other.example/mcp' })).body.error.code, 'mcp_endpoint_changed')
  assert.equal((await v1('POST', '/v1/mcp/servers', { id, name: 'Docs2', url: 'https://mcp.example/mcp' })).body.server.revision, 2)
  for (let i = 0; i < 3; i += 1) await v1('POST', '/v1/mcp/servers', { name: 's' + i, url: 'https://mcp.example/mcp' })
  assert.equal((await v1('POST', '/v1/mcp/servers', { name: 'fifth', url: 'https://mcp.example/mcp' })).status, 429)
  assert.equal((await v1('GET', '/v1/mcp/servers')).body.items.length, 4)
  assert.deepEqual((await v1('DELETE', `/v1/mcp/servers/${id}`)).body, { removed: true })
  assert.equal((await v1('DELETE', `/v1/mcp/servers/${id}`)).status, 404)
})

test('manual tool calls wait for the owner, run once, and scrub credentials', async () => {
  const { api, v1, composio, mcp } = make()
  await v1('POST', '/v1/composio/key', { api_key: KEY })
  await v1('POST', '/v1/composio/connections', { toolkit: 'github' })
  await v1('GET', '/v1/composio/connections')
  await v1('POST', '/v1/mcp/servers', { name: 'Docs', url: 'https://mcp.example/mcp', bearer_token: 'tok_secret_123' })
  const tools = await api.discover({ force: true })
  const names = tools.map(t => t.name)
  assert.ok(names.includes('GITHUB_LIST_REPOS'))
  assert.ok(!names.includes('COMPOSIO_SEARCH'))
  const mcpName = names.find(n => n.startsWith('OTMCP_'))
  assert.ok(mcpName)
  assert.ok(!JSON.stringify(tools).includes('tok_secret_123'))

  const waiting = await api.callTool('GITHUB_LIST_REPOS', { per_page: 1 }, { waitMs: 0 })
  assert.equal(waiting.error, 'tool_pending')
  assert.equal(composio.calls.filter(c => c.path.includes('/tools/execute/')).length, 0, 'nothing executes before approval')
  const listing = await v1('GET', '/v1/composio/approvals')
  const item = listing.body.items[0]
  assert.deepEqual([item.status, item.arguments, item.account.toolkit], ['pending', { per_page: 1 }, 'github'])
  assert.equal((await v1('POST', `/v1/composio/approvals/${item.id}`, { decision: 'maybe' })).status, 400)
  assert.equal((await v1('POST', `/v1/composio/approvals/${item.id}`, { decision: 'approve' })).body.call.status, 'approved')
  const result = await api.callTool('GITHUB_LIST_REPOS', { per_page: 1 }, { waitMs: 0 })
  assert.deepEqual(result.data.repos, ['a'])
  assert.equal(result.data.echo, '[redacted]', 'our key never comes back to the agent')
  assert.equal(composio.calls.filter(c => c.path.includes('/tools/execute/')).length, 1)
  assert.equal(composio.calls.find(c => c.path.includes('/tools/execute/')).body.user_id, USER)
  assert.equal((await v1('POST', `/v1/composio/approvals/${item.id}`, { decision: 'approve' })).status, 409, 'one-shot')

  const denied = await api.callTool(mcpName, { q: 'x' }, { waitMs: 0 })
  const mcpItem = (await v1('GET', '/v1/composio/approvals')).body.items.find(i => i.id === denied.approval_id)
  assert.equal(mcpItem.account.toolkit, 'MCP: Docs')
  await v1('POST', `/v1/composio/approvals/${mcpItem.id}`, { decision: 'deny' })
  assert.equal((await api.callTool(mcpName, { q: 'x' }, { waitMs: 0 })).error, 'tool_pending', 'a denied call never runs; a new proposal is needed')
  assert.equal(mcp.seen.filter(s => s.method === 'tools/call').length, 0)
  const next = (await v1('GET', '/v1/composio/approvals')).body.items.find(i => i.status === 'pending')
  await v1('POST', `/v1/composio/approvals/${next.id}`, { decision: 'approve' })
  const ran = await api.callTool(mcpName, { q: 'x' }, { waitMs: 0 })
  assert.equal(ran.content[0].text, 'found search_docs')
  assert.equal(mcp.seen.find(s => s.method === 'tools/call').auth, 'Bearer tok_secret_123')
  assert.equal(ran.token, 'Bearer [redacted]')
  assert.ok(!JSON.stringify(ran).includes('tok_secret_123'))
})

test('approvals expire, and a key change blocks an approved call', async () => {
  const { api, v1, tick, composio } = make()
  await v1('POST', '/v1/composio/key', { api_key: KEY })
  await v1('POST', '/v1/composio/connections', { toolkit: 'github' })
  await v1('GET', '/v1/composio/connections')
  await api.discover({ force: true })
  const first = await api.callTool('GITHUB_LIST_REPOS', {}, { waitMs: 0 })
  tick(301)
  assert.equal((await v1('POST', `/v1/composio/approvals/${first.approval_id}`, { decision: 'approve' })).status, 409)
  const second = await api.callTool('GITHUB_LIST_REPOS', {}, { waitMs: 0 })
  await v1('POST', `/v1/composio/approvals/${second.approval_id}`, { decision: 'approve' })
  await v1('POST', '/v1/composio/key', { api_key: KEY })
  assert.equal((await api.run(second.approval_id)).result.error, 'connection_changed')
  assert.equal(composio.calls.filter(c => c.path.includes('/tools/execute/')).length, 0)
})

test('concurrent callers consume an approved receipt once while the provider call is in flight', async () => {
  const upstream = fakeComposio()
  const checkedApproval = Promise.withResolvers()
  const allowApprovalPoll = Promise.withResolvers()
  const providerStarted = Promise.withResolvers()
  const releaseProvider = Promise.withResolvers()
  let executes = 0
  const { api } = make({
    async transport(...args) {
      if (new URL(args[1]).pathname.includes('/tools/execute/')) {
        executes += 1
        providerStarted.resolve()
        await releaseProvider.promise
      }
      return upstream.transport(...args)
    },
    async sleep() {
      checkedApproval.resolve()
      await allowApprovalPoll.promise
    },
  })
  api.saveKey({api_key: KEY})
  upstream.accounts.set('ca_1', {id:'ca_1', status:'ACTIVE', toolkit:{slug:'github'}, user_id:USER})
  await api.syncConnections()
  const first = api.callTool('GITHUB_LIST_REPOS', {})
  await checkedApproval.promise
  const approval = api.approvals().items[0]
  api.decide(approval.id,{decision:'approve'})
  allowApprovalPoll.resolve()
  await providerStarted.promise

  const concurrent = api.run(approval.id)
  releaseProvider.resolve()
  const [result, second] = await Promise.all([first,concurrent])
  assert.equal(result.successful, true)
  assert.equal(second.status,'executing')
  assert.equal(executes,1)
  assert.equal((await api.run(approval.id)).status,'succeeded')
  assert.equal(executes,1)
})

test('the pending approval view returns only a boolean without writing expired state', async () => {
  const { api, composio, tick, v1 } = make()
  const path = '/v1/composio/approvals'
  const pending = async () => (await v1('GET',path,undefined,'view=pending')).body
  assert.deepEqual(await pending(),{pending:false})
  assert.equal((await v1('GET',path,undefined,'view=pending&extra=true')).status,400)
  api.saveKey({api_key: KEY})
  composio.accounts.set('ca_1', {id:'ca_1', status:'ACTIVE', toolkit:{slug:'github'}, user_id:USER})
  await api.syncConnections()
  await api.discover()
  api.propose('GITHUB_LIST_REPOS',{organization:'private-fixture'})
  const saved = readFileSync(api.store.file,'utf8')
  assert.deepEqual(await pending(),{pending:true})
  tick(301)
  assert.deepEqual(await pending(),{pending:false})
  assert.equal(readFileSync(api.store.file,'utf8'), saved)
  assert.equal((await v1('GET',path)).body.items[0].status,'expired')
})

test('verified GitHub reads run automatically only for a trusted private call', async () => {
  const read = 'GITHUB_CHECK_IF_PULL_REQUEST_MERGED'
  const alias = 'GITHUB_CHECK_IF_PULL_REQUEST_HAS_BEEN_MERGED'
  const history = 'GITHUB_LIST_REPOS'
  const write = 'GITHUB_CREATE_AN_ISSUE'
  const unknown = 'GITHUB_GET_UNVERIFIED_ACTION'
  const upstream = fakeComposio({githubTools:[read,alias,history,write,unknown]})
  const { api } = make({transport:upstream.transport})
  api.saveKey({api_key: KEY})
  await api.connect({toolkit:'github'})
  await api.syncConnections()
  const args = {owner:'fixture',repo:'example',pull_number:5}

  const shared = await api.callTool(read,args,{waitMs:0})
  assert.equal(shared.error,'tool_pending')
  const privateReceipt = api.propose(read,args,{automaticReads:true})
  assert.notEqual(privateReceipt.id,shared.approval_id)
  assert.equal(await api.run(privateReceipt.id),null)
  assert.equal(upstream.calls.filter(call => call.path.includes('/tools/execute/')).length,0)

  for (const name of [read,alias,history]) {
    const result = await api.callTool(name,args,{automaticReads:true,waitMs:0})
    assert.equal(result.successful,true)
    assert.notEqual(result.data.echo,KEY)
  }
  for (const name of [write,unknown]) {
    assert.equal((await api.callTool(name,args,{automaticReads:true,waitMs:0})).error,'tool_pending')
  }
  api.saveServer({name:'Remote',url:'https://mcp.example/mcp'})
  const mcpTool = (await api.discover()).find(tool=>tool.description.startsWith('Remote:'))
  assert.equal((await api.callTool(mcpTool.name,{}, {automaticReads:true,waitMs:0})).error,'tool_pending')
  assert.deepEqual(upstream.calls.filter(call => call.path.includes('/tools/execute/'))
    .map(call=>[call.path.split('/').at(-1),call.body.connected_account_id,call.body.user_id]),
    [read,alias,history].map(name=>[name,'ca_1',USER]))
  const items = api.approvals().items
  assert.equal(items.find(row=>row.id===shared.approval_id).status,'pending')
  assert.ok(items.slice(0,4).every(row=>row.status==='pending'))
  assert.deepEqual(items.filter(row=>row.approval_mode==='automatic_read').map(row=>row.status),
    ['succeeded','succeeded','succeeded'])
})

test('a burst of automatic read history preserves a write still waiting for approval', async () => {
  const read = 'GITHUB_LIST_REPOS'
  const write = 'GITHUB_CREATE_AN_ISSUE'
  const upstream = fakeComposio({githubTools:[read,write]})
  const { api, tick } = make({transport:upstream.transport})
  api.saveKey({api_key:KEY})
  await api.connect({toolkit:'github'})
  await api.syncConnections()
  const pending = await api.callTool(write,{title:'Fixture'},{automaticReads:true,waitMs:0})
  assert.equal(pending.error,'tool_pending')
  for (let i = 0; i < 105; i += 1) {
    tick(1)
    assert.equal((await api.callTool(read,{page:i+1},{automaticReads:true,waitMs:0})).successful,true)
  }
  assert.equal(api.approvals().items[0].id,pending.approval_id)
  assert.equal(api.approvals().items[0].status,'pending')
  assert.equal(api.store.read().calls.length,100)
})

test('MCP endpoint and IP policy', () => {
  for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(publicIp(ip), true, ip)
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:8.8.8.8', '2001:db8::1', '2002::1', '64:ff9b::808:808']) assert.equal(publicIp(ip), false, ip)
  assert.deepEqual(endpoint('https://mcp.example/a/b'), { host: 'mcp.example', path: '/a/b' })
})

test('pinned transport refuses names resolving to private addresses', async () => {
  const send = pinnedTransport({ resolve: async () => [{ address: '10.0.0.7', family: 4 }], request: () => { throw new Error('must not connect') } })
  await assert.rejects(send('https://mcp.example/mcp', {}, '{}'), err => err.code === 'mcp_network')
})

test('tool server: loopback MCP over HTTP, token path, Origin refused', async () => {
  const fake = { discover: async () => [{ name: 'T_ONE', description: 'd', inputSchema: { type: 'object' } }], callTool: async (name, args) => ({ ok: name, args }) }
  const srv = startToolServer(fake)
  const url = await srv.ready
  try {
    const rpc = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    assert.equal(list.result.tools[0].name, 'T_ONE')
    const called = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'T_ONE', arguments: { a: 1 } } })).json()
    assert.deepEqual(JSON.parse(called.result.content[0].text), { ok: 'T_ONE', args: { a: 1 } })
    assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(new URL('/mcp/wrong', url), { method: 'POST', body: '{}' })).status, 404)
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  } finally { await srv.close() }
  assert.equal((await handleRpc(fake, { jsonrpc: '2.0', id: 9, method: 'nope' })).error.code, -32601)
})

test('capability sync attaches ot-apps to the Main Bot and detaches without tools', async () => {
  const caps = []
  const bot = { capabilities: [] }
  const rt = {
    botOf: () => bot,
    capabilitySave: async (cap) => { caps.push(cap) },
    changeCapabilityAttachment: async (op, { name }) => { if (op === 'attach') bot.capabilities.push(name); else bot.capabilities = bot.capabilities.filter(n => n !== name) },
  }
  const runtime = { rt, mainBot: async () => 'bot1' }
  assert.equal(await syncCapability(runtime, 'http://127.0.0.1:1/mcp/t', 3, true), true)
  assert.deepEqual([caps[0].name, caps[0].kind, caps[0].url], [CAPABILITY, 'mcp', 'http://127.0.0.1:1/mcp/t?v=3'])
  assert.deepEqual(bot.capabilities, [CAPABILITY])
  assert.equal(await syncCapability(runtime, 'http://127.0.0.1:1/mcp/t', 4, false), false)
  assert.deepEqual(bot.capabilities, [])
})

test('native apps share a single pending publication and await the latest connection revision', async () => {
  const started = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  const seen = []
  const runtime = {rt:{},mainBot:async () => 'chief'}
  let wanted = false
  const publisher = createCapabilityPublisher({ runtime: () => runtime, ready: Promise.resolve('http://loopback'),
    wanted: () => wanted,
    async publish(_runtime, _url, version, value) {
      seen.push([version, value])
      if (version === 0) { started.resolve(); await proceed.promise }
      return value
    },
  })
  const first = publisher.sync()
  await started.promise
  assert.equal(publisher.sync(), first)
  wanted = true
  publisher.invalidate()
  proceed.resolve()
  assert.equal(await first, true)
  assert.equal(await publisher.sync(), true)
  assert.deepEqual(seen, [[0,false],[1,true]])
})

test('scrub removes credential fields and known secrets', () => {
  assert.deepEqual(scrub({ access_token: 'x', nested: ['has KEY123 inside'] }, ['KEY123']), { access_token: '[redacted]', nested: ['has [redacted] inside'] })
})

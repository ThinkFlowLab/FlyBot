// B4 connectors in the user's own DS-Bot: the user's own Composio key and
// connections, user-configured remote MCP servers, and the one-shot owner
// approval for every tool call. Port of composio.py, connected_tools.py,
// composio_principals (personal scope) and custom_mcp.py. Keys and bearer
// tokens are sealed at rest; nothing here falls back to another key.
import { createHash, randomUUID } from 'node:crypto'
import { fail, Fault, isObject, bodyOf, nowSeconds } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { seal, unseal } from '../../lib/b4/seal.js'
import * as composio from './composio.js'
import { endpoint, McpClient, MAX_SERVERS, PREFIX, pinnedTransport } from './mcp.js'

const NAME = /^[A-Z][A-Z0-9_]{1,127}$/
const LOCAL_ID = /^[0-9a-f]{32}$/
const MAX_ARGS = 12000
const MAX_RESULT = 10000
const MAX_CALLS_KEPT = 100
const APPROVAL_TTL = 300
const newId = () => randomUUID().replaceAll('-', '')
const KEY_PURPOSE = 'flybot-workspace.composio.key'
const mcpPurpose = id => `flybot-workspace.mcp.${id}`

export function scrub(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets))
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [String(k),
      ['api_key', 'access_token', 'refresh_token', 'authorization', 'password', 'client_secret'].includes(String(k).toLowerCase()) ? '[redacted]' : scrub(v, secrets)]))
  }
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value)
  return value
}

const connectionView = row => ({
  id: row.id, toolkit: row.toolkit,
  catalog_id: Object.entries(composio.CATALOG).find(([, [slug]]) => slug === row.toolkit)?.[0] ?? null,
  status: row.status, state: composio.uiState(row.status), status_reason: row.status_reason ?? null,
  created_at: row.created, updated_at: row.updated,
})
const keyView = row => (row ? { configured: true, key_hint: row.key_hint, revision: row.revision } : { configured: false, key_hint: null, revision: 0 })
const serverView = row => ({ id: row.id, name: row.name, origin: row.origin, revision: row.revision, created: row.created, updated: row.updated })
const callView = (row, withArgs = false) => {
  const view = { id: row.id, task_id: null, name: row.name, status: row.status, created: row.created, expires: row.expires }
  if (withArgs) view.arguments = JSON.parse(row.arguments)
  if (row.result != null) view.result = row.result
  return view
}

export function createConnectors({ dir, sealKey, identity, env = process.env, clock = nowSeconds, transport = composio.fetchTransport, mcpTransport = pinnedTransport(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const store = openJsonStore(dir, 'connectors', () => ({ composio: null, connections: [], mcp_servers: [], calls: [] }))
  const state = () => store.read()
  let changed = () => {}
  const onChange = (fn) => { changed = fn }
  const userRef = () => state().composio_user ?? composio.composioUserId(identity.instanceId)
  const callbackUrl = () => {
    const origin = String(env.FLYBOT_WORKSPACE_PUBLIC_ORIGIN || '').replace(/\/+$/, '')
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) fail(503, 'composio_callback', 'The public site origin is not configured for this runtime')
    return origin + '/v1/composio/callback'
  }

  function secretKey() {
    const row = state().composio
    if (!row) return null
    try { return unseal(sealKey, KEY_PURPOSE, row.key_sealed) } catch { return null }
  }
  function client() {
    const key = secretKey()
    if (!key) fail(409, 'composio_not_configured', 'Add your own Composio API key first')
    return new composio.Client(key, transport)
  }
  const composioFault = (error) => {
    if (error instanceof composio.ComposioError) fail(502, error.code, error.message)
    throw error
  }

  // ---- settings: key, toolkits, connections ----
  const overview = () => ({ composio: keyView(state().composio), catalog: composio.catalogView() })
  function saveKey(raw) {
    const body = bodyOf(raw, ['api_key'])
    if (!('api_key' in body)) fail(400, 'invalid', 'api_key is required (null removes it)')
    const apiKey = body.api_key
    if (apiKey !== null && !composio.validApiKey(apiKey)) fail(400, 'invalid', 'Use an 8-512 character Composio API key without spaces')
    const view = store.update((draft) => {
      // Records belong to the old Composio project; its accounts are not deleted.
      draft.connections = []
      if (apiKey === null) { draft.composio = null; return keyView(null) }
      draft.composio = { key_sealed: seal(sealKey, KEY_PURPOSE, apiKey), key_hint: composio.hint(apiKey), revision: (draft.composio?.revision ?? 0) + 1, updated: clock() }
      return keyView(draft.composio)
    })
    changed()
    return { composio: view }
  }
  async function toolkits(query) {
    const params = new URLSearchParams(query)
    const picked = {}
    for (const [k, v] of params) {
      if (!['search', 'cursor'].includes(k) || k in picked || v.length > 200 || !v) fail(400, 'invalid', 'Invalid toolkit query')
      picked[k] = v
    }
    try {
      const page = await client().listToolkits(picked.search, picked.cursor)
      const items = Array.isArray(page.items) ? page.items : []
      return { items: items.slice(0, 100).map(composio.toolkitView).filter(Boolean), next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null }
    } catch (error) { return composioFault(error) }
  }
  async function syncConnections() {
    const c = client()
    let sync = 'ok', items = []
    try {
      const page = await c.listAccounts(userRef())
      items = Array.isArray(page.items) ? page.items : []
    } catch (error) {
      if (error?.code === 'composio_key_rejected') return composioFault(error)
      sync = 'failed'
    }
    const now = clock()
    const result = store.update((draft) => {
      if (sync === 'ok') {
        const seen = new Set()
        for (const item of items.slice(0, composio.MAX_CONNECTIONS)) {
          const account = item?.id
          const toolkit = typeof item?.toolkit?.slug === 'string' ? item.toolkit.slug.toLowerCase() : null
          if (typeof account !== 'string' || !composio.ACCOUNT.test(account) || !toolkit || !composio.TOOLKIT.test(toolkit)) continue
          seen.add(account)
          const status = composio.normalStatus(item.status)
          const reason = composio.reasonText(item.status_reason)
          const existing = draft.connections.find(row => row.account_id === account)
          if (existing) Object.assign(existing, { status, status_reason: reason, updated: now })
          else if (draft.connections.length < composio.MAX_CONNECTIONS) draft.connections.push({ id: newId(), toolkit, account_id: account, status, status_reason: reason, created: now, updated: now })
        }
        for (const row of draft.connections) {
          if (!seen.has(row.account_id) && !composio.PENDING.includes(row.status)) Object.assign(row, { status: 'DELETED', status_reason: 'Not found in Composio', updated: now })
        }
      }
      return { items: [...draft.connections].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)).map(connectionView), sync }
    })
    changed()
    return result
  }
  async function connect(raw) {
    const { toolkit } = bodyOf(raw, ['toolkit'])
    if (typeof toolkit !== 'string' || !composio.TOOLKIT.test(toolkit)) fail(400, 'invalid', 'Use a Composio toolkit slug')
    if (state().connections.length >= composio.MAX_CONNECTIONS) fail(429, 'quota', 'Connection record limit reached; disconnect one first')
    const callback = callbackUrl()
    let link
    try { link = await client().createLink(userRef(), toolkit, callback) } catch (error) { return composioFault(error) }
    const now = clock()
    const row = store.update((draft) => {
      draft.connections = draft.connections.filter(item => item.account_id !== link.account_id)
      const fresh = { id: newId(), toolkit, account_id: link.account_id, status: 'INITIATED', status_reason: null, created: now, updated: now }
      draft.connections.push(fresh)
      return fresh
    })
    return [201, { connection: connectionView(row), redirect_url: link.redirect_url }]
  }
  const ownConnection = (id) => {
    const row = state().connections.find(item => item.id === id)
    if (!row) fail(404, 'not_found', 'Connection not found')
    return row
  }
  async function disconnect(id, raw) {
    bodyOf(raw, [])
    const row = ownConnection(id)
    try { await client().deleteAccount(row.account_id) } catch (error) { if (error?.code !== 'composio_not_found') composioFault(error) }
    store.update((draft) => { draft.connections = draft.connections.filter(item => item.id !== row.id) })
    changed()
    return { disconnected: true, id: row.id }
  }
  async function refreshConnection(id) {
    const row = ownConnection(id)
    let status, reason
    try {
      const account = await client().getAccount(row.account_id)
      status = composio.normalStatus(account.status)
      reason = composio.reasonText(account.status_reason)
    } catch (error) {
      if (error?.code !== 'composio_not_found') composioFault(error)
      status = 'DELETED'; reason = 'Not found in Composio'
    }
    const updated = store.update((draft) => {
      const item = draft.connections.find(c => c.id === row.id)
      if (item) Object.assign(item, { status, status_reason: reason, updated: clock() })
      return item ?? row
    })
    changed()
    return { connection: connectionView(updated) }
  }

  // ---- custom MCP servers ----
  const listServers = () => ({ items: [...state().mcp_servers].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)).map(serverView) })
  const serverConfig = row => JSON.parse(unseal(sealKey, mcpPurpose(row.id), row.config_sealed))
  function saveServer(raw) {
    const body = bodyOf(raw, ['id', 'name', 'url', 'bearer_token'])
    const sid = body.id || newId()
    if (typeof sid !== 'string' || !LOCAL_ID.test(sid)) fail(400, 'invalid', 'Invalid MCP server id')
    const old = state().mcp_servers.find(row => row.id === sid)
    if (body.id && !old) fail(404, 'not_found', 'MCP server not found')
    if (!old && state().mcp_servers.length >= MAX_SERVERS) fail(429, 'quota', 'At most four custom MCP servers per user')
    const { name, url } = body
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 60 || /[\x00-\x1f]/.test(name)) fail(400, 'invalid', 'Use a 1-60 character server name')
    const { host } = endpoint(url)
    const previous = old ? serverConfig(old) : {}
    const token = 'bearer_token' in body ? body.bearer_token : (previous.bearer_token ?? '')
    if (typeof token !== 'string' || token.length > 4096 || /[^\x21-\x7e]/.test(token)) fail(400, 'invalid', 'Invalid MCP bearer token')
    // Never silently forward a stored credential to a changed endpoint.
    if (old && url !== previous.url && !('bearer_token' in body)) fail(400, 'mcp_endpoint_changed', 'Supply or clear the bearer token when changing endpoint')
    const now = clock()
    const row = store.update((draft) => {
      const next = { id: sid, name: name.trim(), origin: 'https://' + host, config_sealed: seal(sealKey, mcpPurpose(sid), JSON.stringify({ url, bearer_token: token })), revision: old ? old.revision + 1 : 1, created: old ? old.created : now, updated: now }
      draft.mcp_servers = [...draft.mcp_servers.filter(item => item.id !== sid), next]
      return next
    })
    changed()
    return { server: serverView(row) }
  }
  function removeServer(id, raw) {
    if (raw !== undefined && raw !== null) bodyOf(raw, [])
    const found = state().mcp_servers.some(row => row.id === id)
    if (!found) fail(404, 'not_found', 'MCP server not found')
    store.update((draft) => { draft.mcp_servers = draft.mcp_servers.filter(row => row.id !== id) })
    changed()
    return { removed: true }
  }

  // ---- tool catalog, proposals, approvals and execution ----
  // catalog: name -> { kind, ref, remote, version, revision }. A call is bound
  // to the exact key/server revision it was discovered with.
  let catalog = new Map()
  let catalogAt = 0
  async function discover({ search, force = false } = {}) {
    if (!force && !search && clock() - catalogAt < 60 && catalog.size) return [...catalog.values()].map(entry => entry.schema)
    const next = new Map()
    const st = state()
    const key = secretKey()
    if (key && st.composio) {
      const c = new composio.Client(key, transport)
      const active = st.connections.filter(row => row.status === 'ACTIVE').sort((a, b) => a.created - b.created).slice(0, 4)
      for (const row of active) {
        try {
          const account = await c.getAccount(row.account_id)
          if (account.status !== 'ACTIVE' || ![undefined, null, '', userRef()].includes(account.user_id)) continue
          const page = await c.tools(row.toolkit, search)
          for (const item of (Array.isArray(page.items) ? page.items : []).slice(0, 20)) {
            const name = item?.slug, params = item?.input_parameters, version = item?.version
            if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('COMPOSIO_') || name.startsWith(PREFIX)) continue
            if (!isObject(item.toolkit) || String(item.toolkit.slug ?? '').toLowerCase() !== row.toolkit || !isObject(params) || typeof version !== 'string' || !version || version.length > 100 || item.is_deprecated) continue
            const schema = scrub({ name, description: String(item.description ?? '').slice(0, 1000), inputSchema: params }, [key])
            if (JSON.stringify(schema).length > 16000 || next.has(name)) continue
            next.set(name, { kind: 'composio', ref: row.id, version, revision: st.composio.revision, schema })
          }
        } catch { /* one failing account must not hide the others */ }
      }
    }
    for (const row of [...st.mcp_servers].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_SERVERS)) {
      try {
        const config = serverConfig(row)
        const mcp = await new McpClient(config, mcpTransport).initialize()
        const tools = (await mcp.rpc('tools/list')).tools
        if (!Array.isArray(tools)) continue
        for (const t of tools.slice(0, 20)) {
          if (!isObject(t) || typeof t.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(t.name) || !isObject(t.inputSchema)) continue
          const name = PREFIX + createHash('sha256').update(row.id + ':' + t.name).digest('hex').slice(0, 24).toUpperCase()
          const schema = scrub({ name, description: (row.name + ': ' + String(t.description ?? t.name)).slice(0, 1000), inputSchema: t.inputSchema }, [config.bearer_token])
          if (JSON.stringify(schema).length > 16000 || (search && !JSON.stringify(schema).toLowerCase().includes(search.toLowerCase()))) continue
          next.set(name, { kind: 'mcp', ref: row.id, version: t.name, revision: row.revision, schema })
        }
      } catch { /* unreachable server: its tools are simply absent */ }
    }
    catalog = next
    catalogAt = clock()
    return [...catalog.values()].map(entry => entry.schema)
  }

  const live = (row, now) => (row.status === 'pending' || row.status === 'approved') && row.expires > now
  function expireCalls(draft, now) {
    for (const row of draft.calls) if ((row.status === 'pending' || row.status === 'approved') && row.expires <= now) row.status = 'expired'
    if (draft.calls.length > MAX_CALLS_KEPT) draft.calls = draft.calls.slice(-MAX_CALLS_KEPT)
  }
  function propose(name, args) {
    const entry = catalog.get(name)
    if (!entry) fail(403, 'tool_not_discovered', 'Tool is not connected for this account')
    if (!isObject(args)) fail(400, 'invalid', 'arguments must be an object')
    const argumentsText = JSON.stringify(sortKeys(args))
    if (Buffer.byteLength(argumentsText) > MAX_ARGS) fail(413, 'invalid', 'Tool arguments exceed bound')
    const now = clock()
    return store.update((draft) => {
      expireCalls(draft, now)
      // The same tool with the same arguments reuses its open proposal, so the
      // agent can call again after the owner approved without a second prompt.
      const open = draft.calls.find(row => row.name === name && row.arguments === argumentsText && live(row, now))
      if (open) return open
      const row = { id: newId(), name, kind: entry.kind, ref: entry.ref, version: entry.version, revision: entry.revision, arguments: argumentsText, status: 'pending', result: null, created: now, expires: now + APPROVAL_TTL }
      draft.calls.push(row)
      return row
    })
  }
  function decide(id, raw) {
    const { decision } = bodyOf(raw, ['decision'])
    if (decision !== 'approve' && decision !== 'deny') fail(400, 'invalid', 'Choose approve or deny')
    const now = clock()
    return { call: store.update((draft) => {
      expireCalls(draft, now)
      const row = draft.calls.find(item => item.id === id)
      if (!row) fail(404, 'not_found', 'Tool approval not found')
      if (row.status !== 'pending' || row.expires <= now) fail(409, 'expired', 'Approval is no longer pending')
      row.status = decision === 'approve' ? 'approved' : 'denied'
      return callView(row)
    }) }
  }
  function approvals() {
    const now = clock()
    const st = store.update((draft) => { expireCalls(draft, now); return draft })
    const key = secretKey()
    const items = [...st.calls].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)).slice(0, 30).map((row) => {
      const view = callView(row, true)
      if (row.kind === 'composio') {
        const account = st.connections.find(c => c.id === row.ref)
        view.account = account ? { toolkit: account.toolkit, account_id: account.account_id } : null
      } else {
        const server = st.mcp_servers.find(s => s.id === row.ref)
        view.account = server ? { toolkit: 'MCP: ' + server.name, account_id: server.origin } : null
      }
      view.prompt = ''
      return scrub(view, [key])
    })
    return { items }
  }
  async function run(id) {
    // Consume the approval before any network I/O; 'executing' is terminal.
    const row = store.update((draft) => {
      const item = draft.calls.find(c => c.id === id)
      if (!item || item.status !== 'approved' || item.expires <= clock()) return item ? { ...item } : null
      item.status = 'executing'
      return { ...item }
    })
    if (!row || row.status !== 'executing') return row
    let status = 'unknown', result = { error: 'tool_execution_failed_no_retry', note: 'Not retried; check provider state before another call.' }
    try {
      const st = state()
      if (row.kind === 'composio') {
        const account = st.connections.find(c => c.id === row.ref && c.status === 'ACTIVE')
        const key = secretKey()
        if (!account || !key || st.composio?.revision !== row.revision) throw new Fault(409, 'connection_changed', 'Connection or key changed; call blocked')
        const c = new composio.Client(key, transport)
        const remote = await c.getAccount(account.account_id)
        if (remote.status !== 'ACTIVE' || ![undefined, null, '', userRef()].includes(remote.user_id)) {
          status = 'failed'; result = { error: 'connection_not_active' }
        } else {
          const output = await c.execute(row.name, account.account_id, userRef(), row.version, JSON.parse(row.arguments))
          const safe = scrub(output, [key])
          result = JSON.stringify(safe).length <= MAX_RESULT ? safe : { error: 'tool_output_too_large' }
          status = output.successful === true && !result.error ? 'succeeded' : 'failed'
        }
      } else {
        const server = st.mcp_servers.find(s => s.id === row.ref)
        if (!server || server.revision !== row.revision) throw new Fault(409, 'connection_changed', 'MCP connection changed; call blocked')
        const config = serverConfig(server)
        const mcp = await new McpClient(config, mcpTransport).initialize()
        let output = scrub(await mcp.rpc('tools/call', { name: row.version, arguments: JSON.parse(row.arguments) }), [config.bearer_token])
        if (JSON.stringify(output).length > MAX_RESULT) output = { error: 'mcp_output_too_large' }
        result = output
        status = output.isError || output.error ? 'failed' : 'succeeded'
      }
    } catch (error) {
      result = { error: error?.code ?? 'tool_execution_failed_no_retry', note: 'Not retried; check provider state before another call.' }
      status = error instanceof Fault ? 'failed' : 'unknown'
    }
    return store.update((draft) => {
      const item = draft.calls.find(c => c.id === id)
      if (item) Object.assign(item, { status, result })
      return item ? { ...item } : null
    })
  }
  // One agent tool call: propose, wait (bounded) for the owner's decision, run once.
  async function callTool(name, args, { waitMs = 40_000, pollMs = 500 } = {}) {
    if (!catalog.has(name)) await discover({ force: true })
    let row = propose(name, args)
    const deadline = Date.now() + waitMs
    while (row && row.status === 'pending' && Date.now() < deadline) {
      await sleep(pollMs)
      row = state().calls.find(c => c.id === row.id)
    }
    if (row?.status === 'approved') row = await run(row.id)
    if (!row) return { error: 'tool_unavailable' }
    if (row.status === 'pending') return { error: 'tool_pending', approval_id: row.id, note: 'Waiting for the owner to approve in Settings > App connectors; call again with the same arguments after approval. No implicit retry.' }
    return row.result ?? { error: 'tool_' + row.status, note: 'Await owner approval in Settings > App connectors; no implicit retry.' }
  }

  const noQuery = (query) => { if (query) fail(400, 'invalid', 'Queries are not supported') }
  const wrap = fn => async (...args) => { try { return await fn(...args) } catch (error) { return composioFault(error) } }
  const legacy = [
    { method: 'GET', path: /\/v1\/composio/, handle: async ({ query }) => { noQuery(query); return [200, overview()] } },
    { method: 'POST', path: /\/v1\/composio\/key/, handle: async ({ body }) => [200, saveKey(body)] },
    { method: 'GET', path: /\/v1\/composio\/toolkits/, handle: async ({ query }) => [200, await toolkits(query)] },
    { method: 'GET', path: /\/v1\/composio\/connections/, handle: async ({ query }) => { noQuery(query); return [200, await wrap(syncConnections)()] } },
    { method: 'POST', path: /\/v1\/composio\/connections/, handle: async ({ body }) => connect(body) },
    { method: 'GET', path: /\/v1\/composio\/connections\/([0-9a-f]{32})/, handle: async ({ match, query }) => { noQuery(query); return [200, await refreshConnection(match[1])] } },
    { method: 'POST', path: /\/v1\/composio\/connections\/([0-9a-f]{32})\/disconnect/, handle: async ({ match, body }) => [200, await disconnect(match[1], body)] },
    { method: 'GET', path: /\/v1\/composio\/approvals/, handle: async ({ query }) => { noQuery(query); return [200, approvals()] } },
    { method: 'POST', path: /\/v1\/composio\/approvals\/([0-9a-f]{32})/, handle: async ({ match, body }) => [200, decide(match[1], body)] },
    { method: 'GET', path: /\/v1\/mcp\/servers/, handle: async ({ query }) => { noQuery(query); return [200, listServers()] } },
    { method: 'POST', path: /\/v1\/mcp\/servers/, handle: async ({ body }) => [200, saveServer(body)] },
    { method: 'DELETE', path: /\/v1\/mcp\/servers\/([0-9a-f]{32})/, handle: async ({ match, body }) => [200, removeServer(match[1], body)] },
  ]

  return {
    store, legacy, onChange, discover, callTool, propose, decide, approvals, run,
    overview, saveKey, toolkits, syncConnections, connect, disconnect, refreshConnection, listServers, saveServer, removeServer,
    hasTools: () => Boolean(state().composio) || state().mcp_servers.length > 0,
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]))
  return value
}

// Per-user import (flybot_workspace/dsbot_bundle.py 'connectors'): the account's own
// Composio key and connection records, and its custom MCP servers with their
// sealed configs. Servers without a delivered config are skipped.
export const IMPORT_TABLES = {
  composio_user: ['user_ref'],
  composio_keys: ['user_id', 'key_hint', 'revision', 'updated'],
  composio_connections: ['id', 'toolkit', 'account_id', 'status', 'status_reason', 'created', 'updated'],
  custom_mcp_servers: ['id', 'name', 'origin', 'revision', 'created', 'updated'],
}
export function importApplier(sealKey) {
  return (draft, tables, secrets) => {
    draft.connections ??= []
    draft.mcp_servers ??= []
    draft.calls ??= []
    const [user] = tables.composio_user ?? []
    if (user && /^flybot-workspace-[0-9a-f]{32}$/.test(String(user.user_ref))) draft.composio_user = user.user_ref
    const [keyRow] = tables.composio_keys ?? []
    if (keyRow && composio.validApiKey(secrets.composio_key) && !draft.composio) {
      draft.composio = { key_sealed: seal(sealKey, KEY_PURPOSE, secrets.composio_key), key_hint: composio.hint(secrets.composio_key), revision: Math.max(1, Number(keyRow.revision) || 1), updated: keyRow.updated }
      for (const row of tables.composio_connections ?? []) {
        if (!LOCAL_ID.test(String(row.id)) || !composio.ACCOUNT.test(String(row.account_id)) || !composio.TOOLKIT.test(String(row.toolkit))) continue
        if (draft.connections.some(c => c.id === row.id || c.account_id === row.account_id) || draft.connections.length >= composio.MAX_CONNECTIONS) continue
        draft.connections.push({ id: row.id, toolkit: row.toolkit, account_id: row.account_id, status: composio.normalStatus(row.status), status_reason: composio.reasonText(row.status_reason), created: row.created, updated: row.updated })
      }
    }
    for (const row of tables.custom_mcp_servers ?? []) {
      const config = secrets['mcp:' + row.id]
      if (!LOCAL_ID.test(String(row.id)) || typeof config !== 'string' || draft.mcp_servers.some(s => s.id === row.id) || draft.mcp_servers.length >= MAX_SERVERS) continue
      let parsedConfig
      try { parsedConfig = JSON.parse(config); endpoint(parsedConfig.url) } catch { continue }
      draft.mcp_servers.push({ id: row.id, name: String(row.name).slice(0, 60), origin: row.origin, config_sealed: seal(sealKey, mcpPurpose(row.id), JSON.stringify({ url: parsedConfig.url, bearer_token: typeof parsedConfig.bearer_token === 'string' ? parsedConfig.bearer_token : '' })), revision: Math.max(1, Number(row.revision) || 1), created: row.created, updated: row.updated })
    }
  }
}

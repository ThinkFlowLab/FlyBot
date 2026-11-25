// Per-user Composio REST client (port of flybot_workspace/composio.py), running in
// the user's own DS-Bot. Only this user's own key is ever used; there is no
// platform or admin key and no fallback. Errors are fixed strings that never
// contain the key. No redirects are followed.
export const BASE_URL = 'https://backend.composio.dev/api/v3.1'
export const TOOLKIT = /^[a-z0-9_][a-z0-9_-]{0,63}$/
export const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_CONNECTIONS = 100
const MAX_RESPONSE = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000
export const PENDING = ['INITIALIZING', 'INITIATED']
const KNOWN = ['INITIALIZING', 'INITIATED', 'ACTIVE', 'INACTIVE', 'FAILED', 'EXPIRED', 'REVOKED', 'DELETED']

export const CATALOG = {
  github: ['github', 'yes'], notion: ['notion', 'yes'], linear: ['linear', 'yes'], atlassian: ['jira', 'yes'],
  sentry: ['sentry', 'yes'], stripe: ['stripe', 'yes'], paypal: ['paypal', 'own'], square: ['square', 'yes'],
  cloudflare: ['cloudflare', 'key'], vercel: ['vercel', 'own'], supabase: ['supabase', 'yes'], neon: ['neon', 'own'],
  figma: ['figma', 'yes'], canva: ['canva', 'yes'], intercom: ['intercom', 'yes'], monday: ['monday', 'yes'],
  webflow: ['webflow', 'own'], wix: ['wix', 'own'], airtable: ['airtable', 'yes'], dropbox: ['dropbox', 'yes'],
  clickup: ['clickup', 'yes'], todoist: ['todoist', 'yes'], miro: ['miro', 'yes'], attio: ['attio', 'yes'],
  postman: ['postman', 'key'], asana: ['asana', 'yes'], box: ['box', 'yes'], hubspot: ['hubspot', 'yes'],
  slack: ['slack', 'yes'], huggingface: ['hugging_face', 'yes'], exa: ['exa', 'key'],
}

export class ComposioError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status }
}

export const validApiKey = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value)
export const composioUserId = userKey => 'flybot-workspace-' + userKey
export const hint = key => '••••' + key.slice(-4)
export const normalStatus = value => (typeof value === 'string' && KNOWN.includes(value) ? value : 'FAILED')
export const uiState = status => (PENDING.includes(status) ? 'connecting' : status === 'ACTIVE' ? 'connected' : status === 'INACTIVE' ? 'inactive' : 'failed')
export const reasonText = value => (typeof value === 'string' ? value.slice(0, 200) : null)
export const catalogView = () => Object.entries(CATALOG).map(([id, [toolkit, managed]]) => ({ id, toolkit, managed }))

export function safeRedirect(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

export function toolkitView(item) {
  if (!item || typeof item !== 'object' || typeof item.slug !== 'string') return null
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {}
  const managed = Array.isArray(item.composio_managed_auth_schemes) ? item.composio_managed_auth_schemes : []
  return {
    slug: item.slug.toLowerCase().slice(0, 64),
    name: String(item.name || item.slug).slice(0, 80),
    description: (typeof meta.description === 'string' ? meta.description : '').slice(0, 240),
    auth_schemes: (Array.isArray(item.auth_schemes) ? item.auth_schemes : []).filter(s => typeof s === 'string').slice(0, 8),
    composio_managed: managed.length > 0 || Boolean(item.no_auth),
  }
}

export const fetchTransport = async (method, url, headers, body) => {
  const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const raw = Buffer.from(await response.arrayBuffer())
  return [response.status, raw]
}

export class Client {
  #key
  constructor(apiKey, transport = fetchTransport, baseUrl = BASE_URL) {
    if (!validApiKey(apiKey)) throw new ComposioError('composio_not_configured', 'Composio API key is missing')
    this.#key = apiKey
    this.transport = transport
    this.baseUrl = baseUrl
  }

  toJSON() { return '<composio.Client>' }

  async call(method, path, query, body, allow = [200, 201, 202, 204]) {
    let url = this.baseUrl + path
    if (query) url += '?' + new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))).toString()
    const headers = { 'x-api-key': this.#key, Accept: 'application/json' }
    let data
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body) }
    let status, raw
    try { [status, raw] = await this.transport(method, url, headers, data) } catch { throw new ComposioError('composio_unreachable', 'Composio could not be reached') }
    if ((raw?.length ?? 0) > MAX_RESPONSE) throw new ComposioError('composio_failed', 'Composio response was too large')
    if (status === 401 || status === 403) throw new ComposioError('composio_key_rejected', 'Composio rejected this API key', status)
    if (status === 404) throw new ComposioError('composio_not_found', 'Composio did not find that item', status)
    if (status === 409) throw new ComposioError('composio_conflict', 'Composio reported a connection conflict', status)
    if (status === 429) throw new ComposioError('composio_rate_limited', 'Composio rate limit reached; try later', status)
    if (status >= 500 && status < 600) throw new ComposioError('composio_upstream', 'Composio service returned an error; try later', status)
    if (!allow.includes(status)) throw new ComposioError('composio_failed', 'Composio request failed', status)
    if (!raw || raw.length === 0) return {}
    let payload
    try { payload = JSON.parse(Buffer.from(raw).toString('utf8')) } catch { throw new ComposioError('composio_failed', 'Composio returned an unreadable response') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ComposioError('composio_failed', 'Composio returned an unexpected response')
    return payload
  }

  listToolkits(search, cursor, limit = 50) {
    const query = { limit: String(limit), sort_by: 'usage' }
    if (search) query.search = search
    if (cursor) query.cursor = cursor
    return this.call('GET', '/toolkits', query)
  }

  async createLink(userId, toolkit, callbackUrl) {
    const session = await this.call('POST', '/tool_router/session', undefined, { user_id: userId, toolkits: { enable: [toolkit] } })
    if (typeof session.session_id !== 'string' || !ACCOUNT.test(session.session_id)) throw new ComposioError('composio_failed', 'Composio did not return a session')
    const link = await this.call('POST', `/tool_router/session/${session.session_id}/link`, undefined, { toolkit, callback_url: callbackUrl })
    if (typeof link.connected_account_id !== 'string' || !ACCOUNT.test(link.connected_account_id) || !safeRedirect(link.redirect_url)) {
      throw new ComposioError('composio_failed', 'Composio did not return a usable Connect Link')
    }
    return { redirect_url: link.redirect_url, account_id: link.connected_account_id }
  }

  getAccount(id) { return this.call('GET', '/connected_accounts/' + encodeURIComponent(id)) }
  listAccounts(userId, limit = MAX_CONNECTIONS) { return this.call('GET', '/connected_accounts', { user_ids: [userId], limit: String(limit) }) }
  tools(toolkit, search, cursor) {
    const query = { toolkit_slug: toolkit, limit: '20', toolkit_versions: 'latest' }
    if (search) query.query = search
    else query.important = 'true'
    if (cursor) query.cursor = cursor
    return this.call('GET', '/tools', query)
  }
  // Fixed route and explicit account: never custom auth params, proxy URLs or fallback credentials.
  execute(tool, account, user, version, args) {
    return this.call('POST', '/tools/execute/' + encodeURIComponent(tool), undefined, { connected_account_id: account, user_id: user, version, arguments: args })
  }
  deleteAccount(id) { return this.call('DELETE', '/connected_accounts/' + encodeURIComponent(id)) }
}

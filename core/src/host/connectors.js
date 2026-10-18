// Connectors: outside services the owner's Bots can use. Their tools come from an MCP server
// through DSH's own MCP client, mounted on the plugin context as mcp__<connector>__<tool>.
// The mount is global to DSH, so which Bot sees them is decided per Bot in
// connector-access.js: off by default, never on for a Bot that is shared with anyone.
//
// GitHub is the first one: GitHub's own MCP server. Composio is the second: one API key
// opens a gateway to many apps (Gmail, Slack, Calendar, Notion, ...). The user picks the
// apps here; Composio asks for each app's sign-in the first time a Bot needs it, so its
// tools arrive as mcp__composio__COMPOSIO_*.
//
// A secret (GITHUB_TOKEN, COMPOSIO_API_KEY) is kept and redacted by secrets.js. It reaches
// the service only in the MCP request headers, built here in memory, never written to the
// DSH profile. A new secret is shared with no Bot's shell: the tools do not need it there,
// and a Bot that reads a planted instruction in an issue or a mail could send it anywhere.
// The Secrets page can still share it. Signing in is `check` alone, so a browser login can
// take its place later without touching the mount.

import { randomUUID } from 'node:crypto'

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
export const COMPOSIO = 'composio'
export const COMPOSIO_SECRET = 'COMPOSIO_API_KEY'
// Names a saved capability may not take, because the mount already uses them.
export const RESERVED_NAMES = [GITHUB, COMPOSIO]
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const GITHUB_DEFAULTS = {
  url: 'https://api.githubcopilot.com/mcp/',
  api: 'https://api.github.com',
  toolsets: 'context,repos,issues,pull_requests',
}
const COMPOSIO_DEFAULTS = { api: 'https://backend.composio.dev/api/v3.1' }
const CHECK_TIMEOUT_MS = 15_000
const INSECURE = name => `${name} addresses must start with https://`
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_APPS = 40

// Asks GitHub who the token belongs to. Any token GitHub accepts passes.
export async function signIn(token, { api = GITHUB_DEFAULTS.api, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${api.replace(/\/$/, '')}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach GitHub')
  }
  if (response.status === 401) throw new Error('GitHub did not accept this token')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.login !== 'string') throw new Error('GitHub did not say who this token belongs to')
  return { login: user.login }
}

export function cleanApps(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const apps = [...new Set(list.map(app => String(app).trim().toLowerCase()).filter(app => app !== ''))]
  if (apps.length === 0) throw new Error('Pick at least one app')
  if (apps.length > MAX_APPS) throw new Error(`Pick up to ${MAX_APPS} apps`)
  const bad = apps.find(app => !APP_SLUG.test(app))
  if (bad !== undefined) throw new Error('An app name has only lowercase letters, digits, "_" and "-"')
  return apps
}

// Asks Composio for a tool-router session that is limited to `apps`, and returns the MCP
// address of that session. It also proves the key. The key goes only to the API address
// and to an MCP address on the same host, never to one that the answer names elsewhere.
export async function composioSession(apiKey, { api = COMPOSIO_DEFAULTS.api, userId, apps, fetch: request = fetch } = {}) {
  const base = api.replace(/\/$/, '')
  let response
  try {
    response = await request(`${base}/tool_router/session`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'ds-bot' },
      body: JSON.stringify({ user_id: userId, toolkits: { enable: apps }, workbench: { enable: false }, manage_connections: { enable: true } }),
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Composio')
  }
  const body = await response.json().catch(() => ({}))
  if (response.status === 401 || response.status === 403) throw new Error('Composio did not accept this API key')
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 200)}` : ''
    throw new Error(`Composio answered ${response.status}${detail}`)
  }
  let url
  try {
    url = new URL(body?.mcp?.url)
  } catch {
    throw new Error('Composio did not give an MCP address')
  }
  if (url.protocol !== 'https:' || url.origin !== new URL(base).origin) throw new Error('Composio gave an MCP address on another host')
  // Only the id is kept (see composioSessionFind); the address is rebuilt from it at mount time.
  const id = typeof body?.session_id === 'string' && SESSION_ID.test(body.session_id) ? body.session_id : undefined
  if (id === undefined) throw new Error('Composio did not give a session id')
  return { url: url.href, id }
}

const sameApps = (left, right) => Array.isArray(left) && left.length === right.length && right.every(app => left.includes(app))
const sessionAddress = (base, id) => `${base.replace(/\/$/, '')}/tool_router/session/${encodeURIComponent(id)}`

// Asks Composio for a session by id (GET /tool_router/session/{id}, `x-api-key`) and returns its
// MCP address, which is what the mount needs. Composio documents the address in this answer, so
// only the id is kept in state.json and the address is asked for again at each mount. Returns
// undefined once the session is gone (404/410, an id Composio does not know) or when its answer
// names no https address on the API's own host; a refused key or an outage throws.
export async function composioSessionFind(apiKey, { api = COMPOSIO_DEFAULTS.api, id, fetch: request = fetch } = {}) {
  const base = api.replace(/\/$/, '')
  let response
  try {
    response = await request(sessionAddress(base, id), {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'user-agent': 'ds-bot' },
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Composio')
  }
  if (response.status === 401 || response.status === 403) throw new Error('Composio did not accept this API key')
  if (response.status === 400 || response.status === 404 || response.status === 410) return undefined
  if (!response.ok) throw new Error(`Composio answered ${response.status}`)
  const body = await response.json().catch(() => ({}))
  try {
    const url = new URL(body?.mcp?.url)
    return url.protocol === 'https:' && url.origin === new URL(base).origin ? url.href : undefined
  } catch {
    return undefined
  }
}

// True while Composio still has the session and names an address for it.
export async function composioSessionAlive(apiKey, options = {}) {
  return (await composioSessionFind(apiKey, options)) !== undefined
}

// Deletes a session on Composio (DELETE /tool_router/session/{id}): afterwards its MCP address
// answers 404. Best effort and never throws: true when the session is gone (a 404 means it
// already was), false when Composio could not be asked or refused, so a failure never blocks
// a Disconnect or an app-list change. The key goes only in the header, to the API address.
export async function composioDeleteSession(apiKey, { api = COMPOSIO_DEFAULTS.api, id, fetch: request = fetch } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return false
  try {
    const response = await request(sessionAddress(api, id), {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'user-agent': 'ds-bot' },
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    return response.ok || response.status === 404 || response.status === 410
  } catch {
    return false
  }
}

// What state.json keeps of a session: its id and apps, never the address (see composioSessionFind).
const kept = session => ({ id: session.id, apps: session.apps })

// One session per connect or app-list change: the stored session is reused while it is for the
// same apps and Composio still has it; otherwise a new one is made. Returns { id, apps, url }:
// the address is for this mount only and is never saved.
async function composioEnsureSession(apiKey, { api, userId, apps, stored, fetch: request }) {
  const base = (api ?? COMPOSIO_DEFAULTS.api)
  if (typeof stored?.id === 'string' && sameApps(stored.apps, apps)) {
    const url = await composioSessionFind(apiKey, { api: base, id: stored.id, fetch: request })
    if (url !== undefined) return { id: stored.id, url, apps }
  }
  const { url, id } = await composioSession(apiKey, { api: base, userId, apps, fetch: request })
  return { id, url, apps }
}

const DEFINITIONS = {
  [GITHUB]: {
    id: GITHUB,
    name: 'GitHub',
    secret: GITHUB_SECRET,
    purpose: 'GitHub connector',
    defaults: GITHUB_DEFAULTS,
    addresses: options => [options.url, options.api],
    async check({ token, options }) {
      const { login } = await signIn(token, { api: options.api })
      return { login }
    },
    async mountConfig(token, options) {
      return { url: options.url, headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': options.toolsets } }
    },
    mountKey: () => '',
    account: saved => saved?.login ?? null,
  },
  [COMPOSIO]: {
    id: COMPOSIO,
    name: 'Composio',
    secret: COMPOSIO_SECRET,
    purpose: 'Composio connector',
    defaults: COMPOSIO_DEFAULTS,
    addresses: options => [options.api],
    // The user id names this FlyBot to Composio, so the apps signed in once stay signed in.
    // The session it makes (or reuses) is kept in the record as { id, apps }, so the mount does not
    // make another; the session's address is not kept.
    async check({ token, options, saved, body }) {
      const apps = cleanApps(body.apps ?? saved?.apps)
      const userId = saved?.userId ?? `flybot-${randomUUID()}`
      const session = await composioEnsureSession(token, { api: options.api, userId, apps, stored: saved?.session })
      return { userId, apps, session: kept(session) }
    },
    // Mounts the kept session while Composio still has it, with the address Composio gives for its
    // id. `record` is set when a new session had to be made (first start after an older version, or
    // one deleted on Composio) or when an older version's record still carries an address; it must be kept.
    async mountConfig(token, options, saved) {
      // A key without a saved connection (added on the Secrets page, say) makes no session.
      if (saved?.userId === undefined) throw new Error('Connect Composio first')
      const apps = cleanApps(saved.apps)
      const session = await composioEnsureSession(token, { api: options.api, userId: saved.userId, apps, stored: saved.session })
      const same = saved.session?.id === session.id && saved.session?.url === undefined
      return { url: session.url, headers: { 'x-api-key': token }, ...(same ? {} : { record: { ...saved, session: kept(session) }, session: kept(session) }) }
    },
    // Best effort: a session that cannot be deleted is left to Composio, never an error for the user.
    async discard({ keys, options, session }) {
      if (session?.id === undefined) return
      for (const key of keys) if (await composioDeleteSession(key, { api: options.api, id: session.id })) return
    },
    mountKey: saved => JSON.stringify([saved?.userId, saved?.apps]),
    account: () => null,
    extra: saved => ({ apps: saved?.apps ?? [] }),
    // Keeps the user id: a new key for the same FlyBot finds the apps already signed in.
    afterDisconnect: saved => saved?.userId === undefined ? undefined : { userId: saved.userId },
  },
}

export function install(rt) {
  const { ctx, state } = rt
  let stopped = false

  const connectors = Object.values(DEFINITIONS).map(def => {
    const options = rt.config[def.id] === false ? null : { ...def.defaults, ...rt.config[def.id] }
    return {
      def,
      options,
      insecure: options !== null && def.addresses(options).some(address => !/^https:\/\//i.test(String(address))),
      // `key` is what the current mount was made with, so a changed secret or app list mounts again.
      mount: null,
      status: { state: 'off' },
      queue: Promise.resolve(),
      // Set while connect / choose apps is saving the key and the connection: a secret change in
      // between must not mount (the endpoint mounts itself once the connection is saved).
      saving: 0,
    }
  })

  const saved = c => state.connectors?.[c.def.id]
  const unmount = async (c) => {
    const fiber = c.mount?.fiber
    c.mount = null
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => { /* a fiber that fails to dispose must not block unloading */ })
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause. The session address of a
  // mount in progress is not kept anywhere, so it is also taken out of what is shown or logged.
  let addresses = []
  const reason = (error) => {
    let text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    for (const address of addresses) text = text.split(address).join('[session address]')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  async function reconcile(c, force) {
    const { def, options } = c
    if (c.saving > 0 && !force) return
    const token = options !== null && !stopped ? rt.secretValue(def.secret) : undefined
    const key = token === undefined ? undefined : `${token}\n${def.mountKey(saved(c))}`
    if (!force && c.mount !== null && c.mount.key === key) return
    await unmount(c)
    if (token === undefined) {
      c.status = { state: 'off' }
      return
    }
    if (c.insecure) {
      c.mount = { key }
      c.status = { state: 'error', error: INSECURE(def.name) }
      return
    }
    c.status = { state: 'connecting' }
    const loader = ctx.get?.('loader')
    if (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function') {
      c.mount = { key }
      c.status = { state: 'error', error: 'This DSH cannot load connectors' }
      return
    }
    try {
      const { url, headers, record, session } = await def.mountConfig(token, options, saved(c))
      if (def.id === COMPOSIO) addresses = [url]
      if (record !== undefined) {
        // A session made just now is kept only while this connection is still the saved one;
        // after a Disconnect (or a new key) in the meantime it is deleted again.
        if (saved(c) !== undefined && rt.secretValue(def.secret) === token) await keep(c, record)
        else await def.discard?.({ keys: [token], options, session })
      }
      if (stopped) return
      const exports = await loader.import(MCP_CLIENT)
      const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      const fiber = ctx.plugin(plugin, {
        transport: 'streamable-http',
        serverName: def.id,
        url,
        headers,
        failOnStartupError: true,
      })
      c.mount = { key, fiber }
      await fiber.await()
      if (c.mount?.fiber !== fiber) return
      c.status = { state: 'ready' }
    } catch (error) {
      await unmount(c)
      c.mount = { key }
      c.status = { state: 'error', error: reason(error) }
      rt.warn('ds-bot: %s connector failed: %s', def.name, c.status.error)
    }
  }

  // One change at a time per connector; `force` connects again even when nothing changed.
  const sync = (c, force = false) => {
    c.queue = c.queue.then(() => reconcile(c, force)).catch(error => { rt.warn('ds-bot: connectors: %s', reason(error)) })
    return c.queue
  }
  const syncAll = () => Promise.all(connectors.map(c => sync(c)))

  const view = (c) => ({
    id: c.def.id,
    name: c.def.name,
    state: c.status.state,
    ...(c.status.error !== undefined ? { error: c.status.error } : {}),
    account: rt.secretValue(c.def.secret) !== undefined ? c.def.account(saved(c)) : null,
    ...(c.def.extra !== undefined ? c.def.extra(rt.secretValue(c.def.secret) !== undefined ? saved(c) : undefined) : {}),
  })
  const connectorsView = () => connectors.filter(c => c.options !== null).map(view)

  const known = id => {
    const c = connectors.find(entry => entry.def.id === id)
    if (c === undefined || c.options === null) throw new Error('No such connector')
    return c
  }

  const keep = async (c, record) => {
    state.connectors = { ...state.connectors, [c.def.id]: { ...record, connectedAt: saved(c)?.connectedAt ?? Date.now() } }
    await rt.save()
  }
  // Deletes a session that a change has superseded (the stored one after a new connection or app
  // list, the new one when saving it failed). `keys` are tried in order: the key it was made with first.
  const retire = async (c, { gone, kept, keys }) => {
    if (gone?.id === undefined || gone.id === kept?.id) return
    await Promise.resolve(c.def.discard?.({ keys: [...new Set(keys.filter(key => key !== undefined))], options: c.options, session: gone })).catch(() => { /* never blocks the change */ })
  }

  const endpoints = {
    async 'connector-connect'(body) {
      const c = known(body.id)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error(c.def.id === GITHUB ? 'Paste a token first' : 'Paste a key first')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      const oldToken = rt.secretValue(c.def.secret)
      const kept = oldToken !== undefined
      const previous = saved(c)
      const record = await c.def.check({ token, options: c.options, saved: previous, body })
      c.saving += 1
      try {
        await rt.secretEndpoint('secret-set', { name: c.def.secret, value: token, purpose: c.def.purpose, ...(kept ? {} : { scope: [] }) })
        state.connectors = { ...state.connectors, [c.def.id]: { ...record, connectedAt: Date.now() } }
        await rt.save()
      } catch (error) {
        await retire(c, { gone: record.session, kept: previous?.session, keys: [token] })
        throw error
      } finally {
        c.saving -= 1
      }
      await retire(c, { gone: previous?.session, kept: record.session, keys: [oldToken, token] })
      await sync(c)
      return connectorsView()
    },
    // Changes which apps a connected gateway offers, without asking for the key again.
    async 'connector-apps'(body) {
      const c = known(body.id)
      if (c.def.id !== COMPOSIO) throw new Error('This connector has no apps to pick')
      await rt.loadSecrets()
      const token = rt.secretValue(c.def.secret)
      if (token === undefined) throw new Error('Connect Composio first')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      const previous = saved(c)
      const record = await c.def.check({ token, options: c.options, saved: previous, body })
      try {
        await keep(c, record)
      } catch (error) {
        await retire(c, { gone: record.session, kept: previous?.session, keys: [token] })
        throw error
      }
      await retire(c, { gone: previous?.session, kept: record.session, keys: [token] })
      await sync(c)
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      const c = known(body.id)
      await rt.loadSecrets()
      const oldToken = rt.secretValue(c.def.secret)
      const previous = saved(c)
      if (oldToken !== undefined) await rt.secretEndpoint('secret-delete', { name: c.def.secret })
      if (saved(c) !== undefined) {
        const rest = c.def.afterDisconnect?.(saved(c))
        if (rest === undefined) delete state.connectors[c.def.id]
        else state.connectors[c.def.id] = rest
        await rt.save()
      }
      if (oldToken !== undefined) await retire(c, { gone: previous?.session, kept: undefined, keys: [oldToken] })
      await rt.forgetConnector?.(c.def.id)
      await sync(c)
      return connectorsView()
    },
    async 'connector-retry'(body) {
      const c = known(body.id)
      await rt.loadSecrets()
      await sync(c, true)
      return connectorsView()
    },
  }

  const connectorEndpoint = (endpoint, body) => endpoints[endpoint](body ?? {})

  // An older version kept the session's address in state.json. Only the id stays; the address is
  // asked for again at mount time (composioSessionFind).
  const scrubAddresses = async () => {
    await rt.load()
    const session = state.connectors?.[COMPOSIO]?.session
    if (session === undefined || !('url' in session)) return
    state.connectors[COMPOSIO] = { ...state.connectors[COMPOSIO], session: kept(session) }
    await rt.save()
  }

  ctx.effect(() => {
    stopped = false
    void scrubAddresses().catch(error => rt.warn('ds-bot: connectors: %s', reason(error))).then(() => rt.loadSecrets()).then(syncAll)
    return () => {
      stopped = true
      for (const c of connectors) void unmount(c)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { void syncAll() } })
}

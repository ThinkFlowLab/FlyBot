// Connectors: outside services every Bot can use. Their tools come from an MCP server
// through DSH's own MCP client, mounted on the plugin context, so every Bot and Session
// gets them as mcp__<connector>__<tool>.
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
  return { url: url.href }
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
    async check({ token, options, saved, body }) {
      const apps = cleanApps(body.apps ?? saved?.apps)
      const userId = saved?.userId ?? `flybot-${randomUUID()}`
      await composioSession(token, { api: options.api, userId, apps })
      return { userId, apps }
    },
    async mountConfig(token, options, saved) {
      const { url } = await composioSession(token, { api: options.api, userId: saved.userId, apps: saved.apps })
      return { url, headers: { 'x-api-key': token } }
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
    }
  })

  const saved = c => state.connectors?.[c.def.id]
  const unmount = async (c) => {
    const fiber = c.mount?.fiber
    c.mount = null
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => { /* a fiber that fails to dispose must not block unloading */ })
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause.
  const reason = (error) => {
    const text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  async function reconcile(c, force) {
    const { def, options } = c
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
      const { url, headers } = await def.mountConfig(token, options, saved(c))
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

  const endpoints = {
    async 'connector-connect'(body) {
      const c = known(body.id)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error(c.def.id === GITHUB ? 'Paste a token first' : 'Paste a key first')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      const kept = rt.secretValue(c.def.secret) !== undefined
      const record = await c.def.check({ token, options: c.options, saved: saved(c), body })
      await rt.secretEndpoint('secret-set', { name: c.def.secret, value: token, purpose: c.def.purpose, ...(kept ? {} : { scope: [] }) })
      state.connectors = { ...state.connectors, [c.def.id]: { ...record, connectedAt: Date.now() } }
      await rt.save()
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
      const record = await c.def.check({ token, options: c.options, saved: saved(c), body })
      await keep(c, record)
      await sync(c)
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      const c = known(body.id)
      await rt.loadSecrets()
      if (rt.secretValue(c.def.secret) !== undefined) await rt.secretEndpoint('secret-delete', { name: c.def.secret })
      if (saved(c) !== undefined) {
        const rest = c.def.afterDisconnect?.(saved(c))
        if (rest === undefined) delete state.connectors[c.def.id]
        else state.connectors[c.def.id] = rest
        await rt.save()
      }
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

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(syncAll)
    return () => {
      stopped = true
      for (const c of connectors) void unmount(c)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { void syncAll() } })
}

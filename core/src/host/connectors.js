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
// DSH profile. A new secret is for all of the owner's Bots, like any key the owner saves
// (owner decision 2026-10-20, #359, #545): their shells get it as $DSH_SECRET_<NAME> too.
// The Secrets page narrows it to chosen Bots or to none. Reconnecting keeps the scope the
// key already has. Signing in is `check` alone, so a browser login can take its place later
// without touching the mount.

import { randomUUID } from 'node:crypto'
import { createNotifier } from './notify.js'
import { APP_SECRET_SECRET, appCredentials, createInbound } from './feishu-inbound.js'
import { createFeishuTransport } from './feishu-sdk.js'

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
export const COMPOSIO = 'composio'
export const COMPOSIO_SECRET = 'COMPOSIO_API_KEY'
export const FEISHU = 'feishu'
export const FEISHU_SECRET = 'FEISHU_WEBHOOK'
// Names a saved capability may not take, because the mount already uses them.
export const RESERVED_NAMES = [GITHUB, COMPOSIO, FEISHU]
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const GITHUB_DEFAULTS = {
  url: 'https://api.githubcopilot.com/mcp/',
  api: 'https://api.github.com',
  toolsets: 'context,repos,issues,pull_requests',
}
const COMPOSIO_DEFAULTS = { api: 'https://backend.composio.dev/api/v3.1' }
const FEISHU_DEFAULTS = { api: 'https://open.feishu.cn' }
const CHECK_TIMEOUT_MS = 15_000
// A send waits longer than a connect: the connect is one small probe, while a message may sit
// behind Feishu's own queue. The retry budget is notify.js's, not this deadline.
const SEND_TIMEOUT_MS = 60_000
// Feishu's custom-bot webhook answers HTTP 200 with the verdict in the body, so a rate limit has
// to be read out of `code`; 9499 is the one code that means "the same call may work again".
export const FEISHU_RATE_LIMITED = 9499
const FEISHU_TEST_TEXT = 'FlyBot is connected.'
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

const MAX_FOUND = 20
const MAX_QUERY = 64

// Searches Composio's app list (GET /toolkits?search=, `x-api-key`) and returns up to MAX_FOUND
// { slug, name }, most used first. Only slugs a session can take are returned.
export async function composioSearchApps(apiKey, { api = COMPOSIO_DEFAULTS.api, query = '', fetch: request = fetch } = {}) {
  const base = api.replace(/\/$/, '')
  const params = new URLSearchParams({ sort_by: 'usage', limit: String(MAX_FOUND) })
  const search = String(query).trim().slice(0, MAX_QUERY)
  if (search !== '') params.set('search', search)
  let response
  try {
    response = await request(`${base}/toolkits?${params}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'user-agent': 'ds-bot' },
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Composio')
  }
  if (response.status === 401 || response.status === 403) throw new Error('Composio did not accept this API key')
  if (!response.ok) throw new Error(`Composio answered ${response.status}`)
  const body = await response.json().catch(() => ({}))
  const items = Array.isArray(body?.items) ? body.items : []
  const found = new Map()
  for (const item of items) {
    const slug = typeof item?.slug === 'string' ? item.slug.toLowerCase() : ''
    if (!APP_SLUG.test(slug) || found.has(slug)) continue
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 80) : slug
    found.set(slug, { slug, name })
  }
  return [...found.values()].slice(0, MAX_FOUND)
}

// Asks Composio which of the session's apps are signed in (GET /tool_router/session/{id}/toolkits).
// Returns { [slug]: 'ready' | 'sign-in' } for the given apps: ready when the app needs no sign-in or
// has an active connected account, sign-in otherwise (also for an app Composio does not list).
export async function composioAppStatus(apiKey, { api = COMPOSIO_DEFAULTS.api, id, apps, fetch: request = fetch } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Connect Composio first')
  const params = new URLSearchParams({ toolkits: apps.join(','), limit: '50' })
  let response
  try {
    response = await request(`${sessionAddress(api, id)}/toolkits?${params}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'user-agent': 'ds-bot' },
      redirect: 'error',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Composio')
  }
  if (response.status === 401 || response.status === 403) throw new Error('Composio did not accept this API key')
  if (!response.ok) throw new Error(`Composio answered ${response.status}`)
  const body = await response.json().catch(() => ({}))
  const ready = new Set()
  for (const item of Array.isArray(body?.items) ? body.items : []) {
    const slug = typeof item?.slug === 'string' ? item.slug.toLowerCase() : ''
    if (item?.is_no_auth === true || String(item?.connected_account?.status ?? '').toUpperCase() === 'ACTIVE') ready.add(slug)
  }
  return Object.fromEntries(apps.map(app => [app, ready.has(app) ? 'ready' : 'sign-in']))
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

// The webhook URL is the credential, so it is checked against the API address before anything is
// sent: https, on the host this instance was configured for. Never another host, never http.
function webhookAddress(webhook, api) {
  let url
  try {
    url = new URL(String(webhook).trim())
  } catch {
    throw new Error('Paste the webhook URL Feishu gave you')
  }
  const base = new URL(String(api))
  if (url.protocol !== 'https:' || url.origin !== base.origin) throw new Error(`A Feishu webhook must be https on ${base.origin}`)
  return url.href
}

// A fetch that ignores its abort signal would otherwise hang a connect (or a send) for ever.
function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), Math.max(1, ms)) })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// One text message through a custom-bot webhook, answered in notify.js's vocabulary: `{ ok, ts }`
// or `{ ok: false, error }`, where `rate_limited` and `service_unavailable` may pass on their own
// and every other error is a shape Feishu will refuse again. The URL is never part of the answer.
export async function feishuPost(webhook, text, { fetch: request = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await withDeadline(request(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msg_type: 'text', content: { text: String(text) } }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    }), timeoutMs)
  } catch {
    return { ok: false, error: 'network' }
  }
  const body = await response.json().catch(() => ({}))
  if (response.status === 429) {
    const asked = Number(response.headers?.get?.('retry-after')) * 1000
    return { ok: false, error: 'rate_limited', retryAfterMs: Number.isFinite(asked) && asked > 0 ? asked : 0 }
  }
  if (!response.ok) return { ok: false, error: response.status >= 500 ? 'service_unavailable' : `feishu/http-${response.status}` }
  const code = Number(body?.code)
  if (code === 0) {
    const id = body?.data?.message_id
    return { ok: true, ts: typeof id === 'string' && id !== '' ? id : 'sent' }
  }
  if (code === FEISHU_RATE_LIMITED) return { ok: false, error: 'rate_limited', retryAfterMs: 0 }
  return { ok: false, error: `feishu/${Number.isFinite(code) ? code : 'unknown'}` }
}

// The connect step: one test message, so a webhook that cannot post is caught before it is relied
// on. It throws a sentence for the row; nothing it says carries the URL.
export async function feishuCheck(webhook, { api = FEISHU_DEFAULTS.api, fetch: request = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const answer = await feishuPost(webhookAddress(webhook, api), FEISHU_TEST_TEXT, { fetch: request, timeoutMs })
  if (answer.ok) return {}
  if (answer.error === 'network' || answer.error === 'service_unavailable') throw new Error('Could not reach Feishu')
  if (answer.error === 'rate_limited') throw new Error('Feishu is rate-limiting this webhook; try again in a minute')
  throw new Error(`Feishu did not accept the webhook (${answer.error})`)
}

// notify.js's transport for a Feishu webhook: the policy (attempts, backoff, idempotency) stays in
// notify.js, and this only maps one message to one POST.
export function feishuTransport(webhook, { fetch: request = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  return { postMessage: message => feishuPost(webhook, message?.text ?? '', { fetch: request, timeoutMs }) }
}

// The app-mode probe (#1266): a POST that proves the pair and is then thrown away. The long
// connection dials with its own credentials, so nothing here may leak the token into an error, a log
// line or the row; the answer is only "accepted" or one sentence.
const FEISHU_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

const feishuOrigin = (api) => {
  try {
    return new URL(String(api)).origin
  } catch {
    throw new Error('The Feishu API address is not a URL')
  }
}

// One tenant token, asked for at the moment it is needed (the probe, or one answer). It is never
// kept: the socket keeps its own, and an answer does not outlive its POST.
export async function feishuAppToken({ appId, appSecret }, { api = FEISHU_DEFAULTS.api, fetch: request = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await withDeadline(request(`${feishuOrigin(api)}${FEISHU_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    }), timeoutMs)
  } catch {
    throw new Error('Could not reach Feishu')
  }
  const body = await response.json().catch(() => ({}))
  const code = Number(body?.code)
  if (response.status === 401 || response.status === 403 || code === 10003 || code === 10014) throw new Error('Feishu did not accept this App ID and App Secret')
  if (!response.ok) throw new Error(`Feishu answered ${response.status}`)
  const token = body?.tenant_access_token
  if (code !== 0 || typeof token !== 'string' || token === '') throw new Error('Feishu did not accept this App ID and App Secret')
  return token
}

// The connect step of app mode: prove the pair, then forget the token on purpose.
export async function feishuAppCheck(credentials, options = {}) {
  await feishuAppToken(credentials, options)
  return {}
}

// One answer back into the chat the message came from, as the app itself: `im/v1/messages` addressed
// by chat id (the `oc_…` tail of the `feishu:oc_…` handle). This is what makes "connect the app and
// it works" true with no webhook saved — the pair the owner just pasted is the whole credential.
export async function feishuAppSend({ appId, appSecret, chatId, text }, { api = FEISHU_DEFAULTS.api, fetch: request = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const token = await feishuAppToken({ appId, appSecret }, { api, fetch: request, timeoutMs })
  let response
  try {
    response = await withDeadline(request(`${feishuOrigin(api)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text) }) }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    }), timeoutMs)
  } catch {
    throw new Error('Not sent: could not reach Feishu')
  }
  const body = await response.json().catch(() => ({}))
  const code = Number(body?.code)
  if (response.ok && code === 0) return
  if (response.status === 401 || response.status === 403 || code === 99991663) throw new Error('Not sent: Feishu refused the app token while sending the answer')
  throw new Error(`Not sent: Feishu refused the answer (feishu/${Number.isFinite(code) ? code : response.status})`)
}

// The way out for an answer to a Feishu message (#1266). App mode answers as the app, in the very
// chat the message came from; webhook mode answers on the webhook phase 1 already posts on, so a
// message in and an answer out stay one credential and one transport. Which one is read on every
// send, so switching modes needs no re-registration. A missing credential or a refusal is a sentence
// the chat shows ("Not sent: …"), never a silent drop: `remote-chat` prints exactly what is thrown.
export function feishuReply({ secretValue, appOf, post = feishuPost, sendApp = feishuAppSend, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  return async ({ text, handle }) => {
    const app = appOf?.()
    if (app !== undefined) {
      const chatId = typeof handle === 'string' && handle.startsWith(`${FEISHU}:`) ? handle.slice(FEISHU.length + 1) : undefined
      if (chatId === undefined || chatId === '') throw new Error('Not sent: this answer has no Feishu chat to go to.')
      await sendApp({ ...app, chatId, text: String(text ?? '') }, { timeoutMs })
      return
    }
    const webhook = secretValue?.(FEISHU_SECRET)
    if (webhook === undefined) throw new Error('Not sent: connect Feishu first, so the answer has a way out.')
    const answer = await post(webhook, String(text ?? ''), { timeoutMs })
    if (answer?.ok === true) return
    throw new Error(`Not sent: Feishu refused the answer (${answer?.error ?? 'no answer'})`)
  }
}

// The two ways the Feishu row connects (#1266), as data the form renders: one field per credential,
// `masked` on the ones that never come back to the client. There is one Feishu row, not one per mode:
// two rows with the same name would be a puzzle, and the owner asked to click Connect in one place.
export const FEISHU_MODES = [
  {
    id: 'webhook',
    label: 'Custom bot webhook',
    credentials: [{ name: 'webhook', label: 'Webhook URL', masked: true }],
    link: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
    linkLabel: 'Get a webhook URL in Feishu',
  },
  {
    id: 'app',
    label: 'App (long connection)',
    credentials: [
      { name: 'app_id', label: 'App ID', masked: false },
      { name: 'app_secret', label: 'App Secret', masked: true },
    ],
    link: 'https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/create-an-app',
    linkLabel: 'Create a Feishu app',
  },
]

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
  // Feishu (Lark) is not an MCP server: it is a *channel* (#1266). Nothing is mounted and no Bot's
  // tool list changes; what it has is a status, one way in (the long connection of a self-built app)
  // and one way out (that app, or the custom-bot webhook of phase 1). `kind: 'channel'` is what makes
  // the row offer Choose Bots and what makes `reconcile()` open the socket instead of importing a
  // client: webhook mode is the same row with nothing to dial.
  [FEISHU]: {
    id: FEISHU,
    name: 'Feishu',
    secret: FEISHU_SECRET,
    purpose: 'Feishu webhook',
    defaults: FEISHU_DEFAULTS,
    addresses: options => [options.api],
    kind: 'channel',
    modes: FEISHU_MODES,
    paste: 'Choose how to connect Feishu and fill in its fields first',
    async check({ token, options }) {
      return feishuCheck(token, { api: options.api })
    },
    post: (webhook, text) => feishuPost(webhook, text, { timeoutMs: SEND_TIMEOUT_MS }),
    mountKey: () => '',
    account: () => null,
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

  // Feishu inbound (#1266): a message in Feishu starts a turn here. The socket is injected —
  // `rt.feishuTransport` is the one adapter the SDK-versus-hand-written decision changes, so nothing
  // below depends on which client dials. Off unless the owner connected the app on the row, and with
  // no socket adapter it starts nothing rather than pretend. The message lands through
  // `remote-chat.deliver` — the same seam a friend's Bot uses — and the answer leaves through the
  // sender this module registers in that same seam: app mode answers as the app, webhook mode on the
  // webhook phase 1 posts on. One path in, one path out.
  //
  // What the owner set lives in the connector record, not in `rt.config` (#1266): the row is the
  // place Feishu is configured, so the switch and the allowed senders are read from the record every
  // time instead of being copied while this module installs.
  const saved = c => state.connectors?.[c.def.id]
  const feishuRecord = () => state.connectors?.[FEISHU]
  const appOf = () => appCredentials(feishuRecord(), name => rt.secretValue(name))

  // The default adapter is the official SDK, and it is put on the runtime *before* the policy reads
  // it. That read happens on every `start()` rather than once here, so an adapter installed later
  // (a test's stub, a plugin's own client) is the one the next start dials instead of a snapshot
  // taken while it was missing.
  if (rt.feishuTransport === undefined) {
    rt.feishuTransport = createFeishuTransport({
      credentials: () => appOf(),
      log: (format, ...args) => rt.warn(`ds-bot: ${format}`, ...args),
    })
  }
  // One way out per Feishu chat: `remote-chat` keys a reply's sender by the chat's plugin, so this
  // registers the Feishu exit under `feishu`. Registered against the seam object it saw, so a runtime
  // that replaces the seam is wired again instead of keeping a dead registration.
  let feishuWire = { seam: undefined, off: undefined }
  const wireFeishuReply = () => {
    const seam = rt.remoteChats
    if (typeof seam?.onSend !== 'function') return
    if (feishuWire.seam === seam) return
    feishuWire.off?.()
    feishuWire = { seam, off: seam.onSend(FEISHU, feishuReply({ secretValue: name => rt.secretValue(name), appOf })) }
  }

  const feishuInbound = createInbound({
    // "On" means app mode with both halves saved. A half-saved pair dials nothing, and an event that
    // arrives while it is off starts no turn, whatever adapter is still handing events over.
    enabled: () => feishuRecord()?.mode === 'app' && appOf() !== undefined,
    ownerOpenId: rt.config?.feishu?.ownerOpenId,
    allowed: () => feishuRecord()?.allowed ?? [],
    transport: () => rt.feishuTransport,
    deliver: async ({ handle, text, name }) => {
      const seam = rt.remoteChats
      if (typeof seam?.deliver !== 'function') throw new Error('no chat seam is installed for a Feishu message')
      // The seam is installed after this module, so the answer's sender is registered when the first
      // message lands rather than while module install runs.
      wireFeishuReply()
      // `plugin` is what `remote-chat.forward` keys the sender by. Without it the chat is opened with
      // `remote.plugin === undefined` and every answer reads "Not sent: the plugin that reaches this
      // Bot is not running." `open` refreshes a chat that an older build opened without the plugin.
      if (typeof seam.open === 'function') await seam.open({ handle, name, plugin: FEISHU })
      await seam.deliver({ handle, text, name, plugin: FEISHU })
    },
    log: (format, ...args) => rt.warn(`ds-bot: ${format}`, ...args),
    redact: rt.redactSecrets,
  })

  const unmount = async (c) => {
    const fiber = c.mount?.fiber
    c.mount = null
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => { /* a fiber that fails to dispose must not block unloading */ })
  }

  // A sender's retry policy is notify.js's, not a second one written here: one transport per
  // sender, reading the saved webhook when it is called, so a reconnect needs no rebuild. Feishu is a
  // channel now, but its webhook mode still sends: the notifier is per definition that has a `post`.
  const notifiers = new Map(connectors.filter(c => typeof c.def.post === 'function').map(c => [c.def.id, createNotifier({
    channel: c.def.id,
    log: (format, ...args) => rt.warn(`ds-bot: ${format}`, ...args),
    transport: {
      postMessage: (message) => {
        const webhook = rt.secretValue(c.def.secret)
        if (webhook === undefined) return { ok: false, error: 'channel_not_found' }
        return c.def.post(webhook, message?.text ?? '')
      },
    },
  })]))
  const notifierOf = c => notifiers.get(c.def.id)

  // The connect step of a sender: one test message, then ready or the reason. A sender is "ready"
  // once this passes, and the failure is a row the owner can read and Try again from.
  const probe = async (c, token) => {
    try {
      await c.def.check({ token, options: c.options })
      c.status = { state: 'ready' }
    } catch (error) {
      c.status = { state: 'error', error: reason(error) }
      rt.warn('ds-bot: %s connector failed: %s', c.def.name, c.status.error)
    }
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause. The session address of a
  // mount in progress is not kept anywhere, so it is also taken out of what is shown or logged.
  let addresses = []
  const reason = (error) => {
    let text = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    for (const address of addresses) text = text.split(address).join('[session address]')
    return rt.redactSecrets(text || 'error').slice(0, 300)
  }

  // A channel is the row's life, not a mount (#1266): webhook mode is ready once its URL is saved,
  // app mode is ready once its socket is open, and the socket's own lifecycle is the status. Keyed by
  // what the dial depends on, so a new pair (or a mode switch) closes the old socket and opens one.
  async function reconcileChannel(c, force, token) {
    const { def } = c
    const record = saved(c) ?? {}
    const mode = record.mode === 'app' ? 'app' : record.mode === 'webhook' ? 'webhook' : undefined
    const app = mode === 'app' ? appOf() : undefined
    const key = mode === 'app' ? `app\n${app?.appId ?? ''}\n${app?.appSecret ?? ''}` : mode === 'webhook' ? `webhook\n${token ?? ''}` : undefined
    if (!force && c.mount !== null && c.mount.key === key) return
    await unmount(c)
    // A changed pair (or a mode switch) is a new socket: the old one is hung up before the new one
    // dials, so one record never holds two long connections.
    await feishuInbound.stop()
    if (mode === undefined) {
      notifierOf(c)?.setEnabled(false)
      await feishuInbound.stop()
      c.status = { state: 'off' }
      c.mount = { key }
      return
    }
    if (c.insecure) {
      c.mount = { key }
      c.status = { state: 'error', error: INSECURE(def.name) }
      return
    }
    // App mode answers as the app, webhook mode on the webhook: a saved webhook is worth a manual
    // Send in either mode, and nothing else turns the notifier on.
    notifierOf(c)?.setEnabled(token !== undefined)
    if (mode === 'webhook') {
      if (token === undefined) {
        await feishuInbound.stop()
        c.status = { state: 'off' }
        c.mount = { key }
        return
      }
      c.status = { state: 'connecting' }
      // A start-up (or a secret change) only reports that a webhook is saved — a restart must not post
      // to the group again. `force` is a person pressing Try again, which is that person asking for it.
      if (force) await probe(c, token)
      else c.status = { state: 'ready' }
      c.mount = { key }
      return
    }
    if (app === undefined) {
      await feishuInbound.stop()
      c.status = { state: 'error', error: 'A Feishu App ID and App Secret are both needed before the long connection can dial.' }
      c.mount = { key }
      return
    }
    c.status = { state: 'connecting' }
    const result = await feishuInbound.start()
    const inbound = feishuInbound.view()
    c.status = result === 'ready'
      ? { state: 'ready' }
      : result === 'off'
        ? { state: 'off' }
        : { state: 'error', error: inbound.error ?? 'the Feishu long connection did not open' }
    c.mount = { key }
  }

  async function reconcile(c, force) {
    const { def, options } = c
    if (c.saving > 0 && !force) return
    const token = options !== null && !stopped ? rt.secretValue(def.secret) : undefined
    if (def.kind === 'channel') return reconcileChannel(c, force, token)
    const key = token === undefined ? undefined : `${token}\n${def.mountKey(saved(c))}`
    if (!force && c.mount !== null && c.mount.key === key) return
    await unmount(c)
    if (token === undefined) {
      notifierOf(c)?.setEnabled(false)
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
    ...(c.def.kind !== undefined ? { kind: c.def.kind } : {}),
    account: rt.secretValue(c.def.secret) !== undefined ? c.def.account(saved(c)) : null,
    ...(c.def.extra !== undefined ? c.def.extra(rt.secretValue(c.def.secret) !== undefined ? saved(c) : undefined) : {}),
    // #1266: one row, two modes. `mode` is which one is live (null before the first connect), `modes`
    // is what the form renders, and `allowed` is the guest list the app mode's gate reads. Nothing
    // here carries a secret: the App ID is not one, and the webhook never comes back.
    ...(c.def.id === FEISHU ? {
      mode: saved(c)?.mode ?? null,
      modes: c.def.modes,
      allowed: (saved(c)?.allowed ?? []).map(entry => ({ openId: entry.openId, name: entry.name ?? entry.openId })),
      inbound: { ...feishuInbound.view(), app: appOf() === undefined ? 'missing' : 'set' },
    } : {}),
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

  // The Feishu row's own connect (#1266): one row, two modes. `credentials` is one field per
  // credential the picked mode declares — the App ID is kept in the record because it is not a
  // secret, the App Secret goes only to secrets.js. App mode proves the pair with one tenant token,
  // then `sync` opens the socket; webhook mode proves the URL with one test message, as phase 1 did.
  const connectChannel = async (c, body) => {
    // A phase-1 client sends one `token` and no mode: that is the webhook, unchanged (#1266).
    const mode = body.mode === 'app' ? 'app'
      : body.mode === 'webhook' || (body.mode === undefined && typeof body.token === 'string' && body.token.trim() !== '') ? 'webhook'
        : undefined
    if (mode === undefined) throw new Error('Choose how to connect Feishu first')
    if (c.insecure) throw new Error(INSECURE(c.def.name))
    await rt.loadSecrets()
    const given = body.credentials !== null && typeof body.credentials === 'object' && body.credentials !== undefined ? body.credentials : {}
    const text = name => (typeof given[name] === 'string' ? given[name].trim() : '')
    if (mode === 'webhook') {
      const webhook = text('webhook') !== '' ? text('webhook') : (typeof body.token === 'string' ? body.token.trim() : '')
      if (webhook === '') throw new Error('Paste the webhook URL Feishu gave you')
      const previous = saved(c) ?? {}
      c.saving += 1
      try {
        await rt.secretEndpoint('secret-set', { name: FEISHU_SECRET, value: webhook, purpose: c.def.purpose })
        state.connectors = { ...state.connectors, [FEISHU]: { ...previous, mode: 'webhook', connectedAt: Date.now() } }
        await rt.save()
      } finally {
        c.saving -= 1
      }
      // Phase 1's connect, unchanged: the webhook is saved first and then proved with one test
      // message, so a refusal leaves the row in `error` with Try again beside it instead of losing
      // what the owner pasted (acceptance 5, #1266).
      await feishuInbound.stop()
      await probe(c, webhook)
      c.mount = { key: `webhook\n${webhook}` }
      notifierOf(c)?.setEnabled(true)
      return connectorsView()
    }
    const appId = text('app_id')
    const appSecret = text('app_secret')
    if (appId === '' || appSecret === '') throw new Error('Paste the App ID and App Secret Feishu gave the app')
    await feishuAppCheck({ appId, appSecret }, { api: c.options.api })
    c.saving += 1
    try {
      await rt.secretEndpoint('secret-set', { name: APP_SECRET_SECRET, value: appSecret, purpose: 'Feishu app secret' })
      // The guest list survives a re-pair: connecting again is not a decision to let strangers in.
      const previous = saved(c) ?? {}
      state.connectors = { ...state.connectors, [FEISHU]: { ...previous, mode: 'app', appId, connectedAt: Date.now() } }
      await rt.save()
    } finally {
      c.saving -= 1
    }
    await sync(c)
    return connectorsView()
  }
  // The guest list, written from the row (#1266): Allow adds one open_id, Block takes it away. Who
  // may talk is read by the inbound gate on every message, so this needs no restart — the next
  // message from that sender is treated as the owner's.
  const allowedOp = async (body, on) => {
    const c = known(body.id)
    if (c.def.kind !== 'channel') throw new Error('This connector has no allowed senders')
    const openId = typeof body.openId === 'string' ? body.openId.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(openId)) throw new Error('Paste the open_id of the sender to allow')
    await rt.loadSecrets()
    const record = saved(c) ?? {}
    if (record.mode !== 'app') throw new Error('Connect Feishu as an app first')
    const list = Array.isArray(record.allowed) ? record.allowed : []
    let next
    if (on) {
      const knownSender = (feishuInbound.view().refusedSenders ?? []).find(entry => entry.openId === openId)
      next = list.some(entry => entry.openId === openId) ? list
        : [...list, { openId, ...(knownSender?.name === undefined ? {} : { name: knownSender.name }) }]
    } else {
      next = list.filter(entry => entry.openId !== openId)
    }
    state.connectors = { ...state.connectors, [FEISHU]: { ...record, allowed: next } }
    await rt.save()
    return connectorsView()
  }

  const endpoints = {
    async 'connector-connect'(body) {
      const c = known(body.id)
      // A channel has no single token: its form sends a mode and that mode's credential fields.
      if (c.def.kind === 'channel') return connectChannel(c, body)
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token === '') throw new Error(c.def.paste ?? (c.def.id === GITHUB ? 'Paste a token first' : 'Paste a key first'))
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      const oldToken = rt.secretValue(c.def.secret)
      const previous = saved(c)
      const record = await c.def.check({ token, options: c.options, saved: previous, body })
      c.saving += 1
      try {
        await rt.secretEndpoint('secret-set', { name: c.def.secret, value: token, purpose: c.def.purpose })
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
    // Searches Composio's app list: with the saved key, or before connecting with the key being pasted
    // (sent only to Composio, never saved by this call).
    async 'connector-app-search'(body) {
      const c = known(body.id)
      if (c.def.id !== COMPOSIO) throw new Error('This connector has no apps to pick')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      const pasted = typeof body.token === 'string' ? body.token.trim() : ''
      const token = pasted !== '' ? pasted : rt.secretValue(c.def.secret)
      if (token === undefined) throw new Error('Paste a key first')
      try {
        return await composioSearchApps(token, { api: c.options.api, query: typeof body.query === 'string' ? body.query : '' })
      } catch (error) {
        throw new Error(reason(error))
      }
    },
    // Whether each picked app is signed in on Composio yet.
    async 'connector-app-status'(body) {
      const c = known(body.id)
      if (c.def.id !== COMPOSIO) throw new Error('This connector has no apps to pick')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      const token = rt.secretValue(c.def.secret)
      const record = saved(c)
      if (token === undefined || record?.session?.id === undefined) throw new Error('Connect Composio first')
      try {
        return await composioAppStatus(token, { api: c.options.api, id: record.session.id, apps: cleanApps(record.apps) })
      } catch (error) {
        throw new Error(reason(error))
      }
    },
    async 'connector-allow'(body) {
      return allowedOp(body, true)
    },
    async 'connector-block'(body) {
      return allowedOp(body, false)
    },
    async 'connector-disconnect'(body) {
      const c = known(body.id)
      await rt.loadSecrets()
      if (c.def.kind === 'channel') {
        // Disconnect closes both (#1266): the socket goes down, the webhook and the app secret are
        // deleted (each only if it is there — deleting a key that is not saved is an error), and the
        // record goes with them, so the row is `off` and no turn can start.
        for (const name of [FEISHU_SECRET, APP_SECRET_SECRET]) {
          if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name })
        }
        if (saved(c) !== undefined) {
          delete state.connectors[c.def.id]
          await rt.save()
        }
        await feishuInbound.stop()
        await rt.forgetConnector?.(c.def.id)
        await sync(c)
        return connectorsView()
      }
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
      // "Try again" is one press for the whole row: a channel re-proves a webhook and dials the
      // socket again (which is how an adapter installed after the first attempt comes up without a
      // restart), and `reconcile` is the only place that dials, so one press is one socket.
      await sync(c, true)
      return connectorsView()
    },
    // One message, on demand, once. Nothing posts room traffic on its own: that is a spam
    // decision the owner has not made (#1263). Feishu's channel offers this only while a webhook is
    // saved (today's behaviour, acceptance 5): app mode answers by itself, it has no room to post to.
    async 'connector-send'(body) {
      const c = known(body.id)
      if (typeof c.def.post !== 'function') throw new Error('This connector sends no messages')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new Error('Type a message first')
      if (c.insecure) throw new Error(INSECURE(c.def.name))
      await rt.loadSecrets()
      if (rt.secretValue(c.def.secret) === undefined) throw new Error(`Connect ${c.def.name} first`)
      const notifier = notifierOf(c)
      // A fresh key per call: two messages with the same text are two messages, not a duplicate.
      const result = await notifier.send({ key: randomUUID(), text })
      const sent = result.state === 'sent' || result.state === 'duplicate'
      const failure = `Feishu refused the message (${result.error ?? result.reason ?? 'no answer'})`
      await keep(c, { ...saved(c), ...(sent ? { lastOkAt: Date.now() } : { lastError: failure }) })
      if (!sent) throw new Error(failure)
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
    // The long connection dials once the secrets are loaded: the App Secret lives there, so dialling
    // before that read would report a missing app that is in fact saved. `reconcile` opens it, so
    // there is exactly one dial per start — a second call here would be two sockets on one record.
    void scrubAddresses().catch(error => rt.warn('ds-bot: connectors: %s', reason(error))).then(() => rt.loadSecrets()).then(async () => {
      await syncAll()
    })
    return () => {
      stopped = true
      feishuWire.off?.()
      feishuWire = { seam: undefined, off: undefined }
      void feishuInbound.stop()
      for (const c of connectors) void unmount(c)
    }
  }, 'ds-bot: connectors')

  Object.assign(rt, { connectorsView, connectorEndpoint, secretsChanged: () => { void syncAll() } })
}

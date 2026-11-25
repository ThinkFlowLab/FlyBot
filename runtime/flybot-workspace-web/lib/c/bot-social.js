// Stream C: this user's DS-Bot talking to Bot Social for cross-user FlyBot features
// (teams, members, invites, messenger, discover). Bot Social relays and stores only the shared
// state; everything private stays on this volume.
//
// Server: the manager-delivered collaboration file (/run/secrets/flybot-workspace-bot-social.json, see
// docs/BOT_SOCIAL.md), loaded with the image's own validator. Identity: the connector token that
// @flybot/social's one-call onboarding saved for that server ($DSH_HOME/bot/flybot-social.json,
// mode 0600). The token is read on use, sent only as a Bearer header to that exact server, and
// never returned, logged or put in an error message.
import { nativeGroupClient } from './native-groups.js'
import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

export const serverKey = (url) => String(url ?? '').trim().replace(/\/+$/, '').toLowerCase()

const fault = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) })
const LOCAL_DIR = '/run/flybot-workspace-social'
const PUBLIC_ORIGIN = process.env.FLYBOT_WORKSPACE_PUBLIC_ORIGIN?.replace(/\/+$/, '')

async function defaultServer() {
  try {
    const { loadBotSocialConfig } = await import('../../../flybot-image/bot-social-config.js')
    return loadBotSocialConfig().server
  } catch { return undefined }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function requestOnSocket(socketPath, host, path, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    // Node's HTTP client does not enable chunked transfer for DELETE by default.
    // Frame every serialized JSON body so all methods reach Bot Social intact.
    const length = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }
    const req = httpRequest({
      socketPath, path, method, signal, agent: false, headers: { ...headers, ...length, host },
    }, response => {
      const status = response.statusCode
      if (status >= 300 && status < 400) {
        response.resume()
        reject(new Error('Unexpected Bot Social redirect'))
        return
      }
      resolve({
        status,
        ok: status >= 200 && status < 300,
        async json() {
          const chunks = []
          for await (const chunk of response.setEncoding('utf8')) chunks.push(chunk)
          return JSON.parse(chunks.join(''))
        },
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

/**
 * createBotSocial({ dataDir, server?, credentialsPath?, fetch? })
 * server: string | async () => string; defaults to the manager-delivered config.
 */
export function createBotSocial({
  dataDir, server, credentialsPath, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000,
  localSocket = existsSync(LOCAL_DIR) ? join(LOCAL_DIR, 'bot-social.sock') : null,
  localServer = PUBLIC_ORIGIN && PUBLIC_ORIGIN + '/social',
} = {}) {
  const credsPath = credentialsPath ?? join(process.env.DSH_HOME?.trim() || dataDir || '/data', 'bot', 'flybot-social.json')
  const resolveServer = async () => (typeof server === 'function' ? server() : server ?? defaultServer())

  async function connection() {
    const base = await resolveServer()
    if (!base) throw fault('social/not-configured', 'Bot Social is not configured for this DS-Bot yet')
    const creds = readJson(credsPath)
    if (!creds?.token || (creds.server && serverKey(creds.server) !== serverKey(base))) {
      throw fault('social/not-connected', 'This DS-Bot has not joined Bot Social yet; it does so on start')
    }
    return { base: String(base).replace(/\/+$/, ''), token: creds.token, home: creds.home ?? null }
  }

  async function request(method, path, body, {signal} = {}) {
    const { base, token } = await connection()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    let res
    let data
    try {
      const options = {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([controller.signal,signal]) : controller.signal,
        redirect: 'error',
      }
      // The socket belongs to this site's Bot Social. An overridden workspace
      // server must keep using its own origin and credentials.
      res = localSocket && base === localServer && path.startsWith('/v1/ot/')
        ? await requestOnSocket(localSocket, new URL(base).host, path, options)
        : await fetchImpl(base + path, options)
      try { data = await res.json() } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    } catch {
      throw fault('social/unreachable', 'Bot Social could not be reached')
    } finally { clearTimeout(timer) }
    if (!res.ok) {
      const code = typeof data?.error?.code === 'string' ? data.error.code.slice(0, 60) : `http_${res.status}`
      const message = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : `Bot Social answered ${res.status}`
      throw fault(`social/${code}`, message, res.status)
    }
    return data
  }

  return {
    connection,
    request,
    get: (path,options) => request('GET',path,undefined,options),
    post: (path, body = {}) => request('POST', path, body),
    put: (path, body = {}) => request('PUT', path, body),
    patch: (path, body = {}) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
    async status() {
      try {
        const { base, home } = await connection()
        const me = await request('GET', '/v1/ot/me')
        return { connected: true, server: base, home_handle: home?.handle ?? null, handle: me.handle, display_name: me.display_name }
      } catch (error) {
        return { connected: false, reason: error.code ?? 'social/error', message: error.message }
      }
    },
    async identity() {
      // Non-secret attestation for the platform migrate planner. Never returns a token.
      try {
        const { home } = await connection()
        const me = await request('GET', '/v1/ot/me')
        const homeId = home?.bot_id || home?.id || null
        if (!me?.owner_id || !homeId) {
          return { connected: false, reason: 'identity_unavailable', social_owner_id: me?.owner_id ?? null, home_id: homeId, home_handle: home?.handle ?? null, platform_user_id: me?.platform_user_id ?? null }
        }
        return {
          connected: true,
          social_owner_id: me.owner_id,
          home_id: homeId,
          home_handle: home?.handle ?? me.handle ?? null,
          platform_user_id: me.platform_user_id ?? null,
        }
      } catch (error) {
        return { connected: false, reason: error.code ?? 'social/error' }
      }
    },
  }
}

// Path segment helpers: ids and handles from the browser never shape the URL beyond one segment.
const SEGMENT = /^[A-Za-z0-9@._-]{1,80}$/
export function seg(value, name = 'id') {
  const text = String(value ?? '').trim()
  if (!SEGMENT.test(text)) throw fault('social/invalid', `${name} is invalid`)
  return encodeURIComponent(text)
}

export function qs(params) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') out.set(k, String(v))
  const s = out.toString()
  return s ? `?${s}` : ''
}

// One client per process for the default configuration, shared by the C features.
let shared
export function sharedBotSocial(host) {
  shared ??= createBotSocial({ dataDir: host.dataDir })
  return nativeGroupClient(host, shared)
}
export function setSharedBotSocial(client) { shared = client }

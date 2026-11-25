// Legacy /v1 compatibility for features moved into this DS-Bot, exposed through
// the stable feature extension point as the endpoint '<feature>/v1':
//   POST /api/flybot-workspace {endpoint: 'meetings/v1', payload: {method, path, query?, body?, idempotency_key?}}
// -> {status, body} (legacy JSON shape) or {status, download: {content_type, filename, encoding, data}}.
// The browser half (flybot_workspace/static/shell/dsbot-api.mjs) translates a page's
// legacy fetch calls into this envelope only when the page itself was served by
// the user's own DS-Bot, so the legacy platform keeps working until cutover.
// DSH authenticated the request and the platform gateway pinned it to this
// owner's runtime, so the actor is always this DS-Bot's owner.
import { FeatureError } from './http.js'

export const BODY_LIMIT = 2 * 1024 * 1024
const METHODS = new Set(['GET', 'POST'])
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/

export function parseTarget(raw) {
  if (typeof raw !== 'string' || raw.length < 4 || raw.length > 4096 || !raw.startsWith('/v1/')) return null
  let url
  try { url = new URL(raw, 'http://ot.invalid') } catch { return null }
  const path = url.pathname
  if (path !== raw.split('?')[0] || /\/\.{1,2}(\/|$)|\/\/|\\|%/.test(path)) return null
  return { path, query: url.searchParams }
}

export function matchRoute(routes, path) {
  for (const route of routes) {
    const match = route.pattern.exec(path)
    if (match) return { route, params: match.slice(1) }
  }
  return null
}

const errorBody = (error) => {
  const body = { error: { code: error.code, message: error.message } }
  if (error.current !== undefined) body.error.current = error.current
  return body
}

export function createV1Endpoint({ feature, routes, context }) {
  return async (payload, call) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(new Error('payload object required'), { code: `${feature}/invalid` })
    }
    const method = String(payload.method ?? 'GET').toUpperCase()
    let path = payload.path
    // Ordinary download navigation reaches the gateway with path and query split.
    if (typeof path === 'string' && !path.includes('?') && typeof payload.query === 'string' && payload.query) {
      path += '?' + payload.query
    }
    const target = parseTarget(path)
    if (!METHODS.has(method) || !target) return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
    const found = matchRoute(routes, target.path)
    if (!found) return { status: 404, body: { error: { code: 'not_moved', message: 'This route is not served by DS-Bot yet' } } }
    const headers = new Headers()
    if (typeof payload.idempotency_key === 'string') headers.set('idempotency-key', payload.idempotency_key)
    const raw = payload.body
    const username = call?.request?.headers?.get('x-ot-owner-username') ?? process.env.FLYBOT_WORKSPACE_OWNER_USERNAME ?? ''
    const req = {
      ...context,
      method,
      path: target.path,
      query: target.query,
      queryString: target.query.toString(),
      headers,
      ownerUsername: USERNAME.test(username) ? username : '',
      params: found.params,
      signal: call?.request?.signal,
      now: Math.floor(Date.now() / 1000),
      async json(limit = BODY_LIMIT) {
        if (raw === undefined || raw === null) return {}
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new FeatureError(400, 'invalid', 'JSON object body required')
        if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > limit) throw new FeatureError(413, 'too_large', 'Request body too large')
        return raw
      },
    }
    try {
      const result = (await found.route.handle(req, ...found.params)) ?? {}
      const status = result.status ?? 200
      if (result.raw !== undefined) {
        const bytes = typeof result.raw === 'string' ? Buffer.from(result.raw, 'utf8') : Buffer.from(result.raw)
        return {
          status,
          download: {
            content_type: result.headers?.['content-type'] ?? 'application/octet-stream',
            filename: result.filename ?? /filename="([^"]+)"/.exec(result.headers?.['content-disposition'] ?? '')?.[1] ?? 'download',
            ...(result.inline ? {inline:true} : {}),
            encoding: 'base64',
            data: bytes.toString('base64'),
          },
        }
      }
      return { status, body: result.body ?? {} }
    } catch (error) {
      if (error instanceof FeatureError) return { status: error.status, body: errorBody(error) }
      context.log?.(`v1 ${method} ${target.path} failed: ${String(error?.message ?? error).slice(0, 200)}`)
      return { status: 500, body: { error: { code: 'internal', message: 'Internal service error' } } }
    }
  }
}

// Owner id for created_by/updated_by: the platform user id when the manager
// provides it, otherwise a fixed marker (this DS-Bot has exactly one owner).
export function ownerId(env = process.env) {
  const value = String(env.FLYBOT_WORKSPACE_OWNER_USER_ID ?? '')
  return /^[0-9a-f]{32}$/.test(value) ? value : 'owner'
}

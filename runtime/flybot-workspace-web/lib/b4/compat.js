// Legacy /v1 compatibility for features moved into the user's DS-Bot.
// A feature lists routes [{ method, path: RegExp, handle({ match, query, body, method }) -> [status, body] }]
// and exposes compatHandler(routes) as its `v1` endpoint. The platform gateway
// (or a page shim) forwards a moved request as POST /api/flybot-workspace
// {endpoint: '<feature>/v1', payload: {method, path, query, body}} and gets back
// the same {status, body} the Flask route returned, so pages work unchanged.
import { Fault } from './http.js'

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const QUERY_LIMIT = 512
const error = (status, code, message) => ({ status, body: { error: { code, message } } })

export function compatHandler(routes) {
  const maxQuery = Math.max(QUERY_LIMIT, ...routes.map(route => route.queryLimit ?? QUERY_LIMIT))
  return async (payload, call) => {
    const method = String(payload?.method ?? '').toUpperCase()
    const rawPath = payload?.path
    const embedded = typeof rawPath === 'string' ? rawPath.indexOf('?') : -1
    const path = embedded >= 0 ? rawPath.slice(0, embedded) : rawPath
    const explicitQuery = typeof payload?.query === 'string' ? payload.query.replace(/^\?/, '') : ''
    if (embedded >= 0 && explicitQuery) return error(400, 'invalid', 'Ambiguous compat query')
    const query = embedded >= 0 ? rawPath.slice(embedded + 1) : explicitQuery
    if (!METHODS.has(method) || typeof path !== 'string' || !path.startsWith('/v1/') || path.includes('#') || query.includes('#') || path.length > 256 || query.length > maxQuery) {
      return error(400, 'invalid', 'Invalid compat request')
    }
    if (method !== 'GET' && query) return error(400, 'invalid', 'Query parameters are not accepted for writes')
    let pathMatched = false
    for (const route of routes) {
      const match = route.path.exec(path)
      if (!match || match.index !== 0 || match[0] !== path) continue
      pathMatched = true
      if (query.length > (route.queryLimit ?? QUERY_LIMIT)) return error(400, 'invalid', 'Invalid compat request')
      if (route.method !== method) continue
      try {
        const [status, body, download] = await route.handle({ match, query, body: payload.body, method, idempotency_key: payload.idempotency_key }, call)
        return { status, body, ...(download ? {download} : {}) }
      } catch (caught) {
        if (caught instanceof Fault) {
          const body = { error: { code: caught.code, message: caught.message } }
          if (caught.current !== undefined) body.error.current = caught.current
          return { status: caught.status, body }
        }
        return error(500, 'internal', 'Internal service error')
      }
    }
    if (query.length > QUERY_LIMIT) return error(400, 'invalid', 'Invalid compat request')
    return pathMatched ? error(405, 'method', 'Method not supported') : error(404, 'not_moved', 'Route is not served by this DS-Bot')
  }
}

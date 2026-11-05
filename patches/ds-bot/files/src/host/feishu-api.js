const ORIGIN = 'https://open.feishu.cn/open-apis/'
export class FeishuError extends Error {
  constructor(code, detail = '') { super(`Feishu refused the request (${code})${detail ? `: ${detail}` : ''}`); this.code = code; this.detail = detail }
}
export function createFeishuApi(credentials, request = fetch, checkApplication = () => {}) {
  let cached
  async function token() {
    if (cached?.until > Date.now()) return cached.value
    const creds = await credentials()
    if (!creds) throw new Error('Feishu credentials are missing')
    const res = await request(`${ORIGIN}auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }), redirect: 'error', signal: AbortSignal.timeout(15000) })
    const body = await res.json()
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) { const error = new FeishuError(body.code ?? res.status); error.stage = 'credentials'; throw error }
    cached = { value: body.tenant_access_token, until: Date.now() + Math.max(0, (Number(body.expire ?? 0) - 60) * 1000) }
    return cached.value
  }
  async function call(method, path, { body, query, raw = false, authorize } = {}) {
    if (!/^[a-z][a-z0-9_-]*\/v[1-9]\//.test(path) || path.includes('..') || /[?#\\]/.test(path)) throw new Error('Invalid Feishu API path')
    const url = new URL(path, ORIGIN)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const access = await token()
    checkApplication()
    authorize?.()
    const form = body instanceof FormData
    const res = await request(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${access}`, ...(!form && body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}) })
    if (raw && res.ok) return res
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.code !== 0) throw new FeishuError(data.code ?? res.status, typeof data.msg === 'string' ? data.msg.slice(0, 400) : '')
    return data.data ?? data
  }
  return { call, clear: () => { cached = undefined } }
}

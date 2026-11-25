import { WEBSITE_HTML, WEBSITE_PREVIEW_CSP, WEBSITE_PREVIEW_PATH, websitePreviewRevision } from '../lib/website-preview.js'

// POST /api/flybot-workspace: one JSON channel for every FlyBot feature that has
// moved into the user's DS-Bot. Endpoints come from features/<name>/index.js
// (see src/features.js) as '<name>/<op>'.
export const API_PATH = '/api/flybot-workspace'
export const PLUGIN_VERSION = '0.2.0'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

const failure = (code, message) => json({ ok: false, error: { code, message, details: {} } })

export const REPLY_STREAM_PATH = '/api/flybot-workspace/reply-stream'
const RUNTIME_ID = /^[a-f0-9]{32}$/
const SEND_KEY = /^[A-Za-z0-9_-]{16,64}$/

export function createReplyStreamDispatch({ endpoints }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async request => {
    if (request.method !== 'GET') return gatewayError(405, 'method', 'Only GET is supported')
    const query = new URL(request.url).searchParams
    const workspace_id = query.get('workspace') || ''
    const id = query.get('agent') || ''
    const conversation_id = query.get('conversation') || ''
    const key = query.get('key') || ''
    if (query.size !== 4 || ![workspace_id,id,conversation_id].every(value => RUNTIME_ID.test(value)) || !SEND_KEY.test(key)) {
      return gatewayError(400, 'invalid', 'Invalid private reply stream')
    }
    try {
      const handler = (await table())['agents/replyStream']
      if (typeof handler !== 'function') return gatewayError(503, 'unavailable', 'Private reply stream is not available')
      return await handler({workspace_id,id,conversation_id,key}, {request,internal:true})
    } catch (error) {
      const status = error?.status
      if (status === 404) return gatewayError(404, 'not_found', 'Reply not found')
      if (status === 429) return gatewayError(429, 'busy', 'Too many reply streams')
      return gatewayError(500, 'unavailable', 'Private reply stream is not available')
    }
  }
}

// endpoints: a table or a function returning a table (or a promise of one), so the
// route can be registered before features finish loading.
export function createDispatch({ endpoints, host = null }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async (request) => {
    let body
    try { body = await request.json() } catch { body = null }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure('flybot-workspace/invalid', 'JSON object body required')
    }
    const name = String(body.endpoint ?? '')
    const current = await table()
    const handler = Object.hasOwn(current, name) ? current[name] : null
    if (!handler) return failure('flybot-workspace/not-found', `Unknown FlyBot endpoint ${name.slice(0, 80)}`)
    try {
      return json({ ok: true, value: await handler(body.payload ?? null, { request, host }) })
    } catch (error) {
      return failure(typeof error?.code === 'string' ? error.code.slice(0, 80) : 'flybot-workspace/error',
        String(error?.message ?? 'Request failed').slice(0, 500))
    }
  }
}

export const GATEWAY_PATH = '/api/flybot-workspace/gateway'

const INVOKE = /^\/v1\/gateway\/agents\/([0-9a-f]{32})\/invocations$/
const STATUS = /^\/v1\/gateway\/invocations\/([0-9a-f]{32})$/
const TOKEN = /^ota_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/

function gatewayJSON(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function gatewayError(status, code, message) {
  return gatewayJSON({ error: { code, message, details: {} } }, status)
}

// External Agent API surface, shaped like the legacy /v1/gateway responses.
export function createGatewayDispatch({ endpoints }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async (request) => {
    const url = new URL(request.url)
    const path = url.searchParams.get('path') || ''
    const token = request.headers.get('x-ot-gateway-token') || ''
    if (!TOKEN.test(token)) return gatewayError(401, 'unauthorized', 'Invalid API key')
    const current = await table()
    const invoke = INVOKE.exec(path)
    const status = STATUS.exec(path)
    try {
      if (invoke && request.method === 'POST') {
        let body
        try { body = await request.json() } catch { body = null }
        const prompt = body && typeof body.prompt === 'string' ? body.prompt : ''
        const idempotency = request.headers.get('idempotency-key') || (body && body.idempotency_key)
        const handler = current['agent-api/invoke']
        if (!handler) return gatewayError(503, 'unavailable', 'External Agent API is not available')
        const value = await handler({ token, agent_id: invoke[1], prompt, idempotency_key: idempotency }, { request, host: null })
        return gatewayJSON({ invocation: value.invocation }, value.status || 202)
      }
      if (status && request.method === 'GET') {
        const handler = current['agent-api/invocation']
        if (!handler) return gatewayError(503, 'unavailable', 'External Agent API is not available')
        const value = await handler({ token, id: status[1] }, { request, host: null })
        return gatewayJSON({ invocation: value.invocation }, 200)
      }
      return gatewayError(404, 'not_found', 'Unknown gateway path')
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code.replace(/^agent-api\//, '') : 'error'
      const http = Number(error?.status) || 500
      return gatewayError(http, code.slice(0, 80), String(error?.message ?? 'Request failed').slice(0, 500))
    }
  }
}

export const LEGACY_PATH = '/api/flybot-workspace/legacy'

const FEATURE = /^[a-z][a-z0-9-]{0,39}$/
const V1_PATH = /^\/v1\/[A-Za-z0-9/_.-]{1,240}$/
const CHAT_FILE_POST = /^\/v1\/workspaces\/[0-9a-f]{32}\/social\/conversations\/[A-Za-z0-9._-]{1,80}\/messages$/
const AGENT_FILE_POST = /^\/v1\/workspaces\/[0-9a-f]{32}\/agents\/[0-9a-f]{32}\/conversations\/[0-9a-f]{32}\/messages$/
const STICKER_FILE = /^\/v1\/stickers\/[0-9a-f]{32}\/file$/
const CHAT_FILE_MAX = 8 * 1024 * 1024

async function composeAttachments(request, agent) {
  const form = await request.formData()
  const files = form.getAll('file')
  if (!files.length || files.length > (agent ? 4 : 1) || files.some(file => typeof file === 'string' || !file.size)) {
    throw new Error('Select files')
  }
  if (files.reduce((size,file) => size + file.size, 0) > CHAT_FILE_MAX) {
    throw Object.assign(new Error('Files must total 8 MiB or less'), {status:413})
  }
  const attachments = []
  for (const file of files) {
    attachments.push({title:file.name, mime:file.type, data:Buffer.from(await file.arrayBuffer()).toString('base64')})
  }
  if (agent) return {body:form.get('body'), chat_language:form.get('chat_language'),
    reply_language:form.get('reply_language'), attachments}
  const fields = form.getAll('agent_mentions')
  const raw = fields[0]
  if (fields.length > 1 || (raw !== undefined && (typeof raw !== 'string' || raw.length > 8192))) {
    throw new Error('Invalid group agent mentions')
  }
  const mentions = raw === undefined ? undefined : JSON.parse(raw)
  if (raw !== undefined && (!Array.isArray(mentions) || !mentions.length || mentions.length > 20)) {
    throw new Error('Invalid group agent mentions')
  }
  return {attachment:attachments[0], body:form.get('body') ?? undefined, reply_to:form.get('reply_to') ?? undefined,
    ...(mentions ? {agent_mentions:mentions} : {})}
}

function fileResponse(request, {data, content_type, filename, inline}) {
  const safeName = filename.replace(/[^ -~]|["\\]/g, '_')
  const utf8Name = encodeURIComponent(filename.toWellFormed()).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))
  const headers = {
    'content-type': content_type,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${utf8Name}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  }
  const bytes = Buffer.from(data, 'base64')
  if (request.method === 'HEAD') {
    headers['content-length'] = String(bytes.length)
    if (inline) headers['accept-ranges'] = 'bytes'
    return new Response(null, {status:200, headers})
  }
  if (inline) {
    headers['accept-ranges'] = 'bytes'
    // A single byte range is enough for native media playback and seeking.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '')
    if (range && (range[1] || range[2])) {
      const first = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]))
      const last = Math.min(bytes.length - 1, range[1] && range[2] ? Number(range[2]) : bytes.length - 1)
      if (first >= bytes.length || first > last) {
        return new Response(null, {status:416, headers:{...headers, 'content-range':`bytes */${bytes.length}`}})
      }
      headers['content-range'] = `bytes ${first}-${last}/${bytes.length}`
      headers['content-length'] = String(last - first + 1)
      return new Response(bytes.subarray(first, last + 1), {status:206, headers})
    }
  }
  headers['content-length'] = String(bytes.length)
  return new Response(bytes, {status:200, headers})
}

// Session-authenticated /v1 compatibility: the platform forwards a moved route
// here with the original method and body. The answer is the legacy Flask shape
// ({...body} at the feature's status), not {ok, value}.
function isPersonalChatDirectory(request, feature, path, query) {
  if (request.method !== 'GET' || feature !== 'teams' || path !== '/v1/workspaces') return false
  const params = new URLSearchParams(query)
  return params.get('scope') === 'personal' && params.get('include') === 'chat' &&
    [...params.keys()].every(key => ['scope', 'include', 'workspace', 'directory'].includes(key) && params.getAll(key).length === 1)
}

export function createLegacyDispatch({ endpoints, chatDirectory }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async (request) => {
    const url = new URL(request.url)
    const feature = url.searchParams.get('feature') || ''
    const path = url.searchParams.get('path') || ''
    const query = url.searchParams.get('query') || ''
    if (!FEATURE.test(feature) || !V1_PATH.test(path)) {
      return new Response(JSON.stringify({ error: { code: 'invalid', message: 'Invalid legacy path' } }), {
        status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    // Transcript entry links can need saved works and meeting sources. Scope
    // this fast path to the directory and keep the normal request context.
    const early = chatDirectory && isPersonalChatDirectory(request, feature, path, query) ? await chatDirectory : undefined
    const handler = early ?? (await table())[`${feature}/v1`]
    if (typeof handler !== 'function') {
      return new Response(JSON.stringify({ error: { code: 'not_moved', message: 'Route is not served by this DS-Bot' } }), {
        status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    let body
    const agentFiles = feature === 'agents' && AGENT_FILE_POST.test(path)
    const socialFile = feature === 'messenger' && CHAT_FILE_POST.test(path)
    if ((agentFiles || socialFile) && request.method === 'POST'
      && request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
      try { body = await composeAttachments(request, agentFiles) } catch (error) {
        const large = error?.status === 413
        return gatewayError(large ? 413 : 400, large ? 'attachment_too_large' : 'invalid', 'Provide nonempty files totaling up to 8 MiB')
      }
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      const text = await request.text()
      if (text) {
        try { body = JSON.parse(text) } catch {
          return new Response(JSON.stringify({ error: { code: 'invalid', message: 'JSON object body required' } }), {
            status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          })
        }
      }
    }
    try {
      const idempotency_key = request.headers.get('idempotency-key') || undefined
      const stickerHead = request.method === 'HEAD' && feature === 'stickers' && STICKER_FILE.test(path)
      const result = await handler({ method: stickerHead ? 'GET' : request.method, path, query, body, idempotency_key }, { request, host: null })
      const status = Number(result?.status) || 200
      if (result?.download && status === 200) {
        // The interactive document has its own opaque origin. No other
        // artifacts or attachment responses can opt in to this policy.
        if (feature === 'artifacts' && request.method === 'GET'
            && WEBSITE_PREVIEW_PATH.test(path)
            && websitePreviewRevision(new URLSearchParams(query)) !== null
            && result.download.content_type === WEBSITE_HTML) {
          return new Response(Buffer.from(result.download.data, 'base64'), {
            headers: {
              'content-type': WEBSITE_HTML,
              'content-security-policy': WEBSITE_PREVIEW_CSP,
              'cache-control': 'private, no-store',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
            },
          })
        }
        return fileResponse(request, result.download)
      }
      return new Response(status === 204 || stickerHead ? null : JSON.stringify(result?.body ?? {}), {
        status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    } catch (error) {
      const status = Number(error?.status) || 500
      const code = typeof error?.code === 'string' ? error.code.slice(0, 80) : 'error'
      return new Response(JSON.stringify({ error: { code, message: String(error?.message ?? 'Request failed').slice(0, 500) } }), {
        status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
  }
}

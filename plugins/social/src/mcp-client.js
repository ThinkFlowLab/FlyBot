// A minimal client for a Bot Social server's owner MCP endpoint (POST <server>/mcp,
// stateless Streamable HTTP, JSON responses), authenticated by an owner connector token.
// Only tools/call is used; see bot-social src/owner-mcp.ts for the tool set.
// One client instance is reused for the plugin lifetime (seq ids, no initialize per call).
// HTTPS to a remote Bot Social host pays ~2 s per fresh TCP+TLS, so every fetch shares
// one keep-alive http(s).Agent (Node builtins; no extra package).

import http from 'node:http'
import https from 'node:https'

const UNTRUSTED = /^[\s\S]*?\n([\s\S]*)\n[^\n]*$/
const GRANT_CONCURRENCY = 4
const KEEP_ALIVE_MS = 30_000

function makeAgent(Agent) {
  return new Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: KEEP_ALIVE_MS })
}

let sharedHttps
let sharedHttp

export function socialHttpAgent() {
  sharedHttps ??= makeAgent(https.Agent)
  return sharedHttps
}

function agentFor(url) {
  if (String(url).startsWith('http:')) {
    sharedHttp ??= makeAgent(http.Agent)
    return sharedHttp
  }
  return socialHttpAgent()
}

export function fetchOptions(init = {}) {
  return { ...init, agent: init.agent ?? socialHttpAgent() }
}

export function socialFetch(url, init = {}) {
  const parsed = new URL(String(url))
  const lib = parsed.protocol === 'http:' ? http : https
  const agent = init.agent ?? agentFor(url)
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = { ...(init.headers ?? {}) }
  const signal = init.signal
  return new Promise((resolve, reject) => {
    const req = lib.request(parsed, { method, headers, agent }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const headerMap = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          headerMap.set(key, Array.isArray(value) ? value.join(', ') : String(value))
        }
        resolve(new Response(buf, { status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: headerMap }))
      })
    })
    req.on('error', reject)
    if (signal) {
      const abort = () => {
        req.destroy()
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', abort))
    }
    if (init.body) req.write(init.body)
    req.end()
  })
}

export async function mapPool(items, limit, fn) {
  const list = [...items]
  if (list.length === 0) return []
  const cap = Math.max(1, Math.min(limit || GRANT_CONCURRENCY, list.length))
  const out = new Array(list.length)
  let next = 0
  async function worker() {
    for (;;) {
      const at = next++
      if (at >= list.length) return
      out[at] = await fn(list[at], at)
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()))
  return out
}

export { GRANT_CONCURRENCY }

export class BotSocialError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

export const CALL_TIMEOUT_MS = 30_000

export function createMcpClient({ server, token, fetch: fetchImpl = socialFetch, timeoutMs = CALL_TIMEOUT_MS }) {
  if (!server) throw new Error('flybot-social: server URL is required')
  if (!token) throw new Error('flybot-social: owner connector token is required')
  const url = `${server.replace(/\/+$/, '')}/mcp`
  let seq = 0
  async function callTool(name, args = {}) {
    // Every call has a deadline: a hung server is an error, never a stall.
    // Stateless tools/call only: Bot Social's owner MCP does not need initialize, and
    // this client is created once per plugin start (not per Friends' Bots refresh).
    const signal = AbortSignal.timeout(timeoutMs)
    let response
    let body
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
        signal,
      })
      if (!response.ok) throw new BotSocialError(`Bot Social ${name}: HTTP ${response.status}`, `http_${response.status}`)
      body = parseBody(await response.text(), response.headers?.get?.('content-type') ?? '')
    } catch (error) {
      if (error instanceof BotSocialError) throw error
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new BotSocialError(`Bot Social ${name}: no answer in ${Math.round(timeoutMs / 1000)}s`, 'timeout')
      throw error
    }
    if (body.error) throw new BotSocialError(`Bot Social ${name}: ${body.error.message}`, 'rpc')
    const text = body.result?.content?.[0]?.text ?? 'null'
    let data
    try { data = JSON.parse(text) } catch { data = text }
    if (body.result?.isError) throw new BotSocialError(`Bot Social ${name}: ${data?.message ?? text}`, data?.code ?? 'tool')
    return data
  }
  return { callTool }
}

// A JSON body, or a Server-Sent Events stream whose last `data:` line is the JSON-RPC answer.
function parseBody(text, type) {
  if (/text\/event-stream/i.test(type) || /^(event|data|id):/m.test(text.trimStart().slice(0, 6))) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean)
    for (const line of data.reverse()) {
      try { const value = JSON.parse(line); if (value && (value.result !== undefined || value.error !== undefined)) return value } catch {}
    }
    throw new BotSocialError('Bot Social: the event stream had no answer', 'sse')
  }
  return JSON.parse(text)
}

export function isUnknownTool(error) {
  const text = String(error?.message ?? error ?? '')
  const code = String(error?.code ?? '')
  const blob = `${code} ${text}`
  if (/grant_not_found/i.test(blob)) return false
  return code === 'unknown' || /unknown tool|no tool|method not found|unrecognized tool/i.test(text)
}

export function isGrantNotFound(error) {
  const blob = `${error?.code ?? ''} ${error?.reason ?? ''} ${error?.message ?? error ?? ''}`
  return /grant_not_found/i.test(blob)
}

export function isMissingEndpoint(error) {
  if (isGrantNotFound(error)) return false
  const code = String(error?.code ?? '')
  const text = String(error?.message ?? error ?? '')
  return code === 'http_404' || code === 'http_405' || /HTTP 404|HTTP 405/i.test(text)
}

function asList(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.grants)) return value.grants
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.friends)) return value.friends
  return []
}

// Bot Social `publicBot` / grant.grantee may be a handle string or
// `{ handle, display_name, owner_display_name, bot_id }`. Never String() an object:
// that becomes "[object Object]" → "@objectobject".
function handleText(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (typeof value === 'object') return handleText(value.handle ?? value.home ?? value.member ?? '')
  return ''
}

function personNameOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (value && typeof value === 'object') {
    return String(
      value.owner_display_name || value.ownerName
      || value.display_name || value.displayName || '',
    ).trim()
  }
  return ''
}

// Chief@chief.selfb1935.home / @chief.selfb1935.home / @selfb1935.home → a comparable handle.
export function memberHandleOf(value) {
  const raw = handleText(value)
  if (!raw) return ''
  const nested = raw.match(/@([^@\s]+)$/)
  const body = (nested ? nested[1] : raw).replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 120)
  return body ? `@${body}` : ''
}

// A person home from a grant peer: @chief.selfb1935.home → @selfb1935.home.
export function personHomeOf(handle) {
  const key = memberHandleOf(handle)
  if (!key) return ''
  const parts = key.slice(1).split('.')
  if (parts.length >= 2 && parts.at(-1) === 'home') return `@${parts.at(-2)}.home`
  return key
}

function titleHome(home) {
  const part = String(home ?? '').replace(/^@/, '').replace(/\.home$/i, '')
  if (!part) return ''
  return part.charAt(0).toUpperCase() + part.slice(1)
}

export function grantPersonView(grant) {
  const peer = grant && typeof grant === 'object' ? grant.grantee : grant
  const raw = handleText(peer)
    || handleText(grant?.member)
    || handleText(grant?.home)
    || handleText(grant?.handle)
  const member = memberHandleOf(raw)
  const home = personHomeOf(raw)
  const rawName = personNameOf(grant?.name) || personNameOf(peer) || personNameOf(grant)
  const nameLooksLikeHandle = /@/.test(rawName) || /[a-z0-9]+@[a-z0-9.]/i.test(rawName)
  const person = (!nameLooksLikeHandle && rawName) ? rawName.replace(/\s+/g, ' ').trim().slice(0, 60) : titleHome(home)
  const label = home ? `${person} (${home})` : person
  return { home, member, person, label }
}

export function normalizeGrant(item) {
  if (!item || typeof item !== 'object') return undefined
  const grantee = item.grantee ?? item.peer ?? item.handle ?? item.home
  const name = personNameOf(item.name)
    || personNameOf(item.peer)
    || personNameOf(grantee)
    || (typeof item.display_name === 'string' ? item.display_name : '')
  if (!handleText(grantee) && !handleText(item.handle)) return undefined
  const id = item.id ?? item.grant_id ?? item.relationship_id ?? item.relationshipId
  const view = grantPersonView({ grantee, name })
  const canonical = view.member || view.home || memberHandleOf(grantee)
  if (!canonical) return undefined
  return {
    ...(id ? { id: String(id) } : {}),
    // Canonical @handle for core grants.set / normGrantee (not decorated Chief@…).
    grantee: canonical,
    ...(view.label ? { name: view.label } : {}),
    ...(view.home ? { home: view.home } : {}),
    ...(view.member ? { member: view.member } : {}),
    ...(item.relationship_id || item.relationshipId ? { relationshipId: String(item.relationship_id ?? item.relationshipId) } : {}),
    ...(item.room_id || item.roomId ? { roomId: String(item.room_id ?? item.roomId) } : {}),
  }
}

export function normalizeGrants(value) {
  return asList(value).map(normalizeGrant).filter(Boolean)
}

// Owner MCP + REST grant/invite helpers. Named methods so social.js never builds
// URLs or tool names inline. Prefers list_bot_grants / revoke_bot_grant, then
// list_grants / revoke_grant, then REST / list_friends.
export function createSocialApi({ server, token, fetch: fetchImpl = socialFetch, timeoutMs = CALL_TIMEOUT_MS, client } = {}) {
  const mcp = client ?? createMcpClient({ server, token, fetch: fetchImpl, timeoutMs })
  const base = String(server ?? '').replace(/\/+$/, '')

  async function rest(method, path, body) {
    if (!base) throw new BotSocialError(`Bot Social ${method} ${path}: no server URL`, 'no_server')
    if (!token) throw new BotSocialError(`Bot Social ${method} ${path}: no token`, 'no_token')
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
    if (!response.ok) {
      const reason = data?.code ?? data?.error?.code
      const err = new BotSocialError(
        `Bot Social ${method} ${path}: HTTP ${response.status}${reason ? ` ${reason}` : ''}`,
        reason ? String(reason) : `http_${response.status}`,
      )
      err.status = response.status
      err.detail = data
      err.reason = reason
      throw err
    }
    // Grant REST is a last resort when the MCP tool is missing. Connector tokens are
    // forbidden on those /v1 routes (403 connector_token_rest_forbidden); callers catch
    // and fall through. Face-room REST lives in face-rooms.js and is allowed.
    return data
  }

  async function tryTool(name, args, fallback) {
    try {
      return await mcp.callTool(name, args)
    } catch (error) {
      if (typeof fallback === 'function' && isUnknownTool(error)) return fallback(error)
      throw error
    }
  }

  async function listGrants({ botId, relationshipId } = {}) {
    const args = {
      ...(botId ? { bot_id: botId } : {}),
      ...(relationshipId ? { relationship_id: relationshipId } : {}),
    }
    const fromFriends = async () => {
      if (relationshipId && base) {
        try { return await rest('GET', `/v1/relationships/${encodeURIComponent(relationshipId)}/grants`) } catch { /* derive */ }
      }
      const overview = await mcp.callTool('list_friends', botId ? { bot_id: botId } : {})
      return (overview?.friends ?? []).filter(item => item.status === 'active' || item.status === undefined)
    }
    return normalizeGrants(await tryTool('list_bot_grants', args, () => tryTool('list_grants', args, fromFriends)))
  }

  async function revokeGrant({ grantId, relationshipId, botId } = {}) {
    const args = {
      ...(grantId ? { grant_id: grantId } : {}),
      ...(relationshipId ? { relationship_id: relationshipId } : {}),
      ...(botId ? { bot_id: botId } : {}),
    }
    const viaRestOrUnfriend = async () => {
      if (grantId && base) {
        try { return await rest('DELETE', `/v1/grants/${encodeURIComponent(grantId)}`) } catch { /* next */ }
      }
      if (relationshipId && base) {
        const suffix = grantId ? `/${encodeURIComponent(grantId)}` : ''
        try { return await rest('DELETE', `/v1/relationships/${encodeURIComponent(relationshipId)}/grants${suffix}`) } catch { /* next */ }
      }
      if (!relationshipId) throw new BotSocialError('Bot Social revoke_grant: which grant?', 'invalid')
      return mcp.callTool('remove_friend', { relationship_id: relationshipId })
    }
    return tryTool('revoke_bot_grant', args, () => tryTool('revoke_grant', args, viaRestOrUnfriend))
  }

  async function updateBotProfile({ botId, displayName, avatar, color } = {}) {
    const args = {
      ...(botId ? { bot_id: botId } : {}),
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(color !== undefined ? { color } : {}),
    }
    const body = {
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(color !== undefined ? { color } : {}),
    }
    const viaRest = async (error) => {
      if (!botId || !base) {
        if (isUnknownTool(error) || isMissingEndpoint(error)) return { unavailable: true }
        throw error ?? new BotSocialError('Bot Social update_bot_profile: which Bot?', 'invalid')
      }
      try {
        return await rest('PATCH', `/v1/bots/${encodeURIComponent(botId)}/profile`, body)
      } catch (restErr) {
        if (isUnknownTool(restErr) || isMissingEndpoint(restErr)) return { unavailable: true }
        throw restErr
      }
    }
    try {
      return await tryTool('update_bot_profile', args, viaRest)
    } catch (error) {
      if (isUnknownTool(error) || isMissingEndpoint(error)) return { unavailable: true }
      throw error
    }
  }

  async function declineGrant({ grantId, botId } = {}) {
    if (!grantId) throw new BotSocialError('Bot Social decline_bot_grant: which grant?', 'invalid')
    const args = {
      grant_id: grantId,
      ...(botId ? { bot_id: botId } : {}),
    }
    const viaRest = async (error) => {
      if (!base) {
        if (isUnknownTool(error) || isMissingEndpoint(error)) return { unavailable: true }
        throw error ?? new BotSocialError('Bot Social decline_bot_grant: no server URL', 'no_server')
      }
      const suffix = botId ? `?bot_id=${encodeURIComponent(botId)}` : ''
      try {
        return await rest('DELETE', `/v1/remote-bots/${encodeURIComponent(grantId)}${suffix}`)
      } catch (restErr) {
        if (isGrantNotFound(restErr)) return { grant_id: grantId, status: 'declined', gone: true }
        if (isUnknownTool(restErr) || isMissingEndpoint(restErr)) return { unavailable: true }
        throw restErr
      }
    }
    try {
      return await tryTool('decline_bot_grant', args, viaRest)
    } catch (error) {
      if (isGrantNotFound(error)) return { grant_id: grantId, status: 'declined', gone: true }
      if (isUnknownTool(error) || isMissingEndpoint(error)) return { unavailable: true }
      throw error
    }
  }

  return {
    callTool: (name, args) => mcp.callTool(name, args),
    rest,
    listRemoteBots: args => mcp.callTool('list_remote_bots', args),
    listFriends: args => mcp.callTool('list_friends', args ?? {}),
    createInvite: args => mcp.callTool('create_invite', args),
    joinInvite: args => mcp.callTool('join_invite', args),
    listInvites: args => mcp.callTool('list_invites', args ?? {}),
    revokeInvite: args => mcp.callTool('revoke_invite', args),
    respondFriendRequest: args => mcp.callTool('respond_friend_request', args),
    removeFriend: args => mcp.callTool('remove_friend', args),
    listApprovals: args => mcp.callTool('list_approvals', args),
    decideApproval: args => mcp.callTool('decide_approval', args),
    whoami: args => mcp.callTool('whoami', args ?? {}),
    setAutoApprove: args => mcp.callTool('set_auto_approve', args),
    addHomeMember: args => mcp.callTool('add_home_member', args),
    removeHomeMember: args => mcp.callTool('remove_home_member', args),
    listInbox: args => mcp.callTool('list_inbox', args),
    sendAsMember: args => mcp.callTool('send_as_member', args),
    listGrants,
    revokeGrant,
    updateBotProfile,
    declineGrant,
  }
}

// The server fences peer text as a string between markers; this returns the text alone.
export function untrustedText(value) {
  if (typeof value !== 'string') return String(value?.text ?? '')
  const inner = value.match(UNTRUSTED)?.[1] ?? value
  try {
    return String(JSON.parse(inner)?.text ?? inner)
  } catch {
    return inner
  }
}

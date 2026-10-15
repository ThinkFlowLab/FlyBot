// Face-to-face rooms (#83): join by a 6-digit number on Bot Social. This module is the
// client contract — REST against docs/FACE_ROOMS.md — plus error mapping, event rendering
// and sanitization of peer-controlled strings. The host (social.js) calls the server with
// the connector token; the browser shows the friendly copy these helpers return.
//
// Peer text is untrusted: fence it before anything model-visible. Platform system copy
// (joined / left / started) is sanitized the same way as a display name.

import { socialFetch } from './mcp-client.js'

export const FACE_JOIN_CODE = /^\d{6}$/
export const FACE_MAX_MEMBERS = 8
export const FACE_TTL_MS = 10 * 60 * 1000

const CALL_TIMEOUT_MS = 30_000
const NAME_MAX = 60
const SEEN_KEPT = 200

export class FaceRoomError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.code = code
    this.retryAfter = extra.retryAfter
    this.scope = extra.scope
    this.status = extra.status
    this.confirmCode = extra.confirmCode
  }
}

export const isJoinCode = (value) => FACE_JOIN_CODE.test(String(value ?? '').trim())

// Same class of sanitizer as core cleanName / cleanPeerName: one line, no controls,
// brackets, markup or @, capped. Used for every peer-controlled name and for platform
// system copy that embeds those names.
export function cleanFaceName(value, fallback = 'a remote Bot') {
  const text = stripFaceMarkers(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[[\]"<>`@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
  return text || fallback
}

export function stripFaceMarkers(text) {
  let out = String(text ?? '')
  for (let previous; previous !== out;) {
    previous = out
    out = out.replace(/<\/?\s*untrusted-(?:file|message)/gi, '')
  }
  return out
}

export function fenceFaceText(name, text) {
  const who = cleanFaceName(name)
  return `<untrusted-message from="${who}">\n${stripFaceMarkers(text)}\n</untrusted-message>`
}

const UNTRUSTED = /^[\s\S]*?\n([\s\S]*)\n[^\n]*$/
export function faceUntrustedText(value) {
  if (value && typeof value === 'object') return String(value.text ?? '')
  if (typeof value !== 'string') return String(value ?? '')
  const inner = value.match(UNTRUSTED)?.[1] ?? value
  try { return String(JSON.parse(inner)?.text ?? inner) } catch { return inner }
}

export function formatRetryAfter(seconds) {
  const n = Math.max(1, Math.ceil(Number(seconds) || 0))
  if (n < 60) return `${n} second${n === 1 ? '' : 's'}`
  const m = Math.ceil(n / 60)
  return `${m} minute${m === 1 ? '' : 's'}`
}

export function countdownLabel(expiresAt, now = Date.now()) {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return ''
  const left = Math.max(0, at - now)
  if (left <= 0) return 'The matching window has ended'
  const minutes = Math.ceil(left / 60_000)
  if (minutes >= 2) return `${minutes} minutes left to join`
  const seconds = Math.max(1, Math.ceil(left / 1000))
  return seconds === 1 ? '1 second left to join' : `${seconds} seconds left to join`
}

const FRIENDLY = {
  invalid_code: 'Enter a 6-digit number.',
  invalid_request: 'That request was not valid.',
  unauthorized: 'Bot Social signed you out. Reconnect in Friends\' Bots, or restart FlyBot.',
  forbidden: 'This Bot cannot join that room.',
  bot_revoked: 'This Bot is no longer available on Bot Social.',
  bot_not_found: 'That Bot is not one of yours on Bot Social.',
  face_room_not_found: 'That room is not available.',
  room_full: 'This room already has 8 Bots. Nobody else can join with this number.',
  code_void: 'This number is no longer valid. The room already started.',
  room_closed: 'This room has closed.',
  not_a_member: 'You are no longer in this room.',
  dlp_blocked: 'That message was blocked and was not sent.',
  connector_token_rest_forbidden: 'Bot Social would not save that setting with this connection. Restart FlyBot or reconnect in Friends\' Bots.',
  confirmation_required: 'Bot Social asked for a confirmation. Try the toggle again.',
  handle_taken: 'That Bot Social handle is already taken. Rename the Bot and try again.',
}

// MCP add_home_member failures at face-to-face join: same friendly class as REST join errors,
// never a raw tool code. Registration is retried from a clean local state (no leftover member).
export function mapRegisterError(error, bot) {
  if (error instanceof FaceRoomError) return error
  const name = bot?.name ? String(bot.name) : 'this Bot'
  const code = String(error?.code ?? '')
  const msg = String(error?.message ?? error ?? '')
  const retryAfter = error?.retryAfter ?? error?.retry_after
  if (code === 'handle_taken' || /handle[_ ]taken|taken|exists|conflict|duplicate|in use|another Bot's Bot Social identity/i.test(msg)) {
    return new FaceRoomError(`${name} could not join: ${FRIENDLY.handle_taken}`, 'handle_taken')
  }
  if (code === 'rate_limited' || code === 'http_429' || /429|rate.?limit/i.test(code + msg)) {
    return mapFaceError({ error: { code: 'rate_limited', retry_after: retryAfter } }, 429)
  }
  if (code === 'timeout' || /no answer in|TimeoutError|AbortError/i.test(msg)) {
    return new FaceRoomError(`Bot Social did not answer while registering ${name}. Try again.`, 'timeout')
  }
  if (code === 'http_401' || code === 'http_403' || code === 'unauthorized' || /401|403|unauthori[sz]ed|token/i.test(code + msg)) {
    return new FaceRoomError(FRIENDLY.unauthorized, 'unauthorized', { status: 401 })
  }
  const raw = msg.replace(/^Bot Social\s+\S+:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const detail = raw && !/^[a-z_]+$/.test(raw) ? `: ${raw}` : '. Try again.'
  return new FaceRoomError(`Could not register ${name} on Bot Social${detail}`, code || 'register_failed')
}

export function mapFaceError(data, status) {
  const err = data?.error
  const payload = typeof err === 'string'
    ? { code: err, message: data?.message, retry_after: data?.retry_after, scope: data?.scope, confirm_code: data?.confirm_code }
    : (err && typeof err === 'object'
      ? { code: err.code, message: err.message, retry_after: err.retry_after ?? data?.retry_after, scope: err.scope, confirm_code: err.confirm_code ?? data?.confirm_code }
      : { code: data?.code, message: data?.message, retry_after: data?.retry_after, scope: data?.scope, confirm_code: data?.confirm_code })
  const code = String(payload.code ?? '')
  const retryAfter = payload.retry_after
  const confirmCode = payload.confirm_code ? String(payload.confirm_code) : undefined
  let message = FRIENDLY[code]
  if (code === 'rate_limited') {
    message = retryAfter != null
      ? `Too many attempts. Try again in ${formatRetryAfter(retryAfter)}.`
      : 'Too many attempts. Try again in a few minutes.'
  } else if (code === 'locked_out') {
    message = retryAfter != null
      ? `Too many failed attempts. Try again in ${formatRetryAfter(retryAfter)}.`
      : 'Too many failed attempts. Try again later.'
  } else if (!message) {
    const raw = String(payload.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    message = raw && !/^[a-z_]+$/.test(raw) ? raw : 'Could not join that room. Try another number.'
    if (status === 401) message = FRIENDLY.unauthorized
    else if (status === 429) message = retryAfter != null
      ? `Too many attempts. Try again in ${formatRetryAfter(retryAfter)}.`
      : 'Too many attempts. Try again in a few minutes.'
  }
  return new FaceRoomError(message, code || 'face_room_error', { retryAfter, scope: payload.scope, status, confirmCode })
}

export function viewMe(body) {
  if (!body || typeof body !== 'object') return undefined
  return { autoApproveFaceRooms: body.auto_approve_face_rooms === true }
}

function confirmationCode(value) {
  if (!value || typeof value !== 'object') return ''
  if (value instanceof FaceRoomError) return String(value.confirmCode || '')
  if (value.status === 'confirmation_required' || value.code === 'confirmation_required') {
    return String(value.confirm_code || value.confirmCode || '')
  }
  const err = value.error
  if (err && typeof err === 'object' && err.code === 'confirmation_required') {
    return String(err.confirm_code || err.confirmCode || value.confirm_code || '')
  }
  return ''
}

// Face join of my own Bot is a room-scoped grant. True when this Bot has no person-grant.
export function roomOnlyForJoin(bot, hasAnyGrant) {
  if (typeof hasAnyGrant === 'function') return hasAnyGrant(typeof bot === 'string' ? bot : bot?.id) !== true
  return bot?.granted !== true && bot?.published !== true
}

/** @deprecated published is gone; room-only is the face-join default. */
export function publishedForJoin(bot, isPublished) {
  return !roomOnlyForJoin(bot, typeof isPublished === 'function' ? id => isPublished(id) : undefined)
}

export function faceMemberLabel(member) {
  const name = cleanFaceName(member?.display_name || member?.displayName || member?.name, 'Bot')
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, '')
  if (!owner) return name
  if (/^chief$/i.test(name)) return `${owner}'s Chief`
  return `${name} · ${owner}'s Bot`
}

export function platformJoinText(member) {
  const name = cleanFaceName(member?.display_name || member?.displayName, 'Bot')
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, 'Someone')
  // Server copy; we rebuild from sanitized fields so a poisoned payload cannot instruct.
  if (member?.roomOnly === true || member?.published !== true) return `${owner}'s ${name} joined; available to this room only`
  return `${owner}'s ${name} joined`
}

export function platformLeaveText(member) {
  const name = cleanFaceName(member?.display_name || member?.displayName, 'Bot')
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, 'Someone')
  return `${owner}'s ${name} left`
}

export function platformStartedText(reason) {
  if (reason === 'expired') return 'The matching window ended. The room is now open. The number is no longer valid.'
  return 'The room is now open. The number is no longer valid.'
}

// Peer look is optional: only pass through a stored color / avatar when the payload
// actually has one. Image URLs stay one line, no markup; a missing look is fine — the
// client then uses the host BotMark seeded by handle.
export function faceMemberLook(member) {
  if (!member || typeof member !== 'object') return {}
  const out = {}
  const color = typeof member.color === 'string' ? member.color.trim().slice(0, 32) : ''
  if (color && !/[\n<>]/.test(color)) out.color = color
  const src = member.avatar && typeof member.avatar === 'object' ? member.avatar : {}
  const avatar = {}
  if (typeof src.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(src.shape)) avatar.shape = src.shape
  const image = typeof src.image === 'string' ? src.image.trim() : (typeof member.image === 'string' ? member.image.trim() : '')
  if (image && image.length < 2048 && /^(https?:\/\/|data:image\/)/i.test(image) && !/[\s<>]/.test(image)) avatar.image = image
  const emoji = typeof src.emoji === 'string' ? src.emoji.trim() : (typeof member.emoji === 'string' ? member.emoji.trim() : '')
  if (emoji && !/[\n<>]/.test(emoji)) avatar.emoji = emoji.slice(0, 8)
  if (Object.keys(avatar).length) out.avatar = avatar
  return out
}

export function viewFaceMember(member) {
  if (!member || typeof member !== 'object') return undefined
  const handle = normHandle(member.handle)
  return {
    botId: member.bot_id || member.botId,
    handle,
    displayName: cleanFaceName(member.display_name || member.displayName, handle || 'Bot'),
    ownerName: cleanFaceName(member.owner_name || member.ownerName, ''),
    roomOnly: member.roomOnly === true || member.published !== true,
    label: cleanFaceName(member.label, '') || faceMemberLabel(member),
    ...faceMemberLook(member),
  }
}

export function viewFaceRoom(body) {
  if (!body || typeof body !== 'object') return undefined
  const roomId = String(body.room_id || body.roomId || '')
  if (!roomId) return undefined
  return {
    roomId,
    status: body.status === 'open' || body.status === 'closed' ? body.status : 'candidate',
    expiresAt: body.expires_at || body.expiresAt || null,
    startedAt: body.started_at || body.startedAt || null,
    closedAt: body.closed_at || body.closedAt || null,
    eventCursor: Number(body.event_cursor ?? body.eventCursor ?? 0) || 0,
    members: (body.members ?? []).map(viewFaceMember).filter(Boolean),
    events: (body.events ?? []).map(viewFaceEvent).filter(Boolean),
    memberCount: Number(body.member_count ?? body.members?.length ?? 0) || 0,
    myBots: (body.my_bots ?? body.myBots ?? []).map(viewFaceMember).filter(Boolean),
  }
}

const INBOX_TYPES = {
  'face_room.joined': 'member.joined',
  'face_room.left': 'member.left',
  'face_room.started': 'room.started',
  'face_room.message': 'room.message',
  joined: 'member.joined',
  left: 'member.left',
  started: 'room.started',
  message: 'room.message',
}

export function viewFaceEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  const raw = String(event.type || event.event_type || '')
  const mapped = INBOX_TYPES[raw] || raw
  if (!mapped) return undefined
  const member = event.member ? viewFaceMember(event.member) : undefined
  const from = event.from ? viewFaceMember(event.from) : undefined
  return {
    eventId: String(event.event_id || event.eventId || ''),
    eventCursor: Number(event.event_cursor ?? event.eventCursor ?? 0) || 0,
    type: mapped,
    createdAt: event.created_at || event.createdAt,
    actorBot: event.actor_bot || event.actorBot,
    reason: event.reason,
    trust: event.trust,
    member,
    from,
    text: mapped === 'room.message' ? undefined : sanitizePlatformText(event.text, mapped, member, event.reason),
    untrustedText: mapped === 'room.message' ? stripFaceMarkers(faceUntrustedText(event.untrusted_content ?? event.untrustedContent ?? event.untrustedText)) : undefined,
  }
}

function sanitizePlatformText(text, type, member, reason) {
  // Rebuild join/leave/start from sanitized fields so a 60-char name cap cannot
  // truncate the sentence, and a poisoned `text` cannot instruct.
  if (type === 'member.joined' && member) return platformJoinText(member)
  if (type === 'member.left' && member) return platformLeaveText(member)
  if (type === 'room.started') return platformStartedText(reason)
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[[\]"<>`@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return cleaned
}

export function renderFaceEvent(event) {
  const viewed = viewFaceEvent(event)
  if (!viewed) return undefined
  if (viewed.type === 'room.message') {
    const from = viewed.from || {}
    const label = from.label || faceMemberLabel(from)
    const body = viewed.untrustedText ?? ''
    return {
      kind: undefined,
      system: false,
      who: label,
      text: body,
      fenced: fenceFaceText(label, body),
      authorId: from.handle,
      authorKind: 'bot',
      remote: true,
      ownerName: from.ownerName,
      trust: 'peer_untrusted',
      eventId: viewed.eventId,
      eventCursor: viewed.eventCursor,
    }
  }
  const kind = viewed.type === 'member.left' ? 'left' : viewed.type === 'room.started' ? 'started' : 'joined'
  return {
    kind,
    system: true,
    who: 'Room',
    text: viewed.text,
    authorKind: 'system',
    trust: 'platform',
    eventId: viewed.eventId,
    eventCursor: viewed.eventCursor,
    member: viewed.member,
    reason: viewed.reason,
  }
}

export function rememberEvent(seen, eventId) {
  if (!eventId) return seen
  if (seen.includes(eventId)) return seen
  const next = [...seen, eventId]
  return next.length > SEEN_KEPT ? next.slice(-SEEN_KEPT) : next
}

const normHandle = (handle) => {
  const raw = String(handle ?? '').trim()
  if (!raw) return ''
  return `@${raw.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 120)}`
}

export function createFaceRoomApi({ server, token, fetch: fetchImpl = socialFetch, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!server) throw new Error('flybot-social: server URL is required')
  if (!token) throw new Error('flybot-social: owner connector token is required')
  const origin = String(server).replace(/\/+$/, '')
  const base = `${origin}/v1/face-rooms`

  async function callHttp(method, url, body) {
    const signal = AbortSignal.timeout(timeoutMs)
    let response
    let data
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })
      const text = await response.text()
      try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    } catch (error) {
      if (error instanceof FaceRoomError) throw error
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new FaceRoomError(`Bot Social did not answer in ${Math.round(timeoutMs / 1000)}s`, 'timeout')
      }
      throw error
    }
    if (!response.ok) throw mapFaceError(data, response.status)
    return data
  }

  async function request(method, path, body) {
    return callHttp(method, `${base}${path}`, body)
  }

  async function patchMe(payload) {
    return callHttp('PATCH', `${origin}/v1/me`, payload)
  }

  return {
    async join({ code, bots } = {}) {
      const digits = String(code ?? '').trim()
      if (!isJoinCode(digits)) throw mapFaceError({ error: { code: 'invalid_code' } }, 400)
      const handles = (Array.isArray(bots) ? bots : bots ? [bots] : []).map(normHandle).filter(Boolean)
      const body = await request('POST', '/join', { code: digits, ...(handles.length ? { bots: handles } : {}) })
      return viewFaceRoom(body)
    },
    async list() {
      const body = await request('GET', '')
      return (body.rooms ?? []).map(viewFaceRoom).filter(Boolean)
    },
    async get(roomId, { after, as } = {}) {
      const id = encodeURIComponent(String(roomId ?? ''))
      const query = new URLSearchParams()
      if (after !== undefined && after !== null && after !== '') query.set('after', String(after))
      if (as) query.set('as', String(as))
      const suffix = query.size ? `?${query}` : ''
      const body = await request('GET', `/${id}${suffix}`)
      return viewFaceRoom(body)
    },
    async start(roomId) {
      const body = await request('POST', `/${encodeURIComponent(String(roomId))}/start`)
      return viewFaceRoom(body) ?? { roomId, status: 'open' }
    },
    async leave(roomId, { bots } = {}) {
      const handles = (Array.isArray(bots) ? bots : bots ? [bots] : []).map(normHandle).filter(Boolean)
      const body = await request('POST', `/${encodeURIComponent(String(roomId))}/leave`, handles.length ? { bots: handles } : {})
      return viewFaceRoom(body) ?? { roomId, status: body?.status }
    },
    async send(roomId, { text, botId } = {}) {
      const body = await request('POST', `/${encodeURIComponent(String(roomId))}/messages`, {
        text: String(text ?? ''),
        ...(botId ? { bot_id: botId } : {}),
      })
      return {
        messageId: body.message_id,
        status: body.status,
        approvalId: body.approval_id,
        eventCursor: body.event_cursor,
        autoApproved: body.auto_approved === true,
        from: viewFaceMember(body.from),
      }
    },
    async me() {
      return viewMe(await callHttp('GET', `${origin}/v1/me`)) ?? { autoApproveFaceRooms: false }
    },
    // Owner click is the consent. If Bot Social answers confirmation_required, the
    // confirm_code is requested and used in this same call — the UI never asks for it.
    async setAutoApproveFaceRooms(on) {
      const payload = { auto_approve_face_rooms: Boolean(on) }
      let body
      try {
        body = await patchMe(payload)
      } catch (error) {
        const code = confirmationCode(error)
        if (!code) throw error
        body = await patchMe({ ...payload, confirm_code: code })
      }
      const retry = confirmationCode(body)
      if (retry) body = await patchMe({ ...payload, confirm_code: retry })
      if (confirmationCode(body)) {
        throw new FaceRoomError(FRIENDLY.confirmation_required, 'confirmation_required')
      }
      return viewMe(body) ?? { autoApproveFaceRooms: Boolean(on) }
    },
  }
}

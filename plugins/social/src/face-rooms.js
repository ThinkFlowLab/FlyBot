// Face-to-face rooms (#83): join by a 6-digit number on Bot Social. This module is the
// client contract — REST against docs/FACE_ROOMS.md for room join/list/get/start/leave/
// messages (those routes accept the connector token) — plus error mapping, event rendering
// and sanitization of peer-controlled strings. Owner settings (`auto_approve_face_rooms`)
// go through MCP `whoami` / `set_auto_approve` in social.js: REST GET/PATCH /v1/me rejects
// connector tokens with 403 `connector_token_rest_forbidden`. The host (social.js) calls
// the server with the connector token; the browser shows the friendly copy these helpers return.
//
// Peer text is untrusted: fence it before anything model-visible. Platform system copy
// (joined / left / started) is sanitized the same way as a display name.

import { socialFetch } from './mcp-client.js'
import { lookFromServer } from './look.js'
import { formatFaceRoomTitle, faceRoomCreatedAt } from './face-title.js'

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

// A wrapped string is `<marker>\n…\n<marker>`, each marker one `<…>` line. Only such a string is
// unwrapped: plain text keeps every line, so a peer's paragraphs are never cut (#302).
const UNTRUSTED = /^\s*<[^\n]*>[ \t]*\n([\s\S]*)\n[ \t]*<[^\n]*>\s*$/
export function faceUntrustedText(value) {
  if (value && typeof value === 'object') return String(value.text ?? '')
  if (typeof value !== 'string') return String(value ?? '')
  const inner = value.match(UNTRUSTED)?.[1]
  if (inner === undefined) return value
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
  if (left <= 0) return 'Joining has ended'
  const minutes = Math.ceil(left / 60_000)
  if (minutes >= 2) return `${minutes} minutes left to join`
  const seconds = Math.max(1, Math.ceil(left / 1000))
  return seconds === 1 ? '1 second left to join' : `${seconds} seconds left to join`
}

const ALREADY_LEFT = new Set(['bot_not_found', 'not_a_member', 'room_closed', 'face_room_not_found', 'code_void'])
export function alreadyLeftFace(error) {
  const code = String(error?.code ?? '')
  if (ALREADY_LEFT.has(code)) return true
  return /not one of yours on Bot Social|no longer in this room|has closed|not available|no longer valid/i.test(String(error?.message ?? error ?? ''))
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
  connector_token_rest_forbidden: 'This Bot Social connection cannot use that request. Try again, or reconnect in Friends\' Bots.',
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

// Face join of my own Bot is a room-scoped grant. True when this Bot has no person-grant.
export function roomOnlyForJoin(bot, hasAnyGrant) {
  if (typeof hasAnyGrant === 'function') return hasAnyGrant(typeof bot === 'string' ? bot : bot?.id) !== true
  return bot?.granted !== true && bot?.published !== true
}

/** @deprecated published is gone; room-only is the face-join default. */
export function publishedForJoin(bot, isPublished) {
  return !roomOnlyForJoin(bot, typeof isPublished === 'function' ? id => isPublished(id) : undefined)
}

export function handleBotName(handle) {
  const raw = typeof handle === 'object' && handle !== null ? (handle.handle ?? '') : handle
  const part = String(raw ?? '').replace(/^@/, '').split('.')[0]
  if (!part || part === 'home' || part === 'bot') return ''
  return part.charAt(0).toUpperCase() + part.slice(1)
}

export function distinctFaceBotName(member) {
  const name = cleanFaceName(member?.display_name || member?.displayName || member?.name, '')
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, '')
  if (/^chief$/i.test(name)) return 'Chief'
  if (name && name !== 'Bot' && (!owner || name.toLowerCase() !== owner.toLowerCase())) return name
  const fromHandle = handleBotName(member?.handle)
  if (fromHandle && (!owner || fromHandle.toLowerCase() !== owner.toLowerCase())) return fromHandle
  return name && name !== 'Bot' ? name : ''
}

export function faceMemberLabel(member) {
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, '')
  const name = distinctFaceBotName(member) || 'Bot'
  if (!owner || name.toLowerCase() === owner.toLowerCase()) return name
  if (/^chief$/i.test(name)) return `${owner}'s Chief`
  return `${name} · ${owner}`
}

export const FACE_HUMAN_MARK = 'FLYBOT-FACE-HUMAN'

export function encodeFaceHuman(payload = {}) {
  const who = cleanFaceName(payload.who, 'Someone')
  const text = String(payload.text ?? '').slice(0, 18_000)
  return `${FACE_HUMAN_MARK}\n${JSON.stringify({ v: 1, who, text })}`
}

export function humanFaceWho(line, fallback = 'Someone') {
  const who = cleanFaceName(line?.who, '')
  if (who && !/^user$/i.test(who)) return who
  return cleanFaceName(fallback, 'Someone')
}

// Display name for a face-room line: the Bot Social `from` snapshot is the
// authenticated sender. Never take `who` from the FLYBOT-FACE-HUMAN JSON (a
// peer can put another member's name there). Old events without `from` fall
// back to the handle's home label, then Someone — not the claimed name.
export function trustedFaceWho(from) {
  if (!from || typeof from !== 'object') return 'Someone'
  const label = cleanFaceName(from.label, '')
  if (label) return label
  const owner = cleanFaceName(from.owner_name || from.ownerName, '')
  if (owner) {
    const named = faceMemberLabel(from)
    if (named && named !== 'Bot') return named
    return owner
  }
  const handle = String(from.handle || from.id || '')
  const parts = handle.replace(/^@+/, '').split('.').filter(Boolean)
  const home = parts.length >= 2 && parts.at(-1)?.toLowerCase() === 'home'
    ? parts[parts.length - 2]
    : ''
  const shown = cleanFaceName(home, '')
  if (!shown) return 'Someone'
  return shown.charAt(0).toUpperCase() + shown.slice(1)
}

export function faceRoomTitle(snapshot = {}, { code, room } = {}) {
  const members = snapshot.members ?? room?.participants ?? []
  const at = faceRoomCreatedAt({
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt || room?.face?.expiresAt,
    startedAt: snapshot.startedAt || room?.face?.startedAt,
  }) || room?.createdAt
  return formatFaceRoomTitle({
    name: snapshot.name || room?.name,
    members,
    code: code || snapshot.joinCode,
    at,
  })
}

export function parseFaceHuman(text) {
  const raw = String(text ?? '')
  const at = raw.indexOf(FACE_HUMAN_MARK)
  if (at < 0) return undefined
  const start = raw.indexOf('{', at)
  if (start < 0) return undefined
  let depth = 0
  let end = -1
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return undefined
  try {
    const data = JSON.parse(raw.slice(start, end + 1))
    if (data?.v !== 1 || typeof data.text !== 'string') return undefined
    return { who: cleanFaceName(data.who, 'Someone'), text: String(data.text) }
  } catch {
    return undefined
  }
}

// A Bot's own words never carry the person-line marker: only the human-send path writes it,
// so model output cannot pass itself off as the owner speaking (or skip the owner's card).
export const neutralizeFaceHuman = text => String(text ?? '').replace(/FLYBOT-FACE-HUMAN/gi, 'FLYBOT FACE HUMAN')

export function faceOutbound(line, { locals = [], asBots = [], who } = {}) {
  if (!line || line.kind) return undefined
  if (line.remote === true) return undefined
  const author = line.authorId || line.botId
  const local = locals.find(bot => bot.id === author || bot.handle === author)
  if (local?.botId) return { text: neutralizeFaceHuman(line.text), botId: local.botId, human: false }
  if (line.authorKind === 'human') {
    const speaker = asBots.map(handle => locals.find(bot => bot.handle === handle)).find(Boolean)
      || locals.find(bot => bot.botId)
    if (!speaker?.botId) return undefined
    // `text` is the legacy wire form (envelope, for servers that cannot attest); `plain` goes out
    // with typed_by_owner when the server attests it, so no marker text is on the wire.
    return {
      text: encodeFaceHuman({ who: humanFaceWho(line, who), text: line.text }),
      plain: neutralizeFaceHuman(line.text),
      botId: speaker.botId,
      human: true,
    }
  }
  return undefined
}

export function platformJoinText(member) {
  const who = faceMemberLabel(member)
  // Server copy; we rebuild from sanitized fields so a poisoned payload cannot instruct.
  if (member?.roomOnly === true || member?.published !== true) return `${who} joined; available to this room only`
  return `${who} joined`
}

// A leave names the person, not their Bot (#191): "Bob left the room".
export function platformLeaveText(member) {
  const owner = cleanFaceName(member?.owner_name || member?.ownerName, '')
  return owner ? `${owner} left the room` : `${faceMemberLabel(member)} left`
}

export function platformStartedText(reason) {
  if (reason === 'expired') return 'Joining has ended. The room is now open. The number is no longer valid.'
  return 'The room is now open. The number is no longer valid.'
}

// Peer look is optional: only pass through a stored color / avatar when the payload
// actually has one. Image URLs stay one line, no markup; a missing look is fine — the
// client then uses the host BotMark seeded by handle.
const HEX_ONLY = /^#[0-9a-f]{6}$/i
export function faceMemberLook(member) {
  if (!member || typeof member !== 'object') return {}
  const out = {}
  const fromServer = lookFromServer(member)
  const color = fromServer.color
    || (typeof member.color === 'string' && !HEX_ONLY.test(member.color) ? member.color.trim().slice(0, 32) : '')
  if (color && !/[\n<>]/.test(color)) out.color = color
  const src = member.avatar && typeof member.avatar === 'object' ? member.avatar : {}
  const avatar = { ...(fromServer.avatar ?? {}) }
  if (typeof src.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(src.shape)) avatar.shape = src.shape
  const image = typeof src.image === 'string' ? src.image.trim() : (typeof member.image === 'string' ? member.image.trim() : '')
  if (image && image.length <= 65536 && /^(https?:\/\/|data:image\/)/i.test(image) && !/[\s<>]/.test(image)) avatar.image = image
  const emoji = typeof src.emoji === 'string' ? src.emoji.trim() : (typeof member.emoji === 'string' ? member.emoji.trim() : '')
  if (emoji && !/[\n<>]/.test(emoji)) avatar.emoji = emoji.slice(0, 16)
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
    createdAt: body.created_at || body.createdAt || null,
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

// The sender's explicit mention list as the server delivers it (Bot Social `mentions`, #293): at most 8
// handles, each normalised to lowercase "@handle"; anything malformed is dropped, never trusted.
const MENTION_HANDLE = /^@?[a-z0-9._-]{2,40}$/i
export function cleanMentions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, 8)) {
    if (typeof item !== 'string' || !MENTION_HANDLE.test(item.trim())) continue
    const handle = `@${item.trim().replace(/^@/, '').toLowerCase()}`
    if (!out.includes(handle)) out.push(handle)
  }
  return out
}

function viewedFaceText(event) {
  const raw = event.untrusted_content ?? event.untrustedContent
  if (raw === undefined && typeof event.untrustedText === 'string') return event.untrustedText
  return faceUntrustedText(raw ?? event.untrustedText)
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
    // A viewed event (renderFaceEvent views again) already holds the plain text: keep it as is (#302).
    untrustedText: mapped === 'room.message' ? stripFaceMarkers(viewedFaceText(event)) : undefined,
    // Stamped by Bot Social (never read from the text): the owner typed this line themselves. A viewed
    // event is viewed again by renderFaceEvent, hence the camelCase form.
    ...(mapped === 'room.message' && (event.typed_by_owner === true || event.typedByOwner === true) ? { typedByOwner: true } : {}),
    // The sender's own list of whom the line is for (#293). Data from the sender's host, read by
    // renderFaceEvent only on a line the server attests as typed by that person.
    ...(mapped === 'room.message' && cleanMentions(event.mentions).length > 0 ? { mentions: cleanMentions(event.mentions) } : {}),
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

// `attested`: the server stamps typed_by_owner (Bot Social features), so a line is a person's only when
// it carries that stamp; the FLYBOT-FACE-HUMAN text is then never an attribution (any Bot can write
// it), though its inner text is still unwrapped for display. Without it (an older server) the envelope
// keeps its legacy meaning (#180).
export function renderFaceEvent(event, { attested = false } = {}) {
  const viewed = viewFaceEvent(event)
  if (!viewed) return undefined
  if (viewed.type === 'room.message') {
    const from = viewed.from || {}
    const body = viewed.untrustedText ?? ''
    const envelope = parseFaceHuman(body)
    const human = attested ? (viewed.typedByOwner === true ? { text: envelope ? envelope.text : body } : undefined) : envelope
    // A person's own line is attributed to the person, not to the Bot that carried it (#180).
    const ownerName = cleanFaceName(from.owner_name || from.ownerName, '')
    const who = human && ownerName ? ownerName : trustedFaceWho(from)
    const text = human ? human.text : (attested && envelope ? envelope.text : body)
    return {
      kind: undefined,
      system: false,
      who,
      text,
      fenced: fenceFaceText(who, text),
      authorId: human ? (from.handle || 'human') : from.handle,
      authorKind: human ? 'human' : 'bot',
      remote: true,
      human: Boolean(human),
      ownerName: from.ownerName,
      trust: 'peer_untrusted',
      eventId: viewed.eventId,
      eventCursor: viewed.eventCursor,
      // Honoured only on a line the server attests as typed by the person (#293): a Bot's line never
      // calls another home's Bots by a list it wrote, and an unattested server has no such list to trust.
      ...(attested && human && viewed.typedByOwner === true && viewed.mentions ? { mentions: viewed.mentions } : {}),
      // The server attests the person typed it: only such a line may start Bots on this home (#295).
      ...(attested && human && viewed.typedByOwner === true ? { attested: true } : {}),
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
  const raw = typeof handle === 'object' && handle !== null ? (handle.handle ?? handle.home ?? '') : handle
  const body = String(raw ?? '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 120)
  return body ? `@${body}` : ''
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
      const asHandle = normHandle(as)
      if (asHandle) query.set('as', asHandle)
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
    // Bot Social features (GET /v1/platform): what this server can do. An older server, or any
    // failure, is an empty list, so callers keep the behaviour they had.
    async features() {
      try {
        const info = await callHttp('GET', `${origin}/v1/platform`)
        return Array.isArray(info?.features) ? info.features.map(String) : []
      } catch {
        return undefined
      }
    },
    // `typedByOwner`: the person typed this line. Bot Social stamps it for the receiver only when this
    // token may attest; otherwise it answers 403 typed_attestation_forbidden.
    // `mentions`: the Bot handles the line @-names (#293); sent only when the server lists the feature.
    async send(roomId, { text, botId, typedByOwner, mentions } = {}) {
      const listed = cleanMentions(mentions)
      const body = await request('POST', `/${encodeURIComponent(String(roomId))}/messages`, {
        text: String(text ?? ''),
        ...(botId ? { bot_id: botId } : {}),
        ...(typedByOwner === true ? { typed_by_owner: true } : {}),
        ...(listed.length > 0 ? { mentions: listed } : {}),
      })
      return {
        typedByOwner: body.typed_by_owner === true,
        messageId: body.message_id,
        status: body.status,
        approvalId: body.approval_id,
        eventCursor: body.event_cursor,
        autoApproved: body.auto_approved === true,
        from: viewFaceMember(body.from),
      }
    },
  }
}

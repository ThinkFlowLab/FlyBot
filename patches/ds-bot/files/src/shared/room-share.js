// Membership and chat-line envelopes that ride Bot Social's 1:1 `send_as_member` text.
// Bot Social has no FlyBot-group record: the owner's FlyBot parses this on inbox receive
// and projects an inbound-share room. Keep the marker unique so ordinary chat never matches.

export const ROOM_SHARE_MARK = 'FLYBOT-ROOM-SHARE'

// #852: `ask` is the invitee knocking at a local room's link (or accepting it with `accept: true`);
// `invite` is the inviter's answer with the room's name and the ticket's deadline. Neither creates a
// room on the receiving side, and neither is authority: only the room record decides.
const OPS = new Set(['join', 'leave', 'line', 'ask', 'invite'])
const TICKET_SHAPE = /^[A-Za-z0-9_-]{16,64}$/

function clip(value, max = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max)
}

export function encodeRoomShare(payload = {}) {
  const body = {
    v: 1,
    op: OPS.has(payload.op) ? payload.op : 'line',
    roomId: clip(payload.roomId, 120),
    name: clip(payload.name),
    inviterName: clip(payload.inviterName),
    inviterHome: clip(payload.inviterHome, 120),
    inviterHandle: clip(payload.inviterHandle, 120),
    invitedHandle: clip(payload.invitedHandle, 120),
    seq: Number.isFinite(Number(payload.seq)) ? Number(payload.seq) : 0,
  }
  // #852: the link's ticket, the second (accepting) knock, and the inviter's answer fields.
  if (payload.ticket) body.ticket = clip(payload.ticket, 64)
  if (payload.accept === true) body.accept = true
  if (payload.lead) body.lead = clip(payload.lead)
  if (Number.isFinite(Number(payload.expiresAt)) && Number(payload.expiresAt) > 0) body.expiresAt = Math.floor(Number(payload.expiresAt))
  if (body.op === 'ask' && !payload.roomId) delete body.roomId
  if (payload.who) body.who = clip(payload.who)
  if (payload.kind) body.kind = clip(payload.kind, 32)
  if (payload.authorKind) body.authorKind = clip(payload.authorKind, 16)
  if (payload.authorId) body.authorId = clip(payload.authorId, 120)
  if (payload.text) body.text = String(payload.text).slice(0, 18_000)
  // #825: the Bots a line calls, resolved by the sending home where mentions are already resolved,
  // and how many Bot answers the discussion has already taken. A receiving home answers only its own
  // handles in `calls` and only below its room's hop cap; nothing here is read back out of the text.
  if (Number.isFinite(Number(payload.hop)) && Number(payload.hop) > 0) body.hop = Math.min(Math.floor(Number(payload.hop)), 99)
  if (Array.isArray(payload.calls) && payload.calls.length > 0) {
    body.calls = payload.calls.map(handle => clip(handle, 120)).filter(Boolean).slice(0, 24)
  }
  return `${ROOM_SHARE_MARK}\n${JSON.stringify(body)}`
}

// #852: a link invitation for a room that lives in FlyBot itself. No server knows this ticket: the
// inviter's host mints it and the room record keeps it. The link carries the inviter Bot's handle as
// its own path segment, because that handle is the only address the invitee can knock on — a ticket
// inside the 64-character shape cannot hold one. Ten minutes, like the face-room window, and never
// authority on its own: the room record decides.
export const LOCAL_INVITE_TTL_MS = 10 * 60 * 1000
const INVITE_LINK = /^(?:https?:)?\/\/[^\s/]+\/r\/(?:(@[A-Za-z0-9._-]{1,120})\/)?([A-Za-z0-9_-]{16,64})\/?(?:[?#].*)?$/i

// Two shapes, one field: the face-room link the server owns, and the local one that names the Bot to
// knock on. Nothing here decides which is legitimate — the caller does, by kind.
export function parseRoomInviteLink(value) {
  const match = String(value ?? '').trim().match(INVITE_LINK)
  if (!match) return undefined
  return match[1] ? { kind: 'local', handle: match[1], ticket: match[2] } : { kind: 'face', ticket: match[2] }
}

export function roomInviteUrl(handle, ticket, origin = 'https://social.botawaken.com') {
  const who = String(handle ?? '').trim()
  const clean = String(ticket ?? '').trim()
  if (!/^@[A-Za-z0-9._-]{1,120}$/.test(who) || !/^[A-Za-z0-9_-]{16,64}$/.test(clean)) return ''
  return `${String(origin || '').replace(/\/+$/, '')}/r/${who}/${clean}`
}

export function parseRoomShare(text) {
  const raw = String(text ?? '')
  const at = raw.indexOf(ROOM_SHARE_MARK)
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
    if (data?.v !== 1 || !OPS.has(data.op)) return undefined
    // A knock names the ticket and nothing else; an offer must also name the room it is for.
    if (data.op === 'ask') return TICKET_SHAPE.test(String(data.ticket ?? '')) ? data : undefined
    if (data.op === 'invite') return TICKET_SHAPE.test(String(data.ticket ?? '')) && data.roomId ? data : undefined
    if (!data.roomId) return undefined
    return data
  } catch {
    return undefined
  }
}

export function isRoomShareText(text) {
  return String(text ?? '').includes(ROOM_SHARE_MARK)
}

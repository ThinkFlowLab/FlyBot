// Membership and chat-line envelopes that ride Bot Social's 1:1 `send_as_member` text.
// Bot Social has no FlyBot-group record: the owner's FlyBot parses this on inbox receive
// and projects an inbound-share room. Keep the marker unique so ordinary chat never matches.

export const ROOM_SHARE_MARK = 'FLYBOT-ROOM-SHARE'

const OPS = new Set(['join', 'leave', 'line'])

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
  if (payload.who) body.who = clip(payload.who)
  if (payload.kind) body.kind = clip(payload.kind, 32)
  if (payload.authorKind) body.authorKind = clip(payload.authorKind, 16)
  if (payload.authorId) body.authorId = clip(payload.authorId, 120)
  if (payload.text) body.text = String(payload.text).slice(0, 18_000)
  return `${ROOM_SHARE_MARK}\n${JSON.stringify(body)}`
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
    if (data?.v !== 1 || !OPS.has(data.op) || !data.roomId) return undefined
    return data
  } catch {
    return undefined
  }
}

export function isRoomShareText(text) {
  return String(text ?? '').includes(ROOM_SHARE_MARK)
}

// Membership and chat-line envelopes that ride Bot Social's 1:1 `send_as_member` text.
// Bot Social has no FlyBot-group record: the owner's FlyBot parses this on inbox receive
// and projects an inbound-share room. Keep the marker unique so ordinary chat never matches.

import { cut } from './text-boundary.js'

export const ROOM_SHARE_MARK = 'FLYBOT-ROOM-SHARE'

// #852: `ask` is the invitee knocking at a local room's link (or accepting it with `accept: true`);
// `invite` is the inviter's answer with the room's name and the ticket's deadline. Neither creates a
// room on the receiving side, and neither is authority: only the room record decides.
const OPS = new Set(['join', 'leave', 'line', 'ask', 'invite'])
const TICKET_SHAPE = /^[A-Za-z0-9_-]{16,64}$/

function clip(value, max = 60) {
  return cut(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim(), max).text
}

// #904: a room's roster entry. A Bot inside a real room is a handful, not a crowd; the cap keeps one
// envelope from turning into a member dump a guest has to render.
export const ROSTER_MAX = 32
// The group notice's own limit in the room editor (core/src/client/group-settings.js).
export const NOTICE_MAX = 2000
// Recent chat lines a join may carry so a guest's mirror is not empty. Absent means don't
// backfill (an older host); an empty list means the room had no chat lines.
export const HISTORY_MAX = 20
export const HISTORY_TEXT = 2000
// Bot Social rejects `send_as_member` text longer than this. A join that carries the room's chat
// used to exceed it, so the seat was made and the joiner never got the sidebar row (#1161).
export const ROOM_SHARE_TEXT_MAX = 4000
// The instruction-override half of Bot Social's injection detector (plugins/social `ROOM_INSTRUCTION_OVERRIDE`).
// A join that copies one of these lines is held and, until #1161, marked as already sent. Leave them out
// of the join; the owner's card still decides a later line that says the same thing.
const JOIN_HELD_TEXT = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /忽略(之前|以上|前面|先前)的?(所有)?(指令|提示|设定)/,
  /(system prompt|系统提示|developer message)/i,
  /\[(SYSTEM|ADMIN|PLATFORM)\]|<\/?system>/i,
  /(send|forward|reveal|leak) (me )?(all|every|your owner'?s?)/i,
]

function joinTextHeld(text) {
  return JOIN_HELD_TEXT.some(pattern => pattern.test(String(text ?? '')))
}

// A join has to fit the transport and must not carry a line that would hold the whole envelope.
// History that was emptied to fit is omitted (absent means don't backfill; `[]` means there were no lines).
// A roster emptied the same way is omitted (`[]` would tell the guest this home keeps no Bots).
function fitJoin(body) {
  if (Array.isArray(body.history)) {
    const had = body.history.length
    body.history = body.history.filter(line => !joinTextHeld(line.text))
    if (had > 0 && body.history.length === 0) delete body.history
  }
  if (typeof body.notice === 'string' && joinTextHeld(body.notice)) delete body.notice
  const wire = () => `${ROOM_SHARE_MARK}\n${JSON.stringify(body)}`
  let trimmedHistory = false
  while (Array.isArray(body.history) && body.history.length > 0 && wire().length > ROOM_SHARE_TEXT_MAX) {
    body.history.shift()
    trimmedHistory = true
  }
  if (trimmedHistory && body.history.length === 0) delete body.history
  // #1932: the roster is display data and the only part that may be dropped a row at a time, so it
  // pays its own cost first: a row goes while the envelope overflows even with the notice taken out.
  // A roster overflow therefore never empties the notice, and a present empty notice — the host
  // clearing it — is not a placeholder to delete while a row can still give.
  if (Array.isArray(body.roster) && body.roster.length > 0) {
    const keptNotice = body.notice
    // #1946: a present notice costs 12 units on the wire even when it is empty — the key, the colon
    // and the two quotes. Measuring with the notice taken out and then restoring it pushed the
    // envelope back over the cap, and the notice branch below, with nothing to cut, deleted the
    // field; an absent notice reads on the guest as "change nothing", so the host's clear never
    // arrived. The roster now gives while the envelope overflows with the notice field in place, so
    // the field always survives the yield. Only the field's own cost is counted: the notice's text
    // still pays what is left over below, so #1932's cut-not-drop case is unchanged.
    const noticeKeyCost = typeof keptNotice === 'string' ? ',"notice":""'.length : 0
    const overWithNoticeField = () => {
      if (typeof keptNotice === 'string') delete body.notice
      const over = wire().length + noticeKeyCost > ROOM_SHARE_TEXT_MAX
      if (typeof keptNotice === 'string') body.notice = keptNotice
      return over
    }
    while (body.roster.length > 0 && overWithNoticeField()) body.roster.pop()
    if (body.roster.length === 0) delete body.roster
  }
  // The notice pays only what is left over once the roster has given all it can, so a notice that is
  // the whole overflow is still a bounded notice rather than a dropped one.
  if (typeof body.notice === 'string' && wire().length > ROOM_SHARE_TEXT_MAX) {
    const was = body.notice
    const extra = wire().length - ROOM_SHARE_TEXT_MAX
    body.notice = cut(was, Math.max(0, was.length - extra)).text
    // A notice cut down to nothing says "change nothing" rather than "the host cleared it".
    if (body.notice.length === 0 && was.length > 0) delete body.notice
    else if (wire().length > ROOM_SHARE_TEXT_MAX) delete body.notice
  }
}

// Bot Social rejects send_as_member text outside 1–4000 characters (`payload.text (1-4000 chars) required`).
// A join is fitted above; a line's own text is the other way an envelope crosses that line (#1161).
function fitTransport(body) {
  if (body.op === 'join') fitJoin(body)
  const wire = () => `${ROOM_SHARE_MARK}\n${JSON.stringify(body)}`
  if (typeof body.text === 'string') {
    while (body.text.length > 0 && wire().length > ROOM_SHARE_TEXT_MAX) {
      const extra = Math.max(1, wire().length - ROOM_SHARE_TEXT_MAX)
      body.text = cut(body.text, Math.max(0, body.text.length - extra)).text
    }
    if (!body.text) delete body.text
  }
  for (const key of ['history', 'calls', 'bots', 'roster', 'notice']) {
    if (wire().length <= ROOM_SHARE_TEXT_MAX) break
    delete body[key]
  }
  let out = wire()
  if (out.length > ROOM_SHARE_TEXT_MAX || out.length < 1) {
    out = `${ROOM_SHARE_MARK}\n${JSON.stringify({
      v: 1,
      op: body.op,
      ...(body.roomId ? { roomId: String(body.roomId).slice(0, 64) } : {}),
      ...(body.ticket ? { ticket: body.ticket } : {}),
      seq: body.seq || 0,
    })}`
  }
  return out
}

// #904: a handle is unique only inside its home, so an entry carries the home it belongs to: two homes
// can keep Bots with the same local name, and a guest has to tell them apart when it attributes a line.
// The receiving side verifies against the transport's home; this field is for identity, not for trust.
function rosterEntry(entry = {}) {
  const handle = clip(entry.handle, 120)
  const home = clip(entry.home, 120)
  const out = { name: clip(entry.name) }
  if (handle) out.handle = handle
  if (/^@[A-Za-z0-9._-]{1,120}$/.test(home)) out.home = home
  const ownerName = clip(entry.ownerName)
  if (ownerName) out.ownerName = ownerName
  if (!handle) out.connected = false
  return out
}

// A chat line the join copies across. Text keeps its line breaks; other control characters go.
function historyLine(entry = {}) {
  const who = clip(entry.who)
  const text = cut(String(entry.text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim(), HISTORY_TEXT).text
  if (!who || !text) return undefined
  const out = { who, text, seq: Number.isFinite(Number(entry.seq)) ? Math.max(0, Math.floor(Number(entry.seq))) : 0 }
  if (entry.authorKind === 'human' || entry.authorKind === 'bot') out.authorKind = entry.authorKind
  const authorId = clip(entry.authorId, 120)
  if (authorId) out.authorId = authorId
  const handle = clip(entry.handle, 120)
  if (/^@[A-Za-z0-9._-]{1,120}$/.test(handle)) out.handle = handle
  return out
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
  // #878: the accepting knock on a ticket Bot Social recorded names the Bots the claim brought. The
  // inviter's home reads the claim back from the server; this list is only what the knock says.
  if (Array.isArray(payload.bots) && payload.bots.length > 0) {
    body.bots = payload.bots.map(handle => clip(handle, 120)).filter(handle => handle.startsWith('@')).slice(0, 8)
  }
  if (payload.who) body.who = clip(payload.who)
  if (payload.kind) body.kind = clip(payload.kind, 32)
  if (payload.authorKind) body.authorKind = clip(payload.authorKind, 16)
  if (payload.authorId) body.authorId = clip(payload.authorId, 120)
  if (payload.text) body.text = cut(String(payload.text), 18_000).text
  // #825: the Bots a line calls, resolved by the sending home where mentions are already resolved,
  // and how many Bot answers the discussion has already taken. A receiving home answers only its own
  // handles in `calls` and only below its room's hop cap; nothing here is read back out of the text.
  if (Number.isFinite(Number(payload.hop)) && Number(payload.hop) > 0) body.hop = Math.min(Math.floor(Number(payload.hop)), 99)
  if (Array.isArray(payload.calls) && payload.calls.length > 0) {
    body.calls = payload.calls.map(handle => clip(handle, 120)).filter(Boolean).slice(0, 24)
  }
  // #904: the host room's Bots ride the membership notice so the guest's mirror can list them. It is
  // display data only — the guest still takes reachability from Bot Social, so a roster can never hand
  // out a send path. `connected: false` is a Bot with no Bot Social identity: shown, never addressed.
  // #904: an explicit roster is encoded even when empty — empty means the host keeps none of its Bots in
  // the room any more, while an absent field means "change nothing" (an older host).
  if (body.op === 'join' && Array.isArray(payload.roster)) {
    body.roster = payload.roster.slice(0, ROSTER_MAX).map(rosterEntry).filter(entry => entry.connected === false || entry.handle)
  }
  // #904: the host room's notice rides the same join envelope, so the guest's group settings are not
  // empty. It is text the room displays, never authority. A present notice is encoded even when empty:
  // empty means the host cleared it, while an absent field means "change nothing" (an older host).
  if (body.op === 'join' && typeof payload.notice === 'string') body.notice = clip(payload.notice, NOTICE_MAX)
  // Same rule as the roster: a present list is encoded even when empty, an absent field changes nothing.
  if (body.op === 'join' && Array.isArray(payload.history)) {
    body.history = payload.history.map(historyLine).filter(Boolean).slice(-HISTORY_MAX)
  }
  return fitTransport(body)
}

// #852: a link invitation for a room that lives in FlyBot itself. No server knows this ticket: the
// inviter's host mints it and the room record keeps it. The link carries the inviter Bot's handle as
// its own path segment, because that handle is the only address the invitee can knock on — a ticket
// inside the 64-character shape cannot hold one. It has no deadline (owner decision, 2026-10-24): it
// works until its owner withdraws it or someone joins with it, and it is never authority on its own:
// the room record decides.
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

// #1937: the strings a peer sends in here are its own words — the room's notice, a roster entry's
// names, the chat lines a join copies — and JSON carries an unpaired surrogate escape through as it
// came, so JSON.parse hands back a string that is not well formed and the notice reaches the room's
// standing prompt in that shape. Repair the fields this parser passes on, in place: one unit becomes
// one U+FFFD, so no bound, cut or path around them moves.
function wellFormedFields(entry, keys) {
  if (!entry || typeof entry !== 'object') return
  for (const key of keys) {
    if (typeof entry[key] === 'string') entry[key] = entry[key].toWellFormed()
  }
}

function wellFormedShare(data) {
  wellFormedFields(data, ['notice'])
  if (Array.isArray(data.roster)) data.roster.forEach(entry => wellFormedFields(entry, ['name', 'ownerName']))
  if (Array.isArray(data.history)) data.history.forEach(line => wellFormedFields(line, ['who', 'text']))
  return data
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
    return wellFormedShare(data)
  } catch {
    return undefined
  }
}

export function isRoomShareText(text) {
  return String(text ?? '').includes(ROOM_SHARE_MARK)
}

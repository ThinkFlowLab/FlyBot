// One room-invite preview card, drawn wherever an invite is shown (#876). The face-room paste flow
// and the member-invite dialog both render this component, so the markup exists once: a change here
// is visible in both, and neither surface keeps a copy.
//
// It is a plain function, not a hook component: the caller passes its own `createElement` as `h`,
// which is what lets the core bundle and a classic-script plugin (which gets `h` from `require`)
// draw the same card. Everything the card says comes from a server reply, so the strings are
// cleaned here, at the last place before a person reads them — the same rules the server applies to
// a room name (`cleanFaceName`): one line, no controls, brackets, markup or @, capped.
export const INVITE_PREVIEW_NAME_MAX = 60

// Untrusted fence markers are stripped to a fixed point: one pass can remove a match and assemble a
// new one, so a nested `<untrusted-<untrusted-filemessage>` would otherwise leave a complete
// `<untrusted-message>` in the card a person reads (#822).
export function stripInviteMarkers(text) {
  let out = String(text ?? '')
  for (let previous; previous !== out;) {
    previous = out
    out = out.replace(/<\/?\s*untrusted-(?:file|message)/gi, '')
  }
  return out
}

export function cleanInviteName(value, fallback = '') {
  return stripInviteMarkers(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[[\]"<>`@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INVITE_PREVIEW_NAME_MAX) || fallback
}

// A count is only what reads as one (#823): `Number('')` is 0, which would draw an unknown room as
// empty, so an empty or non-numeric string is "not sent", like null.
export function inviteMemberCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  if (!text) return NaN
  const count = Number(text)
  return Number.isFinite(count) ? count : NaN
}

// What the card can honestly say, and nothing else: a reply with no field worth showing is no card
// at all, so the caller keeps its own path (a paste that previews nothing still joins as before).
export function invitePreviewOf(seen) {
  if (!seen || typeof seen !== 'object' || seen.unsupported === true) return null
  const name = cleanInviteName(seen.name)
  const lead = cleanInviteName(seen.lead)
  const members = inviteMemberCount(seen.members)
  const maxMembers = inviteMemberCount(seen.maxMembers)
  const people = Number.isFinite(members) && Number.isFinite(maxMembers)
    ? `${members} / ${maxMembers} in the room`
    : Number.isFinite(members) ? `${members} in the room` : ''
  const expiresAt = typeof seen.expiresAt === 'string' ? seen.expiresAt : ''
  if (!name && !lead && !people && !expiresAt) return null
  return { name, lead, people, expiresAt, clockOffsetMs: Number(seen.clockOffsetMs) || 0 }
}

// Every home counts down to the server's one deadline (#458): `offsetMs` is how far the server's
// clock runs ahead of this one (0 unless the skew is real). m:ss, so the line visibly ticks.
export function inviteCountdown(expiresAt, offsetMs = 0) {
  const at = Date.parse(expiresAt) - (Number(offsetMs) || 0)
  if (!Number.isFinite(at)) return 'Open while the room is open'
  const left = Math.max(0, at - Date.now())
  if (left <= 0) return 'This link has expired'
  const total = Math.max(1, Math.ceil(left / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} left to join`
}

// `kind` prefixes every `data-flybot` name, so each surface keeps the hook its tests and its CSS
// already use while sharing this one tree of elements.
export function RoomInvitePreview({ h, preview, kind = 'face-link-preview', busy = false, joinLabel = 'Join', clearLabel = 'Clear', showClear = true, onJoin, onClear, now } = {}) {
  if (!preview || typeof h !== 'function') return null
  const at = `${kind}`
  const child = (name) => `${at}-${name}`
  const countdown = now === undefined
    ? inviteCountdown(preview.expiresAt, preview.clockOffsetMs)
    : inviteCountdownAt(preview.expiresAt, preview.clockOffsetMs, now)
  return h('div', { className: 'fs-preview', 'data-flybot': at, role: 'status' },
    h('div', { className: 'fs-preview-name', 'data-flybot': child('name') }, preview.name || 'Face-to-face room'),
    preview.lead ? h('div', { className: 'fs-preview-meta', 'data-flybot': child('lead') }, `Lead: ${preview.lead}`) : null,
    preview.people ? h('div', { className: 'fs-preview-meta', 'data-flybot': child('members') }, preview.people) : null,
    preview.expiresAt ? h('div', { className: 'fs-preview-meta', 'data-flybot': child('expiry') }, countdown) : null,
    onJoin || onClear
      ? h('div', { className: 'fs-preview-foot', 'data-flybot': child('foot') },
        showClear && onClear
          ? h('button', {
            type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': child('clear'),
            disabled: !!busy, onClick: onClear,
          }, clearLabel)
          : null,
        onJoin
          ? h('button', {
            type: 'button', className: 'fs-btn fs-btn-sm fs-btn-primary', 'data-flybot': child('join'),
            disabled: !!busy, onClick: onJoin,
          }, joinLabel)
          : null)
      : null)
}

// The same text as `inviteCountdown`, measured against a clock the caller already has — a render is
// then reproducible in a test without freezing the machine's clock.
export function inviteCountdownAt(expiresAt, offsetMs, now) {
  const at = Date.parse(expiresAt) - (Number(offsetMs) || 0)
  if (!Number.isFinite(at)) return 'Open while the room is open'
  const left = Math.max(0, at - Number(now || 0))
  if (left <= 0) return 'This link has expired'
  const total = Math.max(1, Math.ceil(left / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} left to join`
}

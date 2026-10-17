// Face-to-face room titles (#132): people plus a distinguisher so two rooms with
// the same owners are not both "Face-to-face room" / "Face-to-face · Alice, Bob".

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isGenericFaceTitle(name) {
  const n = String(name ?? '').trim()
  return !n || n === 'Face-to-face room'
}

export function formatFaceWhen(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${hh}:${mm}`
}

export function isAutoFaceTitle(name) {
  const n = String(name ?? '').trim()
  return isGenericFaceTitle(n) || n.startsWith('Face-to-face · ')
}

function ownersFromMembers(members) {
  const rows = []
  const seen = new Set()
  for (const member of members ?? []) {
    const owner = String(member?.ownerName ?? member?.owner_name ?? '').trim()
    const key = owner.toLowerCase()
    if (!owner || seen.has(key)) continue
    seen.add(key)
    const handle = String(member?.handle ?? member?.id ?? '').trim().toLowerCase()
    rows.push({ owner, sort: handle || key })
  }
  rows.sort((a, b) => a.sort.localeCompare(b.sort))
  return rows.slice(0, 3).map(row => row.owner)
}

function uniqueOwners(owners) {
  const seen = new Set()
  const out = []
  for (const raw of owners ?? []) {
    const owner = String(raw ?? '').trim()
    const key = owner.toLowerCase()
    if (!owner || seen.has(key)) continue
    seen.add(key)
    out.push(owner)
  }
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return out.slice(0, 3)
}

export function joinCodeOf(code) {
  return String(code ?? '').replace(/\D/g, '').slice(0, 6)
}

// The one time a face room's title shows (#194): when the room was created. Bot Social's
// `created_at` when it sends one, else the joining deadline minus the 10-minute joining window
// (the deadline never changes once the room is open, so the title reads the same before and after
// Enter chat and on every home), else the start.
export const FACE_JOIN_WINDOW_MS = 10 * 60_000
export function faceRoomCreatedAt({ createdAt, expiresAt, startedAt } = {}) {
  if (createdAt && Number.isFinite(Date.parse(createdAt))) return createdAt
  const deadline = Date.parse(expiresAt)
  if (Number.isFinite(deadline)) return new Date(deadline - FACE_JOIN_WINDOW_MS).toISOString()
  return startedAt || undefined
}

// `Face-to-face · Alice, Bob · 482913` when a code is known, else `… · Oct 16 21:40`.
// A caller-chosen name that is not an auto title is kept.
export function formatFaceRoomTitle({ name, owners, members, code, at } = {}) {
  const named = String(name ?? '').trim()
  if (named && !isAutoFaceTitle(named)) return named
  const people = members?.length ? ownersFromMembers(members) : uniqueOwners(owners)
  const join = joinCodeOf(code)
  const when = formatFaceWhen(at) || formatFaceWhen(new Date())
  const bits = ['Face-to-face']
  if (people.length) bits.push(people.join(', '))
  bits.push(join.length === 6 ? join : when)
  return bits.join(' · ')
}

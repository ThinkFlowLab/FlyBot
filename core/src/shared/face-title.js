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
  return out.slice(0, 3)
}

export function joinCodeOf(code) {
  return String(code ?? '').replace(/\D/g, '').slice(0, 6)
}

// `Face-to-face · Alice, Bob · 482913` when a code is known, else `… · Oct 16 21:40`.
// A caller-chosen name that is not an auto title is kept.
export function formatFaceRoomTitle({ name, owners, code, at } = {}) {
  const named = String(name ?? '').trim()
  if (named && !isGenericFaceTitle(named) && !named.startsWith('Face-to-face · ')) return named
  const people = uniqueOwners(owners)
  const join = joinCodeOf(code)
  const when = formatFaceWhen(at) || formatFaceWhen(new Date())
  const bits = ['Face-to-face']
  if (people.length) bits.push(people.join(', '))
  bits.push(join.length === 6 ? join : when)
  return bits.join(' · ')
}

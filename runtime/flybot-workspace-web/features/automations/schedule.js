// Automation schedule semantics, ported from flybot_workspace/automations.py so a
// schedule fires at the same slot inside the user's DS-Bot as it did on the
// server: only the latest slot counts, missed earlier days are not backfilled.
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = new Set(['now', 'once', 'daily', 'weekly', 'monthly', 'weekdays'])
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const formatters = new Map()

export function validZone(zone) {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 64) return false
  try { formatter(zone); return true } catch { return false }
}

function formatter(zone) {
  let fmt = formatters.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    formatters.set(zone, fmt)
  }
  return fmt
}

export function partsIn(zone, ms) {
  const out = {}
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) out[type] = value
  return { year: +out.year, month: +out.month, day: +out.day, hour: +out.hour % 24, minute: +out.minute, second: +out.second, isoWeekday: WEEKDAY[out.weekday] }
}

function localOffset(zone, epochMs) {
  const local = partsIn(zone, epochMs)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - epochMs
}

function wallClockSlot(zone, year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offsetWindow = 36 * 60 * 60 * 1000
  const before = localOffset(zone, wall - offsetWindow)
  const after = localOffset(zone, wall + offsetWindow)
  if (before === after) return {at:(wall - before) / 1000}
  const early = wall - Math.max(before, after)
  const late = wall - Math.min(before, after)
  const earlyMatches = early + localOffset(zone, early) === wall
  const lateMatches = late + localOffset(zone, late) === wall
  if (earlyMatches !== lateMatches) return {at:(earlyMatches ? early : late) / 1000}
  if (earlyMatches) {
    return {at:early / 1000, alternateAt:late / 1000, clockChange:'first'}
  }
  return {at:late / 1000, alternateAt:early / 1000, clockChange:'forward'}
}

// Repeated wall times use the first occurrence. Skipped wall times advance by the offset change.
export function zonedEpoch(zone, year, month, day, hour, minute) {
  return wallClockSlot(zone, year, month, day, hour, minute).at
}

const validDate = (text) => {
  if (typeof text !== 'string' || !DATE.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

export function validSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  let { kind } = value
  if (kind === 'later') { kind = 'once'; value = { ...value, kind } }
  if (!KINDS.has(kind) || !validZone(value.time_zone)) return false
  const keys = new Set(Object.keys(value))
  const same = (want) => keys.size === want.length && want.every((k) => keys.has(k))
  if (kind === 'now') return same(['kind', 'time_zone'])
  if (typeof value.time !== 'string' || !TIME.test(value.time)) return false
  const want = ['kind', 'time', 'time_zone']
  if (kind === 'once') { if (!validDate(value.date)) return false; want.push('date') }
  if (kind === 'weekly') { if (!Number.isInteger(value.weekday) || value.weekday < 1 || value.weekday > 7) return false; want.push('weekday') }
  if (kind === 'monthly') { if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) return false; want.push('day') }
  return same(want)
}

export function normalizeSchedule(value) {
  const kind = value.kind === 'later' ? 'once' : value.kind
  const out = { kind, time_zone: value.time_zone }
  if (kind !== 'now') out.time = value.time
  if (kind === 'once') out.date = value.date
  if (kind === 'weekly') out.weekday = value.weekday
  if (kind === 'monthly') out.day = value.day
  return out
}

function runsOn(schedule, day, weekday) {
  switch (schedule.kind) {
    case 'daily': return true
    case 'weekly': return weekday === schedule.weekday
    case 'weekdays': return weekday <= 5
    case 'monthly': return day === schedule.day
    default: return false
  }
}

export function dueSlot(schedule, nowTs) {
  if (!schedule || !validZone(schedule.time_zone)) return null
  const zone = schedule.time_zone
  const { kind } = schedule
  if (kind === 'now') return {at:0}
  if (typeof schedule.time !== 'string' || !TIME.test(schedule.time)) return null
  const [hour, minute] = schedule.time.split(':').map(Number)
  if (kind === 'once') {
    if (!validDate(schedule.date)) return null
    const [y, m, d] = schedule.date.split('-').map(Number)
    const slot = wallClockSlot(zone, y, m, d, hour, minute)
    return nowTs >= slot.at ? slot : null
  }
  const now = partsIn(zone, nowTs * 1000)
  if (!runsOn(schedule, now.day, now.isoWeekday)) return null
  const slot = wallClockSlot(zone, now.year, now.month, now.day, hour, minute)
  return nowTs >= slot.at ? slot : null
}

export function dueAt(schedule, nowTs) {
  return dueSlot(schedule, nowTs)?.at ?? null
}

export function nextSlot(schedule, nowTs) {
  if (!schedule || schedule.kind === 'now' || !validSchedule(schedule)) return null
  const { time_zone: zone } = schedule
  const [hour, minute] = schedule.time.split(':').map(Number)
  if (schedule.kind === 'once' || schedule.kind === 'later') {
    const [year, month, day] = schedule.date.split('-').map(Number)
    const slot = wallClockSlot(zone, year, month, day, hour, minute)
    return slot.at > nowTs ? slot : null
  }

  const local = partsIn(zone, nowTs * 1000)
  // The 31st may skip a short month. Every recurring rule has a date within 62 calendar days.
  for (let offset = 0; offset <= 62; offset += 1) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset))
    const day = date.getUTCDate()
    const weekday = date.getUTCDay() || 7
    if (!runsOn(schedule, day, weekday)) continue
    const slot = wallClockSlot(zone, date.getUTCFullYear(), date.getUTCMonth() + 1, day, hour, minute)
    if (slot.at > nowTs) return slot
  }
  return null
}

export function nextScheduledSlot(schedule, nowTs) {
  return nextSlot(schedule, nowTs)?.at ?? null
}

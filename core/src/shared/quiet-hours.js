// Team quiet hours (#1166, the E half of #645). A window in wall-clock time that refuses a
// new or edited task whose time lands inside it; a due time is read in that task's own zone,
// so the two are compared as instants (#1199). It is not a mute: nothing here runs when a
// reminder is delivered, because DSH has no hook before one — a task that already fires
// inside the window keeps firing (docs/subsystems/core-host.md).
//
// The window is half-open, `[from, to)`: `from` is quiet and `to` is not, so `22:00–07:00`
// is quiet at 22:00 and free at 07:00. A window whose end is earlier than its start crosses
// midnight.
export const QUIET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

// A refusal the user reads on the form: a named code, like the other refusals.
export const quietError = message => Object.assign(new Error(message), { code: 'bot/quiet-hours' })

// The stored record as the rest of the code reads it: absent, `null`, or `on: false` is off.
export function quietHoursOf(prefs) {
  const record = prefs?.quietHours
  if (record === null || typeof record !== 'object' || Array.isArray(record) || record.on !== true) return { on: false }
  return { on: true, from: record.from, to: record.to }
}

// The settings write. `null` or `{ on: false }` clears the window and off is the absence of
// the record; turning it on needs two well-formed, different times, so an invalid window is
// refused here and never stored as "always quiet".
export function readQuietHours(body, current) {
  if (body === null) return undefined
  if (typeof body !== 'object' || Array.isArray(body)) throw quietError('Quiet hours must be on or off')
  if (body.on === false) return undefined
  if (body.on !== true) throw quietError('Quiet hours must be on or off')
  const from = body.from ?? current?.from
  const to = body.to ?? current?.to
  if (!QUIET_TIME.test(String(from ?? '')) || !QUIET_TIME.test(String(to ?? ''))) throw quietError('Quiet hours need a start and an end time')
  if (from === to) throw quietError('Quiet hours need two different times')
  return { on: true, from, to }
}

// Whether a wall clock (`HH:MM`) sits in the window.
export function inQuietHours(quiet, clock) {
  if (quiet?.on !== true) return false
  return quiet.from < quiet.to ? clock >= quiet.from && clock < quiet.to : clock >= quiet.from || clock < quiet.to
}

// An instant's wall clock in one zone as `HH:MM`; a zone Intl cannot read falls back to the
// host's own, so a bad zone never turns into "not quiet".
export function clockIn(zone, at) {
  const date = new Date(at)
  for (const timeZone of [zone, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    if (typeof timeZone !== 'string' || timeZone === '') continue
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
      const hour = parts.find(part => part.type === 'hour')?.value
      const minute = parts.find(part => part.type === 'minute')?.value
      if (hour !== undefined && minute !== undefined) return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    } catch {
      // An unknown zone: the host's own is next.
    }
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

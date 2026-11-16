// Host-side validation for appearance and send-key prefs. The client module
// (`src/client/appearance.js`) decides how they look; this file only says
// what may be stored.

const MODES = new Set(['light', 'dark', 'auto', 'system'])
const AUTO = new Set(['sun', 'custom'])
const SEND = new Set(['enter', 'shift-enter'])
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DEFAULTS = { mode: 'system', auto: 'sun', from: '19:00', to: '07:00' }

function clock(value, fallback) {
  return typeof value === 'string' && TIME.test(value) ? value : fallback
}

// `null` clears the record (back to the default). An invalid object is refused,
// never stored as "always dark".
export function readAppearance(body, current) {
  if (body === null) return undefined
  if (typeof body !== 'object' || Array.isArray(body)) return false
  const mode = body.mode === undefined ? (current?.mode ?? DEFAULTS.mode) : body.mode
  if (!MODES.has(mode)) return false
  const auto = body.auto === undefined ? (current?.auto ?? DEFAULTS.auto) : body.auto
  if (!AUTO.has(auto)) return false
  const from = clock(body.from, current?.from ?? DEFAULTS.from)
  const to = clock(body.to, current?.to ?? DEFAULTS.to)
  if (body.from !== undefined && (typeof body.from !== 'string' || !TIME.test(body.from))) return false
  if (body.to !== undefined && (typeof body.to !== 'string' || !TIME.test(body.to))) return false
  if (auto === 'custom' && from === to) return false
  return { mode, auto, from, to }
}

export function readSendKey(value) {
  if (value === null || value === 'enter') return undefined
  if (SEND.has(value)) return value === 'enter' ? undefined : value
  return false
}

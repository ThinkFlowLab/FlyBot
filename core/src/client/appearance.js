// Appearance for this window: light, dark, automatic (sunset-to-sunrise or a custom
// night window), or match the system. The chosen palette still comes from themes.js;
// this module only decides whether `data-ds-dark-theme` is on.
// Send-key preference lives here too: it is a General setting persisted with prefs.

export const APPEARANCE_MODES = ['light', 'dark', 'auto', 'system']
export const AUTO_KINDS = ['sun', 'custom']
export const SEND_KEYS = ['enter', 'shift-enter']
export const DEFAULT_APPEARANCE = { mode: 'system', auto: 'sun', from: '19:00', to: '07:00' }
export const DEFAULT_SEND_KEY = 'enter'
export const DEFAULT_LATITUDE = 40
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

// A coarse latitude for the solar estimate when the account has no coordinates.
// Asia/Shanghai is the owner's zone; other common zones are listed so the curve
// is not stuck at mid-latitudes everywhere.
const TZ_LATITUDE = {
  'Asia/Shanghai': 31.23,
  'Asia/Chongqing': 29.56,
  'Asia/Hong_Kong': 22.32,
  'Asia/Taipei': 25.03,
  'Asia/Tokyo': 35.68,
  'Asia/Seoul': 37.57,
  'Asia/Singapore': 1.35,
  'Asia/Kolkata': 28.61,
  'Europe/London': 51.51,
  'Europe/Paris': 48.86,
  'Europe/Berlin': 52.52,
  'America/New_York': 40.71,
  'America/Chicago': 41.88,
  'America/Denver': 39.74,
  'America/Los_Angeles': 34.05,
  'America/Sao_Paulo': -23.55,
  'Australia/Sydney': -33.87,
  UTC: 0,
}

export function timezoneOf(date = new Date(), timeZone) {
  if (typeof timeZone === 'string' && timeZone) return timeZone
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function latitudeForZone(timeZone) {
  return TZ_LATITUDE[timeZone] ?? DEFAULT_LATITUDE
}

export function parseClock(value) {
  if (typeof value !== 'string' || !TIME.test(value)) return null
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

export function formatClock(minutes) {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  const hours = Math.floor(wrapped / 60)
  const mins = wrapped % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

// Local wall-clock minutes past midnight in `timeZone`.
export function localMinutes(date, timeZone) {
  const zone = timezoneOf(date, timeZone)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

function dayOfYear(date, timeZone) {
  const zone = timezoneOf(date, timeZone)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date)
  const year = Number(parts.find(part => part.type === 'year')?.value)
  const month = Number(parts.find(part => part.type === 'month')?.value)
  const day = Number(parts.find(part => part.type === 'day')?.value)
  const utc = Date.UTC(year, month - 1, day)
  const start = Date.UTC(year, 0, 0)
  return Math.round((utc - start) / 86_400_000)
}

// Compact solar estimate: sunrise and sunset as local minutes. Good enough for
// an automatic theme flip; not an almanac. Polar day/night clamps to always
// light or always dark.
export function sunMinutes(date, { latitude, timeZone } = {}) {
  const zone = timezoneOf(date, timeZone)
  const latDeg = Number.isFinite(latitude) ? latitude : latitudeForZone(zone)
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear(date, zone) + 10)) * (Math.PI / 180)
  const lat = latDeg * (Math.PI / 180)
  const cosHa = -Math.tan(lat) * Math.tan(decl)
  if (cosHa >= 1) return { sunrise: 12 * 60, sunset: 12 * 60, alwaysDark: true }
  if (cosHa <= -1) return { sunrise: 0, sunset: 24 * 60, alwaysDark: false, alwaysLight: true }
  const minutesFromNoon = (Math.acos(cosHa) * 180 / Math.PI) / 15 * 60
  const noon = 12 * 60
  return { sunrise: noon - minutesFromNoon, sunset: noon + minutesFromNoon }
}

export function afterSunset(date, options) {
  const sun = sunMinutes(date, options)
  if (sun.alwaysDark) return true
  if (sun.alwaysLight) return false
  const now = localMinutes(date, options?.timeZone)
  return now >= sun.sunset || now < sun.sunrise
}

// Custom night window: dark from `from` until `to`. A window that wraps midnight
// (19:00–07:00) is the usual case. Equal clocks are treated as no window (light).
export function inNightWindow(date, from, to, timeZone) {
  const start = parseClock(from)
  const end = parseClock(to)
  if (start === null || end === null || start === end) return false
  const now = localMinutes(date, timeZone)
  return start < end ? now >= start && now < end : now >= start || now < end
}

export function normalizeAppearance(value) {
  const mode = APPEARANCE_MODES.includes(value?.mode) ? value.mode : DEFAULT_APPEARANCE.mode
  const auto = AUTO_KINDS.includes(value?.auto) ? value.auto : DEFAULT_APPEARANCE.auto
  const from = parseClock(value?.from) !== null ? value.from : DEFAULT_APPEARANCE.from
  const to = parseClock(value?.to) !== null ? value.to : DEFAULT_APPEARANCE.to
  return { mode, auto, from, to }
}

export function appearanceOf(prefs) {
  return normalizeAppearance(prefs?.appearance)
}

export function normalizeSendKey(value) {
  return SEND_KEYS.includes(value) ? value : DEFAULT_SEND_KEY
}

export function sendKeyOf(prefs) {
  return normalizeSendKey(prefs?.sendKey)
}

export function systemDark(media = globalThis.matchMedia) {
  try {
    return typeof media === 'function' ? Boolean(media.call(globalThis, '(prefers-color-scheme: dark)')?.matches) : false
  } catch {
    return false
  }
}

export function isDarkAppearance(prefs, now = new Date(), darkSystem = systemDark(), options = {}) {
  const appearance = appearanceOf(prefs)
  if (appearance.mode === 'light') return false
  if (appearance.mode === 'dark') return true
  if (appearance.mode === 'system') return Boolean(darkSystem)
  const zone = options.timeZone
  if (appearance.auto === 'custom') return inNightWindow(now, appearance.from, appearance.to, zone)
  return afterSunset(now, { timeZone: zone, latitude: options.latitude })
}

export function applyAppearanceAttribute(dark, root) {
  const doc = root?.ownerDocument ?? root ?? (typeof document === 'undefined' ? null : document)
  if (!doc?.documentElement) return dark ? 'dark' : 'light'
  const body = doc.body ?? doc.documentElement
  if (dark) body.setAttribute('data-ds-dark-theme', '')
  else body.removeAttribute('data-ds-dark-theme')
  return dark ? 'dark' : 'light'
}

// The General page and installTheme share this so a stored record, a form draft,
// and the live attribute stay in one shape.
export function appearanceRecord(appearance, { clear = false } = {}) {
  if (clear || appearance == null) return null
  const next = normalizeAppearance(appearance)
  if (next.mode === DEFAULT_APPEARANCE.mode && next.auto === DEFAULT_APPEARANCE.auto
    && next.from === DEFAULT_APPEARANCE.from && next.to === DEFAULT_APPEARANCE.to) return null
  return next
}

export function shouldSendOnKey(event, sendKey) {
  if (!event || event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229) return false
  return normalizeSendKey(sendKey) === 'shift-enter' ? event.shiftKey === true : event.shiftKey !== true
}

export function shouldBreakOnKey(event, sendKey) {
  if (!event || event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229) return false
  return normalizeSendKey(sendKey) === 'shift-enter' ? event.shiftKey !== true : event.shiftKey === true
}

// When the user chose Shift+Enter to send, intercept the shell's Enter-to-send
// composer: Enter inserts a newline, Shift+Enter presses the card's send button.
export function handleComposerSendKey(event, sendKey, { send, insertNewline } = {}) {
  const key = normalizeSendKey(sendKey)
  if (key === DEFAULT_SEND_KEY) return false
  if (shouldSendOnKey(event, key)) {
    event.preventDefault()
    event.stopPropagation()
    send?.()
    return 'send'
  }
  if (shouldBreakOnKey(event, key)) {
    event.preventDefault()
    event.stopPropagation()
    insertNewline?.(event)
    return 'break'
  }
  return false
}

export function composerCardOf(node) {
  return node instanceof Element ? node.closest('[data-composer-card]') : null
}

export function composerFieldOf(event) {
  const target = event?.target
  if (!(target instanceof Element)) return null
  return target.closest('[data-composer-input], textarea, [contenteditable="true"]')
}

export function findSendButton(card) {
  if (!card) return null
  const named = card.querySelector('button[type=submit], button[data-send], [data-composer-send]')
  if (named) return named
  return [...card.querySelectorAll('button')].find((button) => {
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    return /send|发送/i.test(label) && !/dictate|mic|voice|add|plus|录音|听写|添加/i.test(label)
  }) ?? null
}

export function insertComposerNewline(field) {
  if (!field) return
  if (typeof field.value === 'string' && typeof field.selectionStart === 'number') {
    const start = field.selectionStart
    const end = field.selectionEnd ?? start
    const value = field.value
    field.value = `${value.slice(0, start)}\n${value.slice(end)}`
    field.selectionStart = field.selectionEnd = start + 1
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  if (field.isContentEditable || field.getAttribute?.('contenteditable') === 'true') {
    const doc = field.ownerDocument ?? document
    if (typeof doc.execCommand === 'function') doc.execCommand('insertText', false, '\n')
  }
}

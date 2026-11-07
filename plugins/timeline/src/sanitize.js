// Everything the recorder stores and the panel shows that did not come from this plugin
// passes through these two functions: a Bot or group name, a tool name, an id from an
// event. The core's feed cleans its own strings as well; the plugin does not rely on that.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// Bidirectional overrides and isolates reorder text on screen; zero-width characters hide it.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

// Cut on code points, never on UTF-16 units: `max` is a character budget and a unit offset can
// end inside a surrogate pair, so the panel or the exported JSON would carry half a character
// (#2581). The input is flattened first, so a value that already carried an unpaired surrogate is
// never stored as one.
const cutCodePoints = (text, max) => {
  const value = text.toWellFormed()
  if (!Number.isFinite(max) || value.length <= max) return value
  return Array.from(value).slice(0, max).join('')
}

// One line of plain text, no controls, no fence markers, no angle brackets, capped.
export const cleanLabel = (value, max = 60) => {
  let out = String(value ?? '').replace(CONTROLS, ' ').replace(INVISIBLE, '')
  for (let previous; previous !== out;) { previous = out; out = out.replace(/<\s*\/?\s*untrusted-?/gi, '') }
  return cutCodePoints(out.replace(/[<>`"]/g, '').replace(/\s+/g, ' ').trim(), max)
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:_#.@-]{0,159}$/
// An id from an event: a conservative alphabet or nothing.
export const cleanId = value => (typeof value === 'string' && ID.test(value) ? value : undefined)

export const cleanTime = value => (Number.isFinite(value) && value > 0 && value < 8.64e15 ? Math.round(value) : undefined)
export const cleanCount = (value, max = 1e6) => (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0)

// An error code is an enumerated value (RATE_LIMIT, AUTH, ...), never free text: upper-case
// words only, so a message or a key that was put in the field is not kept.
export const cleanCode = value => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : 'UNKNOWN')

// The token counts a turn spent, kept as short-keyed integers (in/cr/cw/out), each capped; a
// turn that reported none gives undefined, so the record stays small.
export const cleanTokens = (value) => {
  if (value === null || typeof value !== 'object') return undefined
  const out = {}
  for (const [from, to] of [['input', 'in'], ['cacheRead', 'cr'], ['cacheWrite', 'cw'], ['output', 'out']]) {
    const count = value[from]
    if (Number.isInteger(count) && count > 0) out[to] = Math.min(count, 1_000_000_000)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

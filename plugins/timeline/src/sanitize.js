// Everything the recorder stores and the panel shows that did not come from this plugin
// passes through these two functions: a Bot or group name, a tool name, an id from an
// event. The core's feed cleans its own strings as well; the plugin does not rely on that.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// Bidirectional overrides and isolates reorder text on screen; zero-width characters hide it.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

// One line of plain text, no controls, no fence markers, no angle brackets, capped.
export const cleanLabel = (value, max = 60) => {
  let out = String(value ?? '').replace(CONTROLS, ' ').replace(INVISIBLE, '')
  for (let previous; previous !== out;) { previous = out; out = out.replace(/<\s*\/?\s*untrusted-?/gi, '') }
  return out.replace(/[<>`"]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:_#.@-]{0,159}$/
// An id from an event: a conservative alphabet or nothing.
export const cleanId = value => (typeof value === 'string' && ID.test(value) ? value : undefined)

export const cleanTime = value => (Number.isFinite(value) && value > 0 && value < 8.64e15 ? Math.round(value) : undefined)
export const cleanCount = (value, max = 1e6) => (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0)

// An error code is an enumerated value (RATE_LIMIT, AUTH, ...), never free text: upper-case
// words only, so a message or a key that was put in the field is not kept.
export const cleanCode = value => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : 'UNKNOWN')

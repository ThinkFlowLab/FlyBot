// Where a bounded prefix may end. Both sides bound text (#1908/#1912/#1916): the host cuts what a
// Bot reads back and what it stores, and a shared label cuts a peer's name. A cut that lands between
// the halves of a surrogate pair reaches a UTF-8 encoder as U+FFFD, so every bound goes through here
// instead of `slice`, and `host/text.js` builds its `cut` on this one implementation.

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = code => code >= 0xdc00 && code <= 0xdfff

// The start of a bounded window, moved back onto a code point boundary.
export const codePointStart = (text, at) => (at > 0 && isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at)

// The end of a bounded prefix, moved back onto a code point boundary.
export const codePointEnd = (text, end) => (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end - 1 : end)

// Whether a text is inside a bound (#2321). Judged in code points, not in UTF-16 units: a character
// outside the BMP costs one of the budget, so a 300-character text is under a 400-character limit
// even though it is 600 units long, and a bound never cuts text that is already under its own limit.
export const fits = (text, max) => {
  const value = String(text)
  let n = 0
  for (let i = 0; i < value.length; n += 1) i += value.codePointAt(i) > 0xffff ? 2 : 1
  return n <= max
}

// A bounded prefix that never splits a surrogate pair. `cut` says whether anything was dropped.
// `max` stays a UTF-16 unit budget, on purpose: its callers bound the units a stored field may cost
// (a capability description at 2000, the open-page snapshot's address and title, a busy-ack prompt
// at 600), and those shapes are pinned by tests. `fits` above is the *character* judgment, for a
// consumer whose budget is characters (#2321); the two questions differ on purpose, and what must
// never differ is that the kept prefix ends on a code point boundary (#1963, #2581).
// The input is flattened first (#1963): a string that already carried an unpaired surrogate went
// straight through, so the caller stored a value that was not well formed. U+FFFD is one UTF-16 unit
// for the one it replaces, so a well-formed input keeps its exact prefix and its `cut` flag.
export const cut = (text, max) => {
  const flat = String(text).toWellFormed()
  return { text: flat.slice(0, codePointEnd(flat, max)), cut: flat.length > max }
}

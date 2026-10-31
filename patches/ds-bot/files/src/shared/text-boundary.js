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

// A bounded prefix that never splits a surrogate pair. `cut` says whether anything was dropped.
export const cut = (text, max) => ({ text: text.slice(0, codePointEnd(text, max)), cut: text.length > max })

// What a preview may show of a stored line (#130 follow-up).
//
// A remote line is fenced for the Bot (`<untrusted-message from="…">…</untrusted-message>`), and the
// fence is data: a person reading a sidebar row must never see it. `unwrapUntrusted` handles the one
// shape this code writes today, a complete wrap. A stored line can also carry a *broken* fence — an
// older write, a hand-edited log, a nested fragment — and then the wrapper leaks into the preview as
// `from="User"> B踢后测4 >`, which is what a real instance showed in its sidebar (#1335).
//
// So a preview is read the same way whatever shape the fence is in: unwrap the complete wraps, then
// remove whatever marker fragments are left, until neither changes the text. Words that never were
// part of a marker are kept, because a preview is still the line someone said.
const FENCE_TAG = /<\s*\/?\s*untrusted-(?:message|file)\b[^<>]*>/gi
// What is left when the tag name alone was stripped by an older pass: ` from="User">`.
const FENCE_ATTR = /\bfrom\s*=\s*(?:"[^"]*"|'[^']*')\s*>/gi
// A lone opener/closer with its attributes cut short, e.g. `<untrusted-message from="User">` minus `>`.
const FENCE_TAIL = /<[^<>]*\buntrusted-(?:message|file)\b[^<>]*$/i
// Only the marker word is left, its brackets already gone: `untrusted-message>` / `/untrusted-file`.
const FENCE_BARE = /(?:\/\s*)?untrusted-(?:message|file)\b\s*>?/gi

export function stripFence(text) {
  let out = String(text ?? '')
  for (let previous; previous !== out;) {
    previous = out
    out = out.replace(FENCE_TAG, '').replace(FENCE_ATTR, '')
  }
  return out.replace(FENCE_TAIL, '').replace(FENCE_BARE, '')
}

// The words of a stored line as a preview shows them: inner text of a wrap, no marker of any shape,
// and one line, because a row is one line.
export function visibleText(text) {
  let out = String(text ?? '')
  for (let previous; previous !== out;) {
    previous = out
    const open = out.indexOf('<untrusted-message')
    if (open < 0) break
    const close = out.lastIndexOf('</untrusted-message>')
    const inner = close > open ? out.slice(out.indexOf('>', open) + 1, close) : out
    out = stripFence(inner)
  }
  return stripFence(out).replace(/\s+/g, ' ').trim()
}

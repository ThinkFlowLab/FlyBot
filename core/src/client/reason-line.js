// Where a hold says why it waits (P-538). The host's sentence was reachable only as a `title` on
// the session dock's card — invisible to a keyboard, a touch screen and a screen reader — and the
// waiting bubble in a chat had no copy of it at all. Both drawing points read it here, so the two
// shapes cannot drift apart.
//
// The visible line is bounded to 200 code points with an ellipsis, and the whole sentence stays in
// `title`: a long reason is cut on screen without hiding its end from the person deciding the hold.
// The bound counts code points (`fits`) and falls between them, so an emoji is never split into two
// surrogates. A reason that is empty or only whitespace is no reason: the caller draws nothing,
// because an empty line would announce a hold with nothing to say.
import { fits } from '../shared/text-boundary.js'

export const REASON_POINTS = 200

// `{ text, title }`, or `null` when the host gave no reason to show.
export const reasonLine = (reason) => {
  if (typeof reason !== 'string' || reason.trim() === '') return null
  const full = reason.toWellFormed()
  return { text: fits(full, REASON_POINTS) ? full : [...full].slice(0, REASON_POINTS).join('') + '…', title: full }
}

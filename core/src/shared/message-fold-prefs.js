// Host-side validation for message-folding prefs. The client module
// (`src/client/message-fold.js`) decides how bubbles look; this file only says
// what may be stored.

const MODES = new Set(['compact', 'standard', 'none'])
export const DEFAULT_FOLDING = { mode: 'standard', documentCards: true }

// `null` clears the record (back to the default). An invalid object is refused,
// never stored as "always unfolded".
export function readFolding(body, current) {
  if (body === null) return undefined
  if (typeof body !== 'object' || Array.isArray(body)) return false
  const mode = body.mode === undefined ? (current?.mode ?? DEFAULT_FOLDING.mode) : body.mode
  if (!MODES.has(mode)) return false
  const documentCards = body.documentCards === undefined
    ? (current?.documentCards ?? DEFAULT_FOLDING.documentCards)
    : body.documentCards
  if (typeof documentCards !== 'boolean') return false
  return { mode, documentCards }
}

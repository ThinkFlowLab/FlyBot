// Cut on code points, never on UTF-16 units. Peer strings are stored (settings.shareRequests),
// used as remote session names and sent in cross-home payloads, so a slice that ends inside a
// surrogate pair leaves a lone half that every later UTF-8 write reads as U+FFFD (#2581).
// Both social.js and mcp-client.js cut with this one copy (#2693).
export const cutCodePoints = (value, max) => {
  const text = String(value ?? '').toWellFormed()
  if (!Number.isFinite(max) || text.length <= max) return text
  return Array.from(text).slice(0, max).join('')
}

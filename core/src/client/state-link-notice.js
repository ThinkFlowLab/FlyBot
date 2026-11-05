// P-556: a save over a linked `state.json` replaces the name with a regular file of this home's own
// and never writes through the link, so the file the person linked keeps every byte and its last
// write time. The host counts those saves and the state answer carries the count together with the
// generation of the host process that made it — a restart starts the count at 0 again — and a window
// that has not said so yet says it once, in the same toast the client shows for confirmations.
// `seen` is what this window has already announced, remembered between polls: `{ gen, count }`.
export const LINK_REPLACED_NOTICE = 'Saved as a separate file; the file the link pointed at was not changed.'

// What one answer says about one host process: the generation that counted, and how many of its saves
// replaced a link. Anything else — a missing field, a bare number, negative or unreadable counts, a
// count with no generation — is not a comparable count, so it answers null and announces nothing.
export const stateLinkCount = (value) => {
  const field = value?.stateFileLinkReplaced
  if (!field || typeof field !== 'object') return null
  const gen = typeof field.gen === 'string' ? field.gen : ''
  const count = Number(field.count)
  if (gen === '' || !Number.isFinite(count) || count < 0) return null
  return { gen, count: Math.floor(count) }
}

// What this window remembers, or null when it remembers nothing: a page that has just loaded has no
// memory, and its first count is a baseline rather than news.
export const stateLinkMemory = (seen) => {
  if (!seen || typeof seen !== 'object') return null
  const gen = typeof seen.gen === 'string' ? seen.gen : ''
  if (gen === '') return null
  const count = Number(seen.count)
  return { gen, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0 }
}

// A count is only comparable inside the process that made it: a new host process starts it at 0, so
// the first save of a restarted host can carry a number the window already passed. Three cases, and
// they are different questions (Security, on review of #2473):
// - no memory (a page that has just loaded): the answer's count becomes the baseline and nothing is
//   said, so a refresh never replays a notice about a save the person was already told about;
// - memory under another generation (the host restarted while this window stayed open): the baseline
//   resets to 0 — not to the answer's count, which would swallow the very save that came with the
//   restart — so `count > 0` says that save once;
// - memory under the same generation: the usual `count > known`, quiet on a repeated `unchanged` and
//   on a host that replaced no link.
export const stateLinkNotice = (value, seen) => {
  const known = stateLinkMemory(seen)
  const answer = stateLinkCount(value)
  if (answer === null) return { seen: known ?? { gen: '', count: 0 }, announce: false }
  if (known === null) return { seen: answer, announce: false }
  if (answer.gen !== known.gen) {
    return answer.count > 0
      ? { seen: answer, announce: true }
      : { seen: { gen: answer.gen, count: 0 }, announce: false }
  }
  return answer.count > known.count ? { seen: answer, announce: true } : { seen: known, announce: false }
}

// One poll's worth of that decision: say the sentence when the count is news, and answer what the
// window now remembers. A window that cannot draw (no `say`) still remembers, so a line it missed
// while it could not draw is not repeated once it can.
export const announceStateLink = (value, seen, say) => {
  const next = stateLinkNotice(value, seen)
  if (next.announce) say?.(LINK_REPLACED_NOTICE)
  return next.seen
}

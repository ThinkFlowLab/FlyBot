// The natural day a timestamp falls in, in the caller's time zone (#2684). `en-CA` prints ISO
// order, which is what the comparison needs; an unknown zone throws here, so a caller that takes
// one from outside (a board read) resolves it with `resolveTimeZone` first.
//
// This was exported by `project-metrics.js`; the core's turn budget needs the same key, and the
// metrics moved to `plugins/project`, so the function lives here and the plugin takes it back
// through the host seam `flybot.projectHost()` (`core/src/host/project-host.js`).
export function dayKey(ms, timeZone = 'UTC') {
  if (!Number.isFinite(ms)) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return parts.format(new Date(ms))
}

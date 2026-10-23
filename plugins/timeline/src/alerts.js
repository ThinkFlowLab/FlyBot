// Durable alerts (#584): the timeline already draws failures and waits, but every read re-derives
// "is something wrong" from the window alone and cannot say since when. This tracker keeps state
// across reads: a condition that holds opens ONE alert, a condition that clears resolves it, and a
// resolved alert stays readable for a short grace window instead of vanishing on the next poll.
// Pure state machine: a `timeline/window` answer in, `{ open, resolved, changed }` out. It records
// nothing, sends nothing and touches no Session; the endpoint over it is read-only.
import { buildHealth } from './health.js'

// A handoff that has waited this long is stuck (#469's "waiting too long"; the issue leaves the
// threshold open, so this is the documented default and the tracker takes it as an argument).
export const STUCK_MS = 15 * 60 * 1000
// How long a resolved alert stays readable, so a reader polling slower than the transition still
// sees that it cleared.
export const RESOLVED_KEPT_MS = 60 * 1000

const SORTS = { open: (a, b) => a.since - b.since || a.id.localeCompare(b.id), resolved: (a, b) => a.resolvedAt - b.resolvedAt || a.id.localeCompare(b.id) }

// Minutes, matching the threshold's unit; a sub-minute threshold still reads in seconds.
const waited = ms => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`)

/**
 * Builds the tracker. `stuckMs` is how long an unanswered request must wait before it opens a
 * `stuck` alert; `resolveMs` is how long a resolved alert is kept; `now(ms)` is the clock used
 * when a folded window carries no `now`.
 *
 * `fold(window)` returns `{ version, now, open, resolved, changed, stale }`:
 * - `open`: one alert per condition that holds — `errors` (a Bot fails most of its turns),
 *   `waiting` (a Bot's request is unanswered) or `stuck` (a handoff waited longer than `stuckMs`).
 *   An alert is `{ id, code, subject, detail, since, seenAt }`, plus `name` for a Bot, and
 *   `from` / `to` / `waitedMs` for a stuck handoff. `id` is stable while the condition holds
 *   (`errors:<bot>`, `waiting:<bot>`, `stuck:<exchange>`), so polling again never opens a second.
 * - `resolved`: alerts that cleared, each with `resolvedAt`, kept for `resolveMs`.
 * - `changed`: true only when this fold opened or resolved something; a detail that changes while
 *   the alert keeps holding is not a transition.
 * - `stale`: true when the folded window ends before the last one folded (a look-back), in which
 *   case the state is returned untouched — an old window never resolves a live alert.
 */
export function createAlertTracker({ stuckMs = STUCK_MS, resolveMs = RESOLVED_KEPT_MS, now = Date.now } = {}) {
  const stuckAfter = Number.isFinite(stuckMs) && stuckMs >= 0 ? stuckMs : STUCK_MS
  const keep = Number.isFinite(resolveMs) && resolveMs >= 0 ? resolveMs : RESOLVED_KEPT_MS
  const open = new Map()
  const resolved = new Map()
  let lastAt = -Infinity

  // The conditions a window carries, keyed by alert id. `errors` and `waiting` come from
  // `buildHealth` so the alert reads the same numbers (and the same thresholds) as the health view.
  const conditions = (window) => {
    const found = new Map()
    for (const bot of buildHealth(window ?? {}).bots) {
      for (const flag of bot.flags) {
        if (flag.code !== 'errors' && flag.code !== 'waiting') continue
        const id = `${flag.code}:${bot.id}`
        found.set(id, { id, code: flag.code, subject: bot.id, name: bot.name, detail: flag.detail })
      }
    }
    for (const request of window?.stuck ?? []) {
      if (typeof request?.id !== 'string' || !(request.waitedMs >= stuckAfter)) continue
      const id = `stuck:${request.id}`
      found.set(id, {
        id, code: 'stuck', subject: request.id,
        detail: `no reply for ${waited(request.waitedMs)}`,
        from: request.from, to: request.to, waitedMs: request.waitedMs,
      })
    }
    return found
  }

  const fold = (window) => {
    const at = Number.isFinite(window?.now) ? window.now : now()
    if (at < lastAt) {
      return {
        version: 1, now: at, stale: true, changed: false,
        open: [...open.values()].map(alert => ({ ...alert })).sort(SORTS.open),
        resolved: [...resolved.values()].map(alert => ({ ...alert })).sort(SORTS.resolved),
      }
    }
    lastAt = at
    const current = conditions(window)
    let changed = false
    const cleared = []
    for (const [id, alert] of open) if (!current.has(id)) cleared.push([id, alert])
    for (const [id, alert] of cleared) {
      open.delete(id)
      resolved.set(id, { ...alert, resolvedAt: at })
      changed = true
    }
    for (const [id, condition] of current) {
      const holding = open.get(id)
      if (holding) {
        if (holding.detail !== condition.detail) holding.detail = condition.detail
        holding.seenAt = at
        continue
      }
      open.set(id, { ...condition, since: at, seenAt: at })
      // A condition that comes back while its resolution is still on display is holding again:
      // the alert re-opens with a fresh `since`, and the stale resolution is not reported twice.
      resolved.delete(id)
      changed = true
    }
    const expired = []
    for (const [id, alert] of resolved) if (at - alert.resolvedAt >= keep) expired.push(id)
    for (const id of expired) resolved.delete(id)
    return {
      version: 1, now: at, stale: false, changed,
      open: [...open.values()].map(alert => ({ ...alert })).sort(SORTS.open),
      resolved: [...resolved.values()].map(alert => ({ ...alert })).sort(SORTS.resolved),
    }
  }

  return { fold }
}

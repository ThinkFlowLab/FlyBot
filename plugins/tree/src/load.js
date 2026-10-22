// Runtime load of tree Bots (#507): how many turns each Bot is running right now, so a
// coordinator can route a new part to a child that is free instead of stacking work on a busy
// one. The core's activity feed (turn.start / turn.end) is the only input; it carries ids and
// times, never text. Pure and process-local: nothing here is persisted.
//
// How long a turn has been open (#624): a count alone cannot tell a long turn from a stuck one —
// `load: 1` read identically for a 47-minute-old turn that never consumed its queue and for a
// turn three seconds in. Each open turn's start is kept, so `openFor()` answers the age of the
// oldest one and a reader can draw its own line. It is a hint for routing, never a gate: this
// plugin cannot see a Bot's inbox, so a legitimately long turn also ages.
export const STALLED_AFTER_MS = 12 * 60_000

const minutes = ms => Math.max(1, Math.round(ms / 60_000))

export function createLoadTracker({ now = Date.now } = {}) {
  /** @type {Map<string, number[]>} start times of the open turns per Bot id, oldest first */
  const open = new Map()
  const timesOf = id => open.get(id) ?? []
  return {
    start(id) {
      if (typeof id !== 'string' || id === '') return
      const times = timesOf(id)
      times.push(now())
      open.set(id, times)
    },
    end(id) {
      if (typeof id !== 'string' || id === '') return
      const times = timesOf(id)
      // Oldest first, so an end drops the oldest still-open turn and what remains is the age of the
      // oldest one left. The end events may arrive in any order; only the count has to stay right.
      times.shift()
      if (times.length === 0) open.delete(id)
      else open.set(id, times)
    },
    of(id) {
      return timesOf(id).length
    },
    /** Age in ms of the oldest open turn, 0 when the Bot is idle. */
    openFor(id, at = now()) {
      const times = timesOf(id)
      if (times.length === 0) return 0
      return Math.max(0, at - times[0])
    },
    snapshot() {
      return Object.fromEntries([...open].map(([id, times]) => [id, times.length]))
    },
  }
}

/** How a load count reads to the model: idle, working, or busy with the running count. */
export function loadWord(count) {
  const n = Number(count) || 0
  if (n <= 0) return 'idle'
  if (n === 1) return 'working'
  return `busy (${n} running)`
}

/**
 * One prompt line for a coordinator: which of its direct children are free and which are busy,
 * so it can send a part to an idle one. Undefined when the Bot has no children (nothing to route).
 * A child whose oldest open turn is past `STALLED_AFTER_MS` says how long it has been open, so a
 * coordinator can tell "busy" from "has not ended a turn in 47 minutes" (#624).
 */
export function loadLine(children, countOf, openForOf = () => 0) {
  if (!Array.isArray(children) || children.length === 0) return undefined
  const parts = children.map(child => {
    const count = Number(countOf(child.id)) || 0
    const age = Number(openForOf(child.id)) || 0
    if (count <= 0 || age < STALLED_AFTER_MS) return `${child.name}: ${loadWord(count)}`
    const waited = count === 1
      ? `working (${minutes(age)} min, no turn ended)`
      : `busy (${count} running, oldest open ${minutes(age)} min)`
    return `${child.name}: ${waited}`
  })
  return `Child load right now — ${parts.join(', ')}. Send a new part to a child that is idle or working before one that is busy.`
}

// Runtime load of tree Bots (#507): how many turns each Bot is running right now, so a
// coordinator can route a new part to a child that is free instead of stacking work on a busy
// one. The core's activity feed (turn.start / turn.end) is the only input; it carries ids and
// times, never text. Pure and process-local: nothing here is persisted.
export function createLoadTracker() {
  /** @type {Map<string, number>} open turns per Bot id */
  const open = new Map()
  return {
    start(id) {
      if (typeof id !== 'string' || id === '') return
      open.set(id, (open.get(id) ?? 0) + 1)
    },
    end(id) {
      if (typeof id !== 'string' || id === '') return
      const next = (open.get(id) ?? 0) - 1
      if (next <= 0) open.delete(id)
      else open.set(id, next)
    },
    of(id) {
      return open.get(id) ?? 0
    },
    snapshot() {
      return Object.fromEntries(open)
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
 */
export function loadLine(children, countOf) {
  if (!Array.isArray(children) || children.length === 0) return undefined
  const parts = children.map(child => `${child.name}: ${loadWord(countOf(child.id))}`)
  return `Child load right now — ${parts.join(', ')}. Send a new part to a child that is idle or working before one that is busy.`
}

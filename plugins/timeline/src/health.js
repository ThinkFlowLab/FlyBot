// A team-health read model (#357): the window's raw numbers turned into per-Bot signals and a
// short set of flags a person can act on, so observability becomes a decision instead of a chart.
// Pure: a window in, a plain object out. It reads only what the window already carries (turns,
// errors, utilization, waits), so it records nothing new and never touches a Session.
const ERROR_RATE_MIN = 0.5
const ERROR_TURNS_MIN = 3
const BUSY_SHARE = 0.9

const share = (part, whole) => (whole > 0 ? part / whole : 0)
const round = value => Math.round(value * 1000) / 1000

/**
 * `window` is a `timeline/window` answer. Resolves `{ version, now, windowMs, live, ok, bots,
 * unhealthy }`. Each Bot carries its turns, errors, error rate, share of the window it was busy,
 * whether it is running now, how many of its requests are unanswered, and flags
 * (`errors` / `busy` / `idle` / `waiting`). `ok` is false when any Bot has an `errors` or
 * `waiting` flag; `unhealthy` names them.
 */
export function buildHealth(window = {}) {
  const lanes = new Map((window.lanes ?? []).map(lane => [lane.id, lane]))
  // Unanswered requests per sender Bot: where a Bot's work is waiting on someone else.
  const waitingOn = new Map()
  for (const edge of window.edges ?? []) {
    if (!(edge?.unanswered > 0) || typeof edge.from !== 'string') continue
    waitingOn.set(edge.from, (waitingOn.get(edge.from) ?? 0) + edge.unanswered)
  }
  const bots = (window.utilization ?? []).map((use) => {
    const lane = lanes.get(use.lane)
    const errorRate = share(use.errors, use.turns)
    const busyShare = share(use.busyMs, use.windowMs)
    const waiting = waitingOn.get(use.lane) ?? 0
    const flags = []
    if (use.turns >= ERROR_TURNS_MIN && errorRate >= ERROR_RATE_MIN) flags.push({ code: 'errors', detail: `${use.errors} of ${use.turns} turns failed` })
    if (use.turns > 0 && busyShare >= BUSY_SHARE) flags.push({ code: 'busy', detail: `busy ${Math.round(busyShare * 100)}% of the window` })
    if (use.turns === 0) flags.push({ code: 'idle', detail: 'no turns in the window' })
    if (waiting > 0) flags.push({ code: 'waiting', detail: `${waiting} request(s) unanswered` })
    return {
      id: use.lane,
      name: lane?.name ?? use.lane,
      ...(lane?.main === true ? { main: true } : {}),
      turns: use.turns, errors: use.errors, errorRate: round(errorRate), busyShare: round(busyShare),
      running: use.running === true, waiting, flags,
    }
  })
  const unhealthy = bots.filter(bot => bot.flags.some(flag => flag.code === 'errors' || flag.code === 'waiting')).map(bot => bot.id)
  return { version: 1, now: window.now ?? null, windowMs: window.windowMs ?? null, live: window.live === true, bots, unhealthy, ok: unhealthy.length === 0 }
}

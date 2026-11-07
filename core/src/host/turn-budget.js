// Team turn budget (#645, the C half; owner decision 2026-11-07). A team spends model turns, and
// a team spends too many of them on work nobody asked for: the count is per team-local day, and at
// or over the cap only a turn the user started themselves is dispatched. A timer's turn, a tidy's,
// a round a Bot started and a kickoff are refused before the model — no request, no line to the
// user, one line in the host log. `0` is off.
//
// Two facts keep the count honest. A turn is spent when its own first step starts
// (`session/event` `step/start`, step 1), so a turn of many steps costs one and a turn the gate
// refused never costs any. The gate is `agent/pre-step`, the seam parts.js already refuses a
// step at: `{ kind: 'reject' }` ends the turn before a model call, and DSH reports it as blocked.
//
// Whose turn it is comes from turns.js's recorded verdict (turn-origin.js): `owner` is the user's
// own message or a line they wrote in a group; everything else — `scheduled`, `other`, or a turn
// whose messages carried no verdict — is system-started and waits for the counter to reset.
import { dayKey } from './project-metrics.js'
import { OWNER } from './turn-origin.js'

// The cap a fresh team starts with, and the day a team counted in before it had a zone of its own.
export const TEAM_TURNS_PER_DAY = 200
export const TEAM_TURN_ZONE = 'Asia/Shanghai'

// The cap the team runs with: a whole number, `0` is off, and an unset or malformed field keeps
// the fresh-team default rather than quietly turning the budget off.
export function turnBudgetOf(prefs) {
  const value = prefs?.turnBudget
  return Number.isSafeInteger(value) && value >= 0 ? value : TEAM_TURNS_PER_DAY
}

// The settings write (`prefs` on the api): a whole number of turns, `0` for off, `null` to clear
// back to the default. Anything else is refused, never stored as a number nobody meant.
export function readTurnBudget(value) {
  if (value === null || value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Turn budget must be a whole number of turns (0 turns the budget off)'), { code: 'bot/turn-budget' })
  return value
}

// What the saved counter says about one day: a record from another day is not a count at all, so
// the day boundary needs no timer — it resets the first time it is read or written.
export function turnsUsed(record, day) {
  return record?.day === day && Number.isSafeInteger(record.count) && record.count > 0 ? record.count : 0
}

// The team's day. The clock the host already keeps (`timeZone`) is the team's zone; a host without
// one counts in Asia/Shanghai, and a zone Intl cannot read falls back to it rather than throwing.
export function teamDayKey(rt, at) {
  const wanted = typeof rt?.config?.timeZone === 'string' && rt.config.timeZone !== '' ? rt.config.timeZone : TEAM_TURN_ZONE
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: wanted })
    return dayKey(at, wanted)
  } catch {
    return dayKey(at, TEAM_TURN_ZONE)
  }
}

export function install(rt) {
  const { ctx } = rt
  const day = () => teamDayKey(rt, Date.now())
  const nameOf = id => rt.botOf(rt.selfOf(id))?.name ?? id

  // One turn, one spend, on its first step. A refused turn never reaches a step and a long turn
  // pays once, so the counter measures dispatched turns and not model calls.
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || event?.type !== 'step/start' || event.data?.step !== 1) return
    if (!rt.isBotSession(id)) return
    const today = day()
    void rt.mutate(() => {
      const used = turnsUsed(rt.state.turns, today)
      rt.state.turns = { day: today, count: used + 1 }
    }).catch(error => rt.warn('ds-bot: turn budget: a turn was not counted: %s', error))
  })

  // Before the turn's first step reaches a model: over the cap, only the user's own turn goes on.
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    await rt.load()
    if (step !== 1 || !rt.isBotSession(agent.id)) return next()
    const cap = turnBudgetOf(rt.state.prefs)
    if (cap === 0) return next()
    const today = day()
    const used = turnsUsed(rt.state.turns, today)
    if (used < cap) return next()
    const origin = rt.live?.get(agent.id)?.origin
    if (origin === OWNER) return next()
    rt.warn('ds-bot: turn budget: %d of %d turns used on %s (%s); a %s turn for %s is not dispatched', used, cap, today, TEAM_TURN_ZONE, origin ?? 'system', nameOf(agent.id))
    return { kind: 'reject' }
  }, { prepend: true })
}

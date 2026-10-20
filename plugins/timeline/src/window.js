// The read model behind `timeline/window`: folds the trace records into what the three
// views draw, for one time window. Pure: records in, a plain object out.
//
// Honesty rules the model keeps (the panel repeats them):
//  - A message is "delivered" when it reached the recipient's log. The core cannot see
//    delivered-to-model or read stamps, so none are modelled.
//  - A turn with no end record is running only if the recorder has been up since it
//    started; one an earlier run left open is closed at the last record before the restart
//    and marked `lost` (its true end is unknown).
//  - Idle is "no running turn": a Bot waiting on a model call or a slow tool is busy.
//  - "model" time is turn time outside tool calls. It includes queueing and host overhead;
//    it is not a measured model latency (phase 2 derives that from DSH's own timed streams).
import { cleanCode, cleanLabel } from './sanitize.js'

export const WINDOW_LIMITS = Object.freeze({ min: 30_000, max: 24 * 3600 * 1000, default: 15 * 60_000 })
const LIMIT = Object.freeze({ turns: 2000, tools: 6000, exchanges: 3000 })

const median = (values) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
// Sorted, merged, clipped intervals: [a, b)
const union = (spans, lo, hi) => {
  const clipped = spans.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out = []
  for (const span of clipped) {
    const last = out.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else out.push([...span])
  }
  return out
}
const total = spans => spans.reduce((sum, [a, b]) => sum + (b - a), 0)
const intersect = (xs, ys) => {
  const out = []
  for (const [a, b] of xs) for (const [c, d] of ys) { const lo = Math.max(a, c); const hi = Math.min(b, d); if (hi > lo) out.push([lo, hi]) }
  return union(out, -Infinity, Infinity)
}

export const clampWindow = (windowMs) => {
  const value = Number(windowMs)
  if (!Number.isFinite(value)) return WINDOW_LIMITS.default
  return Math.min(WINDOW_LIMITS.max, Math.max(WINDOW_LIMITS.min, Math.round(value)))
}

const laneOfParty = (party) => (party?.k === 'u' ? 'user' : party?.id)
const FRIEND_PREFIX = 'f:'

// Folds records into turns, tools and messages. Records are trusted for shape only after
// this check: the file may be old, hand-edited or from another version.
function fold(records) {
  const turns = new Map()
  const tools = new Map()
  const messages = []
  let last = 0
  const closeOpen = () => {
    for (const turn of turns.values()) if (turn.t1 === undefined) { turn.t1 = Math.max(turn.t0, last); turn.lost = true }
    for (const tool of tools.values()) if (tool.t1 === undefined) { tool.t1 = Math.max(tool.t0, last); tool.lost = true }
  }
  for (const record of records) {
    if (record === null || typeof record !== 'object' || typeof record.r !== 'string' || !Number.isFinite(record.t)) continue
    switch (record.r) {
      case 'boot':
        closeOpen()
        break
      case 'ts':
        if (typeof record.id === 'string') turns.set(record.id, { id: record.id, bot: record.bot, room: record.room, place: record.pl, t0: record.t, trigger: record.x ? { x: record.x, from: record.f, role: record.ro } : undefined })
        break
      case 'te': {
        const turn = turns.get(record.id)
        if (turn && turn.t1 === undefined) Object.assign(turn, { t1: Math.max(turn.t0, record.t), outcome: record.o, errorCode: record.ec, model: typeof record.md === 'string' ? cleanLabel(record.md, 120) : undefined })
        break
      }
      case 'ks':
        if (typeof record.id === 'string' && typeof record.tid === 'string') tools.set(`${record.tid}/${record.id}`, { id: record.id, turn: record.tid, name: record.nm, t0: record.t })
        break
      case 'ke': {
        const tool = tools.get(`${record.tid}/${record.id}`)
        if (tool && tool.t1 === undefined) Object.assign(tool, { t1: Math.max(tool.t0, record.t), ok: record.ok === true, interrupted: record.ir === true })
        break
      }
      case 'm':
        if (typeof record.id === 'string') messages.push({ id: record.id, t: record.t, from: record.f, to: record.to, role: record.ro, hop: record.hop ?? 0, replyTo: record.rt, room: record.room, n: record.n ?? 0 })
        break
      default:
    }
    last = Math.max(last, record.t)
  }
  return { turns, tools, messages, last }
}

// Greedy rows so overlapping turns of one lane do not draw on top of each other.
function assignRows(items) {
  const ends = []
  for (const item of [...items].sort((a, b) => a.t0 - b.t0)) {
    let row = ends.findIndex(end => end <= item.t0)
    if (row === -1) row = ends.length
    ends[row] = item.t1 ?? Number.POSITIVE_INFINITY
    item.row = row
  }
  return ends.length
}

export function buildWindow(records, { now = Date.now(), to, windowMs, bots = [], rooms = [], names = {}, stats } = {}) {
  const span = clampWindow(windowMs)
  const hi = Number.isFinite(to) ? Math.min(to, now) : now
  const lo = hi - span
  const live = hi >= now - 1000
  const { turns, tools, messages, last } = fold(records)
  const oldest = records.find(record => Number.isFinite(record?.t))?.t
  let truncated = false

  const end = turn => Math.min(turn.t1 ?? now, hi)
  const overlaps = turn => turn.t0 < hi && end(turn) > lo
  const turnList = [...turns.values()].filter(overlaps)
  const botTurns = turnList.filter(turn => turn.place !== 'room' && turn.bot)
  const roundTurns = turnList.filter(turn => turn.place === 'room' && turn.room)
  const inWindow = messages.filter(message => message.t >= lo && message.t <= hi)

  // ---- lanes: You, every current Bot (idle ones too), Bots seen in the window that are gone, groups with activity
  const botName = new Map(bots.map(bot => [bot.id, cleanLabel(bot.name)]))
  const roomName = new Map(rooms.map(room => [room.id, cleanLabel(room.name)]))
  const stored = { bots: names.bots ?? {}, rooms: names.rooms ?? {}, friends: names.friends ?? {} }
  const current = new Set(bots.map(bot => bot.id))
  const seenBots = new Set()
  const seenRooms = new Set()
  const seenFriends = new Set()
  for (const turn of botTurns) { seenBots.add(turn.bot); if (turn.room) seenRooms.add(turn.room) }
  for (const turn of roundTurns) seenRooms.add(turn.room)
  for (const message of inWindow) {
    for (const party of [message.from, message.to]) {
      if (party?.k === 'b') seenBots.add(party.id)
      if (party?.k === 'r') seenRooms.add(party.id)
      if (party?.k === 'f') seenFriends.add(party.id)
    }
    if (message.room) seenRooms.add(message.room)
  }
  const lanes = [{ id: 'user', kind: 'user', name: 'You' }]
  for (const bot of [...bots.filter(item => item.isMain), ...bots.filter(item => !item.isMain)]) {
    lanes.push({ id: bot.id, kind: 'bot', name: botName.get(bot.id) || bot.id, ...(bot.isMain ? { main: true } : {}) })
  }
  // A raw session id is never a lane name: a gone Bot or group shows its remembered name, else a
  // plain "Removed Bot" / "Removed group" (numbered when there are several).
  const fallback = (label, count) => (count === 0 ? label : `${label} ${count + 1}`)
  let removedBots = 0
  let removedRooms = 0
  for (const id of seenBots) if (!current.has(id)) lanes.push({ id, kind: 'bot', name: cleanLabel(stored.bots[id]) || fallback('Removed Bot', removedBots++), removed: true })
  for (const id of seenRooms) lanes.push({ id, kind: 'room', name: roomName.get(id) || cleanLabel(stored.rooms[id]) || fallback('Removed group', removedRooms++), ...(roomName.has(id) ? {} : { removed: true }) })
  // A friend's Bot lives on another team: messages only, no turns, no utilization.
  for (const id of seenFriends) lanes.push({ id, kind: 'friend', name: cleanLabel(stored.friends[id]) || cleanLabel(id.slice(FRIEND_PREFIX.length)) || 'Friend' })
  const laneIds = new Set(lanes.map(lane => lane.id))

  // ---- turns (with their tools) per Bot lane, rounds per group lane
  const toolsOf = new Map()
  for (const tool of tools.values()) toolsOf.set(tool.turn, [...(toolsOf.get(tool.turn) ?? []), tool])
  const shape = (turn) => ({
    id: turn.id,
    lane: turn.place === 'room' ? turn.room : turn.bot,
    place: turn.place,
    ...(turn.room && turn.place !== 'room' ? { room: turn.room } : {}),
    t0: turn.t0,
    t1: turn.t1 ?? null,
    running: turn.t1 === undefined && live,
    ...(turn.outcome ? { outcome: turn.outcome } : {}),
    ...(turn.errorCode ? { errorCode: cleanCode(turn.errorCode) } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.lost ? { lost: true } : {}),
    ...(turn.trigger ? { trigger: { exchangeId: turn.trigger.x, ...(turn.trigger.from ? { from: laneOfParty(turn.trigger.from) } : {}), ...(turn.trigger.role ? { role: turn.trigger.role } : {}) } } : {}),
    tools: (toolsOf.get(turn.id) ?? [])
      .filter(tool => tool.t0 < hi && (tool.t1 ?? now) > lo)
      .map(tool => ({ id: tool.id, name: cleanLabel(tool.name, 60) || 'tool', t0: tool.t0, t1: tool.t1 ?? null, ...(tool.ok === undefined ? {} : { ok: tool.ok }), ...(tool.interrupted ? { interrupted: true } : {}), ...(tool.lost ? { lost: true } : {}) })),
  })
  let shapedTurns = botTurns.map(shape)
  if (shapedTurns.length > LIMIT.turns) { shapedTurns = shapedTurns.slice(-LIMIT.turns); truncated = true }
  const shapedRounds = roundTurns.map(shape)
  for (const lane of lanes) {
    if (lane.kind === 'bot') lane.rows = Math.max(1, assignRows(shapedTurns.filter(turn => turn.lane === lane.id)))
    if (lane.kind === 'room') lane.rows = Math.max(1, assignRows(shapedRounds.filter(turn => turn.lane === lane.id)))
  }
  const rounds = shapedRounds.map(({ tools: _tools, place: _place, ...round }) => ({
    ...round,
    calls: shapedTurns.filter(turn => turn.room === round.lane && turn.place === 'group' && turn.t0 >= round.t0 && turn.t0 <= (round.t1 ?? now)).map(turn => ({ bot: turn.lane, turnId: turn.id, t0: turn.t0 })),
  }))

  // ---- exchanges: arrows with send -> reply latency
  const byId = new Map()
  for (const message of messages) if (!byId.has(message.id)) byId.set(message.id, message)
  const repliesTo = new Map()
  for (const message of messages) if (message.replyTo && !repliesTo.has(message.replyTo)) repliesTo.set(message.replyTo, message)
  const turnOfTrigger = new Map()
  for (const turn of turns.values()) if (turn.trigger?.x && !turnOfTrigger.has(turn.trigger.x)) turnOfTrigger.set(turn.trigger.x, turn)
  let exchanges = []
  for (const message of inWindow) {
    const from = laneOfParty(message.from)
    const toLane = laneOfParty(message.to)
    if (!from || !toLane || !laneIds.has(from) || !laneIds.has(toLane)) continue
    const arrow = { id: message.id, from, to: toLane, role: message.role, hop: message.hop, t: message.t, ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.room ? { room: message.room } : {}) }
    const friendAsk = message.role === 'request' && from.startsWith(FRIEND_PREFIX)
    if (message.role === 'remote') {
      // A friend's line to you: the answer to the last line you sent that friend before it.
      const asked = [...messages].reverse().find(item => item.role === 'user' && item.to?.id === from && item.t <= message.t)
      if (asked) arrow.latencyMs = Math.max(0, message.t - asked.t)
    } else if (message.role === 'user' && toLane.startsWith(FRIEND_PREFIX)) {
      // Waiting on a friend: from your line to the friend's next line back.
      const answer = messages.find(item => item.role === 'remote' && item.from?.id === toLane && item.t >= message.t)
      const newer = messages.find(item => item.role === 'user' && item.to?.id === toLane && item.t > message.t)
      if (answer && (!newer || answer.t <= newer.t)) Object.assign(arrow, { answerAt: answer.t, latencyMs: Math.max(0, answer.t - message.t) })
      else if (!newer) arrow.waiting = true
    } else if (message.role === 'reply' && message.replyTo) {
      const request = byId.get(message.replyTo)
      if (request) arrow.latencyMs = Math.max(0, message.t - request.t)
    } else if (friendAsk) {
      // A friend's request into a Bot of yours: the Bot's turn for it is the answer, as for a typed line.
      const turn = turnOfTrigger.get(message.id)
      if (turn) {
        arrow.turnId = turn.id
        if (turn.t1 === undefined && live) arrow.waiting = true
        else if (turn.t1 !== undefined) Object.assign(arrow, { answerAt: turn.t1, latencyMs: Math.max(0, turn.t1 - message.t) })
      } else arrow.waiting = true
    } else if (message.role === 'request' || message.role === 'stopped') {
      const reply = repliesTo.get(message.id)
      if (reply) Object.assign(arrow, { replyAt: reply.t, latencyMs: Math.max(0, reply.t - message.t) })
      else arrow.waiting = true
    } else if (message.role === 'user') {
      const turn = turnOfTrigger.get(message.id)
      if (turn) {
        arrow.turnId = turn.id
        if (turn.t1 === undefined && live) arrow.waiting = true
        else if (turn.t1 !== undefined) Object.assign(arrow, { answerAt: turn.t1, latencyMs: Math.max(0, turn.t1 - message.t) })
      }
    }
    exchanges.push(arrow)
  }
  if (exchanges.length > LIMIT.exchanges) { exchanges = exchanges.slice(-LIMIT.exchanges); truncated = true }

  // ---- utilization per Bot: model (turn time outside tools), tools, idle (no running turn)
  const windowMsActual = hi - lo
  const utilization = lanes.filter(lane => lane.kind === 'bot').map((lane) => {
    const own = turnList.filter(turn => turn.bot === lane.id && turn.place !== 'room')
    const busy = union(own.map(turn => [turn.t0, end(turn)]), lo, hi)
    const toolSpans = intersect(busy, union(own.flatMap(turn => (toolsOf.get(turn.id) ?? []).map(tool => [tool.t0, Math.min(tool.t1 ?? now, hi)])), lo, hi))
    const busyMs = total(busy)
    const toolMs = total(toolSpans)
    const durations = own.filter(turn => turn.t1 !== undefined).map(turn => turn.t1 - turn.t0)
    return {
      lane: lane.id, windowMs: windowMsActual, busyMs, modelMs: busyMs - toolMs, toolMs, idleMs: windowMsActual - busyMs,
      turns: own.filter(turn => turn.t0 >= lo).length,
      errors: own.filter(turn => turn.outcome === 'error').length,
      longestMs: durations.length ? Math.max(...durations) : 0,
      running: own.some(turn => turn.t1 === undefined && live),
    }
  })

  // ---- communication map: directed edges, "A waits on B" from request -> reply latencies
  const edgeMap = new Map()
  for (const arrow of exchanges) {
    const key = `${arrow.from}>${arrow.to}`
    const edge = edgeMap.get(key) ?? { from: arrow.from, to: arrow.to, requests: 0, replies: 0, other: 0, answered: 0, unanswered: 0, waits: [] }
    if (arrow.role === 'request' || arrow.role === 'user') {
      edge.requests += 1
      if (arrow.latencyMs !== undefined) { edge.answered += 1; edge.waits.push(arrow.latencyMs) } else edge.unanswered += 1
    } else if (arrow.role === 'reply' || arrow.role === 'remote') edge.replies += 1
    else edge.other += 1
    edgeMap.set(key, edge)
  }
  const edges = [...edgeMap.values()].map(({ waits, ...edge }) => ({ ...edge, ...(waits.length ? { medianMs: median(waits), maxMs: Math.max(...waits), totalWaitMs: waits.reduce((sum, value) => sum + value, 0) } : {}) }))

  return {
    version: 1,
    now, from: lo, to: hi, windowMs: windowMsActual, live,
    coverage: { oldest: oldest ?? null, newest: last || null, complete: oldest !== undefined && oldest <= lo },
    trace: stats ?? null,
    truncated,
    lanes, turns: shapedTurns, rounds, exchanges, utilization, edges,
  }
}

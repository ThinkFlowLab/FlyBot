// Folds the core's activity feed into trace records. One function per feed event; every
// field that goes into the trace is rebuilt here from a conservative alphabet, so a
// malformed or hostile event can only produce a smaller record, never a bigger one.
//
// Record kinds (short keys keep the file small; `t` is the event time in epoch ms):
//   boot  the recorder started: turns still open before it were cut off by a restart
//   ts    turn start   { id, bot?, room?, pl, x?, f?, ro? }  pl = chat | group | room;
//                       x = triggering exchange id, f = who sent it, ro = its role
//   te    turn end     { id, o, ec? }                          o = completed | aborted | error
//   ks    tool start   { id, tid, nm, bot?, room? }
//   ke    tool end     { id, tid, ok, ir? }                    ir = the turn ended first
//   m     delivered    { id, f, to, ro, hop, rt?, room?, n }   f/to = party; rt = replyTo
// No message text, tool arguments or tool output is ever read from an event.
import { cleanCode, cleanCount, cleanId, cleanLabel, cleanTime } from './sanitize.js'

const PLACES = new Set(['chat', 'group', 'room'])
const OUTCOMES = new Set(['completed', 'aborted', 'error'])
// The roles the panel draws. Anything else is not recorded.
export const ROLES = new Set(['user', 'request', 'reply', 'stopped', 'report', 'room', 'post', 'mention'])

const partyOf = (party) => {
  if (party?.kind === 'user') return { k: 'u' }
  if (party?.kind === 'bot' && cleanId(party.botId)) return { k: 'b', id: party.botId }
  if (party?.kind === 'room' && cleanId(party.roomId)) return { k: 'r', id: party.roomId }
  // A friend's Bot is outside the local team: phase 1 shows the local team only.
  return undefined
}
const withParty = (key, party) => (party ? { [key]: party } : {})

export function createRecorder({ adapter, trace, now = Date.now }) {
  // The id -> label tables kept with the trace, so a Bot that was removed still has a name.
  const labelsOf = () => {
    const bots = {}
    const rooms = {}
    for (const bot of adapter.bots()) { const id = cleanId(bot.id); if (id) bots[id] = cleanLabel(bot.name) || id }
    for (const room of adapter.rooms()) { const id = cleanId(room.id); if (id) rooms[id] = cleanLabel(room.name) || id }
    return { bots, rooms }
  }
  let lastLabels = ''
  const write = (record) => {
    if (adapter.readOnly()) return
    // Refresh the name table only when a name changed (cheap string compare per event).
    const labels = labelsOf()
    const key = JSON.stringify(labels)
    if (key !== lastLabels) { lastLabels = key; trace.append(record, labels) } else trace.append(record)
  }
  const place = (event) => {
    const pl = PLACES.has(event?.place) ? event.place : undefined
    const bot = cleanId(event?.botId)
    const room = cleanId(event?.roomId)
    if (pl === undefined || (pl !== 'room' && bot === undefined)) return undefined
    return { pl, ...(bot ? { bot } : {}), ...(room ? { room } : {}) }
  }
  const seen = new Set()
  const firstTime = (id, to) => {
    const key = `${id}>${to}`
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 1000) seen.delete(seen.values().next().value)
    return true
  }

  const handlers = {
    'turn.start'(event) {
      const where = place(event)
      const id = cleanId(event?.turnId)
      const t = cleanTime(event?.time)
      if (!where || !id || !t) return
      const trigger = event.trigger
      const from = partyOf(trigger?.from)
      write({ r: 'ts', t, id, ...where, ...(cleanId(trigger?.exchangeId) ? { x: trigger.exchangeId } : {}), ...withParty('f', from), ...(typeof trigger?.role === 'string' && ROLES.has(trigger.role) ? { ro: trigger.role } : {}) })
    },
    'turn.end'(event) {
      const id = cleanId(event?.turnId)
      const t = cleanTime(event?.time)
      if (!id || !t) return
      const o = OUTCOMES.has(event.outcome) ? event.outcome : 'completed'
      write({ r: 'te', t, id, o, ...(o === 'error' ? { ec: cleanCode(event.errorCode) } : {}) })
    },
    'tool.start'(event) {
      const where = place(event)
      const id = cleanId(event?.callId)
      const tid = cleanId(event?.turnId)
      const t = cleanTime(event?.time)
      if (!where || !id || !tid || !t) return
      write({ r: 'ks', t, id, tid, nm: cleanLabel(event.name, 60) || 'tool', ...(where.bot ? { bot: where.bot } : {}), ...(where.room ? { room: where.room } : {}) })
    },
    'tool.end'(event) {
      const id = cleanId(event?.callId)
      const tid = cleanId(event?.turnId)
      const t = cleanTime(event?.time)
      if (!id || !tid || !t) return
      write({ r: 'ke', t, id, tid, ok: event.ok === true, ...(event.interrupted === true ? { ir: true } : {}) })
    },
    'exchange.delivered'(event) {
      const id = cleanId(event?.exchangeId)
      const t = cleanTime(event?.time)
      const ro = typeof event?.role === 'string' && ROLES.has(event.role) ? event.role : undefined
      const f = partyOf(event?.from)
      const toBot = cleanId(event?.to?.botId)
      const toRoom = cleanId(event?.to?.roomId)
      const to = toBot ? { k: 'b', id: toBot } : toRoom ? { k: 'r', id: toRoom } : undefined
      if (!id || !t || !ro || !f || !to) return
      if (!firstTime(id, `${to.k}${to.id}`)) return
      const room = cleanId(event?.roomId)
      write({ r: 'm', t, id, f, to, ro, hop: cleanCount(event?.hop, 64), ...(cleanId(event?.replyTo) ? { rt: event.replyTo } : {}), ...(room ? { room } : {}), n: cleanCount(event?.textLength, 1e7) })
    },
  }

  return {
    handlers,
    start() {
      // The marker closes turns an earlier run left open (the host restarted under them).
      if (!adapter.readOnly()) write({ r: 'boot', t: cleanTime(now()) ?? 1 })
    },
  }
}

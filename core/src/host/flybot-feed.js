// The team activity feed of the `flybot` service: turns, tool calls and Bot-to-Bot
// deliveries, folded from DSH's `session/event` so plugins subscribe through
// `ctx.flybot.on(...)` and never touch raw session events. Pure observation: it never
// changes a session, never blocks, and a failing listener cannot reach the Session.
//
// What leaves this file is metadata only. Message text, tool arguments, tool output and
// model output never do, so a consumer that stores the feed cannot persist a secret a
// user pasted or a tool printed. Strings that came from outside the team (a tool name
// from an MCP server, a remote handle, an error code) are cleaned here.
import { SOURCE_KIND } from './constants.js'
import { normRemoteHandle, remoteBotTitle } from '../shared/remote-label.js'

export const FEED_EVENTS = Object.freeze(['turn.start', 'turn.end', 'tool.start', 'tool.end', 'exchange.delivered'])

// Relay roles a consumer can show. Retry, resume and secret-card nudges are the host
// talking to itself, not the team talking to each other.
const DELIVERED_ROLES = new Set(['request', 'reply', 'stopped', 'report', 'room', 'post', 'mention', 'remote'])
const OUTCOMES = new Set(['completed', 'aborted', 'error'])

const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// One line, no controls, no fence markers, capped: safe to store and to show.
export const cleanLabel = (value, max = 80) => {
  let out = String(value ?? '').replace(CONTROLS, ' ')
  for (let previous; previous !== out;) { previous = out; out = out.replace(/<\s*\/?\s*untrusted-?/gi, '') }
  return out.replace(/\s+/g, ' ').trim().slice(0, max)
}
// An error code is an enumerated value (RATE_LIMIT, AUTH): upper-case words only, so free text or a key put in the field is not kept.
const cleanCode = code => (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : 'UNKNOWN')
const cleanId = value => (typeof value === 'string' ? cleanLabel(value, 120) : undefined)
const timeOf = event => (Number.isFinite(event?.time) ? event.time : Date.now())
const seqOf = event => (Number.isInteger(event?.seq) ? event.seq : undefined)
const textLength = (content) => {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, block) => sum + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0), 0)
}
const omitUndefined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

// `fire(name, payload)` hands a payload to the service's listeners (hooks.js).
export function installFeed(rt, fire) {
  const { ctx } = rt
  const warn = (...args) => rt.warn?.(...args)
  /** @type {Map<string, {turn?: number, pending?: object, calls: Map<string, {name: string, time: number}>}>} */
  const sessions = new Map()
  const entryOf = (id) => {
    let entry = sessions.get(id)
    if (entry === undefined) sessions.set(id, entry = { calls: new Map() })
    return entry
  }
  // The model each Session's latest request header named (`provider/model`). DSH logs a header
  // only when it changes, so the last one seen is the one every later step runs on.
  /** @type {Map<string, string>} */
  const models = new Map()
  const refOf = config => (typeof config?.provider === 'string' && typeof config?.model === 'string' && config.provider && config.model
    ? cleanLabel(`${config.provider}/${config.model}`, 120) : undefined)
  // The model a turn ran on: only a turn that made a model call has one. A friend's Bot chat runs
  // no model of yours. Before this process saw a header, the Session's own latest header answers.
  const turnModel = (session, id, entry, where) => {
    if (!entry.stepped || where.place === 'remote') return undefined
    if (!models.has(id)) {
      let ref
      try { ref = refOf(session?.requestHeader?.()?.config) } catch { /* no header yet */ }
      if (ref !== undefined) models.set(id, ref)
    }
    return models.get(id)
  }

  // What the user calls a friend's Bot ("Chief (UiA1415)", "Helper (UiB1415)", #384), as the sidebar
  // does, from the published roster or the friend's chat. Untrusted (a peer chose it): cleaned, capped.
  const remoteTitle = (handle) => {
    try {
      const key = normRemoteHandle(handle)
      const member = rt.flybotRemoteMembers?.().find(item => normRemoteHandle(item?.handle) === key)
      const chat = member === undefined ? rt.remoteChats?.list().find(item => normRemoteHandle(item?.handle) === key) : undefined
      const record = member ?? (chat === undefined ? undefined : { ...chat, displayName: chat.name })
      return record === undefined ? undefined : cleanLabel(remoteBotTitle(record), 60) || undefined
    } catch {
      // A roster that cannot be read only costs the friend's name; the handle still identifies it.
      return undefined
    }
  }

  const remoteParty = (handle) => {
    const name = remoteTitle(handle)
    return { kind: 'remote', handle: cleanLabel(handle, 120), ...(name ? { name } : {}) }
  }

  // Where a Session speaks: a Bot's own chat, a Bot's hidden group Session, or the group
  // itself (its turn is the round). Archived segments are not listed.
  const placeOf = (id) => {
    const group = rt.groupOwners?.get(id)
    if (group !== undefined) return { place: 'group', botId: group.botId, roomId: group.roomId }
    const botId = rt.chatOwners?.get(id)
    if (botId !== undefined) {
      // A friend's Bot is a chat of its own (remote-chat.js): its Session runs no model, it
      // only carries lines to and from the friend. It is not a team Bot's chat.
      const handle = rt.botOf?.(botId)?.remote?.handle
      if (typeof handle === 'string') return { place: 'remote', botId, remote: { handle: cleanLabel(handle, 120), name: remoteTitle(handle) ?? cleanLabel(rt.botOf(botId).name, 60) } }
      return { place: 'chat', botId }
    }
    if (rt.roomOf?.(id) !== undefined) return { place: 'room', roomId: id }
    return undefined
  }

  const partyOf = (source, where) => {
    if (source?.kind === 'user') return { kind: 'user' }
    if (source?.remote?.handle) return remoteParty(source.remote.handle)
    if (typeof source?.senderSessionId === 'string' && rt.botOf?.(source.senderSessionId) !== undefined) return { kind: 'bot', botId: source.senderSessionId }
    if (source?.role === 'room' && where.roomId !== undefined) return { kind: 'room', roomId: where.roomId }
    return undefined
  }

  // The delivery a message made into a Session: who, to whom, when. `exchangeId` is the
  // one `state.exchanges` and the relay metadata carry; a typed user line has none, so it
  // gets a stable id of its own.
  const deliveredOf = (id, event, where) => {
    const source = event.data?.source
    let exchangeId
    let role
    let party
    if (source?.kind === 'user') {
      role = 'user'
      exchangeId = `user:${id}:${seqOf(event) ?? timeOf(event)}`
      party = { kind: 'user' }
    } else if (source?.kind === SOURCE_KIND && source.form === 'remote-chat' && where.place === 'remote') {
      // The friend's line, posted into its chat (remote-chat.js `deliver`).
      role = 'remote'
      exchangeId = cleanId(source.exchangeId)
      party = typeof source.remote?.handle === 'string' ? remoteParty(source.remote.handle) : undefined
    } else if (source?.kind === SOURCE_KIND && source.form === 'relay') {
      if (source.deferred || source.resumed || source.retried) return undefined
      role = String(source.role ?? '')
      if (!DELIVERED_ROLES.has(role)) return undefined
      exchangeId = cleanId(source.exchangeId)
      party = partyOf(source, where)
    } else {
      return undefined
    }
    if (exchangeId === undefined || party === undefined) return undefined
    const roomId = where.roomId ?? cleanId(source?.roomId)
    return {
      exchangeId,
      from: party,
      to: omitUndefined({ botId: where.botId, roomId: where.place === 'room' ? where.roomId : undefined }),
      sessionId: id,
      place: where.place,
      remote: where.remote,
      role,
      hop: Number.isInteger(source.hop) ? source.hop : 0,
      time: timeOf(event),
      seq: seqOf(event),
      replyTo: cleanId(source.replyTo),
      roomId,
      audience: source.audience === 'user' ? 'user' : undefined,
      textLength: textLength(event.data?.content),
    }
  }
  const triggerOf = (delivered) => (delivered === undefined ? undefined : omitUndefined({
    exchangeId: delivered.exchangeId, from: delivered.from, role: delivered.role, hop: delivered.hop, replyTo: delivered.replyTo,
  }))

  const closeCalls = (id, entry, where, turnId, time, interrupted) => {
    for (const [callId, call] of entry.calls) {
      fire('tool.end', omitUndefined({ botId: where.botId, roomId: where.roomId, place: where.place, remote: where.remote, sessionId: id, turnId, callId, name: call.name, time, durationMs: Math.max(0, time - call.time), ok: false, interrupted: interrupted ? true : undefined }))
    }
    entry.calls.clear()
  }

  const onEvent = (session, event) => {
    const id = session?.id
    if (typeof id !== 'string' || typeof event?.type !== 'string') return
    const where = placeOf(id)
    if (where === undefined) return
    const entry = entryOf(id)
    const turnId = entry.turn === undefined ? undefined : `${id}#${entry.turn}`
    const base = omitUndefined({ botId: where.botId, roomId: where.roomId, place: where.place, remote: where.remote, sessionId: id })
    switch (event.type) {
      case 'user/message': {
        const delivered = deliveredOf(id, event, where)
        if (delivered === undefined) return
        if (entry.turn === undefined && entry.pending === undefined) entry.pending = delivered
        fire('exchange.delivered', omitUndefined(delivered))
        return
      }
      case 'turn/start': {
        const turn = Number.isInteger(event.data?.turn) ? event.data.turn : (entry.turn ?? 0) + 1
        // A turn that never ended (a crash) is closed by the next one.
        if (entry.turn !== undefined) {
          closeCalls(id, entry, where, turnId, timeOf(event), true)
          fire('turn.end', omitUndefined({ ...base, turnId, turn: entry.turn, time: timeOf(event), outcome: 'aborted', interrupted: true, model: turnModel(session, id, entry, where) }))
        }
        entry.turn = turn
        entry.stepped = false
        const trigger = triggerOf(entry.pending)
        entry.pending = undefined
        fire('turn.start', omitUndefined({ ...base, turnId: `${id}#${turn}`, turn, time: timeOf(event), seq: seqOf(event), trigger }))
        return
      }
      case 'step/start':
        if (entry.turn !== undefined) entry.stepped = true
        return
      case 'request/header': {
        const ref = refOf(event.data?.header?.config)
        if (ref !== undefined) models.set(id, ref)
        return
      }
      case 'tool/call': {
        const callId = cleanId(event.data?.callId)
        if (callId === undefined || entry.turn === undefined) return
        const name = cleanLabel(event.data?.name) || 'tool'
        const time = timeOf(event)
        entry.calls.set(callId, { name, time })
        fire('tool.start', omitUndefined({ ...base, turnId, callId, name, time }))
        return
      }
      case 'tool/result': {
        const callId = cleanId(event.data?.callId ?? event.data?.message?.toolCallId)
        const call = callId === undefined ? undefined : entry.calls.get(callId)
        if (call === undefined) return
        entry.calls.delete(callId)
        const time = timeOf(event)
        fire('tool.end', omitUndefined({ ...base, turnId, callId, name: call.name, time, durationMs: Math.max(0, time - call.time), ok: event.data?.message?.isError !== true && event.data?.error === undefined }))
        return
      }
      case 'turn/end': {
        if (entry.turn === undefined) return
        const time = timeOf(event)
        closeCalls(id, entry, where, turnId, time, true)
        const kind = event.data?.reason?.kind
        const outcome = OUTCOMES.has(kind) ? kind : 'completed'
        const errorCode = outcome === 'error' ? cleanCode(event.data?.reason?.error?.code) : undefined
        fire('turn.end', omitUndefined({ ...base, turnId, turn: entry.turn, time, seq: seqOf(event), outcome, errorCode, model: turnModel(session, id, entry, where) }))
        entry.turn = undefined
        entry.stepped = false
        if (entry.pending === undefined) sessions.delete(id)
        return
      }
      default:
    }
  }

  ctx.on('session/event', (session, event) => {
    try { onEvent(session, event) } catch (error) { warn('flybot: activity feed failed: %s', error) }
  })
}

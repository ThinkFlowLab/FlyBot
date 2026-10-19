// DSH execution behind a room participant boundary. Room policy and prompts stay
// in groups.js; this driver keeps the existing room.sessions/groupOwners format.
import { randomUUID } from 'node:crypto'
import { ROOM_REPLY_TIMEOUT_MS, ROOM_WORK_GRACE_MS, TEAM_TOOLS } from './constants.js'
import { splitRef } from './text.js'

export function createDshRoomParticipant(rt) {
  async function open({ room, member }) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      // A failed model selection left this Bot stale (#289): try again before it speaks.
      if (member.modelStale) await rt.applyModel(member).catch(error => rt.warn('ds-bot: model for %s in %s not repaired: %s', member.name, room.name, error))
      await rt.ensureCapabilities(known)
      return { id: known, created: false }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }) })
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      await rt.selectSessionModel(id, splitRef(ref))
        .catch((error) => { member.modelStale = true; rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error) })
    }
    await rt.applyPermission(member, id)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    await rt.ensureCapabilities(id)
    return { id, created: true }
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
  // it waits for the user's approval, `{ working }` when it goes on working without the
  // round, or null when the round was stopped. The wait restarts on each event of the
  // member's Session, so a member at work is never cut off. `by` is the member that
  // called it, which answers what the turn posts after the round moved on.
  async function runTurn({ room, member, sessionId, text, note, signal, started, by, origin, exchangeId = randomUUID() }) {
    if (signal.aborted) return null
    const turn = { botId: member.id, sessionId, exchangeId }
    started.push(turn)
    // Checked before the delivery, which may start the turn at once.
    const busy = rt.live.get(sessionId)?.turn !== undefined
    const done = new Promise((resolve) => {
      let timer
      let grace
      const abort = () => finish(null)
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        rt.roomWaiters.delete(exchangeId)
        signal.removeEventListener('abort', abort)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS) }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text, ...(by ? { askedBy: by } : {}), ...(origin ? { origin } : {}) })
      // Still held by an earlier request: this turn cannot start until the user answers.
      if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      // Still at earlier work: the call waits in its inbox and is answered after that.
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      rt.roomWaiters.get(exchangeId)?.resolve(null)
    }
    const reply = await done
    // A turn that ended leaves nothing for a stop to cancel.
    if (typeof reply === 'string' || reply?.failure !== undefined) started.splice(started.indexOf(turn), 1)
    return reply
  }

  // A member that reaches its context limit mid-turn goes on in a fresh Session, so a
  // waiter is also found by the member and group that Session now speaks for.
  const waitersOf = (sessionId) => {
    const owner = rt.groupOwners.get(sessionId)
    return [...rt.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId
      || (owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  }
  rt.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // The team's own tools are quick; any other tool is the start of work.
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
  rt.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    for (const waiter of waitersOf(sessionId)) waiter.work()
  }

  function snapshot(sessionId) {
    const entry = rt.live.get(sessionId)
    return entry?.turn === undefined ? { working: false } : { working: true, since: entry.since }
  }

  async function cancel({ sessionId, exchangeId }) {
    if (exchangeId !== undefined) return rt.stopRoomTurn(sessionId, exchangeId)
    if (!snapshot(sessionId).working) return false
    const agent = await rt.resolveAgent(sessionId)
    agent.cancel({ kind: 'user' })
    return true
  }

  return { kind: 'dsh', open, runTurn, snapshot, cancel }
}

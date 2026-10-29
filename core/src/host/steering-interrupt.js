// Steering interrupt (#1509): a human message that arrives while a foreground tool/job
// wait has been open for more than 60s aborts that turn the way Stop does, keeping the
// inbox so the message is claimed at once instead of waiting for the blocking step.
export const INTERRUPT_AFTER_MS = 60_000

const longWait = ({ waitStartedAt, now, thresholdMs }) => typeof waitStartedAt === 'number'
  && typeof now === 'number'
  && now - waitStartedAt > thresholdMs

// Whether this human send should abort the running turn. `waitStartedAt` is the start of
// the oldest tool call still open in the Session — the observable foreground wait.
export function shouldInterruptOnHumanSend({
  sourceKind,
  turnRunning,
  ownChat,
  waitStartedAt,
  now,
  thresholdMs = INTERRUPT_AFTER_MS,
}) {
  return sourceKind === 'user'
    && turnRunning === true
    && ownChat === true
    && longWait({ waitStartedAt, now, thresholdMs })
}

// A group room's own Session is not the Bot's chat (#1650): the line lands there, but the
// wait belongs to the member turn that room's round is waiting on, so that turn is the one
// that lets go — through Stop's room path, never the own-chat cancel.
export function shouldYieldRoomTurn({
  sourceKind,
  roomTurnRunning,
  waitStartedAt,
  now,
  thresholdMs = INTERRUPT_AFTER_MS,
}) {
  return sourceKind === 'user'
    && roomTurnRunning === true
    && longWait({ waitStartedAt, now, thresholdMs })
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, Map<string, number>>} tool calls still open per Session, by call id */
  const open = new Map()

  const callsOf = id => {
    let calls = open.get(id)
    if (calls === undefined) open.set(id, calls = new Map())
    return calls
  }
  const startedAtOf = id => {
    const calls = open.get(id)
    return calls === undefined || calls.size === 0 ? undefined : Math.min(...calls.values())
  }
  const eventTime = event => (typeof event.time === 'number' ? event.time : Date.now())
  const now = () => (typeof rt.now === 'function' ? rt.now() : Date.now())
  const turnRunning = id => rt.live?.get(id)?.turn !== undefined

  const end = (id, key) => {
    if (key === '') return
    const calls = open.get(id)
    if (calls === undefined) return
    calls.delete(key)
    if (calls.size === 0) open.delete(id)
  }

  const interrupt = id => {
    // Drop the evidence first: one abort per wait, however many lines arrive together.
    open.delete(id)
    void Promise.resolve(rt.resolveAgent?.(id))
      .then(agent => agent?.cancel?.({ kind: 'hook', reason: 'ds-bot/interrupt-long-wait' }, { keepInbox: true }))
      .catch(() => {})
  }

  // The member turn the room's round is still waiting on: the waiter is the round itself,
  // and the room index plus the live exchange have to agree with it. A member that went on
  // working has no waiter, so its turn no longer holds the room.
  const awaitedRoomTurn = (roomId) => {
    for (const [exchangeId, waiter] of rt.roomWaiters?.entries() ?? []) {
      if (waiter?.roomId !== roomId) continue
      const owner = rt.groupOwners?.get(waiter.sessionId)
      const info = rt.live?.get(waiter.sessionId)?.info
      if (owner?.roomId !== roomId || info?.role !== 'room' || info.exchangeId !== exchangeId) continue
      return { sessionId: waiter.sessionId, exchangeId }
    }
    return undefined
  }

  const yieldRoomTurn = (turn) => {
    // Same as the own-chat path: the evidence goes first, so one let-go per wait.
    open.delete(turn.sessionId)
    void Promise.resolve(rt.stopRoomTurn?.(turn.sessionId, turn.exchangeId)).catch(() => {})
  }

  // A person's line reaches a busy Session the moment DSH splices it into the inbox; its
  // `user/message` only follows when the next step starts, after the blocking tool returned
  // (#1666). Both arrivals run this judgement, and the let-go clears the wait, so the later one
  // is never a second interruption.
  const humanLine = (id, source) => {
    if (rt.chatOwners?.has(id) === true) {
      const waitStartedAt = startedAtOf(id)
      if (!shouldInterruptOnHumanSend({
        sourceKind: source?.kind,
        turnRunning: turnRunning(id),
        ownChat: true,
        waitStartedAt,
        now: now(),
      })) return
      interrupt(id)
      return
    }
    const room = rt.roomOf?.(id)
    if (room === undefined) return
    const turn = awaitedRoomTurn(room.id)
    if (turn === undefined) return
    if (!shouldYieldRoomTurn({
      sourceKind: source?.kind,
      roomTurnRunning: turnRunning(turn.sessionId),
      waitStartedAt: startedAtOf(turn.sessionId),
      now: now(),
    })) return
    yieldRoomTurn(turn)
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || event?.type === undefined) return
    switch (event.type) {
      case 'tool/call':
        callsOf(id).set(String(event.data?.callId ?? ''), eventTime(event))
        return
      case 'tool/ptc-dispatch-start':
        callsOf(id).set(String(event.data?.subCallId ?? ''), eventTime(event))
        return
      case 'tool/result':
        // The host reports a result as `{ message: ToolResultMessage }`, so the call id is
        // on the message; only older payloads carry it at the top of `data` (#1644).
        end(id, String(event.data?.callId ?? event.data?.message?.toolCallId ?? ''))
        return
      case 'tool/ptc-dispatch':
        end(id, String(event.data?.subCallId ?? ''))
        return
      case 'turn/end':
        open.delete(id)
        return
      case 'agent/inbox/spliced': {
        // Only what the inbox took in is an arrival; a splice that canceled messages (outcome) is
        // a removal, and its inserted list can carry messages this branch already judged.
        if (event.data?.outcome !== undefined) return
        for (const message of event.data?.inserted ?? []) {
          if (message?.source?.kind === 'user') humanLine(id, message.source)
        }
        return
      }
      case 'user/message':
        humanLine(id, event.data?.source)
        return
      default:
    }
  })
}

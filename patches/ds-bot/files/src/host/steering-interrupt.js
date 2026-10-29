// Steering interrupt (#1509): a human message that arrives while a foreground tool/job
// wait has been open for more than 60s aborts that turn the way Stop does, keeping the
// inbox so the message is claimed at once instead of waiting for the blocking step.
export const INTERRUPT_AFTER_MS = 60_000

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
    && typeof waitStartedAt === 'number'
    && typeof now === 'number'
    && now - waitStartedAt > thresholdMs
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
        end(id, String(event.data?.callId ?? ''))
        return
      case 'tool/ptc-dispatch':
        end(id, String(event.data?.subCallId ?? ''))
        return
      case 'turn/end':
        open.delete(id)
        return
      case 'user/message': {
        const source = event.data?.source
        const waitStartedAt = startedAtOf(id)
        if (!shouldInterruptOnHumanSend({
          sourceKind: source?.kind,
          turnRunning: turnRunning(id),
          ownChat: rt.chatOwners?.has(id) === true,
          waitStartedAt,
          now: now(),
        })) return
        interrupt(id)
        return
      }
      default:
    }
  })
}

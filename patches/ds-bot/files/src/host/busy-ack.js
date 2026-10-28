// Busy-ack (#1584): a human message that lands while a Bot turn is already running
// gets a short spoken acknowledgment on the live payload immediately. Steer admits
// to next-step, but a blocking job wait may never yield a step (#1509), so without
// this the chat stays silent until the wait ends.
export const BUSY_ACK_EN = 'Got it — I’ll answer properly once I finish what’s in progress.'
export const BUSY_ACK_ZH = '收到，我先记着，手头忙完再详细回你。'
export const COALESCE_MS = 3_000

export const busyAckText = (language) => (/chinese|简体|\bzh\b/i.test(String(language ?? '')) ? BUSY_ACK_ZH : BUSY_ACK_EN)

export function shouldNoteBusyAck({ sourceKind, turnRunning, ownChat }) {
  return sourceKind === 'user' && turnRunning === true && ownChat === true
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { text: string, at: number }>} */
  const acks = new Map()

  const turnRunning = sessionId => rt.live?.get(sessionId)?.turn !== undefined
  const ownChat = sessionId => rt.chatOwners?.has(sessionId) === true

  const note = (sessionId) => {
    const now = Date.now()
    const existing = acks.get(sessionId)
    if (existing && now - existing.at < COALESCE_MS) {
      existing.at = now
      return existing
    }
    const entry = { text: busyAckText(rt.uiLanguage?.()), at: now }
    acks.set(sessionId, entry)
    return entry
  }

  const clear = (sessionId) => { acks.delete(sessionId) }

  const textOfAssistant = (content) => {
    if (!Array.isArray(content)) return ''
    return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || event?.type === undefined) return
    if (event.type === 'user/message') {
      if (!shouldNoteBusyAck({
        sourceKind: event.data?.source?.kind,
        turnRunning: turnRunning(id),
        ownChat: ownChat(id),
      })) return
      note(id)
      return
    }
    if (event.type === 'assistant/message') {
      if (textOfAssistant(event.data?.message?.content).trim() !== '') clear(id)
      return
    }
    if (event.type === 'turn/end') clear(id)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const id = agent?.session?.id ?? agent?.id
    if (typeof id === 'string') clear(id)
  })

  Object.assign(rt, {
    busyAcksView: () => Object.fromEntries([...acks].map(([id, ack]) => [id, { text: ack.text, at: ack.at }])),
    noteBusyAck: note,
    clearBusyAck: clear,
  })
}

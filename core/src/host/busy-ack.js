// Busy-ack (#1584): a human message that lands while a Bot turn is already running
// gets a short spoken acknowledgment on the live payload. Steer admits to next-step,
// but a blocking job wait may never yield a step (#1509), so without this the chat
// stays silent until the wait ends.
//
// The line is written by one short model call (#1665), not a template: the templated
// lines of #1629 quoted a clipped, truncated piece of the message back inside a fixed
// phrase and read as canned. The ack is published at once with an empty text, which the
// client draws as the avatar with blinking dots (#1656/#1657); the model's sentence fills
// it in when it comes. The call is separate from the busy turn, uses the reasoning-off
// setting when the model has one, a tiny output cap, and a hard ACK_TIMEOUT_MS; on a
// timeout, an error or an empty answer no text is ever sent and the dots clear with the
// turn as before. `config.flybot.modelFor['busy-ack']` names a cheaper model for it;
// otherwise the chat's own model is used.
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { splitRef } from './text.js'

export const COALESCE_MS = 3_000
export const ACK_TIMEOUT_MS = 3_000
export const ACK_MAX_TOKENS = 80
export const ACK_MAX_CHARS = 120

export const ACK_SYSTEM = [
  'You write the one-line acknowledgment a busy assistant sends when a new message arrives while it is still working.',
  'Reply in the same language as the new message.',
  'Write one natural, short sentence that shows you understood what the new message is about and says briefly what you are doing right now.',
  'Do not quote or copy the message, do not use quotation marks, and do not use stock phrases such as "got it" or "noted"; vary your wording.',
  'Output only that sentence.',
].join(' ')

/** The user prompt for the ack call: the new message and what the turn is doing. */
export function ackPrompt({ message, tool, working }) {
  const doing = typeof tool === 'string' && tool.trim() !== '' && tool !== 'ask_user' ? `running the tool \`${tool}\`` : 'working on the previous request'
  const task = String(working ?? '').trim().slice(0, 600)
  return [
    `Currently: ${doing}.`,
    ...(task === '' ? [] : [`The request being worked on: ${task}`]),
    `New message: ${String(message ?? '').trim().slice(0, 1_500)}`,
  ].join('\n')
}

/** The model's answer as one clean line, or '' when unusable. */
export function cleanAck(text) {
  const line = String(text ?? '').split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? ''
  const clean = line.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/gu, '').trim()
  if (clean === '' || [...clean].length > ACK_MAX_CHARS) return ''
  return clean
}

export function shouldNoteBusyAck({ sourceKind, turnRunning, ownChat }) {
  return sourceKind === 'user' && turnRunning === true && ownChat === true
}

// A person's line reaching a member's group Session (#1646). A round relays it as
// `role: 'room'` with no Bot sender: a Bot's own call carries `senderSessionId`, an
// @-mention by another Bot carries `askedBy`, and a friend's Bot carries `remote`.
export function isHumanRoomLine(source) {
  return source?.role === 'room'
    && source.senderSessionId === undefined
    && source.askedBy === undefined
    && source.remote === undefined
}

// The relay prefix delivery.js puts on the line; the ack reads the person's text, not it.
const relayHeader = /^\[[^\]\n]*\]\r?\n/

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

export function install(rt) {
  const { ctx, config } = rt
  /** @type {Map<string, { text: string, at: number, id: number }>} */
  const acks = new Map()
  let counter = 0

  const turnRunning = sessionId => rt.live?.get(sessionId)?.turn !== undefined
  const ownChat = sessionId => rt.chatOwners?.has(sessionId) === true
  const groupSession = sessionId => rt.groupOwners?.has(sessionId) === true
  /** A person's line into this member's running group Session (#1646), once only. */
  const roomLine = (sessionId, source) => groupSession(sessionId) && isHumanRoomLine(source)

  // The route for the ack: a configured economy model first, else the chat's own.
  const routeOf = (session) => {
    const named = config?.flybot?.modelFor?.['busy-ack']
    const own = typeof named === 'string' && named.trim() !== '' ? splitRef(named.trim()) : undefined
    if (own?.provider && own?.model) return own
    const header = session?.requestHeader?.()?.config
    return header?.provider && header?.model ? { provider: header.provider, model: header.model } : undefined
  }

  // The latest earlier user request in the Session: what the busy turn is about.
  const workingOf = (session, message) => {
    try {
      const messages = session?.deriveMessages?.() ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== 'user') continue
        const text = textOf(messages[index].content).replace(relayHeader, '').trim()
        if (text !== '' && text !== String(message ?? '').trim()) return text
      }
    } catch { /* no history is fine */ }
    return ''
  }

  // One short call; resolves to the line or '' — never throws, never outlives the timeout.
  async function write(session, sessionId, message) {
    const route = routeOf(session)
    if (route === undefined || typeof ctx.llm?.stream !== 'function') return ''
    const signal = AbortSignal.timeout(ACK_TIMEOUT_MS)
    const work = (async () => {
      const info = await ctx.llm.resolveModelInfo?.(route.provider, route.model)?.catch?.(() => undefined)
      const off = info?.reasoning?.efforts?.some(effort => effort.id === 'off')
      const messages = [{ role: 'user', content: [{ type: 'text', text: ackPrompt({ message, tool: rt.live?.get(sessionId)?.tool, working: workingOf(session, message) }) }] }]
      rt.tagUsage?.(messages, { sessionId, kind: 'other' })
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(off ? { reasoningEffort: 'off' } : {}),
        system: ACK_SYSTEM,
        messages,
        maxTokens: ACK_MAX_TOKENS,
        purpose: 'other',
        signal,
      })) assembler.push(chunk)
      const finish = assembler.finish
      if (finish?.kind === 'error' || finish?.kind === 'aborted' || finish?.kind === 'max-tokens') return ''
      return cleanAck(assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n'))
    })().catch(() => '')
    let timer
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(''), ACK_TIMEOUT_MS) })
    try { return await Promise.race([work, late]) } finally { clearTimeout(timer) }
  }

  const note = (sessionId, message, session) => {
    const now = Date.now()
    const existing = acks.get(sessionId)
    if (existing && now - existing.at < COALESCE_MS) {
      existing.at = now
      return existing
    }
    counter += 1
    // Published at once with no text: the client draws the pending dots (#1657).
    const entry = { text: '', at: now, id: counter }
    acks.set(sessionId, entry)
    entry.ready = write(session, sessionId, message).then((text) => {
      if (text !== '' && acks.get(sessionId) === entry) entry.text = text
      return entry.text
    })
    return entry
  }

  const clear = (sessionId) => { acks.delete(sessionId) }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || event?.type === undefined) return
    if (event.type === 'user/message') {
      const source = event.data?.source
      const room = roomLine(id, source)
      const own = shouldNoteBusyAck({ sourceKind: source?.kind, turnRunning: turnRunning(id), ownChat: ownChat(id) })
      if (!own && !(room && turnRunning(id))) return
      const text = textOf(event.data?.content ?? event.data?.message?.content)
      note(id, room ? text.replace(relayHeader, '') : text, session)
      return
    }
    if (event.type === 'assistant/message') {
      if (textOf(event.data?.message?.content).trim() !== '') clear(id)
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
    // A room draws the ack on its running member's row (#1646), so its flow is keyed by
    // member, not by the Session a person cannot see. A member whose turn runs before its
    // line is composed is published with an empty text: the client draws the same blinking
    // indicator an own-chat pending ack draws (#1656), never a fixed sentence.
    roomBusyAcksView: sessions => Object.fromEntries(Object.entries(sessions ?? {}).flatMap(([botId, sessionId]) => {
      if (!turnRunning(sessionId)) return []
      const ack = acks.get(sessionId)
      return [[botId, ack === undefined ? { text: '', at: 0 } : { text: ack.text, at: ack.at }]]
    })),
    noteBusyAck: note,
    // The pending model answer for a Session's ack ('' when none); for tests and diagnostics.
    busyAckReady: sessionId => acks.get(sessionId)?.ready ?? Promise.resolve(''),
    clearBusyAck: clear,
  })
}

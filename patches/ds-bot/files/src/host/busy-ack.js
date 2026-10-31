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
import { cut } from '../shared/text-boundary.js'

export const COALESCE_MS = 3_000
export const ACK_TIMEOUT_MS = 3_000
export const ACK_MAX_TOKENS = 80
export const ACK_MAX_CHARS = 120
// How many line ids one Session remembers exactly. The person's line is acked at arrival and its
// `user/message` arrives at the claim, which production logs put up to 768 s later and after the
// `turn/end` that clears the ack entry (#1678, #1684); the ids, not a time window, are what says
// "this line already has its ack". The ids live beside the entry, not inside it, so the entry's
// lifetime cannot take the memory with it.
export const LINE_IDS_KEPT = 16
// The rest of the ids are remembered in a fixed-size filter per Session: an id pruned from the
// exact set still answers "already acked", so a late claim can never resurrect an old line. The
// filter is `LEDGER_FILTER_WORDS` 32-bit words — 256 words × 4 bytes = 1 KiB, 8192 bits — with
// three salted positions per id, and it never grows; a false positive costs one skipped ack,
// never a second sentence.
const LEDGER_FILTER_WORDS = 256
const LEDGER_FILTER_HASHES = 3
// A filter that is only ever added to saturates: at the three salted positions of this size it
// already answers "acked" for 3.6% of brand-new lines after 1000 lines, 15.9% after 2000, 44.2%
// after 4000 and 97.9% after 12000, and every one of those is an ack that falls silent — the gap
// this ledger exists to close. So after `LEDGER_FILTER_REBUILD_AFTER` ids folded in since the
// last rebuild, the filter is rebuilt from the exact set alone. Worst fill is then
// (512 + LINE_IDS_KEPT) × 3 = 1584 of 8192 bits (19.3%), under 1% false positives; the rebuild
// forgets only ids older than the last `LINE_IDS_KEPT`, which have already been claimed.
export const LEDGER_FILTER_REBUILD_AFTER = 512
// Sessions whose line memory is kept. A Session that is archived or stops talking would
// otherwise hold its ids and its filter for the life of the process; the ones that stop writing
// are dropped first, and only past this many does a Session lose its memory.
export const LEDGER_SESSIONS_KEPT = 256

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
  const task = cut(String(working ?? '').trim(), 600).text
  return [
    `Currently: ${doing}.`,
    ...(task === '' ? [] : [`The request being worked on: ${task}`]),
    `New message: ${cut(String(message ?? '').trim(), 1_500).text}`,
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

// A deterministic position in the fixed-size filter for a line id. Three hashes of one FNV-1a
// pass with different salts: an id pruned from the exact set still answers "already acked".
const hashLine = (text, seed) => {
  let hash = 0x811c9dc5 ^ seed
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const lineBits = (lineId) => {
  const key = String(lineId)
  const size = LEDGER_FILTER_WORDS * 32
  return Array.from({ length: LEDGER_FILTER_HASHES }, (_, index) => hashLine(key, index * 0x9e3779b1) % size)
}

const bitCount = (word) => {
  let left = word
  let count = 0
  while (left !== 0) { left &= left - 1; count += 1 }
  return count
}

export function install(rt) {
  const { ctx, config } = rt
  /** @type {Map<string, { text: string, at: number, id: number }>} */
  const acks = new Map()
  // The line ids a Session has already acknowledged. Kept beside the ack entry, not inside it:
  // the entry dies at `turn/end`, and the claim of a `next-turn` line always lands after that
  // (#1684), so the memory has to outlive it.
  /** @type {Map<string, { exact: Set<string>, bits: Uint32Array, folded: number, rebuilds: number }>} */
  const ledgers = new Map()
  // Sessions whose newest turn has not claimed its first user line yet. DSH appends `turn/start`
  // before the step's `user/message` (agent-loop `index.js:943` and `:1061`), so the line that
  // opens a turn is claimed while `turnRunning` is already true and looks exactly like a line that
  // landed on a busy Bot. The first claim after `turn/start` is that opening line, never a busy
  // arrival, so it creates no ack (#1698).
  const openingLine = new Set()
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

  const foldIntoFilter = (ledger, key) => {
    for (const bit of lineBits(key)) ledger.bits[bit >>> 5] |= 1 << (bit & 31)
  }

  // A fresh filter holding every id the exact set still remembers. Never a bare reset: an id the
  // exact set already pruned is only in the old filter, and a reset without re-adding the survivors
  // would put that line back on the table — the duplicate ack this ledger exists to stop.
  const rebuildFilter = (ledger) => {
    ledger.bits = new Uint32Array(LEDGER_FILTER_WORDS)
    for (const key of ledger.exact) foldIntoFilter(ledger, key)
    ledger.folded = 0
    ledger.rebuilds += 1
  }

  // The Session's ledger, created on first use and dropped only when more than
  // `LEDGER_SESSIONS_KEPT` Sessions have written more recently.
  const ledgerOf = (sessionId) => {
    let ledger = ledgers.get(sessionId)
    if (ledger === undefined) {
      while (ledgers.size >= LEDGER_SESSIONS_KEPT) ledgers.delete(ledgers.keys().next().value)
      ledger = { exact: new Set(), bits: new Uint32Array(LEDGER_FILTER_WORDS), folded: 0, rebuilds: 0 }
    } else {
      // Recency: a Session writing now must not be the first one an idle Session takes the room
      // from. Re-inserting moves it to the back of the map's insertion order.
      ledgers.delete(sessionId)
    }
    ledgers.set(sessionId, ledger)
    return ledger
  }

  const rememberLine = (sessionId, lineId) => {
    if (lineId === undefined) return
    const ledger = ledgerOf(sessionId)
    const key = String(lineId)
    if (ledger.exact.has(key)) return
    ledger.exact.add(key)
    // Bounded: the exact set holds the lines still waiting for their claim, and an id it drops
    // is folded into the filter, which is why the drop cannot make that line speak again.
    while (ledger.exact.size > LINE_IDS_KEPT) {
      const oldest = ledger.exact.values().next().value
      ledger.exact.delete(oldest)
      foldIntoFilter(ledger, oldest)
      ledger.folded += 1
    }
    if (ledger.folded > LEDGER_FILTER_REBUILD_AFTER) rebuildFilter(ledger)
  }

  const lineAcked = (sessionId, lineId) => {
    if (lineId === undefined) return false
    const ledger = ledgers.get(sessionId)
    if (ledger === undefined) return false
    const key = String(lineId)
    if (ledger.exact.has(key)) return true
    return lineBits(key).every((bit) => (ledger.bits[bit >>> 5] & (1 << (bit & 31))) !== 0)
  }

  const note = (sessionId, message, session, lineId) => {
    const now = Date.now()
    // The same line arrives twice: as a splice when it is queued and as `user/message` when it
    // is claimed. The claim lands after the `turn/end` that cleared the ack entry, and can be
    // minutes later than the arrival, past any coalescing window — the Session's line ledger,
    // not the entry and not the clock, is what says the line already has an ack (#1678, #1684).
    if (lineAcked(sessionId, lineId)) return acks.get(sessionId)
    const existing = acks.get(sessionId)
    if (existing !== undefined && now - existing.at < COALESCE_MS) {
      rememberLine(sessionId, lineId)
      existing.at = now
      return existing
    }
    counter += 1
    // Published at once with no text: the client draws the pending dots (#1657).
    const entry = { text: '', at: now, id: counter }
    rememberLine(sessionId, lineId)
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
    if (event.type === 'turn/start') {
      openingLine.add(id)
      return
    }
    // DSH queues a person's line as `agent/inbox/spliced` the moment it arrives; its
    // `user/message` follows at the next step start, when the line is claimed. The splice is
    // the arrival, so the ack starts here and the claim below finds it already made (#1678).
    // Only a `next-turn` line waits: a `next-step` splice is steered into the running turn and
    // is admitted at its next step, which is the path that never showed a silence before.
    if (event.type === 'agent/inbox/spliced') {
      const target = event.data?.target
      if ((target !== 'next-turn' && target !== 'next-step') || !Array.isArray(event.data?.inserted)) return
      for (const landed of event.data.inserted) {
        const source = landed?.source
        const room = roomLine(id, source)
        const running = turnRunning(id)
        // An own-chat line waits in `next-turn` for the turn to end, which is the silence this
        // covers; a steer is admitted at the running turn's next step, so own chat needs nothing.
        // A person's room mid-line is relayed as a steer too, but the silence there is the
        // member's speaking row (#1646), so that row is acked at arrival whatever inbox the
        // relay used (#1684).
        const own = target === 'next-turn'
          && shouldNoteBusyAck({ sourceKind: source?.kind, turnRunning: running, ownChat: ownChat(id) })
        if (!own && !(room && running)) continue
        const text = textOf(landed?.content)
        note(id, room ? text.replace(relayHeader, '') : text, session, landed?.id)
      }
      return
    }
    if (event.type === 'user/message') {
      // The claim of the line that opened this turn: it is not a line that landed on a busy Bot,
      // even though `turnRunning` is already true here (#1698).
      if (openingLine.delete(id)) return
      const source = event.data?.source
      const room = roomLine(id, source)
      const own = shouldNoteBusyAck({ sourceKind: source?.kind, turnRunning: turnRunning(id), ownChat: ownChat(id) })
      if (!own && !(room && turnRunning(id))) return
      const text = textOf(event.data?.content ?? event.data?.message?.content)
      // The claim of a line the splice already acked: same id, so `note` keeps that one ack.
      const lineId = event.data?.id ?? event.data?.message?.id
      note(id, room ? text.replace(relayHeader, '') : text, session, lineId)
      return
    }
    if (event.type === 'assistant/message') {
      if (textOf(event.data?.message?.content).trim() !== '') clear(id)
      return
    }
    if (event.type === 'turn/end') {
      openingLine.delete(id)
      clear(id)
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const id = agent?.session?.id ?? agent?.id
    if (typeof id !== 'string') return
    openingLine.delete(id)
    clear(id)
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
    // How many line ids the Session's exact ledger holds; the filter beyond it is fixed-size.
    busyAckLedgerSize: sessionId => ledgers.get(sessionId)?.exact.size ?? 0,
    // How many Sessions have a ledger; bounded by LEDGER_SESSIONS_KEPT.
    busyAckLedgerSessions: () => ledgers.size,
    // How many bits of the Session's filter are set: the filter's fill, for the rebuild bound.
    busyAckLedgerFill: sessionId => (ledgers.get(sessionId)?.bits ?? []).reduce((sum, word) => sum + bitCount(word), 0),
    // How many times the Session's filter was rebuilt from the exact set.
    busyAckLedgerRebuilds: sessionId => ledgers.get(sessionId)?.rebuilds ?? 0,
    // The pending model answer for a Session's ack ('' when none); for tests and diagnostics.
    busyAckReady: sessionId => acks.get(sessionId)?.ready ?? Promise.resolve(''),
    clearBusyAck: clear,
  })
}

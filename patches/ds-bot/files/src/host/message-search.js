// Read-only, instance-local chat history search. Do not reuse chat-index: its catch-up
// resolves Agents and writes SQLite. Only cold-safe query observations are allowed here.
// No session enumeration API, filesystem path, caller-supplied session or plugin-file scan.
import { createHash, randomUUID } from 'node:crypto'

export const SEARCH_LIMITS = { query: 256, results: 50, sessions: 500, pagesPerRequest: 8, pages: 200, events: 1000, cursors: 64, concurrent: 4, ttl: 60_000, sourceEvents: 100_000, resultBytes: 65_536, contextBytes: 24_576, messageBytes: 262_144, scanBytes: 2_097_152, tickets: 512 }
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const unavailable = () => Object.assign(new Error('Chat history search is unavailable'), { code: 'bot/search-unavailable' })
const normalized = text => text.normalize('NFKC').toLowerCase()
const textOf = content => {
  if (!Array.isArray(content)) return ''
  if (content.length > 10_000) return null
  const blocks = []
  let bytes = 0
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.length > SEARCH_LIMITS.messageBytes) return null
    bytes += Buffer.byteLength(block.text) + 1
    if (bytes > SEARCH_LIMITS.messageBytes) return null
    blocks.push(block.text)
  }
  return blocks.join('\n')
}
const digest = text => createHash('sha256').update(text).digest('hex')
const historyUnavailable = () => Object.assign(new Error('History result is no longer available. Search again.'), { code: 'bot/history-unavailable' })
export function utf8Prefix(text, bytes) {
  let low = 0, high = Math.min(text.length, bytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle)) <= bytes) low = middle
    else high = middle - 1
  }
  if (low > 0 && text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff) low -= 1
  return text.slice(0, low)
}
const alignedStart = (text, at) => at > 0 && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff ? at - 1 : at
const jsonTextPrefix = (text, bytes) => {
  const raw = utf8Prefix(text, bytes)
  let low = 0, high = raw.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(raw.slice(0, middle))) <= bytes) low = middle
    else high = middle - 1
  }
  return utf8Prefix(raw.slice(0, low), bytes)
}
const messageText = event => event?.type === 'assistant/message' ? textOf(event.data?.message?.content)
  : event?.type === 'user/message' && event.data?.source?.kind === 'user' ? textOf(event.data?.content) : ''
const turnMap = raw => {
  const turns = new Map()
  let turn
  for (const event of raw) {
    if (event.type === 'turn/start') turn = event.seq
    turns.set(event.seq, Number.isInteger(event.data?.turn) ? event.data.turn : turn)
  }
  return turns
}

export function install(rt) {
  const cursors = new Map()
  const running = new Set()
  const tickets = new Map()
  const enforced = () => rt.authzEnforced?.() === true
  const principal = actor => enforced() ? actor?.memberId : 'legacy-single-human'
  const parts = id => rt.partsOf(id).map(part => part.sessionId).filter(id => typeof id === 'string' && id !== '' && id.length <= 256)
  const allowed = (actor, target) => {
    if (enforced() && !actor) return false
    const bot = rt.state.bots?.[target.botId]
    return Boolean(typeof target.botId === 'string' && target.botId.length <= 256 && bot && !bot.remote && (!enforced() || bot.ownerId === actor.memberId)
      && parts(target.botId).includes(target.sessionId)
      && (!enforced() || rt.sessionOwnedBy?.(actor, target.sessionId) === true))
  }
  const keep = job => {
    const now = Date.now()
    for (const [token, saved] of cursors) if (saved.expires <= now) cursors.delete(token)
    while (cursors.size >= SEARCH_LIMITS.cursors) cursors.delete(cursors.keys().next().value)
    const token = randomUUID()
    cursors.set(token, { ...job, expires: now + SEARCH_LIMITS.ttl })
    return token
  }
  const visibleTurn = (sessionId, turn) => {
    const hidden = rt.state.exchangeTurns?.[sessionId] ?? []
    return !hidden.includes(turn) && !(turn === undefined && hidden.length > 0)
  }
  const ticketFor = data => {
    for (const [token, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(token)
    while (tickets.size >= SEARCH_LIMITS.tickets) tickets.delete(tickets.keys().next().value)
    const token = randomUUID()
    tickets.set(token, { ...data, expires: Date.now() + SEARCH_LIMITS.ttl })
    return token
  }
  const appendPredicate = async () => {
    try {
      const { isAppendSurfaceEvent } = await import('@deepseek-ai/dsh-session')
      if (typeof isAppendSurfaceEvent !== 'function') throw unavailable()
      return isAppendSurfaceEvent
    } catch { throw unavailable() }
  }
  const search = async (body, actor, parentSignal) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['query', 'cursor', 'limit'].includes(key))
      || typeof body.query !== 'string' || body.query.length > 1024 || [...body.query].length > SEARCH_LIMITS.query || [...body.query].some(char => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))) throw invalid('Search query must be text of at most 256 characters')
    if (enforced() && !actor) throw Object.assign(new Error('Sign in first'), { code: 'bot/unauthorized' })
    const query = normalized(body.query.trim())
    const limit = body.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.results) throw invalid('Search limit must be between 1 and 50')
    const empty = { items: [], cursor: null, scope: 'local-bot-chats', incomplete: false, limited: false }
    if (!query) return empty
    const provider = rt.ctx.get?.('sessionQuery')
    if (typeof provider?.observeSession !== 'function') throw unavailable()
    // Native full-text search may index all visible Sessions and only searches
    // the current model surface. Human history is append-origin, including turns
    // compacted out of model context, never replacement summaries or tool records.
    const isAppend = await appendPredicate()
    let job
    if (body.cursor !== undefined && body.cursor !== null) {
      const saved = typeof body.cursor === 'string' && body.cursor.length <= 64 ? cursors.get(body.cursor) : undefined
      if (!saved || saved.expires <= Date.now() || saved.principal !== principal(actor) || saved.query !== query) throw invalid('Search page expired; search again')
      job = { ...saved }
    } else {
      const targets = []
      let limited = false
      const seen = new Set()
      outer: for (const bot of Object.values(rt.state.bots ?? {})) {
        if (bot.remote || (enforced() && bot.ownerId !== actor.memberId)) continue
        for (const sessionId of parts(bot.id).reverse()) {
          const target = { botId: bot.id, sessionId }
          if (!allowed(actor, target) || seen.has(sessionId)) continue
          if (targets.length === SEARCH_LIMITS.sessions) { limited = true; break outer }
          seen.add(sessionId)
          targets.push(target)
        }
      }
      job = { targets, at: 0, through: undefined, before: undefined, pages: 0, incomplete: false, limited, principal: principal(actor), query }
    }
    const items = []
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000)
    const advance = () => { job.at += 1; job.through = undefined; job.before = undefined }
    let requests = 0, scannedBytes = 0, resourceStop = false
    while (job.at < job.targets.length && items.length < limit && requests < SEARCH_LIMITS.pagesPerRequest && job.pages < SEARCH_LIMITS.pages && !resourceStop) {
      signal.throwIfAborted()
      const target = job.targets[job.at]
      if (!allowed(actor, target)) { advance(); continue }
      let observation
      try {
        requests += 1
        job.pages += 1
        observation = await provider.observeSession(target.sessionId, { signal, projectionMode: 'none' })
        signal.throwIfAborted()
        if (!allowed(actor, target)) { advance(); continue }
        if (observation.header?.id !== target.sessionId || !Array.isArray(observation.events) || !Number.isSafeInteger(observation.cursor) || observation.cursor < -1) throw unavailable()
        // Do not create an index or compute projections. Append-origin is the
        // durable human transcript, not the replaceable model context.
        const raw = observation.events
        if (raw.length > SEARCH_LIMITS.sourceEvents) { job.limited = true; advance(); continue }
        if (job.through !== undefined && job.through !== observation.cursor) {
          throw invalid('Search history changed; search again')
        }
        job.through = observation.cursor
        const turns = turnMap(raw)
        const bySeq = new Map(raw.map(event => [event.seq, event]))
        const docs = raw.filter(doc => isAppend(doc)
          && ['user/message', 'assistant/message'].includes(doc.type)
          && (job.before === undefined || doc.seq < job.before)).slice(-SEARCH_LIMITS.events)
        for (let index = docs.length - 1; index >= 0; index -= 1) {
          const doc = docs[index]
          const previousBefore = job.before
          job.before = doc.seq
          const event = bySeq.get(doc.seq)
          const turn = turns.get(doc.seq)
          if (!visibleTurn(target.sessionId, turn)) continue
          const text = messageText(event)
          if (text === null) { job.limited = true; continue }
          scannedBytes += Buffer.byteLength(text)
          if (scannedBytes > SEARCH_LIMITS.scanBytes) { job.before = previousBefore; resourceStop = true; break }
          const clean = text.normalize('NFKC')
          const hit = normalized(clean).indexOf(query)
          if (hit < 0) continue
          const start = alignedStart(clean, Math.max(0, hit - 50))
          const item = { botId: target.botId, sessionId: target.sessionId, seq: event.seq, ...(turn === undefined ? {} : { turn }),
            snippet: utf8Prefix((start ? '…' : '') + clean.slice(start, hit + query.length + 100), 1024), earlier: target.sessionId !== rt.chatOf(target.botId), hitToken: randomUUID() }
          if (Buffer.byteLength(JSON.stringify([...items, item])) > SEARCH_LIMITS.resultBytes - 1024) { job.before = previousBefore; resourceStop = true; break }
          item.hitToken = ticketFor({ ...target, seq: event.seq, turn, through: observation.cursor, hash: digest(text), query, principal: principal(actor) })
          items.push(item)
          if (items.length >= limit) break
        }
        if (!resourceStop && (docs.length === 0 || (docs.length < SEARCH_LIMITS.events && job.before === docs[0].seq))) advance()
      } catch (error) {
        if (error.code === 'bot/invalid') throw error
        if (signal.aborted) throw unavailable()
        job.incomplete = true
        advance()
      } finally {
        try { observation?.[Symbol.dispose]?.() } catch { job.incomplete = true }
      }
    }
    // Recheck at delivery too, including when another request revoked access during await.
    const visible = items.filter(item => {
      const hidden = rt.state.exchangeTurns?.[item.sessionId] ?? []
      return allowed(actor, item) && !(hidden.includes(item.turn) || (item.turn === undefined && hidden.length > 0))
    })
    if (job.pages >= SEARCH_LIMITS.pages && job.at < job.targets.length) job.limited = true
    const cursor = job.at < job.targets.length && job.pages < SEARCH_LIMITS.pages ? keep(job) : null
    return { items: visible, cursor, scope: 'local-bot-chats', incomplete: job.incomplete, limited: job.limited || resourceStop }
  }
  const context = async (body, actor, parentSignal) => {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'hitToken')
      || typeof body.hitToken !== 'string' || body.hitToken.length > 64) throw historyUnavailable()
    const ticket = tickets.get(body.hitToken)
    const valid = () => ticket && ticket.expires > Date.now() && ticket.principal === principal(actor)
      && allowed(actor, ticket) && visibleTurn(ticket.sessionId, ticket.turn)
    if (!valid()) throw historyUnavailable()
    const provider = rt.ctx.get?.('sessionQuery')
    if (typeof provider?.observeSession !== 'function') throw historyUnavailable()
    const isAppend = await appendPredicate()
    if (!valid()) throw historyUnavailable()
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000)
    let observation, result
    try {
      signal.throwIfAborted()
      observation = await provider.observeSession(ticket.sessionId, { signal, projectionMode: 'none' })
      signal.throwIfAborted()
      if (!valid() || observation.header?.id !== ticket.sessionId || observation.cursor !== ticket.through
        || !Array.isArray(observation.events) || observation.events.length > SEARCH_LIMITS.sourceEvents) throw historyUnavailable()
      const raw = observation.events
      const turns = turnMap(raw)
      const messages = raw.filter(event => isAppend(event) && ['user/message', 'assistant/message'].includes(event.type)
        && visibleTurn(ticket.sessionId, turns.get(event.seq))
        && (event.type !== 'user/message' || event.data?.source?.kind === 'user'))
      const at = messages.findIndex(event => event.seq === ticket.seq)
      const anchor = at >= 0 ? messageText(messages[at]) : null
      if (anchor === null || digest(anchor) !== ticket.hash || !normalized(anchor).includes(ticket.query)) throw historyUnavailable()
      const entries = messages.slice(Math.max(0, at - 2), at + 3).map(event => {
        const original = messageText(event)
        const hit = event.seq === ticket.seq
        // Preserve original text; locate the normalized match with a prefix-length
        // binary search so width/composition normalization does not replace history.
        let start = 0
        if (hit) {
          const wanted = normalized(original).indexOf(ticket.query)
          let low = 0, high = original.length
          while (low < high) {
            const middle = Math.floor((low + high) / 2)
            if (normalized(original.slice(0, middle)).length < wanted) low = middle + 1
            else high = middle
          }
          start = alignedStart(original, Math.max(0, low - 256))
        }
        const text = original === null ? '' : jsonTextPrefix(original.slice(start), hit ? 8192 : 2048)
        return { seq: event.seq, turn: turns.get(event.seq) ?? null, role: event.type === 'user/message' ? 'user' : 'assistant', hit,
          text, truncated: original === null || start > 0 || text.length < original.length, omittedBefore: start > 0 }
      })
      const list = rt.partsOf(ticket.botId)
      result = { scope: 'read-only-history', botId: ticket.botId, sessionId: ticket.sessionId, seq: ticket.seq,
        part: list.findIndex(part => part.sessionId === ticket.sessionId) + 1, partCount: list.length, entries }
      if (Buffer.byteLength(JSON.stringify(result)) > SEARCH_LIMITS.contextBytes - 64) throw historyUnavailable()
    } catch { throw historyUnavailable() }
    finally {
      try { observation?.[Symbol.dispose]?.() } catch { result = undefined }
    }
    // Disposal is synchronous but can still reveal a permission change in an
    // adapter; recheck after releasing the lease, immediately before delivery.
    if (!result || !valid() || result.entries.some(entry => !visibleTurn(ticket.sessionId, entry.turn ?? undefined))) throw historyUnavailable()
    return result
  }
  const bounded = run => async (body, actor, signal) => {
    const key = principal(actor)
    if (running.has(key) || running.size >= SEARCH_LIMITS.concurrent) throw unavailable()
    running.add(key)
    try { return await run(body, actor, signal) } finally { running.delete(key) }
  }
  rt.searchMessages = bounded(search)
  rt.readHistoryHit = bounded(context)
}

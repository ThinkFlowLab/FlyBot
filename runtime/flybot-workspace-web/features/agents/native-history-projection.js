import { createHash } from 'node:crypto'
import { livePrivateChat, ownsPrivateChatPart, privateChatThread } from '../../lib/native-chat.js'
import { NATIVE_EVENT_LEDGER } from './history.js'

const MAX_TURN_EVENTS = 2048
const MAX_CATCH_UP_EVENTS = 2048
const STORAGE_READ_MS = 1200
const MAX_COLD_REVISIONS = 128
const MAX_TEXT = 20_000
const ID = /^[0-9a-f]{32}$/

function textOf(content, allowReasoning = false) {
  if (!Array.isArray(content) || !content.length || content.some(block =>
      !(block?.type === 'text' && typeof block.text === 'string') && !(allowReasoning && block?.type === 'reasoning'))) return null
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return text.trim() && text.length <= MAX_TEXT && !text.includes('\0') && text.isWellFormed() ? text : null
}

function nativeInput(event) {
  const source = event.data?.source
  if (event.surfaceOp !== 'append' || source?.kind !== 'user' || source.imported || source.flybotWorkspaceMessageId ||
      source.handoff || source.resume || source.imOrigin ||
      (typeof source.rpcId === 'string' && /^(?:ot-|otp:|ots:|im:)/.test(source.rpcId))) return null
  const text = textOf(event.data?.content)
  return text ? {text,request:typeof source.rpcId === 'string' && source.rpcId.length <= 128 ? source.rpcId : undefined} : null
}

function turnRows(session, end, floor = session.firstLiveSeq ?? 0) {
  const turn = end.data?.turn
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(end.seq)) return []
  const users = []
  let answer, seenAnswer = false, otherInput = false
  const rowOf = (event, role, text) => ({event_seq:event.seq,role,text,created:Math.floor(event.time / 1000)})
  const canAnswer = end.data?.reason?.kind === 'completed'
  for (let seq = end.seq - 1; seq >= Math.max(floor,end.seq - MAX_TURN_EVENTS); seq--) {
    const event = session.eventAt(seq)
    if (!event) return []
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (event.type !== 'turn/start' || event.data?.turn !== turn || !users.length) return []
      const rows = users.reverse()
      if (!otherInput && answer && answer.event_seq > rows.at(-1).event_seq) {
        const request = rows.length === 1 ? rows[0].request : undefined
        rows.push({...answer,request})
      }
      return rows
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== seq || !Number.isFinite(event.time) || event.time <= 0) continue
    if (event.type === 'user/message') {
      const input = nativeInput(event)
      if (input) users.push({...rowOf(event,'user',input.text),request:input.request})
      else {
        const source = event.data?.source
        if (source?.kind === 'user' || !['instructions','catalog','snapshot','recall'].includes(source?.form)) otherInput = true
      }
    } else if (canAnswer && !seenAnswer && event.type === 'assistant/message' && event.data?.turn === turn) {
      seenAnswer = true
      const message = event.data?.message
      if (event.surfaceOp !== 'append' || event.data?.interrupted || event.data?.source?.imported || message?.source?.kind !== 'model') continue
      const text = textOf(message.content,true)
      if (text) answer = rowOf(event,'assistant',text)
    }
  }
  return []
}

export function nativeHistoryProjection({host,db}) {
  db.exec(NATIVE_EVENT_LEDGER)
  db.exec(`CREATE TABLE IF NOT EXISTS native_agent_history_checkpoints (
    session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    next_seq INTEGER NOT NULL);`)
  const jobs = new Map()
  const recovering = new Map()
  const coldRevisions = new Map()
  const mapping = db.prepare(`SELECT c.id,c.agent_id,a.workspace_id FROM native_agent_sessions s
    JOIN native_agent_objects o ON o.agent_id=s.agent_id JOIN agents a ON a.id=s.agent_id
    JOIN agent_conversations c ON c.agent_id=s.agent_id AND s.conversation_key='agent:'||c.agent_id||':'||c.id
    WHERE s.session_id=? AND o.bot_id=? AND a.archived=0 AND c.archived_at IS NULL`)
  const existing = db.prepare('SELECT 1 FROM native_agent_events WHERE session_id=? AND event_seq=?')
  const insert = db.prepare('INSERT OR IGNORE INTO agent_messages(id,conversation_id,role,text,status,created,meta) VALUES(?,?,?,?,?,?,?)')
  const record = db.prepare('INSERT INTO native_agent_events(message_id,session_id,event_seq,source) VALUES(?,?,?,?)')
  const touch = db.prepare('UPDATE agent_conversations SET updated=MAX(updated,?) WHERE id=?')
  const checkpoint = db.prepare('SELECT next_seq FROM native_agent_history_checkpoints WHERE session_id=? AND conversation_id=?')
  const advance = db.prepare(`INSERT INTO native_agent_history_checkpoints VALUES (?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET conversation_id=excluded.conversation_id,
      next_seq=CASE WHEN conversation_id=excluded.conversation_id THEN MAX(next_seq,excluded.next_seq) ELSE excluded.next_seq END`)

  function ownedConversation(rt, sessionId, allowPast = false) {
    const old = rt.pastOwners?.get(sessionId)
    if (old && (!allowPast || old.roomId !== undefined)) return null
    const botId = old?.botId ?? rt.chatOwners?.get(sessionId)
    if (typeof botId !== 'string' || !ownsPrivateChatPart(rt,botId,sessionId)) return null
    const bot = rt.botOf(botId)
    const identity = bot?.flybotWorkspace
    if (bot?.hidden || !ID.test(identity?.agent_id || '') || !ID.test(identity?.workspace_id || '')) return null
    const thread = privateChatThread(bot,sessionId)
    if (!thread || (!old && thread.sessionId !== sessionId)) return null
    let found
    for (const id of [thread.sessionId,...thread.segments.map(part => part.sessionId)]) {
      const row = mapping.get(id,botId)
      if (!row) continue
      if (row.agent_id !== identity.agent_id || row.workspace_id !== identity.workspace_id || (found && row.id !== found.id)) return null
      found = row
    }
    return found
  }

  function save(rt, sessionId, conversationId, rows, nextSeq) {
    if (ownedConversation(rt,sessionId,true)?.id !== conversationId) return false
    db.exec('BEGIN IMMEDIATE')
    try {
      let updated = 0
      for (const {event_seq,role,text,created,request} of rows) {
        if (existing.get(sessionId,event_seq)) continue
        const receipt = request ? ['request',request] : ['event',sessionId,event_seq]
        const id = createHash('sha256').update(JSON.stringify([conversationId,role,receipt])).digest('hex').slice(0,32)
        const meta = JSON.stringify({engine:'ds-bot',session_id:sessionId})
        if (!insert.run(id,conversationId,role,text,role === 'user' ? 'sent' : 'succeeded',created,meta).changes) continue
        record.run(id,sessionId,event_seq,'native')
        updated = Math.max(updated,created)
      }
      if (updated) touch.run(updated,conversationId)
      if (nextSeq !== undefined) advance.run(sessionId,conversationId,nextSeq)
      db.exec('COMMIT')
      return true
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  function enqueue(conversationId, work) {
    const job = Promise.resolve(jobs.get(conversationId)).then(work)
      .catch(() => host.log?.('Native private chat history projection could not be saved.'))
    jobs.set(conversationId,job)
    void job.then(() => { if (jobs.get(conversationId) === job) jobs.delete(conversationId) })
    return job
  }

  function recoverRows(session, from, floor) {
    const through = Math.min(session.seq, from + MAX_CATCH_UP_EVENTS)
    if (from >= through) return null
    const rows = []
    for (let seq = from; seq < through; seq++) {
      const event = session.eventAt(seq)
      if (!event || event.seq !== seq) throw new Error('Native session history is unavailable')
      if (event.type === 'turn/end') rows.push(...turnRows(session,event,floor))
    }
    return {rows, through}
  }

  async function recoverStored(storage, sessionId, next, signal = AbortSignal.timeout(STORAGE_READ_MS)) {
    if (!storage) return null
    const snapshot = await storage.stat(sessionId,{signal})
    if (!snapshot || snapshot.header?.id !== sessionId) return null
    if (snapshot.eventCount <= next) return {checked:true}
    const reached = coldRevisions.get(sessionId)
    const revision = storage.identity !== undefined && typeof snapshot.revision === 'string'
      ? {storage:storage.identity, revision:snapshot.revision} : null
    if (revision && reached?.storage === revision.storage && reached.revision === revision.revision && reached.next === next) return null
    const handle = await storage.open(sessionId,'read',{signal})
    try {
      if (handle.id !== sessionId) return null
      const floor = handle.inheritedEventCount
      const from = Math.max(floor,next)
      // A turn can start before the checkpoint and finish in the new slice.
      const offset = Math.max(floor,from - MAX_TURN_EVENTS)
      const count = from - offset + MAX_CATCH_UP_EVENTS
      const {events} = await handle.read(offset,count,{signal})
      const recovered = recoverRows({seq:offset + events.length,eventAt:seq=>events[seq - offset]},from,floor)
      return {recovered, revision:events.length < count ? revision : null}
    } finally { await handle.close() }
  }

  function previousPartIds(rt, mapping, current) {
    const exact = mapping.native_session_id
    const bot = rt.botOf(mapping.native_bot_id)
    return (privateChatThread(bot,exact)?.segments ?? []).map(part=>part.sessionId)
      .filter(id=>id !== exact && id !== current)
  }

  function requiresEarlierRecovery(runtime, mapping, conversationId) {
    const {rt,ctx} = runtime ?? {}
    if (typeof rt?.botOf !== 'function' || typeof ctx?.sessions?.get !== 'function') return false
    const current = livePrivateChat(rt,mapping.native_bot_id,mapping.native_session_id)
    return !!current && previousPartIds(rt,mapping,current).some(id=>
      !checkpoint.get(id,conversationId) && ownedConversation(rt,id,true)?.id === conversationId)
  }

  function catchUp(runtime, mapping, conversationId) {
    const {rt,ctx} = runtime ?? {}
    if (typeof rt?.botOf !== 'function' || typeof ctx?.sessions?.get !== 'function') return
    if (recovering.has(conversationId)) return recovering.get(conversationId)
    const exact = mapping.native_session_id
    const current = livePrivateChat(rt,mapping.native_bot_id,exact)
    if (!current) return
    const job = enqueue(conversationId,async () => {
      const ids = new Set([exact,current,...previousPartIds(rt,mapping,current)])
      let previousBudget
      for (const sessionId of ids) {
        if (ownedConversation(rt,sessionId,true)?.id !== conversationId) continue
        // Give additional sealed parts one shared read budget per open.
        if (sessionId !== exact && sessionId !== current) {
          previousBudget ??= AbortSignal.timeout(STORAGE_READ_MS)
          if (previousBudget.aborted) break
        }
        const next = checkpoint.get(sessionId,conversationId)?.next_seq ?? 0
        const session = ctx.sessions.get(sessionId)
        let recovered
        let revision
        let checked = false
        if (session?.id === sessionId && Number.isSafeInteger(session.seq) && typeof session.eventAt === 'function') {
          // firstLiveSeq includes the entire restored log. Only native fork seeds
          // came from a different physical Session.
          const floor = session.inheritedEventCount ?? 0
          recovered = recoverRows(session,Math.max(floor,next),floor)
          if (recovered) await ctx.sessions.flush(session)
          checked = true
        } else {
          const stored = await recoverStored(ctx.get?.('sessionPersistence'),sessionId,next,previousBudget)
          recovered = stored?.recovered
          revision = stored?.revision
          checked = stored?.checked
        }
        if (recovered && !save(rt,sessionId,conversationId,recovered.rows,recovered.through)) continue
        if (!recovered && checked && previousBudget) save(rt,sessionId,conversationId,[],next)
        if (revision) {
          coldRevisions.set(sessionId,{...revision,next:recovered?.through ?? next})
          if (coldRevisions.size > MAX_COLD_REVISIONS) coldRevisions.delete(coldRevisions.keys().next().value)
        }
      }
    })
    recovering.set(conversationId,job)
    void job.then(() => { if (recovering.get(conversationId) === job) recovering.delete(conversationId) })
    return job
  }

  function attach({rt,ctx} = {}) {
    if (typeof ctx?.on !== 'function' || typeof ctx.sessions?.flush !== 'function' || typeof rt?.botOf !== 'function') return
    ctx.on('session/event',(session,event) => {
      if (event?.type !== 'turn/end' || typeof session?.eventAt !== 'function') return
      try {
        const conversation = ownedConversation(rt,session.id)
        if (!conversation) return
        const rows = turnRows(session,event)
        if (!rows.length) return
        enqueue(conversation.id,async () => {
          await ctx.sessions.flush(session)
          save(rt,session.id,conversation.id,rows)
        })
      } catch { host.log?.('Native private chat history could not be projected.') }
    })
  }

  return {attach,catchUp,requiresEarlierRecovery,pending: id => jobs.get(id)}
}

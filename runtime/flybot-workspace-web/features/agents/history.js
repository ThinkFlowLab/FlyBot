// Adopt native Main-Bot agent threads, then import missing legacy messages as
// actual Session events. No model call, no replay or outgoing message.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import { addPrivateChat, livePrivateChat, ownsPrivateChatPart, privateChatThread } from '../../lib/native-chat.js'

export const NATIVE_EVENT_LEDGER = `CREATE TABLE IF NOT EXISTS native_agent_events(
  message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,event_seq INTEGER,source TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS native_agent_event_lookup ON native_agent_events(session_id,event_seq);`

export async function adoptThread({ rt, source, target, sessionId }) {
  if (!sessionId) return sessionId
  const existing = privateChatThread(target, sessionId)
  if (existing && livePrivateChat(rt, target.id, sessionId)) return existing.sessionId
  const thread = privateChatThread(source, sessionId)
  const unowned = () => Object.assign(new Error('Legacy agent Session has no native owner thread'), { code: 'agents/legacy-session-unowned', status: 409 })
  if (existing || !thread || !livePrivateChat(rt, source.id, sessionId)) throw unowned()
  const ids = [thread.sessionId, ...thread.segments.map(segment => segment.sessionId)]
  if (ids.some(id => !ownsPrivateChatPart(rt, source.id, id) || privateChatThread(target, id))) throw unowned()
  if (ids.some(id => rt.live.get(id)?.turn !== undefined)) throw Object.assign(new Error('Agent history is busy; retry migration'), { code:'agents/history-busy', status:409 })
  const part = {...source.openParts?.[thread.index], sessionId: thread.sessionId, segments: thread.segments}
  if (thread.index === undefined) {
    const replacement = await rt.createSession(source.name, { dir: rt.workDirOf({ botId: source.id }) })
    source.sessionId = replacement; source.segments = []; rt.chatOwners.set(replacement, source.id)
  } else source.openParts.splice(thread.index, 1)
  rt.chatOwners.delete(part.sessionId)
  rt.pastOwners?.delete(part.sessionId)
  addPrivateChat(rt, target, part)
  return part.sessionId
}

export async function importHistory({ db, rt, ctx, bot, conversationId, sessionId, secondarySessionIds = [] }) {
  db.exec(NATIVE_EVENT_LEDGER)
  // Stopped partial replies are retained for the user, without constructing an
  // assistant message in the native Session that the model never completed.
  const rows = db.prepare(`SELECT m.* FROM agent_messages m WHERE m.conversation_id=? AND m.status<>'cancelled'
    AND NOT EXISTS (SELECT 1 FROM native_agent_events e WHERE e.message_id=m.id)
    ORDER BY m.created,m.rowid`).all(conversationId)
    .filter(row => !JSON.parse(row.meta || '{}').nativePending)
  if (!rows.length) return { imported:0, matched:0 }
  const scan = new Set()
  for (const sid of [sessionId, ...secondarySessionIds].filter(Boolean)) {
    const thread = privateChatThread(bot, sid)
    for (const part of thread?.segments || []) scan.add(part.sessionId)
    if (thread) scan.add(thread.sessionId)
    scan.add(sid)
  }
  const events = []
  for (const id of scan) {
    const agent = await rt.resolveAgent(id); await ctx.sessions.flush(agent.session)
    for await (const event of rt.eventsBackwards(id, AbortSignal.timeout(15000), Infinity)) {
      if (!['user/message','assistant/message','flybot-workspace/message-status','plugin:flybot-workspace/message-status'].includes(event.type)) continue
      const role = ['flybot-workspace/message-status','plugin:flybot-workspace/message-status'].includes(event.type) ? event.data.role : event.type === 'user/message' ? 'user' : 'assistant'
      const content = role === 'user' ? event.data.content : event.data.message?.content
      let text = (Array.isArray(content) ? content : []).filter(c=>c.type==='text').map(c=>c.text).join('\n')
      // Former persona-based Main Bot agent turns wrapped the user's text.
      if (role === 'user' && text.includes('\n\nUser: ')) text = text.slice(text.lastIndexOf('\n\nUser: ')+8)
      events.push({ role,text,id,seq:event.seq,time:event.time,tag:event.data.source?.flybotWorkspaceMessageId,rpc:event.data.source?.rpcId })
    }
  }
  events.sort((a,b)=>a.time-b.time || a.seq-b.seq)
  const used = new Set(events.flatMap((e,i)=>db.prepare('SELECT 1 FROM native_agent_events WHERE session_id=? AND event_seq=?').get(e.id,e.seq) ? [i] : [])), put = db.prepare('INSERT OR IGNORE INTO native_agent_events VALUES(?,?,?,?)')
  const writeSessionId = privateChatThread(bot, sessionId)?.sessionId ?? sessionId
  const agent = await rt.resolveAgent(writeSessionId)
  let imported=0,matched=0
  // A native system head must precede the first surface message. This is an
  // EMPTY current initialization, not a historical prompt or model response.
  // Native execution replaces it with the actual scoped prompt before inference.
  const initializeHead = async () => {
    if (agent.session.surface.nodes.length) return
    const native = await import(pathToFileURL(createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').resolve('@deepseek-ai/dsh-llm')).href)
    const source={kind:'flybot-workspace-initialization',reason:'protect-native-history-head',noModelCall:true}
    let turn=1
    for(let seq=0;seq<agent.session.seq;seq++){const e=agent.session.eventAt(seq);if(e.type==='turn/start')turn=Math.max(turn,e.data.turn+1)}
    agent.session.append('turn/start',{turn,source})
    agent.session.append('step/start',{turn,step:1,source})
    agent.session.append('system/message',{turn,step:1,message:native.createSystemMessage('')},{surfaceOp:'append'})
    agent.session.append('step/end',{turn,step:1,source})
    agent.session.append('turn/end',{turn,source})
    await ctx.sessions.flush(agent.session)
  }
  for(const row of rows){
    const known=events.find((e,i)=>!used.has(i) && (e.tag===row.id || e.rpc==='ot-agent:'+row.id || e.rpc==='otp:'+row.id || (e.role===row.role && e.text===row.text && row.text)))
    if(known){ used.add(events.indexOf(known));put.run(row.id,known.id,known.seq,'adopted');matched++;continue }
    await initializeHead()
    // Failed/empty messages remain visible diagnostic events, not fabricated replies.
    const source={kind:'user',flybotWorkspaceMessageId:row.id,originalTime:row.created*1000,imported:true,status:row.status}
    let event
    if(!row.text || row.status==='failed') {
      // Resolve the engine's public module, not a second private-class copy.
      const native = await import(pathToFileURL(createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').resolve('@deepseek-ai/dsh-session')).href)
      const seq = native.appendPluginRecord(agent.session,'plugin:flybot-workspace/message-status',{source,role:row.role,text:row.text,status:row.status})
      event=agent.session.eventAt(seq)
    } else if(row.role==='user') event=agent.session.append('user/message',{id:row.id,role:'user',source,content:[{type:'text',text:row.text}]},{surfaceOp:'append'})
    else {
      // Imported transcript boundary, NOT a new model invocation. Provider/model
      // were not retained by the legacy platform, so explicitly label them unknown.
      let turn=1
      for(let seq=0;seq<agent.session.seq;seq++){const e=agent.session.eventAt(seq);if(e.type==='turn/start')turn=Math.max(turn,e.data.turn+1)}
      const history={...source,kind:'flybot-workspace-history'}
      agent.session.append('turn/start',{turn,source:history,imported:true})
      agent.session.append('step/start',{turn,step:1,source:history,imported:true})
      event=agent.session.append('assistant/message',{turn,step:1,source,stream:[],message:{id:row.id,role:'assistant',source:{...history,kind:'model',provider:'flybot-workspace-history',model:'historical-unknown'},content:[{type:'text',text:row.text}]}},{surfaceOp:'append'})
      agent.session.append('step/end',{turn,step:1,source:history,imported:true})
      agent.session.append('turn/end',{turn,source:history,imported:true})
    }
    // Flush BEFORE mapping: a crash between these is recovered by event source id.
    await ctx.sessions.flush(agent.session)
    put.run(row.id,writeSessionId,event.seq,'imported'); imported++
  }
  return { imported,matched }
}

// Compatibility for the first history-import release: those append-only events
// predate the native required stream field. Normalize ONLY our marked imports
// for native projection reads; preserve the durable log and source mapping.
// Empty stream means no recorded transport/usage, never invented token usage.
export function normalizeImportedSession(session) {
  const prototype = Object.getPrototypeOf(session)
  const mark = Symbol.for('flybot-workspace.imported-event-normalizer')
  if (!prototype || prototype[mark]) return
  const read = prototype.eventAt
  prototype.eventAt = function (seq) {
    const e = read.call(this, seq)
    return e?.type === 'assistant/message' && e.data?.source?.imported === true && /^[0-9a-f]{32}$/.test(e.data.source.flybotWorkspaceMessageId || '') && !Array.isArray(e.data.stream)
      ? { ...e, data: { ...e.data, stream: [] } } : e
  }
  prototype[mark] = true
}

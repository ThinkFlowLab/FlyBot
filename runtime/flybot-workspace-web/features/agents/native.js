// Stable platform-agent -> actual native roster object. The SQLite record is
// compatibility metadata, not an alternate executor. Native edits are pulled on
// reads; writes and turns target the mapped Bot. The Personal Agent maps to
// the native Chief.
import { adoptThread, importHistory } from './history.js'
import { createHash } from 'node:crypto'
import { addPrivateChat, livePrivateChat, ownsPrivateChatPart, privateChatThread } from '../../lib/native-chat.js'

export function nativeAgents({ host, db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_agent_objects (
    agent_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE, last_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_agent_sessions (
    conversation_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS native_agent_pending_titles (
    conversation_id TEXT PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE, title TEXT NOT NULL);`)
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  let queue = Promise.resolve()
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next }
  const services = async () => { const s = await host.runtime(); await s.mainBot(); return s }
  const personal = row => row && one('SELECT 1 FROM native_personal_binding WHERE singleton=1 AND agent_id=? AND workspace_id=?', row.id, row.workspace_id)
  async function chiefFor(s, row) {
    if (!personal(row)) return undefined
    const id = await s.mainBot()
    return s.rt.isMain?.(id) === true ? s.rt.botOf(id) : undefined
  }
  const needsChiefBinding = (row, chief) => chief && one('SELECT bot_id FROM native_agent_objects WHERE agent_id=?', row.id)?.bot_id !== chief.id

  async function bindChief(rt, row, chief, previous) {
    const conflict = () => Object.assign(new Error('Cannot safely bind Personal Agent to the native Main Bot'),
      {code:'agents/personal-binding-conflict', status:409})
    const mapped = one('SELECT agent_id FROM native_agent_objects WHERE bot_id=?', chief.id)
    const owned = link => link?.agent_id === row.id && link.workspace_id === row.workspace_id
    if ((mapped && mapped.agent_id !== row.id) || (chief.flybotWorkspace?.agent_id && !owned(chief.flybotWorkspace))) throw conflict()
    if (previous && !owned(previous.flybotWorkspace) && (!owned(chief.flybotWorkspace) || previous.flybotWorkspace?.agent_id)) throw conflict()

    const prefix = `agent:${row.id}:`
    const sessions = new Map(Object.entries(previous?.flybotWorkspace?.sessionKeys ?? {}).filter(([key]) => key.startsWith(prefix)))
    for (const {conversation_key:key, session_id:id} of db.prepare('SELECT conversation_key,session_id FROM native_agent_sessions WHERE agent_id=?').all(row.id)) {
      if (!key.startsWith(prefix) || (sessions.has(key) && sessions.get(key) !== id)) throw conflict()
      sessions.set(key, id)
    }
    for (const [key, id] of sessions) {
      const saved = chief.flybotWorkspace?.sessionKeys?.[key]
      if ((saved && saved !== id) || typeof id !== 'string' || !id) throw conflict()
      if (livePrivateChat(rt, chief.id, id)) continue
      const thread = privateChatThread(previous, id)
      if (!thread || !livePrivateChat(rt, previous.id, id)) throw conflict()
      const parts = [thread.sessionId, ...thread.segments.map(part => part.sessionId)]
      if (parts.some(part => !ownsPrivateChatPart(rt, previous.id, part) || privateChatThread(chief, part))) throw conflict()
      if (parts.some(part => rt.live.get(part)?.turn !== undefined)) {
        throw Object.assign(new Error('Wait for the Personal Agent to finish before reconnecting'), {code:'agents/history-busy', status:409})
      }
    }
    for (const id of sessions.values()) if (!livePrivateChat(rt, chief.id, id)) await adoptThread({rt, source:previous, target:chief, sessionId:id})

    chief.flybotWorkspace ??= {}
    Object.assign(chief.flybotWorkspace, {agent_id:row.id, workspace_id:row.workspace_id, summary:row.summary,
      category:row.category, quick_starts:JSON.parse(row.quick_starts), portrait:row.portrait})
    for (const [key, id] of sessions) {
      (chief.flybotWorkspace.sessionKeys ??= {})[key] = id
      if (previous?.flybotWorkspace?.pendingSessionSetup?.[key]) (chief.flybotWorkspace.pendingSessionSetup ??= {})[key] = true
      if (previous?.flybotWorkspace?.sessionKeys) delete previous.flybotWorkspace.sessionKeys[key]
      if (previous?.flybotWorkspace?.pendingSessionSetup) delete previous.flybotWorkspace.pendingSessionSetup[key]
    }
    if (owned(previous?.flybotWorkspace)) {
      delete previous.flybotWorkspace.agent_id
      delete previous.flybotWorkspace.workspace_id
    }
    // Persist native ownership before committing its SQLite reference. Retrying
    // a crash between writes recognizes the thread IDs now owned by Chief.
    await rt.save()
    run(`INSERT INTO native_agent_objects VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
      bot_id=excluded.bot_id,last_name=excluded.last_name`, row.id, chief.id, chief.name)
    return chief
  }

  async function withChiefLock(row, fn) {
    if (!personal(row)) return serial(fn)
    const s = await services()
    const chief = await chiefFor(s, row)
    return s.exclusive && needsChiefBinding(row, chief) ? s.exclusive(() => serial(fn)) : serial(fn)
  }
  const titleJobs = new Map()
  const pendingTitle = (id, agentId) => one(`SELECT p.title FROM native_agent_pending_titles p
    JOIN agent_conversations c ON c.id=p.conversation_id WHERE c.id=? AND c.agent_id=?`, id, agentId)?.title

  function markSessionTitle(conversationId, title) {
    run(`INSERT INTO native_agent_pending_titles VALUES (?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET title=excluded.title`, conversationId, title)
  }

  function renameSession(row, key) {
    const prefix = `agent:${row.id}:`
    if (!key.startsWith(prefix)) return
    const id = key.slice(prefix.length)
    if (!pendingTitle(id, row.id)) return
    const prior = titleJobs.get(key) || Promise.resolve()
    const job = prior.then(async () => {
      const title = pendingTitle(id, row.id)
      if (!title) return
      const mapping = mappedSession(row, key)
      if (!mapping) return
      const { rt, ctx } = await host.runtime()
      const sessionId = livePrivateChat(rt, mapping.native_bot_id, mapping.native_session_id)
      if (!sessionId) return
      const target = await rt.resolveAgent(sessionId)
      await ctx.sessionTitle.rename(target.session, title)
      run('DELETE FROM native_agent_pending_titles WHERE conversation_id=? AND title=?', id, title)
    }).catch(() => host.log?.('Native session title will be retried after the session is available.'))
    titleJobs.set(key, job)
    void job.then(() => { if (titleJobs.get(key) === job) titleJobs.delete(key) })
    return job
  }

  // A runtime can stop between saving a conversation title and updating its native Session.
  for (const { id, agent_id } of db.prepare(`SELECT c.id,c.agent_id FROM native_agent_pending_titles p
    JOIN agent_conversations c ON c.id=p.conversation_id`).all()) {
    void renameSession({ id: agent_id }, `agent:${agent_id}:${id}`)
  }

  const nativeName = (rt, row) => {
    const plain = row.name.slice(0, 40)
    const taken = Object.values(rt.state.bots).some(b => b.name === plain && b.flybotWorkspace?.agent_id !== row.id)
    return taken || row.name.length > 40 ? row.name.slice(0, 29) + '-' + row.id.slice(0, 10) : plain
  }
  async function ensure(row) {
    const s = await services(), { rt } = s
    row = one('SELECT * FROM agents WHERE id=?', row.id)
    let mapping = one('SELECT * FROM native_agent_objects WHERE agent_id=?', row.id)
    // Recover a create whose roster save completed before the mapping commit.
    let bot = mapping ? rt.botOf(mapping.bot_id) : Object.values(rt.state.bots).find(b => b.flybotWorkspace?.agent_id === row.id)
    const chief = await chiefFor(s, row)
    if (needsChiefBinding(row, chief)) {
      if (mapping && !bot) throw Object.assign(new Error('The previous Personal Agent could not be found'), {code:'agents/personal-binding-conflict', status:409})
      bot = await bindChief(rt, row, chief, bot === chief ? undefined : bot)
      mapping = one('SELECT * FROM native_agent_objects WHERE agent_id=?', row.id)
    }
    if (!bot && mapping) {
      run('UPDATE agents SET archived=1 WHERE id=?', row.id)
      return { ...row, archived: 1, native_bot_id: mapping.bot_id, native_deleted: true }
    }
    if (!bot) {
      bot = await rt.createBot({ name: nativeName(rt, row), instructions: row.instructions, role: row.summary.slice(0, 24), pickModel: true })
      // Importing/creating an object is not permission to send a greeting.
      delete bot.kickoff
      const main = rt.botOf(await s.mainBot())
      bot.model = main?.model
      bot.capabilities = row.inherit_capabilities === 0 ? [] : [...(main?.capabilities || [])]
      bot.flybotWorkspace = { agent_id: row.id, workspace_id: row.workspace_id, summary: row.summary, category: row.category, quick_starts: JSON.parse(row.quick_starts), portrait: row.portrait }
      if (row.archived) bot.hidden = true
      await rt.save()
    }
    if (!mapping) run('INSERT OR IGNORE INTO native_agent_objects VALUES(?,?,?)', row.id, bot.id, bot.name)
    const lastName = mapping?.last_name || bot.name
    const nextName = bot.name !== lastName ? bot.name : row.name
    const instructions = bot.instructions || ''
    const changed = nextName !== row.name || instructions !== row.instructions || Number(!!bot.hidden) !== row.archived
    if (changed) {
      const hash = createHash('sha256').update(nextName.toLowerCase()).digest('hex')
      const collision = one('SELECT id FROM agents WHERE workspace_id=? AND name_hash=? AND id<>?', row.workspace_id, hash, row.id)
      if (collision) throw Object.assign(new Error('Native Bot rename conflicts with workspace agent name'), { status: 409, code: 'agents/conflict' })
      // name_hash updated by the caller with the shared hashing rule.
      run('UPDATE agents SET name=?,name_hash=?,instructions=?,archived=?,revision=revision+1,updated=? WHERE id=?', nextName, hash, instructions, Number(!!bot.hidden), Math.floor(Date.now()/1000), row.id)
    }
    run('UPDATE native_agent_objects SET last_name=? WHERE agent_id=?', bot.name, row.id)
    const current = one('SELECT * FROM agents WHERE id=?', row.id)
    return { ...current, native_bot_id: bot.id, native_name: bot.name }
  }
  async function update(row, patch) {
    const { rt } = await services()
    const bot = rt.botOf(row.native_bot_id)
    if (row.native_deleted || !bot) throw Object.assign(new Error('Native Bot was deleted; it will not be silently recreated'), { status: 409, code: 'agents/native-deleted' })
    if (!Object.keys(patch).length) return { native_bot_id: bot.id, native_name: bot.name }
    const nativePatch = {}
    if (patch.name !== undefined) nativePatch.name = nativeName(rt, { ...row, name: patch.name })
    if (patch.instructions !== undefined) nativePatch.instructions = patch.instructions
    if (patch.summary !== undefined) nativePatch.role = patch.summary.slice(0,24)
    if (Object.keys(nativePatch).length) await rt.updateBot(bot.id, nativePatch)
    if (patch.archived !== undefined) await rt.setFlags(bot.id, { hidden: !!patch.archived })
    bot.flybotWorkspace = { ...bot.flybotWorkspace, ...Object.fromEntries(['summary','category','quick_starts','portrait'].filter(k => patch[k] !== undefined).map(k => [k,patch[k]])) }
    await rt.save()
    run('UPDATE native_agent_objects SET last_name=? WHERE agent_id=?', bot.name, row.id)
    return { native_bot_id: bot.id, native_name: bot.name }
  }
  function legacySessionIds(s, row, key) {
    const conversationId = key.slice(('agent:' + row.id + ':').length)
    const privateConversation = one('SELECT id FROM agent_conversations WHERE id=? AND agent_id=?', conversationId, row.id)
    const personal = privateConversation && one('SELECT 1 FROM native_personal_binding WHERE singleton=1 AND agent_id=? AND workspace_id=?', row.id, row.workspace_id)
    return [...new Set([s.legacySession?.(key), privateConversation ? s.legacySession?.(conversationId) : undefined, personal ? s.legacySession?.('plugin:' + conversationId) : undefined].filter(Boolean))]
  }
  async function bindSession(s, row, key, title, legacyIds) {
    const mapped = await ensure(row)
    if (mapped.native_deleted) throw Object.assign(new Error('Native Bot was deleted'), { status: 409, code: 'agents/native-deleted' })
    const { rt } = s
    const bot = rt.botOf(mapped.native_bot_id)
    let m = one('SELECT * FROM native_agent_sessions WHERE conversation_key=?', key)
    const conversationId = key.slice(('agent:' + row.id + ':').length)
    const adopted = []
    for (const legacyId of legacyIds) adopted.push(await adoptThread({ rt, source: rt.botOf(await s.mainBot()), target: bot, sessionId: legacyId }))
    bot.flybotWorkspace.sessionKeys ??= {}
    if (!m) {
      const recovered = bot.flybotWorkspace.sessionKeys[key]
      const sessionId = recovered || adopted[0] || await rt.createSession(title || row.name, { dir: rt.workDirOf({ botId: bot.id }) })
      const fresh = !recovered && !adopted.length
      if (fresh) addPrivateChat(rt, bot, {sessionId, segments: [], startedAt: Date.now()})
      bot.flybotWorkspace.sessionKeys[key] = sessionId
      await prepareSession(sessionId, fresh)
      await rt.save()
      run('INSERT INTO native_agent_sessions VALUES(?,?,?)', key, row.id, sessionId)
      m = { session_id: sessionId }
    } else if (await prepareSession(m.session_id) || adopted.length) await rt.save()
    await importHistory({ db, rt, ctx: s.ctx, bot, conversationId, sessionId: m.session_id, secondarySessionIds: adopted })
    void renameSession(row, key)
    return { native_bot_id: mapped.native_bot_id, native_session_id: m.session_id, native_name: mapped.native_name }

    async function prepareSession(sessionId, fresh = false) {
      const metadata = bot.flybotWorkspace
      if (!s.prepareMappedChat || (!fresh && metadata.pendingSessionSetup?.[key] !== sessionId)) return false
      try {
        // The native composer uses the Session's route even before its first Web turn.
        await s.prepareMappedChat(bot.id, sessionId)
        delete metadata.pendingSessionSetup?.[key]
        return true
      } catch {
        // Keep an empty chat available and retry this exact part on the next bind.
        metadata.pendingSessionSetup ??= {}
        metadata.pendingSessionSetup[key] = sessionId
        host.log?.('The native chat configuration will be retried when the chat is next bound.')
        return false
      }
    }
  }
  async function session(row, key, title) {
    const s = await services()
    const legacyIds = legacySessionIds(s, row, key)
    const chief = await chiefFor(s, row)
    const botId = legacyIds.length === 0 && !needsChiefBinding(row, chief)
      ? one('SELECT bot_id FROM native_agent_objects WHERE agent_id=?', row.id)?.bot_id : undefined
    // Never hold the roster write queue while waiting for the Bot. Adopting
    // an old thread may affect both the Main Bot and its new owner.
    const bind = () => serial(() => bindSession(s, row, key, title, legacyIds))
    return s.exclusive ? s.exclusive(bind, botId) : bind()
  }
  function mappedSession(row, key) {
    // An established conversation can show its durable messages while a model
    // turn holds the bridge lock. Reconciliation still runs before native writes.
    const mapping = one(`SELECT o.bot_id AS native_bot_id, o.last_name AS native_name, s.session_id AS native_session_id
      FROM native_agent_sessions s JOIN native_agent_objects o ON o.agent_id=s.agent_id
      WHERE s.conversation_key=? AND s.agent_id=?`, key, row.id)
    const rt = host.currentRuntime?.()?.rt
    return mapping && (!rt || rt.botOf(mapping.native_bot_id)) ? mapping : null
  }
  async function readSession(row, key, title) {
    return mappedSession(row, key) || session(row, key, title)
  }
  return { ensure: row => withChiefLock(row, () => ensure(row)),
    // Check the revision, change the roster, and advance SQLite under the same lock.
    write: (fn, id) => withChiefLock(typeof id === 'string' ? one('SELECT id,workspace_id FROM agents WHERE id=?', id) : undefined, () => fn({ensure,update})),
    session, readSession, mappedSession, markSessionTitle, renameSession }
}

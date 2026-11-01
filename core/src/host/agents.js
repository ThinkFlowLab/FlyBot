// The DSH Agent: a team's one plain dsh entry, listed beside the Bots but not one of
// them. Its Sessions are ordinary root Sessions in the DS Bot workspace, so they get
// the whole dsh conversation surface and none of the team tools.
import { randomUUID } from 'node:crypto'
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX, TEAM_TOOLS } from './constants.js'
import { cut } from './text.js'

export function install(rt) {
  const { ctx, state } = rt

  /** @type {Map<string, string>} Session id -> DSH Agent record id. */
  const sessionIndex = new Map()
  // store.js calls this from indexSessions after every adopt and save.
  rt.indexAgents = () => {
    sessionIndex.clear()
    for (const agent of Object.values(state.agents)) {
      for (const sessionId of agent.sessions ?? []) sessionIndex.set(sessionId, agent.id)
    }
  }
  // The DSH Agent a Session belongs to; Bot and group Sessions get undefined.
  const agentOf = sessionId => state.agents[sessionIndex.get(sessionId)]

  // A DSH Agent Session must not offer the team tools: its agent sees only the
  // global dsh surface minus this plugin's registrations. A Session whose deny
  // has not landed yet (schemas not up, restrict hook missing, a transient
  // throw) stays on the retry list until it sticks or the Session leaves.
  const restricted = new WeakSet()
  const RETRY_MS = 5_000
  const pendingRestrict = new Set()
  let retryTimer
  const stopRetry = () => {
    if (retryTimer !== undefined) clearInterval(retryTimer)
    retryTimer = undefined
  }
  ctx.effect(() => stopRetry, 'ds-bot: agent tool restrict retry')
  const scheduleRetry = (agent) => {
    pendingRestrict.add(agent)
    if (retryTimer === undefined) {
      retryTimer = setInterval(() => {
        for (const waiting of [...pendingRestrict]) void restrictTeamTools(waiting)
        if (pendingRestrict.size === 0) stopRetry()
      }, RETRY_MS)
      retryTimer.unref?.()
    }
  }
  const restrictTeamTools = async (agent) => {
    if (agent === undefined || restricted.has(agent)) return
    if (agentOf(agent.session?.id) === undefined) {
      pendingRestrict.delete(agent)
      return
    }
    // Unknown names make restrict() throw, so only deny what this profile serves.
    const known = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
    const deny = TEAM_TOOLS.filter(name => known.has(name))
    // An empty list can mean the schemas are not up yet, and a missing restrict
    // hook means the Agent is still being put together; both retry.
    if (deny.length === 0 || typeof agent.ctx?.tools?.restrict !== 'function') {
      scheduleRetry(agent)
      return
    }
    try {
      agent.ctx.tools.restrict({ deny })
      restricted.add(agent)
      pendingRestrict.delete(agent)
    } catch (error) {
      rt.warn('ds-bot: team tools stay visible to DSH Agent %s: %s', agent.session?.id, error)
      scheduleRetry(agent)
    }
  }
  // Fires when a root Session resolves its agent, including sessions saved earlier.
  ctx.on('agent/created', ({ agent }) => {
    void rt.load()
      .then(() => restrictTeamTools(agent))
      .catch(error => rt.warn('ds-bot: tool restrict on agent/created failed: %s', error))
  })

  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  // A change made outside a request may start in a window that was read-only only because
  // the other dsh had the team open: refresh first — it adopts what that host left and
  // takes the free lock (#1027, #1032) — then refuse if the lock is still someone else's.
  const beforeWrite = async () => {
    if (rt.readOnly() !== undefined) await rt.refresh()
    writeCheck()
  }
  const record = (agentId) => {
    const agent = state.agents[agentId]
    if (agent === undefined) throw new Error('Unknown DSH Agent')
    return agent
  }

  async function createAgentSession(agentId, workspaceId) {
    record(agentId)
    await beforeWrite()
    // A known workspace id wins (the Agent's latest Session may live outside the
    // team workspace after a workspace switch); anything else gets the team's own.
    const target = typeof workspaceId === 'string' && ctx.workspaceRegistry.get(workspaceId)
      ? workspaceId
      : await rt.ensureWorkspace()
    const { sessionId } = await ctx.sessionController.create({ workspaceId: target })
    await rt.mutate(() => { record(agentId).sessions.push(sessionId) })
    // agent/created fired before the session joined the index, so restrict again now.
    await restrictTeamTools(await rt.resolveAgent(sessionId))
    return sessionId
  }

  // A root Session the user opened from a DSH Agent page (the hero's workspace
  // picker or a fork) is adopted into the same Agent: it keeps dsh's surface and
  // the team tools stay hidden.
  async function adoptAgentSession(agentId, sessionId) {
    record(agentId)
    await beforeWrite()
    if (record(agentId).sessions.includes(sessionId)) return sessionId
    await rt.resolveAgent(sessionId)
    // The ownership check reads the records, so it runs inside the change, after the adopt.
    await rt.mutate(() => {
      const owned = rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
        || rt.roomOf(sessionId) !== undefined || agentOf(sessionId) !== undefined
      if (owned) throw new Error('Session already belongs to the team')
      const agent = record(agentId)
      if (!agent.sessions.includes(sessionId)) agent.sessions.push(sessionId)
    })
    await restrictTeamTools(await rt.resolveAgent(sessionId))
    return sessionId
  }

  async function addAgent() {
    const id = randomUUID()
    await rt.mutate(() => {
      writeCheck()
      if (Object.keys(state.agents).length > 0) throw new Error('The team already has a DSH Agent')
      state.agents[id] = { id, name: AGENT_NAME, sessions: [], createdAt: Date.now() }
    })
    try {
      await createAgentSession(id)
    } catch (error) {
      // The first Session may already be created and saved: archive it and
      // persist the rollback, or the Agent returns on restart with its team
      // tools never denied.
      const createdSessions = [...record(id).sessions]
      await rt.mutate(() => { delete state.agents[id] }).catch(() => { /* rollback is best effort; the original error is what the caller sees */ })
      for (const sessionId of createdSessions) await ctx.workspaceRegistry.archiveSession(sessionId).catch(() => { /* rollback is best effort; the original error is what the caller sees */ })
      throw error
    }
    return record(id)
  }

  async function archiveAgentSession(agentId, sessionId) {
    record(agentId)
    await beforeWrite()
    if (!record(agentId).sessions.includes(sessionId)) throw new Error('Session does not belong to the DSH Agent')
    // Archive first: the Session leaves the Agent only once it is actually gone,
    // so a failed archive stays retryable and keeps its tool restriction.
    await ctx.workspaceRegistry.archiveSession(sessionId)
    await rt.mutate(() => {
      const agent = record(agentId)
      agent.sessions = agent.sessions.filter(id => id !== sessionId)
    })
  }

  async function renameAgentSession(agentId, sessionId, title) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw new Error('Session does not belong to the DSH Agent')
    const clean = String(title ?? '').trim()
    if (clean === '') throw new Error('A session needs a title')
    const agent_ = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent_.session, cut(clean, AGENT_SESSION_TITLE_MAX).text)
  }

  async function removeAgent(agentId) {
    record(agentId)
    await beforeWrite()
    const sessions = [...record(agentId).sessions]
    const kept = []
    let failure
    for (const sessionId of sessions) {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId)
      } catch (error) {
        failure ??= error
        kept.push(sessionId)
      }
    }
    // What could not be archived stays with the Agent, so it keeps its tool
    // restriction and the removal can be retried from the same place.
    if (kept.length > 0) {
      await rt.mutate(() => { record(agentId).sessions = kept })
      throw failure
    }
    await rt.mutate(() => { delete state.agents[agentId] })
  }

  Object.assign(rt, { agentOf, addAgent, createAgentSession, adoptAgentSession, archiveAgentSession, renameAgentSession, removeAgent })
}

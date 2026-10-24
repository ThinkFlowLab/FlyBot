import { setLocalBots } from './characters.js'
import { setPluginTools } from './text.js'

// -------------------------------------------------------------------------
// Small observable sources for the inject `hooks` compartment.

export function createSource(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved === value) return
      value = resolved
      for (const listener of [...listeners]) listener()
    },
  }
}

export const EMPTY_ROSTER = { revision: -1, mainBotId: null, mainBotIds: [], bots: [], rooms: [], humans: [], self: null, agents: [], exchangeTurns: {}, remoteTypedTurns: {}, remoteAwaiting: {}, questions: {}, secrets: [], capabilities: [], capabilityStatuses: {}, secretRequests: {}, models: [], defaultModel: null, modelsKey: null, prefs: {}, byId: {}, roomsById: {}, agentsById: {}, agentOf: {}, ready: false }
// Any Main Bot holds the Main Bot powers; `mainBotId`, the first one, is the sidebar tile.
export const isMainOf = (roster, id) => id !== undefined && (roster.mainBotIds ?? []).includes(id)

// A Bot's chat is a chain of Sessions ("parts"): the Bot id is its first part's id
// and `sessionId` its current one. Every part id finds the Bot; Session state
// (running, unread, turns) is read from the current part, team state from the Bot id.
export function indexRoster(value) {
  setLocalBots(value.bots)
  setPluginTools(value.pluginTools)
  const byId = {}
  // A remote chat must not replace a local Bot's id or session (#963). Nobody
  // takes another Bot's own id; the same Bot may refresh its own keys.
  const claim = (bot, id) => {
    if (id === undefined || id === null || id === '') return
    const prev = byId[id]
    if (prev && prev !== bot && !prev.remote && bot?.remote) return
    if (prev && prev !== bot && prev.id === id) return
    byId[id] = bot
  }
  for (const bot of value.bots) {
    for (const id of [...(bot.parts ?? []), bot.sessionId ?? bot.id, bot.id]) claim(bot, id)
  }
  const roomsById = {}
  for (const room of value.rooms) roomsById[room.id] = room
  // The DSH Agent is not a Bot: it indexes by its own id and by each Session it owns.
  const agentsById = {}
  const agentOf = {}
  for (const agent of value.agents ?? []) {
    agentsById[agent.id] = agent
    for (const sessionId of agent.sessions ?? []) agentOf[sessionId] = agent.id
  }
  return { ...value, agents: value.agents ?? [], byId, roomsById, agentsById, agentOf, ready: true }
}

// A member id, session id, or part id. A local Bot wins when a friend's chat
// was indexed under the same key (#963).
export function rosterBot(roster, id) {
  if (id === undefined || id === null || id === '') return undefined
  const list = roster?.bots ?? []
  const own = list.find(bot => bot && !bot.remote && (bot.id === id || bot.sessionId === id || (bot.parts ?? []).includes(id)))
  if (own) return own
  return roster?.byId?.[id]
}

// The local Bot of this display name, else a friend's Bot with that name (#963).
export function botByName(bots, name) {
  const wanted = String(name ?? '').toLowerCase()
  if (wanted === '') return undefined
  const list = Array.isArray(bots) ? bots : []
  return list.find(bot => bot && !bot.remote && String(bot.name ?? '').toLowerCase() === wanted)
    ?? list.find(bot => bot && String(bot.name ?? '').toLowerCase() === wanted)
}

// Whether a main-view Session id belongs to the team's DSH Agent: the conversation
// group then stays withdrawn while the shell keeps the sidebar. Before the roster
// arrives, the ids cached from the last pull answer.
export function isAgentSession(roster, cache, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return false
  if (roster.ready) return roster.agentOf[sessionId] !== undefined
  return cache.has(sessionId)
}

// Per Session, how many mounted cells draw each card call; a count of 0 drops the call.
export function countCards(state, sessionId, callIds, delta) {
  const own = { ...state[sessionId] }
  for (const callId of callIds) {
    const count = (own[callId] ?? 0) + delta
    if (count > 0) own[callId] = count
    else delete own[callId]
  }
  return { ...state, [sessionId]: own }
}

// Which Bot turn may use a connector (#335, #369). The connector tools (mcp__github__*,
// mcp__composio__*) are mounted once for the whole DSH profile (connectors.js), so each Bot's own
// tool list and every call are narrowed here. Two questions decide, per Bot and connector:
//
//   - Whose turn is it? (turn-origin.js reads it from the messages the turn took in.) The owner's own
//     turn (typed in the Bot's chat, a Bot of the same owner passing the owner's request on) uses the
//     tools unless the owner turned them off for that Bot: `bot.connectors = { composio: false }`.
//     Absent means on, so every Bot, old or new, has the connected connector, also a Bot that is
//     shared with someone: sharing a Bot never takes the owner's own use away.
//   - A turn someone else started (a friend, another room member, another owner's Bot, a room with
//     other people in it) uses them only when the owner allowed shared use for that Bot:
//     `bot.connectorsShared = { composio: true }`; absent means off, and it also needs the owner's own
//     switch on. A turn whose origin cannot be determined counts as someone else's (fail closed), and
//     so does a Session whose Bot or parent chain cannot be resolved.
//   - The tools are taken out of the Bot's tool list (restrict, per Agent) and every call is refused by a
//     guard that looks at the answer when the call happens. A sub-agent counts as its parent's Bot and
//     turn. Sessions that belong to no Bot (the DSH Agent, plain DSH sessions) are not touched: they
//     are the owner's own, and no friend can reach them.
//
// The switches change only through `bot-connectors` on the channel, which Bots do not call.

import { GITHUB, COMPOSIO } from './connectors.js'
import { OWNER, OTHER, settled } from './turn-origin.js'

export const CONNECTOR_IDS = [GITHUB, COMPOSIO]
const prefixOf = id => `mcp__${id}__`
export const connectorOfTool = name => (typeof name === 'string' ? CONNECTOR_IDS.find(id => name.startsWith(prefixOf(id))) : undefined)
const MAX_DEPTH = 8

export function install(rt) {
  const { ctx, state } = rt

  // Only an explicit false turns it off for the owner; a Bot with no record has it (a team saved by
  // #346, where an absent record meant off, therefore starts on). Only an explicit true offers it to others.
  const turnedOff = (bot, id) => bot?.connectors?.[id] === false
  const offeredToOthers = (bot, id) => bot?.connectorsShared?.[id] === true
  // `origin` is OWNER or OTHER; anything else was turned into OTHER by the caller.
  const allowed = (bot, id, origin) => bot.remote === undefined && !turnedOff(bot, id) && (origin === OWNER || offeredToOthers(bot, id))

  // The Bot an Agent works for: its own chat, a group Session and an earlier part resolve through
  // selfOf; a sub-agent Session is followed up to its parent. The answer has three shapes, and only
  // the middle one keeps the tools:
  //   { bot, sessionId }  the Agent works for that Bot, in that Bot Session (the end of the chain):
  //                the Bot's switches and whose turn it is decide;
  //   { plain }    the chain ends at a Session that belongs to no Bot (the DSH Agent, a plain Session);
  //   { unknown }  the chain cannot be followed to its end (a parent Session that is gone, a parent
  //                chain deeper than MAX_DEPTH, a Bot id that no longer exists). It may well belong to
  //                a shared Bot, so it fails CLOSED: no connector tools, every call refused.
  const whoseAgent = (agent) => {
    let id = agent?.id ?? agent?.session?.id
    let header = agent?.session?.header
    for (let depth = 0; id !== undefined && depth < MAX_DEPTH; depth += 1) {
      const botId = rt.selfOf(id)
      if (botId !== undefined) {
        const bot = rt.botOf(botId)
        return bot === undefined ? { unknown: true } : { bot, sessionId: id }
      }
      // The Agent's own header is part of the call; a parent's header has to be found again.
      if (depth > 0 && header === undefined) return { unknown: true }
      const parent = header?.parentSession
      if (parent === undefined) return { plain: true }
      id = String(parent)
      header = ctx.sessions?.get?.(id)?.header
    }
    return id === undefined ? { plain: true } : { unknown: true }
  }
  const botOfAgent = agent => whoseAgent(agent).bot

  // Whose request the Agent's turn answers, as the call guard needs it: a turn with no verdict is
  // someone else's.
  const originOfWho = who => settled(rt, who.sessionId) ?? OTHER
  // The same for the tool list, which is built before the model sees the message and again when the
  // turn's origin changes: a Session that runs no turn, or a turn whose first message is not in yet,
  // is listed as it would be for the owner's next message. The guard below still decides every call.
  const listedFor = who => settled(rt, who.sessionId) ?? OWNER

  // The origin an Agent's request to another Bot carries on (message_bot, stop_bot): the strictest
  // answer, OTHER when it cannot be told. Not a Bot's Agent (the DSH Agent): the owner's own.
  rt.agentOrigin = (agent) => {
    const who = whoseAgent(agent)
    if (who.plain === true) return OWNER
    return who.bot === undefined ? OTHER : originOfWho(who)
  }

  ctx.tools.guard(exec => {
    const id = connectorOfTool(exec?.name)
    if (id === undefined) return undefined
    const who = whoseAgent(exec.agent)
    if (who.plain === true) return undefined
    if (who.unknown === true) return `The ${id} connector is not available here: the Bot this Agent works for could not be determined.`
    const { bot } = who
    const origin = originOfWho(who)
    if (allowed(bot, id, origin)) return undefined
    if (bot.remote !== undefined) return `The ${id} connector is not available to a friend's Bot.`
    if (turnedOff(bot, id)) return `The ${id} connector is turned off for ${bot.name}. Its owner can turn it on in this Bot's settings.`
    return settled(rt, who.sessionId) === undefined
      ? `The ${id} connector is not available here: it could not be determined whose request this is, so it is treated as someone else's. Its owner can allow shared use in ${bot.name}'s settings.`
      : `The ${id} connector is not available to other people using ${bot.name}. Its owner can allow it in this Bot's settings.`
  })

  // ---------------------------------------------------------------- the per-Agent tool list
  const masks = new WeakMap()
  // Who each local Bot was shared with the last time its Agents were looked at (see followSharing).
  const sharedBefore = new Map()
  // Labels alone can stay equal when the people change (two people with one name), so the rooms the Bot
  // sits in and who is in them are part of what is compared.
  const sharingOf = botId => [
    ...rt.sharedWith(botId),
    ...Object.values(state.rooms ?? {}).filter(room => (room.members ?? []).includes(botId)).map(room => `${room.id}:${(room.members ?? []).join(',')}:${(room.participants ?? []).filter(p => p?.leftSeq === undefined).map(p => p?.id ?? p?.handle).join(',')}`),
  ].join('\n')
  const seen = new WeakSet()
  const refs = []
  const track = (agent) => {
    if (agent === null || typeof agent !== 'object' || seen.has(agent)) return
    seen.add(agent)
    refs.push(new WeakRef(agent))
  }
  const served = (agent) => {
    try { return new Set(ctx.tools.schemas(agent).map(schema => schema.name)) } catch { return undefined }
  }
  const denied = (who, names) => {
    const origin = who.bot === undefined ? OTHER : listedFor(who)
    return [...names].filter((name) => {
      const id = connectorOfTool(name)
      return id !== undefined && (who.bot === undefined || !allowed(who.bot, id, origin))
    }).sort()
  }

  function hideConnectorTools(agent) {
    track(agent)
    if (typeof agent?.ctx?.tools?.restrict !== 'function') return
    const who = whoseAgent(agent)
    const bot = who.bot
    if (bot !== undefined) sharedBefore.set(bot.id, sharingOf(bot.id))
    // An Agent that belongs to no Bot keeps the tools, unless it already carries a mask; one whose Bot
    // cannot be determined never gets them (see whoseAgent).
    const current = masks.get(agent)
    if (who.plain === true && current === undefined) return
    const names = served(agent)
    if (names === undefined) return
    // The mask hides its own names from schemas(), so count them as known (as hooks.js does).
    for (const name of current?.deny ?? []) names.add(name)
    const key = denied(who, names).join(',')
    if ((current?.key ?? '') === key) return
    try {
      current?.dispose?.()
      masks.delete(agent)
      // After the old mask is lifted, schemas() lists what is really served now.
      const fresh = served(agent)
      const deny = fresh === undefined ? [] : denied(who, fresh)
      masks.set(agent, { key: deny.join(','), deny, dispose: deny.length > 0 ? agent.ctx.tools.restrict({ deny }) : undefined })
    } catch (error) {
      rt.warn('ds-bot: connector tools stay listed for %s: %s', bot?.name ?? agent?.id, error)
    }
  }

  const eachAgent = (visit) => {
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      const agent = refs[i].deref()
      if (agent === undefined) refs.splice(i, 1)
      else visit(agent)
    }
  }
  // The profile's tool set changed (a connector mounted or went away): apply the answer to every
  // Agent that is already up. One pass per burst of changes; a pass that changes a mask changes the
  // tool set again, and the next pass finds nothing left to do.
  let scheduled = false
  ctx.on('tools/change', () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      eachAgent(hideConnectorTools)
    })
  })
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideConnectorTools(agent)
    } catch (error) {
      rt.warn('ds-bot: connector tools for a new Agent: %s', error)
    }
  })

  // ---------------------------------------------------------------- the switches
  // What is stored is only what differs from the defaults: `connectors` holds the explicit offs for the
  // owner's own use, `connectorsShared` the explicit ons for other people's use.
  const cleanOff = flags => Object.fromEntries(CONNECTOR_IDS.filter(id => flags?.[id] === false).map(id => [id, false]))
  const cleanOn = flags => Object.fromEntries(CONNECTOR_IDS.filter(id => flags?.[id] === true).map(id => [id, true]))
  const store = (bot, field, flags) => {
    if (Object.keys(flags).length === 0) delete bot[field]
    else bot[field] = flags
  }
  const flagsOf = bot => ({ connectors: cleanOff(bot.connectors), connectorsShared: cleanOn(bot.connectorsShared) })

  // `scope`: 'owner' (default) is the owner's own use of the Bot; 'shared' is other people's use of it
  // (a friend, another room member, another owner's Bot).
  async function setBotConnector({ botId, connector, enabled: on, scope = 'owner' } = {}) {
    await rt.load()
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const bot = rt.botOf(String(botId ?? ''))
    if (bot === undefined || bot.remote !== undefined) throw new Error('Unknown Bot')
    if (!CONNECTOR_IDS.includes(connector)) throw new Error('No such connector')
    if (typeof on !== 'boolean') throw new Error('Say whether to turn it on or off')
    if (scope !== 'owner' && scope !== 'shared') throw new Error('Say whose use it is: yours or other people\'s')
    if (scope === 'shared') {
      // Others get what the owner has, never more.
      if (on && turnedOff(bot, connector)) throw new Error(`Turn ${connector} on for ${bot.name} first: other people only get what you have.`)
      store(bot, 'connectorsShared', cleanOn({ ...bot.connectorsShared, [connector]: on }))
    } else {
      store(bot, 'connectors', cleanOff({ ...bot.connectors, [connector]: on ? undefined : false }))
      // Off for the owner means off for everyone: a stored offer would only wait to come back.
      if (!on) store(bot, 'connectorsShared', cleanOn({ ...bot.connectorsShared, [connector]: false }))
    }
    await rt.save()
    rt.refreshConnectorTools(bot.id)
    return { botId: bot.id, ...flagsOf(bot) }
  }

  // Disconnecting a connector clears every Bot's choices for it: a later connection (maybe another
  // account) starts from the defaults again, on for the owner and off for others.
  async function forgetConnector(connector) {
    let changed = false
    for (const bot of Object.values(state.bots ?? {})) {
      for (const field of ['connectors', 'connectorsShared']) {
        if (bot[field]?.[connector] === undefined) continue
        const { [connector]: _, ...rest } = bot[field]
        store(bot, field, rest)
        changed = true
      }
    }
    if (changed) {
      await rt.save()
      eachAgent(hideConnectorTools)
    }
  }

  // A Bot's switches or sharing changed: apply it to the Agents it already has.
  const refreshConnectorTools = botId => eachAgent(agent => { if (botOfAgent(agent)?.id === botId) hideConnectorTools(agent) })

  // A turn began, took in another message or ended in a Bot Session: whose request it answers may have
  // changed, so the Agents that work in that Session (its sub-agents too) list the tools that fit.
  // Runs inside the Session's event, before the model sees the message.
  const connectorTurnChanged = sessionId => eachAgent(agent => { if (whoseAgent(agent).sessionId === sessionId) hideConnectorTools(agent) })

  // Who a Bot is shared with also changes without a switch: a friend, another person or another owner's
  // Bot joins or leaves a room, a room is joined by code, a grant is added. Every such change is
  // saved, so each save compares who each local Bot is shared with now and the last time, and
  // refreshes the Agents of those that changed. (The guard reads the team at call time, so a refusal
  // never waits for this; this keeps the list in step.)
  const followSharing = () => {
    try {
      const changed = []
      for (const bot of Object.values(state.bots ?? {})) {
        if (bot.remote !== undefined) continue
        const now = sharingOf(bot.id)
        const before = sharedBefore.get(bot.id)
        if (before !== undefined && before !== now) changed.push(bot.id)
        sharedBefore.set(bot.id, now)
      }
      for (const botId of changed) refreshConnectorTools(botId)
    } catch (error) {
      rt.warn('ds-bot: connector tools after a sharing change: %s', error)
    }
  }
  const save = rt.save
  rt.save = async (...args) => {
    const result = await save.apply(rt, args)
    followSharing()
    return result
  }

  Object.assign(rt, { botConnectorEndpoint: setBotConnector, forgetConnector, hideConnectorTools, refreshConnectorTools, connectorTurnChanged })
}
